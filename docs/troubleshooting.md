# Troubleshooting

Use this guide when Bridge fails to start, authenticate users, or deliver expected workspace behavior.

## API Starts but `/ready` Returns `503`

### Postgres failure

Symptoms:

- `dependencies.store.ok` is `false`
- readiness detail mentions Postgres query failures

Checks:

- verify `STORE_DRIVER=postgres`
- verify `DATABASE_URL`
- confirm migrations have been applied
- confirm the database is reachable from the API host

### Redis failure

Symptoms:

- `dependencies.redis.configured` is `true`
- `dependencies.redis.ok` is `false`
- readiness detail mentions invalid URL, reconnecting, or subscriber/publisher failures

Checks:

- verify `REDIS_URL`
- verify Redis network reachability
- confirm the URL uses `redis://` or `rediss://`

## Browser Login Succeeds but Workspace Requests Fail

Common causes:

- cookie security settings do not match the deployment origin
- `CORS_ORIGIN` does not include the browser origin
- reverse proxy strips cookies
- CSRF protection is enabled and mutating requests do not send `x-bridge-csrf: 1`

Checks:

- inspect browser network requests for missing cookies
- verify `SESSION_COOKIE_SECURE` and `SESSION_COOKIE_SAMESITE`
- confirm the web client origin is listed in `CORS_ORIGIN`

## OIDC Login Returns `403`

Common causes:

- `AUTH_MODE` is not `oidc`
- proxy secret is missing or incorrect
- upstream identity headers are absent
- the user is not provisioned or is inactive

Checks:

- verify `OIDC_PROXY_SECRET` and `OIDC_PROXY_SECRET_HEADER`
- verify email header propagation
- confirm the target user exists in Bridge and is active

## WebSocket Connects Poorly or Does Not Sync Across Nodes

Common causes:

- no session cookie during handshake
- Redis not configured in a multi-node deployment
- reverse proxy not forwarding WebSocket upgrade traffic

Checks:

- confirm the socket receives `sync:snapshot`
- confirm `/ready` reports Redis healthy in multi-node mode
- verify the WebSocket target URL is the API root URL

## Attachment Upload Fails

Common causes:

- file exceeds `ATTACHMENT_MAX_SIZE_BYTES`
- blocked extension policy rejects the file
- malware scanner rejects the file
- attachment backend credentials are invalid

Checks:

- inspect API response message
- verify the selected storage driver configuration
- test scanner command execution manually if using `ATTACHMENT_SCAN_MODE=command`

## WebDAV Attachment Backend Fails at Startup

Common causes:

- `ATTACHMENT_WEBDAV_BASE_URL` is missing
- URL is `http` for a non-loopback host
- username or app password is missing

Checks:

- verify the base URL uses `https`
- use `ATTACHMENT_WEBDAV_ALLOW_INSECURE=true` only for `localhost`, `127.0.0.1`, or `[::1]`
- confirm credentials against the WebDAV server independently

## Push Delivery Is Enabled but Nothing Is Delivered

Common causes:

- `PUSH_DELIVERY_WEBHOOK_URL` is unset
- push devices have not been registered
- webhook target rejects requests

Checks:

- call `GET /admin/notifications/delivery`
- trigger `POST /admin/notifications/delivery/run`
- verify the webhook endpoint accepts the payload and optional auth header

## Mobile App Cannot Reach the API

Common causes:

- `API_URL` still points to `localhost` from an emulator context
- network path to the API host is blocked

Checks:

- for Android emulators, set `API_URL=http://10.0.2.2:4000`
- confirm the API is reachable from the device or simulator network

## Desktop Shell Opens the Wrong URL or Hides on Close

Checks:

- verify `BRIDGE_DESKTOP_URL` or `BRIDGE_WEB_URL`
- set `BRIDGE_DESKTOP_CLOSE_TO_TRAY=false` if you want window close to quit instead of hiding
- set `BRIDGE_DESKTOP_START_HIDDEN=false` if you want the shell to show immediately

## Smoke Script Fails

The smoke script runs lint, tests, builds, then starts the server on port `4010`.

Checks:

- ensure no process is already using `4010`
- ensure the server build output exists
- inspect `/tmp/bridge-smoke-server.log`
- confirm login credentials for `alex@bridge.local` remain valid

## When to Escalate

Escalate beyond routine troubleshooting when:

- database corruption or migration rollback is suspected
- attachment encryption keys are missing or inconsistent
- bot tokens may have leaked
- readiness is unstable across multiple API nodes despite healthy infrastructure

## Related Documents

- [Operations](operations.md)
- [Security](security.md)
- [Configuration](configuration.md)
