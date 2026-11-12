# API reference

_Generated from the controllers by `scripts/gen-api-reference.mjs`. Do not edit by hand._

Every route is prefixed with `/api/v1` unless its path is shown in full (the ticket-rmm-v1
integration, under `/api/integration/v1`). There are **431** of them across
**57** controllers.

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

## Actions

`apps/api/src/actions/actions.controller.ts`

| Method | Path | Access | Capability |
|---|---|---|---|
| `GET` | `/api/v1/actions/:id` | signed in | — |
| `POST` | `/api/v1/actions/:id/cancel` | signed in | — |
| `POST` | `/api/v1/actions/:id/reconcile` | signed in, throttled | — |
| `GET` | `/api/v1/actions/catalog` | signed in | — |
| `GET` | `/api/v1/endpoints/:id/actions` | signed in | — |
| `POST` | `/api/v1/endpoints/:id/actions` | signed in, throttled | — |

## Administration

`apps/api/src/admin/admin.controller.ts`

| Method | Path | Access | Capability |
|---|---|---|---|
| `GET` | `/api/v1/admin/platform-settings` | signed in | — |
| `PATCH` | `/api/v1/admin/platform-settings` | signed in | — |
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

## Audit chain

`apps/api/src/audit/audit-chain.controller.ts`

| Method | Path | Access | Capability |
|---|---|---|---|
| `GET` | `/api/v1/audit/integrity` | signed in | — |
| `POST` | `/api/v1/audit/integrity/verify` | signed in | — |

## Authentication

`apps/api/src/auth/auth.controller.ts`

| Method | Path | Access | Capability |
|---|---|---|---|
| `POST` | `/api/v1/auth/change-password` | signed in, throttled | — |
| `POST` | `/api/v1/auth/login` | public, throttled | — |
| `POST` | `/api/v1/auth/logout` | signed in | — |
| `GET` | `/api/v1/auth/me` | signed in | — |
| `POST` | `/api/v1/auth/mfa/verify` | public, throttled | — |
| `GET` | `/api/v1/auth/profile` | signed in | — |
| `PATCH` | `/api/v1/auth/profile` | signed in | — |
| `POST` | `/api/v1/auth/step-up` | signed in, throttled | — |
| `GET` | `/api/v1/auth/step-up` | signed in | — |

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

## Chat

`apps/api/src/chat/chat.controller.ts`

| Method | Path | Access | Capability |
|---|---|---|---|
| `GET` | `/api/v1/endpoints/:id/chat` | signed in | `COMPUTERS_VIEW` |
| `POST` | `/api/v1/endpoints/:id/chat/conversations` | signed in, throttled | `CHAT_SEND` |
| `GET` | `/api/v1/endpoints/:id/chat/conversations/:cid` | signed in | `COMPUTERS_VIEW` |
| `POST` | `/api/v1/endpoints/:id/chat/conversations/:cid/end` | signed in | `CHAT_SEND` |
| `POST` | `/api/v1/endpoints/:id/chat/conversations/:cid/messages` | signed in, throttled | `CHAT_SEND` |

## Client updates

`apps/api/src/client-updates/client-updates.controller.ts`

| Method | Path | Access | Capability |
|---|---|---|---|
| `GET` | `/api/v1/client-updates/computers` | signed in | — |
| `GET` | `/api/v1/client-updates/policy` | signed in | — |
| `PUT` | `/api/v1/client-updates/policy` | signed in | — |
| `DELETE` | `/api/v1/client-updates/policy/sites/:siteId` | signed in | — |

## Containment

`apps/api/src/containment/containment.controller.ts`

| Method | Path | Access | Capability |
|---|---|---|---|
| `GET` | `/api/v1/containment` | signed in | — |
| `GET` | `/api/v1/containment/banner` | signed in | — |
| `POST` | `/api/v1/containment/pauses` | signed in | — |
| `POST` | `/api/v1/containment/pauses/:id/clear` | signed in | — |

## Dashboard

`apps/api/src/dashboard/dashboard.controller.ts`

| Method | Path | Access | Capability |
|---|---|---|---|
| `GET` | `/api/v1/dashboard` | signed in | — |
| `GET` | `/api/v1/dashboard/map` | signed in | — |
| `GET` | `/api/v1/dashboard/overview` | signed in | — |
| `GET` | `/api/v1/dashboard/platform` | signed in | — |

