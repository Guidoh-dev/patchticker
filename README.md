# PatchTicker — Full-Stack Architecture

Software update intelligence platform. Dark/technical aesthetic. Real-time update health scoring across Apple, NVIDIA, AMD, PS5, Windows, and Steam.

---

## Project Structure

```
patchticker/
├── backend/                  # Node.js / Express API
│   ├── src/
│   │   ├── server.js         # Entry point
│   │   ├── routes/
│   │   │   ├── health.js     # GET /api/health
│   │   │   ├── updates.js    # GET /api/updates, /api/updates/:id
│   │   │   └── bugReports.js # POST/GET /api/bug-reports
│   │   ├── middleware/
│   │   │   ├── cors.js       # Restricted CORS (env-driven)
│   │   │   ├── rateLimiter.js # Tiered rate limiting
│   │   │   ├── validate.js   # express-validator handler
│   │   │   ├── errorHandler.js # Global 404 + error handler
│   │   │   └── httpLogger.js # Morgan → Winston
│   │   ├── services/
│   │   │   ├── updatesService.js  # All third-party API calls (Reddit)
│   │   │   └── bugReportService.js # In-memory store (swap for DB)
│   │   ├── validators/
│   │   │   └── index.js      # express-validator chains
│   │   └── utils/
│   │       └── logger.js     # Winston + daily log rotation
│   ├── .env.example          # Copy to .env and fill in
│   └── package.json
│
├── frontend/                 # Vanilla JS + Vite
│   ├── index.html
│   ├── src/
│   │   ├── main.js           # App bootstrap + rendering
│   │   ├── api.js            # All fetch calls (NO API keys)
│   │   └── styles.css
│   ├── vite.config.js        # Dev proxy → backend
│   └── package.json
│
├── .gitignore
└── package.json              # Monorepo root
```

---

## Quick Start

### 1. Install dependencies

```bash
# Root (installs concurrently)
npm install

# Backend
cd backend && npm install

# Frontend
cd ../frontend && npm install
```

### 2. Configure environment

```bash
cd backend
cp .env.example .env
# Edit .env — fill in Reddit credentials and your domain
```

### 3. Run in development

```bash
# From root — starts both backend (port 4000) and frontend (port 3000)
npm run dev
```

Frontend proxies `/api/*` → `localhost:4000` automatically via Vite.

---

## API Endpoints

| Method | Path | Description | Rate Limit |
|--------|------|-------------|------------|
| GET | `/api/health` | Server health check | Standard |
| GET | `/api/updates` | List all updates (`?platform=` `?status=`) | External (20/min) |
| GET | `/api/updates/summary` | Aggregated stats | Standard |
| GET | `/api/updates/:id` | Single update + Reddit feed | External (20/min) |
| POST | `/api/bug-reports` | Submit a bug report | Strict (10/hour) |
| GET | `/api/bug-reports/:updateId` | List reports for an update | Standard |

---

## Security Architecture

| Concern | Implementation |
|---------|---------------|
| API key exposure | All third-party calls in `services/` — never in frontend |
| CORS | Restricted to `ALLOWED_ORIGIN` env variable |
| Rate limiting | 3-tier: standard (100/15min), external (20/min), submission (10/hr) |
| Request validation | `express-validator` chains on every route |
| Security headers | `helmet` middleware |
| Secrets | `dotenv` — `.env` is gitignored |
| Logging | Winston with daily rotation — `logs/` is gitignored |

---

## Production Deployment

1. Set `NODE_ENV=production` in your environment
2. Set `ALLOWED_ORIGIN=https://yourdomain.com`
3. Build the frontend: `npm run build` (outputs to `frontend/dist/`)
4. Serve `frontend/dist/` as static files via Nginx/Caddy
5. Configure Nginx to proxy `/api/*` → Express backend
6. Run backend with a process manager: `pm2 start src/server.js`

### Nginx snippet

```nginx
location /api/ {
    proxy_pass http://localhost:4000;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
}

location / {
    root /var/www/patchticker/frontend/dist;
    try_files $uri $uri/ /index.html;
}
```

---

## Next Steps

- [ ] Replace in-memory bug report store with PostgreSQL
- [ ] Add Redis for rate limit state (multi-instance support)
- [ ] Wire Anthropic API for AI-powered changelog summaries
- [ ] Add WebSocket support for real-time ticker updates
- [ ] Implement user auth (JWT) for report ownership
