# API reference

_Generated from the controllers by `scripts/gen-api-reference.mjs`. Do not edit by hand._

Every route is prefixed with `/api/v1`. There are **188** of them across
**23** controllers.

For request and response shapes, worked examples and error codes, see
[PUBLIC-API.md](PUBLIC-API.md) — this page is the complete surface, that one is the guide.

## Authentication

Unless a route is marked **public**, it needs a signed-in session: a JWT in the
`access_token` cookie, or `Authorization: Bearer <token>`. Role, business and
capabilities are re-read from the database on every request — the token is used
for identity only, never for authorisation.

A **capability** column names the permission a Business User must hold. Platform
Admins and Business Owners are not confined by it; see
[access-control.md](access-control.md).

**Throttled** routes have a per-route rate limit on top of the global one.

---

## Administration

`apps/api/src/admin/admin.controller.ts`

| Method | Path | Access | Capability |
|---|---|---|---|
| `GET` | `/api/v1/admin/platform-settings` | signed in | — |
| `PATCH` | `/api/v1/admin/platform-settings` | signed in | — |
| `GET` | `/api/v1/admin/search` | signed in | — |
| `GET` | `/api/v1/admin/status` | signed in | — |
| `GET` | `/api/v1/admin/unassigned-devices` | signed in | — |
| `POST` | `/api/v1/admin/unassigned-devices/:id/assign` | signed in | — |

## API keys

`apps/api/src/apikeys/apikeys.controller.ts`

| Method | Path | Access | Capability |
|---|---|---|---|
| `GET` | `/api/v1/apikeys` | signed in | — |
| `POST` | `/api/v1/apikeys` | signed in | — |
| `DELETE` | `/api/v1/apikeys/:id` | signed in | — |

## Audit log

`apps/api/src/audit/audit.controller.ts`

| Method | Path | Access | Capability |
|---|---|---|---|
| `GET` | `/api/v1/audit` | signed in | `AUDIT_VIEW` |

## Authentication

`apps/api/src/auth/auth.controller.ts`

| Method | Path | Access | Capability |
|---|---|---|---|
| `POST` | `/api/v1/auth/change-password` | signed in | — |
| `POST` | `/api/v1/auth/login` | public, throttled | — |
| `POST` | `/api/v1/auth/logout` | signed in | — |
| `GET` | `/api/v1/auth/me` | signed in | — |
| `POST` | `/api/v1/auth/mfa/verify` | public, throttled | — |
| `GET` | `/api/v1/auth/profile` | signed in | — |
| `PATCH` | `/api/v1/auth/profile` | signed in | — |

## Businesses

`apps/api/src/businesses/businesses.controller.ts` — mounted at `/businesses` and `/customers`

| Method | Path | Access | Capability |
|---|---|---|---|
| `GET` | `/api/v1/businesses` | signed in | — |
| `POST` | `/api/v1/businesses` | signed in | — |
| `GET` | `/api/v1/businesses/:id` | signed in | — |
| `PATCH` | `/api/v1/businesses/:id` | signed in | — |
| `DELETE` | `/api/v1/businesses/:id` | signed in | — |
| `PATCH` | `/api/v1/businesses/:id/archive` | signed in | — |
| `GET` | `/api/v1/businesses/:id/users` | signed in | `USERS_VIEW` |
| `POST` | `/api/v1/businesses/:id/users` | signed in | `USERS_MANAGE` |
| `DELETE` | `/api/v1/businesses/:id/users/:userId` | signed in | `USERS_MANAGE` |
| `PATCH` | `/api/v1/businesses/:id/users/:userId/active` | signed in | `USERS_MANAGE` |
| `PATCH` | `/api/v1/businesses/:id/users/:userId/capabilities` | signed in | `USERS_MANAGE` |
| `POST` | `/api/v1/businesses/:id/users/:userId/reset-access` | signed in | `USERS_MANAGE` |
| `GET` | `/api/v1/businesses/capability-catalog` | signed in | — |
| `GET` | `/api/v1/customers` | signed in | — |
| `POST` | `/api/v1/customers` | signed in | — |
| `GET` | `/api/v1/customers/:id` | signed in | — |
| `PATCH` | `/api/v1/customers/:id` | signed in | — |
| `DELETE` | `/api/v1/customers/:id` | signed in | — |
| `PATCH` | `/api/v1/customers/:id/archive` | signed in | — |
| `GET` | `/api/v1/customers/:id/users` | signed in | `USERS_VIEW` |
| `POST` | `/api/v1/customers/:id/users` | signed in | `USERS_MANAGE` |
| `DELETE` | `/api/v1/customers/:id/users/:userId` | signed in | `USERS_MANAGE` |
| `PATCH` | `/api/v1/customers/:id/users/:userId/active` | signed in | `USERS_MANAGE` |
| `PATCH` | `/api/v1/customers/:id/users/:userId/capabilities` | signed in | `USERS_MANAGE` |
| `POST` | `/api/v1/customers/:id/users/:userId/reset-access` | signed in | `USERS_MANAGE` |
| `GET` | `/api/v1/customers/capability-catalog` | signed in | — |

