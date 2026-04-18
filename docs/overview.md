# Bridge Overview

Bridge is a workspace messaging system composed of a Fastify API, a browser client, an Electron desktop shell, an Expo mobile shell, shared TypeScript contracts, and optional Postgres and Redis dependencies for persistence and cross-instance realtime fanout.

## Platform Capabilities

- Session-based user login with `local` and header-driven `oidc` authentication modes
- Multi-channel chat with direct messages, group direct messages, threads, mentions, and unread counters
- Realtime sync over WebSockets using shared event contracts from `@bridge/shared`
- Role-based administration for channels, users, bots, governance settings, moderation, and audit export
- Attachment uploads with local, S3, or WebDAV backends plus optional malware scanning and envelope encryption
- Notification preferences, in-app notification feeds, push device registration, and async push delivery hooks
- Readiness and metrics endpoints for operator monitoring

## Component Map

| Component | Runtime | Responsibility |
| --- | --- | --- |
| `apps/server` | Node.js | API, session auth, WebSocket fanout, rate limiting, admin workflows, retention, metrics, readiness |
| `apps/web` | Browser | Primary user interface for chat, search, attachments, admin board, and bot management |
| `apps/desktop` | Electron | Desktop shell around the web app with tray integration and external navigation controls |
| `apps/mobile` | Expo / React Native | Mobile login, workspace browsing, unread summary, and notification feed |
| `packages/shared` | TypeScript package | Shared models for users, channels, messages, notifications, workspace settings, and realtime events |
| Postgres | Optional dependency, required for durable mode | Migrations, durable workspace data, sessions, auth state, notifications, push devices |
| Redis | Optional dependency | Cross-instance realtime pub/sub and readiness reporting for realtime connectivity |

## Supported Client Modes

| Client | Status | Notes |
| --- | --- | --- |
| Web | Full primary client | Uses `VITE_API_URL` and `VITE_WS_URL`; requires session cookie support |
| Desktop | Shell around web | Loads the web deployment defined by `BRIDGE_DESKTOP_URL` or `BRIDGE_WEB_URL` |
| Mobile | Focused shell | Uses HTTP APIs for login, bootstrap, unread state, and notifications; configured by `API_URL` and `WS_URL` |

## Deployment Topologies

### Single-node deployment

- One Bridge API instance
- One static web hosting location for `apps/web/dist`
- Postgres for durable data
- Optional Redis for realtime fanout and readiness visibility
- Optional S3 or WebDAV attachment backend

This is the simplest operator model and the default starting point.

### Multi-node API deployment

- Multiple Bridge API instances behind a reverse proxy or load balancer
- Shared Postgres database
- Shared Redis deployment for cross-instance realtime fanout
- Shared attachment backend

In this topology, Redis is strongly recommended because each API instance maintains its own WebSocket connections and relies on the realtime coordinator for event propagation across nodes.

## Data Domains

| Domain | Primary store |
| --- | --- |
| Users, credentials, sessions, channels, messages, settings | Postgres in `STORE_DRIVER=postgres`; in-memory only in `STORE_DRIVER=memory` |
| Realtime pub/sub | Redis when `REDIS_URL` is set; in-process fallback otherwise |
| Attachments | Local filesystem, S3, or WebDAV depending on `ATTACHMENT_STORAGE_DRIVER` |
| Notification delivery queue state | Postgres |
| Desktop and mobile runtime config | Environment variables at process start |

## Operator Entry Points

- [Installation](installation.md) for local setup and validation
- [Configuration](configuration.md) for runtime settings
- [Deployment](deployment.md) for rollout topology and serving model
- [Operations](operations.md) for migrations, health checks, and routine tasks
- [Security](security.md) for trust boundaries and hardening
