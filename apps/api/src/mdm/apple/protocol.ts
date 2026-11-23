/**
 * Apple MDM, the protocol's closed lists and message shapes (0.84 Harbor,
 * docs/own-mdm.md M2, §93). Pure: only ./plist. No clock, no database.
 *
 * Every list here is also a CHECK in migration 0101, word for word and in
 * order (§93 compares them). Adding a request type is a migration, an
 * invariant change and a docs/own-mdm.md change in the same commit.
 *
 * Sources: Apple's Device Management documentation, "Check-in",
 * "TokenUpdate", "Sending MDM commands to a device", and each command's own
 * page (developer.apple.com/documentation/devicemanagement/<name>-command).
 * Real devices answer with more than these pages show; anything not read here
 * is dropped, never stored.
 */
import { isDict, type PlistDict, type PlistValue } from './plist';

/**
 * The commands Rem0te can send in M2: inventory only, in this order. No lock,
 * lost mode, erase or profile removal (M4 and M5).
 */
export const REQUEST_TYPES = ['DeviceInformation', 'SecurityInfo', 'InstalledApplicationList', 'ProfileList', 'CertificateList'] as const;
export type RequestType = (typeof REQUEST_TYPES)[number];
export const isRequestType = (v: unknown): v is RequestType => typeof v === 'string' && (REQUEST_TYPES as readonly string[]).includes(v);

/** Rem0te's own queue states for an Apple command (0101 CHECK). */
export const APPLE_COMMAND_STATES = ['queued', 'sent', 'acknowledged', 'error', 'cancelled', 'expired'] as const;
export type AppleCommandState = (typeof APPLE_COMMAND_STATES)[number];

/** An enrolled Apple device's state (0101 CHECK). */
export const APPLE_DEVICE_STATES = ['authenticated', 'enrolled', 'checked_out'] as const;
export type AppleDeviceState = (typeof APPLE_DEVICE_STATES)[number];

/** A one-time enrollment link's state (0101 CHECK). */
export const LINK_STATES = ['open', 'claimed', 'used', 'expired', 'revoked'] as const;
export type LinkState = (typeof LINK_STATES)[number];

/** The check-in messages Rem0te answers. Everything else is refused (UserAuthenticate: 410, as Apple asks of a server without user channels). */
export const CHECKIN_TYPES = ['Authenticate', 'TokenUpdate', 'CheckOut'] as const;
export type CheckinType = (typeof CHECKIN_TYPES)[number];

/** The statuses a device reports on the command channel. */
export const DEVICE_STATUSES = ['Idle', 'Acknowledged', 'Error', 'CommandFormatError', 'NotNow'] as const;
export type DeviceStatus = (typeof DEVICE_STATUSES)[number];

/**
 * The DeviceInformation queries Rem0te asks for: only what MobileDevice
 * keeps (0096's rule). Never IMEI, MEID, PhoneNumber, ICCID, the MAC
 * addresses or a user: they are not asked for, and if a device sends them
 * anyway they are not read.
 */
export const DEVICE_INFO_QUERIES = [
  'DeviceName', 'Model', 'ModelName', 'ProductName', 'OSVersion', 'BuildVersion', 'SerialNumber',
  'DeviceCapacity', 'AvailableDeviceCapacity', 'IsSupervised',
] as const;

/**
 * The MDM payload's AccessRights, one constant (Apple: "MDM" payload). In
 * M2: 1 inspect profiles (ProfileList), 4 lock and passcode removal (M4's
 * DeviceLock), 16 device information, 256 inspect installed apps, 1024
 * security queries (SecurityInfo, CertificateList). NOT 8 (erase): that bit
 * is for the business that allows destructive actions (M5, decision 16), and
 * every device enrolled without it must enroll again to get it. Changing
 * this constant changes what new enrollments grant, and nothing for devices
 * already enrolled.
 */
export const ACCESS_RIGHTS = 1 + 4 + 16 + 256 + 1024;

/** A command stays in the queue this long, then expires. */
export const COMMAND_TTL_MS = 7 * 24 * 3_600_000;

// ── Charsets for what a device sends ──────────────────────────────────────

/** A device UDID (25-char Apple silicon form, 40-hex legacy form, or a UUID). */
export const UDID_RE = /^[A-Fa-f0-9-]{24,64}$/;
export const COMMAND_UUID_RE = /^[A-Fa-f0-9-]{36}$/;
export const PUSH_MAGIC_RE = /^[A-Za-z0-9-]{1,64}$/;
/** The push token, hex (Apple: 32 bytes; the simulator sends fewer). */
export const PUSH_TOKEN_RE = /^[0-9a-f]{8,200}$/;
export const TOPIC_RE = /^com\.apple\.mgmt\.[A-Za-z0-9.-]{1,100}$/;
// eslint-disable-next-line security/detect-unsafe-regex -- anchored, bounded repetitions, each group starts with a literal dot the digit class excludes
const OS_RE = /^[0-9]{1,3}(?:\.[0-9]{1,4}){0,3}$/;
const BUILD_RE = /^[A-Za-z0-9]{1,20}$/;
const MODEL_RE = /^[A-Za-z0-9 ,._()/-]{1,64}$/;
const SERIAL_RE = /^[A-Z0-9]{4,40}$/;

