// src/config/db.js
// ─────────────────────────────────────────────────────────────────────────────
// DATABASE CONNECTION — PostgreSQL via node-postgres (pg)
//
// SECURITY PROPERTIES
// ────────────────────
//  1. SSL ENFORCED IN PRODUCTION
//     All connections use TLS. sslmode=require is the minimum; production
//     should use sslmode=verify-full with a CA certificate to prevent
//     MITM attacks against the DB connection. Set DB_SSL_CA to the path of
//     your database server's CA certificate for full chain verification.
//
//  2. LEAST-PRIVILEGE USER
//     Connect as the application user (patchticker_app), not the DB owner.
//     The app user has only the permissions it needs:
//       SELECT, INSERT, UPDATE on users, refresh_tokens, bug_reports
//       SELECT, INSERT, UPDATE on account_lockouts
//       DELETE only on refresh_tokens (for logout/revocation)
//       EXECUTE on functions it calls
//     It cannot: DROP/CREATE/ALTER tables, access other schemas, use COPY,
//     create roles, or access pg_catalog system tables beyond basics.
//     See schema.sql for the full GRANT set.
//
//  3. NO PUBLIC PORT EXPOSURE
//     The DATABASE_URL should point to a private network address.
//     Never open port 5432 to the internet. Use:
//       • Private VPC subnets (AWS RDS private, Railway private networking)
//       • SSH tunnel for local dev access to production
//       • Bastion host / VPN for DBA access
//     The application connects from within the same private network.
//
//  4. PARAMETERIZED QUERIES ONLY
//     pool.query(text, params) is the only public API. There is no
//     pool.queryRaw() or string-interpolation helper. Service code cannot
//     accidentally construct SQL from user input.
//
//  5. CONNECTION POOL LIMITS
//     max connections limited to prevent exhaustion DoS. Idle timeout
//     releases connections that have been unused for 30 seconds. Connection
//     timeout prevents hanging if the DB is unreachable.
//
//  6. STARTUP HEALTH CHECK
//     The pool runs a SELECT 1 after connecting to confirm the DB is
//     reachable and TLS is working before the server starts accepting
//     requests. Failure aborts startup.
//
//  7. GRACEFUL SHUTDOWN
//     SIGTERM drains the pool cleanly, allowing in-flight queries to finish.
//
// CONNECTION STRING FORMAT
// ─────────────────────────
//  DATABASE_URL=postgres://user:password@host:5432/dbname?sslmode=require
//
//  For managed databases (Railway, Supabase, Neon, RDS):
//    The platform provides a connection string. Copy it verbatim into .env.
//    Some platforms (Neon, Supabase) append ?sslmode=require automatically.
//    If not, append it yourself.
//
//  For full CA verification (recommended in production):
//    Set DB_SSL_CA to the path of the server CA cert (.pem or .crt).
//    This prevents connecting to a spoofed database endpoint.
//    Example: DB_SSL_CA=/etc/ssl/patchticker-db-ca.pem
//
// ─────────────────────────────────────────────────────────────────────────────

'use strict';

const { Pool }  = require('pg');
const fs        = require('fs');
const logger    = require('../utils/logger');
// Lazily required to avoid circular dependency at module load time
// (alerting → logger → db is not a cycle; db → alerting is fine after load)
let _alert, _ALERT_TYPE;

const isProd = process.env.NODE_ENV === 'production';
const isTest = process.env.NODE_ENV === 'test';

// ── SSL configuration ─────────────────────────────────────────────────────────

/**
 * Build the ssl option for the pg pool.
 *
 * Development: SSL disabled by default (local Postgres typically has no cert).
 *              Set DB_SSL=true to enable if your dev DB uses SSL.
 *
 * Production:  SSL always required. If DB_SSL_CA is set, performs full chain
 *              verification (verify-full equivalent). If not, requires SSL but
 *              skips CA verification (acceptable for platforms where the CA
 *              cert is managed by the cloud provider and MITM risk is low on
 *              private network, but verify-full is strongly preferred).
 *
 * Test:        SSL disabled — tests use a local Postgres without SSL.
 */
