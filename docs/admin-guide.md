# Admin Guide

Bridge includes an admin board in the web client plus corresponding admin APIs for operators with elevated roles.

## Role Model

| Role | Typical capabilities |
| --- | --- |
| `admin` | Full admin board access, channel and user management, bot lifecycle, settings changes, retention, moderation |
| `manager` | Treated as privileged in the web client and receives admin overview access in current behavior |
| `member` | Standard workspace participation |
| `guest` | Restricted role intended for limited workspace participation when enabled by policy |

In the current server implementation, admin-only API checks cover the admin surface. The web client also treats both `admin` and `manager` as privileged for UI visibility.

## Admin Overview

`GET /admin/overview` returns:

- workspace settings
- user list
- channel list
- channel membership map
- message list
- audit log
- summary stats

Use this as the primary operator snapshot for workspace state.

## Channel Administration

### Create a channel

Use:

```text
POST /admin/channels
```

Payload fields:

- `name`
- `description`
- `isPrivate`

The server rejects duplicate active channel names.

### Archive a channel

Use:

```text
PATCH /admin/channels/:channelId
```

Archiving removes the channel from the active workspace view without deleting historical data immediately.

### Manage private channel membership

Use:

- `POST /admin/channels/:channelId/members`
- `DELETE /admin/channels/:channelId/members/:userId`

These endpoints apply only to private workspace channels.

## User Administration

### Invite a user

Use:

```text
POST /admin/users
```

The server creates the user and returns an `initialPassword`. Handle this value as a secret and distribute it through a secure onboarding path.

### Change a role

Use:

```text
PATCH /admin/users/:userId/role
```

Role changes invalidate the target user’s active sessions.

### Activate or deactivate a user

Use:

```text
PATCH /admin/users/:userId/status
```

Status changes also invalidate active sessions.

## Bot Administration

### Create a bot

Use:

```text
POST /admin/bots
```

The response returns:

- the bot user record
- a one-time bearer token

### List bots

Use:

```text
GET /admin/bots
```

Current responses include active token counts and the timestamp of the most recently created active token.

### Rotate a bot token

Use:

```text
POST /admin/bots/:botUserId/token
```

This replaces the active token set for the bot and returns the new token once.

### Revoke bot tokens

Use:

```text
DELETE /admin/bots/:botUserId/token
```

Use revocation for incident response or integration retirement.

## Governance and Security Settings

Use:

```text
PATCH /admin/settings
```

Current workspace settings are:

- `workspaceName`
- `messageRetentionDays`
- `allowGuestAccess`
- `enforceMfaForAdmins`

`messageRetentionDays` is later enforced by explicit retention runs.

## Moderation and Audit

### Delete a message

Use:

```text
DELETE /admin/messages/:messageId
```

Deleting a message also removes its linked attachment objects where possible.

### Export audit activity

Use:

```text
GET /admin/audit/export
```

Supported query parameters:

- `format=json|csv`
- `action`
- `actorId`
- `since`
- `until`
- `offset`
- `limit`

## Notification Delivery Operations

Operators can inspect and run notification delivery batches with:

- `GET /admin/notifications/delivery`
- `POST /admin/notifications/delivery/run`

## Maintenance Workflow

Retention is executed on demand through:

```text
POST /admin/maintenance/retention-run
```

Plan this as an operator task or scheduled control-plane action if you need regular retention enforcement.

## Related Documents

- [Operations](operations.md)
- [Security](security.md)
- [API Reference](api-reference.md)
