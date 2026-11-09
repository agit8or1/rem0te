# Rem0te documentation

Start with the page that matches what you are doing. All of this is also inside
the product, searchable, under **Documentation** in the sidebar.

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
- **[inventory.md](inventory.md)** — the specs a managed computer reports, its
  pending Windows updates, and how to read a slice of its event log.
- **[tactical-rmm.md](tactical-rmm.md)** — connecting and querying from inside
  Tactical RMM: URL Actions, agent matching, and the Collector Task.
- **[integration-clientst0r.md](integration-clientst0r.md)** — ClientSt0r ticket
  analysis (contract ticket-rmm-v1): staff-only findings, what a job can and
  cannot touch, peers file, mappings. Contract: [contracts/ticket-rmm-v1](contracts/ticket-rmm-v1/README.md).
- **[support-requests.md](support-requests.md)** — the customer support link,
  the status page, and the technician queue.
- **[technicians.md](technicians.md)** — MSP technicians: per-business,
  time-limited and scheduled access, groups, approval, the business switcher.

## Running it

- **[update-signing.md](update-signing.md)** — the offline-signed update chain (0.24): what a compromised portal can
  and cannot do, key ceremony, shipping a release, signed-only containment, migrating legacy agents, rotation, recovery.
- **[technician-access.md](technician-access.md)** — technician presets (L1/L2/L3),
  launch policy, protected device classes, fleet-abuse limits, independent
  review of trust changes, and what this build can and cannot enforce.
- **[setup.md](setup.md)** — installation, configuration, ports, operations.
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
