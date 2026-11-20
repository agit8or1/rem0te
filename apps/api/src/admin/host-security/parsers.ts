/**
 * Server security (0.74): the parsers behind Admin → Security.
 *
 * Pure: no imports, no I/O. Each takes the text a command printed or a file
 * held and returns what it says, or null when it cannot tell. "Cannot tell"
 * is never turned into "fine" here or anywhere above (posture.ts); the
 * page shows it as Unknown. Unit proof: apps/api/scripts/unit-host-security.mjs,
 * against fixtures copied from a real Ubuntu 24.04 host.
 */

// ── sshd_config ─────────────────────────────────────────────────────────────

/** The directives the page reports on, lower-cased as sshd compares them. */
export const SSHD_KEYS = [
  'permitrootlogin', 'passwordauthentication', 'kbdinteractiveauthentication', 'permitemptypasswords',
  'pubkeyauthentication', 'x11forwarding', 'maxauthtries', 'port',
] as const;
export type SshdKey = (typeof SSHD_KEYS)[number];

/** OpenSSH 9.x's compiled-in defaults, used only when no readable file sets the directive. */
export const SSHD_DEFAULTS: Record<SshdKey, string> = {
  permitrootlogin: 'prohibit-password', passwordauthentication: 'yes', kbdinteractiveauthentication: 'yes',
  permitemptypasswords: 'no', pubkeyauthentication: 'yes', x11forwarding: 'no', maxauthtries: '6', port: '22',
};

export interface SshdValue {
  value: string;
  /** The file that set it, or 'default'. */
  source: string;
  /**
   * True when a file sshd reads before the one that set it (or before the
   * end, for a default) could not be read: it may set the directive first,
   * and sshd keeps the first value it sees.
   */
  uncertain: boolean;
}
export interface SshdConfig { values: Record<SshdKey, SshdValue>; unreadable: string[]; files: string[] }

export interface ConfigFile { path: string; text: string | null }

/**
 * sshd's effective global settings from its configuration files, the way
 * sshd reads them: first value wins, `Include` is expanded in place (the
 * caller supplies the files a pattern names, sorted, as sshd sorts its
 * glob), and a `Match` block applies only to some connections, so nothing
 * after a `Match` in a file is global.
 *
 * `sshd -T` would be exact but needs root (it reads the host keys), which the
 * service user is not; this is the fallback, and it says when it is unsure.
 */
