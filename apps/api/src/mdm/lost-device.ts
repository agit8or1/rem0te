/**
 * Lost-device commands (0.86 Lighthouse, docs/own-mdm.md M4, §95): which of
 * them a device can take, and what a request may carry. Pure: it imports
 * only ./model. No clock, no database, no provider.
 *
 * Three kinds, in this order, and nothing else can be sent from Rem0te:
 *
 *   lock              Apple DeviceLock; Android LOCK.
 *   lost_mode_start   Apple EnableLostMode; Android START_LOST_MODE.
 *   lost_mode_stop    Apple DisableLostMode; Android STOP_LOST_MODE.
 *
 * Erase, wipe, retire and removing work data are M5's, behind a second
 * person and the always-ask `mdm.destructive` check (decision 16). They are
 * not in this list, in the migration's CHECK, or in any provider's command
 * table, so nothing can send one.
 *
 * Who can take what (the vendors' own pages, docs/own-mdm.md "The first
 * commands" and the Android command table):
 *
 *   - Apple lock: every enrolled device, supervised or not (Apple lists
 *     DeviceLock as allowed under user enrollment too).
 *   - Apple lost mode: supervised devices only, never under user enrollment.
 *     Supervision is what the device itself reported (DeviceInformation's
 *     IsSupervised). Unknown is not supervised: the command is refused,
 *     never sent to find out.
 *   - Android lock: every enrolled device. On a work profile with its own
 *     challenge it locks only the profile.
 *   - Android lost mode: company-owned devices only (fully managed, or a
 *     work profile on a company-owned device). A personal device is refused.
 *
 * What a request may carry: a message and a contact phone number, shown on
 * the device's lock screen, for an Apple lock and for starting lost mode
 * (lost mode needs at least one). An Android lock shows none, so a message
 * is refused there rather than silently dropped. Both are bounded and
 * charset-checked here; neither is ever written to an audit row or a log
 * line (only whether one was given), and neither is kept on a Rem0te
 * command (MdmCommand). Apple's queue holds them until the command is final
 * (0103's trigger clears them); Android's are sent once and not stored.
 */
import { isOneOf, type CommandKind, type ManagementScope, type Ownership, type Platform, type Provider } from './model';

/** The only kinds Rem0te sends (0103 CHECK on portal commands, in order). */
export const LOST_DEVICE_KINDS = ['lock', 'lost_mode_start', 'lost_mode_stop'] as const satisfies readonly CommandKind[];
export type LostDeviceKind = (typeof LOST_DEVICE_KINDS)[number];

/** A lost-device command waits this long for the device, then expires (Apple's queue TTL; Android's Command.duration). */
export const LOST_COMMAND_TTL_MS = 7 * 24 * 3_600_000;

/** The lock-screen message: printable, at most this many characters. */
export const MESSAGE_MAX = 160;
/** A contact phone number for the finder: digits and the usual punctuation. */
export const PHONE_RE = /^[+0-9][0-9 ().-]{2,30}$/;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001F\u007F-\u009F\u2028\u2029\u202A-\u202E\u2066-\u2069]/;

export const LOST_KIND_LABEL: Record<LostDeviceKind, string> = { lock: 'Lock', lost_mode_start: 'Start lost mode', lost_mode_stop: 'Stop lost mode' };

export interface LostDeviceRequest { kind: LostDeviceKind; message: string | null; phoneNumber: string | null }
export type ParsedRequest = { ok: true; value: LostDeviceRequest } | { ok: false; code: string; message: string };

/** Does this kind take a message and phone number on this provider? */
export function takesMessage(kind: LostDeviceKind, provider: Provider | string): boolean {
  if (kind === 'lost_mode_start') return true;
  return kind === 'lock' && provider === 'apple';
}

/**
 * The request body, checked before anything is read: the kind, and an
 * optional message and phone number. Blank is absent. Control characters,
 * bidi overrides and over-long text are refused, never trimmed into
 * something else.
 */
