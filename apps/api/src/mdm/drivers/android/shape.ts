/**
 * The Android Management API's shapes, as Rem0te reads and writes them
 * (0.85 Mooring, docs/own-mdm.md M3, §94). Pure: node:crypto (the JWT
 * signature) and ../../model only. No host, no clock (every time is passed
 * in), no network.
 *
 *   - the service-account JWT (RS256) exchanged for an access token;
 *   - the default policy: status reports for software and apps ONLY, never
 *     network info (it carries the IMEI and the MAC addresses, which 0096
 *     does not keep), memory, power or hardware status;
 *   - a one-time enrollment token: work profile (personal usage allowed) or
 *     fully managed (personal usage disallowed), chosen per token;
 *   - a Device turned into the provider-neutral record the sync parses
 *     (schemas.ts), reading only the fields named in DEVICE_FIELDS: no
 *     networkInfo, telephony, user, IMEI, MEID, phone number or MAC is ever
 *     asked for or read;
 *   - an Operation turned into a provider-neutral command record;
 *   - 0.86 (M4, §95): the body of devices.issueCommand for the three
 *     lost-device commands, and nothing else. LOCK takes nothing;
 *     START_LOST_MODE only the lock-screen message and phone number a person
 *     gave, as UserFacingMessages; STOP_LOST_MODE nothing. There is no WIPE,
 *     RELINQUISH_OWNERSHIP or RESET_PASSWORD body (M5), and no devices.delete.
 */
import { createPrivateKey, sign, type KeyObject } from 'node:crypto';
import { EXTERNAL_TENANT_RE, PROVIDER_ID_RE } from '../../model';

/** The one policy Rem0te applies to a business's enterprise (0102 CHECK). */
export const POLICY_ID = 'rem0te-default';

/**
 * The default policy, exactly. A PATCH with no update mask replaces the
 * whole policy, so nothing else is ever on. applicationReportsEnabled is on
 * because the design asks for it (inventory later); in M3 the device listing
 * does not even request the reports (DEVICE_FIELDS).
 */
export const DEFAULT_POLICY = { statusReportingSettings: { softwareInfoEnabled: true, applicationReportsEnabled: true } } as const;

/** Sign-up states (0102 CHECK, in order). */
export const SIGNUP_STATES = ['open', 'claimed', 'bound', 'failed', 'expired'] as const;
export type SignupState = (typeof SIGNUP_STATES)[number];
/** A sign-up link lives this long (0102 caps it at an hour). */
export const SIGNUP_MINUTES = 30;

/** Per-token choice: a work profile (personal usage allowed) or a fully managed device. */
export const PERSONAL_USAGE = ['allowed', 'disallowed'] as const;
export type PersonalUsage = (typeof PERSONAL_USAGE)[number];
export const ALLOW_PERSONAL_USAGE: Record<PersonalUsage, string> = { allowed: 'PERSONAL_USAGE_ALLOWED', disallowed: 'PERSONAL_USAGE_DISALLOWED' };
/** One-time tokens only, an hour by default (Google's own default), never longer. */
export const TOKEN_MIN_MINUTES = 15;
export const TOKEN_MAX_MINUTES = 60;
export const TOKEN_DEFAULT_MINUTES = 60;

/** Charsets for what Google sends and what Rem0te puts in a URL. Anything else is refused. */
export const ENTERPRISE_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
export const ENTERPRISE_NAME_RE = /^enterprises\/([A-Za-z0-9_-]{1,64})$/;
export const SIGNUP_NAME_RE = /^signupUrls\/[A-Za-z0-9_-]{1,128}$/;
export const ENTERPRISE_TOKEN_RE = /^[A-Za-z0-9._~+/=-]{1,1024}$/;
export const ENROLLMENT_VALUE_RE = /^[A-Za-z0-9_-]{4,256}$/;
export const PAGE_TOKEN_RE = /^[A-Za-z0-9._~+/=-]{1,1024}$/;
export const STATE_TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;
export const POLICY_VERSION_RE = /^[0-9]{1,19}$/;
const DEVICE_NAME_RE = /^enterprises\/[A-Za-z0-9_-]{1,64}\/devices\/([A-Za-z0-9._:-]{1,128})$/;
const OPERATION_NAME_RE = /^enterprises\/[A-Za-z0-9_-]{1,64}\/devices\/[A-Za-z0-9._:-]{1,128}\/operations\/([A-Za-z0-9._-]{1,100})$/;
// eslint-disable-next-line security/detect-unsafe-regex -- anchored, bounded quantifiers, one optional group
const DURATION_RE = /^([0-9]{1,9})(?:\.[0-9]{1,9})?s$/;

