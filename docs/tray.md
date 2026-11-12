# The tray icon

From 0.36, a managed Windows computer has a Rem0te icon in the notification area for each person signed in. Both
agents install it. From the icon the person can:

- **Chat with support.** A red badge on the icon means a technician has written.
- **Open a support request.** They can attach their resource usage and a screenshot.
- **Run a few self-help tools**, such as checking DNS or renewing their IP address.

> **Not yet run on real Windows.** The portal side of all of this is tested end to end against the real API: codes,
> the chat page, recording, support requests, attachments, self-help, containment and A/B isolation. The tray's own
> logic is unit-tested in Go against a fake portal and a fake operating system. The tray, the agent and the tray
> host build and vet for Windows, the generated PowerShell parses, and the chat page has been driven in Chromium at
> the tray window's size.
>
> **None of the Windows-specific code has run on a Windows machine:**
> - the notification icon, its menu and balloons;
> - the WebView2 window;
> - the support form, and the screenshot taken with `BitBlt`;
> - starting the tray in each session with `CreateProcessAsUser`;
> - the pipes' access list;
> - `ipconfig` and `ping`;
> - the Run key.
>
> Treat all of it as untested until it has run on Windows.

Linux and macOS computers have no tray. The device page's History tab says so.

## The menu

| Item | What it does |
|---|---|
| **Chat with support** (*n new*) | Opens the chat window. If a technician has started a chat, it opens that one. If not, the person can start one (see below) |
| **Open a support request…** | A small form: what they need help with, plus two boxes that are **unticked by default**, *Include my computer's current resource usage* and *Include a screenshot of my screen*. A ticked screenshot is taken at once and shown as a preview with a **Remove** button before anything is sent |
| **Self-help tools** ▸ | The tools listed below. A tool that is paused or not available here is greyed out, with the reason |
| **About** | The business, the agent type (signed or standard), the version, and the portal it talks to |

There is no Quit item. The tray is part of the managed agent, and it is started again at the next sign-in.

## Chat

The chat window is the portal's **`/assist/chat`** page shown in a small WebView2 window, about 440 × 640. If the
Microsoft Edge WebView2 runtime is missing, the tray opens the same page in the default browser and says so in a
balloon. Messages work exactly as they do on the signed agent's chat ([chat.md](chat.md)): the same 2,000-character
cap, the same control-character rules, and receipts set only when the page reports them.

**How the window signs in, without a long-lived credential in a URL:**

1. The tray asks the portal for a **one-time code** over its own channel (see *Credentials*). The portal stores only
   the code's SHA-256 hash, and the code lives **60 seconds**.
2. The tray opens `https://<portal>/assist/open?c=<code>`. The portal **consumes the code with one conditional
   update**, so two requests cannot both use it.
3. In exchange, it sets a session cookie, `rem0te_assist`, with these properties:
   - `HttpOnly; Secure; SameSite=Strict`
   - `Path=/assist`
   - it lasts 2 hours, and only its hash is stored.
4. It answers **303** to `/assist/chat`, so the code leaves the address bar at once.

Replaying the URL from history, a guessed code and an expired code all get the same answer: a 410 page saying the
link has been used and to open the chat from the tray again.

**The page** is served by the API and reached through the web app's `/assist` rewrite. The console's own Content
Security Policy is not applied there. The page sends its own headers:

- **Content Security Policy:**
  - `default-src 'none'`
  - `script-src 'self'`, `style-src 'self'`, `img-src 'self'`, `connect-src 'self'`
  - `base-uri 'none'`, `form-action 'none'`, `frame-ancestors 'none'`
- **Other headers:** `no-store`, `nosniff`, `no-referrer`, `X-Frame-Options: DENY`.
- **Credentials:** the page accepts the `/assist` cookie and nothing else. A portal session is not an `/assist`
  session, and the `/assist` cookie opens nothing in the portal.
- **Writes** (start, send, receipts, end) must carry the header `x-assist: 1`, which a cross-site form cannot set.
- **Text** is drawn with `textContent`, never as HTML, and nothing in a message becomes a link.

**The WebView2 window** is locked down as follows:

- It loads only `https://` URLs under `/assist/` on the portal it was installed for. Every other request,
  sub-resources included, gets a 403 from the tray itself.
