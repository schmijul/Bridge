# Security Guide

This guide summarizes the main trust boundaries and security-sensitive controls in Bridge.

## Trust Boundaries

Bridge trusts different inputs depending on deployment mode:

- direct user credentials in `AUTH_MODE=local`
- proxy-supplied identity headers in `AUTH_MODE=oidc`
- session cookies for browser and WebSocket authentication
- bearer tokens for bot message posting and optionally for ops endpoints
- attachment backend credentials for object storage access

Each of these surfaces should be configured deliberately.

## Authentication Modes

### Local authentication

- entrypoint: `POST /auth/login`
- credentials are verified against stored password hashes
- login endpoints are rate limited by source address and credential failure window
- password changes are available through `POST /auth/change-password`

### OIDC proxy authentication

- entrypoint: `POST /auth/oidc/login`
- Bridge expects identity to be established upstream
- the proxy may be hardened with `OIDC_PROXY_SECRET`
- role mapping can be derived from configured group names

If `OIDC_PROXY_SECRET` is not set, Bridge trusts the header source purely by network placement and proxy discipline. In production-style OIDC deployments, set the secret and restrict direct access to the API.

## Session Security

- session cookie name: `bridge_session`
- cookies are `HttpOnly`
- enable `SESSION_COOKIE_SECURE=true` under HTTPS
- use `SESSION_COOKIE_DOMAIN` only when cross-subdomain scoping is required
- default session lifetime is seven days in the current auth implementation

## CSRF Protection

Bridge enforces CSRF protection for session-authenticated mutating requests when `CSRF_PROTECTION_ENABLED=true`, which is the code default.

Requirement:

- send `x-bridge-csrf: 1` on non-GET session-authenticated requests that are not explicitly exempt

Bearer-token-authenticated requests are excluded from this CSRF check.

## Proxy and IP Trust

Only enable `TRUST_PROXY_HEADERS=true` when the reverse proxy is authoritative for client source IPs and strips untrusted incoming forwarding headers. This setting affects rate limiting and client address evaluation.

## Operator Endpoints

- `/metrics` and `/ready` can be protected with `OPS_BEARER_TOKEN`
- `/health` is always unauthenticated

If metrics or readiness are exposed beyond a private monitoring plane, configure `OPS_BEARER_TOKEN`.

## Attachment Security Controls

### Encryption at rest

Use:

- `ATTACHMENT_ENCRYPTION_PRIMARY_KEY`
- `ATTACHMENT_ENCRYPTION_PRIMARY_KEY_ID`
- `ATTACHMENT_ENCRYPTION_FALLBACK_KEYS`

Keys must be 32 bytes in hex or base64. Fallback keys support decryption during key rotation.

### Malware scanning

Use:

- `ATTACHMENT_SCAN_MODE=command`
- `ATTACHMENT_SCAN_COMMAND` with `{file}` placeholder

Rejected uploads generate audit activity and are not accepted into the workspace.

### Extension blocking

Bridge blocks a set of executable or script-like file extensions. Override this set carefully with `ATTACHMENT_BLOCKED_EXTENSIONS` only when your operational risk model requires it.

## Bot Token Handling

- bot tokens are issued once on creation or rotation
- active tokens can be revoked through the admin API
- bot posting uses `Authorization: Bearer <token>` on `POST /bots/messages`
- rotate tokens whenever integration ownership changes or token leakage is suspected

## Rate Limiting

Bridge applies rate limits to:

- login attempts
- repeated login failures
- authenticated API traffic
- inbound WebSocket messages

Tune these values for your traffic pattern instead of removing them.

## Desktop Shell Hardening

The Electron shell uses:

- `contextIsolation: true`
- `nodeIntegration: false`
- `sandbox: true`
- `webSecurity: true`
- blocked in-window navigation to external origins
- external link handoff via the operating system shell

Treat the desktop shell as a wrapper around a trusted Bridge web origin. Do not point it at arbitrary third-party content.

## Security Checklist

- set `STORE_DRIVER=postgres`
- enable TLS at the edge
- set `SESSION_COOKIE_SECURE=true`
- protect `/metrics` and `/ready` with `OPS_BEARER_TOKEN`
- set `OIDC_PROXY_SECRET` when using `AUTH_MODE=oidc`
- enable attachment encryption for sensitive deployments
- enable malware scanning where file upload risk is material
- keep Redis private to the application network
- store bot tokens and attachment backend credentials in a secret manager

## Related Documents

- [Configuration](configuration.md)
- [Operations](operations.md)
- [Deployment](deployment.md)
