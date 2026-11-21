#!/usr/bin/env node
/**
 * 0.78 Courier: file transfer's pure decisions (src/remote-ops/file-policy.ts
 * and limits.ts). This suite checks:
 *   - that they agree with the agent's Go code (internal/remote: limits.go,
 *     the shared path fixture testdata/file-paths.json) and with migration
 *     0095's CHECKs;
 *   - that the browser's incremental SHA-256 (apps/web/lib/sha256.ts)
 *     matches node:crypto;
 *   - the capabilities and the confirm key.
 * No database. Needs `nest build` (dist/).
 *
 * The behavioural proof over HTTP, with the agent's real worker, is
 * e2e-files.mjs. The Windows file system is the lab's
 * internal/remote/lab_files_windows_test.go.
 */
import { createRequire } from 'node:module';
import { createHash, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..', '..', '..');
const dist = (f) => {
  for (const base of [path.join(here, '..', 'dist'), path.join(here, '..', 'dist', 'src')]) {
    try { return require(path.join(base, f)); } catch (e) { if (e.code !== 'MODULE_NOT_FOUND') throw e; }
  }
  throw new Error(`dist/${f} not found: run nest build first`);
};
const F = dist('remote-ops/file-policy.js');
const L = dist('remote-ops/limits.js');
const CAPS = dist('rbac/capabilities.js');
const C = dist('security-controls/confirm-catalog.js');

let pass = 0; const fails = [];
const check = (name, ok, detail = '') => { if (ok) pass++; else fails.push(name); console.log(`${ok ? '✓' : '✗'} ${name}${ok || !detail ? '' : `\n    ${detail}`}`); };
const read = (p) => readFileSync(path.join(root, p), 'utf8');
const sha = (b) => createHash('sha256').update(b).digest('hex');

// ── Limits agree with the agent and the migration ─────────────────────────
const go = read('tools/windows-installer/internal/remote/limits.go');
const goConst = (name) => { const m = go.match(new RegExp(`\\b${name}\\s*=\\s*([^\\n/]+)`)); return m ? m[1].trim() : null; };
const goNum = (name) => { const v = goConst(name); return v ? Function(`return ${v}`)() : null; };
const goList = (name) => { const m = go.match(new RegExp(`${name}\\s*=\\s*\\[\\]string\\{([^}]*)\\}`)); return m ? [...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]) : null; };
check('the chunk is 512 KiB on both sides', L.FILE_CHUNK_BYTES === 512 * 1024 && goNum('FileChunkBytes') === L.FILE_CHUNK_BYTES, goConst('FileChunkBytes'));
check('the hard limit is 60 minutes on both sides', L.FILE_TRANSFER_MAX_MS === 60 * 60_000 && goConst('FileTransferMax') === '60 * time.Minute');
check('the largest file is 2 GiB on both sides', L.FILE_MAX_MB_MAX * 1048576 === goNum('FileMaxBytes') && L.FILE_MAX_MB_MAX === 2048);
check('the default limit is 100 MB', L.FILE_MAX_MB_DEFAULT === 100);
check('the path length agrees (4–1,024)', goNum('FilePathMin') === L.FILE_PATH_MIN && goNum('FilePathMax') === L.FILE_PATH_MAX && L.FILE_PATH_MAX === 1024);
check('live transfers per computer agree (2)', goNum('FileLiveMax') === L.FILE_LIVE_PER_COMPUTER && L.FILE_LIVE_PER_COMPUTER === 2);
check('the agent\'s error codes agree, in order', JSON.stringify(goList('AgentFileErrors')) === JSON.stringify([...L.AGENT_FILE_ERRORS]), JSON.stringify(goList('AgentFileErrors')));
check('the reserved names agree, in order', JSON.stringify(goList('ReservedNames')) === JSON.stringify([...L.RESERVED_NAMES]));
check('the agent build that carries it is 0.78.0', L.FILES_MIN_AGENT === '0.78.0');
const mig = read('apps/api/prisma/migrations/0095_file_transfers/migration.sql');
check('0095 CHECKs the two directions', /"direction" IN \('to_computer', 'from_computer'\)/.test(mig));
check('0095 CHECKs every end reason', L.FILE_END_REASONS.every((r) => mig.includes(`'${r}'`)));
check('0095 CHECKs the hard limit (60 minutes)', /"notAfter" <= "createdAt" \+ interval '60 minutes'/.test(mig));
check('0095 CHECKs the chunk size and window', /octet_length\("data"\) BETWEEN 1 AND 524288/.test(mig) && /"inSeq" - "ackSeq" <= 8/.test(mig) && L.FILE_WINDOW_CHUNKS === 8);
check('0095 CHECKs the size limit setting (1–2048 MB, default 100)', /"fileMaxMb" INTEGER NOT NULL DEFAULT 100/.test(mig) && /"fileMaxMb" BETWEEN 1 AND 2048/.test(mig));
check('0095 makes an upload declare its size and SHA-256', /"direction" = 'from_computer' OR \("size" IS NOT NULL AND "sha256" IS NOT NULL\)/.test(mig));
check('0095 keeps a transfer in its computer\'s business (trigger)', /file_transfer_business/.test(mig));
check('0095 refuses ".." and "/" in a stored path', /position\('\.\.' in "path"\) = 0/.test(mig) && /position\('\/' in "path"\) = 0/.test(mig));

