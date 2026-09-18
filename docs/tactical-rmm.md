# Tactical RMM

Connecting to a computer, and reading what Rem0te knows about it, from inside
Tactical RMM.

---

## What is actually possible

Worth stating plainly, because it shapes everything below: **Tactical RMM has no
way to consume a REST API.** There is no screen where you paste an API URL or an
OpenAPI document and have TRMM render someone else's data. Its extension points
for a third-party tool are:

| Mechanism | What it does |
|---|---|
| **URL Action** | Right-click an agent → *Run URL Action* → opens a URL you templated with that agent's details |
| **Script** | Runs on the agent, or against it; can call any HTTP API you like |
| **Collector Task** | A scheduled script whose **last line of output** TRMM saves into a custom field |
| **Alert action** | Runs a script when an alert fires |

So "adding Rem0te to TRMM" means giving TRMM the right URLs to open and the
right scripts to run. All four are set up below and none requires a change to
Tactical RMM itself.

---

## 1. Connect from TRMM — the URL Action

**Settings → Global Settings → URL Actions → Add**

| Field | Value |
|---|---|
| Name | `Connect with Rem0te` |
| Description | `Open a remote session via Rem0te` |
| URL Pattern | see below |

```
https://<your-rem0te-host>/trmm?host={{agent.hostname}}&client={{client.name}}&site={{site.name}}&agent={{agent.agent_id}}
```

Right-click any agent → **Run URL Action** → *Connect with Rem0te*.

A second action that opens the computer's page instead of connecting — specs,
pending Windows updates, event log — is the same URL with `&action=open`:

```
https://<your-rem0te-host>/trmm?host={{agent.hostname}}&client={{client.name}}&site={{site.name}}&agent={{agent.agent_id}}&action=open
```

You can make either one the **double-click** action for an agent under
*Preferences*.

> **Everything between `{{ }}` is case sensitive** in Tactical RMM, including
> `{{client.name}}`. A mistyped variable is sent through as literal text, which
> arrives here as a hostname that matches nothing.

### There is no API key in that URL, deliberately

A URL Action opens in the technician's own browser, so it authenticates as
**them**, with their existing Rem0te session, scoped to the computers they can
already see. Someone who cannot reach a machine in Rem0te cannot reach it from
TRMM either.

That is why no key appears in the template. A URL Action is stored in TRMM's
global settings, lands in browser history, and is visible to every TRMM
operator who can right-click an agent — which is the wrong place for a
credential. If the technician is not signed in, Rem0te asks them to, then
carries on.

---

## 2. How a TRMM agent is matched to a Rem0te computer

In this order, stopping at the first exact answer:

1. **The recorded TRMM agent id.** Stored as an endpoint alias (`trmm:<id>`).
   The only match that cannot be wrong.
2. **Hostname, narrowed by client name.** Business names are compared loosely —
   case, punctuation and company suffixes are ignored, so *Harbor Logistics* in
   TRMM matches *Harbor Logistics Ltd* in Rem0te.
3. **Hostname alone**, when exactly one computer answers to it.

**Hostnames collide.** Two customers each with a `SERVER01` is not an edge case,
and connecting a technician to the wrong customer's machine is the worst thing
this could do — so when more than one computer matches, Rem0te shows a short
list and asks. It never picks a "closest" match.

Choosing from that list **records the mapping**: the TRMM agent id is stored
against that computer, and every later launch from TRMM goes straight through.
The integration gets more reliable the more it is used, and the mapping moves
rather than duplicating if an agent is later rebuilt onto different hardware.

Recording it needs `computers:edit`. Without that capability the connection
still works; it just asks again next time.

---

## 3. Show the RustDesk ID inside TRMM — the Collector Task

If you want the ID visible on the agent's own page in TRMM, and simpler URL
Actions like `{{agent.Rem0te ID}}`, use a **Collector Task**. TRMM saves the
last line a script prints into a custom field.

**Settings → Global Settings → Custom Fields → Agent → Add:** name `Rem0te ID`,
type *Text*.

**Settings → Script Manager → New**, Windows/PowerShell, and paste:

```powershell
# Rem0te ID collector for Tactical RMM.
# Prints this machine's RustDesk ID as its last line, for a Collector Task.
$ErrorActionPreference = 'SilentlyContinue'
$id = ''
$rd = 'C:\Program Files\RustDesk\rustdesk.exe'
if (Test-Path $rd) {
    $out = & $rd --get-id 2>$null | Out-String
    if ($out -match '([0-9]{6,15})') { $id = $Matches[1] }
}
if (-not $id) {
    foreach ($p in @("$env:ProgramData\RustDesk\config\RustDesk.toml",
                     "$env:APPDATA\RustDesk\config\RustDesk.toml")) {
        if (Test-Path $p) {
            $c = Get-Content $p -Raw
            if ($c -match "id\s*=\s*'?`"?([0-9]{6,15})") { $id = $Matches[1]; break }
        }
    }
}
Write-Output $id
```

Then **Automation Manager → Add Task → Collector Task**, pointing at that script
and the `Rem0te ID` custom field.

### Why this is not Rem0te pushing to TRMM's API

It would be reasonable to expect Rem0te to write that field over TRMM's API.
Two reasons it does not:

- **TRMM does not document an API endpoint for setting custom field values.**
  Collector Tasks are the documented mechanism. Building on an undocumented
  endpoint means an integration that breaks on somebody else's upgrade, in a
  way that looks like Rem0te's fault.
- **It would mean Rem0te storing an API key for your RMM.** A TRMM API key
  inherits its user's full permissions and bypasses 2FA. Holding one — to reach
  across the network and write a field that the endpoint can print locally for
  free — is a large amount of custody for a small amount of convenience.

The machine already knows its own RustDesk ID. Asking it is cheaper and safer
than asking your RMM's API for permission to write it down.

---

## 4. Query Rem0te from a TRMM script

For anything beyond a launch — checking enrolment, listing what Rem0te holds for
a customer — use the public API with a scoped API key. This is the one place a
key is appropriate, because it lives in TRMM's **Global Keystore** rather than
in a URL.

**Settings → Global Settings → Key Store → Add:** name `REM0TE_KEY`, value = a
Rem0te API key (Settings → API Keys). Then in a script, pass
`{{global.REM0TE_KEY}}` as an argument:

```powershell
param([string]$Key, [string]$Host = 'your-rem0te-host')
$h = @{ 'X-API-Key' = $Key }
$me = Invoke-RestMethod -Uri "https://$Host/pub/v1/whoami" -Headers $h
Write-Output "Rem0te business: $($me.businessId)"
```

Scopes, request and response shapes and error codes are in
[PUBLIC-API.md](PUBLIC-API.md). Keys are scoped to one business and can do
nothing outside it.

---

## Troubleshooting

**"No computer matched"** — the hostname TRMM sent is not one Rem0te knows, or
not one you have access to. Rem0te matches on hostname, display name and alias;
check the machine is enrolled and the names agree.

**"More than one computer matches"** — working as intended. Pick one; it is
recorded and will not ask again.

**The URL Action opens a login page** — expected the first time in a browser
that has no Rem0te session. Sign in; it continues to the computer.

**The variable arrives as literal `{{agent.hostname}}`** — a typo in the URL
pattern, or the wrong case. TRMM does not warn about this.

---

## See also

- [inventory.md](inventory.md) — what the computer's page shows once you land on it
- [PUBLIC-API.md](PUBLIC-API.md) — the API guide, for scripts
- [clients.md](clients.md) — deploying the Rem0te agent, which TRMM can also do
  as an ordinary script