- Dev tools, the context menu, host objects, web messages, script dialogs and browser accelerator keys are off.
- Its profile is kept in `%LOCALAPPDATA%\Rem0te\chat-webview`.
- It runs as a separate process (`rem0te-tray.exe --chat-window`), and the URL reaches that process on stdin, not
  on its command line, which other processes can read.

**The person can start a chat** from the tray when none is open. The first message starts the chat, and a support
request appears in the queue at the same time. The request has the origin *The tray on the computer* and a fixed
description; the message itself is not copied, so it does not outlive a chat that is not recorded. The technician's
Chat tab shows the chat as started from the tray, and the conversation's technician reads *Waiting for a technician*
until one replies.

**One Windows account per chat.** A chat belongs to the account that first opened it. Another person signed in to
the same computer gets no badge for it, and if they open the window they are told the chat is someone else's.

### Recording

Whether chats are recorded is a **per-business setting**, falling back to a **platform default**, which is on unless
changed.

| | Who can change it |
|---|---|
| A business's setting (on, off, or *use the default*) | The Business Owner, for their own business; a Platform Admin, for any business |
| The platform default | A Platform Admin |

Every change needs a **fresh sign-in** (`STEP_UP_REQUIRED` until confirmed). Each change is audited as
`CHAT_RECORDING_CHANGED` with the scope and the before and after values. The setting is on **Settings → General**.

The setting is **frozen into each chat when it starts**, and both sides are told: the technician's panel shows
whether this chat is recorded, and so does the person's window.

- **Recorded:** the transcript is kept as described in [chat.md](chat.md), for 400 days.
- **Not recorded:** each message is **deleted from the server once both sides have it**:
  - a technician's message is deleted when the person's window reports it read;
  - a reply is deleted when the technician's panel reports it has shown it. Only the panel of someone who can
    write in the chat counts; a viewer's panel acknowledges nothing.

  Anything left is deleted when the chat ends. The conversation row stays, so the record shows who chatted, when
  and how many messages were sent, but the text is gone. Both windows keep their own copy on screen until they
  close, and both say that closing loses it.

A recording setting is not a substitute for the audit log, which never holds message text either way.

## Support requests from the tray

A request from the tray goes into the [support queue](support-requests.md) for the computer's business. It has the
origin **The tray on the computer**, is linked to the computer, and is signed with the Windows account that sent it.

| Attachment | What it holds |
|---|---|
| **Resource usage** (optional) | CPU %, memory used and total, disk free and total on the system drive, uptime, and the top 10 processes by CPU (name, CPU %, memory). A process name that looks like a path is dropped, and numbers are clamped |
| **Screenshot** (optional) | The whole virtual screen at the moment the box was ticked, scaled to at most 1600 px wide, as JPEG. At most 700 KB (the database refuses more) and 4096 px a side; JPEG or PNG only |

**Who sees the attachments:** only someone who can see **both** the request and the computer. A queue worker who has
not been given the computer sees the request and a note saying how many attachments are hidden; fetching one is a
404 for them, as it is for another business. Attachments are fetched with the portal session, never by a link, and
served with these headers:

- `Content-Type` exactly `image/jpeg` or `image/png`;
- `X-Content-Type-Options: nosniff`;
- `Content-Security-Policy: default-src 'none'; sandbox`;
- `Cache-Control: no-store`.

| Limit | Value |
|---|---|
| Requests per computer | 3 an hour (`SUPPORT_RATE_LIMITED`, 429) |
| Requests per Windows account | 2 an hour (429) |
| Open requests per computer | 3 (`SUPPORT_OPEN_CAP`, 409) |
| Description | 2,000 characters; control characters dropped |
| The tray itself | The same per-device and per-account limits locally, so a person is told before anything is sent |

A request that is refused for its content (an empty description, a bad image) does not count against the limits. A
chat the person starts from the tray counts as one of their requests.

**Containment never stops a support request.** Asking for help is exactly what someone should be able to do while
their business is paused.

## Self-help tools

The catalog is **closed**. The API, the agent and the database (a `CHECK` constraint) hold the same six tools, and
`scripts/check-security-invariants.mjs` §55 fails if they ever differ.