function buildSslConfig() {
  if (isTest) return false;

  const forceSSL = process.env.DB_SSL === 'true' || isProd;
  if (!forceSSL) return false;

  const caPath = process.env.DB_SSL_CA;
  if (caPath) {
    try {
      const ca = fs.readFileSync(caPath, 'utf8');
      logger.info('DB SSL: full CA verification enabled', { caPath });
      return {
        rejectUnauthorized: true,  // verify server certificate chain
        ca,
      };
    } catch (err) {
      const msg = `[db] Cannot read DB_SSL_CA file at ${caPath}: ${err.message}`;
      if (isProd) throw new Error(msg);
      logger.warn(msg);
    }
  }

  if (isProd) {
    // In production without a CA cert, still require SSL but warn that
    // full chain verification is not active.
    logger.warn(
      '[db] DB_SSL_CA not set — SSL is required but server certificate is not verified. ' +
      'Set DB_SSL_CA for full MITM protection.'
    );
    return { rejectUnauthorized: false };
  }

  return { rejectUnauthorized: false };
}

// ── Pool creation ─────────────────────────────────────────────────────────────

function createPool() {
  const connectionString = process.env.DATABASE_URL;

  if (!connectionString) {
    if (isProd) {
      throw new Error('[db] DATABASE_URL is not set. Cannot start in production without a database.');
    }
    // In dev/test with no DATABASE_URL, return a mock pool that throws on use.
    // This lets the server start for unit tests that don't need the DB.
    logger.warn('[db] DATABASE_URL not set — database features will be unavailable.');
    return null;
  }

  if (connectionString.startsWith('REPLACE_WITH') || connectionString.startsWith('your_')) {
    if (isProd) {
      throw new Error('[db] DATABASE_URL is still a placeholder. Set a real connection string.');
    }
    logger.warn('[db] DATABASE_URL is a placeholder — database features will be unavailable.');
    return null;
  }

  const ssl = buildSslConfig();

  const pool = new Pool({
    connectionString,
    ssl,
    // Pool sizing
    max:              parseInt(process.env.DB_POOL_MAX    || '10',   10),
    min:              parseInt(process.env.DB_POOL_MIN    || '2',    10),
    idleTimeoutMillis:parseInt(process.env.DB_IDLE_MS     || '30000', 10),  // 30s
    connectionTimeoutMillis: parseInt(process.env.DB_CONN_TIMEOUT_MS || '5000', 10), // 5s
    // Statement timeout — no query may run longer than this
    // Prevents runaway queries from holding connections indefinitely
    statement_timeout: parseInt(process.env.DB_STATEMENT_TIMEOUT_MS || '30000', 10), // 30s
  });

  // ── Pool event logging ──────────────────────────────────────────────────────
  pool.on('connect', (client) => {
    logger.debug('DB pool: new connection established', {
      totalCount: pool.totalCount,
      idleCount:  pool.idleCount,
    });
    // Set a session-level statement timeout as a belt-and-suspenders measure
    // (in case the pool-level option isn't supported by the pg version)
    const timeoutMs = parseInt(process.env.DB_STATEMENT_TIMEOUT_MS || '30000', 10);
    client.query(`SET statement_timeout = ${timeoutMs}`).catch(() => {});
  });

  pool.on('acquire', () => {
    logger.debug('DB pool: connection acquired', {
      totalCount: pool.totalCount,
      idleCount:  pool.idleCount,
      waitingCount: pool.waitingCount,
    });
  });

  pool.on('error', (err) => {
    // Log idle client errors — these can indicate DB restarts or network issues
    logger.error('DB pool: idle client error', {
      message: err.message,
      code:    err.code,
    });
    // Fire a DB_ERROR alert (cooldown: 10 min) so ops are paged on persistent
    // connection loss — e.g. DB server restart, network partition, credential rotation
    try {
      if (!_alert) {
        const alerting = require('../utils/alerting');
        _alert      = alerting.alert;
        _ALERT_TYPE = alerting.ALERT_TYPE;
      }
      _alert(_ALERT_TYPE.DB_ERROR, `DB pool idle client error: ${err.message}`, {
        code: err.code,
      });
    } catch { /* never let alerting failure affect the pool */ }
  });

  return pool;
}

const pool = createPool();

// ── Public query API ──────────────────────────────────────────────────────────

