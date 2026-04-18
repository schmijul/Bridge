# Bridge Documentation

This directory contains the operator-facing and engineering documentation for Bridge.

## Core Documents

| Document | Purpose |
| --- | --- |
| [Overview](overview.md) | Platform summary, component map, supported clients, and deployment models |
| [Architecture](architecture.md) | Runtime design, data flow, realtime model, and service boundaries |
| [Installation](installation.md) | Local setup, bootstrap sequence, validation, and developer startup workflows |
| [Configuration](configuration.md) | Authoritative environment variable and runtime configuration reference |
| [Deployment](deployment.md) | Production deployment model, startup order, scaling guidance, and reverse proxy expectations |
| [Operations](operations.md) | Day-2 tasks, health checks, migrations, retention, and backup guidance |
| [Security](security.md) | Auth modes, trust boundaries, hardening controls, and security-sensitive settings |
| [Admin Guide](admin-guide.md) | Role model and operator workflows in the admin board and admin APIs |
| [API Reference](api-reference.md) | HTTP endpoints and realtime WebSocket contract |
| [Troubleshooting](troubleshooting.md) | Common failure modes and corrective actions |

## Recommended Reading Order

1. [Overview](overview.md)
2. [Installation](installation.md)
3. [Configuration](configuration.md)
4. [Deployment](deployment.md)
5. [Operations](operations.md)
6. [Security](security.md)
7. [Admin Guide](admin-guide.md)
8. [API Reference](api-reference.md)

## Related Repository Entrypoints

- Root project summary: [`../README.md`](../README.md)
- Server example environment: [`../apps/server/.env.example`](../apps/server/.env.example)
- Web example environment: [`../apps/web/.env.example`](../apps/web/.env.example)
- Mobile example environment: [`../apps/mobile/.env.example`](../apps/mobile/.env.example)
