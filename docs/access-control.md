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

Can create, edit, disable and delete businesses; view every business, user and computer;
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
| | `computers:edit` | Rename, tag and re-organise computers; reveal, set or rotate a computer's password — on computers they have been given access to |
| | `computers:event_logs` | Read Windows event log entries from a computer they can see |
| Support | `support:quick_connect` | Use Quick Connect |
| | `support:sessions_view` | See sessions currently in progress |
| | `support:history_view` | See past sessions for this business — read only, see below |
| Users | `users:view` | See the other people in this business |
| | `users:manage` | Invite, disable and remove business users; set their permissions |
| Audit | `audit:view` | See this business's audit history |
| Automation | `scripts:author` | Add scripts to this business's library, edit them (each edit is a new version) and submit versions for review |
| | `scripts:review` | Approve or reject someone else's script version, never one they wrote or edited. Approving needs a fresh sign-in. Neither capability runs anything ([script-library.md](script-library.md)) |

**Defaults for a new Business User:** `computers:view` and `computers:connect`. Everything more
administrative is off until granted.

`computers:event_logs` is separate from `computers:view` on purpose. Somebody else's System and
Security logs are a different kind of access from a name and an online dot, and plenty of people
who should see a computer's inventory should not see every failed logon on it. Every request is
audited as `ENDPOINT_EVENT_LOG_REQUESTED` with the log, the window and the requester — see
[inventory.md](inventory.md).

A **Business Owner** implicitly holds every business capability — the column is left empty for them
so there is exactly one source of truth and no stale grant can survive a demotion. A **Platform
Admin** holds everything.

**Nobody can edit their own permissions or their own level**, owner or not.

Three rules that are easy to assume the other way round:

- **`computers:edit` does not widen reach.** Revealing, setting or rotating a computer's password,
  and minting a launcher token for it, take the same per-computer access as connecting: a grant on
  that computer, or the computer being company-wide. Before 0.18.22 the capability alone was
  enough, which let a Business User read the password of a machine they had been given no access to.
- **Making a computer company-wide needs `users:manage`**, the capability that grants access to one
  person, because it grants access to everyone in the business at once.
- **`support:history_view` reads sessions; it never changes them.** Completing, cancelling or
  posting an event to a session — and binding a launcher token to it — is for the technician who
  ran it, a Business Owner of its business, or a Platform Admin. Anyone else who can see the session
  gets a 403 and nothing is written. Before 0.19.12 the write paths reused the read filter, so
  `computers:connect` plus `support:history_view` was enough to close a colleague's session or
  write events into it.
- **Membership alone shows the business's profile, not its inventory.** `GET /businesses/:id`
  includes the computer list only with `computers:view`.

An **API key** acts as a Business Owner of its business, and only while the person who created it
still is one (or is a Platform Admin). Suspending, demoting or removing that person stops their
keys working.

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

**Business scope is not the whole rule for a computer.** `assertEndpointInScope` is the per-id form
of `endpointVisibilityWhere`, the rule the device list uses, and every `:id` route goes through it:

| Caller | Sees by id |
|---|---|
| Platform Admin | any computer |
| Business Owner | any computer in their business |
| Technician | the computers their assignment names |
| Business User | a computer in their business that is company-wide, or granted to them (inside the grant's start and end dates) |

A computer a Business User cannot see answers **404 Computer not found**, the same as a computer in
another business or one that does not exist. A grant's weekly schedule is not part of seeing: a
person with a weekday-only grant still sees the computer at the weekend, and is refused when they try
to connect, reveal its password or open a session — that is `canReachEndpoint`. Before 0.31.2 the
per-id check stopped at business scope, so a Business User could read and change, by id, computers
in their business granted only to someone else; `apps/api/scripts/e2e-endpoint-visibility.mjs` is
the proof that they no longer can, and §26 of `scripts/check-security-invariants.mjs` keeps the
check in place.

The JWT is not trusted as a cache: `JwtStrategy.validate()` re-reads role, business and capabilities
from the database on every request. Revoking a capability, moving someone between businesses, or
disabling a business takes effect on the very next request.

### What this covers

Businesses · users · computers · sessions · remote connections · audit logs · installers ·
enrollment tokens · launcher tokens · credentials · Quick Connect · notes · sites ·
API keys · dashboard counts.

The dashboard (`GET /dashboard/overview`, 0.31) adds nothing new to this: each
section reuses the rule of the page it summarises — devices use the device
list's visibility (a Business User's granted and company-wide computers, a
technician's assignment), alerts call the alerts list's own `alertWhere`, an
approved-action plan is shown only when every computer it names is visible,
sessions follow the sessions list (narrowed, for anyone but an owner, to
computers they can see or their own sessions), and activity follows the audit
page. A section the caller lacks the capability for is `null`, not zero.
Proven by `apps/api/scripts/e2e-dashboard.mjs`.

Proven by `apps/api/scripts/e2e-business-access.mjs` — 82 server-side checks including direct-URL
and direct-API cross-business probing in both directions.

---

## MSP technicians (v0.20)

A technician who supports several businesses is not a fourth level. They are
given **technician assignments**: per business, per capability, optionally per
computer and time-limited or scheduled, re-checked on every request. Acting in
a customer business through an assignment, a person is never that business's
owner, whatever they are in their own. Full rules: [technicians.md](technicians.md).

The `technicians:manage` **platform permission** lets someone other than a
Platform Admin create and revoke assignments and manage technician groups. Only
a Platform Admin can grant it. It does not make them a Platform Admin and gives
them no access to any business.

## Presets, protected devices and abuse limits (v0.23)

Technician assignments can be created from **presets** (L1/L2/L3) that grant
read-side capabilities only. Sessions for preset-backed technicians come from
the **launch policy**: view-only only where the endpoint can enforce it,
control only by an independently approved, freshly activated temporary
grant, and never the permanent password. **Protected device classes**
(domain controllers, hypervisors, backup servers, the RMM host) are denied
interactively to everyone, Platform Admin included. **Fleet-abuse limits**
count distinct computers and businesses per identity across every entry
point and pause the identity on a trip. Changes that widen trust go to
**independent review**. Full rules: [technician-access.md](technician-access.md).

## Step-up (v0.20)

Revealing a computer password, changing permissions, managing technicians, SSO
configuration and passkey changes need a recent re-authentication on top of a
valid session. Access is checked first, then step-up. See
[sign-in.md](sign-in.md#step-up).

## Access review and offboarding (v0.20)

Each computer lists who can reach it and why; offboarding removes a person's
access and reports which RustDesk credentials they obtained, so those can be
rotated. Revocation alone never changes a password someone already saw. See
[offboarding.md](offboarding.md).

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
