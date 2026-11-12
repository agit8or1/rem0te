#!/usr/bin/env node
// Tests for running approved scripts (0.34): the pure parts, against dist.
//
//   cd apps/api && npx nest build && node scripts/unit-script-run.mjs
//
// The argument rule (the same vectors as TestArgumentsMirrorThePortal in
// tools/windows-installer/internal/action/script_test.go, so the portal and
// the agent are checked against one table), the plan rule shared by the
// portal and the signer, the catalog entry, and the portal's second
// redaction and cap of reported output. No database, no signer.

import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { randomBytes } from 'node:crypto';

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const dist = join(here, '..', 'dist');
const sr = require(join(dist, 'actions', 'script-run.js'));
const so = require(join(dist, 'actions', 'script-output.js'));
const cat = require(join(dist, 'actions', 'catalog.js'));
const def = require(join(dist, 'script-library', 'definition.js'));

let passed = 0;
const failures = [];
const check = (name, ok, detail = '') => { if (ok) passed++; else failures.push(`${name}${detail ? ` — ${detail}` : ''}`); };

// ── Arguments: one table with the agent ─────────────────────────────────────
{
  const ds = [
    { name: 'Host', type: 'string', required: true, charset: 'hostname', maxLength: 10 },
    { name: 'N', type: 'integer', required: false, min: -5, max: 5 },
    { name: 'Mode', type: 'choice', required: false, choices: ['fast', 'slow'] },
    { name: 'On', type: 'boolean', required: false },
  ];
  check('the declarations themselves are valid', sr.Parameters.safeParse(ds).success);
  for (const a of [{ Host: 'a.b-c' }, { Host: 'x', N: -5, Mode: 'slow', On: false }]) {
    check(`accepts ${JSON.stringify(a)}`, sr.argumentsProblem(ds, a) === null, sr.argumentsProblem(ds, a));
  }
  for (const a of [{}, { Host: '' }, { Host: 'a b' }, { Host: 'a_b' }, { Host: 'abcdefghijk' }, { Host: 'x', N: 1.5 }, { Host: 'x', N: 6 },
    { Host: 'x', Mode: 'FAST' }, { Host: 'x', On: 'true' }, { Host: 'x', host: 'y' }, { Host: 'x', Extra: 'y' }, { Host: 'x', N: '2' }, null, [], 'Host=x']) {
    check(`refuses ${JSON.stringify(a)}`, sr.argumentsProblem(ds, a) !== null);
  }
  // No charset admits what PowerShell would treat as code or a separator.
  for (const [cs, re] of Object.entries(sr.CHARSETS)) {
    for (const ch of ['"', "'", '$', '`', ';', '|', '&', '(', ')', '\n', '\r', '{', '}', '<', '>', '\\', '/', '#', '‘', '“']) {
      check(`charset ${cs} refuses ${JSON.stringify(ch)}`, !re.test(`a${ch}b`));
    }
  }
  check('at most ten arguments', sr.argumentsProblem(Array.from({ length: 11 }, (_, i) => ({ name: `P${i}`, type: 'boolean', required: false })), Object.fromEntries(Array.from({ length: 11 }, (_, i) => [`P${i}`, true]))) !== null);
  check('parameter names are distinct case-insensitively', !sr.Parameters.safeParse([{ name: 'A', type: 'boolean', required: false }, { name: 'a', type: 'boolean', required: false }]).success);
  check('a charset is from the closed list, never a regex', !sr.Parameters.safeParse([{ name: 'A', type: 'string', required: false, charset: '.*', maxLength: 5 }]).success);
  check('the library takes its rules from the same module (one copy)', def.Parameters === sr.Parameters && def.definitionSha256 === sr.definitionSha256 && def.CHARSETS === sr.CHARSETS);
}