## Dashboard

`apps/api/src/dashboard/dashboard.controller.ts`

| Method | Path | Access | Capability |
|---|---|---|---|
| `GET` | `/api/v1/dashboard` | signed in | — |
| `GET` | `/api/v1/dashboard/platform` | signed in | — |

## Client downloads

`apps/api/src/downloads/downloads.controller.ts`

| Method | Path | Access | Capability |
|---|---|---|---|
| `GET` | `/api/v1/downloads` | signed in | — |
| `GET` | `/api/v1/downloads/rustdesk/configured` | signed in | — |
| `GET` | `/api/v1/downloads/rustdesk/plain` | signed in | — |
| `GET` | `/api/v1/downloads/rustdesk/setup.cmd` | signed in | — |

## Computers

`apps/api/src/endpoints/endpoints.controller.ts`

| Method | Path | Access | Capability |
|---|---|---|---|
| `GET` | `/api/v1/endpoints` | signed in | `COMPUTERS_VIEW` |
| `POST` | `/api/v1/endpoints` | signed in | `COMPUTERS_ADD` |
| `GET` | `/api/v1/endpoints/:id` | signed in | `COMPUTERS_VIEW` |
| `PATCH` | `/api/v1/endpoints/:id` | signed in | `COMPUTERS_EDIT` |
| `GET` | `/api/v1/endpoints/:id/access` | signed in | `USERS_VIEW` |
| `POST` | `/api/v1/endpoints/:id/access` | signed in | `USERS_MANAGE` |
| `PATCH` | `/api/v1/endpoints/:id/access-mode` | signed in | `COMPUTERS_EDIT` |
| `DELETE` | `/api/v1/endpoints/:id/access/:userId` | signed in | `USERS_MANAGE` |
| `POST` | `/api/v1/endpoints/:id/aliases` | signed in | `COMPUTERS_EDIT` |
| `DELETE` | `/api/v1/endpoints/:id/aliases/:aliasId` | signed in | `COMPUTERS_EDIT` |
| `PATCH` | `/api/v1/endpoints/:id/archive` | signed in | `COMPUTERS_REMOVE` |
| `POST` | `/api/v1/endpoints/:id/connect` | signed in, throttled | `COMPUTERS_CONNECT` |
| `GET` | `/api/v1/endpoints/:id/connect.cmd` | signed in, throttled | `COMPUTERS_CONNECT` |
| `GET` | `/api/v1/endpoints/:id/password` | signed in, throttled | `COMPUTERS_EDIT` |
| `PATCH` | `/api/v1/endpoints/:id/password` | signed in | `COMPUTERS_EDIT` |
| `POST` | `/api/v1/endpoints/:id/rotate-credential` | signed in | `COMPUTERS_EDIT` |
| `POST` | `/api/v1/endpoints/:id/tags` | signed in | `COMPUTERS_EDIT` |
| `DELETE` | `/api/v1/endpoints/:id/tags/:tag` | signed in | `COMPUTERS_EDIT` |
| `POST` | `/api/v1/endpoints/:id/timeline/generate` | signed in | `COMPUTERS_EDIT` |
| `GET` | `/api/v1/endpoints/connected` | signed in | `COMPUTERS_VIEW` |
| `POST` | `/api/v1/endpoints/grants/redeem` | public, throttled | — |
| `GET` | `/api/v1/endpoints/mine` | signed in | — |

## Endpoint enrolment

