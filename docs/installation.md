# Installation

This guide covers a local Bridge setup suitable for development, evaluation, and operator familiarity testing.

## Prerequisites

- Node.js and `npm`
- Docker Engine with Docker Compose support
- Local ports `4000`, `5173`, `5432`, and `6379` available
- Optional platform tooling for Electron or Expo if desktop or mobile shells are needed

If Docker is not available, you can substitute externally managed Postgres and Redis instances and point the server environment accordingly.

## Workspace Bootstrap

1. Install dependencies:
   ```bash
   npm install
   ```
2. Create environment files:
   ```bash
   cp apps/server/.env.example apps/server/.env
   cp apps/web/.env.example apps/web/.env
   cp apps/mobile/.env.example apps/mobile/.env
   ```
3. Start infrastructure:
   ```bash
   docker compose up -d
   ```
4. Apply database migrations:
   ```bash
   npm run db:migrate -w @bridge/server
   ```
5. Start the primary developer stack:
   ```bash
   npm run dev
   ```

This starts:

- the Fastify API in `apps/server`
- the Vite web client in `apps/web`

## Optional Client Shells

### Desktop shell

```bash
npm run dev:desktop
```

The desktop shell loads the web application URL from `BRIDGE_DESKTOP_URL` or falls back to `http://localhost:5173`.

### Mobile shell

```bash
npm run dev:mobile
```

The mobile shell reads `API_URL` and `WS_URL` from `apps/mobile/.env` or shell environment variables. For Android emulators, use `http://10.0.2.2:4000` instead of `http://localhost:4000`.

## Local Validation

Once the stack is running:

- open `http://localhost:5173`
- sign in with `alex@bridge.local` / `bridge123!`
- confirm the workspace loads and the admin tab is visible
- call `GET http://localhost:4000/health` and expect `{"ok":true}`
- call `GET http://localhost:4000/ready` and confirm store and Redis readiness

## Default Local Accounts

| Email | Password | Role |
| --- | --- | --- |
| `alex@bridge.local` | `bridge123!` | `admin` |
| `sam@bridge.local` | `bridge123!` | `manager` |
| `nina@bridge.local` | `bridge123!` | `member` |
| `jordan@bridge.local` | `bridge123!` | `member` |

These are development bootstrap accounts seeded by the current store and auth initialization path.

## Useful Commands

| Command | Purpose |
| --- | --- |
| `npm run dev` | Start server and web development loops |
| `npm run dev:desktop` | Start the Electron shell |
| `npm run dev:mobile` | Start the Expo shell |
| `npm run db:migrate -w @bridge/server` | Apply Postgres migrations |
| `npm run build` | Build shared, server, web, and desktop packages |
| `npm run test` | Run package test suites and TypeScript validation |
| `npm run lint` | Run TypeScript no-emit checks across workspaces |
| `npm run smoke` | Execute lint, test, build, and a basic API smoke path |

## Installation Notes

- `STORE_DRIVER=memory` avoids Postgres persistence and is only appropriate for transient development workflows.
- `RUN_MIGRATIONS_ON_BOOT=true` is convenient for local use; production rollout policy is covered in [Deployment](deployment.md).
- The web client and API can run on different origins, but CORS and cookie policy must be configured coherently. See [Configuration](configuration.md) and [Security](security.md).

## Related Documents

- [Overview](overview.md)
- [Configuration](configuration.md)
- [Troubleshooting](troubleshooting.md)
