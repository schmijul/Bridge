# Bridge

Bridge is a privacy-first team messaging platform with real-time sync, workspace governance controls, and an integrated admin board.

## Screenshot

![Bridge UI](imgs/Screenshot%20from%202026-03-22%2016-34-34.png)

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
4. Run both apps:
   ```bash
   npm run dev
   ```

- Web: http://localhost:5173
- API: http://localhost:4000

## Admin API

Admin endpoints are protected by role and expect `x-user-id` in request headers.

- `GET /admin/overview`
- `POST /admin/channels`
- `PATCH /admin/channels/:channelId`
- `POST /admin/users`
- `PATCH /admin/users/:userId/role`
- `PATCH /admin/settings`
- `DELETE /admin/messages/:messageId`

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
