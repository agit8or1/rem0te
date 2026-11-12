import { createHash, createPublicKey, verify as edVerify, type KeyObject } from 'node:crypto';
import { z } from 'zod';
import { UPDATE_ID_RE } from './catalog';

/**
 * Device-signed results (v0.34): reading what a signed agent signed.
 *
 * Shared, as code, by the portal and the approval signer, like catalog.ts.
 * Pure: zod and node:crypto only, no clock, no I/O, no Nest, no Prisma.
 *
 * Each signed agent (0.34+) holds an Ed25519 key it generated itself and
 * never exports (tools/windows-installer/internal/devsig). It signs every
 * final action result — the job, the sha256 of the exact plan, its enrolled
 * identity, the outcome and each update's final state — and every Windows
 * Update scan — what was offered, what history records installed, whether a
 * restart is pending. The portal stores both as received and relays them;
 * the approval signer verifies them against the key two approvers bound to
 * that computer in a patch policy before any later ring of the policy is
 * signed. So a compromised portal can still withhold or delay a result, but
 * cannot write one.
 *
 * This file only VERIFIES. Nothing in the portal or the signer constructs a
 * device statement or holds a device key, and the security invariants (§38)
 * check that the statement prefixes appear nowhere else in apps/api/src.
 */

export const DEVICE_SIGNED_SCHEMA = 'rem0te-device-signed/1';
export const RESULT_STATEMENT_SCHEMA = 'rem0te-action-result-statement/1';
export const SCAN_STATEMENT_SCHEMA = 'rem0te-patch-scan-statement/1';
/** Domain separation, exactly as the agent signs (devsig.ResultPrefix / ScanPrefix). */
const RESULT_PREFIX = 'rem0te-device-result-v1\n';
const SCAN_PREFIX = 'rem0te-device-scan-v1\n';

/** A computer's result key: base64 of a raw 32-byte Ed25519 public key. */
export const ResultKey = z.string().regex(/^[A-Za-z0-9+/]{43}=$/);

/** The envelope the agent writes beside a result or a scan. */
export const DeviceSigned = z.object({
  schema: z.literal(DEVICE_SIGNED_SCHEMA),
  key: ResultKey,
  statement: z.string().regex(/^[A-Za-z0-9+/]*={0,2}$/).max(24_000),
  sig: z.string().regex(/^[A-Za-z0-9+/]{86}==$/),
}).strict();
export type DeviceSigned = z.infer<typeof DeviceSigned>;

const Hex32 = z.string().regex(/^[a-f0-9]{32}$/);
const Hex64 = z.string().regex(/^[0-9a-f]{64}$/);
const Iso = z.string().datetime({ offset: true });
const UpdKey = z.string().regex(/^[0-9a-f-]{36}@[0-9]{1,7}$/);

/** What the agent signs about one job (devsig.ResultStatement). */
export const ResultStatement = z.object({
  schema: z.literal(RESULT_STATEMENT_SCHEMA),
  jobId: Hex32,
  /** sha256 of the signed plan bytes the computer verified; '' if the envelope did not decode. */
  planSha256: z.union([Hex64, z.literal('')]),
  rustdeskId: z.string().max(32),
  deviceSecretSha256: z.union([Hex64, z.literal('')]),
  outcome: z.enum(['succeeded', 'already_running', 'failed', 'refused', 'not_executed', 'uncertain', 'restart_required', 'partial', 'no_change']),
  reason: z.string().max(200).optional(),
  completedAt: Iso,
  updates: z.array(z.object({
    updateId: z.string().regex(UPDATE_ID_RE), revision: z.number().int(), state: z.string().max(40), hresult: z.string().max(12).optional(),
  }).strict()).max(20).optional(),
  rebootPending: z.boolean().optional(),
}).strict();
export type ResultStatement = z.infer<typeof ResultStatement>;

/** What the agent signs about one Windows Update scan (devsig.ScanStatement). */
export const ScanStatement = z.object({
  schema: z.literal(SCAN_STATEMENT_SCHEMA),
  rustdeskId: z.string().max(32),
  deviceSecretSha256: z.union([Hex64, z.literal('')]),
  scannedAt: Iso,
  error: z.boolean(),
  rebootPending: z.boolean(),
  offered: z.array(UpdKey).max(100),
  installed: z.array(UpdKey).max(50),
}).strict();
export type ScanStatement = z.infer<typeof ScanStatement>;