export function parseLostDeviceRequest(body: unknown): ParsedRequest {
  const b = body && typeof body === 'object' && !Array.isArray(body) ? body as Record<string, unknown> : {};
  if (!isOneOf(LOST_DEVICE_KINDS, b.kind)) return { ok: false, code: 'MOBILE_COMMAND_INVALID', message: 'Choose lock, start lost mode or stop lost mode.' };
  const text = (v: unknown): string | null | false => {
    if (v === undefined || v === null) return null;
    if (typeof v !== 'string') return false;
    const s = v.replace(/\s+/g, ' ').trim();
    return s ? s : null;
  };
  const message = text(b.message), phone = text(b.phoneNumber);
  if (message === false || phone === false) return { ok: false, code: 'MOBILE_COMMAND_INVALID', message: 'The message and phone number must be text.' };
  if (message !== null && (message.length > MESSAGE_MAX || CONTROL.test(message))) {
    return { ok: false, code: 'MOBILE_MESSAGE_INVALID', message: `The message must be at most ${MESSAGE_MAX} printable characters.` };
  }
  if (phone !== null && !PHONE_RE.test(phone)) return { ok: false, code: 'MOBILE_PHONE_INVALID', message: 'The phone number may hold only digits, spaces, +, (, ), . and -.' };
  if (b.kind === 'lost_mode_stop' && (message !== null || phone !== null)) {
    return { ok: false, code: 'MOBILE_MESSAGE_NOT_TAKEN', message: 'Stopping lost mode takes no message or phone number.' };
  }
  if (b.kind === 'lost_mode_start' && message === null && phone === null) {
    return { ok: false, code: 'MOBILE_MESSAGE_REQUIRED', message: 'Lost mode shows a message or a phone number on the lock screen: give at least one.' };
  }
  return { ok: true, value: { kind: b.kind, message, phoneNumber: phone } };
}

/** What Rem0te knows about a device when deciding. `supervised` is Apple's (null: not reported, or not Apple). */
export interface DeviceFacts {
  provider: Provider | string;
  platform: Platform | string;
  ownership: Ownership | string;
  managementScope: ManagementScope | string;
  enrollmentState: string;
  supervised: boolean | null;
  connectorEnabled: boolean;
}

export interface Refusal { code: string; status: 403 | 409; message: string }

/**
 * Why this device cannot take this command, or null when it can. The same
 * answer drives the console's buttons and the send path; the send path
 * asks again after the fresh confirmation, so a device that changed in
 * between is refused then.
 */
export function lostDeviceRefusal(kind: LostDeviceKind, d: DeviceFacts, req?: Pick<LostDeviceRequest, 'message' | 'phoneNumber'>): Refusal | null {
  if (d.provider !== 'apple' && d.provider !== 'android') {
    return { code: 'MOBILE_COMMAND_UNSUPPORTED', status: 409, message: 'This provider cannot be sent commands from Rem0te.' };
  }
  if (!d.connectorEnabled) return { code: 'MOBILE_CONNECTOR_DISABLED', status: 409, message: 'This device\'s connector is disabled.' };
  if (d.enrollmentState !== 'enrolled') return { code: 'MOBILE_DEVICE_NOT_ENROLLED', status: 409, message: 'The device is not enrolled, so it would never receive the command.' };
  if (req && !takesMessage(kind, d.provider) && (req.message !== null || req.phoneNumber !== null)) {
    return { code: 'MOBILE_MESSAGE_NOT_TAKEN', status: 409, message: 'This command shows no message on this platform: leave the message and phone number empty.' };
  }
  if (kind === 'lock') return null;
  if (d.provider === 'apple') {
    if (d.managementScope !== 'device') {
      return { code: 'LOST_MODE_UNAVAILABLE', status: 409, message: 'Lost mode is not available on a device enrolled for managed apps and data only.' };
    }
    if (d.supervised !== true) {
      return {
        code: 'LOST_MODE_NEEDS_SUPERVISION', status: 409,
        message: d.supervised === false
          ? 'Lost mode works only on a supervised iPhone or iPad (Apple Business Manager or Apple Configurator). This one is not supervised: lock it instead.'
          : 'This device has not reported whether it is supervised, and lost mode works only on a supervised one. Lock it instead, or wait for its next inventory.',
      };
    }
    return null;
  }
  if (d.ownership !== 'corporate') {
    return { code: 'LOST_MODE_NOT_ON_PERSONAL', status: 409, message: 'Android lost mode is only for company-owned devices. This one is personal: lock it instead.' };
  }
  return null;
}

/** Every kind, with whether this device can take it now (the console's buttons). */
export function lostDeviceOptions(d: DeviceFacts) {
  return LOST_DEVICE_KINDS.map((kind) => {
    const r = lostDeviceRefusal(kind, d);
    return { kind, label: LOST_KIND_LABEL[kind], available: r === null, code: r?.code ?? null, reason: r?.message ?? null, takesMessage: takesMessage(kind, d.provider) };
  });
}
