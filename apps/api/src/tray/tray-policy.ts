/**
 * The tray (0.36): the rules, as pure functions. No Nest, no Prisma, so
 * scripts/unit-tray.mjs exercises exactly what the services run.
 *
 * Three things the person at the computer can do through the tray, each
 * bounded here:
 *   - chat: a one-time code (60 s) exchanged once for an /assist cookie
 *     (≤ 2 h, one computer, one conversation);
 *   - a support request, optionally with a resource-usage sample and a
 *     screenshot (JPEG or PNG, ≤ 700 KiB, ≤ 4096 px a side);
 *   - a self-help tool from a closed catalog with no parameters.
 */
import { createHash, randomBytes, timingSafeEqual } from 'crypto';

// ── Codes and sessions ───────────────────────────────────────────────────────

/** A minted code is good for this long, and once. */
export const CODE_TTL_MS = 60_000;
/** The /assist cookie lives at most this long (and ends with its conversation). */
export const SESSION_TTL_MS = 2 * 60 * 60_000;
/** Codes one computer may mint per 10 minutes. */
export const MAX_CODES_PER_10_MIN = 10;
export const ASSIST_COOKIE = 'rem0te_assist';
/** The cookie is sent only to /assist: the page and its API (rewritten to the API's /api/v1/assist). */
export const ASSIST_COOKIE_PATH = '/assist';

const CODE_RE = /^[A-Za-z0-9_-]{43}$/;
const TRAY_KEY_RE = /^tk_([a-z0-9]{24})\.([A-Za-z0-9_-]{43})$/;

export const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
/** 32 random bytes, base64url: 43 characters. */
export const newSecret = () => randomBytes(32).toString('base64url');
export const isCode = (v: unknown): v is string => typeof v === 'string' && CODE_RE.test(v);

