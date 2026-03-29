# Bridge

Bridge is a privacy-first team messaging platform with real-time sync, workspace governance controls, and an integrated admin board.

## Screenshots

### Chat Workspace

![Bridge Chat Workspace](imgs/chat-overview.png)

### Admin Board

![Bridge Admin Board](imgs/admin-board.png)

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
- `STORE_DRIVER=postgres` enables persistent storage; use `memory` for local test-only mode
- `RUN_MIGRATIONS_ON_BOOT=true` applies migrations on server startup in Postgres mode

## Admin API

Admin endpoints are protected by role. Session cookie auth is preferred; `x-user-id` remains a compatibility fallback during migration.

- `GET /admin/overview`
- `POST /admin/channels`
- `PATCH /admin/channels/:channelId`
- `POST /admin/users`
- `PATCH /admin/users/:userId/role`
- `PATCH /admin/users/:userId/status`
- `PATCH /admin/settings`
- `DELETE /admin/messages/:messageId`

## Auth API

- `POST /auth/login` with `{ email, password }`
- `GET /auth/me`
- `POST /auth/logout`

## Search API

- `GET /search/messages?q=<term>&limit=20` (session required)

Default local dev credentials:

- `alex@bridge.local` / `bridge123!`
- `sam@bridge.local` / `bridge123!`
- `nina@bridge.local` / `bridge123!`

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
