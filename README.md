# Bridge

Bridge is a privacy-first team messaging platform with real-time sync, workspace governance controls, and an integrated admin board.

## Project Status & Disclaimer

Bridge is a self-teaching side project and community playground, not a finished enterprise product.

- This repository is provided as-is for learning and experimentation.
- No warranty is provided, including for security vulnerabilities, data loss, or fitness for production use.
- Do not deploy this code in production environments without your own full security review, hardening, and operational controls.

## Screenshots

Screenshots below were refreshed for the current session-based login flow.

### Login

![Bridge Login](imgs/login.png)

### Chat Workspace

![Bridge Chat Workspace](imgs/chat-overview.png)

### Admin Board

![Bridge Admin Board](imgs/admin-board.png)

The Admin Board includes workspace governance and security controls (for example guest access and MFA enforcement policy toggles).

## Stack

- TypeScript monorepo (`npm` workspaces)
- `apps/server`: Fastify + WebSocket real-time sync API
- `apps/web`: React + Vite client
- `packages/shared`: shared event/types contracts
- Docker Compose for local Postgres + Redis dependencies
- Git metadata stamping in builds and runtime

## Product Scope

- Multi-channel company chat with realtime message delivery
- Presence status and online member indicator
- Admin board for:
  - onboarding/invite users
  - role management (`admin`, `manager`, `member`, `guest`)
  - channel lifecycle management (create/archive)
  - workspace security/governance settings
  - message moderation and audit log

## Quick start

1. Install dependencies:
   ```bash
   npm install
   ```
2. Copy env files:
   ```bash
   cp apps/server/.env.example apps/server/.env
   cp apps/web/.env.example apps/web/.env
   ```
3. Start infra (optional for current in-memory MVP):
   ```bash
   docker compose up -d
   ```
4. Run DB migrations:
   ```bash
   npm run db:migrate -w @bridge/server
   ```
5. Run both apps:
   ```bash
   npm run dev
   ```

- Web: http://localhost:5173
- API: http://localhost:4000
- Web now uses session login (`/auth/login`) before entering the workspace

### Server environment

- `DATABASE_URL` points to Postgres (for migrations and upcoming persistent storage)
- `REDIS_URL` configures Redis reachability checks and upcoming realtime coordination features
- `STORE_DRIVER=postgres` enables persistent storage; use `memory` for local test-only mode
- `RUN_MIGRATIONS_ON_BOOT=true` applies migrations on server startup in Postgres mode
- `AUTH_LOGIN_RATE_LIMIT_MAX` and `AUTH_LOGIN_RATE_LIMIT_WINDOW_MS` tune login burst throttling
- `AUTH_LOGIN_FAILURE_LIMIT_MAX` and `AUTH_LOGIN_FAILURE_LIMIT_WINDOW_MS` tune login brute-force lockout
- `API_RATE_LIMIT_MAX` and `API_RATE_LIMIT_WINDOW_MS` tune authenticated API throttling
- `AUTH_MODE` supports `local` (password login) and `oidc` (header-based SSO proxy flow)
- `SESSION_COOKIE_SECURE=true` should be enabled behind HTTPS in production
- `SESSION_COOKIE_SAMESITE` supports `lax` (default), `strict`, or `none`
- `SESSION_COOKIE_DOMAIN` can scope cookies to your production domain
- `TRUST_PROXY_HEADERS=true` enables `x-forwarded-for` client IP extraction behind trusted proxies
- In `AUTH_MODE=oidc`, configure identity headers with `OIDC_EMAIL_HEADER`, `OIDC_DISPLAY_NAME_HEADER`, and `OIDC_GROUPS_HEADER`
- Optional OIDC group-to-role mapping via `OIDC_ROLE_GROUP_ADMIN`, `OIDC_ROLE_GROUP_MANAGER`, `OIDC_ROLE_GROUP_MEMBER`, `OIDC_ROLE_GROUP_GUEST`

## Admin API

Admin endpoints are protected by role and require a valid session cookie.

- `GET /admin/overview`
- `GET /admin/audit/export?format=json|csv&action=&actorId=&since=&until=&offset=&limit=`
- `POST /admin/channels`
- `PATCH /admin/channels/:channelId`
- `POST /admin/channels/:channelId/members`
- `DELETE /admin/channels/:channelId/members/:userId`
- `POST /admin/users`
- `PATCH /admin/users/:userId/role`
- `PATCH /admin/users/:userId/status`
- `PATCH /admin/settings`
- `PATCH /admin/settings` can update governance/security settings such as `allowGuestAccess` and `enforceMfaForAdmins`
- `POST /admin/maintenance/retention-run` executes a retention sweep based on `messageRetentionDays`
- `DELETE /admin/messages/:messageId`

## Auth API

- `POST /auth/login` with `{ email, password }`
- `POST /auth/oidc/login` (only when `AUTH_MODE=oidc`; identity from trusted proxy headers)
- `GET /auth/me`
- `GET /auth/mode`
- `POST /auth/logout`

## Readiness API

- `GET /ready` returns dependency readiness for store and Redis with `200` when ready and `503` when required dependencies are unhealthy

## Metrics API

- `GET /metrics` exposes Prometheus-compatible counters for HTTP/auth/rate-limit events

## Search API

- `GET /search/messages?q=<term>&limit=20` (session required)

## Unread API

- `GET /me/unread` (session required)

## Direct Message API

- `GET /dm/conversations` (session required)
- `POST /dm/conversations` with `{ participantUserIds: string[] }` (session required)

## Bootstrap API

- `GET /bootstrap` (session required; channels/messages are ACL-filtered per user)

Default local dev credentials:

- `alex@bridge.local` / `bridge123!`
- `sam@bridge.local` / `bridge123!`
- `nina@bridge.local` / `bridge123!`

## Current Status

Implemented:

- Session login/logout (`/auth/*`) with cookie-based auth
- Admin board role checks and moderation flows
- Channel membership/ACL controls for private channels
- Direct messages and group direct message conversations
- Threads/replies with `threadRootMessageId` metadata
- Mentions metadata extraction on message send (`mentionUserIds`)
- Unread counters endpoint and server-side read-state tracking (`GET /me/unread`)
- Auth/API boundary rate limiting and brute-force protections (`429` + `retry-after`)
- Optional Postgres-backed persistence (`STORE_DRIVER=postgres`)
- Database migrations (`001_init.sql`, `002_auth.sql`, `003_channel_acl.sql`, `004_direct_messages.sql`, `005_threads_mentions.sql`)
- Realtime WebSocket sync with authenticated user binding
- Basic server-side message search endpoint

## Open Work

Still required for production replacement:

- Attachments (S3/MinIO), upload limits, and malware scanning strategy
- Better search (indexing quality, ranking, pagination, retention awareness)
- Redis-backed presence/pub-sub for reliable multi-instance scaling
- Observability stack (metrics, tracing/log correlation, alerting)
- Backup/restore automation with restore verification in CI/staging
- Mattermost migration tooling (users/channels and optional history)
- Desktop/mobile clients (Phase 2) and notification strategy

## Validation Pipeline

Run all local checks:

```bash
npm run lint
npm run test
npm run smoke
```

## Git in build process

Builds are stamped with:

- commit SHA
- branch name
- latest tag (if available)
- dirty state
- build timestamp

Use:

```bash
npm run build
```

This generates `build-meta.json` in each app `dist` folder and exposes metadata via `GET /health` on the server.

## Privacy defaults

- No third-party analytics
- Minimal log data
- CORS allow-list from environment
- Private workspaces/users modeled server-side
- Architecture leaves room for end-to-end encryption later
