# Configuration Reference

This document is the authoritative runtime configuration reference for Bridge.

## Server Core

| Variable | Default | Required | Notes |
| --- | --- | --- | --- |
| `PORT` | `4000` | No | API listen port |
| `CORS_ORIGIN` | `http://localhost:5173` | No | Comma-separated allowlist for browser origins |
| `AUTH_MODE` | `local` | No | `local` or `oidc` |
| `STORE_DRIVER` | `memory` in code, `postgres` in example env | No | `memory` for transient mode, `postgres` for durable mode |
| `DATABASE_URL` | none | Yes when `STORE_DRIVER=postgres` | Postgres connection string |
| `REDIS_URL` | none | No | Enables Redis-backed realtime coordinator |
| `RUN_MIGRATIONS_ON_BOOT` | `false` in code, `true` in example env | No | Applies migrations automatically during server startup in Postgres mode |

## Sessions, Cookies, and Proxy Awareness

| Variable | Default | Required | Notes |
| --- | --- | --- | --- |
| `SESSION_COOKIE_SECURE` | `false` | No | Enable behind HTTPS |
| `SESSION_COOKIE_SAMESITE` | `lax` | No | `lax`, `strict`, or `none` |
| `SESSION_COOKIE_DOMAIN` | unset | No | Scope cookie to a parent domain when required |
| `TRUST_PROXY_HEADERS` | `false` | No | Uses `x-forwarded-for` for client IP and rate limiting |
| `CSRF_PROTECTION_ENABLED` | `true` in code | No | Session-authenticated mutating requests must send `x-bridge-csrf: 1` unless exempt |

Exempt CSRF paths are:

- `/auth/login`
- `/auth/oidc/login`
- `/auth/logout`
- `/bots/messages`
- `/health`
- `/ready`
- `/metrics`
- `/auth/mode`

## Auth and Login Rate Limits

| Variable | Default | Required | Notes |
| --- | --- | --- | --- |
| `AUTH_LOGIN_RATE_LIMIT_MAX` | `20` | No | Login burst limit |
| `AUTH_LOGIN_RATE_LIMIT_WINDOW_MS` | `300000` | No | Login burst window |
| `AUTH_LOGIN_FAILURE_LIMIT_MAX` | `6` | No | Invalid credential lockout threshold |
| `AUTH_LOGIN_FAILURE_LIMIT_WINDOW_MS` | `900000` | No | Invalid credential lockout window |
| `API_RATE_LIMIT_MAX` | `180` | No | Per-actor authenticated API limit |
| `API_RATE_LIMIT_WINDOW_MS` | `60000` | No | Authenticated API window |
| `WS_MESSAGE_RATE_LIMIT_MAX` | `60` | No | Per-socket inbound WebSocket message limit |
| `WS_MESSAGE_RATE_LIMIT_WINDOW_MS` | `10000` | No | WebSocket rate limit window |

## OIDC Proxy Mode

These settings only apply when `AUTH_MODE=oidc`.

| Variable | Default | Required | Notes |
| --- | --- | --- | --- |
| `OIDC_PROXY_SECRET` | unset | Recommended | Shared secret to prevent header spoofing |
| `OIDC_PROXY_SECRET_HEADER` | `x-proxy-secret` | No | Header name that carries the shared secret |
| `OIDC_EMAIL_HEADER` | `x-auth-request-email` | No | Header carrying the authenticated user email |
| `OIDC_DISPLAY_NAME_HEADER` | `x-auth-request-name` | No | Header carrying display name |
| `OIDC_GROUPS_HEADER` | `x-auth-request-groups` | No | Comma-separated group list |
| `OIDC_ROLE_GROUP_ADMIN` | unset | No | Comma-separated groups mapped to `admin` |
| `OIDC_ROLE_GROUP_MANAGER` | unset | No | Comma-separated groups mapped to `manager` |
| `OIDC_ROLE_GROUP_MEMBER` | unset | No | Comma-separated groups mapped to `member` |
| `OIDC_ROLE_GROUP_GUEST` | unset | No | Comma-separated groups mapped to `guest` |

If no configured group matches, Bridge falls back to `member`.

## Attachments

| Variable | Default | Required | Notes |
| --- | --- | --- | --- |
| `ATTACHMENT_STORAGE_DRIVER` | `local` | No | `local`, `s3`, or `webdav` |
| `ATTACHMENT_LOCAL_DIR` | `.bridge_uploads` | No | Local storage path for `local` mode |
| `ATTACHMENT_MAX_SIZE_BYTES` | `26214400` | No | Maximum accepted upload size |
| `ATTACHMENT_BLOCKED_EXTENSIONS` | built-in set | No | Comma-separated extension override |

### Attachment encryption

| Variable | Default | Required | Notes |
| --- | --- | --- | --- |
| `ATTACHMENT_ENCRYPTION_PRIMARY_KEY` | unset | No | 32-byte key in hex or base64 |
| `ATTACHMENT_ENCRYPTION_PRIMARY_KEY_ID` | `primary` | No | Label stored with encrypted payload metadata |
| `ATTACHMENT_ENCRYPTION_FALLBACK_KEYS` | unset | No | Comma-separated `keyId=key` entries for decrypting older files |
| `ATTACHMENT_ENCRYPTION_KEY` | unset | No | Legacy single-key alias retained for compatibility |

