# Compatibility testing

Every release must keep working with the agents already installed. Nothing
forces a computer to update on the day a release ships: the signed agent
checks once a day, a computer may be off for weeks, and an update can be
paused. So a server release is tested against the **older released agents**
still in use, not only against the agent built from the same commit.

## What runs

| Check | What it proves | Evidence level |
|---|---|---|
| `compat (agent vX.Y.Z)` CI jobs | the signed agent's decision code **as released at that tag** still works with this server: approved actions, staged patching and patch policies, maintenance actions, service and process control, technician presets | **Sim** — the agent's real Go code against `rem0te-action-sim`'s fake Windows services |
| The ordinary e2e suites | the agent built from this commit works with this server | Sim / API |
| `agent-lab-windows` (when merged) | the agent's Windows code and RustDesk on a real, disposable Windows Server VM | Lab |

None of the compatibility jobs touch a real Windows computer. A green
compatibility run says the older agent's *decisions* still meet the new
server's plans, results and refusals. It does not say the agent's Windows
calls work; that is what the lab and the fleet are for
(`docs/readiness.md` and `docs/lab-testing.md`, both in review).

### New report fields (0.69)

A signed agent from 0.69 adds one heartbeat field, `rustdeskPreflight`
(Managed Secure Access readiness). Older agents send nothing and get exactly
the answer they got before — no new key in it. The portal drops a block it
cannot parse rather than refusing the heartbeat, so an agent newer than the
portal never fails either. `e2e-msa-readiness.mjs` checks both.

## Supported versions

`scripts/compat/supported-agents.json` lists them, each with why it is there:

| Agent | Why |
|---|---|
| v0.64.0 | running on production computers (2026-11-19) |
| v0.67.0 | the previous minor release before 0.68 |
| v0.68.3 | the previous release (0.69 adds the RustDesk preflight; 0.68.3 sends none) |

The agent built from the commit under test is always covered by the ordinary
suites.

**Changing the list is a support decision.** A version leaves only by moving
to `retired` with the date and the reason, so the record of what was once
supported stays. Add the previous release on every release, and any version
still reported by computers you manage.

## When an older agent fails

A supported agent failing a suite fails the job. Either the server broke it
(fix the server), or the change is intentional: then the suite goes in
`knownIncompatible` for that tag, with the reason and what the computers on
that version must do, and the release notes say so. Nothing is dropped
silently.

## Running it yourself

```bash
DATABASE_URL=postgresql://…/<name containing scratch or test> scripts/compat-agents.sh v0.64.0
```

It refuses any other database, builds the agent from the tag with
`git archive` (the working tree is not used), and writes
`.compat-logs/<tag>/evidence.json`: the tag, the server version and commit,
and each suite's result.

## What is not covered yet

- **The standard (PowerShell) agent and the Linux and macOS agents.** Their
  heartbeat and command-result bodies per released version, replayed against
  the new API, are next.
- **RustDesk client versions** against the server's connect paths: part of the
  lab.
- **ClientSt0r contract versions:** the integration does not yet interoperate
  with the real ClientSt0r (`docs/readiness.md`).
- **The release gate.** The jobs report on every pull request; making them a
  required check is the owner's call once they have run stably.