`apps/api/src/enrollment/enrollment.controller.ts`

| Method | Path | Access | Capability |
|---|---|---|---|
| `POST` | `/api/v1/enrollment/claim` | public, throttled | — |
| `POST` | `/api/v1/enrollment/confirm-rotation` | public, throttled | — |
| `POST` | `/api/v1/enrollment/heartbeat` | public, throttled | — |
| `GET` | `/api/v1/enrollment/tokens` | signed in | `COMPUTERS_VIEW` |
| `POST` | `/api/v1/enrollment/tokens` | signed in | `COMPUTERS_ADD` |
| `DELETE` | `/api/v1/enrollment/tokens/:id` | signed in | `COMPUTERS_REMOVE` |

## Launcher

`apps/api/src/launcher/launcher.controller.ts`

| Method | Path | Access | Capability |
|---|---|---|---|
| `POST` | `/api/v1/launcher/token` | signed in | `COMPUTERS_CONNECT` |
| `PATCH` | `/api/v1/launcher/token/:id/revoke` | signed in | `COMPUTERS_CONNECT` |
| `GET` | `/api/v1/launcher/validate` | public, throttled | — |

## Multi-factor authentication

`apps/api/src/mfa/mfa.controller.ts`

| Method | Path | Access | Capability |
|---|---|---|---|
| `POST` | `/api/v1/mfa/recovery/verify` | signed in, throttled | — |
| `GET` | `/api/v1/mfa/status` | signed in | — |
| `DELETE` | `/api/v1/mfa/totp` | signed in, throttled | — |
| `POST` | `/api/v1/mfa/totp/confirm` | signed in, throttled | — |
| `POST` | `/api/v1/mfa/totp/setup` | signed in | — |

## Notes

`apps/api/src/notes/notes.controller.ts`

| Method | Path | Access | Capability |
|---|---|---|---|
| `GET` | `/api/v1/notes` | signed in | `COMPUTERS_VIEW` |
| `POST` | `/api/v1/notes` | signed in | `COMPUTERS_EDIT` |
| `PATCH` | `/api/v1/notes/:id` | signed in | `COMPUTERS_EDIT` |
| `DELETE` | `/api/v1/notes/:id` | signed in | `COMPUTERS_EDIT` |
| `POST` | `/api/v1/notes/:id/comments` | signed in | `COMPUTERS_EDIT` |

## Public (unauthenticated)

`apps/api/src/public/public.controller.ts`

| Method | Path | Access | Capability |
|---|---|---|---|
| `GET` | `/api/v1/public/install/:platform` | public | — |
| `GET` | `/api/v1/public/install/linux/:token` | public | — |
| `GET` | `/api/v1/public/install/mac/:token` | public | — |
| `GET` | `/api/v1/public/install/win/:token` | public | — |
| `GET` | `/api/v1/public/rustdesk-config` | public | — |

## Public API (API-key authenticated)

`apps/api/src/public-api/public-api.controller.ts`

| Method | Path | Access | Capability |
|---|---|---|---|
| `GET` | `/api/v1/pub/v1/businesses` | public | — |
| `POST` | `/api/v1/pub/v1/businesses` | public | — |
| `GET` | `/api/v1/pub/v1/businesses/:id` | public | — |
| `GET` | `/api/v1/pub/v1/companies` | public | — |
| `POST` | `/api/v1/pub/v1/companies` | public | — |
| `GET` | `/api/v1/pub/v1/companies/:id` | public | — |
| `GET` | `/api/v1/pub/v1/computers` | public | — |
| `GET` | `/api/v1/pub/v1/computers/:id` | public | — |
| `POST` | `/api/v1/pub/v1/enrollment/tokens` | public | — |
| `GET` | `/api/v1/pub/v1/enrollment/tokens` | public | — |
| `GET` | `/api/v1/pub/v1/users` | public | — |
| `POST` | `/api/v1/pub/v1/users/invite` | public | — |
| `GET` | `/api/v1/pub/v1/whoami` | public | — |

## Quick Connect

`apps/api/src/quick-connect/quick-connect.controller.ts`

