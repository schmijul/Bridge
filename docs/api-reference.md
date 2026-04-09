# API Reference

This reference covers the current Bridge HTTP and realtime interfaces.

## Conventions

- Session-authenticated browser and mobile requests use the `bridge_session` cookie.
- Most mutating session-authenticated requests require `x-bridge-csrf: 1` when CSRF protection is enabled.
- Bearer token authentication is used for bot posting and optionally for ops endpoints.
- All endpoints may echo `x-request-id` in responses.

## Health and Ops

| Method | Path | Auth | Notes |
| --- | --- | --- | --- |
| `GET` | `/health` | none | Liveness check |
| `GET` | `/ready` | optional bearer | Store and Redis readiness |
| `GET` | `/metrics` | optional bearer | Prometheus text format |

## Authentication

| Method | Path | Auth | Notes |
| --- | --- | --- | --- |
| `GET` | `/auth/mode` | none | Returns `{ mode }` |
| `POST` | `/auth/login` | none | Local email/password login |
| `POST` | `/auth/oidc/login` | none, trusted proxy headers | OIDC proxy login, only in `AUTH_MODE=oidc` |
| `GET` | `/auth/me` | session | Returns current user |
| `POST` | `/auth/change-password` | session | Local mode only |
| `POST` | `/auth/logout` | session optional | Clears session cookie |

### `POST /auth/login`

Request body:

```json
{
  "email": "alex@bridge.local",
  "password": "bridge123!"
}
```

Response body:

```json
{
  "user": {
    "id": "u-1",
    "displayName": "Alex",
    "email": "alex@bridge.local",
    "role": "admin"
  }
}
```

### `POST /auth/change-password`

Request body:

```json
{
  "currentPassword": "old-password",
  "newPassword": "NewSecurePassword123!"
}
```

## Bootstrap and Workspace

| Method | Path | Auth | Notes |
| --- | --- | --- | --- |
| `GET` | `/bootstrap` | session | Returns users, channels, messages, online users, workspace, and cursor |
| `GET` | `/me/unread` | session | Returns workspace unread summary |
| `POST` | `/read-state` | session | Updates channel read progress and optionally notification read state |

### `POST /read-state`

Request body:

```json
{
  "channelId": "c-general",
  "lastMessageId": "m-7",
  "markNotificationsReadUpToMessage": true
}
```

## Search

| Method | Path | Auth | Notes |
| --- | --- | --- | --- |
| `GET` | `/search/messages` | session | Message search with term and metadata filters |

Query parameters:

- `q`
- `channelId`
- `fromUserId`
- `before`
- `after`
- `offset`
- `limit`

`before` and `after` use ISO 8601 timestamps.

## Attachments

| Method | Path | Auth | Notes |
| --- | --- | --- | --- |
| `POST` | `/attachments` | session | Multipart upload with `file`, `channelId`, and optional `threadRootMessageId` |
| `DELETE` | `/attachments/:attachmentId` | session | Removes a pending upload owned by the caller |
| `GET` | `/attachments/:attachmentId/download` | session | Downloads a ready attachment with ACL enforcement |

Upload response:

```json
{
  "attachment": {
    "id": "uuid",
    "channelId": "c-general",
    "uploaderId": "u-1",
    "originalName": "notes.pdf",
    "mimeType": "application/pdf",
    "sizeBytes": 12345,
    "status": "pending",
    "createdAt": "2026-04-09T12:00:00.000Z"
  }
}
```

## Notifications

| Method | Path | Auth | Notes |
| --- | --- | --- | --- |
| `GET` | `/notifications` | session | Feed, counts, and current preferences |
| `POST` | `/notifications/read` | session | Marks explicit notifications or all notifications read |
| `GET` | `/notifications/preferences` | session | Returns notification preferences |
| `PATCH` | `/notifications/preferences` | session | Updates mention and direct-message preferences |
| `PUT` | `/me/push-devices/:installationId` | session | Registers or updates a push device |
| `DELETE` | `/me/push-devices/:installationId` | session | Disables a registered push device |
| `GET` | `/me/push-devices` | session | Lists the caller’s registered devices |

