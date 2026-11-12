# Server sizing

*Added in 0.33; heartbeat figures re-measured in 0.34.* How big a server to give Rem0te for 50, 250, 1,000 and 5,000 computers, and why.

Every figure here is labelled:

- **measured** — taken on 2026-11-11 with `apps/api/scripts/bench-heartbeat.mjs` (a load script that starts its
  own API against a scratch database) or by inserting and rolling back synthetic rows in a scratch PostgreSQL 16
  database. The host was a shared 16-core, 8 GB Ubuntu 24.04 machine running other work (load average 4–5 in
  0.33, 3–17 during the 0.34 runs), so treat measured CPU and latency as *this host under load*, not a lower bound.
- **estimated** — worked out from a measured figure and a cadence in the code, or from RustDesk's documented
  behaviour. Nothing labelled estimated was observed on a real fleet.

Nothing here has been observed on a production fleet of these sizes. The largest measured run was 5,000
synthetic computers (0.34).

## The short answer

| Computers | vCPU | RAM | Disk (SSD) | PostgreSQL | Notes |
|---|---|---|---|---|---|
| 50 | 2 | 2 GB | 20 GB | same host, defaults | Anything that runs Ubuntu 22.04 runs this |
| 250 | 2 | 4 GB | 40 GB | same host, `shared_buffers` 512 MB | |
| 1,000 | 4 | 8 GB | 80 GB | same host, `shared_buffers` 2 GB | Heartbeats use about 0.2 of a core |
| 5,000 | 8 | 16 GB | 200 GB | separate host or dedicated cores, `shared_buffers` 4 GB | One API process measured 49–72 heartbeats/s against the 27.8 needed — see below |

The disk column is for a year of history with room for backups and client downloads; the database part of it is
far smaller (see *Database growth*). Relay bandwidth depends on concurrent remote sessions, not on the number of
computers, and is sized separately.

## Heartbeats: the load that scales with computers

The Windows agent heartbeats every **3 minutes** (`Rem0teHeartbeat` scheduled task). That is the only work every
enrolled computer does all the time.

| Computers | Heartbeats per second (estimated: N ÷ 180) | API CPU for them (estimated from the measured ≈ 35 ms each; ≈ 50 ms at 5,000) |
|---|---|---|
| 50 | 0.3 | 1% of one core |
| 250 | 1.4 | 5% of one core |
| 1,000 | 5.6 | 20% of one core |
| 5,000 | 27.8 | 1.4 cores |

