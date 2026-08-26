# Troubleshooting

Start here when something does not connect. The single most useful fact on this
page: **the error RustDesk shows almost never names the component that produced
it.**

---

## "Failed to connect: the target device is offline or does not exist"

This is hbbs's answer, relayed by the client. It has four distinct causes that
look identical from the technician's chair, and one command tells them apart.

### First move, always

```bash
sudo deploy/scripts/hbbs-probe.py <rustdesk-id>
```

| Verdict | What it rules out | Go to |
|---|---|---|
| `ONLINE` | Server and endpoint are both fine | [The client you're connecting from](#the-client-youre-connecting-from) |
| `OFFLINE` | Server is fine; endpoint is not registered right now | [Endpoint not registered](#endpoint-not-registered) |
| `ID_NOT_EXIST` | hbbs has never seen this ID | [Endpoint on the wrong server](#endpoint-on-the-wrong-server) |
| `LICENSE_MISMATCH` | Keys disagree | [Key mismatch](#key-mismatch) |

hbbs writes **nothing** to its log when a connection request fails — no line for
an unknown ID, none for an offline peer, none for a key mismatch. Reading
`/var/log/rustdesk-server/hbbs.log` after a failed connect will show you
nothing, which is why this script exists.

### The client you're connecting from

**`ONLINE` means the endpoint is reachable and the server is doing its job.**
The RustDesk on your own machine is asking a different rendezvous server.

The Connect button opens `rustdesk://connection/new/<id>`, which Windows routes
to whichever RustDesk is installed, using whatever server *that* client points
at. The URI scheme has no field for a server address. A stock client — a fresh
install, or an auto-update that replaced a configured build — asks
`rustdesk.com`, where your IDs do not exist.

**Fix:** In Rem0te, click **Connect**. It downloads a small script that installs
RustDesk if the machine has none, points it at this server, and opens the
session. Run it once and subsequent connects work directly.

Or, from **Downloads**, run *Set up this computer for Connect*.

Still failing after that:

- **Quit RustDesk completely first** — from the system tray, not just the
  window. A running client will not pick up a configuration change.
- **Uninstalling RustDesk does not clear its settings.** `%APPDATA%\RustDesk`
  survives an uninstall and a fresh install reads the old server straight back
  out of it. Delete that folder, then reinstall.
- **Check what the client actually thinks:** RustDesk → Settings → Network →
  ID/Relay Server. The ID Server must be your Rem0te host and the Key must match
  Rem0te → Settings → RustDesk → Public Key exactly.

### Endpoint not registered

`OFFLINE` — hbbs knows the ID but has no live registration.

- **Within ~30 seconds of an hbbs restart this is normal.** The online-peer map
  is in memory; a restart empties it and clients re-register on their next
  cycle. Every `rustdesk-server` upgrade and every
  `systemctl restart rustdesk-hbbs` opens that window. Wait, probe again.
- Otherwise: the endpoint is off, RustDesk is not running on it, or it has lost
  its route to port 21116. Compare against the endpoint's **Last seen** in
  Rem0te — that is a separate HTTP heartbeat. Heartbeat current but hbbs
  `OFFLINE` means RustDesk specifically is stopped or misconfigured on that
  machine.

### Endpoint on the wrong server

`ID_NOT_EXIST` — hbbs has never seen this ID, so the endpoint is registering
somewhere else, usually `rustdesk.com`.

Re-run the Rem0te installer on it. Installs from before **v0.8.2** wrote the
RustDesk *service* config to a path the service never reads, leaving it running
on defaults pointed at the public servers while every check passed. That fix
only lands by reinstalling.

### Key mismatch

`LICENSE_MISMATCH` — the key presented is not the one hbbs was started with.

```bash
cat /var/lib/rustdesk-server/id_ed25519.pub
```

must equal Rem0te → Settings → RustDesk → Public Key. If you regenerated the
server keypair, every client configured before that moment is now wrong.

---

## Connected, but the password is rejected

Rem0te stores the endpoint's permanent password encrypted and hands it to the
client. It desyncs if someone ran `rustdesk --password` on the endpoint by hand.
Stage a credential rotation from the endpoint's page, or re-run the installer.

---

## The Connect script closes before you can read it

Every run writes a full log to:

```
%LOCALAPPDATA%\Rem0te\rem0te-last-run.log
```

Open that. It survives the window closing, and it is the fastest way to see
which step failed.

The script also pauses on failure now, so a window that closes instantly
usually means something stopped it before PowerShell ever ran — see below.

To watch it run with the window guaranteed to stay open, start a Command Prompt
first and drag the file into it, or:

```bat
cmd /k "%USERPROFILE%\Downloads\Connect to NAME.cmd"
```

Other reasons it may appear to do nothing:

- **It needs to actually run.** A browser that saved it and did not open it has
  done nothing yet.
- **SmartScreen may block it** — *More info* → *Run anyway*.
- **It deletes itself on completion by design**, because it carries a live
  credential. If you need it again, click Connect again.

The log never contains the password: the error handler prints the failing
command's category, deliberately not the script line, because the whole script
is one line and printing it would put the credential in the log.

---

## An endpoint shows online in Rem0te but RustDesk says offline

They are different signals and both are correct.

| Signal | Source | Lifetime |
|---|---|---|
| Rem0te's dot | HTTP heartbeat every ~3 min | Swept offline after ~10 min |
| RustDesk | Live registration with hbbs, **in memory only** | Empty after any hbbs restart |

A Connect depends only on the second. `hbbs-probe.py` reports the second.

---

## Endpoints stuck "Update pending" forever

Only installers from v0.8.2 onward report a RustDesk version *and* understand
the staged-upgrade instruction. An older endpoint can be staged for an upgrade
it will never apply, and the staging never clears because clearing requires the
endpoint to report the target version.

Re-run the installer on those machines by hand. They need it anyway for the
service-config fix.

---

## WebSocket routes answer but nothing works

`/ws/id` and `/ws/relay` need **rustdesk-server 1.1.16 or newer**. 1.1.15
accepts the WebSocket upgrade and immediately drops the connection, so the
routes look healthy and do nothing.

```bash
hbbs --version
sudo deploy/scripts/hbbs-probe.py <id> --ws --host <your-host>
```

Upgrade from **Updates → RustDesk Server**, or see [updates.md](updates.md).

---

## Endpoints appear briefly then go offline

Port 21116 needs **UDP as well as TCP**. Registration is UDP; a firewall or
port-forward that carries only TCP produces exactly this.

```bash
sudo tcpdump -i any -nn 'udp port 21116'
```

---

## Services

```bash
systemctl status reboot-remote-api reboot-remote-web rustdesk-hbbs rustdesk-hbbr
journalctl -u reboot-remote-api -n 50
tail -50 /var/log/rustdesk-server/hbbs.log     # startup and key only — nothing per-connection
```

---

## Reset admin password

```bash
node -e "require('argon2').hash('NewPassword123').then(h => console.log(h))"
sudo -u postgres psql reboot_remote -c \
  "UPDATE \"User\" SET password = 'HASH' WHERE email = 'admin@example.com';"
```

---

## See also

- [connecting.md](connecting.md) — how the connect paths work
- [clients.md](clients.md) — which client is which
- [updates.md](updates.md) — Rem0te, clients, and hbbs/hbbr
