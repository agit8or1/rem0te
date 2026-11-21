#!/usr/bin/env node
/**
 * 0.77 Conduit: the background terminal's pure decisions
 * (src/remote-ops/policy.ts and limits.ts), and that they agree with the
 * agent's Go constants (tools/windows-installer/internal/remote) and
 * migration 0094's CHECKs. No database. Needs `nest build` (dist/).
 *
 * The behavioural proof over HTTP, with the agent's real worker, is
 * e2e-terminal.mjs; the Windows exec site is the lab's
 * internal/remote/lab_windows_test.go.
 */
import { createRequire } from 'node:module';
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
const P = dist('remote-ops/policy.js');
const L = dist('remote-ops/limits.js');
const CAPS = dist('rbac/capabilities.js');
const C = dist('security-controls/confirm-catalog.js');

let pass = 0; const fails = [];
const check = (name, ok, detail = '') => { if (ok) pass++; else fails.push(name); console.log(`${ok ? '✓' : '✗'} ${name}${ok || !detail ? '' : `\n    ${detail}`}`); };
const read = (p) => readFileSync(path.join(root, p), 'utf8');

// ── Limits agree with the agent and the migration ─────────────────────────
const go = read('tools/windows-installer/internal/remote/limits.go');
const goConst = (name) => { const m = go.match(new RegExp(`\\b${name}\\s*=\\s*([^\\n/]+)`)); return m ? m[1].trim() : null; };
const goBytes = (name) => { const v = goConst(name); if (!v) return null; return Function(`return ${v.replace(/<</g, '<<')}`)(); };
const goDur = (name) => { const v = goConst(name); const m = v && v.match(/^(\d+)\s*\*\s*time\.(Minute|Second)$/); return m ? Number(m[1]) * (m[2] === 'Minute' ? 60_000 : 1000) : null; };
check('the idle limit is 15 minutes, on both sides', L.TERMINAL_IDLE_MS === 15 * 60_000 && goDur('IdleTimeout') === L.TERMINAL_IDLE_MS, goConst('IdleTimeout'));
check('the hard limit is 60 minutes, on both sides', L.TERMINAL_MAX_MS === 60 * 60_000 && goDur('MaxSession') === L.TERMINAL_MAX_MS, goConst('MaxSession'));
check('the input frame cap agrees (4,096)', goBytes('InputFrameMax') === L.TERMINAL_INPUT_FRAME_MAX && L.TERMINAL_INPUT_FRAME_MAX === 4096);
check('the output frame cap agrees (16,384)', goBytes('OutputFrameMax') === L.TERMINAL_OUTPUT_FRAME_MAX && L.TERMINAL_OUTPUT_FRAME_MAX === 16384);
check('the session input cap agrees (1 MiB)', goBytes('SessionInputMax') === L.TERMINAL_SESSION_INPUT_MAX);
check('the session output cap agrees (8 MiB)', goBytes('SessionOutputMax') === L.TERMINAL_SESSION_OUTPUT_MAX);
check('frames per post agree (16)', goBytes('OutputFramesPerPost') === L.TERMINAL_OUTPUT_FRAMES_PER_POST);
check('live terminals per computer agree (3)', goBytes('MaxLive') === L.TERMINAL_LIVE_PER_COMPUTER);
const goList = (name) => { const m = go.match(new RegExp(`${name}\\s*=\\s*\\[\\]string\\{([^}]*)\\}`)); return m ? [...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]) : null; };
check('the two shells agree, in order', JSON.stringify(goList('Shells')) === JSON.stringify([...L.TERMINAL_SHELLS]) && JSON.stringify([...L.TERMINAL_SHELLS]) === '["cmd","powershell"]', JSON.stringify(goList('Shells')));
check('the agent refusals agree', JSON.stringify(goList('AgentRefusals')) === JSON.stringify([...L.AGENT_REFUSALS]), JSON.stringify(goList('AgentRefusals')));
const mig = read('apps/api/prisma/migrations/0094_terminal_sessions/migration.sql');
check("0094 CHECKs the shells", /"shell" IN \('cmd', 'powershell'\)/.test(mig));
check('0094 CHECKs every end reason, and no other', L.END_REASONS.every((r) => mig.includes(`'${r}'`)));
check('0094 CHECKs the hard limit (notAfter within 60 minutes of opening)', /"notAfter" <= "createdAt" \+ interval '60 minutes'/.test(mig));
check('0094 CHECKs the frame sizes', /4096/.test(mig) && /16384/.test(mig));
check('0094 holds one live terminal per technician per computer', /CREATE UNIQUE INDEX "TerminalSession_one_live_key"[^;]*WHERE "state" <> 'ended'/.test(mig));
check('0094 keeps a session in its computer\'s business (trigger)', /terminal_session_business/.test(mig));