export function parseSshdConfig(main: ConfigFile, include: (pattern: string) => ConfigFile[]): SshdConfig | null {
  if (main.text === null) return null;
  const values: Partial<Record<SshdKey, SshdValue>> = {};
  const unreadable: string[] = [];
  const files: string[] = [];
  const keys = new Set<string>(SSHD_KEYS);
  const seen = new Set<string>();
  const walk = (f: ConfigFile, depth: number) => {
    if (depth > 8 || seen.has(f.path)) return;
    seen.add(f.path);
    files.push(f.path);
    if (f.text === null) { unreadable.push(f.path); return; }
    for (const raw of f.text.split(/\r?\n/)) {
      const line = raw.replace(/#.*$/, '').trim();
      if (!line) continue;
      const m = /^([A-Za-z0-9]+)(?:\s*=\s*|\s+)(.*)$/.exec(line);
      if (!m) continue;
      const key = m[1].toLowerCase();
      const value = m[2].trim().replace(/^"(.*)"$/, '$1');
      if (key === 'match') return;                   // the rest of this file is conditional
      if (key === 'include') {
        for (const pattern of value.split(/\s+/).filter(Boolean)) for (const inc of include(pattern)) walk(inc, depth + 1);
        continue;
      }
      if (!keys.has(key) || values[key as SshdKey]) continue;
      values[key as SshdKey] = { value: value.toLowerCase(), source: f.path, uncertain: unreadable.length > 0 };
    }
  };
  walk(main, 0);
  const out = {} as Record<SshdKey, SshdValue>;
  for (const k of SSHD_KEYS) out[k] = values[k] ?? { value: SSHD_DEFAULTS[k], source: 'default', uncertain: unreadable.length > 0 };
  return { values: out, unreadable, files };
}

// ── Firewall ────────────────────────────────────────────────────────────────

/** /etc/ufw/ufw.conf's ENABLED, or null when the file is missing or says neither. */
export function parseUfwConf(text: string | null): boolean | null {
  if (text === null) return null;
  const m = /^\s*ENABLED\s*=\s*"?(yes|no)"?\s*$/im.exec(text);
  return m ? m[1].toLowerCase() === 'yes' : null;
}

// ── Listening sockets (`ss -Htlnu`) ─────────────────────────────────────────

export interface Listener { proto: 'tcp' | 'udp'; address: string; port: number; loopback: boolean }

/** `ss -Htlnu`: one socket per line, `tcp LISTEN 0 511 127.0.0.1:3000 0.0.0.0:*`. */
export function parseSsListeners(stdout: string): Listener[] | null {
  const out: Listener[] = [];
  for (const raw of stdout.split('\n')) {
    const cols = raw.trim().split(/\s+/);
    if (cols.length < 5) continue;
    const proto = cols[0] === 'tcp' ? 'tcp' : cols[0] === 'udp' ? 'udp' : null;
    if (!proto) continue;
    const local = cols[4];
    const i = local.lastIndexOf(':');
    if (i < 1) continue;
    const port = Number(local.slice(i + 1));
    if (!Number.isInteger(port)) continue;
    let address = local.slice(0, i).replace(/^\[|\]$/g, '');
    address = address.replace(/^\[/, '').replace(/\]$/, '');
    const host = address.split('%')[0];
    const loopback = /^127\./.test(host) || host === '::1';
    out.push({ proto, address, port, loopback });
  }
  if (!out.length && stdout.trim()) return null;
  return out;
}

/**
 * What this server is expected to expose to the network: SSH, Caddy (80/443,
 * and 443/udp for HTTP/3) and the RustDesk server (21115–21119/tcp, 21116/udp).
 * A DHCP client bound to one interface (`192.0.2.5%eth0:68`) is the host's
 * own lease, not a service.
 */
export const EXPECTED_PUBLIC = {
  tcp: [22, 80, 443, 21115, 21116, 21117, 21118, 21119],
  udp: [443, 21116],
} as const;

export function unexpectedListeners(ls: Listener[]): Listener[] {
  return ls.filter((l) => {
    if (l.loopback) return false;
    if (l.proto === 'udp' && l.port === 68 && l.address.includes('%')) return false;
    return !(EXPECTED_PUBLIC[l.proto] as readonly number[]).includes(l.port);
  });
}

// ── apt ─────────────────────────────────────────────────────────────────────

export interface AptPackage { name: string; suites: string[]; version: string; from: string | null; security: boolean }

/**
 * `apt list --upgradable`:
 *   `libc6/noble-updates,noble-security 2.39-0ubuntu8.6 amd64 [upgradable from: 2.39-0ubuntu8.5]`
 * A package is a security update when one of its suites is a `-security`
 * pocket. Returns null for output that holds no package lines and is not
 * apt's empty answer (just "Listing...").
 */
export function parseAptUpgradable(stdout: string): AptPackage[] | null {
  const lines = stdout.split('\n').map((l) => l.trim()).filter(Boolean);
  const out: AptPackage[] = [];
  let listing = false;
  for (const line of lines) {
    if (/^Listing/.test(line)) { listing = true; continue; }
    if (/^WARNING:/.test(line)) continue;
    // eslint-disable-next-line security/detect-unsafe-regex -- anchored; the one optional group starts with a literal '[' none of the \S runs before it can end on whitespace
    const m = /^([a-z0-9][a-z0-9+.:-]*)\/(\S+)\s+(\S+)\s+\S+(?:\s+\[upgradable from:\s*([^\]]+)\])?/.exec(line);
    if (!m) continue;
    const suites = m[2].split(',');
    out.push({ name: m[1], suites, version: m[3], from: m[4]?.trim() ?? null, security: suites.some((s) => /-security$/.test(s)) });
  }
  if (!out.length && !listing) return null;
  return out;
}