### `POST /notifications/read`

Request body options:

```json
{
  "all": true
}
```

or

```json
{
  "notificationIds": ["notif-1", "notif-2"]
}
```

## Direct Messages

| Method | Path | Auth | Notes |
| --- | --- | --- | --- |
| `GET` | `/dm/conversations` | session | Lists direct and group direct message channels available to the caller |
| `POST` | `/dm/conversations` | session | Creates or reuses a DM / group DM |

Request body:

```json
{
  "participantUserIds": ["u-2", "u-3"]
}
```

## Admin

| Method | Path | Auth | Notes |
| --- | --- | --- | --- |
| `GET` | `/admin/overview` | admin | Returns workspace-wide admin data |
| `GET` | `/admin/audit/export` | admin | JSON or CSV audit export |
| `POST` | `/admin/channels` | admin | Creates a workspace channel |
| `PATCH` | `/admin/channels/:channelId` | admin | Archives a channel |
| `POST` | `/admin/channels/:channelId/members` | admin | Adds member to a private channel |
| `DELETE` | `/admin/channels/:channelId/members/:userId` | admin | Removes member from a private channel |
| `POST` | `/admin/users` | admin | Creates a user and returns an initial password |
| `PATCH` | `/admin/users/:userId/role` | admin | Changes a user role |
| `PATCH` | `/admin/users/:userId/status` | admin | Activates or deactivates a user |
| `GET` | `/admin/bots` | admin | Lists bot users |
| `POST` | `/admin/bots` | admin | Creates a bot and returns a one-time token |
| `POST` | `/admin/bots/:botUserId/token` | admin | Rotates bot token |
| `DELETE` | `/admin/bots/:botUserId/token` | admin | Revokes bot tokens |
| `PATCH` | `/admin/settings` | admin | Updates workspace settings |
| `GET` | `/admin/notifications/delivery` | admin | Returns push delivery runner status |
| `POST` | `/admin/notifications/delivery/run` | admin | Runs a one-shot push delivery batch |
| `POST` | `/admin/maintenance/retention-run` | admin | Executes retention sweep |
| `DELETE` | `/admin/messages/:messageId` | admin | Deletes a message and attempts attachment cleanup |

### `GET /admin/audit/export`

Supported query parameters:

- `format=json|csv`
- `action`
- `actorId`
- `since`
- `until`
- `offset`
- `limit`

### `PATCH /admin/settings`

Request body may include:

```json
{
  "workspaceName": "Bridge Product Team",
  "messageRetentionDays": 365,
  "allowGuestAccess": false,
  "enforceMfaForAdmins": true
}
```

## Bots

| Method | Path | Auth | Notes |
| --- | --- | --- | --- |
| `POST` | `/bots/messages` | bearer token | Posts a message as a bot |

Request body:

```json
{
  "channelId": "c-general",
  "content": "Deployment complete",
  "threadRootMessageId": "m-4"
}
```

## Realtime WebSocket

### Connection

- endpoint: WebSocket connection to the configured API base URL root
- authentication: valid `bridge_session` cookie must be present during handshake
- initial server message: `sync:snapshot`

### Client events

```json
{
  "type": "message:send",
  "payload": {
    "channelId": "c-general",
    "content": "hello",
    "tempId": "temp-1",
    "threadRootMessageId": "m-4",
    "attachmentIds": ["attachment-1"]
  }
}
```

Other client event types:

- `presence:update`
- `typing:update`
- `read:update`

### Server events

The server may emit:

- `sync:snapshot`
- `message:new`
- `message:deleted`
- `channel:created`
- `channel:updated`
- `user:updated`
- `workspace:updated`
- `audit:new`
- `presence:changed`
- `typing:changed`
- `read:changed`
- `error`

### Realtime limits

Inbound WebSocket traffic is rate limited by:

- `WS_MESSAGE_RATE_LIMIT_MAX`
- `WS_MESSAGE_RATE_LIMIT_WINDOW_MS`

The server emits an `error` event when the socket exceeds the rate limit.

## Related Documents

- [Architecture](architecture.md)
- [Admin Guide](admin-guide.md)
- [Security](security.md)
