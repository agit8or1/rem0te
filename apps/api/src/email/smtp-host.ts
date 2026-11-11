/**
 * Where this server may open an SMTP connection (0.34). Pure: unit-tested in
 * scripts/unit-email.mjs.
 *
 * The SMTP host is typed by a Platform Admin, and the API then connects to it
 * and speaks a line protocol at it — the shape of an SSRF. So the rule is the
 * one §17 applies to a business's alert destinations (a public DNS name: no IP
 * literal, no `localhost`, no single-label or internal-suffix name), applied
 * twice:
 *
 *   on save   the NAME is checked (checkSmtpHostName), so a mistake is a 400
 *             with a reason, not a failed send next week;
 *   on send   the name is resolved and EVERY address it returns is checked
 *             (checkResolved); the connection is then made to that checked
 *             address, with the name kept for TLS (servername) — so a name
 *             that resolved to a public address when it was saved and to
 *             127.0.0.1 or 169.254.169.254 now (DNS rebinding) is refused,
 *             because what is checked is what is connected to.
 *
 * Refusing when ANY returned address is disallowed — not just the first —
 * stops a mixed answer (one public, one internal) from being used to reach
 * the internal one on a retry.
 *
 * A relay on the same host or the LAN is a legitimate install (Postfix on
 * localhost, an on-premises Exchange). It is allowed only by the operator, in
 * the API's environment — not from the portal, where a stolen admin session
 * could switch it on:
 *
 *   SMTP_ALLOW_LOCAL_RELAY unset   public names and public addresses only
 *   SMTP_ALLOW_LOCAL_RELAY=loopback  also `localhost`, 127.0.0.0/8 and ::1
 *   SMTP_ALLOW_LOCAL_RELAY=private   also RFC 1918, 100.64/10, fc00::/7 and
 *                                    internal names (single-label, .local …)
 *
 * Never allowed, whatever the setting: link-local (169.254/16 — the cloud
 * metadata address — and fe80::/10), unspecified (0.0.0.0, ::), multicast,
 * broadcast and reserved ranges. IPv4-mapped IPv6 (::ffff:127.0.0.1) is
 * judged as the IPv4 address it carries.
 *
 * Plaintext SMTP (tlsMode "none") is allowed only to a loopback address: the
 * password and the mail never cross a wire unencrypted.
 */
import { isIP } from 'net';

export type AddressClass = 'public' | 'loopback' | 'private' | 'blocked';
export type LocalRelay = 'none' | 'loopback' | 'private';

export function localRelayAllowance(v: string | undefined = process.env.SMTP_ALLOW_LOCAL_RELAY): LocalRelay {
  const s = (v ?? '').trim().toLowerCase();
  return s === 'loopback' ? 'loopback' : s === 'private' ? 'private' : 'none';
}

const INTERNAL_SUFFIX = /\.(local|internal|lan|home|corp|localdomain|localhost|intranet|private|arpa)$/;

function v4(ip: string): number[] | null {
  const p = ip.split('.');
  if (p.length !== 4) return null;
  const n = p.map((x) => (/^\d{1,3}$/.test(x) ? Number(x) : NaN));
  return n.every((x) => x >= 0 && x <= 255) ? n : null;
}

function classifyV4([a, b, c]: number[]): AddressClass {
  if (a === 127) return 'loopback';
  if (a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127)) return 'private';
  if (a === 0 || (a === 169 && b === 254) || a >= 224) return 'blocked'; // unspecified/"this network", link-local, multicast, reserved, broadcast
  if ((a === 192 && b === 0 && (c === 0 || c === 2)) || (a === 198 && (b === 18 || b === 19)) || (a === 198 && b === 51 && c === 100) || (a === 203 && b === 0 && c === 113)) return 'blocked'; // IETF, documentation, benchmarking
  return 'public';
}

/** Expand an IPv6 literal into eight 16-bit groups, or null. */
function v6groups(ip: string): number[] | null {
  let s = ip.toLowerCase();
  const pct = s.indexOf('%');
  if (pct >= 0) s = s.slice(0, pct); // zone id: only link-local uses it, judged by the address
  let tail: number[] = [];
  const lastColon = s.lastIndexOf(':');
  if (s.slice(lastColon + 1).includes('.')) {
    const q = v4(s.slice(lastColon + 1));
    if (!q) return null;
    tail = [(q[0] << 8) | q[1], (q[2] << 8) | q[3]];
    s = s.slice(0, lastColon + 1); // "::ffff:" or "::"
    if (!s.endsWith('::')) s = s.slice(0, -1);
  }
  const halves = s.split('::');
  if (halves.length > 2) return null;
  const parse = (h: string) => (h ? h.split(':').map((g) => (/^[0-9a-f]{1,4}$/.test(g) ? parseInt(g, 16) : NaN)) : []);
  const head = parse(halves[0]);
  const rest = halves.length === 2 ? parse(halves[1]) : [];
  const want = 8 - tail.length;
  let groups: number[];
  if (halves.length === 2) {
    const fill = want - head.length - rest.length;
    if (fill < 0) return null;
    groups = [...head, ...Array(fill).fill(0), ...rest];
  } else groups = head;
  groups = [...groups, ...tail];
  return groups.length === 8 && groups.every((g) => Number.isInteger(g) && g >= 0 && g <= 0xffff) ? groups : null;
}

