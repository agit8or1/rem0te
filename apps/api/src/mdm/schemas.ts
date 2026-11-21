/**
 * What an MDM driver hands the sync (0.80 Tablet), parsed strictly before
 * anything is stored. Pure: zod, ./model and common/text only.
 *
 * Every driver turns its provider's answer into these provider-neutral
 * records (the stand-in's wire shape is exactly them). A page that is not the
 * shape fails the sync (`bad_response`); one record that is not is skipped
 * and counted, so a single odd device cannot stop the rest.
 *
 * What is kept, and what is not:
 *   - The serial number only for a corporate device. A personal (BYOD)
 *     device's serial is dropped here: Rem0te manages only its work profile
 *     or managed data, and has no use for the hardware identity of
 *     somebody's own phone. A corporate serial is kept for asset records
 *     and, later, warranty (docs/mobile-devices.md).
 *   - Never the IMEI, MEID, phone number, Wi-Fi or Bluetooth MAC, or the
 *     signed-in user: they are not in the schema, so a provider that sends
 *     them has them stripped. The IMEI identifies a phone line as much as a
 *     device, and nothing in 3.1–3.4 needs it: commands address the
 *     provider's own device id.
 *   - Free text (name, model, the compliance reason) has control characters
 *     removed and a length cap, and the console draws it as text.
 */
import { z } from 'zod';
import { CONTROLS_ALL } from '../common/text';
import {
  COMMAND_KINDS, COMPLIANCE_STATES, CURSOR_RE, ENROLLMENT_STATES, FAILURE_CODE_RE, MANAGEMENT_SCOPES, OWNERSHIPS, PLATFORMS,
  PROVIDER_ID_RE, SERIAL_RE, type ComplianceState, type ManagementScope, type Platform,
} from './model';

/** At most this many records in one page; a driver asks for no more. */
export const PAGE_MAX = 100;
const MAX_BYTES = 2 ** 50; // 1 PiB: a bound, not a real size

export const cleanText = (v: string, max: number): string =>
  v.replace(CONTROLS_ALL, ' ').replace(/\s+/g, ' ').trim().slice(0, max);

const iso = z.string().max(40).refine((s) => !Number.isNaN(Date.parse(s)), 'not a date').transform((s) => new Date(s));
const text = (max: number) => z.string().max(max * 4).transform((s) => cleanText(s, max));
const bytes = z.number().int().min(0).max(MAX_BYTES);

/** Which management scope a platform can have (Android work profile, Apple User Enrollment). */
export function scopeFits(platform: Platform, scope: ManagementScope): boolean {
  if (scope === 'work_profile') return platform === 'android';
  if (scope === 'user_enrollment') return platform === 'ios' || platform === 'ipados';
  return true;
}

const RawDevice = z.object({
  id: z.string().regex(PROVIDER_ID_RE),
  name: text(100).nullish(),
  platform: z.enum(PLATFORMS),
  ownership: z.enum(OWNERSHIPS),
  managementScope: z.enum(MANAGEMENT_SCOPES),
  enrollmentState: z.enum(ENROLLMENT_STATES).refine((s) => s !== 'not_reported', 'Rem0te decides not_reported'),
  enrolledAt: iso.nullish(),
  complianceState: z.enum(COMPLIANCE_STATES),
  complianceReason: text(200).nullish(),
  model: text(100).nullish(),
  manufacturer: text(60).nullish(),
  osVersion: z.string().regex(/^[A-Za-z0-9 ._()-]{1,40}$/).nullish(),
  serialNumber: z.string().max(80).nullish(),
  storageTotalBytes: bytes.nullish(),
  storageFreeBytes: bytes.nullish(),
  lastCheckInAt: iso.nullish(),
}); // unknown keys (imei, phone number, user…) are stripped by zod's default

export interface DeviceRecord {
  providerDeviceId: string;
  name: string | null;
  platform: Platform;
  ownership: (typeof OWNERSHIPS)[number];
  managementScope: ManagementScope;
  enrollmentState: Exclude<(typeof ENROLLMENT_STATES)[number], 'not_reported'>;
  enrolledAt: Date | null;
  complianceState: ComplianceState;
  complianceReason: string | null;
  model: string | null;
  manufacturer: string | null;
  osVersion: string | null;
  serialNumber: string | null;
  storageTotalBytes: bigint | null;
  storageFreeBytes: bigint | null;
  lastCheckInAt: Date | null;
}

