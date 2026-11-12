# Rem0te documentation

Start with the page that matches what you are doing. All of this is also inside
the product under **Help & docs → Full documentation** in the sidebar, as a grouped index with a
contents panel on every page and search across all of it (press <kbd>/</kbd>).

## Something is broken

- **[troubleshooting.md](troubleshooting.md)** — start here. Especially for
  *"the target device is offline or does not exist"*, which almost never means
  what it says.

## Using it

- **[technician-guide.md](technician-guide.md)** — day-to-day: find a computer,
  connect, help someone unenrolled, review sessions.
- **[clients.md](clients.md)** — every RustDesk client Rem0te hands out, who each
  is for, and how it learns where this server is.
- **[connecting.md](connecting.md)** — what actually happens when you click
  Connect, the three connect paths, and why they are not equivalent.
- **[capabilities.md](capabilities.md)** — what each agent type can do (standard,
  signed, Linux/macOS, Quick Connect), what needs configuring first, and what has
  been tested on real Windows versus simulated (0.30).
- **[inventory.md](inventory.md)** — the specs a managed computer reports, its
  installed software and change history, its pending Windows updates, and how
  to read a slice of its event log.
- **[diagnostics.md](diagnostics.md)** — one-click read-only diagnostics: disk space,
  services, recent errors, top processes, network and DNS, pending updates and
  restart status, and what the agent will and will not read (0.31); the Processes,
  Services and Network snapshot tabs (0.33).
- **[monitoring.md](monitoring.md)** — monitors (offline, disk, CPU, memory,
  services, event log, pending restart), inheritance, alerts, site outages,
  maintenance windows, escalation and ClientSt0r tickets (0.29).
- **[group-policies.md](group-policies.md)** — monitors and client-update policies for a device group (0.35):
  computer > group > site > business, priorities between groups, membership computed at each evaluation,
  what the pages show, and the measured cost at 5,000 computers.
- **[metric-history.md](metric-history.md)** — CPU, memory and disk over 24 hours to 90 days on a computer's
  Performance tab: what is recorded, gaps, roll-up and retention settings, storage per 1,000 computers (0.33).
- **[reports.md](reports.md)** — patch compliance, agent coverage, alert frequency and offline time per
  business and site, what each is computed from and what it cannot tell you, and the audited CSV export (0.32);
  software version compliance per catalog entry (0.34).
- **[email.md](email.md)** — outbound email (0.34): the SMTP relay and which hosts it may be, confirmed recipients,
  alert emails, scheduled reports (exactly once per period, evaluated as their owner), and stopping all mail.
- **[tactical-rmm.md](tactical-rmm.md)** — connecting and querying from inside
  Tactical RMM: URL Actions, agent matching, and the Collector Task.
- **[integration-clientst0r.md](integration-clientst0r.md)** — ClientSt0r ticket
  analysis (contract ticket-rmm-v1): staff-only findings, what a job can and
  cannot touch, peers file, mappings. Contract: [contracts/ticket-rmm-v1](contracts/ticket-rmm-v1/README.md).
- **[chat.md](chat.md)** — chatting with the person at a Windows computer: the window on their desktop, receipts,
  limits, containment, audit and 400-day retention; signed agent only, not yet run on real Windows (0.34).
- **[support-requests.md](support-requests.md)** — the customer support link,
  the status page, and the technician queue.
- **[technicians.md](technicians.md)** — MSP technicians: per-business,
  time-limited and scheduled access, groups, approval, the business switcher.

## Running it

- **[security-model.md](security-model.md)** — which technician can reach a customer's PC and what evidence you will
  have afterwards: the portal / RustDesk / endpoint boundary, what each session mode really does, roles vs presets,
  and the roadmap. The same controls, with effective state, are in Settings → Security → Security Features.
- **[update-signing.md](update-signing.md)** — the offline-signed update chain (0.24): what a compromised portal can
  and cannot do, key ceremony, shipping a release, signed-only containment, migrating legacy agents, rotation, recovery.