/** /etc/apt/apt.conf.d/20auto-upgrades: whether the periodic list refresh and unattended upgrades are on. */
export function parseAutoUpgrades(text: string | null): { updateLists: boolean; unattended: boolean } | null {
  if (text === null) return null;
  const get = (k: string) => {
    const m = new RegExp(`^\\s*APT::Periodic::${k}\\s+"(\\d+)"\\s*;`, 'm').exec(text);
    return m ? Number(m[1]) > 0 : false;
  };
  return { updateLists: get('Update-Package-Lists'), unattended: get('Unattended-Upgrade') };
}

/** /var/run/reboot-required.pkgs: the packages asking for a restart, deduplicated. */
export function parseRebootPkgs(text: string | null): string[] {
  if (!text) return [];
  return [...new Set(text.split('\n').map((l) => l.trim()).filter((l) => /^[a-z0-9][a-z0-9+.-]*$/.test(l)))];
}

// ── fail2ban (through rem0te-f2b) ───────────────────────────────────────────

/** `status`: the jail names, or null when the output is not fail2ban's. */
export function parseF2bStatus(stdout: string): string[] | null {
  if (!/Number of jail:/.test(stdout)) return null;
  const m = /Jail list:[ \t]*(.*)$/m.exec(stdout);
  if (!m) return [];
  return m[1].split(',').map((j) => j.trim()).filter((j) => /^[A-Za-z0-9_-]{1,64}$/.test(j));
}

export interface JailStatus { currentFailed: number | null; totalFailed: number | null; currentBanned: number; totalBanned: number; bannedIps: string[]; journalMatches: string | null; fileList: string | null }

/** `status <jail>`. Null when the counts are not there. */
export function parseF2bJail(stdout: string): JailStatus | null {
  const num = (re: RegExp) => { const m = re.exec(stdout); return m ? Number(m[1]) : null; };
  const currentBanned = num(/Currently banned:\s+(\d+)/);
  const totalBanned = num(/Total banned:\s+(\d+)/);
  if (currentBanned === null || totalBanned === null) return null;
  const ips = /Banned IP list:[ \t]*(.*)$/m.exec(stdout);
  return {
    currentFailed: num(/Currently failed:\s+(\d+)/), totalFailed: num(/Total failed:\s+(\d+)/),
    currentBanned, totalBanned,
    bannedIps: ips ? ips[1].trim().split(/\s+/).filter((x) => /^[0-9A-Fa-f.:/]{1,64}$/.test(x)) : [],
    journalMatches: /Journal matches:[ \t]*(.*)$/m.exec(stdout)?.[1].trim() || null,
    fileList: /File list:[ \t]*(.*)$/m.exec(stdout)?.[1].trim() || null,
  };
}

/**
 * A jail reading the systemd journal for a unit that is not the one running
 * the service matches nothing, silently: on Ubuntu 24.04 the SSH server is
 * `ssh.service`, while fail2ban's sshd filter matches `sshd.service`. Returns
 * the unit the jail names when it differs from `actualUnit`, else null.
 */
export function jailWatchesOtherUnit(journalMatches: string | null, actualUnit: string): string | null {
  if (!journalMatches) return null;
  const units = [...journalMatches.matchAll(/_SYSTEMD_UNIT=([A-Za-z0-9@._-]+)/g)].map((m) => m[1]);
  if (!units.length || units.includes(actualUnit)) return null;
  return units[0];
}

/**
 * `get <jail> ignoreip`: "No IP address/network is ignored", or
 * "These IP addresses/networks are ignored:" then "|- a" / "`- b" lines.
 */