export type Parsed<T> = { ok: true; value: T } | { ok: false; reason: string };

export function parseDevice(raw: unknown): Parsed<DeviceRecord> {
  const p = RawDevice.safeParse(raw);
  if (!p.success) return { ok: false, reason: 'shape' };
  const d = p.data;
  if (!scopeFits(d.platform, d.managementScope)) return { ok: false, reason: 'scope_platform' };
  const total = d.storageTotalBytes ?? null, free = d.storageFreeBytes ?? null;
  if (total !== null && free !== null && free > total) return { ok: false, reason: 'storage' };
  const serial = d.ownership === 'corporate' && d.serialNumber && SERIAL_RE.test(d.serialNumber.trim()) ? d.serialNumber.trim().toUpperCase() : null;
  return {
    ok: true,
    value: {
      providerDeviceId: d.id,
      name: d.name || null,
      platform: d.platform,
      ownership: d.ownership,
      managementScope: d.managementScope,
      enrollmentState: d.enrollmentState as DeviceRecord['enrollmentState'],
      enrolledAt: d.enrolledAt ?? null,
      complianceState: d.complianceState,
      // A reason only explains a state that needs one.
      complianceReason: d.complianceState === 'compliant' || d.complianceState === 'not_evaluated' ? null : d.complianceReason || null,
      model: d.model || null,
      manufacturer: d.manufacturer || null,
      osVersion: d.osVersion ?? null,
      serialNumber: serial,
      storageTotalBytes: total === null ? null : BigInt(total),
      storageFreeBytes: free === null ? null : BigInt(free),
      lastCheckInAt: d.lastCheckInAt ?? null,
    },
  };
}

const code = z.string().regex(FAILURE_CODE_RE);
const RawCommand = z.object({
  id: z.string().regex(PROVIDER_ID_RE),
  deviceId: z.string().regex(PROVIDER_ID_RE),
  kind: z.enum(COMMAND_KINDS),
  requestedAt: iso,
  expiresAt: iso.nullish(),
  acceptedAt: iso.nullish(),
  rejectedAt: iso.nullish(),
  rejectCode: code.nullish(),
  completedAt: iso.nullish(),
  failedAt: iso.nullish(),
  failureCode: code.nullish(),
});

export interface CommandRecord {
  providerCommandId: string;
  providerDeviceId: string;
  kind: (typeof COMMAND_KINDS)[number];
  requestedAt: Date;
  expiresAt: Date | null;
  acceptedAt: Date | null;
  rejected: { at: Date; code: string } | null;
  completedAt: Date | null;
  failed: { at: Date; code: string } | null;
}

export function parseCommand(raw: unknown): Parsed<CommandRecord> {
  const p = RawCommand.safeParse(raw);
  if (!p.success) return { ok: false, reason: 'shape' };
  const c = p.data;
  // A time without its code, or a code without its time, is not a report.
  if (!!c.rejectedAt !== !!c.rejectCode || !!c.failedAt !== !!c.failureCode) return { ok: false, reason: 'shape' };
  return {
    ok: true,
    value: {
      providerCommandId: c.id, providerDeviceId: c.deviceId, kind: c.kind, requestedAt: c.requestedAt, expiresAt: c.expiresAt ?? null,
      acceptedAt: c.acceptedAt ?? null,
      rejected: c.rejectedAt && c.rejectCode ? { at: c.rejectedAt, code: c.rejectCode } : null,
      completedAt: c.completedAt ?? null,
      failed: c.failedAt && c.failureCode ? { at: c.failedAt, code: c.failureCode } : null,
    },
  };
}

/** One page of a provider listing: the records, unparsed, and the cursor for the next page. */
const cursor = z.string().regex(CURSOR_RE).nullable();
export const DevicePage = z.object({ devices: z.array(z.unknown()).max(PAGE_MAX), next: cursor });
export const CommandPage = z.object({ commands: z.array(z.unknown()).max(PAGE_MAX), next: cursor });