## Device views devicegroups

`apps/api/src/device-views/device-views.controller.ts`

| Method | Path | Access | Capability |
|---|---|---|---|
| `GET` | `/api/v1/device-groups` | signed in | `COMPUTERS_VIEW` |
| `POST` | `/api/v1/device-groups` | signed in, throttled | `COMPUTERS_EDIT` |
| `PATCH` | `/api/v1/device-groups/:id` | signed in, throttled | `COMPUTERS_EDIT` |
| `DELETE` | `/api/v1/device-groups/:id` | signed in, throttled | `COMPUTERS_EDIT` |

## Device views deviceviews

`apps/api/src/device-views/device-views.controller.ts`

| Method | Path | Access | Capability |
|---|---|---|---|
| `GET` | `/api/v1/device-views` | signed in | `COMPUTERS_VIEW` |
| `POST` | `/api/v1/device-views` | signed in, throttled | `COMPUTERS_VIEW` |
| `GET` | `/api/v1/device-views/:id` | signed in | `COMPUTERS_VIEW` |
| `PATCH` | `/api/v1/device-views/:id` | signed in, throttled | `COMPUTERS_VIEW` |
| `DELETE` | `/api/v1/device-views/:id` | signed in, throttled | `COMPUTERS_VIEW` |

## Device views endpointsbulk

`apps/api/src/device-views/device-views.controller.ts`

| Method | Path | Access | Capability |
|---|---|---|---|
| `POST` | `/api/v1/endpoints/bulk` | signed in, throttled | `COMPUTERS_VIEW` |
| `POST` | `/api/v1/endpoints/bulk/export.csv` | signed in, throttled | `COMPUTERS_VIEW` |

## Diagnostics

`apps/api/src/diagnostics/diagnostics.controller.ts`

| Method | Path | Access | Capability |
|---|---|---|---|
| `GET` | `/api/v1/diagnostics/technician/helper.cmd` | signed in | `COMPUTERS_CONNECT` |
| `GET` | `/api/v1/diagnostics/technician/latest` | signed in | `COMPUTERS_CONNECT` |
| `POST` | `/api/v1/diagnostics/technician/report` | public, throttled | — |
| `GET` | `/api/v1/endpoints/:id/diagnostics` | signed in | `COMPUTERS_VIEW` |
| `GET` | `/api/v1/endpoints/:id/diagnostics/report` | signed in | `COMPUTERS_VIEW` |

## Diagnostics catalog

`apps/api/src/diagnostics-catalog/diagnostics-catalog.controller.ts`

