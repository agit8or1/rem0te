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

Can create, edit, disable and delete customers; view every customer, user and device;
adopt an unassigned device into a customer and make deployment keys and assignment rules
(0.57, [deployment.md](deployment.md)); manage Business Owners and Business Users; manage
platform settings, RustDesk infrastructure, installers and updates; view global audit logs and
active sessions; and use Quick Connect whenever the master switch is on.

A Platform Admin bypasses customer-level restrictions **explicitly** — `AccessControlService`
short-circuits for them and the bypass is auditable, rather than being an emergent property of a
missing filter.

### Business Owner / Admin

Full administrative rights **inside their own customer only**.

| Can | Cannot |
|---|---|
| View and manage their customer profile | See any other customer |
| View, add, remove, rename and organise their devices | Query another customer's devices |
| Initiate remote connections | Reach another customer through an altered URL or API call |
| Manage, invite, disable and remove Business Users | Change platform settings |
| Assign permissions to Business Users | Create Platform Admins |
| View their customer's sessions and audit history | Access global audit logs |
| Download installers bound to their customer | Access global infrastructure configuration |
| Use Quick Connect, if enabled for their customer | Promote anyone (including themselves) to Business Owner |

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
| Devices | `computers:view` | See the devices belonging to this customer |
| | `computers:connect` | Start a remote session to a device they can see |
| | `computers:add` | Create enrollment links and add new devices |
| | `computers:remove` | Archive devices and revoke their access |
| | `computers:edit` | Rename, tag and re-organise devices; reveal, set or rotate a device's password — on devices they have been given access to |
| | `computers:event_logs` | Read Windows event log entries from a device they can see |
| Support | `support:quick_connect` | Use Quick Connect |
| | `support:sessions_view` | See sessions currently in progress |
| | `support:history_view` | See past sessions for this customer — read only, see below |
| | `support:requests` | See the [support request](support-requests.md) queue, claim requests, hand them off and close them |
| | `support:chat` | Start a [chat](chat.md) with the person at a device they can see, write in it, send files and pictures, and end it (0.34, files 0.44). Reading transcripts and files needs only `computers:view` |
| | `tickets:create` | *Create PSA tickets* (0.48): send an event-log entry or alert from a device they can see to the customer's PSA, or the platform default, as a ticket. An event-log entry also needs `computers:event_logs`, an alert `monitoring:alerts`. See [AI and tickets](ai-and-tickets.md) |
| Users | `users:view` | See the other people in this customer |
| | `users:manage` | Invite, disable and remove business users; set their permissions |
| Audit | `audit:view` | See this customer's audit history |
| Integration | `integration:ticket_analysis` | Submit read-only ClientSt0r ticket analysis for this customer and read its staff-only findings ([integration-clientst0r.md](integration-clientst0r.md)). Grants no remote access and no actions |
| Backups | `backups:view` | *See backup status* (0.81): the Backups page — assets, last job, last verified restore, RPO/RTO — for the devices they can see; never an asset linked to no device. Not a default ([backups.md](backups.md)) |
| Monitoring | `monitoring:alerts` | See monitoring alerts for the devices they can see, and acknowledge or resolve them ([monitoring.md](monitoring.md)) |
| | `monitoring:configure` | Add and change monitors and maintenance windows for this customer. Who gets notified is set by a Business Owner |
| Actions | `actions:request` | Ask for a catalog action on a device they can reach ([approved-actions.md](approved-actions.md)). It never approves anything |
| Automation | `scripts:author` | Add scripts to this customer's library, edit them (each edit is a new version) and submit versions for review |
| | `scripts:review` | Approve or reject someone else's script version, never one they wrote or edited. Approving needs a fresh sign-in. Neither capability runs anything ([script-library.md](script-library.md)) |

**Defaults for a new Business User:** `computers:view` and `computers:connect`. Everything more
administrative is off until granted.

`computers:event_logs` is separate from `computers:view` on purpose. Somebody else's System and
Security logs are a different kind of access from a name and an online dot, and plenty of people
who should see a device's inventory should not see every failed logon on it. Every request is
audited as `ENDPOINT_EVENT_LOG_REQUESTED` with the log, the window and the requester — see
[inventory.md](inventory.md).

A **Business Owner** implicitly holds every customer capability — the column is left empty for them
so there is exactly one source of truth and no stale grant can survive a demotion. A **Platform
Admin** holds everything.

**Nobody can edit their own permissions or their own level**, owner or not.

Three rules that are easy to assume the other way round:

