# Server sizing

*Added in 0.33.* How big a server to give Rem0te for 50, 250, 1,000 and 5,000 computers, and why.

Every figure here is labelled:

- **measured** — taken on 2026-11-11 with `apps/api/scripts/bench-heartbeat.mjs` (a load script that starts its
  own API against a scratch database) or by inserting and rolling back synthetic rows in a scratch PostgreSQL 16
  database. The host was a shared 16-core, 8 GB Ubuntu 24.04 machine running other work (load average 4–5), so
  treat measured CPU and latency as *this host under load*, not a lower bound.
- **estimated** — worked out from a measured figure and a cadence in the code, or from RustDesk's documented
  behaviour. Nothing labelled estimated was observed on a real fleet.

Nothing here has been observed on a production fleet of these sizes. The largest measured run was 2,000
synthetic computers.

## The short answer

| Computers | vCPU | RAM | Disk (SSD) | PostgreSQL | Notes |
|---|---|---|---|---|---|
| 50 | 2 | 2 GB | 20 GB | same host, defaults | Anything that runs Ubuntu 22.04 runs this |
| 250 | 2 | 4 GB | 40 GB | same host, `shared_buffers` 512 MB | |
| 1,000 | 4 | 8 GB | 80 GB | same host, `shared_buffers` 2 GB | Heartbeats use about 0.4 of a core |
| 5,000 | 8 | 16 GB | 200 GB | separate host or dedicated cores, `shared_buffers` 4 GB | **At the measured limit of one API process — see below** |

The disk column is for a year of history with room for backups and client downloads; the database part of it is
far smaller (see *Database growth*). Relay bandwidth depends on concurrent remote sessions, not on the number of
computers, and is sized separately.

## Heartbeats: the load that scales with computers

The Windows agent heartbeats every **3 minutes** (`Rem0teHeartbeat` scheduled task). That is the only work every
enrolled computer does all the time.

| Computers | Heartbeats per second (estimated: N ÷ 180) | API CPU for them (estimated from the measured 70 ms each) |
|---|---|---|
| 50 | 0.3 | 2% of one core |
| 250 | 1.4 | 10% of one core |
| 1,000 | 5.6 | 39% of one core |
| 5,000 | 27.8 | 1.9 cores |

Per steady-state heartbeat (nothing due; measured, 1,000–2,000 computers, rounds after warm-up):

| What | Measured |
|---|---|
| API CPU, total | **≈ 70 ms** (60 ms in the Node process including Prisma's query engine, 11 ms in a `sqlite3` child process) |
| PostgreSQL CPU (the backends serving the API) | ≈ 9 ms |
| Database work | ≈ 24 transactions, 23–28 rows read, 4 rows updated, ≈ 0 inserted, 90–190 buffer hits |
| Request / response body | 451 B / 369 B of JSON (plus HTTP and TLS overhead) |
| Latency at 4 in flight | p50 160 ms, p95 290–490 ms |
| Latency at 16 in flight | p50 330–370 ms, p95 680–840 ms |
| **Throughput of one API process** | **18–23 /s at 4 in flight; 34–41 /s at 16 in flight** |
| API memory (RSS) | ≈ 300 MB idle, 350–470 MB under this load |

A heartbeat inserts nothing in steady state: it updates the computer's node, endpoint and live-state rows. The
growth comes from the work it hands out (inventory every 6 hours, update scans every 12 hours) and from people.

### Why 5,000 is at the edge

5,000 computers need 27.8 heartbeats a second, sustained. One API process measured 18–41 a second on this host,
depending on how many arrive at once. So 5,000 computers are inside what one process did, but without headroom —
and after an outage every agent comes back within the same few minutes.

Most of the cost is one thing: **every heartbeat runs a `sqlite3` process** to ask whether hbbs has seen the
computer's RustDesk ID (`peerRegisteredWithHbbs` in `enrollment.service.ts`). As an experiment (a patched build, not
shipped), skipping that lookup took API CPU from ≈ 70 ms to ≈ 42 ms per heartbeat and throughput at 4 in flight from
18–23 /s to 41–49 /s. The query itself is trivial; most of the cost is starting a process for it. Until
that lookup is batched or cached, plan 5,000 computers as "measured to fit, not proven", and watch heartbeat
latency in the API log.

Running two API processes behind the proxy is **not supported**: the stale-device sweep, monitoring sweep,
client-update sweep and audit sealer run inside the API process and would run twice. More cores help PostgreSQL
and the web process, not the API's single event loop.

### First contact and inventory

A computer's first heartbeat and its first inventory (a synthetic 150-application list) cost ≈ 110–125 ms of API
CPU together (**measured**), and the inventory upload took 55–115 ms. The inventory request is ≈ 14 KB of JSON
(**measured** for 150 applications). Enrolling a few hundred computers in an hour is not a sizing concern; a mass
re-install across 5,000 computers is, for the same reason as above.

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

**Nothing in these tables is pruned.** Commands, inventory changes, sessions, alerts and diagnostics accumulate. The
audit log *cannot* be pruned in place: rows are sealed into a hash chain and a trigger refuses changes (see
[containment.md](containment.md)); deleting rows is detected as tampering. Plan disk for history, not for a
steady state.

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
computer. Your rates will differ: a fleet with heavy software churn, frequent diagnostics or many sessions grows
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

It creates synthetic computers with bound device secrets and a scratch hbbs peer database (so the `sqlite3` lookup
runs as it would in production, without touching the real one), warms them up with one inventory each, measures
steady-state heartbeats, prints table sizes, and removes its fixtures. It needs `sqlite3` installed.