| Tool | What it does | Runs as | Where | Rate per computer | Stopped by |
|---|---|---|---|---|---|
| **Check DNS** (`dns.check`) | Resolves the portal's host name and `www.msftconnecttest.com` | the user | both agents | 10 / 10 min | — |
| **Flush the DNS cache** (`dns.flush`) | `ipconfig /flushdns` | SYSTEM | signed only | 3 / 10 min | `actions` pause |
| **Renew IP address** (`ip.renew`) | `ipconfig /renew`, after a confirmation that the network may drop for a few seconds | SYSTEM | signed only | 2 / 15 min | `actions` pause |
| **Test the connection** (`net.test`) | Pings each gateway, then opens a TLS connection to the portal | the user | both agents | 10 / 10 min | — |
| **Show network details** (`net.details`) | The adapters, addresses, gateways and DNS servers | the user | both agents | 10 / 10 min | — |
| **Restart the remote support service** (`rustdesk.restart`) | Restarts the RustDesk service. Refused while a remote session is open, or when the tray cannot tell whether one is | SYSTEM | signed only | 2 / 30 min | `actions` or `remote` pause |

At most 30 runs an hour per computer in all.

**Every run is recorded.** The tray asks the portal first (`/tray/self-help/begin`), and the portal decides:

- **An unknown tool** is refused.
- **An elevated tool requested with a tray key** is refused: tray keys belong to the standard agent (see *Credentials*).
- **Under containment**, the request is refused (`403 CONTAINED`), and it is still recorded as a *refused* run, so
  the history shows that someone tried.
- **Over the rate limit**, the request is refused (`429`).

The result comes back with a short summary and up to 40 lines of detail. Both are stripped of control characters and
bounded in length.

Each run appears in the computer's **History tab, under Tray**, with the tool, the time, the Windows account, how it
ran and its result. It is audited as `TRAY_SELF_HELP` with the run id, the tool, the outcome and whether it ran
offline. The Windows account and the output are not in the audit log.

**Offline.** Renewing an address is exactly what someone does when the portal cannot be reached. On the signed agent,
an elevated tool may run without the portal if:

- the tray host's last answer from the portal and its last reading of the signed containment pause are each less
  than an hour old;
- neither of them blocked the tool;
- the local rate limits allow it.

The result is queued (at most 20) and reported when the portal is back, marked *offline* in the history. The portal
accepts offline reports only from the signed agent, only from the last 7 days, and at most 20 a day per computer.

## Credentials

| Who | Holds | Can |
|---|---|---|
| **Signed agent's tray** (runs as the user) | **Nothing.** It talks only to the tray host over two pipes | Ask the host for anything on the menu |
| **Tray host** (`rem0te-agent.exe tray-host`, SYSTEM) | The device secret, as the agent always has | Call `/tray/*` for the session's user, and run the elevated tools |
| **Standard agent's tray** (runs as the user) | A **tray key**, in `C:\ProgramData\Rem0te\tray\tray.json` | Call `/tray/*`, and nothing else: status, chat codes, support requests, and the three read-only tools |
| **The chat window** | The `/assist` cookie, for 2 hours | Read and write the one chat it is bound to |

**The signed agent.** The tray host holds a lock in `StateDir\trayhost\host.lock`, so only one host runs at a time.
Every 5 seconds it looks for active Windows sessions. For each one it:

1. checks that the tray file's SHA-256 matches the one the signed install recorded, and refuses to start any other
   file;
2. starts the tray in that session as the signed-in user (`WTSQueryUserToken` + `CreateProcessAsUser`);
3. talks to it over two pipes, set up as in 0.34:
   - first-instance and local-only;
   - with a protected access list naming only SYSTEM and that user;
   - accepted only when the process at the other end is the one the host started;
   - opened with a per-launch nonce.

The **Windows account** the portal is told is the one in the session's token, not anything the tray says. Frames are
size-limited JSON with a closed set of fields per type; anything else closes the pipe.

If a session's tray keeps failing, the host waits 30 seconds before trying again, or 30 minutes after five failures
in ten minutes. The host exits after 12 hours, or when the agent's own file changes, and the next heartbeat starts it
again.

**The standard agent.** The SYSTEM heartbeat pairs the tray:

