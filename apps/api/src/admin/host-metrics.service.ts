import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import * as fs from 'fs';
import * as os from 'os';

/**
 * Live host metrics: network throughput, CPU utilisation, and how many
 * RustDesk sessions are actually moving traffic through this server.
 *
 * Everything here is read from `/proc`, with no subprocess and no privilege.
 * That is deliberate — the API already has fixed-command sudo grants for a
 * couple of operations and this needed none of them, so it gets none.
 *
 * ## Why a sampler rather than a read
 *
 * Throughput and CPU utilisation are both *rates*: `/proc/net/dev` and
 * `/proc/stat` hold monotonic counters, and a single read of a counter tells
 * you nothing about the current rate. A request-time "read twice 200 ms apart"
 * would make every dashboard poll sleep, and would still report a 200 ms
 * window as though it meant something. So a timer samples on a fixed interval
 * and each request reads the last computed rate plus a short history for a
 * sparkline.
 *
 * `os.loadavg()` is NOT a substitute for CPU utilisation. Load average counts
 * runnable *and* uninterruptible-sleep tasks, so a box blocked on disk shows a
 * load of 8 at 2% CPU; and it is scaled by core count, so the same number means
 * different things on different hosts. Both are reported: utilisation because
 * it answers "how busy is this", load average because it answers "is anything
 * queueing".
 */

/** How often counters are sampled. 2s is responsive without being noisy. */
const SAMPLE_MS = 2000;

/** Samples retained for the sparkline — 30 at 2s is a one-minute window. */
const HISTORY = 30;

/**
 * The RustDesk relay port. A relayed session holds a connection from each
 * side, so established connections here come in pairs — which is what makes
 * "sessions in use" countable at all.
 */
const RELAY_PORT = 21117;

/** TCP_ESTABLISHED, as /proc/net/tcp spells it. */
const TCP_ESTABLISHED = '01';

interface NetCounters { rx: number; tx: number; at: number }
interface CpuCounters { idle: number; total: number }