| Method | Path | Access | Capability |
|---|---|---|---|
| `POST` | `/api/v1/quick-connect/connect` | signed in | `QUICK_CONNECT` |
| `GET` | `/api/v1/quick-connect/sessions` | signed in | `QUICK_CONNECT` |
| `POST` | `/api/v1/quick-connect/sessions/:id/end` | signed in | `QUICK_CONNECT` |
| `GET` | `/api/v1/quick-connect/status` | signed in | — |

## Quick Connect (public)

`apps/api/src/quick-connect/quick-connect-public.controller.ts`

| Method | Path | Access | Capability |
|---|---|---|---|
| `GET` | `/api/v1/public/quick-connect` | public | — |
| `GET` | `/api/v1/public/quick-connect/download/:os` | public | — |

## Security

`apps/api/src/admin/security.controller.ts`

| Method | Path | Access | Capability |
|---|---|---|---|
| `GET` | `/api/v1/admin/security/audit` | signed in | — |
| `POST` | `/api/v1/admin/security/audit/fix` | signed in | — |
| `GET` | `/api/v1/admin/security/config` | signed in | — |
| `PATCH` | `/api/v1/admin/security/config` | signed in | — |
| `GET` | `/api/v1/admin/security/fail2ban` | signed in | — |
| `POST` | `/api/v1/admin/security/fail2ban/ban` | signed in | — |
| `GET` | `/api/v1/admin/security/fail2ban/ignore` | signed in | — |
| `POST` | `/api/v1/admin/security/fail2ban/ignore` | signed in | — |
| `DELETE` | `/api/v1/admin/security/fail2ban/ignore/:ip` | signed in | — |
| `POST` | `/api/v1/admin/security/fail2ban/install` | signed in | — |
| `GET` | `/api/v1/admin/security/fail2ban/jail/:jail/config` | signed in | — |
| `PATCH` | `/api/v1/admin/security/fail2ban/jail/:jail/config` | signed in | — |
| `POST` | `/api/v1/admin/security/fail2ban/unban` | signed in | — |
| `GET` | `/api/v1/admin/security/os-updates` | signed in | — |
| `POST` | `/api/v1/admin/security/os-updates/run` | signed in | — |
| `GET` | `/api/v1/admin/security/os-updates/status` | signed in | — |
| `GET` | `/api/v1/admin/security/tls` | signed in | — |
| `POST` | `/api/v1/admin/security/tls/renew` | signed in | — |

## Support sessions

`apps/api/src/sessions/sessions.controller.ts`

| Method | Path | Access | Capability |
|---|---|---|---|
| `GET` | `/api/v1/sessions` | signed in | `SESSIONS_VIEW` |
| `POST` | `/api/v1/sessions` | signed in | `COMPUTERS_CONNECT` |
| `GET` | `/api/v1/sessions/:id` | signed in | `SESSIONS_VIEW` |
| `PATCH` | `/api/v1/sessions/:id/cancel` | signed in | `COMPUTERS_CONNECT` |
| `PATCH` | `/api/v1/sessions/:id/complete` | signed in | `COMPUTERS_CONNECT` |
| `POST` | `/api/v1/sessions/:id/events` | signed in | `COMPUTERS_CONNECT` |
| `GET` | `/api/v1/sessions/stats` | signed in | `SESSIONS_VIEW` |

## Sites businessesbusinessIdsites

`apps/api/src/sites/sites.controller.ts` — mounted at `/businesses/:businessId/sites` and `/customers/:businessId/sites`

| Method | Path | Access | Capability |
|---|---|---|---|
| `GET` | `/api/v1/businesses/:businessId/sites` | signed in | `COMPUTERS_VIEW` |
| `POST` | `/api/v1/businesses/:businessId/sites` | signed in | `COMPUTERS_EDIT` |
| `GET` | `/api/v1/businesses/:businessId/sites/:id` | signed in | `COMPUTERS_VIEW` |
| `PATCH` | `/api/v1/businesses/:businessId/sites/:id` | signed in | `COMPUTERS_EDIT` |
| `DELETE` | `/api/v1/businesses/:businessId/sites/:id` | signed in | `COMPUTERS_REMOVE` |
| `GET` | `/api/v1/customers/:businessId/sites` | signed in | `COMPUTERS_VIEW` |
| `POST` | `/api/v1/customers/:businessId/sites` | signed in | `COMPUTERS_EDIT` |
| `GET` | `/api/v1/customers/:businessId/sites/:id` | signed in | `COMPUTERS_VIEW` |
| `PATCH` | `/api/v1/customers/:businessId/sites/:id` | signed in | `COMPUTERS_EDIT` |
| `DELETE` | `/api/v1/customers/:businessId/sites/:id` | signed in | `COMPUTERS_REMOVE` |