- It calls `POST /tray/pair` with the device secret. That secret stays where it was, in `heartbeat.dat`, which only
  SYSTEM and Administrators can read.
- The portal mints a tray key, `tk_<24-character id>.<43-character secret>`. It keeps only the id and the secret's
  SHA-256.
- The heartbeat writes the key to `tray.json`, which is readable by local users so that the tray can read it.
- Every pairing replaces the previous key at once. The heartbeat re-pairs when the portal asks, or when the file is
  missing.
- A standard computer's device secret is refused on `/tray/*` (`TRAY_KEY_REQUIRED`). A tray key is refused on a
  signed computer.

**What this means, and why it is not a new way in.** Any local user of a standard computer can read `tray.json`, and
the standard tray reports the Windows account it runs as **without proof**. So on a standard computer, a local user
can chat or file a request **under another local account's name**, and run the three read-only tools. They cannot:

- run an elevated tool, in the API or under the database's `CHECK`;
- reach any route but `/tray/*`;
- act for another computer, since each key names one computer;
- read anything about another business.

What they can do is narrower than what anyone with the business's [support link](support-requests.md) can already
do: ask for help. The difference is that a tray request names the computer. The technician's panel shows the Windows
account as reported by the computer.

On the signed agent, the account comes from the session token and is not taken from the tray.

**Installing.**

