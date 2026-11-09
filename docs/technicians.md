# MSP technicians

*Added in v0.20.*

An MSP technician supports several customer businesses but belongs to none of them. Until v0.20 the only ways to give such a person access were to make them a Platform Admin (every business, every setting) or a member of one business (one business, nothing else). Technician assignments sit between the two. They give one person, or a group, defined access to one business, optionally to some of its computers, optionally only for a while or during set hours. Every grant is recorded and can be revoked.

## Who does what

| Action | Who |
|---|---|
| Create or revoke an assignment, manage technician groups | Platform Admin, or anyone holding the `technicians:manage` platform permission |
| Give someone `technicians:manage` | Platform Admin only |
| Ask for access to a business | Any current technician |
| Approve or deny a pending request | That business's Business Owner, or a Platform Admin |
| Require approval before technicians can work in a business | That business's Business Owner, or a Platform Admin |

A Business Owner can **never create** an assignment. If they could, one business could hand access to itself to an outsider, with no accountability on the MSP side. The owner's part is approval, and only for their own business.

Changing assignments, groups or platform permissions needs a [step-up](sign-in.md#step-up) (`technicians.manage`). Approving or denying needs `permissions.change`.

## Assignments

An assignment names:

- **who**: one person, or a technician group (everyone in the group gets it);
- **which business**;
- **which capabilities**, from the same list a business uses for its own users (*Users → Permissions*). `users:manage` cannot be given to a technician;
- **which computers**: every computer in the business, or a specific list;
- **when**, optionally: a start, an expiry, and a weekly schedule in an explicit time zone, e.g. weekdays 08:00–18:00 America/New_York.

All of this is re-evaluated on **every request**, not stored in the session. An assignment that expires, leaves its schedule, or is revoked stops working on the technician's next click, even mid-session. This matches how a suspended account is handled.

**Presets (v0.23).** An assignment is either created from a preset (L1 Help Desk, L2 Technician, L3 Senior, or a clone) or given explicit capabilities. Asking for neither gives **L1 Help Desk**. A preset-backed assignment's capabilities are derived live from the preset and never include Remote connect or credential access: sessions come from the launch policy and temporary grants instead. Explicit-capability (custom) assignments, including every assignment made before 0.23, behave as they always did. Capability and computer scope are taken from the **same** assignment, so overlapping grants no longer combine. A manager cannot assign themselves, or a group they belong to, and cannot add themselves to a group. See [technician-access.md](technician-access.md).

A technician acting in a customer business through an assignment is **never a Business Owner there**, whatever role they hold in their own business. They get the assignment's capabilities and nothing more.

### Temporary access

Give the assignment an expiry. The person's *All assigned* page and the computer's [access review](offboarding.md#access-review) both show it as temporary, with its end time. When it expires, it moves to the person's *inactive* list with the reason `expired`, so they can see why it vanished.

## Requests and approval

A technician can ask for access to a business from **All assigned → Request access**. A request must have a reason and an expiry: open-ended access is never self-service.

- A request **always** waits as `PENDING` and grants nothing until that business's Business Owner (or a Platform Admin) approves it at **Technician approvals**. An approver can narrow a request (fewer capabilities, fewer computers, an earlier expiry) but can never widen it.
- *Require approval* on a business goes further: it makes assignments created by a technician manager wait for the owner's approval as well.

## Working in a business

Anyone with at least one live assignment sees a **business switcher** at the top of the sidebar. Choosing a business sets the `rem0te_business` cookie. The API honours it only for the person's own business or one they are assigned to at that moment; anything else is silently treated as their own business. The amber *Technician access* label under the business name shows when the switcher is in that mode.

**All assigned** (`/technician`) is a read-only overview across every business the person can reach. Each business is queried with **its own** assignment's scope, so a broad grant in one business never widens what is shown for another.

## See also

- [Access control](access-control.md): the three levels and the business boundary.
- [Technician access](technician-access.md): presets, the launch policy, protected device classes and fleet-abuse limits.
- [Offboarding](offboarding.md): removing a technician everywhere at once.
