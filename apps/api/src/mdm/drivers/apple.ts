/**
 * The `apple` driver (0.84 Harbor, docs/own-mdm.md M2, §93): Rem0te's own
 * Apple MDM server, read like any provider. It calls nothing: it reads the
 * AppleDevice and AppleCommand rows the Apple services keep (through the
 * AppleReader it is given) and hands the sync the provider-neutral records
 * schemas.ts parses. Only the sync writes MobileDevice (§90).
 *
 * Profile enrollment is corporate and device-wide, so every device is
 * `corporate` / `device`; compliance is `not_evaluated` (Rem0te has no
 * compliance policy for its own devices yet). The five inventory commands
 * appear as `sync` commands: sent is when the device fetched one (Rem0te is
 * the provider, so that is its acceptance), acknowledged is completed, an
 * error is the device's failure code, a command cancelled before it was
 * fetched is a rejection.
 *
 * 0.86 (§95): the three lost-device commands appear as `lock`,
 * `lost_mode_start` and `lost_mode_stop`, with the same meaning (accepted
 * when the device fetched it, completed on Acknowledged). send() puts one in
 * Rem0te's own queue through the reader's queueLostDevice, under the id
 * Rem0te's command row already holds, so the sync finds that row and never
 * makes a second one. It still makes no call of its own.
 */
import type { AppleDevice } from '@prisma/client';
import type { AppleReader } from '../apple/apple-mdm.service';
import { isLostType, LOST_TYPE_KIND, type LostType } from '../apple/protocol';
import { MdmSendError, type MdmDriver, type RawPage } from '../driver';
import type { LostDeviceKind } from '../lost-device';
import { PAGE_MAX } from '../schemas';

/** Each lost-device kind's Apple request type (0.86). */
export const APPLE_LOST_TYPE: Record<LostDeviceKind, LostType> = { lock: 'DeviceLock', lost_mode_start: 'EnableLostMode', lost_mode_stop: 'DisableLostMode' };

/** Commands older than this are not listed (they are final, and the listing stays bounded). */
export const APPLE_COMMAND_WINDOW_MS = 14 * 24 * 3_600_000;

const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);
const enrollment = (s: string) => (s === 'enrolled' ? 'enrolled' : s === 'checked_out' ? 'unenrolled' : 'pending');
const num = (b: bigint | null) => (b === null ? null : Number(b));

export function deviceRecord(d: AppleDevice) {
  return {
    id: d.id,
    name: d.deviceName,
    platform: d.platform,
    ownership: 'corporate',
    managementScope: 'device',
    enrollmentState: enrollment(d.state),
    enrolledAt: iso(d.enrolledAt),
    complianceState: 'not_evaluated',
    model: d.modelName ?? d.productName,
    manufacturer: 'Apple',
    osVersion: d.osVersion,
    serialNumber: d.serialNumber,
    storageTotalBytes: num(d.storageTotalBytes),
    storageFreeBytes: num(d.storageFreeBytes),
    lastCheckInAt: iso(d.lastSeenAt),
  };
}

export function commandRecord(c: Awaited<ReturnType<AppleReader['commands']>>[number]) {
  const failed = c.state === 'error' && c.respondedAt;
  const rejected = c.state === 'cancelled' && !c.sentAt;
  return {
    id: c.id,
    deviceId: c.appleDeviceId,
    kind: isLostType(c.requestType) ? LOST_TYPE_KIND[c.requestType] : 'sync',
    requestedAt: c.queuedAt.toISOString(),
    expiresAt: c.expiresAt.toISOString(),
    acceptedAt: iso(c.sentAt),
    rejectedAt: rejected ? c.queuedAt.toISOString() : null,
    rejectCode: rejected ? 'cancelled' : null,
    completedAt: c.state === 'acknowledged' ? iso(c.respondedAt) : null,
    failedAt: failed ? iso(c.respondedAt) : null,
    failureCode: failed ? (c.errorCode ?? 'apple:unknown').slice(0, 56) : null,
  };
}

export function appleDriver(reader: AppleReader): MdmDriver {
  return {
    provider: 'apple',
    label: 'Rem0te (Apple)',
    ready: () => ({ ok: true }),
    async listDevices(row, cursor): Promise<RawPage> {
      const rows = await reader.devices(row.customerId, cursor, PAGE_MAX);
      return { records: rows.map(deviceRecord), next: rows.length === PAGE_MAX ? rows[rows.length - 1].id : null };
    },
    async listCommands(row, cursor): Promise<RawPage> {
      const rows = await reader.commands(row.customerId, cursor, PAGE_MAX, new Date(Date.now() - APPLE_COMMAND_WINDOW_MS));
      return { records: rows.map(commandRecord), next: rows.length === PAGE_MAX ? rows[rows.length - 1].id : null };
    },
    async send(row, device, cmd) {
      const r = await reader.queueLostDevice({
        id: cmd.ref, customerId: row.customerId, appleDeviceId: device.providerDeviceId, type: APPLE_LOST_TYPE[cmd.kind],
        text: { message: cmd.message, phoneNumber: cmd.phoneNumber }, expiresAt: cmd.expiresAt,
      });
      if (!r.ok) throw new MdmSendError(r.code === 'not_supervised' ? 'unsupported' : r.code === 'not_enrolled' ? 'refused' : 'conflict');
      return { providerCommandId: cmd.ref, acceptedAt: null };
    },
  };
}