| Method | Path | Access | Capability |
|---|---|---|---|
| `GET` | `/api/v1/endpoints/:id/diagnostics/catalog` | signed in | `COMPUTERS_VIEW` |
| `POST` | `/api/v1/endpoints/:id/diagnostics/runs` | signed in, throttled | `COMPUTERS_VIEW` |
| `GET` | `/api/v1/endpoints/:id/diagnostics/runs` | signed in | `COMPUTERS_VIEW` |
| `GET` | `/api/v1/endpoints/:id/diagnostics/runs/:runId` | signed in | `COMPUTERS_VIEW` |
| `GET` | `/api/v1/endpoints/:id/diagnostics/snapshots/:key` | signed in | `COMPUTERS_VIEW` |

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
| `POST` | `/api/v1/endpoints/:id/accept-device-secret` | signed in, throttled | `COMPUTERS_EDIT` |
| `GET` | `/api/v1/endpoints/:id/access` | signed in | `USERS_VIEW` |
| `POST` | `/api/v1/endpoints/:id/access` | signed in | `USERS_MANAGE` |
| `PATCH` | `/api/v1/endpoints/:id/access-mode` | signed in | `COMPUTERS_EDIT` |
| `DELETE` | `/api/v1/endpoints/:id/access/:userId` | signed in | `USERS_MANAGE` |
| `POST` | `/api/v1/endpoints/:id/aliases` | signed in | `COMPUTERS_EDIT` |
| `DELETE` | `/api/v1/endpoints/:id/aliases/:aliasId` | signed in | `COMPUTERS_EDIT` |
| `PATCH` | `/api/v1/endpoints/:id/archive` | signed in | `COMPUTERS_REMOVE` |
| `GET` | `/api/v1/endpoints/:id/commands/:commandId` | signed in | `COMPUTERS_VIEW` |
| `POST` | `/api/v1/endpoints/:id/connect` | signed in, throttled | — |
| `GET` | `/api/v1/endpoints/:id/connect.cmd` | signed in, throttled | — |
| `POST` | `/api/v1/endpoints/:id/event-log` | signed in, throttled | `COMPUTERS_EVENT_LOGS` |
| `GET` | `/api/v1/endpoints/:id/event-log/latest` | signed in | `COMPUTERS_EVENT_LOGS` |
| `GET` | `/api/v1/endpoints/:id/inventory` | signed in | `COMPUTERS_VIEW` |
| `POST` | `/api/v1/endpoints/:id/inventory/refresh` | signed in, throttled | `COMPUTERS_VIEW` |
| `GET` | `/api/v1/endpoints/:id/password` | signed in, throttled | `COMPUTERS_EDIT` |
| `PATCH` | `/api/v1/endpoints/:id/password` | signed in | `COMPUTERS_EDIT` |
| `POST` | `/api/v1/endpoints/:id/reinstall-agent` | signed in, throttled | `COMPUTERS_EDIT` |
| `PATCH` | `/api/v1/endpoints/:id/restore` | signed in | `COMPUTERS_REMOVE` |
| `POST` | `/api/v1/endpoints/:id/rotate-credential` | signed in | `COMPUTERS_EDIT` |
| `POST` | `/api/v1/endpoints/:id/tags` | signed in | `COMPUTERS_EDIT` |
| `DELETE` | `/api/v1/endpoints/:id/tags/:tag` | signed in | `COMPUTERS_EDIT` |
| `POST` | `/api/v1/endpoints/:id/timeline/generate` | signed in | `COMPUTERS_EDIT` |
| `GET` | `/api/v1/endpoints/connected` | signed in | `COMPUTERS_VIEW` |
| `POST` | `/api/v1/endpoints/grants/redeem` | public, throttled | — |
| `GET` | `/api/v1/endpoints/list` | signed in | `COMPUTERS_VIEW` |
| `GET` | `/api/v1/endpoints/list/export.csv` | signed in, throttled | `COMPUTERS_VIEW` |
| `GET` | `/api/v1/endpoints/mine` | signed in | — |
| `POST` | `/api/v1/endpoints/trmm/link` | signed in, throttled | `COMPUTERS_EDIT` |
| `GET` | `/api/v1/endpoints/trmm/resolve` | signed in, throttled | `COMPUTERS_VIEW` |

## Endpoint enrolment

`apps/api/src/enrollment/enrollment.controller.ts`

| Method | Path | Access | Capability |
|---|---|---|---|
| `POST` | `/api/v1/enrollment/chat/poll` | public, throttled | — |
| `POST` | `/api/v1/enrollment/chat/reply` | public, throttled | — |
| `POST` | `/api/v1/enrollment/claim` | public, throttled | — |
| `POST` | `/api/v1/enrollment/command-result` | public, throttled | — |
| `POST` | `/api/v1/enrollment/confirm-rotation` | public, throttled | — |
| `POST` | `/api/v1/enrollment/diagnostic-result` | public, throttled | — |
| `POST` | `/api/v1/enrollment/heartbeat` | public, throttled | — |
| `POST` | `/api/v1/enrollment/monitor-report` | public, throttled | — |
| `GET` | `/api/v1/enrollment/tokens` | signed in | `COMPUTERS_VIEW` |
| `POST` | `/api/v1/enrollment/tokens` | signed in | `COMPUTERS_ADD` |
| `DELETE` | `/api/v1/enrollment/tokens/:id` | signed in | `COMPUTERS_REMOVE` |
| `GET` | `/api/v1/enrollment/tokens/:id/status` | signed in | `COMPUTERS_VIEW` |

## Health

`apps/api/src/health/health.controller.ts`

| Method | Path | Access | Capability |
|---|---|---|---|
| `GET` | `/api/v1/healthz` | signed in | — |

## Integration admin

`apps/api/src/integration/integration-admin.controller.ts`

