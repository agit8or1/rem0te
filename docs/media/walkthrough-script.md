# Rem0te walkthrough — script and transcript

The walkthrough is **caption-led**: the on-screen captions below are what the
recording shows, word for word. **No narration was produced**, and the video
has no audio track.

Recorded against the isolated demo stack described in
[docs/screenshots.md](../screenshots.md#regenerating-these), on v0.53.2. Every
business, person and computer in it is fictitious, and the computers report
through a **simulated agent**: none of the computer actions shown ran on a real
Windows PC. The AI provider and the PSA are loopback stand-ins on the demo
server.

**Length:** 14:35 · highlight cut: 1:20

## Chapters

| Time | Chapter |
|---|---|
| 0:07 | Sign in |
| 0:20 | Dashboard |
| 0:37 | Devices |
| 1:19 | A computer |
| 6:19 | Tasks |
| 7:32 | Connect |
| 7:48 | Reinstall link |
| 8:15 | Add device |
| 8:43 | Patching |
| 9:46 | Monthly windows |
| 10:24 | Scheduled installs |
| 10:51 | Patching |
| 10:57 | Software catalog |
| 11:21 | Scripts |
| 11:35 | Monitoring and alerts |
| 11:55 | Reports |
| 12:07 | Businesses |
| 12:23 | Settings |
| 13:33 | Audit log |
| 13:40 | Docs and help |
| 14:25 | Rem0te |

## Captions

| # | Time | Chapter | On-screen caption |
|---|---|---|---|
| 1 | 0:00 | Title card | Rem0te — Self-hosted remote support and management for the computers of your customer businesses, built on RustDesk. — A captioned tour of every feature · v0.53 |
| 2 | 0:07 | Sign in | A demo environment: every business, person and computer here is fictitious |
| 3 | 0:16 | Sign in | The computers report through a simulated agent: nothing shown here ran on a real Windows PC |
| 4 | 0:23 | Dashboard | The dashboard: what needs attention now, across every customer business |
| 5 | 0:28 | Dashboard | A site outage is grouped into one alert instead of one per computer |
| 6 | 0:33 | Dashboard | Counts, customers affected and patch status, each a link into the detail |
| 7 | 0:41 | Devices | Devices: every enrolled computer you may see, with health, agent and patches |
| 8 | 0:45 | Devices | Search by name, host, IP, user or business |
| 9 | 0:52 | Devices | Filters for business, site, group, online state, alerts and agent |
| 10 | 1:00 | Devices | Views save a filter set, private or shared with the team |
| 11 | 1:04 | Devices | Columns come in at the window widths where they fit |
| 12 | 1:09 | Devices | Tick computers for bulk actions: update, reinstall, tags, groups, export |
| 13 | 1:22 | A computer | One computer's workspace: status, the actions you may take, and a tab per job |
| 14 | 1:27 | A computer | The header says what is wrong at a glance: alerts, pending updates, which agent |
| 15 | 1:31 | A computer | The Tasks panel: everything sent to this computer, and where each one is |
| 16 | 1:38 | A computer | Recent tasks stay listed for two weeks, each with its steps and its result |
| 17 | 1:46 | A computer | The Agent card: version, channel, and automatic agent updates |
| 18 | 1:51 | A computer | Automatic updates can be set per computer: Inherit, On or Off |
| 19 | 1:57 | A computer | This demo server runs with automatic agent updates switched off, which wins over the computer's On |
| 20 | 2:03 | A computer | Inventory: hardware, operating system, disks and the logged-on user |
| 21 | 2:10 | A computer | Performance: processor, memory and disk over up to 30 days |
| 22 | 2:17 | A computer | Software: the catalog, ready to install, and every installed program |
| 23 | 2:18 | A computer | Install a package from the catalog: one signed plan for this computer |
| 24 | 2:29 | A computer | Remove an installed program: the agent reads the uninstall entry itself and decides how |
| 25 | 2:41 | A computer | Rem0te and RustDesk are protected and never offered for removal |
| 26 | 2:51 | A computer | Services: start, stop, restart, or change the startup type |
| 27 | 3:03 | A computer | Each change is a signed plan; the agent checks the service again before it acts |
| 28 | 3:12 | A computer | Processes: end one process, matched by name and start time, never a reused PID |
| 29 | 3:26 | A computer | Event logs, with Ask AI and Create ticket on any entry |
| 30 | 3:31 | A computer | Ask AI explains an entry in plain language. Here the provider is a local stand-in |
| 31 | 3:39 | A computer | Create ticket sends the entry to your PSA, with the AI explanation if you want it |
| 32 | 3:54 | A computer | The ticket number comes back from the PSA (a loopback stand-in in this demo) |
| 33 | 4:00 | A computer | Patches: the signed agent's last Windows Update scan, and what it offers |
| 34 | 4:05 | A computer | The Latest install follows an install from the request to the scan after it |
| 35 | 4:15 | A computer | One row per update, with Windows' own error code and what it means |
| 36 | 4:20 | A computer | Windows wants a restart: Schedule restart warns the signed-in user first, and never interrupts a session |
| 37 | 4:25 | A computer | Scan now, or let the scan two minutes after the restart refresh the list |
| 38 | 4:29 | A computer | Updates that install put on the computer wait for the restart instead of being offered again |
| 39 | 4:35 | A computer | Tick the update that failed to try it again |
| 40 | 4:38 | A computer | Install now, or Schedule it: a date, a time and a time zone, up to 14 days ahead |
| 41 | 4:49 | A computer | Or start at the next opening of this computer's patch policy window |
| 42 | 4:58 | A computer | Nothing is handed to the computer before then, and until it starts it can be canceled |
| 43 | 5:03 | A computer | Each computer's Patch policy: Inherit the company-wide policy, Exclude, or use another policy |
| 44 | 5:08 | A computer | It says when the policy's window next opens |
| 45 | 5:16 | A computer | Exclude stops automatic patching at once; Install updates on this tab still works |
| 46 | 5:24 | A computer | Monitoring: this computer's alerts, and which monitors apply to it |
| 47 | 5:29 | A computer | Actions: approved maintenance, like starting the Print Spooler, with its current state |
| 48 | 5:37 | A computer | Diagnostics: a fixed catalog of read-only checks, run on the computer |
| 49 | 5:43 | A computer | Chat with the person at the computer, in the tray on their screen |
| 50 | 5:44 | A computer | Pictures and files go both ways; a picture is shown only if its bytes really are one |
| 51 | 5:49 | A computer | A built-in emoji picker |
| 52 | 6:07 | A computer | Unread replies from every computer collect in the header's chat inbox |
| 53 | 6:16 | A computer | History: sessions, changes and actions on this computer, newest first |
| 54 | 6:19 | Tasks | The number in the top bar is your tasks in progress, on every page |
| 55 | 6:28 | Tasks | Automation → Tasks: every task on every computer you can see |
| 56 | 6:36 | Tasks | Queued for the next check-in, handed out, scheduled, held, or done |
| 57 | 6:41 | Tasks | Overdue when it takes longer than its kind usually does, with what that usually means |
| 58 | 6:47 | Tasks | A scheduled install, held until its time; it can be canceled until then |
| 59 | 6:54 | Tasks | Filter by state and by type |
| 60 | 7:01 | Tasks | Now the gatehouse install answers. A task you started finishing shows a toast, wherever you are |
| 61 | 7:26 | Tasks | Done, with each update's result |
| 62 | 7:36 | Connect | Connect opens RustDesk on your computer, configured for this server |
| 63 | 7:41 | Connect | It releases the computer's password, so it asks you to confirm it is you first |
| 64 | 7:51 | Reinstall link | A computer that has gone quiet says so under its buttons, with a link to reinstall its agent |
| 65 | 7:57 | Reinstall link | The same is under More → Reinstall manually (download link) |
| 66 | 8:09 | Reinstall link | The link re-attaches to the same record: history, site and settings kept, no duplicate |
| 67 | 8:17 | Add device | Add device: choose where the computer lands, and who may connect to it |
| 68 | 8:27 | Add device | The business is fixed into the link; the computer that runs it cannot choose another |
| 69 | 8:33 | Add device | Then pick the operating system and make a one-time install link |
| 70 | 8:37 | Add device | Light and dark themes ship with the product |
| 71 | 8:45 | Patching | Patching: Windows updates a canary first, then rings, inside a maintenance window |
| 72 | 8:50 | Patching | The pre-flight reads what signed patching needs and says what is missing |
| 73 | 8:55 | Patching | A company-wide policy covers every computer set to Inherit |
| 74 | 9:01 | Patching | The portal builds the rings: a canary that checks in reliably, then rings of at most 25 |
| 75 | 9:06 | Patching | A computer that cannot be patched is listed with the reason |
| 76 | 9:12 | Patching | When computers join or leave, a new revision is proposed and signed like any policy |
| 77 | 9:16 | Patching | An assignable policy covers only the computers set to use it: here the depots, monthly |
| 78 | 9:22 | Patching | Two days after Patch Tuesday, and it says when its window next opens |
| 79 | 9:27 | Patching | Every computer's setting in one place: Inherit, Exclude or Use policy |
| 80 | 9:33 | Patching | A new policy chooses its classes, window, soak between rings, restart rule and canary |
| 81 | 9:46 | Monthly windows | A policy's maintenance window is weekly or monthly |
| 82 | 9:59 | Monthly windows | The nth or last weekday of the month, plus up to 14 days: second Tuesday + 2 is the Thursday after Patch Tuesday |
| 83 | 10:06 | Monthly windows | Its next three openings come from the server, worked out exactly as the approval signer checks them |
| 84 | 10:12 | Monthly windows | Or a day of the month, 1 to 28, so it opens every month, February included |
| 85 | 10:27 | Scheduled installs | A deployment's next ring can start now or at a time too |
| 86 | 10:39 | Scheduled installs | The time becomes the signed plan's start, and the agent refuses it early. Not sent in this demo |
| 87 | 10:46 | Scheduled installs | A scheduled ring shows when it starts, and can be canceled until then |
| 88 | 10:51 | Scheduled installs | The patch compliance report, by business and by computer |
| 89 | 11:00 | Software catalog | The software catalog: approved packages with the installer's hash pinned |
| 90 | 11:02 | Software catalog | Browse the winget community index and add packages by selection |
| 91 | 11:23 | Scripts | The script library: versioned PowerShell, reviewed before it can run anywhere |
| 92 | 11:30 | Scripts | Each version shows its content hash and static checks, and needs approving |
| 93 | 11:37 | Monitoring and alerts | Alerts from every monitor, grouped and filtered |
| 94 | 11:42 | Monitoring and alerts | An outage lists the computers in it; acknowledge or resolve it with a note |
| 95 | 11:48 | Monitoring and alerts | Monitors are set globally, per business, site, group or computer, the most specific winning |
| 96 | 11:58 | Reports | Reports: patch status, offline time, alerts, agent coverage and software |
| 97 | 12:05 | Reports | Each one can be exported as CSV, or emailed on a schedule |
| 98 | 12:11 | Businesses | Businesses: each customer owns its computers, people, sites and history |
| 99 | 12:17 | Businesses | Automatic agent updates per business: Inherit, On, Off or in its maintenance window |
| 100 | 12:27 | Settings | Confirm it is you: choose, function by function, which changes ask again after sign-in |
| 101 | 12:33 | Settings | Here the everyday changes are set to Don't ask; install links and security changes still ask |
| 102 | 12:45 | Settings | Some always ask: your password, authenticator and passkeys, and turning a confirmation off |
| 103 | 12:55 | Settings | AI: your own provider and key. This demo answers from a local stand-in, with a fake key |
| 104 | 13:02 | Settings | PSA / ticketing: a connector per business or for the whole platform |
| 105 | 13:08 | Settings | Email: your SMTP relay for alerts and scheduled reports, to confirmed recipients only |
| 106 | 13:13 | Settings | Access control: Platform Admin, Business Owner and Business User |
| 107 | 13:19 | Settings | Each user holds exactly the capabilities granted to them |
| 108 | 13:24 | Settings | Users: invitations, roles, MFA status and offboarding |
| 109 | 13:30 | Settings | Security: what protects the server, read from the server itself |
| 110 | 13:36 | Audit log | Every change is in the audit log, in a hash chain that shows any deletion |
| 111 | 13:43 | Docs and help | The full documentation is built into the app, with search |
| 112 | 13:58 | Docs and help | The tray runs on Windows. These are its generated icons; its menu has not been photographed on Windows |
| 113 | 14:06 | Docs and help | Its menu opens with the business and its IT provider, and offers a support request only when a PSA is set up |
| 114 | 14:15 | Docs and help | Help: short answers for technicians, in the app |
| 115 | 14:25 | Rem0te | Self-hosted. Open source. No RustDesk Pro required. |
| 116 | 14:29 | Title card | Rem0te — Self-hosted remote support and management, built on RustDesk. Install guide, docs and source on GitHub. — github.com/agit8or1/rem0te  ·  mspreboot.com |

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
