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
LOG_FILE="/tmp/bridge-smoke-server.log"
(
  cd apps/server
  PORT=4010 CORS_ORIGIN=http://localhost:5173 npm run start
) > "$LOG_FILE" 2>&1 &
SERVER_PID=$!

cleanup() {
  if kill -0 "$SERVER_PID" 2>/dev/null; then
    kill "$SERVER_PID" 2>/dev/null || true
    wait "$SERVER_PID" 2>/dev/null || true
  fi
}
trap cleanup EXIT

server_ready="false"
for _ in $(seq 1 25); do
  if curl -fsS "http://localhost:4010/health" >/dev/null 2>&1; then
    server_ready="true"
    break
  fi
  sleep 1
done

if [ "$server_ready" != "true" ]; then
  echo "[smoke] server failed to become ready on :4010"
  echo "[smoke] server log:"
  sed -n '1,200p' "$LOG_FILE"
  exit 1
fi

HEALTH_JSON="$(curl -fsS "http://localhost:4010/health")"

COOKIE_JAR="/tmp/bridge-smoke-cookie.txt"
rm -f "$COOKIE_JAR"
curl -fsS -c "$COOKIE_JAR" \
  -H "Content-Type: application/json" \
  -d '{"email":"alex@bridge.local","password":"bridge123!"}' \
  "http://localhost:4010/auth/login" >/dev/null
BOOTSTRAP_JSON="$(curl -fsS -b "$COOKIE_JAR" "http://localhost:4010/bootstrap")"

echo "$HEALTH_JSON" | grep -Eq '"ok"[[:space:]]*:[[:space:]]*true'
echo "$HEALTH_JSON" | grep -Eq '"analyticsEnabled"[[:space:]]*:[[:space:]]*false'
echo "$HEALTH_JSON" | grep -Eq '"commitSha"[[:space:]]*:'

echo "$BOOTSTRAP_JSON" | grep -Eq '"channels"[[:space:]]*:'
echo "$BOOTSTRAP_JSON" | grep -Eq '"messages"[[:space:]]*:'

echo "[smoke] success"
