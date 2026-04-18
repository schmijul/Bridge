# Operations Guide

This guide covers routine operator workflows for running Bridge after deployment.

## Service Health Endpoints

### `GET /health`

- purpose: simple liveness check
- authentication: none
- success response: `200` with `{ "ok": true }`

### `GET /ready`

- purpose: dependency readiness for the configured store and Redis
- authentication: bearer token required only when `OPS_BEARER_TOKEN` is set
- success response: `200` when the required dependencies are healthy
- degraded response: `503` when Postgres or configured Redis are unhealthy

The response includes:

- current timestamp
- store driver and status detail
- Redis configured flag and health detail

### `GET /metrics`

- purpose: Prometheus-compatible counters
- authentication: bearer token required only when `OPS_BEARER_TOKEN` is set
- content type: `text/plain; version=0.0.4; charset=utf-8`

## Routine Operator Tasks

### Run migrations

Use a controlled rollout step before deploying a new server version:

```bash
npm run db:migrate -w @bridge/server
```

Avoid relying on `RUN_MIGRATIONS_ON_BOOT=true` for change-management-heavy environments unless that is an explicit platform policy.

### Rotate a bot token

- use the admin UI or `POST /admin/bots/:botUserId/token`
- distribute the returned token immediately
- the rotated token is returned once and should be stored securely by the consuming system

### Revoke bot tokens

- use the admin UI or `DELETE /admin/bots/:botUserId/token`
- verify dependent integrations fail closed after revocation

### Run a retention sweep

Invoke:

```text
POST /admin/maintenance/retention-run
```

The result includes deleted message and attachment counts plus the cutoff timestamp derived from `workspace.settings.messageRetentionDays`.

### Inspect push delivery status

Use:

- `GET /admin/notifications/delivery`
- `POST /admin/notifications/delivery/run`

These endpoints report and trigger the in-process push delivery runner.

## Backup Guidance

Back up the durable system of record:

- Postgres database
- attachment backend contents
- secret material used for auth, attachment encryption, and push delivery

Redis can usually be treated as disposable in Bridge because it is used for realtime pub/sub rather than primary data storage.

## Logging and Request Tracing

- Bridge echoes `x-request-id` when supplied by the caller
- if no request ID is supplied, the server generates one
- propagate the same request ID through reverse proxies and synthetic monitoring jobs when possible

## Build and Release Validation

Recommended pre-release command:

```bash
npm run smoke
```

This script performs linting, tests, builds, starts the server, and validates a minimal API flow.

## Operational Checks After Restart

- verify `/ready` returns `200`
- sign in as an admin user
- confirm the admin overview loads
- create or archive a non-critical test channel if a full write-path check is needed
- confirm attachments, unread counters, and notifications operate normally

## Failure Domains

| Dependency | Symptoms when unhealthy |
| --- | --- |
| Postgres | durable mode startup failures, migration errors, auth/session persistence failures, notification queue issues |
| Redis | degraded `/ready`, missing cross-instance realtime fanout, reconnect noise |
| Attachment backend | upload failures, download errors, retention cleanup side effects |
| Push webhook target | queued or retried deliveries, elevated delivery error counters |

## Related Documents

- [Deployment](deployment.md)
- [Security](security.md)
- [Troubleshooting](troubleshooting.md)
