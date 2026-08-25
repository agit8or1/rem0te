# Access Control

Rem0te has exactly three access levels. There is no reseller hierarchy, and no separate role for
billing, read-only or portal access.

```
              PLATFORM ADMIN
              Full platform access
                     |
                     v
            BUSINESS OWNER / ADMIN
            Full business control
                     |
                     v
               BUSINESS USER
          Permissions assigned by owner
```

---

## The three levels

### Platform Admin

The Rem0te operator. Identified by `User.isPlatformAdmin`, not by a role row — there is no
"Platform Admin" membership to forge.

Can create, edit, disable and delete businesses; view and search every business, user and computer;
move an unassigned computer into a business; manage Business Owners and Business Users; manage
platform settings, RustDesk infrastructure, installers and updates; view global audit logs and
active sessions; and use Quick Connect whenever the master switch is on.

A Platform Admin bypasses business-level restrictions **explicitly** — `AccessControlService`
short-circuits for them and the bypass is auditable, rather than being an emergent property of a
missing filter.

### Business Owner / Admin

Full administrative rights **inside their own business only**.

| Can | Cannot |
|---|---|
| View and manage their business profile | See any other business |
| View, add, remove, rename and organise their computers | Query another business's devices |
| Initiate remote connections | Reach another business through an altered URL or API call |
| Manage, invite, disable and remove Business Users | Change platform settings |
| Assign permissions to Business Users | Create Platform Admins |
| View their business's sessions and audit history | Access global audit logs |
| Download installers bound to their business | Access global infrastructure configuration |
| Use Quick Connect, if enabled for their business | Promote anyone (including themselves) to Business Owner |

### Business User

Access is determined by permissions assigned by the Business Owner. A Business User gets **only**
explicitly granted permissions.

---

## Permissions

Stored on `Membership.capabilities` as an allowlisted string array. The vocabulary lives in
`apps/api/src/rbac/capabilities.ts` and is served to the UI at
`GET /api/v1/businesses/capability-catalog`, so the checkboxes can never drift from the server.

| Group | Key | Meaning |
|---|---|---|
| Computers | `computers:view` | See the computers belonging to this business |
| | `computers:connect` | Start a remote session to a computer they can see |
| | `computers:add` | Create enrollment links and add new computers |
| | `computers:remove` | Archive computers and revoke their access |
| | `computers:edit` | Rename, tag and re-organise computers |
| Support | `support:quick_connect` | Use Quick Connect |
| | `support:sessions_view` | See sessions currently in progress |
| | `support:history_view` | See past sessions for this business |
| Users | `users:view` | See the other people in this business |
| | `users:manage` | Invite, disable and remove business users; set their permissions |
| Audit | `audit:view` | See this business's audit history |

**Defaults for a new Business User:** `computers:view` and `computers:connect`. Everything more
administrative is off until granted.

A **Business Owner** implicitly holds every business capability — the column is left empty for them
so there is exactly one source of truth and no stale grant can survive a demotion. A **Platform
Admin** holds everything.

**Nobody can edit their own permissions or their own level**, owner or not.

---

## The business is the security boundary

Enforcement lives in the service layer, not the controller, so a forged path parameter, a swapped
query string and a direct API call all hit the same check.

Every business-scoped operation resolves through `AccessControlService`:

```ts
// Which business does this request operate on?
const scope = this.acl.resolveScope(actor, requestedBusinessId);
//   Platform Admin  → the requested business, or null for "all businesses"
//   Everyone else   → their own business; a different one is a 403
//   No business     → 403. Fail closed.
```

Lookups by id go one step further and confirm the object itself is in scope before anything is read
from it:

```ts
await this.acl.assertEndpointInScope(actor, endpointId);   // 404 if it isn't
await this.acl.assertBusinessInScope(actor, businessId);
await this.acl.assertUserInScope(actor, targetUserId);
```

These deliberately raise **404, not 403**, for objects in another business — a caller probing ids
learns nothing about whether they exist.

The JWT is not trusted as a cache: `JwtStrategy.validate()` re-reads role, business and capabilities
from the database on every request. Revoking a capability, moving someone between businesses, or
disabling a business takes effect on the very next request.

### What this covers

Businesses · users · computers · sessions · remote connections · audit logs · installers ·
enrollment tokens · launcher tokens · credentials · Quick Connect · search · notes · sites ·
API keys · dashboard counts.

Proven by `apps/api/scripts/e2e-business-access.mjs` — 82 server-side checks including direct-URL
and direct-API cross-business probing in both directions.

---

## Quick Connect

Quick Connect is a **permission, not a role**. Three things must all be true:

1. **Platform master switch** — `PlatformSettings.quickConnectEnabled` (Settings → Quick Connect).
   Off here means unavailable everywhere, whatever anything else says.
2. **Per-business switch** — `Customer.quickConnectEnabled`. Platform Admin sets it.
3. **Per-user permission** — `support:quick_connect`. Business Owners hold it implicitly *if* the
   business is enabled; Business Users need it granted; Platform Admins always have it when the
   master switch is on.

`GET /api/v1/quick-connect/status` returns which of the three failed, so the UI can say why rather
than showing an unexplained disabled button. Denied attempts are audited as
`QUICK_CONNECT_DENIED` with the failing condition.

---

## Migration from the old model

Migration `0009_business_access_model` remapped every membership. Least privilege was preserved:

| Legacy role | Becomes | Capabilities |
|---|---|---|
| Platform Admin | Platform Admin | everything |
| Tenant Owner | **Business Owner** | all business capabilities |
| Tenant Admin | **Business Owner** | all business capabilities |
| Technician | **Business User** | view · connect · sessions · history |
| Billing Admin | **Business User** | users:view · audit:view — **no computer access** |
| Read Only | **Business User** | view · sessions · history · audit — **no connect** |
| Customer Portal | **Business User** | view · connect · sessions · history |

An old **Read Only** user does *not* come out of the migration able to start a remote session, and an
old **Billing Admin** — who never had `endpoints:read` — gets no computer capabilities at all.

### Why legacy values still exist

`RoleType` still contains `TENANT_OWNER`, `TENANT_ADMIN`, `TECHNICIAN`, `BILLING_ADMIN`,
`READ_ONLY` and `CUSTOMER`. PostgreSQL cannot drop an enum value that historical rows may
reference, and `Role` rows are referenced by `Invitation.roleId` and by historical audit joins.

They are **tombstones**: no membership points at them, nothing in the application assigns them, and
the `Role` rows themselves were renamed `(retired) …` and marked non-system so they cannot be picked
from any selector. `capabilities.ts` retains a read-only translation table so a membership that
somehow predates the migration is still resolved at least-privilege rather than silently granted
nothing.

The `Customer` table likewise keeps its name — renaming it would mean rewriting every foreign key
for no behavioural gain. The domain, the API and the UI all call it a Business.