- **`computers:edit` does not widen reach.** Revealing, setting or rotating a device's password,
  and minting a launcher token for it, take the same per-device access as connecting: a grant on
  that device, or the device being company-wide. Before 0.18.22 the capability alone was
  enough, which let a Business User read the password of a machine they had been given no access to.
- **`computers:edit` does not let a Business User manage device groups or shared views** (0.33).
  Both are about the whole customer, and a Business User may see only some of its devices, so they
  are for a Business Owner, a technician whose assignment grants `computers:edit` over the whole
  customer, or the MSP — the same rule as the client-update policy. A saved view never widens
  anything: it is a set of list parameters, run as whoever opens it.
- **A device group holds only its own customer's devices, and that is enforced by the database**
  (0.34). A device may be in any number of its customer's groups. Adding one to another
  customer's group is refused by the service (`OTHER_BUSINESS`) and, underneath, by a trigger on
  the membership table, whatever code path writes it. A device that changes customer — moved by
  a Platform Admin, or re-enrolled with a token of another customer — leaves every group of the
  old customer in the same statement (a second trigger); the move's audit entry lists them.
  Membership grants nothing.
- **A rule group's members are computed as the reader, never stored** (0.34). Its rule is the
  device list's own filters, AND-ed with the group's customer AND-ed with the reader's own
  visibility, every time it is read — so a Business User sees only their devices in it, a
  technician only the ones their grant names, and another customer's rule group lists nothing and
  is a 404 to edit or act on. A rule that selects by alerts is not evaluated for a reader without
  `monitoring:alerts` (filtering by it is a 403: membership would disclose alert state). A rule's
  values reach the database only as bound parameters. Nothing adds a device to a rule group by
  hand — the service refuses it and a trigger refuses the row — and a group's kind cannot change.
  Bulk on a rule group resolves its members at request time as the caller, then runs each
  device's own checks.
- **Making a device company-wide needs `users:manage`**, the capability that grants access to one
  person, because it grants access to everyone in the customer at once.
- **`support:history_view` reads sessions; it never changes them.** Completing, cancelling or
  posting an event to a session — and binding a launcher token to it — is for the technician who
  ran it, a Business Owner of its customer, or a Platform Admin. Anyone else who can see the session
  gets a 403 and nothing is written. Before 0.19.12 the write paths reused the read filter, so
  `computers:connect` plus `support:history_view` was enough to close a colleague's session or
  write events into it.
- **Membership alone shows the customer's profile, not its inventory.** `GET /businesses/:id`
  includes the device list only with `computers:view`.

An **API key** acts as a Business Owner of its customer, and only while the person who created it
still is one (or is a Platform Admin). Suspending, demoting or removing that person stops their
keys working. Creating a key needs `api_keys:write` (Business Owner or Platform Admin) **and a fresh
re-authentication**, whatever its scopes (0.34; `apikey.create`). Keys cannot be edited or
un-revoked; revoking needs only `api_keys:write`.

---

## The customer is the security boundary

Enforcement lives in the service layer, not the controller, so a forged path parameter, a swapped
query string and a direct API call all hit the same check.

Every customer-scoped operation resolves through `AccessControlService`:

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

These deliberately raise **404, not 403**, for objects in another customer — a caller probing ids
learns nothing about whether they exist.

**Customer scope is not the whole rule for a device.** `assertEndpointInScope` is the per-id form
of `endpointVisibilityWhere`, the rule the device list uses, and every `:id` route goes through it:

