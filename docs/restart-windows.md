# Restart windows

From 0.60 you can say, in one place, when a computer may be restarted automatically:

> Restart if Windows needs it, nightly 02:00–04:00, America/Chicago.

Set it on a **business** (the default for every computer in it), on a **device group**, or on **one computer**. A
computer can also be set to **No automatic restarts**. Before 0.60 the only automatic restart was a patch policy's
restart window (0.54), so a computer that was not in a patch policy with one — or whose updates were installed by
Windows itself — sat with *restart required* until someone restarted it by hand. That is what happened to the
computer whose missed restart prompted this feature.

**With nothing set, nothing restarts a computer automatically.** That has not changed.

## Where to set it

| Where | What it sets |
|---|---|
| **Businesses → (a business) → Overview → Restart window** | The business's window; a window for any of its device groups; and a list of its computers with their own setting (each with *Inherit*) |
| **Computers → (a computer) → Patches → Restart window** | What governs this computer and where it comes from, and this computer's own setting: a window, or *No automatic restarts* |
| **Computers → select some → Restart window…** | *No automatic restarts*, or *Inherit* (remove each one's own setting), for up to 200 computers |

### Which one applies

The most specific one that is in force wins, as everywhere else in rem0te (0.35):

1. the computer's own setting (a window, or *No automatic restarts*);
2. a device group's, lowest priority number first (1 beats 2) — each group setting has its own priority, and two
   groups of one business never share one;
3. the business's.

The card on the Patches tab says which one governs the computer, in words — *from business Acme*, *from device
group Servers*, *set on this computer* — or **None — this computer is never restarted automatically.**

A window that is not in force — waiting for approval, rejected, revoked, paused or expired — governs nothing, and
the next one down applies. The card names it and says why, so *Waiting for approval* is never mistaken for *in force*.

A computer in a patch policy that has its **own** restart window (0.54) is restarted by that policy, not also by a
restart window; the card says so.

## What a window says

| Field | Choices |
|---|---|
| When | **Restart if Windows needs it** (the default) — only a computer Windows says needs a restart (pending updates, a pending file rename, a component servicing reboot) is restarted. **Restart every time the window opens** — a maintenance restart, whether or not Windows asks |
| Window | Daily (a weekly window on every day), weekly on chosen days, or monthly (the nth or last weekday plus 0–14 days, or day 1–28) — the same window shapes as a patch policy's (0.53). At least 30 minutes long. A window may cross midnight |
| Time zone | One IANA zone. The editor offers the business's site time zones first |
| RustDesk exception | *Restart even if a technician is connected through RustDesk (their session is dropped)*. **Never ticked by default** |

From 0.63 a window **does not expire**: it stands until it is changed, removed, paused or revoked. Its signed
document carries `expiry: "never"` instead of a date, and the approval page says *Expires: Never*. A window set before
0.63 keeps the expiry it was approved with (at most 90 days) and stops then; the card says so, and **Change → Save**
sets it again without one (which is approved again). See
[Staged patching → Policies that never expire](staged-patching.md#policies-that-never-expire-063).

## How a restart happens

Nothing in the portal restarts a computer. Every automatic restart is a signed `windows.reboot.schedule@1` plan:

1. **The window is approved once.** Saving a window creates an automation policy (0.58) whose task is `restart`.
   Two people approve it with their passkeys on the approval signer — never the person who set it — unless the
   business uses **direct mode** (0.40), in which case it is in force at once. Until it is approved the card says
   **Waiting for approval** with a link to the signer's page, and it restarts nothing.
2. **Inside the window, the portal asks.** Every minute the restart-window sweep looks at every computer a window in
   force governs. For one that is online, runs the signed agent, has no restart or update install already open, and
   — under *if Windows needs it* — whose last scan says a restart is pending, it asks the signer for **one** restart
   plan for that one computer.
3. **The signer decides each plan** against the approved window, from its own copy of it: the computer is in the
   business (and, for a computer's own window, is that computer as enrolled); the plan starts now and the restart —
   its last moment plus the warning — falls inside the window, by the same occurrence function the patch policies
   use; the parameters are exactly the fixed **15-minute warning**, `onlyIfRequired` under *if Windows needs it*,
   and `ignoreRemoteSession` only if the window has the exception; no other plan for that computer in this window is
   still open; and at most **three** have been signed for it in this window. Anything else is refused and the
   portal shows the signer's reason.
4. **The agent decides again.** It verifies the signed plan, and — with `onlyIfRequired` — reads Windows' own
   restart-pending state and does nothing if none is pending (*No restart required*). A signed-in Windows user does
   not stop the restart: they see the 15-minute warning, and unsaved work is lost. **An open RustDesk session does**,
   unless the window has the exception.

### Deferred, and tried again

A restart that waits for a RustDesk session (or because the computer could not tell whether one was open), or a plan
that never reached the computer before it closed, is asked for again **15 minutes later in the same window**, up to
three tries a window, and again in the next window. A restart that ran, or one the computer said was not needed, is
not tried again in that window.

A computer that is offline for the whole window is tried in the next one. One that never checks in, or still runs
the standard agent, is never restarted; the card says so.

## Who may change it

| Change | Who | Confirm it is you? |
|---|---|---|
| A business's or a group's window | A Business Owner of the business, a technician with *computers:edit* and *actions:request* over the whole business, or the MSP | Yes (`restart.window`) |
| A computer's own window | Someone with *computers:edit* and *actions:request* on that computer | Yes |
| *No automatic restarts* on a computer or group | The same people | No — it only narrows |
| Removing a group's or computer's own setting (*Inherit*) | The same people | Yes — the computers fall back to the window above, which may restart them |
| Removing the business's window | The business's editors | No — it only narrows |

Whether *confirm it is you* asks is the *Settings → Confirm it is you* policy (0.49); the catalog key is
`restart.window`. Every change is in the audit log as `RESTART_WINDOW_SET` or `RESTART_WINDOW_CLEARED`, with the
setting before and after. A window's own policy is audited like any automation policy (`AUTOMATION_POLICY_CREATED`,
`AUTOMATION_POLICY_REVOKED`), and each restart like any action (`ACTION_REQUESTED` and its results).

Changing a window replaces the one in force **only once the change is approved**; until then the old window keeps
working and the card shows the change as waiting. Removing a window, or setting *No automatic restarts*, revokes the
window at once — in the portal and on the signer — and cancels any of its restart plans that have not yet reached
their computer.

A device group that carries a restart window cannot be deleted until the window is removed.

## Containment

A containment pause on **Approved actions** (`actions`) for the business, or for everything, stops every automatic
restart: the sweep asks for nothing and the window says why. The approval signer's own pause refuses the plans too.

## Operating it

- `RESTART_WINDOW_SWEEP=off` stops the sweep in a process. Every test stack sets it; never set it in production.
  `RESTART_WINDOW_SWEEP_SECONDS` (default 60, minimum 2) is how often it runs. At most 100 plans are asked for in one
  pass.
- **The approval signer must be 0.60 or later.** An older signer does not know the `restart` task; the card says
  *The approval signer answering is older than 0.60* and nothing can be set until it is reinstalled.
- The agent needs nothing new. Agents from 0.54 honour `onlyIfRequired` and the RustDesk exception; the portal does
  not ask an older agent for a plan carrying either.

## Not proven

- **No restart window has restarted a real Windows computer.** Every restart above was decided by the agent's real
  verifier and executor against a simulated registry and RustDesk session state (`rem0te-action-sim`), as for 0.54.
- The signer cannot see which computers a business or group window governs; it holds each plan to the business and
  the window, and the portal decides membership. A compromised portal could ask for a restart of another computer of
  the same business inside an approved window — never outside it, never with a shorter warning, never without
  *only if required* under a window that has it, and never more than three times a window.
