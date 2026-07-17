# Dependency Audit — PatchTicker
**Date:** 2026-03-03  
**Auditor:** CI/Security Review  
**Scope:** All direct dependencies across backend, frontend, and root workspaces

---

## Methodology

Four sources were cross-referenced for each package:

1. **npm registry** — latest stable version, publish date
2. **GitHub release history** — changelog, breaking changes, security notes
3. **npm advisory database** — known CVEs in older versions
4. **OSV database (osv.dev)** — broader vulnerability coverage beyond npm advisories

Pinning strategy: all versions are **exact pins** (no `^` or `~`). This means:
- `npm update` will not silently pull in new versions
- The CI environment is bit-for-bit reproducible
- Dependabot PRs make every upgrade visible and deliberate

---

## Backend — Finding Summary

| Package | Was | Now | Change type | Decision rationale |
|---|---|---|---|---|
| `express` | `^4.19.2` | `4.21.2` | Pin latest 4.x | Express 5.2.1 is the npm default but has route-syntax breaking changes (`{/:param}`, no unnamed regex captures, `req.params[0]` removed). Migration requires audit of all route files. Staying on 4.x maintenance branch which receives security backports. Tracked for future migration. |
| `helmet` | `^7.1.0` | `8.1.0` | Major bump | v8 adds `Cross-Origin-Embedder-Policy: credentialless` option and improves CSP defaults. No breaking API changes for our usage. |
| `express-rate-limit` | `^7.3.1` | `7.5.0` | Minor bump | v8 is latest but introduces a store abstraction breaking change. v7.5.0 is the latest stable v7. Updated within major. |
| `csrf-csrf` | `^3.0.3` | `4.0.3` | Major bump | v4 changes the `getSecret` function signature (now receives `req` as argument, enabling per-request secrets). Our usage passes a static secret — no code change needed. |
| `zod` | `^3.23.8` | `3.24.2` | Minor bump | Zod 4 is stable (4.3.6) and 14x faster, but has breaking changes: `.strict()` → `z.strictObject()`, `.superRefine()` deprecated, error shape changed from `.errors` to `.issues`. Migration tracked as a future task. Running latest v3. |
| `axios` | `^1.7.2` | `1.9.0` | Minor bump | No security advisories. Updated to latest 1.x. |
| `argon2` | `^0.31.2` | `0.44.0` | Minor bumps | Prebuilt binary support extended. No API changes. Updated to latest. |
| `winston` | `^3.13.0` | `3.21.0` | Minor bump | Bug fixes, no breaking changes. Updated to latest. |
| `jsonwebtoken` | `^9.0.2` | `9.0.3` | Patch | Dependency updates only. |
| `cookie-parser` | `^1.4.6` | `1.4.7` | Patch | Minor fixes. |
| `morgan` | `^1.10.0` | `1.10.0` | No change | Already at latest. Pinned. |
| `dotenv` | `^16.4.5` | `16.5.0` | Patch | Minor fixes. |
| `uuid` | `^10.0.0` | `11.1.0` | Minor bump | No breaking changes for v4 UUID generation. |
| `winston-daily-rotate-file` | `^5.0.0` | `5.0.0` | Pin | Already at latest within major. |
| `cors` | `^2.8.5` | `2.8.5` | Pin | No changes since 2019, but no vulnerabilities either. Package is stable/complete. |

### Removed
| Package | Reason |
|---|---|
| None | All existing deps retained |

### Added (dev)
| Package | Version | Reason |
|---|---|---|
| `supertest` | `7.1.0` | HTTP integration testing — was missing, enabling route-level tests |

---

## Frontend — Finding Summary

| Package | Was | Now | Decision |
|---|---|---|---|
| `vite` | `^5.2.11` | `7.0.6` | Two major versions behind. v6 and v7 are both stable. v7 requires Node 20+, which we already enforce via `engines`. No source-code changes needed for a vanilla JS project. |

---

## Root — Finding Summary

| Package | Was | Now | Decision |
|---|---|---|---|
| `concurrently` | `^8.2.2` | `9.2.1` | Major bump. v9 drops Node 16 (we require 20+). No API changes for our usage. |

---

## Known Intentional Deferrals

### Express 4 → 5
**Status:** Deferred  
**Tracking:** Future milestone  
**Reason:** Express 5 has breaking route-syntax changes:
- Optional params: `:name?` → `{/:name}`  
- Unnamed regex captures removed (`req.params[0]`)  
- `res.redirect('back')` removed  
- `req.body` is now `undefined` (not `{}`) when no body parser

None of our current routes use these patterns, but a full route audit is required before upgrading to avoid subtle runtime failures. Express 4.x is in maintenance mode and receives security backports.

### Zod 3 → 4
**Status:** Deferred  
**Tracking:** Future milestone  
**Reason:** Zod 4 breaking changes affecting our codebase:
- `.strict()` is now a legacy alias for `z.strictObject()` (still works, but should be migrated)  
- `.superRefine()` deprecated in favour of `.check()`  
- Error shape: `zodError.errors` → `zodError.issues` (`.errors` is an alias in v4, so validate.js still works)  
- `z.ZodIssueCode` type structure changed  
- `.email()` and `.uuid()` moved to top-level `z.email()`, `z.uuid()`

The v3→v4 migration requires updating all 6 schema files, the validate middleware, and 150+ test cases. Tracked as a dedicated task. Running `zod@3.24.2` (latest v3).

---

## CI Security Scanning — Tool Coverage Matrix

| Threat | npm audit | OSV Scanner | CodeQL |
|---|---|---|---|
| Known CVE in direct dep | ✅ | ✅ | ❌ |
| Known CVE in transitive dep | ✅ | ✅ | ❌ |
| CVE not yet in npm advisory DB | ❌ | ✅ | ❌ |
| SQL injection in source code | ❌ | ❌ | ✅ |
| Path traversal in source code | ❌ | ❌ | ✅ |
| ReDoS in regexes | ❌ | ❌ | ✅ |
| Prototype pollution | ❌ | ❌ | ✅ |
| Credential leakage | ❌ | ❌ | ✅ |
| XSS in rendered output | ❌ | ❌ | ✅ |
| New CVE disclosed between PRs | ❌ scheduled | ❌ | ❌ |

`scheduled-audit.yml` fills the gap for "new CVE between PRs" by running npm audit + OSV weekly and creating a GitHub issue if anything is found.

---

## Version Pinning Policy

All versions use exact pins (e.g. `"express": "4.21.2"`, not `"^4.21.2"`).

**Rationale:**
- Reproducible builds across all environments (local, CI, production)
- No silent transitive upgrades that change behaviour without a PR
- Dependabot PRs make every upgrade explicit, reviewed, and tested

**Update process:**
1. Dependabot opens a PR with the new version
2. CI pipeline runs automatically (audit + lint + test + CodeQL)
3. If all checks pass, PR is reviewed by a human and merged
4. For major version bumps, changelog is reviewed before merging

**Manual update:**
```bash
cd backend
npm install some-package@x.y.z   # installs and updates package.json + lock
npm test                          # verify nothing broke
git add package.json package-lock.json
git commit -m "chore(deps): bump some-package to x.y.z"
```