| Method | Path | Access | Capability |
|---|---|---|---|
| `GET` | `/api/v1/admin/integration/mappings` | Platform Admin | — |
| `POST` | `/api/v1/admin/integration/mappings/organizations` | Platform Admin | — |
| `DELETE` | `/api/v1/admin/integration/mappings/organizations/:id` | Platform Admin | — |
| `POST` | `/api/v1/admin/integration/mappings/technicians` | Platform Admin | — |
| `DELETE` | `/api/v1/admin/integration/mappings/technicians/:id` | Platform Admin | — |
| `GET` | `/api/v1/admin/integration/peers` | Platform Admin | — |

## Integration apiintegrationv

`apps/api/src/integration/integration.controller.ts`

| Method | Path | Access | Capability |
|---|---|---|---|
| `GET` | `/api/integration/v1/capabilities` | signed peer (ticket-rmm-v1) | — |
| `POST` | `/api/integration/v1/jobs` | signed peer (ticket-rmm-v1) | — |
| `GET` | `/api/integration/v1/jobs/:job_id` | signed peer (ticket-rmm-v1) | — |
| `GET` | `/api/integration/v1/jobs/:job_id/events` | signed peer (ticket-rmm-v1) | — |

## Integration apiintegrationv

`apps/api/src/integration/integration.controller.ts`

| Method | Path | Access | Capability |
|---|---|---|---|
| `POST` | `/api/integration/v1/action-proposals` | signed peer (ticket-rmm-v1) | — |
| `GET` | `/api/integration/v1/action-proposals/:job_id` | signed peer (ticket-rmm-v1) | — |

## Integration apiintegrationvalerts

`apps/api/src/integration/integration.controller.ts`

| Method | Path | Access | Capability |
|---|---|---|---|
| `GET` | `/api/integration/v1/alerts/:alert_id` | signed peer (ticket-rmm-v1) | — |
| `POST` | `/api/integration/v1/alerts/:alert_id/ticket` | signed peer (ticket-rmm-v1) | — |
| `GET` | `/api/integration/v1/alerts/events` | signed peer (ticket-rmm-v1) | — |

## Launcher

`apps/api/src/launcher/launcher.controller.ts`

| Method | Path | Access | Capability |
|---|---|---|---|
| `POST` | `/api/v1/launcher/token` | signed in | — |
| `PATCH` | `/api/v1/launcher/token/:id/revoke` | signed in | `COMPUTERS_CONNECT` |
| `GET` | `/api/v1/launcher/validate` | public, throttled | — |

## Metrics

`apps/api/src/metrics/metrics.controller.ts`

| Method | Path | Access | Capability |
|---|---|---|---|
| `GET` | `/api/v1/endpoints/:id/metrics` | signed in | `COMPUTERS_VIEW` |

## Multi-factor authentication

`apps/api/src/mfa/mfa.controller.ts`

| Method | Path | Access | Capability |
|---|---|---|---|
| `POST` | `/api/v1/mfa/recovery/verify` | signed in, throttled | — |
| `GET` | `/api/v1/mfa/status` | signed in | — |
| `DELETE` | `/api/v1/mfa/totp` | signed in, throttled | — |
| `POST` | `/api/v1/mfa/totp/confirm` | signed in, throttled | — |
| `POST` | `/api/v1/mfa/totp/setup` | signed in | — |

## Monitoring

`apps/api/src/monitoring/monitoring.controller.ts`

| Method | Path | Access | Capability |
|---|---|---|---|
| `GET` | `/api/v1/monitoring/alerts` | signed in | — |
| `GET` | `/api/v1/monitoring/alerts/:id` | signed in | — |
| `POST` | `/api/v1/monitoring/alerts/:id/acknowledge` | signed in | — |
| `POST` | `/api/v1/monitoring/alerts/:id/resolve` | signed in | — |
| `GET` | `/api/v1/monitoring/endpoints/:id` | signed in | — |
| `GET` | `/api/v1/monitoring/notify-policy` | signed in | — |
| `PUT` | `/api/v1/monitoring/notify-policy` | signed in | — |
| `GET` | `/api/v1/monitoring/rules` | signed in | — |
| `POST` | `/api/v1/monitoring/rules` | signed in | — |
| `PATCH` | `/api/v1/monitoring/rules/:id` | signed in | — |
| `DELETE` | `/api/v1/monitoring/rules/:id` | signed in | — |
| `POST` | `/api/v1/monitoring/rules/recommended` | signed in | — |
| `GET` | `/api/v1/monitoring/summary` | signed in | — |
| `GET` | `/api/v1/monitoring/suppressions` | signed in | — |
| `POST` | `/api/v1/monitoring/suppressions` | signed in | — |
| `POST` | `/api/v1/monitoring/suppressions/:id/revoke` | signed in | — |