/** The only device fields Rem0te asks Google for (the `fields` partial response). */
export const DEVICE_FIELDS = 'devices(name,state,ownership,managementMode,enrollmentTime,lastStatusReportTime,policyCompliant,'
  + 'nonComplianceDetails(nonComplianceReason),hardwareInfo(brand,model,manufacturer,serialNumber),softwareInfo(androidVersion)),nextPageToken';

/** Percent-encode everything but unreserved characters (RFC 3986), so a query is [A-Za-z0-9._~%=&-]. */
export const enc = (s: string) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
export const query = (q: Record<string, string | number | null | undefined>) =>
  Object.entries(q).filter(([, v]) => v !== null && v !== undefined && v !== '').map(([k, v]) => `${enc(k)}=${enc(String(v))}`).join('&');

// ── The service-account JWT ─────────────────────────────────────────────────

const b64url = (b: Buffer | string) => Buffer.from(b).toString('base64url');

/** The claims Google's token endpoint expects: one scope, an hour at most. */
export function jwtClaims(c: { clientEmail: string }, aud: string, scope: string, nowSec: number) {
  return { iss: c.clientEmail, scope, aud, iat: nowSec, exp: nowSec + 3600 };
}

/** An RS256 JWT over the claims, with the key id in the header. */
export function signJwt(c: { clientEmail: string; privateKeyId: string; key: KeyObject | string }, aud: string, scope: string, nowSec: number): string {
  const head = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT', kid: c.privateKeyId }));
  const body = b64url(JSON.stringify(jwtClaims(c, aud, scope, nowSec)));
  const key = typeof c.key === 'string' ? createPrivateKey(c.key) : c.key;
  return `${head}.${body}.${b64url(sign('sha256', Buffer.from(`${head}.${body}`), key))}`;
}

// ── Requests ────────────────────────────────────────────────────────────────

/** The only Android commands Rem0te issues (0.86), by Rem0te kind. */
export const ANDROID_COMMAND_TYPES = { lock: 'LOCK', lost_mode_start: 'START_LOST_MODE', lost_mode_stop: 'STOP_LOST_MODE' } as const;
export type AndroidLostKind = keyof typeof ANDROID_COMMAND_TYPES;
// eslint-disable-next-line no-control-regex
const LOST_TEXT_BAD = /[\u0000-\u001F\u007F-\u009F\u2028\u2029\u202A-\u202E\u2066-\u2069]/;
const LOST_PHONE_RE = /^[+0-9][0-9 ().-]{2,30}$/;

/**
 * devices.issueCommand's body for one lost-device command. `duration` is how
 * long the command waits for the device (Google's default is ten minutes;
 * a lost phone may be off for days). The message and phone number are
 * checked again here and sent as UserFacingMessage `defaultMessage`s; any
 * other kind, or text that fails the check, gives null and nothing is sent.
 */
export function commandBody(kind: string, text: { message: string | null; phoneNumber: string | null }, ttlSeconds: number): Record<string, unknown> | null {
  if (!Number.isInteger(ttlSeconds) || ttlSeconds < 60 || ttlSeconds > 30 * 86_400) return null;
  const duration = `${ttlSeconds}s`;
  if (kind === 'lock') return { type: ANDROID_COMMAND_TYPES.lock, duration };
  if (kind === 'lost_mode_stop') return { type: ANDROID_COMMAND_TYPES.lost_mode_stop, duration, stopLostModeParams: {} };
  if (kind !== 'lost_mode_start') return null;
  const message = text.message && text.message.length <= 160 && !LOST_TEXT_BAD.test(text.message) ? text.message : null;
  const phone = text.phoneNumber && LOST_PHONE_RE.test(text.phoneNumber) ? text.phoneNumber : null;
  if (!message && !phone) return null;
  return {
    type: ANDROID_COMMAND_TYPES.lost_mode_start, duration,
    startLostModeParams: { ...(message ? { lostMessage: { defaultMessage: message } } : {}), ...(phone ? { lostPhoneNumber: { defaultMessage: phone } } : {}) },
  };
}

/**
 * The Operation devices.issueCommand returns, as Rem0te's command id
 * (`<device>:<operation>`) and Google's acceptance time; null when it is not
 * an Operation on that device.
 */
