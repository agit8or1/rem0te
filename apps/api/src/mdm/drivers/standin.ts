/**
 * The loopback MDM stand-in (0.80 Tablet). It is how the MDM model, the
 * sync and the console are proven before any provider account exists
 * (decision 18): the e2e suite runs a small HTTP server on 127.0.0.1 that
 * answers in the provider-neutral shape schemas.ts parses.
 *
 * It is reachable ONLY through common/safe-https.ts's testLoopbackAllowed:
 * NODE_ENV must be `test` and MDM_TEST_BASE_URL exactly
 * http://127.0.0.1:<port>[/path]. Under any other NODE_ENV, or with any other
 * value, ready() says no and the listing functions throw before a request
 * is made, so a connector row naming the stand-in on a production server
 * reads nothing. There is no fallback host: this file names none.
 *
 *   GET <base>/mdm/v1/tenants/<externalTenantId>/devices[?cursor=<c>]
 *   GET <base>/mdm/v1/tenants/<externalTenantId>/commands[?cursor=<c>]
 *     → { "devices" | "commands": [...], "next": <cursor> | null }
 *
 * Nothing is sent but the tenant id and the cursor, both charset-checked.
 *
 * 0.86: it takes no command. `send()` refuses (`unsupported`) before
 * anything is read, and the console never offers one (lost-device.ts).
 */
import type { MdmConnector } from '@prisma/client';
import { OutboundError, safeGet, testLoopbackAllowed } from '../../common/safe-https';
import { MdmDriverError, MdmSendError, type MdmDriver, type RawPage } from '../driver';
import { CURSOR_RE, EXTERNAL_TENANT_RE } from '../model';
import { CommandPage, DevicePage } from '../schemas';

export const STANDIN_TIMEOUT_MS = 10_000;
export const STANDIN_MAX_BYTES = 512 * 1024;

/** The stand-in's base URL, or null when this process may not use it. Read nowhere else. */
export function standinBase(): string | null {
  const raw = (process.env.MDM_TEST_BASE_URL ?? '').replace(/\/+$/, '');
  return raw && testLoopbackAllowed(raw) ? raw : null;
}

function url(row: MdmConnector, what: 'devices' | 'commands', cursor: string | null): string {
  const base = standinBase();
  if (!base) throw new MdmDriverError('not_ready', 'The stand-in is available only to the test suites.');
  if (!EXTERNAL_TENANT_RE.test(row.externalTenantId)) throw new MdmDriverError('refused', 'The connector\'s provider tenant id is not valid.');
  if (cursor !== null && !CURSOR_RE.test(cursor)) throw new MdmDriverError('bad_response', 'The provider returned an invalid cursor.');
  const u = `${base}/mdm/v1/tenants/${row.externalTenantId}/${what}${cursor ? `?cursor=${cursor}` : ''}`;
  // safe-https checks it again; this is only to fail with our own code first.
  if (!testLoopbackAllowed(u)) throw new MdmDriverError('refused', 'The stand-in address was refused.');
  return u;
}

async function getPage(row: MdmConnector, what: 'devices' | 'commands', cursor: string | null): Promise<RawPage> {
  const target = url(row, what, cursor);
  let res;
  try {
    res = await safeGet(target, { accept: 'application/json' }, { timeoutMs: STANDIN_TIMEOUT_MS, maxBytes: STANDIN_MAX_BYTES });
  } catch (e) {
    throw new MdmDriverError('unreachable', e instanceof OutboundError ? e.code : 'UNREACHABLE');
  }
  if (res.status === 401 || res.status === 403 || res.status === 404) throw new MdmDriverError('refused', `HTTP ${res.status}`);
  if (res.status !== 200) throw new MdmDriverError('unreachable', `HTTP ${res.status}`);
  let json: unknown;
  try { json = JSON.parse(res.body.toString('utf8')); } catch { throw new MdmDriverError('bad_response', 'not JSON'); }
  if (what === 'devices') {
    const p = DevicePage.safeParse(json);
    if (!p.success) throw new MdmDriverError('bad_response', 'not a device page');
    return { records: p.data.devices, next: p.data.next };
  }
  const p = CommandPage.safeParse(json);
  if (!p.success) throw new MdmDriverError('bad_response', 'not a command page');
  return { records: p.data.commands, next: p.data.next };
}

export const standinDriver: MdmDriver = {
  provider: 'standin',
  label: 'Stand-in (tests only)',
  ready(row) {
    if (!standinBase()) return { ok: false, reason: 'The stand-in is a test fixture: it answers only to the test suites (NODE_ENV=test and a loopback address). Connecting a real provider comes in a later release.' };
    if (!EXTERNAL_TENANT_RE.test(row.externalTenantId)) return { ok: false, reason: 'The connector\'s provider tenant id is not valid.' };
    return { ok: true };
  },
  listDevices: (row, cursor) => getPage(row, 'devices', cursor),
  listCommands: (row, cursor) => getPage(row, 'commands', cursor),
  send: () => Promise.reject(new MdmSendError('unsupported')),
};
