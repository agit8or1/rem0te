/**
 * The `android` driver (0.85 Mooring, docs/own-mdm.md M3, §94): a business's
 * Android enterprise, read through the Android Management API. Read-only:
 * devices.list (paged, only DEVICE_FIELDS) and each device's Operations.
 * The sync calls it inside MDM_SWEEP, after its `integration` pause check,
 * and is the only writer of MobileDevice and MdmCommand (§90).
 *
 * `ready()` never calls out: the connector must name an enterprise id. The
 * sealed key is opened in memory per listing (AndroidReader.credential);
 * without one the listing is `not_ready` before any request.
 *
 * Commands: Operations exist only for commands someone issued, and Rem0te
 * issues none in M3, so a real enterprise will list none until M4. Each
 * command page covers OPERATION_DEVICES_PER_PAGE devices (one call each), so
 * a pass makes at most COMMAND_PAGES × 25 = 250 operation calls per
 * connector. An enterprise with more devices syncs as `partial`: every
 * device is read, but Operations only for the first 250 by id.
 */
import type { MdmConnector } from '@prisma/client';
import { MdmDriverError, type MdmDriver, type RawPage } from '../../driver';
import { AmapiError, listDevices, listOperations, type AndroidCredential } from './amapi';
import { deviceRecord, ENTERPRISE_ID_RE, operationRecord } from './shape';

export const OPERATION_DEVICES_PER_PAGE = 25;

export interface AndroidReader {
  /** The service-account key, opened in memory for this listing; null when none is sealed. */
  credential(): Promise<AndroidCredential | null>;
  /** This connector's devices (still reported), after `after` by provider id, for the Operations listing. */
  deviceIds(connectorId: string, after: string | null, take: number): Promise<Array<{ providerDeviceId: string; managementScope: string }>>;
}

function driverError(e: unknown): MdmDriverError {
  if (e instanceof MdmDriverError) return e;
  if (e instanceof AmapiError) {
    const code = e.code === 'not_ready' ? 'not_ready'
      : e.code === 'bad_key' || e.code === 'permission_denied' || e.code === 'not_found' ? 'refused'
        : e.code === 'bad_response' ? 'bad_response' : 'unreachable';
    return new MdmDriverError(code, e.code);
  }
  return new MdmDriverError('unreachable', 'UNREACHABLE');
}

async function cred(reader: AndroidReader): Promise<AndroidCredential> {
  const c = await reader.credential();
  if (!c) throw new MdmDriverError('not_ready', 'No service-account key is sealed.');
  return c;
}

export function androidDriver(reader: AndroidReader): MdmDriver {
  const enterprise = (row: MdmConnector) => {
    if (!ENTERPRISE_ID_RE.test(row.externalTenantId)) throw new MdmDriverError('refused', 'The connector does not name an Android enterprise.');
    return row.externalTenantId;
  };
  return {
    provider: 'android',
    label: 'Rem0te (Android)',
    ready(row) {
      return ENTERPRISE_ID_RE.test(row.externalTenantId) ? { ok: true } : { ok: false, reason: 'The connector does not name an Android enterprise.' };
    },
    async listDevices(row, cursor): Promise<RawPage> {
      try {
        const page = await listDevices(await cred(reader), enterprise(row), cursor);
        // A device Rem0te cannot show becomes a record the sync's parser refuses, so it is counted as skipped.
        return { records: page.devices.map((d) => deviceRecord(d) ?? { skipped: true }), next: page.next };
      } catch (e) { throw driverError(e); }
    },
    async listCommands(row, cursor): Promise<RawPage> {
      try {
        const c = await cred(reader);
        const e = enterprise(row);
        const devices = await reader.deviceIds(row.id, cursor, OPERATION_DEVICES_PER_PAGE);
        const records: unknown[] = [];
        const seenAt = new Date();
        for (const d of devices) {
          for (const op of await listOperations(c, e, d.providerDeviceId)) {
            const r = operationRecord(op, d.providerDeviceId, d.managementScope, seenAt);
            if (r) records.push(r);
          }
        }
        return { records, next: devices.length === OPERATION_DEVICES_PER_PAGE ? devices[devices.length - 1].providerDeviceId : null };
      } catch (e) { throw driverError(e); }
    },
  };
}
