# Deployment Guide

This guide describes how to deploy Bridge as a production-style service using the current repository layout.

## Recommended Topology

- Reverse proxy or load balancer terminating TLS
- Static hosting for the web build output from `apps/web/dist`
- One or more Bridge API instances from `apps/server`
- Postgres for durable state
- Redis for cross-instance realtime fanout
- Shared attachment backend using local shared storage, S3, or WebDAV

The desktop and mobile applications are optional clients and do not change the server deployment model.

## Build Artifacts

### Server

Build the server with:

```bash
npm run build -w @bridge/server
```

Start it with:

```bash
npm run start -w @bridge/server
```

### Web

Build the web application with:

```bash
npm run build -w @bridge/web
```

This produces a static site in `apps/web/dist`. The repository does not provide a production web server for this output. Serve it with your standard static hosting layer or reverse proxy.

### Desktop

The desktop shell is not required for server deployment. Build it only if distributing the desktop client:

```bash
npm run build -w @bridge/desktop
```

## Deployment Sequence

1. Provision Postgres and create the target database.
2. Provision Redis if running multiple API instances or if operator visibility into realtime readiness is required.
3. Configure the Bridge server environment.
4. Run migrations:
   ```bash
   npm run db:migrate -w @bridge/server
   ```
5. Build and deploy the server artifact.
6. Build and publish the web static artifact.
7. Confirm `/health`, `/ready`, and a full login flow before opening traffic broadly.

## Reverse Proxy Requirements

- forward requests to the Bridge API without stripping cookies
- preserve `Authorization` headers for `/metrics` and `/ready` when `OPS_BEARER_TOKEN` is set
- preserve any OIDC identity headers when running `AUTH_MODE=oidc`
- set `TRUST_PROXY_HEADERS=true` only when the proxy reliably sets `x-forwarded-for`
- route WebSocket upgrade traffic to the API root URL; Bridge does not use a separate WebSocket path

## Cookie and Origin Alignment

Choose one of these operating models:

### Same-origin preferred model

- Serve the web app and API behind the same site or closely aligned origin strategy
- Keep `SESSION_COOKIE_SAMESITE=lax`
- Keep `SESSION_COOKIE_SECURE=true`

### Cross-origin browser model

- Set `CORS_ORIGIN` to the exact web origin or comma-separated allowed origins
- Use `SESSION_COOKIE_SAMESITE=none`
- Use `SESSION_COOKIE_SECURE=true`
- Ensure browser clients include credentials on fetch requests

## Scaling Guidance

### API instances

Bridge API instances are stateless only when all durable state and session state live in Postgres. Use `STORE_DRIVER=postgres` for multi-instance deployments.

### Realtime

When scaling past one API instance:

- configure `REDIS_URL`
- ensure all nodes can connect to the same Redis deployment
- confirm `/ready` reports Redis as configured and healthy

Without Redis, each API node only has local realtime visibility.

### Attachments

For multiple API instances:

- use S3 or WebDAV, or a shared filesystem visible to all nodes
- avoid node-local attachment storage unless traffic is pinned and storage is shared externally

## Secrets Handling

Treat the following as secrets:

- `DATABASE_URL`
- `OPS_BEARER_TOKEN`
- `OIDC_PROXY_SECRET`
- `ATTACHMENT_ENCRYPTION_PRIMARY_KEY`
- `ATTACHMENT_ENCRYPTION_FALLBACK_KEYS`
- `ATTACHMENT_S3_SECRET_ACCESS_KEY`
- `ATTACHMENT_WEBDAV_APP_PASSWORD`
- `PUSH_DELIVERY_WEBHOOK_AUTH_HEADER`

Do not embed these into static web assets.

## Rollout Validation

After each rollout:

- call `/health`
- call `/ready`
- sign in through the web client
- verify `/bootstrap` returns data
- verify a WebSocket session receives `sync:snapshot`
- upload and download a test attachment if attachment storage is enabled
- execute an admin action and confirm an audit event is recorded

## Related Documents

- [Configuration](configuration.md)
- [Operations](operations.md)
- [Security](security.md)
