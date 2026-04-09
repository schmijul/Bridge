# Bridge Architecture

Bridge is organized as a TypeScript monorepo with the server as the system of record and the web, desktop, and mobile applications consuming the server’s HTTP and realtime contracts.

## Runtime Layers

### API layer

The API is built on Fastify and is responsible for:

- session creation and validation
- request tracing and security headers
- rate limiting for login, authenticated APIs, and WebSocket traffic
- bootstrap, search, unread, notification, attachment, DM, and admin endpoints
- readiness and Prometheus-compatible metrics

The server process starts in [`apps/server/src/index.ts`](../apps/server/src/index.ts) and can optionally run migrations on boot when `STORE_DRIVER=postgres` and `RUN_MIGRATIONS_ON_BOOT=true`.

### Store layer

The store supports two operating modes:

- `memory`: process-local state intended for local development and test-only workflows
- `postgres`: durable mode backed by the migration set in `apps/server/migrations`

Workspace state includes users, channels, messages, read state, notification preferences, notifications, push devices, bot API tokens, and workspace settings.

### Realtime layer

The realtime coordinator supports two behaviors:

- local in-process event fanout when `REDIS_URL` is unset
- Redis-backed publish/subscribe when `REDIS_URL` is configured

The server attaches a `WebSocketServer` directly to the HTTP server and uses the same session cookie for WebSocket authentication. There is no separate WebSocket path; clients connect to the configured server root URL.

### Client layer

- The web client authenticates through `/auth/login`, fetches `/bootstrap`, and then opens a WebSocket connection for incremental sync.
- The desktop shell embeds the web client and constrains navigation to the configured target origin.
- The mobile shell uses HTTP APIs for login, workspace bootstrap, unread summary, and notification feed access.

## Request and Session Flow

1. User submits credentials to `POST /auth/login` or arrives through a trusted proxy to `POST /auth/oidc/login`.
2. Server validates the request, creates a session, and sets the `bridge_session` cookie.
3. Browser or mobile client calls `GET /bootstrap` and related APIs with `credentials: include`.
4. Web client opens a WebSocket connection using the same session cookie.
5. Server emits `sync:snapshot` immediately and then sends incremental `ServerEvent` messages.

Sessions are stored in memory or Postgres depending on `STORE_DRIVER`. Session cleanup runs inside the server process.

## Realtime Event Model

Shared contracts live in [`packages/shared/src/index.ts`](../packages/shared/src/index.ts).

### Client-to-server events

- `message:send`
- `presence:update`
- `typing:update`
- `read:update`

### Server-to-client events

- `message:new`
- `message:deleted`
- `channel:created`
- `channel:updated`
- `user:updated`
- `workspace:updated`
- `audit:new`
- `presence:changed`
- `typing:changed`
- `read:changed`
- `sync:snapshot`
- `error`

Every authorized socket receives a filtered event stream based on channel membership and ACL checks.

## Authentication Modes

### Local mode

- `AUTH_MODE=local`
- email/password login through `POST /auth/login`
- password changes through `POST /auth/change-password`

### OIDC proxy mode

- `AUTH_MODE=oidc`
- identity asserted through trusted proxy headers
- role mapping optionally derived from configured group names
- optional shared secret validation via `OIDC_PROXY_SECRET`

OIDC mode assumes an upstream authentication system. Bridge does not perform a full OIDC authorization-code flow itself.

## Attachments Pipeline

1. Authenticated client uploads a multipart file to `POST /attachments`.
2. Server validates channel access, optional thread linkage, blocked extensions, and file size.
3. Optional scanner executes when `ATTACHMENT_SCAN_MODE=command`.
4. Optional envelope encryption wraps storage I/O when attachment encryption keys are configured.
5. File is written to the configured backend and recorded as a pending attachment.
6. Attachment becomes message-linked when a subsequent `message:send` event references its `attachmentIds`.

## Notifications and Read State

Notification state is coupled to mentions and direct messages:

- `/notifications` returns feed state and current preferences
- `/notifications/read` marks explicit notifications or all notifications as read
- `/read-state` updates channel read progress and can mark notifications read up to a message boundary
- `/me/unread` returns channel-level unread counts
- `/me/push-devices` manages registered push destinations
- push delivery batches are processed by the in-process worker when enabled

## Build and Metadata Flow

`scripts/build-meta.sh` writes build metadata such as commit SHA, branch, tag, dirty state, and UTC build time into build artifacts for the server and web packages. This metadata can be used during packaging or observability workflows.

## Related Documents

- [Overview](overview.md)
- [Configuration](configuration.md)
- [Deployment](deployment.md)
- [API Reference](api-reference.md)