| Caller | Sees by id |
|---|---|
| Platform Admin | any device |
| Business Owner | any device in their customer |
| Technician | the devices their assignment names |
| Business User | a device in their customer that is company-wide, or granted to them (inside the grant's start and end dates) |

A device a Business User cannot see answers **404 Device not found**, the same as a device in
another customer or one that does not exist. A grant's weekly schedule is not part of seeing: a
person with a weekday-only grant still sees the device at the weekend, and is refused when they try
to connect, reveal its password or open a session — that is `canReachEndpoint`. Before 0.31.2 the
per-id check stopped at customer scope, so a Business User could read and change, by id, devices
in their customer granted only to someone else; `apps/api/scripts/e2e-endpoint-visibility.mjs` is
the proof that they no longer can, and §26 of `scripts/check-security-invariants.mjs` keeps the
check in place.

The JWT is not trusted as a cache: `JwtStrategy.validate()` re-reads role, customer and capabilities
from the database on every request. Revoking a capability, moving someone between customers, or
disabling a customer takes effect on the very next request.

### What this covers

Customers · users · devices · sessions · remote connections · audit logs · installers ·
enrollment tokens · launcher tokens · credentials · Quick Connect · notes · sites ·
API keys · dashboard counts.

The dashboard (`GET /dashboard/overview`, 0.31) adds nothing new to this: each
section reuses the rule of the page it summarises — devices use the device
list's visibility (a Business User's granted and company-wide devices, a
technician's assignment), alerts call the alerts list's own `alertWhere`, an
approved-action plan is shown only when every device it names is visible,
sessions follow the sessions list (narrowed, for anyone but an owner, to
devices they can see or their own sessions), and activity follows the audit
page. A section the caller lacks the capability for is `null`, not zero.
Proven by `apps/api/scripts/e2e-dashboard.mjs`.

Global search (`GET /search`, 0.33) works the same way. Each group is built
from its own list route's where builder — the device list's `scopedWhere`,
`listWhere` for customers and sites, `memberWhere` for people, `alertWhere`
for alerts — with the search AND-ed onto it, and is gated by that list's
capability (`computers:view`, none, `computers:view`, `users:view`,
`monitoring:alerts`). A group the caller may not use is `null`. Another
customer's devices, sites and people are not found by any query, including
an exact hostname or RustDesk ID. The older `GET /admin/search` was removed in
0.31.2: it scoped devices by customer alone, so a Business User found
devices assigned only to others and a technician restricted to named
devices found the whole customer. Proven by
`apps/api/scripts/e2e-search.mjs`; the rules are §28 of the security
invariants.

Proven by `apps/api/scripts/e2e-business-access.mjs` — 83 server-side checks including direct-URL
and direct-API cross-customer probing in both directions.

---

## MSP technicians (v0.20)

A technician who supports several customers is not a fourth level. They are
given **technician assignments**: per customer, per capability, optionally per
device and time-limited or scheduled, re-checked on every request. Acting in
a customer through an assignment, a person is never that customer's
owner, whatever they are in their own. Full rules: [technicians.md](technicians.md).

The `technicians:manage` **platform permission** lets someone other than a
Platform Admin create and revoke assignments and manage technician groups. Only
a Platform Admin can grant it. It does not make them a Platform Admin and gives
them no access to any customer.

## Presets, protected devices and abuse limits (v0.23)

Technician assignments can be created from **presets** (L1/L2/L3) that grant
read-side capabilities only. Sessions for preset-backed technicians come from
the **launch policy**: view-only only where the device can enforce it,
control only by an independently approved, freshly activated temporary
grant, and never the permanent password. **Protected device classes**
(domain controllers, hypervisors, backup servers, the RMM host) are denied
interactively to everyone, Platform Admin included. **Fleet-abuse limits**
count distinct devices and customers per identity across every entry
point and pause the identity on a trip. Changes that widen trust go to
**independent review**. Full rules: [technician-access.md](technician-access.md).

## Step-up (v0.20)

Revealing a device password, changing permissions, managing technicians, SSO
configuration and passkey changes need a recent re-authentication on top of a
valid session. Access is checked first, then step-up. See
[sign-in.md](sign-in.md#step-up).

From 0.33, `computers:add` alone no longer makes an enrolment link: making one
also needs a fresh re-authentication, for every role, and so does creating an
API key (any key from 0.34). See
[sign-in.md](sign-in.md#install-links-and-api-keys).

## Access review and offboarding (v0.20)

Each device lists who can reach it and why; offboarding removes a person's
access and reports which RustDesk credentials they obtained, so those can be
rotated. Revocation alone never changes a password someone already saw. See
[offboarding.md](offboarding.md).

---

## Quick Connect

Quick Connect is a **permission, not a role**. Three things must all be true:

1. **Platform master switch** — `PlatformSettings.quickConnectEnabled` (Settings → Quick Connect).
   Off here means unavailable everywhere, whatever anything else says.
2. **Per-customer switch** — `Customer.quickConnectEnabled`. Platform Admin sets it.
3. **Per-user permission** — `support:quick_connect`. Business Owners hold it implicitly *if* the
   customer is enabled; Business Users need it granted; Platform Admins always have it when the
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
| Tenant Owner | **Business Owner** | all customer capabilities |
| Tenant Admin | **Business Owner** | all customer capabilities |
| Technician | **Business User** | view · connect · sessions · history |
| Billing Admin | **Business User** | users:view · audit:view — **no device access** |
| Read Only | **Business User** | view · sessions · history · audit — **no connect** |
| Customer Portal | **Business User** | view · connect · sessions · history |

An old **Read Only** user does *not* come out of the migration able to start a remote session, and an
old **Billing Admin** — who never had `endpoints:read` — gets no device capabilities at all.

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
for no behavioural gain. The domain, the API and the UI all call it a Customer.
