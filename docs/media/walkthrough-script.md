# Rem0te walkthrough — script and transcript

The walkthrough is **caption-led**: the on-screen captions below are what the
recording shows, word for word. **No narration was produced**, and the video
has no audio track.

Recorded against the isolated demo stack described in
[docs/screenshots.md](../screenshots.md#regenerating-these), on v0.50.5. Every
business, person and computer in it is fictitious, and the computers report
through a **simulated agent**: none of the computer actions shown ran on a real
Windows PC. The AI provider and the PSA are loopback stand-ins on the demo
server.

**Length:** 10:58 · highlight cut: 1:01

## Chapters

| Time | Chapter |
|---|---|
| 0:07 | Sign in |
| 0:25 | Dashboard |
| 0:48 | Devices |
| 1:40 | A computer |
| 5:26 | Connect |
| 5:40 | Reinstall link |
| 6:11 | Add device |
| 6:41 | Patching |
| 7:44 | Software catalog |
| 8:09 | Scripts |
| 8:23 | Monitoring and alerts |
| 8:42 | Reports |
| 8:54 | Businesses |
| 9:07 | Settings |
| 10:12 | Audit log |
| 10:20 | Docs and help |
| 10:48 | Rem0te |

## Captions

| # | Time | Chapter | On-screen caption |
|---|---|---|---|
| 1 | 0:01 | Title card | Rem0te — Self-hosted remote support and management for the computers of your customer businesses, built on RustDesk. — A captioned tour of every feature · v0.50 |
| 2 | 0:07 | Sign in | A demo environment: every business, person and computer here is fictitious |
| 3 | 0:22 | Sign in | The computers report through a simulated agent: nothing shown here ran on a real Windows PC |
| 4 | 0:30 | Dashboard | The dashboard: what needs attention now, across every customer business |
| 5 | 0:36 | Dashboard | A site outage is grouped into one alert instead of one per computer |
| 6 | 0:42 | Dashboard | Counts, customers affected and patch status, each a link into the detail |
| 7 | 0:53 | Devices | Devices: every enrolled computer you may see, with health, agent and patches |
| 8 | 0:59 | Devices | Search by name, host, IP, user or business |
| 9 | 1:08 | Devices | Filters for business, site, group, online state, alerts and agent |
| 10 | 1:18 | Devices | Views save a filter set, private or shared with the team |
| 11 | 1:24 | Devices | Columns come in at the window widths where they fit |
| 12 | 1:30 | Devices | Tick computers for bulk actions: update, reinstall, tags, groups, export |
| 13 | 1:43 | A computer | One computer's workspace: status, the actions you may take, and a tab per job |
| 14 | 1:48 | A computer | The header says what is wrong at a glance: alerts, pending updates, which agent |
| 15 | 1:52 | A computer | The Agent card: version, channel, and automatic agent updates |
| 16 | 1:57 | A computer | Automatic updates can be set per computer: Inherit, On or Off |
| 17 | 2:02 | A computer | This demo server runs with automatic agent updates switched off, which wins over the computer's On |
| 18 | 2:09 | A computer | Inventory: hardware, operating system, disks and the logged-on user |
| 19 | 2:15 | A computer | Performance: processor, memory and disk over up to 30 days |
| 20 | 2:20 | A computer | Software: the catalog, ready to install, and every installed program |
| 21 | 2:21 | A computer | Install a package from the catalog: one signed plan for this computer |
| 22 | 2:31 | A computer | Remove an installed program: the agent reads the uninstall entry itself and decides how |
| 23 | 2:41 | A computer | Rem0te and RustDesk are protected and never offered for removal |
| 24 | 2:48 | A computer | Services: start, stop, restart, or change the startup type |
| 25 | 2:59 | A computer | Each change is a signed plan; the agent checks the service again before it acts |
| 26 | 3:08 | A computer | Processes: end one process, matched by name and start time, never a reused PID |
| 27 | 3:20 | A computer | Event logs, with Ask AI and Create ticket on any entry |
| 28 | 3:24 | A computer | Ask AI explains an entry in plain language. Here the provider is a local stand-in |
| 29 | 3:32 | A computer | Create ticket sends the entry to your PSA, with the AI explanation if you want it |
| 30 | 3:45 | A computer | The ticket number comes back from the PSA (a loopback stand-in in this demo) |
| 31 | 3:52 | A computer | Patches: the signed agent's last Windows Update scan, and what it offers |
| 32 | 3:57 | A computer | Tick updates to install them on this computer now |
| 33 | 4:09 | A computer | Each computer's Patch policy: Inherit the company-wide policy, Exclude, or use another policy |
| 34 | 4:18 | A computer | Exclude stops automatic patching at once; Install updates on this tab still works |
| 35 | 4:25 | A computer | Monitoring: this computer's alerts, and which monitors apply to it |
| 36 | 4:30 | A computer | Actions: approved maintenance, like starting the Print Spooler, with its current state |
| 37 | 4:38 | A computer | Diagnostics: a fixed catalog of read-only checks, run on the computer |
| 38 | 4:44 | A computer | Chat with the person at the computer, in the tray on their screen |
| 39 | 4:45 | A computer | Pictures and files go both ways; a picture is shown only if its bytes really are one |
| 40 | 4:49 | A computer | A built-in emoji picker |
| 41 | 5:11 | A computer | Unread replies from every computer collect in the header's chat inbox |
| 42 | 5:23 | A computer | History: sessions, changes and actions on this computer, newest first |
| 43 | 5:26 | Connect | Connect opens RustDesk on your computer, configured for this server |
| 44 | 5:32 | Connect | It releases the computer's password, so it asks you to confirm it is you first |
| 45 | 5:44 | Reinstall link | A computer that has gone quiet says so under its buttons, with a link to reinstall its agent |
| 46 | 5:51 | Reinstall link | The same is under More → Reinstall manually (download link) |
| 47 | 6:04 | Reinstall link | The link re-attaches to the same record: history, site and settings kept, no duplicate |
| 48 | 6:14 | Add device | Add device: choose where the computer lands, and who may connect to it |
| 49 | 6:26 | Add device | The business is fixed into the link; the computer that runs it cannot choose another |
| 50 | 6:33 | Add device | Then pick the operating system and make a one-time install link |
| 51 | 6:36 | Add device | Light and dark themes ship with the product |
| 52 | 6:44 | Patching | Patching: Windows updates a canary first, then rings, inside a maintenance window |
| 53 | 6:48 | Patching | The pre-flight reads what signed patching needs and says what is missing |
| 54 | 6:53 | Patching | A company-wide policy covers every computer set to Inherit |
| 55 | 6:59 | Patching | The portal builds the rings: a canary that checks in reliably, then rings of at most 25 |
| 56 | 7:04 | Patching | A computer that cannot be patched is listed with the reason |
| 57 | 7:10 | Patching | When computers join or leave, a new revision is proposed and signed like any policy |
| 58 | 7:15 | Patching | An assignable policy covers only the computers set to use it, here the depots on Sunday morning |
| 59 | 7:20 | Patching | Every computer's setting in one place: Inherit, Exclude or Use policy |
| 60 | 7:26 | Patching | A new policy chooses its classes, window, soak between rings, restart rule and canary |
| 61 | 7:38 | Patching | The patch compliance report, by business and by computer |
| 62 | 7:47 | Software catalog | The software catalog: approved packages with the installer's hash pinned |
| 63 | 7:50 | Software catalog | Browse the winget community index and add packages by selection |
| 64 | 8:12 | Scripts | The script library: versioned PowerShell, reviewed before it can run anywhere |
| 65 | 8:18 | Scripts | Each version shows its content hash and static checks, and needs approving |
| 66 | 8:26 | Monitoring and alerts | Alerts from every monitor, grouped and filtered |
| 67 | 8:31 | Monitoring and alerts | An outage lists the computers in it; acknowledge or resolve it with a note |
| 68 | 8:36 | Monitoring and alerts | Monitors are set globally, per business, site, group or computer, the most specific winning |
| 69 | 8:45 | Reports | Reports: patch status, offline time, alerts, agent coverage and software |
| 70 | 8:51 | Reports | Each one can be exported as CSV, or emailed on a schedule |
| 71 | 8:56 | Businesses | Businesses: each customer owns its computers, people, sites and history |
| 72 | 9:02 | Businesses | Automatic agent updates per business: Inherit, On, Off or in its maintenance window |
| 73 | 9:10 | Settings | Confirm it is you: choose, function by function, which changes ask again after sign-in |
| 74 | 9:15 | Settings | Here the everyday changes are set to Don't ask; install links and security changes still ask |
| 75 | 9:25 | Settings | Some always ask: your password, authenticator and passkeys, and turning a confirmation off |
| 76 | 9:34 | Settings | AI: your own provider and key. This demo answers from a local stand-in, with a fake key |
| 77 | 9:40 | Settings | PSA / ticketing: a connector per business or for the whole platform |
| 78 | 9:46 | Settings | Email: your SMTP relay for alerts and scheduled reports, to confirmed recipients only |
| 79 | 9:51 | Settings | Access control: Platform Admin, Business Owner and Business User |
| 80 | 9:57 | Settings | Each user holds exactly the capabilities granted to them |
| 81 | 10:02 | Settings | Users: invitations, roles, MFA status and offboarding |
| 82 | 10:09 | Settings | Security: what protects the server, read from the server itself |
| 83 | 10:16 | Audit log | Every change is in the audit log, in a hash chain that shows any deletion |
| 84 | 10:24 | Docs and help | The full documentation is built into the app, with search |
| 85 | 10:36 | Docs and help | Help: short answers for technicians, in the app |
| 86 | 10:48 | Rem0te | Self-hosted. Open source. No RustDesk Pro required. |
| 87 | 10:52 | Title card | Rem0te — Self-hosted remote support and management, built on RustDesk. Install guide, docs and source on GitHub. — github.com/agit8or1/rem0te  ·  mspreboot.com |

## How it was made

- `apps/web/scripts/capture-video.mjs` drives the real application with
  Playwright at 1920 × 1080 and records WebM. A red ring marks what is about
  to be read or clicked, and a drawn pointer moves to it (headless Chromium
  records no pointer of its own). `CUT=highlight` records the short cut.
- `scripts/build-video.sh` encodes the MP4s and the poster;
  `scripts/video-captions.mjs` writes this page and `walkthrough.vtt` from
  the recorder's caption log.
- Masking (`apps/web/scripts/capture-masks.mjs`) runs in the page before
  anything is painted: enrolment tokens, long hex secrets, RustDesk IDs, public
  IP addresses and host names outside a small allowlist are replaced in the
  DOM, so no frame carries them. Nothing is written back to the database.
- No remote session is established. Connect stops at its confirmation dialog;
  the service, process, uninstall, install and catalog dialogs are opened and
  cancelled. The only writes are one chat message and one ticket sent to the
  loopback PSA stand-in.