export function issuedOperation(v: unknown, deviceId: string): { providerCommandId: string; createdAt: string | null } | null {
  const o = obj(v);
  const name = str(o?.name, 400) ?? '';
  const m = name.match(OPERATION_NAME_RE);
  const dev = name.match(/^enterprises\/[A-Za-z0-9_-]{1,64}\/devices\/([A-Za-z0-9._:-]{1,128})\/operations\//)?.[1];
  if (!m || dev !== deviceId) return null;
  const id = `${deviceId}:${m[1]}`;
  if (!PROVIDER_ID_RE.test(id)) return null;
  return { providerCommandId: id, createdAt: isoOrNull(obj(o?.metadata)?.createTime) };
}

/** Rem0te's command id back into the device and operation ids (the operation id has no colon). */
export function operationIdsOf(providerCommandId: string): { deviceId: string; operationId: string } | null {
  const i = providerCommandId.lastIndexOf(':');
  if (i <= 0) return null;
  const deviceId = providerCommandId.slice(0, i), operationId = providerCommandId.slice(i + 1);
  return /^[A-Za-z0-9._:-]{1,128}$/.test(deviceId) && /^[A-Za-z0-9._-]{1,100}$/.test(operationId) ? { deviceId, operationId } : null;
}

export function enrollmentTokenBody(enterpriseId: string, usage: PersonalUsage, minutes: number) {
  return {
    policyName: `enterprises/${enterpriseId}/policies/${POLICY_ID}`,
    duration: `${minutes * 60}s`,
    oneTimeOnly: true,
    allowPersonalUsage: ALLOW_PERSONAL_USAGE[usage],
  };
}

// ── Answers ─────────────────────────────────────────────────────────────────

const obj = (v: unknown): Record<string, unknown> | null => (v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : null);
const str = (v: unknown, max = 200): string | null => (typeof v === 'string' && v.length > 0 && v.length <= max ? v : null);
const isoOrNull = (v: unknown): string | null => { const s = str(v, 40); return s && !Number.isNaN(Date.parse(s)) ? s : null; };

export function enterpriseIdOf(v: unknown): string | null {
  const m = (str(obj(v)?.name, 100) ?? '').match(ENTERPRISE_NAME_RE);
  return m && EXTERNAL_TENANT_RE.test(m[1]) ? m[1] : null;
}

export function signupAnswer(v: unknown): { name: string; url: string } | null {
  const o = obj(v);
  const name = str(o?.name, 150), url = str(o?.url, 2048);
  return name && SIGNUP_NAME_RE.test(name) && url ? { name, url } : null;
}

export function policyVersionOf(v: unknown): string | null {
  const ver = obj(v)?.version;
  const s = typeof ver === 'number' && Number.isSafeInteger(ver) ? String(ver) : str(ver, 19);
  return s && POLICY_VERSION_RE.test(s) ? s : null;
}

export function enrollmentTokenAnswer(v: unknown): { tokenId: string; value: string; qrCode: string; expiresAt: string | null } | null {
  const o = obj(v);
  const name = str(o?.name, 200) ?? '';
  const m = name.match(/^enterprises\/[A-Za-z0-9_-]{1,64}\/enrollmentTokens\/([A-Za-z0-9_-]{1,100})$/);
  const value = str(o?.value, 256), qr = str(o?.qrCode, 4096);
  if (!m || !value || !ENROLLMENT_VALUE_RE.test(value) || !qr) return null;
  try { if (!obj(JSON.parse(qr))) return null; } catch { return null; }
  return { tokenId: m[1], value, qrCode: qr, expiresAt: isoOrNull(o?.expirationTimestamp) };
}

/** Google's device states, as Rem0te's enrollment states. Anything else is not a device Rem0te shows. */
const ENROLLMENT: Record<string, 'pending' | 'enrolled' | 'unenrolled'> = {
  PROVISIONING: 'pending', ACTIVE: 'enrolled', DISABLED: 'enrolled', LOST: 'enrolled', PREPARING_FOR_MIGRATION: 'enrolled', DELETED: 'unenrolled',
};
const SCOPE: Record<string, 'device' | 'work_profile'> = { DEVICE_OWNER: 'device', PROFILE_OWNER: 'work_profile' };

/**
 * A Google Device as the provider-neutral record schemas.ts parses, or null
 * when it is not one Rem0te can show. Ownership: only COMPANY_OWNED is
 * corporate; PERSONALLY_OWNED and anything unspecified is `byod`, so the
 * stricter keep-rule applies (parseDevice drops a BYOD serial).
 */
export function deviceRecord(v: unknown): Record<string, unknown> | null {
  const d = obj(v);
  if (!d) return null;
  const id = (str(d.name, 300) ?? '').match(DEVICE_NAME_RE)?.[1];
  const enrollmentState = ENROLLMENT[str(d.state, 40) ?? ''];
  const managementScope = SCOPE[str(d.managementMode, 40) ?? ''];
  if (!id || !PROVIDER_ID_RE.test(id) || !enrollmentState || !managementScope) return null;
  const hw = obj(d.hardwareInfo) ?? {}, sw = obj(d.softwareInfo) ?? {};
  const compliant = d.policyCompliant;
  const reason = Array.isArray(d.nonComplianceDetails) ? str(obj(d.nonComplianceDetails[0])?.nonComplianceReason, 60) : null;
  const version = str(sw.androidVersion, 20);
  return {
    id,
    name: null,
    platform: 'android',
    ownership: d.ownership === 'COMPANY_OWNED' ? 'corporate' : 'byod',
    managementScope,
    enrollmentState,
    enrolledAt: isoOrNull(d.enrollmentTime),
    complianceState: compliant === true ? 'compliant' : compliant === false ? 'noncompliant' : 'not_evaluated',
    complianceReason: compliant === false && reason ? reason.toLowerCase().replace(/_/g, ' ') : null,
    model: str(hw.model, 100),
    manufacturer: str(hw.manufacturer, 60) ?? str(hw.brand, 60),
    osVersion: version && /^[A-Za-z0-9 ._()-]{1,30}$/.test(version) ? `Android ${version}` : null,
    serialNumber: str(hw.serialNumber, 80),
    lastCheckInAt: isoOrNull(d.lastStatusReportTime),
  };
}

/** Google's command types, as 0096's kinds. Others (REBOOT, RESET_PASSWORD, eSIM…) are not shown. */
const KIND: Record<string, string> = { LOCK: 'lock', START_LOST_MODE: 'lost_mode_start', STOP_LOST_MODE: 'lost_mode_stop', RELINQUISH_OWNERSHIP: 'retire', WIPE: 'wipe' };

/**
 * An Operation as a provider-neutral command record, or null. The Operation
 * existing is Google's acceptance (`acceptedAt` its createTime); only `done`
 * without an error is the device's completion, and Google gives no
 * completion time, so it is the time Rem0te first saw it (`seenAt`). A WIPE
 * on a work profile removes only the work data.
 */
export function operationRecord(v: unknown, deviceId: string, scope: string, seenAt: Date): Record<string, unknown> | null {
  const o = obj(v);
  if (!o) return null;
  const opId = (str(o.name, 400) ?? '').match(OPERATION_NAME_RE)?.[1];
  const meta = obj(o.metadata) ?? {};
  let kind = KIND[str(meta.type, 40) ?? ''];
  const created = isoOrNull(meta.createTime);
  if (!opId || !kind || !created) return null;
  const id = `${deviceId}:${opId}`;
  if (!PROVIDER_ID_RE.test(id)) return null;
  if (kind === 'wipe' && scope === 'work_profile') kind = 'remove_managed_data';
  const dur = (str(meta.duration, 30) ?? '').match(DURATION_RE);
  const expiresAt = dur ? new Date(Date.parse(created) + Number(dur[1]) * 1000).toISOString() : null;
  const err = obj(o.error);
  const errorCode = str(meta.errorCode, 60);
  const failed = !!err || (!!errorCode && errorCode !== 'COMMAND_ERROR_CODE_UNSPECIFIED');
  const code = err ? `android:grpc_${Number.isInteger(err.code) ? String(err.code) : 'unknown'}` : `android:${(errorCode ?? 'unknown').toLowerCase()}`;
  return {
    id, deviceId, kind, requestedAt: created, expiresAt, acceptedAt: created,
    completedAt: o.done === true && !failed ? seenAt.toISOString() : null,
    failedAt: failed ? seenAt.toISOString() : null,
    failureCode: failed ? code.replace(/[^a-z0-9_.:-]/g, '_').slice(0, 56) : null,
  };
}

/** Google's error body (`{ error: { code, status } }`, or the token endpoint's `{ error: "invalid_grant" }`) as a short status, never its text. */
export function googleStatus(body: unknown): string | null {
  const o = obj(body);
  const e = o?.error;
  if (typeof e === 'string') return /^[a-z_]{1,40}$/.test(e) ? e : null;
  const s = str(obj(e)?.status, 40);
  return s && /^[A-Z_]{1,40}$/.test(s) ? s : null;
}