### Attachment scanning

| Variable | Default | Required | Notes |
| --- | --- | --- | --- |
| `ATTACHMENT_SCAN_MODE` | `none` | No | `none` or `command` |
| `ATTACHMENT_SCAN_COMMAND` | unset | Required when `ATTACHMENT_SCAN_MODE=command` | Must include `{file}` placeholder |
| `ATTACHMENT_SCAN_TIMEOUT_MS` | `10000` | No | Scanner timeout |

### S3 backend

Required when `ATTACHMENT_STORAGE_DRIVER=s3`:

| Variable | Default | Notes |
| --- | --- | --- |
| `ATTACHMENT_S3_BUCKET` | none | Bucket name |
| `ATTACHMENT_S3_ACCESS_KEY_ID` | none | Access key |
| `ATTACHMENT_S3_SECRET_ACCESS_KEY` | none | Secret key |
| `ATTACHMENT_S3_REGION` | `us-east-1` | Region |
| `ATTACHMENT_S3_ENDPOINT` | unset | Optional custom endpoint such as MinIO |
| `ATTACHMENT_S3_KEY_PREFIX` | `bridge/uploads` | Prefix applied to object keys |
| `ATTACHMENT_S3_FORCE_PATH_STYLE` | `true` | Useful for S3-compatible local endpoints |

### WebDAV backend

Required when `ATTACHMENT_STORAGE_DRIVER=webdav`:

| Variable | Default | Notes |
| --- | --- | --- |
| `ATTACHMENT_WEBDAV_BASE_URL` | none | Must use `https` unless explicitly allowed for loopback development |
| `ATTACHMENT_WEBDAV_USERNAME` | none | Service user |
| `ATTACHMENT_WEBDAV_APP_PASSWORD` | none | Use an app password, not a primary user password |
| `ATTACHMENT_WEBDAV_PATH_PREFIX` | `bridge/attachments` | Path prefix beneath the WebDAV base URL |
| `ATTACHMENT_WEBDAV_ALLOW_INSECURE` | `false` | Only for `localhost`, `127.0.0.1`, or `[::1]` development URLs |

## Push Delivery Worker

| Variable | Default | Required | Notes |
| --- | --- | --- | --- |
| `PUSH_DELIVERY_ENABLED` | `false` | No | Enables the in-process push delivery runner |
| `PUSH_DELIVERY_PROVIDER` | `webhook` | No | Current code accepts only `webhook` |
| `PUSH_DELIVERY_WEBHOOK_URL` | unset | Required when enabled | HTTP target for delivery batches |
| `PUSH_DELIVERY_WEBHOOK_AUTH_HEADER` | unset | No | Optional `Authorization` header value |
| `PUSH_DELIVERY_POLL_INTERVAL_MS` | `3000` | No | Polling interval |
| `PUSH_DELIVERY_BATCH_SIZE` | `20` | No | Batch size per run |
| `PUSH_DELIVERY_MAX_ATTEMPTS` | `5` | No | Max attempts before terminal failure |
| `PUSH_DELIVERY_RETRY_BASE_MS` | `5000` | No | Initial retry backoff |
| `PUSH_DELIVERY_RETRY_MAX_MS` | `300000` | No | Max retry backoff |

## Operator Endpoints

| Variable | Default | Required | Notes |
| --- | --- | --- | --- |
| `OPS_BEARER_TOKEN` | unset | No | When set, `/metrics` and `/ready` require `Authorization: Bearer <token>` |

## Web Client

| Variable | Default | Required | Notes |
| --- | --- | --- | --- |
| `VITE_API_URL` | `http://localhost:4000` | No | API base URL used by the browser client |
| `VITE_WS_URL` | `ws://localhost:4000` | No | WebSocket endpoint base URL |

## Mobile Client

| Variable | Default | Required | Notes |
| --- | --- | --- | --- |
| `API_URL` | `http://localhost:4000` | No | API base URL exposed via Expo config |
| `WS_URL` | `ws://localhost:4000` | No | Stored in Expo config for mobile runtime consumers |

## Desktop Shell

| Variable | Default | Required | Notes |
| --- | --- | --- | --- |
| `BRIDGE_DESKTOP_URL` | `http://localhost:5173` | No | Preferred URL for the desktop shell |
| `BRIDGE_WEB_URL` | none | No | Fallback alias used when `BRIDGE_DESKTOP_URL` is unset |
| `BRIDGE_DESKTOP_CLOSE_TO_TRAY` | `true` | No | Hides to tray on window close |
| `BRIDGE_DESKTOP_START_HIDDEN` | `false` | No | Starts hidden instead of showing immediately |

## Configuration Guidelines

- Use `STORE_DRIVER=postgres` for any deployment that must preserve data across process restarts.
- Keep `SESSION_COOKIE_SECURE=true` whenever Bridge is served over HTTPS.
- Use `SESSION_COOKIE_SAMESITE=none` only when you intentionally run the web client on a different site and also enable `SESSION_COOKIE_SECURE=true`.
- Treat `OIDC_PROXY_SECRET` and any attachment encryption keys as secrets, not as regular config.
- Use Redis whenever more than one API instance can emit or consume realtime traffic.

## Related Documents

- [Deployment](deployment.md)
- [Security](security.md)
- [Troubleshooting](troubleshooting.md)