// ── The shell, the reason ─────────────────────────────────────────────────
check('only cmd and powershell are shells', P.isShell('cmd') && P.isShell('powershell') && !['pwsh', 'bash', 'cmd.exe', 'CMD', '', null, 1].some((v) => P.isShell(v)));
check('a reason is required: 3–500 characters, trimmed', P.cleanReason('  fix   the spooler ') === 'fix the spooler' && P.cleanReason('ab') === null && P.cleanReason('x'.repeat(501)) === null && P.cleanReason(undefined) === null);
check('a reason with control characters is refused', P.cleanReason('ok\u0000bad') === null && P.cleanReason('ok\u007fbad') === null);

// ── The open decision, in order ───────────────────────────────────────────
const ok = { pooled: false, windows: true, signed: true, deviceSecret: true, agentVersion: '0.77.0', minAgent: L.TERMINAL_MIN_AGENT, online: true, paused: false, ownLive: false, liveCount: 0 };
const code = (f) => P.openRefusal({ ...ok, ...f })?.code ?? null;
check('a computer that meets every rule may open', code({}) === null);
check('pooled → ENDPOINT_UNASSIGNED (403)', code({ pooled: true }) === 'ENDPOINT_UNASSIGNED' && P.openRefusal({ ...ok, pooled: true }).status === 403);
check('not Windows → TERMINAL_SIGNED_AGENT_REQUIRED', code({ windows: false }) === 'TERMINAL_SIGNED_AGENT_REQUIRED');
check('not the signed agent → TERMINAL_SIGNED_AGENT_REQUIRED', code({ signed: false }) === 'TERMINAL_SIGNED_AGENT_REQUIRED');
check('no device secret → TERMINAL_NO_DEVICE_SECRET', code({ deviceSecret: false }) === 'TERMINAL_NO_DEVICE_SECRET');
check('an agent older than 0.77.0, or unknown → TERMINAL_AGENT_TOO_OLD', code({ agentVersion: '0.76.9' }) === 'TERMINAL_AGENT_TOO_OLD' && code({ agentVersion: null }) === 'TERMINAL_AGENT_TOO_OLD' && code({ agentVersion: 'dev' }) === 'TERMINAL_AGENT_TOO_OLD' && code({ agentVersion: '0.78.1' }) === null);
check('a remote pause → CONTAINED (403)', code({ paused: true }) === 'CONTAINED' && P.openRefusal({ ...ok, paused: true }).status === 403);
check('offline → TERMINAL_OFFLINE', code({ online: false }) === 'TERMINAL_OFFLINE');
check('one of your own already live → TERMINAL_ALREADY_OPEN', code({ ownLive: true }) === 'TERMINAL_ALREADY_OPEN');
check('three live on the computer → TERMINAL_TOO_MANY', code({ liveCount: 3 }) === 'TERMINAL_TOO_MANY' && code({ liveCount: 2 }) === null);
check('the order: pooled before signed before secret before version before pause before offline',
  code({ pooled: true, signed: false, deviceSecret: false, paused: true, online: false }) === 'ENDPOINT_UNASSIGNED'
  && code({ signed: false, deviceSecret: false, paused: true, online: false }) === 'TERMINAL_SIGNED_AGENT_REQUIRED'
  && code({ deviceSecret: false, agentVersion: null, paused: true }) === 'TERMINAL_NO_DEVICE_SECRET'
  && code({ agentVersion: '0.1.0', paused: true }) === 'TERMINAL_AGENT_TOO_OLD'
  && code({ paused: true, online: false, ownLive: true }) === 'CONTAINED'
  && code({ online: false, ownLive: true }) === 'TERMINAL_OFFLINE');