@Injectable()
export class HostMetricsService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(HostMetricsService.name);
  private timer: ReturnType<typeof setInterval> | null = null;

  private lastNet: NetCounters | null = null;
  private lastCpu: CpuCounters | null = null;

  private rxBps = 0;
  private txBps = 0;
  private cpuPercent = 0;
  private history: { rx: number; tx: number; cpu: number }[] = [];

  onModuleInit() {
    // Prime the counters so the first sample a second later is a real rate
    // rather than a spike measured from process start.
    this.lastNet = this.readNet();
    this.lastCpu = this.readCpu();
    this.timer = setInterval(() => {
      try {
        this.sample();
      } catch (e) {
        // A metrics sampler must never take the API down. /proc is stable on
        // Linux, but this also runs in whatever container someone else builds.
        this.logger.warn(`Host metrics sample failed: ${String(e)}`);
      }
    }, SAMPLE_MS);
    // Do not hold the event loop open on shutdown.
    this.timer.unref?.();
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  private sample() {
    const net = this.readNet();
    if (net && this.lastNet) {
      const dt = (net.at - this.lastNet.at) / 1000;
      if (dt > 0) {
        // Counters are 32-bit on some kernels and wrap. A negative delta is a
        // wrap, not negative traffic: report zero for that interval rather
        // than a wildly negative rate.
        this.rxBps = Math.max(0, (net.rx - this.lastNet.rx) / dt);
        this.txBps = Math.max(0, (net.tx - this.lastNet.tx) / dt);
      }
    }
    if (net) this.lastNet = net;

    const cpu = this.readCpu();
    if (cpu && this.lastCpu) {
      const dTotal = cpu.total - this.lastCpu.total;
      const dIdle = cpu.idle - this.lastCpu.idle;
      if (dTotal > 0) {
        this.cpuPercent = Math.min(100, Math.max(0, ((dTotal - dIdle) / dTotal) * 100));
      }
    }
    if (cpu) this.lastCpu = cpu;

    this.history.push({ rx: this.rxBps, tx: this.txBps, cpu: this.cpuPercent });
    if (this.history.length > HISTORY) this.history.shift();
  }

  /**
   * Summed receive/transmit bytes across real interfaces.
   *
   * Loopback is excluded: the API talks to Postgres, Redis and the web process
   * over it, so including `lo` would report Rem0te's own internal chatter as
   * customer traffic — on a quiet server that is most of the graph. Bridges and
   * veth pairs are excluded for the same reason, since a container host would
   * otherwise count every packet twice.
   */
  private readNet(): NetCounters | null {
    let raw: string;
    try {
      raw = fs.readFileSync('/proc/net/dev', 'utf8');
    } catch {
      return null;
    }
    let rx = 0, tx = 0;
    for (const line of raw.split('\n').slice(2)) {
      const [namePart, rest] = line.split(':');
      if (!rest) continue;
      const name = namePart.trim();
      if (!name || name === 'lo') continue;
      if (/^(docker|br-|veth|virbr|tap|tun)/.test(name)) continue;
      const f = rest.trim().split(/\s+/);
      rx += Number(f[0]) || 0;
      tx += Number(f[8]) || 0;
    }
    return { rx, tx, at: Date.now() };
  }

  /** Aggregate jiffies from the summary `cpu` line of /proc/stat. */
  private readCpu(): CpuCounters | null {
    let raw: string;
    try {
      raw = fs.readFileSync('/proc/stat', 'utf8');
    } catch {
      return null;
    }
    const line = raw.split('\n').find((l) => l.startsWith('cpu '));
    if (!line) return null;
    const f = line.trim().split(/\s+/).slice(1).map((n) => Number(n) || 0);
    // user nice system idle iowait irq softirq steal …
    const idle = (f[3] ?? 0) + (f[4] ?? 0);
    const total = f.reduce((a, b) => a + b, 0);
    return { idle, total };
  }

  /**
   * RustDesk sessions currently relayed through this server.
   *
   * Counted from established TCP connections on the relay port. A relayed
   * session is two peers each holding one connection, so the session count is
   * the pair count — which is what makes this answerable at all without a
   * protocol Rem0te does not speak.
   *
   * **This undercounts by design, and the UI has to say so.** RustDesk prefers
   * a direct peer-to-peer connection and only falls back to the relay when
   * hole-punching fails. A session that went direct carries no traffic through
   * here and cannot be seen from this host at all — Rem0te hands out a
   * credential and never touches the session again. So this is "sessions using
   * the relay", not "sessions in progress", and calling it the latter would be
   * a number that quietly reads low.
   */
  private readRelay(): { connections: number; sessions: number } {
    const hex = RELAY_PORT.toString(16).toUpperCase().padStart(4, '0');
    let connections = 0;
    for (const f of ['/proc/net/tcp', '/proc/net/tcp6']) {
      let raw: string;
      try {
        raw = fs.readFileSync(f, 'utf8');
      } catch {
        continue;
      }
      for (const line of raw.split('\n').slice(1)) {
        const c = line.trim().split(/\s+/);
        if (c.length < 4) continue;
        // local_address is host:port in hex; state is the 4th column.
        const localPort = c[1]?.split(':')[1];
        if (localPort === hex && c[3] === TCP_ESTABLISHED) connections += 1;
      }
    }
    return { connections, sessions: Math.floor(connections / 2) };
  }

  /** Everything the dashboard needs, as of the last sample. */
  snapshot() {
    const relay = this.readRelay();
    return {
      cpu: {
        percent: Math.round(this.cpuPercent),
        cores: os.cpus().length,
        loadAvg: os.loadavg() as [number, number, number],
      },
      network: {
        rxBytesPerSec: Math.round(this.rxBps),
        txBytesPerSec: Math.round(this.txBps),
        // Oldest first, so a sparkline can be drawn straight from it.
        history: this.history.map((h) => ({
          rx: Math.round(h.rx),
          tx: Math.round(h.tx),
          cpu: Math.round(h.cpu),
        })),
        sampleSeconds: SAMPLE_MS / 1000,
      },
      relay: {
        port: RELAY_PORT,
        connections: relay.connections,
        sessions: relay.sessions,
      },
    };
  }
}