/** A tray key: `tk_<id>.<secret>`. The id is a lookup key; only the secret's hash is stored. */
export function newTrayKey(): { keyId: string; secret: string; token: string; hash: string } {
  const keyId = randomBytes(12).toString('hex');
  const secret = newSecret();
  return { keyId, secret, token: `tk_${keyId}.${secret}`, hash: sha256(secret) };
}
export function parseTrayKey(raw: unknown): { keyId: string; secret: string } | null {
  if (typeof raw !== 'string') return null;
  const m = TRAY_KEY_RE.exec(raw);
  return m ? { keyId: m[1], secret: m[2] } : null;
}
/** Constant-time comparison of a presented secret with a stored hash. */
export function hashMatches(storedHex: string | null | undefined, presented: string): boolean {
  if (!storedHex || !/^[0-9a-f]{64}$/.test(storedHex)) return false;
  const a = Buffer.from(storedHex, 'hex');
  const b = Buffer.from(sha256(presented), 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * The Set-Cookie value for an /assist session: HttpOnly (no script can read
 * it), Secure, SameSite=Strict (no other site can send it), and scoped to
 * /assist so no other page of the portal ever receives it.
 */
export function assistCookie(token: string, maxAgeMs = SESSION_TTL_MS): string {
  return `${ASSIST_COOKIE}=${token}; Path=${ASSIST_COOKIE_PATH}; Max-Age=${Math.floor(maxAgeMs / 1000)}; HttpOnly; Secure; SameSite=Strict`;
}
export function clearAssistCookie(): string {
  return `${ASSIST_COOKIE}=; Path=${ASSIST_COOKIE_PATH}; Max-Age=0; HttpOnly; Secure; SameSite=Strict`;
}
export function readAssistCookie(header: string | undefined): string | null {
  if (!header) return null;
  for (const part of header.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === ASSIST_COOKIE) {
      const t = v.join('=');
      return CODE_RE.test(t) ? t : null;
    }
  }
  return null;
}

/**
 * The page's Content-Security-Policy. Nothing inline, nothing from anywhere
 * else, no frames, no forms, no plugins: the page loads its own script and
 * stylesheet from /assist and talks only to /assist/api.
 */
export const ASSIST_CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self'",
  "connect-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ');

// ── Recording ────────────────────────────────────────────────────────────────

/** A business's choice wins; null falls back to the platform default (itself on unless turned off). */
export function chatRecorded(business: boolean | null | undefined, platformDefault: boolean | null | undefined): boolean {
  if (business === true || business === false) return business;
  return platformDefault !== false;
}

// ── Self-help ────────────────────────────────────────────────────────────────

export interface SelfHelpTool {
  id: string;
  title: string;
  /** Runs in the SYSTEM agent: so only on the signed agent. */
  elevated: boolean;
  /** Runs per device in this window, at most. */
  perWindow: number;
  windowMs: number;
  /** Containment kinds that stop it ('actions' stops every elevated tool). */
  blockedBy: ('actions' | 'remote')[];
}

/**
 * The closed catalog. No tool takes a parameter from the person at the
 * computer, and none can be told what to run: each id maps to one fixed
 * routine in the agent (tools/windows-installer/internal/tray/catalog.go
 * must list exactly these, in this order).
 */
export const SELF_HELP: readonly SelfHelpTool[] = [
  { id: 'dns.check', title: 'Check DNS', elevated: false, perWindow: 10, windowMs: 10 * 60_000, blockedBy: [] },
  { id: 'dns.flush', title: 'Flush the DNS cache', elevated: true, perWindow: 3, windowMs: 10 * 60_000, blockedBy: ['actions'] },
  { id: 'ip.renew', title: 'Renew IP address', elevated: true, perWindow: 2, windowMs: 15 * 60_000, blockedBy: ['actions'] },
  { id: 'net.test', title: 'Test the connection', elevated: false, perWindow: 10, windowMs: 10 * 60_000, blockedBy: [] },
  { id: 'net.details', title: 'Show network details', elevated: false, perWindow: 10, windowMs: 10 * 60_000, blockedBy: [] },
  { id: 'rustdesk.restart', title: 'Restart the remote support service', elevated: true, perWindow: 2, windowMs: 30 * 60_000, blockedBy: ['actions', 'remote'] },
] as const;
export const SELF_HELP_IDS = SELF_HELP.map((t) => t.id);
/** Runs per device per hour, every tool together. */
export const SELF_HELP_PER_HOUR = 30;

export function selfHelpTool(id: unknown): SelfHelpTool | null {
  return typeof id === 'string' ? SELF_HELP.find((t) => t.id === id) ?? null : null;
}

/** Which tools a credential may run: a tray key (standard agent) never the elevated ones. */
export function toolsFor(via: 'signed' | 'tray_key'): SelfHelpTool[] {
  return SELF_HELP.filter((t) => via === 'signed' || !t.elevated);
}

export const SELF_HELP_OUTCOMES = ['succeeded', 'failed', 'refused'] as const;
export type SelfHelpOutcome = (typeof SELF_HELP_OUTCOMES)[number];

/** A short result line from the agent, made inert (one line, ≤ 300 characters). */
export function summaryLine(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const s = Array.from(raw, (ch) => { const c = ch.codePointAt(0)!; return c < 32 || (c >= 0x7f && c <= 0x9f) || (c >= 0x2028 && c <= 0x202e) || (c >= 0x2066 && c <= 0x2069) ? ' ' : ch; })
    .join('').replace(/\s+/g, ' ').trim().slice(0, 300);
  return s || null;
}

/** The agent's detail object: at most 40 lines of at most 200 characters each. */
export function detailLines(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw.slice(0, 40).map((l) => (summaryLine(l) ?? '').slice(0, 200)).filter(Boolean);
}

// ── Support requests from the tray ───────────────────────────────────────────

export const SUPPORT_MAX_TEXT = 2000;
/** Requests one computer may send per hour, and per Windows account per hour. */
export const SUPPORT_PER_DEVICE_HOUR = 3;
export const SUPPORT_PER_USER_HOUR = 2;
/** Open tray requests one computer may have at once. */
export const SUPPORT_OPEN_PER_DEVICE = 3;
export const SCREENSHOT_MAX_BYTES = 700 * 1024;
export const SCREENSHOT_MAX_SIDE = 4096;

export type ImageCheck = { ok: true; contentType: 'image/jpeg' | 'image/png'; width: number; height: number; bytes: Buffer } | { ok: false; code: string };

/**
 * A screenshot as the tray sends it: base64 of a JPEG or a PNG, decoded,
 * at most 700 KiB, its dimensions read from the header and capped. Anything
 * that is not exactly one of the two formats is refused, never sniffed into
 * something else.
 */
export function screenshot(raw: unknown): ImageCheck {
  if (typeof raw !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(raw)) return { ok: false, code: 'SCREENSHOT_NOT_BASE64' };
  if (raw.length > Math.ceil((SCREENSHOT_MAX_BYTES * 4) / 3) + 4) return { ok: false, code: 'SCREENSHOT_TOO_LARGE' };
  const b = Buffer.from(raw, 'base64');
  if (b.length === 0 || b.length > SCREENSHOT_MAX_BYTES) return { ok: false, code: 'SCREENSHOT_TOO_LARGE' };
  const dims = imageSize(b);
  if (!dims) return { ok: false, code: 'SCREENSHOT_NOT_IMAGE' };
  if (dims.width < 1 || dims.height < 1 || dims.width > SCREENSHOT_MAX_SIDE || dims.height > SCREENSHOT_MAX_SIDE) return { ok: false, code: 'SCREENSHOT_DIMENSIONS' };
  return { ok: true, contentType: dims.type, width: dims.width, height: dims.height, bytes: b };
}

export function imageSize(b: Buffer): { type: 'image/jpeg' | 'image/png'; width: number; height: number } | null {
  // PNG: signature, then IHDR first with width and height.
  if (b.length >= 24 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) && b.subarray(12, 16).toString('latin1') === 'IHDR') {
    return { type: 'image/png', width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
  }
  // JPEG: SOI, then segments until a start-of-frame marker.
  if (b.length >= 4 && b[0] === 0xff && b[1] === 0xd8) {
    let i = 2;
    while (i + 9 < b.length) {
      if (b[i] !== 0xff) return null;
      const marker = b[i + 1];
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { i += 2; continue; }
      const len = b.readUInt16BE(i + 2);
      if (len < 2) return null;
      if ((marker >= 0xc0 && marker <= 0xcf) && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { type: 'image/jpeg', height: b.readUInt16BE(i + 5), width: b.readUInt16BE(i + 7) };
      }
      i += 2 + len;
    }
  }
  return null;
}

export interface UsageSample {
  sampledAt: string;
  cpuPercent: number | null;
  memoryTotalMb: number | null;
  memoryUsedMb: number | null;
  diskTotalMb: number | null;
  diskFreeMb: number | null;
  uptimeSeconds: number | null;
  topProcesses: { name: string; cpuPercent: number | null; memoryMb: number | null }[];
}

const num = (v: unknown, min: number, max: number): number | null =>
  typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max ? Math.round(v * 10) / 10 : null;
const PROC_NAME_RE = /^[A-Za-z0-9 ._()+-]{1,64}$/;

/**
 * The agent's resource-usage sample, reduced to numbers in range and process
 * names in an inert charset (the image name only: no paths, no command lines).
 * Null when it carries nothing usable.
 */
export function usageSample(raw: unknown, now = new Date()): UsageSample | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const at = typeof r.sampledAt === 'string' && !Number.isNaN(Date.parse(r.sampledAt)) && Math.abs(Date.parse(r.sampledAt) - now.getTime()) < 24 * 3600_000
    ? new Date(Date.parse(r.sampledAt)).toISOString() : now.toISOString();
  const procs = Array.isArray(r.topProcesses) ? r.topProcesses.slice(0, 10) : [];
  const out: UsageSample = {
    sampledAt: at,
    cpuPercent: num(r.cpuPercent, 0, 100),
    memoryTotalMb: num(r.memoryTotalMb, 0, 64 * 1024 * 1024),
    memoryUsedMb: num(r.memoryUsedMb, 0, 64 * 1024 * 1024),
    diskTotalMb: num(r.diskTotalMb, 0, 1024 * 1024 * 1024),
    diskFreeMb: num(r.diskFreeMb, 0, 1024 * 1024 * 1024),
    uptimeSeconds: num(r.uptimeSeconds, 0, 20 * 365 * 86_400),
    topProcesses: procs
      .filter((p): p is Record<string, unknown> => !!p && typeof p === 'object' && typeof (p as Record<string, unknown>).name === 'string' && PROC_NAME_RE.test((p as Record<string, unknown>).name as string))
      .map((p) => ({ name: p.name as string, cpuPercent: num(p.cpuPercent, 0, 100 * 256), memoryMb: num(p.memoryMb, 0, 64 * 1024 * 1024) })),
  };
  const anything = out.cpuPercent !== null || out.memoryTotalMb !== null || out.diskTotalMb !== null || out.uptimeSeconds !== null || out.topProcesses.length > 0;
  return anything ? out : null;
}

// ── Branding the tray and the page show ──────────────────────────────────────

const HEX_COLOR = /^#[0-9A-Fa-f]{6}$/;
export function accent(raw: string | null | undefined): string {
  return raw && HEX_COLOR.test(raw) ? raw : '#3B82F6';
}

/**
 * The "technician support" line in About: the IT provider's phone and
 * e-mail as its branding records them, or a fixed sentence. Never anything a
 * device, a chat message or a request can set.
 */
export function supportLine(b: { supportPhone?: string | null; supportEmail?: string | null } | null | undefined): string {
  const parts = [b?.supportPhone, b?.supportEmail].map((x) => summaryLine(x ?? '')?.slice(0, 120)).filter(Boolean);
  return parts.length ? `Support: ${parts.join(' · ')}` : 'Contact your IT provider for support.';
}