- **Standard agent:** the installer downloads `rem0te-tray.exe` from the portal and refuses it unless its SHA-256
  matches the one the portal printed into the script. It places the file in `C:\Program Files\Rem0te\tray\`:
  SYSTEM and Administrators have full control, local users can read and run it. It adds a `Rem0teTray` entry to the
  machine's Run key, so the tray starts at each sign-in with `--standard`.

  Where the file comes from:
  - when an update repository is configured, the portal serves the signed release's `windows/rem0te-tray.exe`;
  - otherwise it serves `apps/api/dist/rem0te-tray.exe`, if one is there;
  - with neither, the installer logs that there is no tray and skips it.

  On the standard agent, the portal is trusted for this file exactly as it is trusted for the script itself. That
  is the standard agent's trust model, not a new one.
- **Signed agent:** `rem0te-tray.exe` is a signed target of the release (`windows/rem0te-tray.exe`, see
  [update-signing.md](update-signing.md)), verified exactly like the agent and installed to the same directory. A
  signed install removes the standard agent's Run entry, so a computer that migrates does not run two trays.

## Containment

| Pause | Effect on the tray |
|---|---|
| `actions` | Flush DNS, Renew IP address and Restart the remote support service are refused and recorded as refused runs. The signed tray host also checks the **signed** pause before running one |
| `remote` | Restarting the remote support service is refused, and new chats can be neither started nor written in (as in [chat.md](chat.md)) |
| Either | Support requests and the read-only tools still work |

## The technician's side

- **Chat tab:** whether each chat is recorded; whether it was started from the tray; and a note on a chat that is
  not recorded.
- **History tab → Tray:** whether the computer has a tray, and of which kind. It lists the self-help runs, offline
  ones marked, and, for someone who works the support queue, the requests sent from the tray.
- **Support requests:** for anyone who can see the computer, a tray request shows its usage table and screenshot.
- **Settings → General → Chat recording.**

## Audit

| Entry | When | Meta |
|---|---|---|
| `TRAY_PAIRED` | A standard computer's tray was given a key | `keyId`, `replaced` |
| `TRAY_SELF_HELP` | A self-help run was recorded (including refused and offline runs) | `runId`, `tool`, `outcome`, `offline` |
| `CHAT_RECORDING_CHANGED` | A business's setting or the platform default changed | `scope`, `before`, `after` |
| `CHAT_STARTED` | Also when the person starts one from the tray | `conversationId`, `recorded`, `by: end_user`, `supportRequestId` |
| `SUPPORT_REQUEST_SUBMITTED` | Also for tray requests | `origin: AGENT`, `endpointId`, `screenshot`, `usage` |
| `ENDPOINT_HEARTBEAT_REJECTED` | A bad tray key or device secret on `/tray/*` | `reason` (`tray_key_unauthenticated` / `tray_unauthenticated`) |

No entry holds message text, request text, the Windows account, a code, a tray key or a device secret.
`e2e-tray.mjs` scans every audit row it caused for all of those.

## Clean-up

The API runs a sweep every hour. It:

- deletes chat codes and `/assist` sessions an hour after they expired;
- deletes self-help runs after 400 days;
- closes a run the agent never reported on as *failed* after an hour.

Set `TRAY_SWEEP=off` to stop it. `scripts/run-e2e.sh` and the browser suite do.

## API

| Route | Authentication | |
|---|---|---|
| `POST /tray/pair` | Device secret, standard computer | Mint (or replace) the tray key |
| `POST /tray/status` | Tray key, or device secret on a signed computer | Business, agent type, the open chat and unread messages, recording, tools and whether each is blocked, containment, the poll interval |
| `POST /tray/chat-code` | Same | A one-time code for `/assist/open` |
| `POST /tray/support-requests` | Same | `{ description, usage?, screenshot? }` |
| `POST /tray/self-help/begin` | Same | `{ tool }` → `{ runId }` |
| `POST /tray/self-help/result` | Same | `{ runId \| offline + tool + ranAt, outcome, summary?, detail? }` |
| `GET /assist/open?c=` | The code | Sets the cookie, 303 to `chat` |
| `GET /assist/chat`, `/assist/assist.js`, `/assist/assist.css` | — | The page |
| `GET /assist/api/state`, `POST /assist/api/{start,messages,receipts,end}` | The `/assist` cookie, plus `x-assist: 1` on writes | The chat |
| `GET /endpoints/:id/tray` | `computers:view` | The tray, self-help runs and tray requests for one computer |
| `GET /chat-recording` | Signed in | The setting for your business and the platform default |
| `PUT /chat-recording` | Business Owner or Platform Admin, fresh sign-in | `{ businessId, recording: true \| false \| null }` |
| `PUT /chat-recording/platform` | Platform Admin, fresh sign-in | `{ recording }` |
| `POST /endpoints/:id/chat/conversations/:cid/ack` | `support:chat` | The panel showed these replies (deletes them in a chat that is not recorded) |
| `GET /support-requests/:id/attachments/:aid` | `support:requests`, and the computer visible | One attachment |

## What has been proven, and what hasn't

| | Evidence |
|---|---|
| Pairing and key replacement; the device secret refused as a tray credential; codes minted, exchanged once, replayed, guessed and expired; cookie flags and page headers; the page holding no secret; technician and user-started chats; recording changes (fresh sign-in, roles, audit) and unrecorded deletion, counted in rows; support requests with usage and a screenshot, attachment visibility and limits; self-help runs, signed-only tools, rates, offline reports and history; containment; A/B isolation; no text, keys, codes or secrets in the audit log | `apps/api/scripts/e2e-tray.mjs` (142 checks), the real API from `dist` on a scratch database, the computer simulated over the real routes |
| The chat page in a browser at the tray window's size and smaller, light and dark: the code leaving the address bar, the cookie, starting, a reply drawn as text, receipts, Enter to send, ending, the used-link page, no console error or CSP violation | `apps/web/scripts/e2e-ui.mjs`, `assistWindow` (Chromium, not WebView2) |
| Catalog, limits, credentials, recording rule, usage and screenshot bounds, status shape | `apps/api/scripts/unit-tray.mjs` |
| Tray protocol, catalog (against the TypeScript and SQL lists), limits, URLs and navigation rule, screenshot encoding, usage clamping, the core (chat, support, self-help, offline queue, signed-only), the pipe server, the signed install placing and recording the tray | `go test ./internal/tray/ ./internal/agent/ ./cmd/rem0te-tray/` |
| Windows build | `GOOS=windows go build ./...` and `go vet` |
| The generated install and heartbeat scripts | Parsed by PowerShell 7's parser |
| Static guarantees | `scripts/check-security-invariants.mjs` §55 (and §45 for the chat changes); each check shown to fail with its guard removed |
| **The tray on a real Windows desktop: the icon, menu, form, WebView2, screenshot, `CreateProcessAsUser`, the pipe access list, `ipconfig` and `ping`, the Run key, Fast User Switching and RDP** | **None. Not run on Windows.** |
