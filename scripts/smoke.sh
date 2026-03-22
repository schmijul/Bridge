#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

echo "[smoke] lint"
npm run lint

echo "[smoke] test"
npm run test

echo "[smoke] build"
npm run build

echo "[smoke] start server"
(
  cd apps/server
  PORT=4010 CORS_ORIGIN=http://localhost:5173 npm run start
) > /tmp/bridge-smoke-server.log 2>&1 &
SERVER_PID=$!

cleanup() {
  if kill -0 "$SERVER_PID" 2>/dev/null; then
    kill "$SERVER_PID" 2>/dev/null || true
    wait "$SERVER_PID" 2>/dev/null || true
  fi
}
trap cleanup EXIT

for _ in $(seq 1 25); do
  if curl -fsS "http://localhost:4010/health" >/dev/null; then
    break
  fi
  sleep 1
done

HEALTH_JSON="$(curl -fsS "http://localhost:4010/health")"
BOOTSTRAP_JSON="$(curl -fsS "http://localhost:4010/bootstrap")"

echo "$HEALTH_JSON" | grep -Eq '"ok"[[:space:]]*:[[:space:]]*true'
echo "$HEALTH_JSON" | grep -Eq '"analyticsEnabled"[[:space:]]*:[[:space:]]*false'
echo "$HEALTH_JSON" | grep -Eq '"commitSha"[[:space:]]*:'

echo "$BOOTSTRAP_JSON" | grep -Eq '"channels"[[:space:]]*:'
echo "$BOOTSTRAP_JSON" | grep -Eq '"messages"[[:space:]]*:'

echo "[smoke] success"