/** What kind of address an IP literal is. Anything unparseable is blocked. */
export function classifyAddress(raw: string): AddressClass {
  const ip = raw.replace(/^\[|\]$/g, '');
  const fam = isIP(ip.split('%')[0]);
  if (fam === 4) { const q = v4(ip); return q ? classifyV4(q) : 'blocked'; }
  if (fam !== 6) return 'blocked';
  const g = v6groups(ip);
  if (!g) return 'blocked';
  // IPv4-mapped (::ffff:a.b.c.d) and IPv4-compatible are judged as IPv4.
  if (g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff) return classifyV4([g[6] >> 8, g[6] & 255, g[7] >> 8, g[7] & 255]);
  if (g.every((x) => x === 0)) return 'blocked'; // ::
  if (g.slice(0, 7).every((x) => x === 0) && g[7] === 1) return 'loopback'; // ::1
  if (g.slice(0, 6).every((x) => x === 0)) return 'blocked'; // deprecated IPv4-compatible
  if ((g[0] & 0xffc0) === 0xfe80) return 'blocked'; // link-local
  if ((g[0] & 0xff00) === 0xff00) return 'blocked'; // multicast
  if ((g[0] & 0xfe00) === 0xfc00) return 'private'; // unique local
  if (g[0] === 0x2001 && g[1] === 0x0db8) return 'blocked'; // documentation
  if (g[0] === 0x64 && g[1] === 0xff9b) return 'blocked'; // NAT64: could front any IPv4, internal included
  return 'public';
}

export function addressAllowed(c: AddressClass, allow: LocalRelay): boolean {
  if (c === 'public') return true;
  if (c === 'loopback') return allow === 'loopback' || allow === 'private';
  if (c === 'private') return allow === 'private';
  return false;
}

export type HostCheck = { ok: true; host: string; literal: AddressClass | null } | { ok: false; reason: string };

const LABEL = /^[a-z0-9-]{1,63}$/;
/** A DNS name, label by label (no nested-quantifier regex: each label is checked on its own). */
export function isHostName(h: string): boolean {
  return h.length >= 1 && h.length <= 253 && h.split('.').every((l) => LABEL.test(l) && !l.startsWith('-') && !l.endsWith('-'));
}

/**
 * Check a configured SMTP host before it is saved. Returns the normalised
 * (lower-case, unbracketed) host. A public relay must be a DNS name — an IP
 * literal cannot match a certificate and is what an SSRF probe looks like.
 */
export function checkSmtpHostName(raw: unknown, allow: LocalRelay = localRelayAllowance()): HostCheck {
  if (typeof raw !== 'string') return { ok: false, reason: 'The SMTP host is required.' };
  const h = raw.trim().toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (!h || h.length > 253) return { ok: false, reason: 'The SMTP host is required.' };
  if (isIP(h)) {
    const c = classifyAddress(h);
    if (c === 'public') return { ok: false, reason: 'Use the relay\'s DNS name, not an IP address: TLS checks the certificate against the name.' };
    if (!addressAllowed(c, allow)) return { ok: false, reason: refusal(c) };
    return { ok: true, host: h, literal: c };
  }
  if (!isHostName(h)) return { ok: false, reason: 'The SMTP host is not a valid host name.' };
  if (h === 'localhost' || h.endsWith('.localhost')) {
    return addressAllowed('loopback', allow) ? { ok: true, host: h, literal: null } : { ok: false, reason: refusal('loopback') };
  }
  if (!h.includes('.') || INTERNAL_SUFFIX.test(h)) {
    return allow === 'private' ? { ok: true, host: h, literal: null } : { ok: false, reason: 'The SMTP host must be a public DNS name (an internal name needs SMTP_ALLOW_LOCAL_RELAY=private in the API\'s environment).' };
  }
  return { ok: true, host: h, literal: null };
}

function refusal(c: AddressClass): string {
  if (c === 'loopback') return 'A relay on this server (loopback) needs SMTP_ALLOW_LOCAL_RELAY=loopback in the API\'s environment.';
  if (c === 'private') return 'A relay on a private network needs SMTP_ALLOW_LOCAL_RELAY=private in the API\'s environment.';
  return 'That address can never be an SMTP relay (link-local, unspecified, multicast or reserved).';
}

/**
 * Judge what a name resolved to, at send time. Every address must be
 * allowed; the first one is connected to. Returns the address and whether it
 * is loopback (the only place plaintext may go).
 */
export function checkResolved(addresses: string[], allow: LocalRelay = localRelayAllowance()): { ok: true; address: string; loopback: boolean } | { ok: false; reason: string } {
  if (!addresses.length) return { ok: false, reason: 'The SMTP host did not resolve.' };
  for (const a of addresses) {
    const c = classifyAddress(a);
    if (!addressAllowed(c, allow)) return { ok: false, reason: `The SMTP host resolved to a disallowed address (${c}). ${c === 'blocked' ? '' : refusal(c)}`.trim() };
  }
  return { ok: true, address: addresses[0], loopback: classifyAddress(addresses[0]) === 'loopback' };
}

export const TLS_MODES = ['implicit', 'starttls', 'none'] as const;
export type TlsMode = (typeof TLS_MODES)[number];

/** Plaintext only to loopback. `isLoopback` is the host as configured, or the address as resolved. */
export function tlsModeAllowed(mode: TlsMode, isLoopback: boolean): boolean {
  return mode !== 'none' || isLoopback;
}