const str = (d: PlistDict, k: string): string | null => (typeof d[k] === 'string' ? (d[k] as string) : null);
const text = (v: unknown, max: number): string | null => {
  if (typeof v !== 'string') return null;
  // Control characters out, whitespace folded, length capped; the console draws it as text.
  // eslint-disable-next-line no-control-regex
  const s = v.replace(/[\u0000-\u001F\u007F-\u009F]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
  return s || null;
};
const pick = (v: unknown, re: RegExp): string | null => (typeof v === 'string' && re.test(v) ? v : null);

// ── Check-in ──────────────────────────────────────────────────────────────

export type Checkin =
  | { type: 'Authenticate'; udid: string; topic: string; facts: AuthFacts }
  | { type: 'TokenUpdate'; udid: string; topic: string; pushToken: string; pushMagic: string }
  | { type: 'CheckOut'; udid: string; topic: string }
  | { type: 'unsupported'; messageType: string }
  | { type: 'invalid'; why: string };

export interface AuthFacts { productName: string | null; osVersion: string | null; buildVersion: string | null; serialNumber: string | null; deviceName: string | null }

/**
 * A check-in message, from its parsed plist. Only the named keys are read:
 * IMEI, MEID, UnlockToken, user fields and anything else a device sends are
 * never copied out. User Enrollment (EnrollmentID instead of UDID) is
 * refused: it is M8.
 */
export function readCheckin(d: PlistDict): Checkin {
  const messageType = str(d, 'MessageType');
  if (!messageType || !/^[A-Za-z]{1,40}$/.test(messageType)) return { type: 'invalid', why: 'message_type' };
  if (!(CHECKIN_TYPES as readonly string[]).includes(messageType)) return { type: 'unsupported', messageType };
  if (d.EnrollmentID !== undefined || d.UserID !== undefined) return { type: 'invalid', why: 'user_channel' };
  const udid = pick(d.UDID, UDID_RE);
  const topic = pick(d.Topic, TOPIC_RE);
  if (!udid) return { type: 'invalid', why: 'udid' };
  if (!topic) return { type: 'invalid', why: 'topic' };
  if (messageType === 'Authenticate') {
    const serial = typeof d.SerialNumber === 'string' ? d.SerialNumber.trim().toUpperCase() : null;
    return {
      type: 'Authenticate', udid, topic,
      facts: {
        productName: pick(d.ProductName, MODEL_RE), osVersion: pick(d.OSVersion, OS_RE), buildVersion: pick(d.BuildVersion, BUILD_RE),
        serialNumber: serial && SERIAL_RE.test(serial) ? serial : null, deviceName: text(d.DeviceName, 100),
      },
    };
  }
  if (messageType === 'TokenUpdate') {
    const token = d.Token instanceof Uint8Array ? Buffer.from(d.Token).toString('hex') : null;
    const magic = pick(d.PushMagic, PUSH_MAGIC_RE);
    if (!token || !PUSH_TOKEN_RE.test(token)) return { type: 'invalid', why: 'token' };
    if (!magic) return { type: 'invalid', why: 'push_magic' };
    // UnlockToken is deliberately not read (docs/own-mdm.md: Rem0te does not keep it).
    return { type: 'TokenUpdate', udid, topic, pushToken: token, pushMagic: magic };
  }
  return { type: 'CheckOut', udid, topic };
}

// ── The command channel ───────────────────────────────────────────────────

export type Report =
  | { status: 'Idle'; udid: string }
  | { status: Exclude<DeviceStatus, 'Idle'>; udid: string; commandUuid: string; errorCode: string | null; body: PlistDict }
  | { status: 'invalid'; why: string };

export function readReport(d: PlistDict): Report {
  const udid = pick(d.UDID, UDID_RE);
  if (!udid) return { status: 'invalid', why: d.EnrollmentID !== undefined ? 'user_channel' : 'udid' };
  const status = str(d, 'Status');
  if (!status || !(DEVICE_STATUSES as readonly string[]).includes(status)) return { status: 'invalid', why: 'status' };
  if (status === 'Idle') return { status: 'Idle', udid };
  const commandUuid = pick(d.CommandUUID, COMMAND_UUID_RE);
  if (!commandUuid) return { status: 'invalid', why: 'command_uuid' };
  return { status: status as Exclude<DeviceStatus, 'Idle'>, udid, commandUuid, errorCode: status === 'Error' ? errorCode(d.ErrorChain) : status === 'CommandFormatError' ? 'command_format_error' : null, body: d };
}

/** The first ErrorChain entry as `<domain>:<code>`, lowercased into the failure-code charset. Never the description text. */
export function errorCode(chain: PlistValue | undefined): string {
  const first = Array.isArray(chain) && isDict(chain[0]) ? chain[0] : null;
  const code = first && typeof first.ErrorCode === 'number' && Number.isInteger(first.ErrorCode) ? String(first.ErrorCode) : 'unknown';
  const domain = first && typeof first.ErrorDomain === 'string' ? first.ErrorDomain.toLowerCase().replace(/[^a-z0-9_.-]/g, '').slice(0, 40) : '';
  return `apple:${domain ? `${domain}:` : ''}${code}`.slice(0, 64);
}

/** The command body Rem0te sends for each request type: fixed, built from nothing a person typed. */
export function commandFor(type: RequestType): PlistDict {
  switch (type) {
    case 'DeviceInformation': return { RequestType: type, Queries: [...DEVICE_INFO_QUERIES] };
    case 'InstalledApplicationList': return { RequestType: type, ManagedAppsOnly: false };
    case 'ProfileList':
    case 'SecurityInfo':
    case 'CertificateList':
      return { RequestType: type };
  }
}

export function commandEnvelope(type: RequestType, commandUuid: string): PlistDict {
  return { Command: commandFor(type), CommandUUID: commandUuid };
}

// ── What an Acknowledged result tells Rem0te ──────────────────────────────

export interface Inventory {
  deviceName?: string | null;
  model?: string | null;
  modelName?: string | null;
  productName?: string | null;
  osVersion?: string | null;
  buildVersion?: string | null;
  serialNumber?: string | null;
  storageTotalBytes?: bigint | null;
  storageFreeBytes?: bigint | null;
  supervised?: boolean | null;
  passcodePresent?: boolean | null;
  passcodeCompliant?: boolean | null;
  appCount?: number | null;
  profileCount?: number | null;
  certificateCount?: number | null;
}

const GB = 1_000_000_000;
/** DeviceCapacity / AvailableDeviceCapacity are decimal gigabytes (a real, on real devices; a string on the simulator). */
function gigabytes(v: unknown): bigint | null {
  // eslint-disable-next-line security/detect-unsafe-regex -- anchored, bounded, one group starting with a literal dot
  const n = typeof v === 'number' ? v : typeof v === 'string' && /^[0-9]{1,6}(?:\.[0-9]{1,6})?$/.test(v) ? Number(v) : NaN;
  if (!Number.isFinite(n) || n < 0 || n > 1_000_000) return null;
  return BigInt(Math.round(n * GB));
}
const bool = (v: unknown): boolean | null => (typeof v === 'boolean' ? v : v === 'true' ? true : v === 'false' ? false : null);
const count = (v: unknown, max = 100_000): number | null => (Array.isArray(v) ? Math.min(v.length, max) : null);

/** Only the facts Rem0te keeps. A field the result does not carry is left out (undefined), not cleared. */
export function inventoryFrom(type: RequestType, body: PlistDict): Inventory {
  switch (type) {
    case 'DeviceInformation': {
      const q = isDict(body.QueryResponses) ? body.QueryResponses : {};
      const out: Inventory = {};
      if ('DeviceName' in q) out.deviceName = text(q.DeviceName, 100);
      if ('Model' in q) out.model = pick(q.Model, MODEL_RE);
      if ('ModelName' in q) out.modelName = pick(q.ModelName, MODEL_RE);
      if ('ProductName' in q) out.productName = pick(q.ProductName, MODEL_RE);
      if ('OSVersion' in q) out.osVersion = pick(q.OSVersion, OS_RE);
      if ('BuildVersion' in q) out.buildVersion = pick(q.BuildVersion, BUILD_RE);
      if ('SerialNumber' in q) { const s = typeof q.SerialNumber === 'string' ? q.SerialNumber.trim().toUpperCase() : ''; out.serialNumber = SERIAL_RE.test(s) ? s : null; }
      if ('DeviceCapacity' in q) out.storageTotalBytes = gigabytes(q.DeviceCapacity);
      if ('AvailableDeviceCapacity' in q) out.storageFreeBytes = gigabytes(q.AvailableDeviceCapacity);
      if ('IsSupervised' in q) out.supervised = bool(q.IsSupervised);
      if (out.storageTotalBytes != null && out.storageFreeBytes != null && out.storageFreeBytes > out.storageTotalBytes) out.storageFreeBytes = null;
      return out;
    }
    case 'SecurityInfo': {
      const s = isDict(body.SecurityInfo) ? body.SecurityInfo : {};
      return { passcodePresent: bool(s.PasscodePresent), passcodeCompliant: bool(s.PasscodeCompliant) };
    }
    case 'InstalledApplicationList': return { appCount: count(body.InstalledApplicationList) };
    case 'ProfileList': return { profileCount: count(body.ProfileList) };
    case 'CertificateList': return { certificateCount: count(body.CertificateList) };
  }
}

/** iPad or iPhone, from the product name ("iPad13,1", "iPhone15,2"); anything else is unknown. */
export function platformOf(productName: string | null | undefined): 'ios' | 'ipados' | null {
  if (!productName) return null;
  if (/^iPad/.test(productName)) return 'ipados';
  if (/^iP(hone|od)/.test(productName)) return 'ios';
  return null;
}