## Notes

`apps/api/src/notes/notes.controller.ts`

| Method | Path | Access | Capability |
|---|---|---|---|
| `GET` | `/api/v1/notes` | signed in | `COMPUTERS_VIEW` |
| `POST` | `/api/v1/notes` | signed in | `COMPUTERS_EDIT` |
| `PATCH` | `/api/v1/notes/:id` | signed in | `COMPUTERS_EDIT` |
| `DELETE` | `/api/v1/notes/:id` | signed in | `COMPUTERS_EDIT` |
| `POST` | `/api/v1/notes/:id/comments` | signed in | `COMPUTERS_EDIT` |

## Offboarding

`apps/api/src/offboarding/offboarding.controller.ts`

| Method | Path | Access | Capability |
|---|---|---|---|
| `GET` | `/api/v1/endpoints/:id/access-review` | signed in | `COMPUTERS_VIEW` |
| `GET` | `/api/v1/offboarding` | signed in | — |
| `POST` | `/api/v1/offboarding` | signed in | — |
| `GET` | `/api/v1/offboarding/:id` | signed in | — |
| `GET` | `/api/v1/offboarding/pending-rotations` | signed in | `COMPUTERS_VIEW` |
| `GET` | `/api/v1/offboarding/preview` | signed in | — |

## Passkeys

`apps/api/src/passkeys/passkeys.controller.ts`

| Method | Path | Access | Capability |
|---|---|---|---|
| `GET` | `/api/v1/auth/passkeys` | signed in | — |
| `DELETE` | `/api/v1/auth/passkeys/:id` | signed in | — |
| `POST` | `/api/v1/auth/passkeys/login` | public, throttled | — |
| `POST` | `/api/v1/auth/passkeys/login/options` | public, throttled | — |
| `POST` | `/api/v1/auth/passkeys/register` | signed in, throttled | — |
| `POST` | `/api/v1/auth/passkeys/register/options` | signed in, throttled | — |
| `POST` | `/api/v1/auth/step-up/passkey` | signed in, throttled | — |
| `POST` | `/api/v1/auth/step-up/passkey/options` | signed in, throttled | — |

## Patching

`apps/api/src/patching/patching.controller.ts`

| Method | Path | Access | Capability |
|---|---|---|---|
| `GET` | `/api/v1/endpoints/:id/patches` | signed in | — |
| `POST` | `/api/v1/endpoints/:id/patches/install` | signed in, throttled | — |
| `GET` | `/api/v1/patching/candidates` | signed in | — |
| `GET` | `/api/v1/patching/deployments` | signed in | — |
| `POST` | `/api/v1/patching/deployments` | signed in, throttled | — |
| `GET` | `/api/v1/patching/deployments/:id` | signed in | — |
| `POST` | `/api/v1/patching/deployments/:id/cancel` | signed in | — |
| `POST` | `/api/v1/patching/deployments/:id/pause` | signed in | — |
| `POST` | `/api/v1/patching/deployments/:id/resume` | signed in | — |
| `POST` | `/api/v1/patching/deployments/:id/rings/:ring/request` | signed in, throttled | — |
| `GET` | `/api/v1/patching/policies` | signed in | — |
| `POST` | `/api/v1/patching/policies` | signed in, throttled | — |
| `GET` | `/api/v1/patching/policies/:id` | signed in | — |
| `POST` | `/api/v1/patching/policies/:id/revoke` | signed in | — |
| `GET` | `/api/v1/patching/preflight` | signed in | — |

## Public (unauthenticated)

`apps/api/src/public/public.controller.ts`

| Method | Path | Access | Capability |
|---|---|---|---|
| `GET` | `/api/v1/public/install/:platform` | public | — |
| `GET` | `/api/v1/public/install/linux/:token` | public | — |
| `GET` | `/api/v1/public/install/mac/:token` | public | — |
| `GET` | `/api/v1/public/install/win/:token` | public | — |
| `GET` | `/api/v1/public/install/windows-params.json` | public | — |
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

## Public url adminpublicaddress

`apps/api/src/platform/public-url.controller.ts`