/** A result's outcome as an ActionTarget status: one table, used by the portal and the signer alike. */
export const RESULT_STATUS = {
  succeeded: 'SUCCEEDED', already_running: 'SUCCEEDED', restart_required: 'SUCCEEDED', no_change: 'SUCCEEDED',
  failed: 'FAILED', partial: 'FAILED', refused: 'REFUSED_BY_ENDPOINT', not_executed: 'NOT_EXECUTED', uncertain: 'UNKNOWN',
} as const satisfies Record<ResultStatement['outcome'], string>;

/** What a person compares with `rem0te-agent.exe status` on the computer: the first 16 hex of sha256(key), in fours. */
export function resultKeyFingerprint(key: string): string {
  const raw = Buffer.from(key, 'base64');
  return createHash('sha256').update(raw).digest('hex').slice(0, 16).replace(/(.{4})(?!$)/g, '$1-');
}

const SPKI_ED25519 = Buffer.from('302a300506032b6570032100', 'hex');
function publicKey(key: string): KeyObject | null {
  const raw = Buffer.from(key, 'base64');
  if (raw.length !== 32) return null;
  try { return createPublicKey({ key: Buffer.concat([SPKI_ED25519, raw]), format: 'der', type: 'spki' }); } catch { return null; }
}

export type Opened<T> = { ok: true; statement: T } | { ok: false; code: 'result_signature_invalid' | 'result_wrong_device'; message: string };

/**
 * Verify a device statement under the key already trusted for this computer.
 * The key the envelope names is never trusted for itself: a statement signed
 * by any other key — a forger's, or another computer's — is `result_wrong_device`.
 */
export function openDeviceStatement(kind: 'result', blob: unknown, trustedKey: string): Opened<ResultStatement>;
export function openDeviceStatement(kind: 'scan', blob: unknown, trustedKey: string): Opened<ScanStatement>;
export function openDeviceStatement(kind: 'result' | 'scan', blob: unknown, trustedKey: string): Opened<ResultStatement | ScanStatement> {
  const what = kind === 'result' ? 'result' : 'scan';
  const env = DeviceSigned.safeParse(blob);
  if (!env.success) return { ok: false, code: 'result_signature_invalid', message: `The ${what}'s signature is not a device signature.` };
  if (env.data.key !== trustedKey) return { ok: false, code: 'result_wrong_device', message: `The ${what} is signed by a key other than the one approved for this computer.` };
  const pub = publicKey(trustedKey);
  const bytes = Buffer.from(env.data.statement, 'base64');
  const ok = !!pub && edVerify(null, Buffer.concat([Buffer.from(kind === 'result' ? RESULT_PREFIX : SCAN_PREFIX, 'utf8'), bytes]), pub, Buffer.from(env.data.sig, 'base64'));
  if (!ok) return { ok: false, code: 'result_signature_invalid', message: `The ${what}'s signature does not verify under this computer's key.` };
  let json: unknown;
  try { json = JSON.parse(bytes.toString('utf8')); } catch { return { ok: false, code: 'result_signature_invalid', message: `The signed ${what} does not parse.` }; }
  const st = (kind === 'result' ? ResultStatement : ScanStatement).safeParse(json);
  if (!st.success) return { ok: false, code: 'result_signature_invalid', message: `The signed ${what} is not a ${what} statement.` };
  return { ok: true, statement: st.data };
}

/**
 * The key a signed blob says it is from, if the blob verifies under that key.
 * This proves only that whoever sent it holds the key — not whose computer it
 * is. The portal uses it to learn which key to put in a policy for two people
 * to approve; the signer never trusts a key this way.
 */
export function selfSignedScanKey(blob: unknown, identity: { rustdeskId: string; deviceSecretSha256: string }): string | null {
  const env = DeviceSigned.safeParse(blob);
  if (!env.success) return null;
  const o = openDeviceStatement('scan', blob, env.data.key);
  if (!o.ok || o.statement.rustdeskId !== identity.rustdeskId || o.statement.deviceSecretSha256 !== identity.deviceSecretSha256) return null;
  return env.data.key;
}