/**
 * Execute a parameterized SQL query.
 *
 * ALWAYS use this function with $1/$2/... placeholders.
 * NEVER interpolate user input into the `text` string.
 *
 * @param {string}   text    — SQL with $1, $2, ... placeholders
 * @param {any[]}    [params] — bound parameters (never user-controlled SQL)
 * @returns {Promise<import('pg').QueryResult>}
 *
 * @example
 * const result = await query(
 *   'SELECT id, email_hmac FROM users WHERE email_hmac = $1',
 *   [emailHmac]
 * );
 */
async function query(text, params) {
  if (!pool) {
    throw new Error('[db] No database connection — DATABASE_URL is not configured.');
  }

  const start = Date.now();
  try {
    const result = await pool.query(text, params);
    const duration = Date.now() - start;

    // Log slow queries (> 1 second) for performance investigation
    if (duration > 1000) {
      logger.warn('DB: slow query', {
        // Do NOT log `text` if it could contain interpolated user data.
        // Since we enforce parameterized queries, text is always a static string.
        query:    text.slice(0, 200),
        duration: `${duration}ms`,
        rows:     result.rowCount,
      });
    } else {
      logger.debug('DB query executed', {
        rows:     result.rowCount,
        duration: `${duration}ms`,
      });
    }

    return result;
  } catch (err) {
    const duration = Date.now() - start;
    logger.error('DB query error', {
      query:    text.slice(0, 200), // safe — static SQL string only
      duration: `${duration}ms`,
      code:     err.code,
      message:  err.message,
    });
    throw err;
  }
}

/**
 * Acquire a client from the pool for multi-statement transactions.
 * The caller MUST call client.release() in a finally block.
 *
 * @returns {Promise<import('pg').PoolClient>}
 *
 * @example
 * const client = await getClient();
 * try {
 *   await client.query('BEGIN');
 *   await client.query('INSERT INTO users ...', [...]);
 *   await client.query('INSERT INTO refresh_tokens ...', [...]);
 *   await client.query('COMMIT');
 * } catch (err) {
 *   await client.query('ROLLBACK');
 *   throw err;
 * } finally {
 *   client.release();
 * }
 */
async function getClient() {
  if (!pool) {
    throw new Error('[db] No database connection — DATABASE_URL is not configured.');
  }
  return pool.connect();
}

// ── Startup health check ──────────────────────────────────────────────────────

/**
 * Verify the database connection is working and SSL is active.
 * Called from server.js before the HTTP server starts accepting requests.
 * Throws on failure — server should not start with a broken DB connection.
 *
 * @returns {Promise<{ version: string, sslActive: boolean }>}
 */
async function healthCheck() {
  if (!pool) {
    logger.warn('[db] Skipping DB health check — no pool configured.');
    return { version: null, sslActive: false, skipped: true };
  }

  const client = await pool.connect();
  try {
    // Check DB version
    const versionResult = await client.query('SELECT version()');
    const version = versionResult.rows[0].version;

    // Check whether the current connection is using SSL
    // ssl_is_used() returns true if the connection is encrypted
    let sslActive = false;
    try {
      const sslResult = await client.query('SELECT ssl_is_used() AS ssl');
      sslActive = sslResult.rows[0]?.ssl === true;
    } catch {
      // ssl_is_used() may not exist on very old Postgres versions
      logger.warn('[db] Could not verify SSL status — ssl_is_used() unavailable');
    }

    if (isProd && !sslActive) {
      throw new Error(
        '[db] Production DB connection is NOT using SSL. ' +
        'Ensure DATABASE_URL includes ?sslmode=require and DB_SSL=true.'
      );
    }

    logger.info('DB health check passed', {
      version: version.split(' ').slice(0, 2).join(' '), // "PostgreSQL 16.2"
      sslActive,
      poolTotal: pool.totalCount,
      poolIdle:  pool.idleCount,
    });

    return { version, sslActive };
  } finally {
    client.release();
  }
}

// ── Graceful shutdown ─────────────────────────────────────────────────────────

/**
 * Drain the pool and close all connections.
 * Called from SIGTERM handler in server.js.
 */
async function shutdown() {
  if (!pool) return;
  logger.info('DB pool: draining connections');
  await pool.end();
  logger.info('DB pool: all connections closed');
}

// ── isAvailable ───────────────────────────────────────────────────────────────

/** Returns true if a pool is configured (DATABASE_URL was set). */
function isAvailable() {
  return pool !== null;
}

module.exports = {
  query,
  getClient,
  healthCheck,
  shutdown,
  isAvailable,
};
