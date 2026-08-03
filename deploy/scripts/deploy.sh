#!/usr/bin/env bash
set -euo pipefail

APP_DIR=${APP_DIR:-/opt/patchticker}
BRANCH=${BRANCH:-main}
SERVICE=${SERVICE:-patchticker-api}

cd "$APP_DIR"

echo "[deploy] fetching latest $BRANCH"
git fetch origin "$BRANCH"
git checkout "$BRANCH"
git pull --ff-only origin "$BRANCH"

echo "[deploy] installing dependencies"
npm ci --workspaces

echo "[deploy] building frontend"
npm run build

echo "[deploy] running audit"
npm run audit

echo "[deploy] checking launch readiness"
npm run check:launch

echo "[deploy] restarting backend"
sudo systemctl restart "$SERVICE"
sudo systemctl --no-pager --full status "$SERVICE"

echo "[deploy] validating nginx config"
sudo nginx -t
sudo systemctl reload nginx

echo "[deploy] done"