Per steady-state heartbeat (nothing due; measured in 0.34, 1,000 computers, rounds after warm-up, load average
3–11; 0.33's figures in brackets):

| What | Measured |
|---|---|
| API CPU, total | **≈ 35–39 ms** [≈ 70 ms]; 61–71 ms in one run at load average 10. All of it in the Node process, including Prisma's query engine: no `sqlite3` child per heartbeat since 0.34 (see below) |
| PostgreSQL CPU (the backends serving the API) | ≈ 7–9 ms [≈ 9 ms] |
| Database work | ≈ 24–27 transactions, 4 rows updated, ≈ 0 inserted [unchanged] |
| Request / response body | 451 B / 369 B of JSON (plus HTTP and TLS overhead) |
| Latency at 4 in flight | p50 45–50 ms, p95 55–140 ms [p50 160 ms, p95 290–490 ms] |
| Latency at 16 in flight | p50 113–126 ms, p95 150–255 ms [p50 330–370 ms, p95 680–840 ms] |
| **Throughput of one API process** | **61–83 /s at 4 in flight; 109–136 /s at 16 in flight** (61–71 /s in the run at load average 10) [18–23 /s; 34–41 /s] |
| API memory (RSS) | ≈ 300 MB idle, 415–510 MB under this load |

At 5,000 computers (measured, 16 in flight, two rounds, load average 6–7): **49–72 heartbeats a second at 46–51 ms
of API CPU each**, p50 190–245 ms, RSS ≈ 575 MB. The 0.33 build on the same host and fleet, immediately after (load
average 11–15): 26–34 a second at 84–118 ms.

A heartbeat inserts nothing in steady state: it updates the computer's node, endpoint and live-state rows. The
growth comes from the work it hands out (inventory every 6 hours, update scans every 12 hours) and from people.

### 5,000 computers on one API process

5,000 computers need 27.8 heartbeats a second, sustained. In 0.33 one API process measured 18–41 a second, which
fit without headroom. Most of that cost was one thing: **every heartbeat ran a `sqlite3` process** to ask hbbs's
peer table whether the computer's RustDesk ID had ever registered (`peerRegisteredWithHbbs`). The query was
trivial; starting a process for it was not, and it cost the Node process as much again as the child.

Since 0.34 one `sqlite3` reads the whole peer table at most once every `HBBS_PEER_CACHE_SECONDS` (default 10,
clamped to 1–30) and every heartbeat in between answers from memory — one process per 10 seconds instead of 28 a
second. The answer cannot be staler than that window; an unreadable database still answers *unknown* (see
[architecture.md](architecture.md)). Measured at 5,000 computers, one process did 49–72 heartbeats a second: 1.8–2.6×
what 5,000 need, on a host that was busy with other work.

That headroom is for the steady state. After an outage every agent comes back within the same few minutes, and a
computer's first heartbeat with its inventory costs ≈ 77 ms of API CPU (**measured** at 5,000 in 0.34), so a fleet
reconnecting at once is still worth watching: heartbeat latency is in the API log. More than 5,000 has not been
measured.

Running two API processes behind the proxy is **not supported**: the stale-device sweep, monitoring sweep,
client-update sweep and audit sealer run inside the API process and would run twice. More cores help PostgreSQL
and the web process, not the API's single event loop.

### First contact and inventory

A computer's first heartbeat and its first inventory (a synthetic 150-application list) cost ≈ 110–125 ms of API
CPU together in 0.33 and ≈ 77 ms in 0.34 at 5,000 computers (**measured**), and the inventory upload took 55–125 ms. The inventory request is ≈ 14 KB of JSON
(**measured** for 150 applications). Enrolling a few hundred computers in an hour is not a sizing concern; a mass
re-install across 5,000 computers is, for the same reason as above.


### Chat (0.34)

Chat adds almost nothing per computer. A heartbeat from a signed agent that can chat makes one more indexed lookup:
is a chat open here? It uses the partial unique index on open conversations. Other computers do no extra work.

An **open** chat adds a long-poll: one request every 25 s or less while the window is up, each a few indexed
queries. While the poll is held the API keeps a timer and re-reads the database every 10 s; it holds no database
connection. Fifty chats open at once come to about two requests a second, small next to 27.8 heartbeats a second at
5,000 computers. `CHAT_MAX_WAITERS` (default 500) caps how many polls are held at once; past it, polls are answered at
once and the agent backs off. The held polls live in the API process, which is one more reason it runs as a single
process. These are **estimates** from the code path; chat has not been load-tested
([chat.md](chat.md#capacity)).

## Database growth

Measured on-disk cost per row, **heap plus every index**, from 20,000 synthetic rows per table shaped like what the
services write (5,000 for diagnostics), inserted and rolled back in one transaction:

| Table | What a row is | Bytes per row (measured) |
|---|---|---|
| `Endpoint` | one per computer | 531 |
| `RustdeskNode` | one per computer | 634 |
| `EndpointEnrollment` | one per computer | 274 |
| `EndpointInventory` | one per computer, overwritten each pass; 150 applications | 4,266 (of which the software list ≈ 2,600) |
| `EndpointCommand` | an inventory, update-scan, event-log or diagnostic instruction | 472 |
| `EndpointChange` | one inventory difference (software version, disk, …) | 196 |
| `ActivityLog` | one audit entry (browser user agent, ~100 B of metadata) | 551, plus ≈ 209 once sealed (**estimated** from the sealer's three fields) |
| `MonitorAlert` | one alert | 466 |
| `MonitorAlertEvent` | raised / notified / acknowledged / resolved | 174 |
| `SupportSession` | one remote session | 369 |
| `SupportSessionEvent` | one session state change | 209 |
| `DiagnosticRun` | one diagnostic with a 4 KB result (results are capped at 32 KB) | 4,491 |

**From 0.34 these tables are pruned** by the retention sweep ([data-retention.md](data-retention.md)): finished
commands and diagnostics after 90 days, inventory changes and resolved alerts after 400, unused tokens after 30 days
past expiry; session rows are kept and only their events' detail is trimmed after 400 days. Before 0.34 nothing here
was pruned. The audit log *cannot* be pruned in place: rows are sealed into a hash chain and a trigger refuses
changes (see [containment.md](containment.md)); deleting rows is detected as tampering. It is the one table that
keeps growing.

### What grows, and how fast (estimated)

| Source | Rate assumed | Per computer per year |
|---|---|---|
| Automatic collections (`EndpointCommand`) | 4 inventories + 2 update scans a day (the 6 h / 12 h cadences in `endpoint-inventory.service.ts`) | ≈ 1.0 MB |
| Inventory changes (`EndpointChange`) | 2 a day (software updates) | ≈ 0.15 MB |
| Remote sessions | 2 a month, each 1 session + ~6 events + ~4 audit entries | ≈ 0.11 MB |
| Monitor alerts | 2 a month, each 1 alert + 3 events | ≈ 0.02 MB |
| Diagnostics | 1 a month at 4 KB | ≈ 0.05 MB |
| **Total** | | **≈ 1.3 MB per computer per year** |

So roughly: 50 computers ≈ 70 MB a year, 250 ≈ 330 MB, 1,000 ≈ 1.3 GB, 5,000 ≈ 6.5 GB, plus the fixed ≈ 6 KB per
computer. That is the rate *without* retention (every release before 0.34). With the 0.34 defaults the
history levels off (**estimated** from the rates above and the windows): commands at 90 days' worth (≈ 0.25 MB per
computer), changes at 400 days' (≈ 0.16 MB), alerts and diagnostics at a few tens of KB, so a computer's pruned
history settles at about **0.45 MB** after its first year. Remote sessions and their audit entries (≈ 0.11 MB a
year) are kept, and grow, as does every other audit entry. See [data-retention.md](data-retention.md) for the windows and how to change them. Your rates will differ: a fleet with heavy software churn, frequent diagnostics or many sessions grows
faster. Measure your own with:

```sql
SELECT relname, n_live_tup, pg_size_pretty(pg_total_relation_size(relid))
FROM pg_stat_user_tables ORDER BY pg_total_relation_size(relid) DESC LIMIT 15;
```

### The 0.32 additions that grow with time

| Feature | What it writes | Growth |
|---|---|---|
| Audit chain (0.28) | every audit row gains its hash and sealed references; an `AuditCheckpoint` every 15 minutes | ≈ 0.2 KB more per audit row; checkpoints ≈ 35,000 a year, a few MB |
| Monitor alerts | `MonitorAlert` + `MonitorAlertEvent`; one open alert per problem (partial unique index), so a problem that persists counts occurrences on its open alert rather than adding rows | ≈ 1 KB per alert with its events |
| Scheduled client updates | one `CLIENT_UPDATE_AUTO_QUEUED` audit entry per computer each time a policy queues an update | ≈ 0.76 KB × computers per client release |
| Report exports | one `REPORT_EXPORTED` audit entry per CSV; the CSV itself is streamed and not stored | ≈ 0.76 KB per export |
| Metric history | **does not exist.** CPU, memory and disk are latest values on the computer's row, overwritten each heartbeat | none |
| Chat (0.34) | `ChatConversation` + `ChatMessage`; two audit rows per chat (start, end) and one per prune pass that deleted anything | ≈ 0.3 KB per message plus the text; deleted 400 days after the chat ends |

## PostgreSQL

- **Connections.** Prisma's pool defaults to `2 × CPU cores + 1` per process. The bench opened 7 backends at 4
  requests in flight and 22 at 16 (**measured**). PostgreSQL's default `max_connections` of 100 is enough for one API,
  the web process and maintenance at every size here; add `?connection_limit=` to `DATABASE_URL` only if the
  database is shared.
- **Memory.** `shared_buffers` at about 25% of RAM on a dedicated database host, or 512 MB – 2 GB on a shared one.
  The whole working set at 5,000 computers (the per-computer rows, about 30 MB, plus recent history) fits in memory.
- **Write load.** ≈ 24 commits and 4 row updates per heartbeat (**measured**): ≈ 670 commits a second at 5,000
  computers. Those updates rewrite the same rows over and over, so leave autovacuum on; the rows a heartbeat updates
  are small. Put the database on SSD.
- **Backups** grow with the history above. `pg_dump` of a 1,000-computer, one-year database is in the low gigabytes
  (**estimated**).

## RustDesk: hbbs and hbbr

The ID server (hbbs) and relay (hbbr) are separate programs; Rem0te only reads hbbs's database.

- **hbbs** handles registration and hole-punching. Each RustDesk client re-registers every few seconds and is
  treated as online for 30 s after its last registration (`REG_TIMEOUT`; **estimated**, not measured here — this
  page's measurements never contacted a real hbbs). The traffic is small UDP packets: for 5,000 clients, on the order
  of a few hundred packets a second and well under 1 Mbit/s (**estimated**). hbbs CPU and memory are negligible next
  to the API at every size here.
- **hbbr** carries a session only when the two ends cannot connect directly. Its bandwidth is **per concurrent
  relayed session**, not per computer: an office desktop session is typically a few hundred kbit/s to 2 Mbit/s, and
  full-screen video or high resolution several times that (**estimated**, from RustDesk's codec behaviour). Size the
  uplink as *peak concurrent technicians × relayed share × 2 Mbit/s*, with headroom. Ten technicians fully relayed
  is ≈ 20 Mbit/s.
- **The API's own traffic** is small: ≈ 1.5 KB per heartbeat on the wire (**estimated**: the measured 820 B of JSON
  plus headers and TLS), ≈ 0.35 Mbit/s at 5,000 computers, plus ≈ 14 KB per inventory every 6 hours. Client
  downloads (the RustDesk installer, tens of MB each) dominate during a rollout.

## Re-measuring

The numbers above come from a script you can run against your own hardware — on a **scratch** database, never
production (it refuses a database whose name lacks `scratch` or `test`, and ports 3000/3001/443/4000/4001):

```bash
cd apps/api && npx nest build
DATABASE_URL=postgresql://…/rem0te_bench_test \
  BENCH_ENDPOINTS=1000 BENCH_ROUNDS=3 BENCH_CONCURRENCY=4 \
  node scripts/bench-heartbeat.mjs
```

It creates synthetic computers with bound device secrets and a scratch hbbs peer database (so the shared `sqlite3`
peer read runs as it would in production, without touching the real one), warms them up with one inventory each, measures
steady-state heartbeats, prints table sizes, and removes its fixtures. It needs `sqlite3` installed.