// ── The plan rule shared by portal and signer ───────────────────────────────
const CONTENT = 'param([string]$Name)\nWrite-Output "hi $Name"\n';
const DECLS = [{ name: 'Name', type: 'string', required: true, charset: 'identifier', maxLength: 32 }];
function block(over = {}) {
  const contentSha256 = sr.sha256Hex(CONTENT);
  const b = { allowlistId: randomBytes(16).toString('hex'), scriptId: 'scr_00000001', versionId: 'ver_00000001', name: 'Hi', version: 1, businessId: 'biz_acme_0001',
    language: 'powershell', targetOs: 'windows', risk: 'medium', parameters: DECLS, contentSha256, contentBytes: Buffer.byteLength(CONTENT), contributors: ['user_author01'], reviewedBy: 'user_review01', ...over };
  return { ...b, definitionSha256: over.definitionSha256 ?? sr.definitionSha256(b) };
}
function plan({ args = { Name: 'world' }, b = block(), biz = 'biz_acme_0001', action = 'windows.script.run', params, n = 1 } = {}) {
  const now = Date.now();
  return {
    schema: 'rem0te-action-plan/1', jobId: randomBytes(16).toString('hex'), action: { id: action, version: 1 },
    artifact: { target: 'windows/rem0te-agent.exe', sha256: 'a'.repeat(64) },
    params: params ?? { scriptVersionId: b.versionId, sha256: b.contentSha256, parameters: args, timeoutMinutes: 5 },
    targets: Array.from({ length: n }, (_, i) => ({ endpointId: `ep_${String(i).padStart(8, '0')}`, businessId: biz, businessName: 'Acme', hostname: `PC${i}`, deviceClass: 'WORKSTATION', rustdeskId: String(100000000 + i), deviceSecretSha256: 'b'.repeat(64) })),
    requestedBy: { userId: 'user_requester', name: 'Dana', via: 'portal' }, origin: { kind: 'technician', ticketRef: null }, reason: 'test',
    policy: { risk: 'high', approvalsRequired: 2, customerSignoff: false },
    window: { notBefore: new Date(now).toISOString(), notAfter: new Date(now + 3_600_000).toISOString() },
    createdAt: new Date(now).toISOString(), approvers: [], signedAt: null, script: b,
  };
}
{
  const ok = plan();
  check('a conforming plan passes the shared rule', sr.scriptPlanProblem(ok) === null && cat.validatePlanAction(cat.Plan.parse(ok)).ok === true, sr.scriptPlanProblem(ok));
  const cases = [
    ['no script block', (() => { const p = plan(); delete p.script; return p; })(), 'script_missing'],
    ['a script block on another action', { ...plan({ action: 'windows.service.start', params: { service: 'Spooler' } }) }, 'script_not_allowed'],
    ['params naming another hash', plan({ params: { scriptVersionId: 'ver_00000001', sha256: 'c'.repeat(64), parameters: { Name: 'x' }, timeoutMinutes: 5 } }), 'script_mismatch'],
    ['params naming another version', plan({ params: { scriptVersionId: 'ver_99999999', sha256: sr.sha256Hex(CONTENT), parameters: { Name: 'x' }, timeoutMinutes: 5 } }), 'script_mismatch'],
    ['a definition hash that does not cover the parameters', plan({ b: block({ definitionSha256: 'd'.repeat(64) }) }), 'script_mismatch'],
    ['a business script on another business', plan({ biz: 'biz_birch_0001' }), 'script_wrong_business'],
    ['an argument outside its charset', plan({ args: { Name: 'a$(whoami)' } }), 'arguments_not_allowed'],
    ['an undeclared argument', plan({ args: { Name: 'a', Command: 'x' } }), 'arguments_not_allowed'],
    ['a timeout off the list', plan({ params: { scriptVersionId: 'ver_00000001', sha256: sr.sha256Hex(CONTENT), parameters: { Name: 'x' }, timeoutMinutes: 60 } }), 'params_not_allowed'],
    ['an extra param (a command)', plan({ params: { scriptVersionId: 'ver_00000001', sha256: sr.sha256Hex(CONTENT), parameters: { Name: 'x' }, timeoutMinutes: 5, command: 'whoami' } }), 'params_not_allowed'],
  ];
  for (const [name, p, code] of cases) check(`the shared rule refuses ${name}`, sr.scriptPlanProblem(p) === code, `${sr.scriptPlanProblem(p)}`);
  check('a global script may run on any business', sr.scriptPlanProblem(plan({ b: block({ businessId: null }), biz: 'biz_birch_0001' })) === null);
  check('validatePlanAction applies it (unknown arg → arguments_not_allowed)', cat.validatePlanAction(cat.Plan.parse(plan({ args: { Name: 'a', X: 1 } }))).reason === 'arguments_not_allowed');
  check('validatePlanAction allows 25 targets', cat.validatePlanAction(cat.Plan.parse(plan({ n: 25 }))).ok === true);
  check('the plan schema refuses 26 targets', !cat.Plan.safeParse(plan({ n: 26 })).success);
  check('the plan schema refuses a script block with an extra field', !cat.Plan.safeParse({ ...plan(), script: { ...block(), content: CONTENT } }).success);
}