## Sites sites

`apps/api/src/sites/sites.controller.ts`

| Method | Path | Access | Capability |
|---|---|---|---|
| `GET` | `/api/v1/sites` | signed in | `COMPUTERS_VIEW` |
| `GET` | `/api/v1/sites/:id` | signed in | `COMPUTERS_VIEW` |
| `PATCH` | `/api/v1/sites/:id` | signed in | `COMPUTERS_EDIT` |
| `DELETE` | `/api/v1/sites/:id` | signed in | `COMPUTERS_REMOVE` |

## Tenants

`apps/api/src/tenants/tenants.controller.ts` — mounted at `/platform` and `/tenants`

| Method | Path | Access | Capability |
|---|---|---|---|
| `GET` | `/api/v1/platform` | signed in | — |
| `GET` | `/api/v1/platform/:id` | signed in | — |
| `PATCH` | `/api/v1/platform/:id` | signed in | — |
| `PATCH` | `/api/v1/platform/:id/branding` | signed in | — |
| `PATCH` | `/api/v1/platform/:id/branding/logo` | signed in | — |
| `PATCH` | `/api/v1/platform/:id/settings` | signed in | — |
| `GET` | `/api/v1/tenants` | signed in | — |
| `GET` | `/api/v1/tenants/:id` | signed in | — |
| `PATCH` | `/api/v1/tenants/:id` | signed in | — |
| `PATCH` | `/api/v1/tenants/:id/branding` | signed in | — |
| `PATCH` | `/api/v1/tenants/:id/branding/logo` | signed in | — |
| `PATCH` | `/api/v1/tenants/:id/settings` | signed in | — |

## Updates

`apps/api/src/admin/update.controller.ts`

| Method | Path | Access | Capability |
|---|---|---|---|
| `GET` | `/api/v1/admin/update/changelog` | signed in | — |
| `GET` | `/api/v1/admin/update/check` | signed in | — |
| `GET` | `/api/v1/admin/update/progress` | signed in | — |
| `GET` | `/api/v1/admin/update/rustdesk` | signed in | — |
| `POST` | `/api/v1/admin/update/rustdesk` | signed in | — |
| `GET` | `/api/v1/admin/update/rustdesk-server` | signed in | — |
| `POST` | `/api/v1/admin/update/rustdesk-server` | signed in | — |
| `POST` | `/api/v1/admin/update/rustdesk/:endpointId/cancel` | signed in | — |
| `GET` | `/api/v1/admin/update/version` | signed in | — |

## Users

`apps/api/src/users/users.controller.ts`

| Method | Path | Access | Capability |
|---|---|---|---|
| `GET` | `/api/v1/users` | signed in | `USERS_VIEW` |
| `PATCH` | `/api/v1/users/:userId` | signed in | `USERS_MANAGE` |
| `DELETE` | `/api/v1/users/:userId` | signed in | `USERS_MANAGE` |
| `PATCH` | `/api/v1/users/:userId/activate` | signed in | `USERS_MANAGE` |
| `PATCH` | `/api/v1/users/:userId/business` | signed in | `USERS_MANAGE` |
| `PATCH` | `/api/v1/users/:userId/capabilities` | signed in | `USERS_MANAGE` |
| `PATCH` | `/api/v1/users/:userId/level` | signed in | `USERS_MANAGE` |
| `POST` | `/api/v1/users/:userId/mfa/reset` | signed in | `USERS_MANAGE` |
| `PATCH` | `/api/v1/users/:userId/platform-admin` | signed in | — |
| `POST` | `/api/v1/users/:userId/reset-password` | signed in | `USERS_MANAGE` |
| `PATCH` | `/api/v1/users/:userId/suspend` | signed in | `USERS_MANAGE` |
| `GET` | `/api/v1/users/find` | signed in | — |
| `GET` | `/api/v1/users/me/mfa-status` | signed in | — |
| `GET` | `/api/v1/users/platform-admins` | signed in | — |