// ── The path rule: the shared fixture, the same answers as Go ─────────────
const fx = JSON.parse(read('tools/windows-installer/internal/remote/testdata/file-paths.json'));
const wrong = fx.cases.filter((c) => (F.checkPath(c.path) === null) !== c.ok);
check(`checkPath agrees with the agent on all ${fx.cases.length} fixture paths`, fx.cases.length >= 40 && wrong.length === 0, JSON.stringify(wrong.map((c) => [c.path, F.checkPath(c.path)])));
check('the fixture has refusals of every kind: UNC, device, "..", stream, reserved, relative',
  ['\\\\server', '\\\\?\\', '\\\\.\\', '..', ':stream', 'CON', 'Temp\\report'].every((s) => fx.cases.some((c) => !c.ok && c.path.includes(s))));
check('checkPath takes 1,024 characters and refuses 1,025', F.checkPath('C:\\' + 'a'.repeat(1021)) === null && F.checkPath('C:\\' + 'a'.repeat(1022)) !== null);
check('checkPath refuses anything but a string', [null, undefined, 1, {}, ['C:\\x']].every((v) => F.checkPath(v) !== null));

// ── Chunks ────────────────────────────────────────────────────────────────
const b = randomBytes(1000);
check('a chunk decodes when its SHA-256 matches', F.decodeChunk(b.toString('base64'), sha(b))?.equals(b));
check('a chunk with another SHA-256 is refused', F.decodeChunk(b.toString('base64'), sha(Buffer.from('x'))) === null);
check('an empty, oversized, or non-base64 chunk is refused',
  F.decodeChunk('', sha(Buffer.alloc(0))) === null
  && F.decodeChunk(Buffer.alloc(L.FILE_CHUNK_BYTES + 1).toString('base64'), sha(Buffer.alloc(L.FILE_CHUNK_BYTES + 1))) === null
  && F.decodeChunk('###', sha(b)) === null && F.decodeChunk(b.toString('base64'), 'ABC') === null);
check('a full chunk is accepted at the limit', !!F.decodeChunk(Buffer.alloc(L.FILE_CHUNK_BYTES, 7).toString('base64'), sha(Buffer.alloc(L.FILE_CHUNK_BYTES, 7))));
const CH = L.FILE_CHUNK_BYTES;
check('chunksFor: 0 → 0, 1 → 1, one chunk → 1, one more byte → 2', F.chunksFor(0) === 0 && F.chunksFor(1) === 1 && F.chunksFor(CH) === 1 && F.chunksFor(CH + 1) === 2);
check('chunkFits: every chunk but the last is full, the last makes up the size',
  F.chunkFits(1, CH, CH + 5) && F.chunkFits(2, 5, CH + 5) && !F.chunkFits(2, 6, CH + 5) && !F.chunkFits(1, 5, CH + 5) && !F.chunkFits(3, 1, CH + 5) && !F.chunkFits(0, 1, 1));
check('maxBytesOf is MiB', F.maxBytesOf(100) === 104857600 && F.maxBytesOf(2048) === 2147483648);

// ── The request decision, in order ────────────────────────────────────────
const ok = { pooled: false, windows: true, signed: true, deviceSecret: true, agentVersion: '0.78.0', minAgent: '0.78.0', online: true, paused: false, liveCount: 0 };
const codeOf = (f) => F.fileRefusal({ ...ok, ...f })?.code ?? null;
check('a ready computer may transfer', codeOf({}) === null);
check('refusals, each on its own', codeOf({ pooled: true }) === 'ENDPOINT_UNASSIGNED' && codeOf({ windows: false }) === 'FILES_SIGNED_AGENT_REQUIRED'
  && codeOf({ signed: false }) === 'FILES_SIGNED_AGENT_REQUIRED' && codeOf({ deviceSecret: false }) === 'FILES_NO_DEVICE_SECRET'
  && codeOf({ agentVersion: '0.77.0' }) === 'FILES_AGENT_TOO_OLD' && codeOf({ agentVersion: null }) === 'FILES_AGENT_TOO_OLD'
  && codeOf({ paused: true }) === 'CONTAINED' && codeOf({ online: false }) === 'FILES_OFFLINE' && codeOf({ liveCount: 2 }) === 'FILES_TOO_MANY');