| Method | Path | Access | Capability |
|---|---|---|---|
| `GET` | `/api/v1/admin/public-address` | signed in | — |
| `PUT` | `/api/v1/admin/public-address` | signed in, throttled | — |
| `POST` | `/api/v1/admin/public-address/check` | signed in, throttled | — |

## Public url publicaddressprobe

`apps/api/src/platform/public-url.controller.ts`

| Method | Path | Access | Capability |
|---|---|---|---|
| `GET` | `/api/v1/public/address-probe/:nonce` | public, throttled | — |

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

## Reports

`apps/api/src/reports/reports.controller.ts`

| Method | Path | Access | Capability |
|---|---|---|---|
| `GET` | `/api/v1/reports/agent-coverage` | signed in | `COMPUTERS_VIEW` |
| `GET` | `/api/v1/reports/agent-coverage/export.csv` | signed in, throttled | `COMPUTERS_VIEW` |
| `GET` | `/api/v1/reports/alert-frequency` | signed in | `ALERTS_VIEW` |
| `GET` | `/api/v1/reports/alert-frequency/export.csv` | signed in, throttled | `ALERTS_VIEW` |
| `GET` | `/api/v1/reports/offline-time` | signed in | `ALERTS_VIEW` |
| `GET` | `/api/v1/reports/offline-time/export.csv` | signed in, throttled | `ALERTS_VIEW` |
| `GET` | `/api/v1/reports/patch-compliance` | signed in | `COMPUTERS_VIEW` |
| `GET` | `/api/v1/reports/patch-compliance/export.csv` | signed in, throttled | `COMPUTERS_VIEW` |

## Rollouts

`apps/api/src/admin/rollouts.controller.ts`

| Method | Path | Access | Capability |
|---|---|---|---|
| `GET` | `/api/v1/admin/rollouts` | signed in | — |
| `POST` | `/api/v1/admin/rollouts` | signed in | — |
| `GET` | `/api/v1/admin/rollouts/:id` | signed in | — |
| `POST` | `/api/v1/admin/rollouts/:id/cancel` | signed in | — |
| `POST` | `/api/v1/admin/rollouts/:id/pause` | signed in | — |
| `POST` | `/api/v1/admin/rollouts/:id/start` | signed in | — |
| `GET` | `/api/v1/admin/rollouts/endpoints/:endpointId/history` | signed in | — |
| `POST` | `/api/v1/admin/rollouts/jobs/:jobId/cancel` | signed in | — |
| `GET` | `/api/v1/admin/rollouts/pilot-groups` | signed in | — |
| `POST` | `/api/v1/admin/rollouts/pilot-groups` | signed in | — |
| `GET` | `/api/v1/admin/rollouts/pin` | signed in | — |
| `PATCH` | `/api/v1/admin/rollouts/pin` | signed in | — |

## Script library

`apps/api/src/script-library/script-library.controller.ts`

| Method | Path | Access | Capability |
|---|---|---|---|
| `GET` | `/api/v1/scripts` | signed in | — |
| `POST` | `/api/v1/scripts` | signed in, throttled | — |
| `GET` | `/api/v1/scripts/:id` | signed in | — |
| `GET` | `/api/v1/scripts/:id/diff` | signed in | — |
| `POST` | `/api/v1/scripts/:id/versions` | signed in, throttled | — |
| `GET` | `/api/v1/scripts/:id/versions/:version` | signed in | — |
| `POST` | `/api/v1/scripts/:id/versions/:version/review` | signed in, throttled | — |
| `POST` | `/api/v1/scripts/:id/versions/:version/submit` | signed in | — |
| `POST` | `/api/v1/scripts/:id/versions/:version/withdraw` | signed in | — |

## Search

`apps/api/src/search/search.controller.ts`

| Method | Path | Access | Capability |
|---|---|---|---|
| `GET` | `/api/v1/search` | signed in, throttled | — |

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

## Security controls

`apps/api/src/security-controls/security-controls.controller.ts`