export function parseIgnoreIps(stdout: string): string[] {
  return stdout.split('\n')
    .map((l) => l.replace(/^\s*[|`]-\s*/, '').trim())
    .filter((l) => /^[0-9A-Fa-f.:/]{2,64}$/.test(l) && /[.:]/.test(l));
}

/** `get <jail> bantime|findtime|maxretry`: one integer (bantime may be -1, permanent). */
export function parseF2bNumber(stdout: string): number | null {
  const t = stdout.trim();
  return /^-?\d{1,10}$/.test(t) ? Number(t) : null;
}

/** An address or CIDR the wrapper will pass, and nothing else (it refuses the rest anyway). */
export function validAddress(s: unknown): s is string {
  if (typeof s !== 'string' || !/^[0-9A-Fa-f.:/]{2,64}$/.test(s)) return false;
  const [addr, bits, extra] = s.split('/');
  if (extra !== undefined) return false;
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(addr);
  if (v4) {
    if (v4.slice(1).some((o) => Number(o) > 255)) return false;
    return bits === undefined || (/^\d{1,2}$/.test(bits) && Number(bits) <= 32);
  }
  if (!/^[0-9A-Fa-f:]+$/.test(addr) || !addr.includes(':') || (addr.match(/::/g) ?? []).length > 1) return false;
  return bits === undefined || (/^\d{1,3}$/.test(bits) && Number(bits) <= 128);
}

export const validJail = (s: unknown): s is string => typeof s === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(s);

// ── Caddy and certificates ──────────────────────────────────────────────────

/** Site addresses with a TLS name: bare domains opening a block (`a.example.com {` or `a.example.com, b.example.com {`). */
export function parseCaddyDomains(text: string | null): string[] {
  if (!text) return [];
  const out = new Set<string>();
  for (const line of text.split('\n')) {
    const m = /^([^\s#{][^{#]*?)\s*\{\s*$/.exec(line);
    if (!m) continue;
    for (const addr of m[1].split(/[,\s]+/).filter(Boolean)) {
      const a = addr.replace(/^https:\/\//, '').replace(/:443$/, '');
      // eslint-disable-next-line security/detect-unsafe-regex -- each label ends in a literal '.', which the label classes exclude, and the lookahead caps the input at 253 characters
      if (/^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i.test(a)) out.add(a.toLowerCase());
    }
  }
  return [...out];
}

/**
 * How long a certificate has left, and how worried to be. Caddy renews a
 * 90-day Let's Encrypt certificate with about 30 days left, so under 20 days
 * means renewal has been failing for over a week, and under 7 is urgent.
 */
export function certStatus(validTo: string | null, now: number): { expiresAt: string; daysLeft: number; level: 'ok' | 'renewal_failing' | 'urgent' | 'expired' } | null {
  if (!validTo) return null;
  const t = Date.parse(validTo);
  if (!Number.isFinite(t)) return null;
  const daysLeft = Math.floor((t - now) / 86_400_000);
  const level = t <= now ? 'expired' : daysLeft < 7 ? 'urgent' : daysLeft < 20 ? 'renewal_failing' : 'ok';
  return { expiresAt: new Date(t).toISOString(), daysLeft, level };
}

// ── HTTP security headers ───────────────────────────────────────────────────

export type HeaderVerdict = 'ok' | 'weak' | 'missing' | 'disclosed';
export interface HeaderCheck { id: string; header: string; verdict: HeaderVerdict; value: string | null; detail: string }

const SIX_MONTHS = 15_552_000;

/** The console's own response headers, judged. `headers` keys are lower-case. */
export function evaluateHeaders(headers: Record<string, string | undefined>): HeaderCheck[] {
  const h = (k: string) => headers[k] ?? null;
  const out: HeaderCheck[] = [];
  const hsts = h('strict-transport-security');
  const maxAge = hsts ? Number(/max-age\s*=\s*"?(\d+)/i.exec(hsts)?.[1] ?? NaN) : NaN;
  out.push({
    id: 'hsts', header: 'Strict-Transport-Security', value: hsts,
    verdict: !hsts ? 'missing' : !Number.isFinite(maxAge) || maxAge < SIX_MONTHS ? 'weak' : 'ok',
    detail: !hsts ? 'Browsers may be downgraded to plain HTTP on a first visit.'
      : !Number.isFinite(maxAge) || maxAge < SIX_MONTHS ? 'max-age is under six months.' : `max-age ${maxAge} s.`,
  });
  const csp = h('content-security-policy');
  out.push({
    id: 'csp', header: 'Content-Security-Policy', value: csp,
    verdict: !csp ? 'missing' : /(^|;)\s*default-src\b/i.test(csp) || /(^|;)\s*script-src\b/i.test(csp) ? 'ok' : 'weak',
    detail: !csp ? 'No policy limits where script may come from.' : 'Present.',
  });
  const xfo = h('x-frame-options');
  const fa = csp && /frame-ancestors\s+('none'|'self')/i.test(csp);
  out.push({
    id: 'framing', header: 'X-Frame-Options / frame-ancestors', value: xfo ?? (fa ? 'frame-ancestors' : null),
    verdict: fa || (xfo && /^(deny|sameorigin)$/i.test(xfo.trim())) ? 'ok' : 'missing',
    detail: fa || xfo ? 'The console cannot be framed by another site.' : 'Another site could frame the console (clickjacking).',
  });
  const xcto = h('x-content-type-options');
  out.push({ id: 'nosniff', header: 'X-Content-Type-Options', value: xcto, verdict: xcto && /nosniff/i.test(xcto) ? 'ok' : 'missing', detail: xcto ? 'nosniff.' : 'Browsers may guess content types.' });
  const rp = h('referrer-policy');
  out.push({
    id: 'referrer', header: 'Referrer-Policy', value: rp,
    verdict: !rp ? 'missing' : /unsafe-url|no-referrer-when-downgrade/i.test(rp) ? 'weak' : 'ok',
    detail: !rp ? 'The browser default sends the path to other origins on some links.' : 'Present.',
  });
  const pp = h('permissions-policy');
  out.push({ id: 'permissions', header: 'Permissions-Policy', value: pp, verdict: pp ? 'ok' : 'missing', detail: pp ? 'Present.' : 'Camera, microphone and geolocation are not explicitly switched off.' });
  for (const [id, header] of [['server', 'Server'], ['powered', 'X-Powered-By']] as const) {
    const v = h(header.toLowerCase());
    if (v) out.push({ id, header, value: v, verdict: 'disclosed', detail: 'Names the software answering.' });
  }
  return out;
}

// ── npm audit ───────────────────────────────────────────────────────────────

export interface NpmAudit {
  counts: Record<'critical' | 'high' | 'moderate' | 'low' | 'info', number>;
  dependencies: number | null;
  packages: Array<{ name: string; severity: string; direct: boolean; fixAvailable: boolean; titles: string[] }>;
}

/** `npm audit --json` (npm 7+). Null for anything that is not an audit report, including npm's own error object. */
export function parseNpmAudit(stdout: string): NpmAudit | null {
  let j: Record<string, unknown>;
  try { j = JSON.parse(stdout) as Record<string, unknown>; } catch { return null; }
  if (!j || typeof j !== 'object' || j.error) return null;
  const meta = j.metadata as { vulnerabilities?: Record<string, number>; dependencies?: { total?: number; prod?: number } } | undefined;
  if (!meta?.vulnerabilities || typeof j.vulnerabilities !== 'object') return null;
  const v = meta.vulnerabilities;
  const counts = { critical: v.critical ?? 0, high: v.high ?? 0, moderate: v.moderate ?? 0, low: v.low ?? 0, info: v.info ?? 0 };
  const packages = Object.entries(j.vulnerabilities as Record<string, Record<string, unknown>>).map(([name, p]) => ({
    name,
    severity: typeof p.severity === 'string' ? p.severity : 'unknown',
    direct: p.isDirect === true,
    fixAvailable: !!p.fixAvailable,
    titles: (Array.isArray(p.via) ? p.via : []).filter((x): x is { title: string } => !!x && typeof x === 'object' && typeof (x as { title?: unknown }).title === 'string')
      .map((x) => x.title).slice(0, 5),
  }));
  const order = ['critical', 'high', 'moderate', 'low', 'info'];
  packages.sort((a, b) => order.indexOf(a.severity) - order.indexOf(b.severity) || a.name.localeCompare(b.name));
  return { counts, dependencies: meta.dependencies?.prod ?? meta.dependencies?.total ?? null, packages };
}
