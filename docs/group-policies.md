# Device-group policies

From 0.35 a **monitor** and an **automatic client-update policy** can be set
for a device group, as well as for a business, a site or (monitors only) one
computer. A group can be static (members added by hand or by a bulk action)
or rule-based (members are the computers matching the group's rule right now).
Patch policies are not group-scoped; see [the end of this page](#patch-policies-are-not-group-scoped).

## Which policy wins

Most specific first:

| Rank | Scope | Monitors | Client updates |
|---|---|---|---|
| 1 | **This computer** | yes | — (the one-off is the Update button) |
| 2 | **A device group** it is in | yes | yes |
| 3 | **Its site** | yes | yes (a site override) |
| 4 | **Its business** | yes | yes |
| 5 | **Global** (the MSP) | yes | — |

The winner replaces everything below it, exactly as a site override always
did: a group monitor that is switched off switches the inherited monitor off
for the group's computers, and a group client-update policy that is off keeps
its computers off even when the business policy is on. For monitors this is
per **key** — each key is decided separately.

### A computer in more than one group

Every group policy has a **priority**, 1 to 999. When a computer is in two or
more groups that each have a policy for the same thing (for monitors, the
same key), the **lowest number wins**. Two group policies of one business
cannot share a number — for monitors, two group monitors with the same key —
and saving a clash is refused with *PRIORITY_TAKEN* (409). The database
enforces it as well (partial unique indexes in migration 0057), so a tie never
has to be broken when the policy is evaluated. If one ever reached the
resolver anyway it would be decided by the policy's id: a fixed order, never
the order rows came back from the database.

**Why a priority and not "no overlapping groups".** Whether two groups
overlap is not a property of their policies. A rule group's members change by
themselves — a computer goes offline, reports a new RustDesk version, is not
seen for a week — and a static group's change through bulk actions that never
look at policies. A check made when a policy is saved would be true then and
false an hour later, with nothing to say so. A priority is decided once, by
the person who sets the policy, and holds whatever the membership does.

### Seeing which one won

- **A computer's page.** The *Monitoring* tab says, for every monitor in
  effect, where it was set and what it beat: *set for group Tills (priority 2)
  — ahead of group Kiosks (priority 5) on priority — replacing business
  Acme*. The *Updates* card has a **Client-update policy** row: *Group Tills
  (priority 2) — off*, with the sentence the server used to decide it.
- **Settings → Monitoring.** Group monitors are listed as *Group Tills ·
  priority 2*; *Edit* changes the priority.
- **Settings → Client updates.** A **Device groups** card lists every group of
  the business, those with a policy first in precedence order, with how many
  computers are in each *now* (counted over the computers you can see). The
  **Computers** table has a *Policy* column — the winning scope, and which
  groups it was ahead of — with the full reason on hover.

## Membership is computed, never stored

Nothing records which groups a computer is in for policy purposes. Each
decision evaluates it at that moment:

- a **static** group's members are its membership rows;
- a **rule** group's members are the group's business AND its rule AND the
  computers that business can see (`endpointVisibilityWhere` for the business
  as a whole, i.e. every computer of it that is not archived), through the
  device list's own evaluator (`EndpointListService.evaluateRuleGroups`) — the
  same code that fills the *Groups* column.

So a computer that stops matching a rule loses that group's policy at the
next evaluation: the next heartbeat asks it about the site's or business's
monitors instead, the next monitor sweep closes the group monitor's open alert
(*the monitor no longer applies to this computer*), and the client-update page
and the heartbeat's hold follow the new winner.

Two kinds of rule group match **nothing** for a policy:

- a rule this server can no longer read (as on the device list);
- a rule that picks computers by their **alerts**. Monitors raise alerts, so a
  monitor scoped to "computers with critical alerts" would decide its own
  scope. Such a group cannot be given a policy (*GROUP_READS_ALERTS*), and a
  group that already carries one cannot have its rule changed to read alerts.

### When membership is evaluated

| Where | How often | What is evaluated |
|---|---|---|
| Monitor sweep | every `MONITOR_SWEEP_SECONDS` (60) | every group carrying a monitor, once over its business, for the whole tick |
| Client-update sweep | every `CLIENT_UPDATE_SWEEP_SECONDS` (120) | per business with an enabled policy, its groups carrying a policy, once for the tick |
| Heartbeat (monitor block, live-sample monitors, monitor report) | each heartbeat | only groups that can change that answer: those carrying a monitor whose key has a monitor of a kind the heartbeat asks about |
| Heartbeat (client-update hold) | only when a POLICY update is queued for the computer | the business's group policies, for that computer |
| Device page, policy pages | each read | the groups carrying a policy, for the computers shown |

A snapshot is never kept beyond the call or tick that built it.

### Measured cost

`apps/api/scripts/bench-group-policy.mjs`: one business, 5,000 computers over
10 sites, 50 rule groups covering every condition a policy-usable rule may
carry (tag, online, platform, site, OS, RustDesk version, pending patches,
restart pending, agent type, last seen), a group monitor on every group and a
group client-update policy on 49. Medians on the development server, with
other work running on it:

| What | Median | Worst |
|---|---|---|
| One membership snapshot of 50 rule groups over 5,000 computers (per sweep tick) | 0.6–0.9 s | 0.95 s |
| Monitor sweep, 50 group monitors (baseline without them: 0.4–0.7 s) | 1.5 s | 1.6 s |
| Client-update sweep membership, 49 group policies (per business per tick) | 0.7 s | 0.75 s |
| Heartbeat monitor block when no group monitor is of a kind it asks about | 12 ms | 18 ms |
| Heartbeat monitor block when all 50 groups carry service monitors (worst case) | 84 ms | 220 ms |
| Client-update hold for one computer (only while a POLICY update is queued) | 41 ms | 125 ms |

The sweeps stay well inside their tick, so membership is computed fresh each
tick and is not cached. The heartbeat's worst case grows with the number of
rule groups that carry a **service or event** monitor — each one is one or two
small queries for that computer — not with the number of groups or
computers. Fifty such groups is the ceiling (a business can have at most 50
rule groups); a handful, which is the common case, costs a few milliseconds.

## Security

- **Another business's group is a 404**, for monitors and for client updates,
  the same as a made-up id. The database also refuses a policy whose group
  belongs to another business (trigger `group_policy_same_business`, 0057).
- **Who may set them** is unchanged: monitors need `monitoring:configure` for
  the whole business (or the Business Owner, or the MSP); client-update
  policies need what a business policy needs.
- **Fresh authentication.** Turning a group client-update policy on, or
  saving one that stays on, needs it, as for a business policy. **Removing** a
  group policy needs it too: its computers fall back to a site or business
  policy that may be on.
- **Deleting a group that carries a policy is refused** (*GROUP_HAS_POLICIES*,
  409, and NO ACTION foreign keys underneath), so deleting the group is not a
  way round the step-up. Remove its policies first.
- **Who is notified stays global or per business.** There are no group
  notification policies: if editing a group's rule — which needs no step-up —
  could change who hears about an alert, it would be a way round the
  fresh-authentication rule on changing who is notified (§17). Group
  *monitors* decide what is watched, never who is told.
- Changing a group's membership (adding a computer to a static group,
  editing a rule) can move computers onto a group's client-update policy
  without a step-up, exactly as moving a computer to another site can move it
  onto that site's override. The policy itself was confirmed when it was
  turned on.
- Invariants: `scripts/check-security-invariants.mjs` §46.

## Patch policies are not group-scoped

A patch policy's rings name computers, and the approval signer signs exactly
that document: it refuses any ring plan that names a computer the approvers
did not see. A ring "group Tills" would either have to be re-approved every
time the group's membership moved, or would widen what two people approved
without either of them seeing it. Neither is acceptable, so rings stay lists
of named computers. Choosing the computers of a ring from a group when
proposing a policy (a one-time copy, approved as usual) would fit the model;
it is not built.

## Troubleshooting

- **"Another device-group … already has priority N."** Pick a free number.
  For monitors the number only has to be free among group monitors with the
  same key.
- **A group shows "matches no computer".** Its rule cannot be read, or it
  picks computers by alerts. Fix the rule (or remove the policy).
- **A computer did not follow a group policy I expected.** Open its page: the
  Monitoring tab and the Client-update policy row say which scope won and
  what it beat. A computer that is not in the group *now* — offline when the
  rule says online, untagged — does not get the policy.
- **A queued automatic update is held with "policy_off" after a computer left
  a group.** Its request was queued under the group's policy and the policy
  that governs it now is off. Saving any client-update policy for the
  business withdraws such requests; until then the heartbeat holds it.