// ── The catalog entry ───────────────────────────────────────────────────────
{
  const a = cat.CATALOG.find((x) => x.id === 'windows.script.run');
  check('windows.script.run@1 is in the catalog', !!a && a.version === 1);
  check('it is always high risk, workstation or server', a.risk([{ deviceClass: 'WORKSTATION' }]) === 'high' && a.risk([{ deviceClass: 'SERVER' }]) === 'high');
  check('at most 25 targets', a.maxTargets === 25);
  check('not requested directly from the Actions tab, and not offered to ClientSt0r', a.direct === false && a.integration === false);
  check('the catalog is exactly the seven actions', cat.CATALOG.map((x) => x.id).sort().join() === ['windows.service.start', 'windows.update.install', 'windows.service.restart', 'windows.reboot.schedule', 'windows.reboot.cancel', 'windows.logs.collect', 'windows.script.run'].sort().join());
  check('its timeouts are the closed list 1, 5, 10, 15, 30', sr.TIMEOUT_MINUTES.join() === '1,5,10,15,30');
}

// ── Output: decoded, redacted again, capped again ───────────────────────────
{
  const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');
  const r = {
    contentSha256: 'a'.repeat(64), exitCode: 3221225786, timedOut: false, durationMs: 1200,
    stdout: b64('ok\npassword=hunter2\nC:\\Users\\alice\\Documents\\x.txt\n'), stderr: b64('token: abcdefabcdefabcdefabcdefabcdefabcdefabcdef\n'),
    stdoutBytes: 50, stderrBytes: 40, stdoutTruncated: false, stderrTruncated: false, cleanup: 'removed',
  };
  check('the agent result schema accepts a well-formed report', so.ScriptAgentResult.safeParse(r).success);
  check('the agent result schema refuses an extra field', !so.ScriptAgentResult.safeParse({ ...r, command: 'x' }).success);
  check('the agent result schema refuses non-base64 output', !so.ScriptAgentResult.safeParse({ ...r, stdout: 'not base64!' }).success);
  const s = so.sanitizeScriptOutput(r);
  check('an unsigned Windows exit code is stored as the signed int32', s.exitCode === 3221225786 - 4294967296, String(s.exitCode));
  check('the portal redacts key=value credentials the agent missed', !s.stdout.text.includes('hunter2') && /password=\[redacted\]/.test(s.stdout.text), s.stdout.text);
  check('the portal redacts user-profile paths', !s.stdout.text.includes('alice'), s.stdout.text);
  check('the portal redacts long tokens on stderr', !s.stderr.text.includes('abcdefabcdefabcdef'), s.stderr.text);
  const big = so.sanitizeStream(b64('é'.repeat(40000)), false);
  check('the portal caps each stream at 64 KiB without splitting a character', Buffer.byteLength(big.text) <= 65536 && big.truncated && !big.text.includes('�'), `${Buffer.byteLength(big.text)}`);
  check('the agent\'s truncation flag survives', so.sanitizeStream(b64('x'), true).truncated === true);
  const invalid = so.sanitizeStream(Buffer.from([0x61, 0xff, 0xfe, 0x62]).toString('base64'), false);
  check('invalid UTF-8 is replaced, not refused', invalid.text.startsWith('a') && invalid.text.endsWith('b'), JSON.stringify(invalid.text));
  check('headBytes never splits a character', so.headBytes('aé', 2) === 'a' && so.headBytes('aé', 3) === 'aé');
  const sum = so.scriptSummary(r);
  check('the summary on the target row carries no output text', !('stdout' in sum) && !('stderr' in sum) && sum.exitCode === 3221225786);
}

if (failures.length) {
  console.error(`✗ ${failures.length} failed, ${passed} passed`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log(`✓ ${passed} script-run checks passed`);