- **[approved-actions.md](approved-actions.md)** — the first approved action (0.26): starting the Print Spooler once,
  approved by passkey on a separate approval signer and verified by the agent; setup, the roster ceremony, results,
  reconciliation, and what is and is not proven.
- **[staged-patching.md](staged-patching.md)** — Windows updates in stages (0.27): a canary, then rings, each a
  signed plan two approvers authorize; what is installed and refused, the promotion gate, what *effective* means,
  and what is and is not proven.
- **[software-deployment.md](software-deployment.md)** — software deployment (0.34): a catalog of allowlisted winget
  packages pinned by version and installer SHA-256, installed or uninstalled on one computer or by canary and rings
  as signed two-approver actions; detection rules, version compliance, who verifies what, and what is not proven.
- **[script-library.md](script-library.md)**: the script library. PowerShell scripts with immutable, hashed
  versions, static-check warnings, and review by someone other than the author. From 0.34 an approved version
  runs on Windows as the signed action `windows.script.run@1`, only once its hash is on the approval signer's own
  allowlist; the page covers that path, its limits, the threat model, and that it hasn't run on real Windows yet.
  and what is and is not proven. Since 0.32 it also covers installing from one computer's Patches tab and patch
  policies, which are approved once and then signed ring by ring by the signer inside a maintenance window.
- **[patching-setup.md](patching-setup.md)** — turning on signed patching in production, in order (0.32): signed
  release, signed channel, signer, approvers, the first policy; where each key lives; the live pre-flight.
- **[containment.md](containment.md)** — stopping writes during an incident (0.28): a global write pause and
  per-business suspension, enforced by the portal, the approval signer and a signed pause the agents obey; the
  tamper-evident audit log, its off-host export and verification; watching from outside.
- **[incident-recovery.md](incident-recovery.md)** — the runbook: a compromised account, portal or database; key
  rotation; restoring from backup and checking the audit chain against the export.
- **[technician-access.md](technician-access.md)** — technician presets (L1/L2/L3),
  launch policy, protected device classes, fleet-abuse limits, independent
  review of trust changes, and what this build can and cannot enforce.
- **[setup.md](setup.md)** — installation, configuration, ports, operations.
- **[server-sizing.md](server-sizing.md)** — how big a server for 50 to 5,000 computers, from measured heartbeat cost and row sizes.
- **[data-retention.md](data-retention.md)** — what ages out of the database and when, what never does (the audit log), and the `RETENTION_*` settings.
- **[updates.md](updates.md)** — the three things that can be out of date
  (Rem0te, the RustDesk clients, hbbs/hbbr) and how each is updated.
- **[architecture.md](architecture.md)** — what runs where, the data model, and
  the RustDesk configuration chain.
- **[access-control.md](access-control.md)** — the permission model in full.
- **[offboarding.md](offboarding.md)** — who can reach a computer and why, and
  removing someone's access — including what revocation cannot undo.
- **[sign-in.md](sign-in.md)** — passwords, SSO (OIDC), passkeys, step-up, and
  recovering from a sign-in misconfiguration.

## Building on it

- **[API-REFERENCE.md](API-REFERENCE.md)** — every route, its access level and the
  capability it needs. Generated from the controllers and checked against the
  running route table, so it cannot quietly fall behind.
- **[PUBLIC-API.md](PUBLIC-API.md)** — the API guide: scopes, request and
  response shapes, errors, worked examples.
- **[SECURITY-AUDIT.md](SECURITY-AUDIT.md)** — security posture and findings.

---

## The one thing worth knowing up front

Rem0te decides *who may connect to what* and hands out the credential. RustDesk
carries the session. They have **separate ideas of whether a computer is
online**, and a Connect depends only on RustDesk's.

When they disagree — a green dot in Rem0te and "offline" from RustDesk — ask
hbbs directly rather than guessing:

```bash
sudo deploy/scripts/hbbs-probe.py <rustdesk-id>
```

Most of [troubleshooting.md](troubleshooting.md) is downstream of that one
command.