check('the first refusal wins (pool before agent before pause before offline)',
  codeOf({ pooled: true, signed: false, paused: true }) === 'ENDPOINT_UNASSIGNED' && codeOf({ agentVersion: '0.1.0', paused: true, online: false }) === 'FILES_AGENT_TOO_OLD'
  && codeOf({ paused: true, online: false }) === 'CONTAINED');

// ── Clocks and endings ────────────────────────────────────────────────────
const t0 = Date.UTC(2026, 10, 21, 12);
const live = { state: 'transferring', notAfter: t0 + 60 * 60_000, lastProgressAt: t0 };
check('a moving transfer goes on', F.fileExpiry(live, t0 + 9 * 60_000) === null);
check('10 minutes with nothing moving: stalled', F.fileExpiry(live, t0 + 10 * 60_000) === 'stalled');
check('the 60-minute limit: expired, whatever moved', F.fileExpiry({ ...live, lastProgressAt: t0 + 59 * 60_000 }, t0 + 60 * 60_000) === 'expired');
check('a finished transfer never expires', F.fileExpiry({ ...live, state: 'completed' }, t0 + 99 * 60_000) === null);
check('end reasons map to their audit actions',
  F.fileEndAction('completed') === 'FILE_TRANSFER_COMPLETED' && F.fileEndAction('cancelled') === 'FILE_TRANSFER_CANCELLED' && F.fileEndAction('revoked') === 'FILE_TRANSFER_CANCELLED'
  && ['expired', 'stalled', 'paused', 'hash_mismatch', 'exists', 'reparse_point'].every((r) => F.fileEndAction(r) === 'FILE_TRANSFER_FAILED'));
check('every agent error is an end reason', L.AGENT_FILE_ERRORS.every((e) => F.isFileEndReason(e)) && !F.isFileEndReason('deleted'));

// ── Capabilities and the confirm key ──────────────────────────────────────
const plat = Object.values(CAPS.PLATFORM_CAP);
const biz = Object.values(CAPS.CAP);
check('upload and download are two platform-only capabilities, never business ones',
  plat.includes('computers:files_upload') && plat.includes('computers:files_download') && !biz.some((c) => c.startsWith('computers:files')));
const owner = CAPS.effectiveCapabilities?.({ isPlatformAdmin: false, roleType: 'BUSINESS_OWNER', capabilities: [] }) ?? [];
check('a Business Owner holds neither', !owner.includes('computers:files_upload') && !owner.includes('computers:files_download'), JSON.stringify(owner).slice(0, 80));
const pa = CAPS.effectiveCapabilities?.({ isPlatformAdmin: true, roleType: 'PLATFORM_ADMIN', capabilities: [] }) ?? [];
check('a Platform Admin holds both', pa.includes('computers:files_upload') && pa.includes('computers:files_download'));
check('a stored grant cannot carry them', CAPS.sanitizeCapabilities(['computers:files_upload', 'computers:files_download', 'computers:view']).join() === 'computers:view');
const fileKey = C.CONFIRM_CATALOG.find((e) => e.key === 'files.transfer');
check('files.transfer is a catalog key, defaulting to off', fileKey?.default === 'off');

// ── The browser's SHA-256 ─────────────────────────────────────────────────
const ts = require(require.resolve('typescript', { paths: [path.join(root, 'apps/web')] }));
const src = read('apps/web/lib/sha256.ts');
const js = ts.transpileModule(src, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2021 } }).outputText;
check('lib/sha256.ts is pure (no import)', !/\brequire\s*\(/.test(js));
const mod = { exports: {} };
new Function('module', 'exports', js)(mod, mod.exports);
const S = mod.exports;
const sizes = [0, 1, 55, 56, 63, 64, 65, 119, 120, 1000, CH, CH + 3];
check('lib/sha256.ts matches node:crypto at every padding edge', sizes.every((n) => { const x = randomBytes(n); return S.sha256Hex(x) === sha(x); }));
const big = randomBytes(3 * CH + 17);
const inc = new S.Sha256();
for (let i = 0; i < big.length; i += 100_003) inc.update(big.subarray(i, i + 100_003));
check('it hashes in slices exactly as in one piece', inc.hex() === sha(big));
check('base64 both ways', Buffer.from(S.toBase64(new Uint8Array(big))).toString() === big.toString('base64') && Buffer.from(S.fromBase64(big.toString('base64'))).equals(big));

console.log(`\n${pass} passed, ${fails.length} failed`);
if (fails.length) process.exit(1);
