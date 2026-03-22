# Bridge

Bridge is a fast, privacy-first team messaging platform with real-time sync and a clean UX.

## Stack

- TypeScript monorepo (`npm` workspaces)
- `apps/server`: Fastify + WebSocket real-time sync API
- `apps/web`: React + Vite client
- `packages/shared`: shared event/types contracts
- Docker Compose for local Postgres + Redis dependencies
- Git metadata stamping in builds and runtime

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
3. Start infra:
   ```bash
   docker compose up -d
   ```
4. Run both apps:
   ```bash
   npm run dev
   ```

- Web: http://localhost:5173
- API: http://localhost:4000

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
- Private workspaces/users are modeled server-side
- Architecture leaves room for end-to-end encryption later