| Method | Path | Access | Capability |
|---|---|---|---|
| `POST` | `/api/v1/security-controls/alert-suppressions` | signed in | — |
| `POST` | `/api/v1/security-controls/alert-suppressions/:id/revoke` | signed in | — |
| `GET` | `/api/v1/security-controls/alerts` | signed in | — |
| `GET` | `/api/v1/security-controls/catalog` | signed in | — |
| `PATCH` | `/api/v1/security-controls/endpoints/:id/device-class` | signed in | — |
| `GET` | `/api/v1/security-controls/inspect` | signed in | — |
| `GET` | `/api/v1/security-controls/maintenance-exceptions` | signed in | — |
| `POST` | `/api/v1/security-controls/maintenance-exceptions` | signed in | — |
| `POST` | `/api/v1/security-controls/maintenance-exceptions/:id/decision` | signed in | — |
| `POST` | `/api/v1/security-controls/maintenance-exceptions/:id/revoke` | signed in | — |
| `GET` | `/api/v1/security-controls/pauses` | signed in | — |
| `POST` | `/api/v1/security-controls/pauses/:id/clear` | signed in | — |
| `GET` | `/api/v1/security-controls/policy` | signed in | — |
| `PUT` | `/api/v1/security-controls/policy` | signed in | — |
| `PUT` | `/api/v1/security-controls/policy/business/:businessId` | signed in | — |
| `GET` | `/api/v1/security-controls/presets` | signed in | — |
| `PUT` | `/api/v1/security-controls/presets/:id` | signed in | — |
| `DELETE` | `/api/v1/security-controls/presets/:id` | signed in | — |
| `POST` | `/api/v1/security-controls/presets/:id/clone` | signed in | — |
| `POST` | `/api/v1/security-controls/presets/:id/preview` | signed in | — |
| `POST` | `/api/v1/security-controls/presets/:id/reset` | signed in | — |
| `PATCH` | `/api/v1/security-controls/technician-devices/:id/managed` | signed in | — |
| `POST` | `/api/v1/security-controls/temporary-access` | signed in | — |
| `GET` | `/api/v1/security-controls/temporary-access` | signed in | — |
| `POST` | `/api/v1/security-controls/temporary-access/:id/activate` | signed in | — |
| `POST` | `/api/v1/security-controls/temporary-access/:id/decision` | signed in | — |
| `POST` | `/api/v1/security-controls/temporary-access/:id/revoke` | signed in | — |
| `GET` | `/api/v1/security-controls/trust-changes` | signed in | — |
| `POST` | `/api/v1/security-controls/trust-changes/:id/decision` | signed in | — |
| `GET` | `/api/v1/security-controls/upgrade-preview` | signed in | — |

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
| `POST` | `/api/v1/sessions/telemetry` | public, throttled | — |

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

## Sso authsso

`apps/api/src/sso/sso.controller.ts`

| Method | Path | Access | Capability |
|---|---|---|---|
| `POST` | `/api/v1/auth/sso/:id/link` | signed in, throttled | — |
| `GET` | `/api/v1/auth/sso/:id/start` | public, throttled | — |
| `GET` | `/api/v1/auth/sso/callback` | public, throttled | — |
| `GET` | `/api/v1/auth/sso/identities` | signed in | — |
| `DELETE` | `/api/v1/auth/sso/identities/:id` | signed in | — |
| `GET` | `/api/v1/auth/sso/providers` | public, throttled | — |

## Sso ssoproviders

`apps/api/src/sso/sso.controller.ts`

| Method | Path | Access | Capability |
|---|---|---|---|
| `GET` | `/api/v1/sso/providers` | signed in | — |
| `POST` | `/api/v1/sso/providers` | signed in | — |
| `PATCH` | `/api/v1/sso/providers/:id` | signed in | — |
| `DELETE` | `/api/v1/sso/providers/:id` | signed in | — |
| `POST` | `/api/v1/sso/providers/:id/mappings` | signed in | — |
| `DELETE` | `/api/v1/sso/providers/:id/mappings/:mappingId` | signed in | — |
| `POST` | `/api/v1/sso/providers/:id/test` | signed in, throttled | — |

## Support requests publicsupport

`apps/api/src/support-requests/support-requests.controller.ts`

| Method | Path | Access | Capability |
|---|---|---|---|
| `GET` | `/api/v1/public/support/intake/:slug` | public, throttled | — |
| `POST` | `/api/v1/public/support/intake/:slug` | public, throttled | — |
| `GET` | `/api/v1/public/support/status/:token` | public, throttled | — |
| `POST` | `/api/v1/public/support/status/:token/cancel` | public, throttled | — |

## Support requests supportrequests

`apps/api/src/support-requests/support-requests.controller.ts`

