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

## Running it

- **[setup.md](setup.md)** — installation, configuration, ports, operations.
- **[updates.md](updates.md)** — the three things that can be out of date
  (Rem0te, the RustDesk clients, hbbs/hbbr) and how each is updated.
- **[architecture.md](architecture.md)** — what runs where, the data model, and
  the RustDesk configuration chain.
- **[access-control.md](access-control.md)** — the permission model in full.

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
