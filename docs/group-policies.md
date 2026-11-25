# Device-group policies

From 0.35 a **monitor** and an **automatic client-update policy** can be set
for a device group, as well as for a customer, a site or (monitors only) one
device. A group can be static (members added by hand or by a bulk action)
or rule-based (members are the devices matching the group's rule right now).
Patch policies are not group-scoped; see [the end of this page](#patch-policies-are-not-group-scoped).

## Which policy wins

Most specific first:

| Rank | Scope | Monitors | Client updates |
|---|---|---|---|
| 1 | **This device** | yes | — (the one-off is the Update button) |
| 2 | **A device group** it is in | yes | yes |
| 3 | **Its site** | yes | yes (a site override) |
| 4 | **Its customer** | yes | yes |
| 5 | **Global** (the MSP) | yes | — |

The winner replaces everything below it, exactly as a site override always
did: a group monitor that is switched off switches the inherited monitor off
for the group's devices, and a group client-update policy that is off keeps
its devices off even when the customer policy is on. For monitors this is
per **key** — each key is decided separately.

### A device in more than one group

Every group policy has a **priority**, 1 to 999. When a device is in two or
more groups that each have a policy for the same thing (for monitors, the
same key), the **lowest number wins**. Two group policies of one customer
cannot share a number — for monitors, two group monitors with the same key —
and saving a clash is refused with *PRIORITY_TAKEN* (409). The database
enforces it as well (partial unique indexes in migration 0057), so a tie never
has to be broken when the policy is evaluated. If one ever reached the
resolver anyway it would be decided by the policy's id: a fixed order, never
the order rows came back from the database.

**Why a priority and not "no overlapping groups".** Whether two groups
overlap is not a property of their policies. A rule group's members change by
themselves — a device goes offline, reports a new RustDesk version, is not
seen for a week — and a static group's change through bulk actions that never
look at policies. A check made when a policy is saved would be true then and
false an hour later, with nothing to say so. A priority is decided once, by
the person who sets the policy, and holds whatever the membership does.

### Seeing which one won

- **A device's page.** The *Monitoring* tab says, for every monitor in
  effect, where it was set and what it beat: *set for group Tills (priority 2)
  — ahead of group Kiosks (priority 5) on priority — replacing customer
  Acme*. The *Updates* card has a **Client-update policy** row: *Group Tills
  (priority 2) — off*, with the sentence the server used to decide it.
- **Monitoring → Monitoring policies.** Group monitors are listed as *Group Tills ·
  priority 2*; *Edit* changes the priority.
- **Patching → Client updates.** A **Device groups** card lists every group of
  the customer, those with a policy first in precedence order, with how many
  devices are in each *now* (counted over the devices you can see). The
  **Devices** table has a *Policy* column — the winning scope, and which
  groups it was ahead of — with the full reason on hover.

## Membership is computed, never stored

Nothing records which groups a device is in for policy purposes. Each
decision evaluates it at that moment:

- a **static** group's members are its membership rows;
- a **rule** group's members are the group's customer AND its rule AND the
  devices that customer can see (`endpointVisibilityWhere` for the customer
  as a whole, i.e. every device of it that is not archived), through the
  device list's own evaluator (`EndpointListService.evaluateRuleGroups`) — the
  same code that fills the *Groups* column.

So a device that stops matching a rule loses that group's policy at the
next evaluation: the next heartbeat asks it about the site's or customer's
monitors instead, the next monitor sweep closes the group monitor's open alert
(*the monitor no longer applies to this device*), and the client-update page
and the heartbeat's hold follow the new winner.

Two kinds of rule group match **nothing** for a policy:

- a rule this server can no longer read (as on the device list);
- a rule that picks devices by their **alerts**. Monitors raise alerts, so a
  monitor scoped to "devices with critical alerts" would decide its own
  scope. Such a group cannot be given a policy (*GROUP_READS_ALERTS*), and a
  group that already carries one cannot have its rule changed to read alerts.

### When membership is evaluated

| Where | How often | What is evaluated |
|---|---|---|
| Monitor sweep | every `MONITOR_SWEEP_SECONDS` (60) | every group carrying a monitor, once over its customer, for the whole tick |
| Client-update sweep | every `CLIENT_UPDATE_SWEEP_SECONDS` (120) | per customer with an enabled policy, its groups carrying a policy, once for the tick; and (0.36) per customer with a queued automatic update, its groups carrying a policy, for those devices |
| Heartbeat (monitor block, live-sample monitors, monitor report) | each heartbeat | only groups that can change that answer: those carrying a monitor whose key has a monitor of a kind the heartbeat asks about |
| Heartbeat (client-update hold) | only when a POLICY update is queued for the device | the customer's group policies, for that device |
| Device page, policy pages | each read | the groups carrying a policy, for the devices shown |

A snapshot is never kept beyond the call or tick that built it.

### Measured cost

`apps/api/scripts/bench-group-policy.mjs`: one customer, 5,000 devices over
10 sites, 50 rule groups covering every condition a policy-usable rule may
carry (tag, online, platform, site, OS, RustDesk version, pending patches,
restart pending, agent type, last seen), a group monitor on every group and a
group client-update policy on 49. Medians on the development server, with
other work running on it:

| What | Median | Worst |
|---|---|---|
| One membership snapshot of 50 rule groups over 5,000 devices (per sweep tick) | 0.6–0.9 s | 0.95 s |
| Monitor sweep, 50 group monitors (baseline without them: 0.4–0.7 s) | 1.5 s | 1.6 s |
| Client-update sweep membership, 49 group policies (per customer per tick) | 0.7 s | 0.75 s |
| Heartbeat monitor block when no group monitor is of a kind it asks about | 12 ms | 18 ms |
| Heartbeat monitor block when all 50 groups carry service monitors (worst case) | 84 ms | 220 ms |
| Client-update hold for one device (only while a POLICY update is queued) | 41 ms | 125 ms |

The sweeps stay well inside their tick, so membership is computed fresh each
tick and is not cached. The heartbeat's worst case grows with the number of
rule groups that carry a **service or event** monitor — each one is one or two
small queries for that device — not with the number of groups or
devices. Fifty such groups is the ceiling (a customer can have at most 50
rule groups); a handful, which is the common case, costs a few milliseconds.

## Security

- **Another customer's group is a 404**, for monitors and for client updates,
  the same as a made-up id. The database also refuses a policy whose group
  belongs to another customer (trigger `group_policy_same_business`, 0057).
- **Who may set them** is unchanged: monitors need `monitoring:configure` for
  the whole customer (or the Business Owner, or the MSP); client-update
  policies need what a customer policy needs.
- **Fresh authentication.** Turning a group client-update policy on, or
  saving one that stays on, needs it, as for a customer policy. **Removing** a
  group policy needs it too: its devices fall back to a site or customer
  policy that may be on.
- **Deleting a group that carries a policy is refused** (*GROUP_HAS_POLICIES*,
  409, and NO ACTION foreign keys underneath), so deleting the group is not a
  way round the step-up. Remove its policies first.
- **Who is notified stays global or per customer.** There are no group
  notification policies: if editing a group's rule — which needs no step-up —
  could change who hears about an alert, it would be a way round the
  fresh-authentication rule on changing who is notified (§17). Group
  *monitors* decide what is watched, never who is told.
- Changing a group's membership (adding a device to a static group,
  editing a rule) can move devices onto a group's client-update policy
  without a step-up, exactly as moving a device to another site can move it
  onto that site's override. The policy itself was confirmed when it was
  turned on.
- Invariants: `scripts/check-security-invariants.mjs` §46.

## Patch policies are not group-scoped

A patch policy's rings name devices, and the approval signer signs exactly
that document: it refuses any ring plan that names a device the approvers
did not see. A ring "group Tills" would either have to be re-approved every
time the group's membership moved, or would widen what two people approved
without either of them seeing it. Neither is acceptable, so rings stay lists
of named devices. Choosing the devices of a ring from a group when
proposing a policy (a one-time copy, approved as usual) would fit the model;
it is not built.

## Troubleshooting

- **"Another device-group … already has priority N."** Pick a free number.
  For monitors the number only has to be free among group monitors with the
  same key.
- **A group shows "matches no device".** Its rule cannot be read, or it
  picks devices by alerts. Fix the rule (or remove the policy).
- **A device did not follow a group policy I expected.** Open its page: the
  Monitoring tab and the Client-update policy row say which scope won and
  what it beat. A device that is not in the group *now* — offline when the
  rule says online, untagged — does not get the policy.
- **A queued automatic update was withdrawn or moved after a device left a
  group (0.36).** Its request was queued under the group's policy. The next
  client-update sweep withdraws it if the policy that governs the device now
  is off (`CLIENT_UPDATE_AUTO_WITHDRAWN`), or keeps it under that policy if it
  is on (`CLIENT_UPDATE_AUTO_REPLANNED`); the audit entry says why. Before
  0.36 it stayed queued, held as "policy_off", until the next policy save.