| Method | Path | Access | Capability |
|---|---|---|---|
| `POST` | `/api/v1/support-requests` | signed in, throttled | — |
| `GET` | `/api/v1/support-requests` | signed in | `SUPPORT_REQUESTS` |
| `GET` | `/api/v1/support-requests/:id` | signed in | `SUPPORT_REQUESTS` |
| `POST` | `/api/v1/support-requests/:id/cancel` | signed in | `SUPPORT_REQUESTS` |
| `POST` | `/api/v1/support-requests/:id/claim` | signed in | `SUPPORT_REQUESTS` |
| `POST` | `/api/v1/support-requests/:id/complete` | signed in | `SUPPORT_REQUESTS` |
| `POST` | `/api/v1/support-requests/:id/handoff` | signed in | `SUPPORT_REQUESTS` |
| `GET` | `/api/v1/support-requests/:id/handoff-candidates` | signed in | `SUPPORT_REQUESTS` |
| `POST` | `/api/v1/support-requests/:id/release` | signed in | `SUPPORT_REQUESTS` |
| `GET` | `/api/v1/support-requests/intake` | signed in | — |
| `PATCH` | `/api/v1/support-requests/intake` | signed in | — |

## Technicians

`apps/api/src/technicians/technicians.controller.ts`

| Method | Path | Access | Capability |
|---|---|---|---|
| `POST` | `/api/v1/technicians/access-requests` | signed in | — |
| `GET` | `/api/v1/technicians/approvals` | signed in | — |
| `POST` | `/api/v1/technicians/approvals/:id` | signed in | — |
| `GET` | `/api/v1/technicians/assignments` | signed in | — |
| `POST` | `/api/v1/technicians/assignments` | signed in | — |
| `POST` | `/api/v1/technicians/assignments/:id/revoke` | signed in | — |
| `PATCH` | `/api/v1/technicians/businesses/:businessId/approval-required` | signed in | — |
| `GET` | `/api/v1/technicians/groups` | signed in | — |
| `POST` | `/api/v1/technicians/groups` | signed in | — |
| `PATCH` | `/api/v1/technicians/groups/:id` | signed in | — |
| `DELETE` | `/api/v1/technicians/groups/:id` | signed in | — |
| `POST` | `/api/v1/technicians/groups/:id/members` | signed in | — |
| `DELETE` | `/api/v1/technicians/groups/:id/members/:userId` | signed in | — |
| `GET` | `/api/v1/technicians/me` | signed in | — |
| `GET` | `/api/v1/technicians/overview` | signed in | — |
| `GET` | `/api/v1/technicians/people` | signed in | — |
| `GET` | `/api/v1/technicians/people/:userId/effective` | signed in | — |
| `PATCH` | `/api/v1/technicians/people/:userId/platform-permissions` | signed in | — |
| `GET` | `/api/v1/technicians/vocabulary` | signed in | — |

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
| `GET` | `/api/v1/admin/update/app-version` | signed in | — |
| `GET` | `/api/v1/admin/update/changelog` | signed in | — |
| `GET` | `/api/v1/admin/update/check` | signed in | — |
| `GET` | `/api/v1/admin/update/progress` | signed in | — |
| `GET` | `/api/v1/admin/update/rustdesk` | signed in | — |
| `POST` | `/api/v1/admin/update/rustdesk` | signed in | — |
| `GET` | `/api/v1/admin/update/rustdesk-server` | signed in | — |
| `POST` | `/api/v1/admin/update/rustdesk-server` | signed in | — |
| `POST` | `/api/v1/admin/update/rustdesk/:endpointId/cancel` | signed in | — |
| `GET` | `/api/v1/admin/update/version` | signed in | — |

## Update trust adminupdatetrust

`apps/api/src/update-trust/update-trust.controller.ts`

| Method | Path | Access | Capability |
|---|---|---|---|
| `GET` | `/api/v1/admin/update-trust` | signed in | — |
| `PUT` | `/api/v1/admin/update-trust/mode` | signed in | — |

## Update trust publicupdates

`apps/api/src/update-trust/update-trust.controller.ts`

| Method | Path | Access | Capability |
|---|---|---|---|
| `GET` | `/api/v1/public/updates/metadata/:file` | public | — |
| `GET` | `/api/v1/public/updates/targets/*path` | public | — |

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