// ── The clocks ────────────────────────────────────────────────────────────
const t0 = Date.UTC(2026, 10, 21, 12, 0, 0);
const s = { state: 'open', notAfter: new Date(P.hardLimit(t0)), lastActivityAt: new Date(t0) };
check('the hard limit is 60 minutes from opening', P.hardLimit(t0) - t0 === 60 * 60_000);
check('nothing expires before the idle limit', P.expiry(s, t0 + 15 * 60_000 - 1) === null);
check('15 minutes without input → expired_idle', P.expiry(s, t0 + 15 * 60_000) === 'expired_idle');
const busy = { ...s, lastActivityAt: P.touch(s, t0 + 59 * 60_000) };
check('input moves the idle clock', P.expiry(busy, t0 + 59 * 60_000 + 1000) === null);
check('input never moves the hard limit: 60 minutes → expired_max', P.expiry(busy, t0 + 60 * 60_000) === 'expired_max');
check('touch never goes past the hard limit', P.touch(s, t0 + 2 * 60 * 60_000).getTime() === P.hardLimit(t0));
check('the deadline is the earlier of the two clocks', P.deadline(s).reason === 'expired_idle' && P.deadline(s).at === t0 + 15 * 60_000 && P.deadline(busy).reason === 'expired_max');
check('an ended session never expires again', P.expiry({ ...s, state: 'ended' }, t0 + 99 * 60 * 60_000) === null);
const rem = P.remaining(s, t0 + 60_000);
check('remaining: idle and total seconds for the countdowns', rem.idleSeconds === 14 * 60 && rem.totalSeconds === 59 * 60 && P.remaining(s, t0 + 99 * 60 * 60_000).totalSeconds === 0);
// Reconnecting (reading, or another browser tab) never calls touch: the service
// moves lastActivityAt only in input and keepAlive. Checked in the source:
const svc = read('apps/api/src/remote-ops/terminal.service.ts');
const touchCalls = [...svc.matchAll(/touch\(/g)].length;
check('only input and Keep alive move the idle clock (two touch calls in the service)', touchCalls === 2 && /async input\([\s\S]*?touch\(/.test(svc) && /async keepAlive\([\s\S]*?touch\(/.test(svc), `touch calls: ${touchCalls}`);
check('the agent\'s calls never move the idle clock', !/async fromAgent\([\s\S]*?\n {2}}\n/.exec(svc)?.[0].includes('touch('));

// ── Who may end a session ─────────────────────────────────────────────────
const sess = { technicianId: 'tech', businessId: 'biz' };
check('its own technician closes it', P.endAs({ userId: 'tech', isPlatformAdmin: false, technician: true, businessId: null, canEditComputers: false }, sess) === 'closed');
check('a Platform Admin revokes it', P.endAs({ userId: 'pa', isPlatformAdmin: true, technician: false, businessId: null, canEditComputers: false }, sess) === 'revoked');
check("the business's own member with Edit computers revokes it", P.endAs({ userId: 'own', isPlatformAdmin: false, technician: false, businessId: 'biz', canEditComputers: true }, sess) === 'revoked');
check('a member without Edit computers cannot', P.endAs({ userId: 'u', isPlatformAdmin: false, technician: false, businessId: 'biz', canEditComputers: false }, sess) === null);
check("another business's member cannot", P.endAs({ userId: 'u', isPlatformAdmin: false, technician: false, businessId: 'other', canEditComputers: true }, sess) === null);
check('another technician cannot, even with Edit computers', P.endAs({ userId: 't2', isPlatformAdmin: false, technician: true, businessId: 'biz', canEditComputers: true }, sess) === null);
check('end reasons map to their audit actions', P.endAction('closed') === 'TERMINAL_CLOSED' && P.endAction('revoked') === 'TERMINAL_REVOKED'
  && P.endAction('expired_idle') === 'TERMINAL_EXPIRED' && P.endAction('expired_max') === 'TERMINAL_EXPIRED' && P.endAction('paused') === 'TERMINAL_ENDED' && P.endAction('exited') === 'TERMINAL_ENDED');
check('every end reason is known, nothing else is', L.END_REASONS.every((r) => P.isEndReason(r)) && !P.isEndReason('whatever'));

// ── Frames ────────────────────────────────────────────────────────────────
check('input: 1–4,096 bytes of UTF-8', P.inputBytes('dir\n')?.length === 4 && P.inputBytes('x'.repeat(4096))?.length === 4096 && P.inputBytes('x'.repeat(4097)) === null && P.inputBytes('') === null);
check('input: multi-byte characters count as bytes', P.inputBytes('é'.repeat(2048))?.length === 4096 && P.inputBytes('é'.repeat(2049)) === null);
check('input: NUL and non-strings are refused', P.inputBytes('a\u0000b') === null && P.inputBytes(42) === null && P.inputBytes(null) === null);
const b64 = (s) => Buffer.from(s).toString('base64');
const fr = (seq, data = 'x', stream = 'stdout') => ({ seq, stream, data: b64(data) });
check('output: contiguous frames are taken', P.outputFrames([fr(1), fr(2, 'y', 'stderr')], 0)?.length === 2);
check('output: a retry of taken frames is dropped, the rest taken', P.outputFrames([fr(1), fr(2), fr(3)], 2)?.map((f) => f.seq).join() === '3');
check('output: a gap refuses the post', P.outputFrames([fr(1), fr(3)], 0) === null && P.outputFrames([fr(5)], 3) === null);
check('output: more than 16 frames refuses the post', P.outputFrames(Array.from({ length: 17 }, (_, i) => fr(i + 1)), 0) === null && P.outputFrames(Array.from({ length: 16 }, (_, i) => fr(i + 1)), 0)?.length === 16);
check('output: a frame over 16,384 bytes refuses the post', P.outputFrames([fr(1, 'x'.repeat(16385))], 0) === null && P.outputFrames([fr(1, 'x'.repeat(16384))], 0)?.length === 1);
check('output: an empty frame, a bad stream or bad base64 refuses the post', P.outputFrames([{ seq: 1, stream: 'stdout', data: '' }], 0) === null
  && P.outputFrames([{ seq: 1, stream: 'stdin', data: b64('x') }], 0) === null && P.outputFrames([{ seq: 1, stream: 'stdout', data: '!!!' }], 0) === null);
check('output: no frames is nothing, not a refusal', Array.isArray(P.outputFrames(undefined, 0)) && P.outputFrames(undefined, 0).length === 0 && P.outputFrames('x', 0) === null);

// ── Capabilities: default deny ────────────────────────────────────────────
const PLAT = Object.values(CAPS.PLATFORM_CAP);
check('the platform-only capabilities include computers:terminal', PLAT.includes('computers:terminal'));
check('none of them is a business capability (an owner cannot grant them)', PLAT.every((c) => !CAPS.ALL_BUSINESS_CAPABILITIES.includes(c)));
const eff = CAPS.effectiveCapabilities;
check('a Platform Admin holds computers:terminal', eff({ isPlatformAdmin: true }).includes('computers:terminal') && CAPS.hasCapability({ isPlatformAdmin: true }, 'computers:terminal'));
check('a Business Owner does not', !eff({ isPlatformAdmin: false, roleType: 'BUSINESS_OWNER' }).includes('computers:terminal') && !eff({ isPlatformAdmin: false, roleType: 'TENANT_OWNER' }).includes('computers:terminal'));
check('a stored grant naming it is dropped (Business User, technician, preset, SSO mapping)',
  !CAPS.sanitizeCapabilities(['computers:terminal', 'computers:view']).includes('computers:terminal')
  && !CAPS.sanitizeTechnicianCapabilities(['computers:terminal']).includes('computers:terminal')
  && !eff({ isPlatformAdmin: false, roleType: 'BUSINESS_USER', capabilities: ['computers:terminal', 'computers:view'] }).includes('computers:terminal'));
check('no capability group offers it as a checkbox', !JSON.stringify(CAPS.CAPABILITY_GROUPS ?? []).includes('computers:terminal'));
check('terminal.open is in the catalog and asks by default', C.CONFIRM_CATALOG.some((f) => f.key === 'terminal.open' && f.default === 'ask'));

console.log(`\n${pass} passed, ${fails.length} failed`);
if (fails.length) { for (const f of fails) console.log(`  ✗ ${f}`); process.exit(1); }
