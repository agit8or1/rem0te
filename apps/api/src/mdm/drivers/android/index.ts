/**
 * The `android` driver (0.85 Mooring, docs/own-mdm.md M3, §94): a business's
 * Android enterprise, read through the Android Management API. The sync
 * calls it inside MDM_SWEEP, after its `integration` pause check, and is the
 * only writer of MobileDevice and of a command's later state (§90).
 *
 * `ready()` never calls out: the connector must name an enterprise id. The
 * sealed key is opened in memory per call (AndroidReader.credential);
 * without one the call is `not_ready` before any request.
 *
 * Commands (0.86, M4, §95; decision 30). Operations exist only for commands
 * an EMM issued, and Rem0te is the only EMM of its enterprises, so the
 * driver no longer lists each device's Operations (0.85 read them per
 * device, at most 250 devices a pass). listCommands reads, by its own name,
 * the Operation of each OPEN command Rem0te issued on this connector
 * (AndroidReader.openCommands): OPERATIONS_PER_PAGE a command page, so at
 * most COMMAND_PAGES × 25 = 250 operations.get a pass, bounded by the open
 * commands and not by the size of the enterprise. send() issues one LOCK,
 * START_LOST_MODE or STOP_LOST_MODE through devices.issueCommand; its
 * Operation is Google's acceptance.
 */
import type { MdmConnector } from '@prisma/client';
import { MdmDriverError, MdmSendError, type MdmDriver, type RawPage } from '../../driver';
import { AmapiError, getOperation, issueCommand, listDevices, type AndroidCredential } from './amapi';
import { deviceRecord, ENTERPRISE_ID_RE, operationIdsOf, operationRecord } from './shape';

export const OPERATIONS_PER_PAGE = 25;

export interface AndroidReader {
  /** The service-account key, opened in memory for this call; null when none is sealed. */
  credential(): Promise<AndroidCredential | null>;
  /** This connector's open commands Rem0te issued (0.86), after `after` by command id, for operations.get. */
  openCommands(connectorId: string, after: string | null, take: number): Promise<Array<{ providerCommandId: string; managementScope: string }>>;
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

function sendError(e: unknown): MdmSendError {
  if (e instanceof MdmSendError) return e;
  if (e instanceof MdmDriverError) return new MdmSendError(e.code === 'not_ready' ? 'not_ready' : e.code === 'refused' ? 'refused' : e.code === 'bad_response' ? 'bad_response' : 'unreachable');
  if (e instanceof AmapiError) {
    return new MdmSendError(e.code === 'not_ready' ? 'not_ready' : e.code === 'quota' ? 'quota' : e.code === 'conflict' ? 'conflict'
      : e.code === 'bad_key' || e.code === 'permission_denied' || e.code === 'not_found' ? 'refused'
        : e.code === 'bad_response' ? (e.httpStatus === 400 ? 'refused' : 'bad_response') : 'unreachable');
  }
  return new MdmSendError('unreachable');
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
        const open = await reader.openCommands(row.id, cursor, OPERATIONS_PER_PAGE);
        if (!open.length) return { records: [], next: null };
        const c = await cred(reader);
        const e = enterprise(row);
        const records: unknown[] = [];
        const seenAt = new Date();
        for (const o of open) {
          const ids = operationIdsOf(o.providerCommandId);
          if (!ids) continue;
          const op = await getOperation(c, e, ids.deviceId, ids.operationId);
          const r = op === null ? null : operationRecord(op, ids.deviceId, o.managementScope, seenAt);
          // Only the Operation Rem0te asked about: a server answering with another one is not read.
          if (r && r.id === o.providerCommandId) records.push(r);
        }
        return { records, next: open.length === OPERATIONS_PER_PAGE ? open[open.length - 1].providerCommandId : null };
      } catch (e) { throw driverError(e); }
    },
    async send(row, device, cmd) {
      try {
        const c = await cred(reader);
        const ttl = Math.max(60, Math.round((cmd.expiresAt.getTime() - Date.now()) / 1000));
        const op = await issueCommand(c, enterprise(row), device.providerDeviceId, cmd.kind, { message: cmd.message, phoneNumber: cmd.phoneNumber }, ttl);
        return { providerCommandId: op.providerCommandId, acceptedAt: op.createdAt ? new Date(op.createdAt) : new Date() };
      } catch (e) { throw sendError(e); }
    },
  };
}
