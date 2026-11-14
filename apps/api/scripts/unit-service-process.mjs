#!/usr/bin/env node
/**
 * Service control and ending a process (0.45): windows.service.control@1 and
 * windows.process.stop@1, the portal half.
 *
 *   - the closed parameters (zod) take exactly what the agent's Go parser
 *     takes, and refuse the same hostile values;
 *   - the protected lists and refusal rules match the agent's, read from the
 *     Go source rather than copied here;
 *   - the request DTOs carry nothing but the snapshot row's identity, the
 *     operation and the window — never a binary path, account or password;
 *   - a process_list row as the portal stores it is a valid plan parameter,
 *     so a row the Processes tab shows can be asked for as it is.
 *
 * No database, no signer, no agent. Needs `nest build` (reads dist/).
 */
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const dist = path.join(here, '..', 'dist');
const ROOT = path.join(here, '..', '..', '..');
const cat = require(path.join(dist, 'actions/catalog.js'));
const dc = require(path.join(dist, 'device-control/device-control.service.js'));
const diag = require(path.join(dist, 'diagnostics-catalog/catalog.js'));
const goSvc = readFileSync(path.join(ROOT, 'tools/windows-installer/internal/action/svcctl.go'), 'utf8');
const goProc = readFileSync(path.join(ROOT, 'tools/windows-installer/internal/action/procstop.go'), 'utf8');

let passed = 0; const failures = [];
const check = (name, ok, detail = '') => { if (ok) passed++; else failures.push(`${name}${detail ? ` — ${detail}` : ''}`); };
const goList = (src, name) => ((src.match(new RegExp(`(?:var )?\\b${name}\\s*= \\[\\]string\\{([\\s\\S]*?)\\n?\\}`)) ?? [])[1] ?? '').replace(/\/\/.*$/gm, '').split(',').map((x) => x.trim().replace(/"/g, '')).filter(Boolean);
const ok = (schema, v) => schema.safeParse(v).success;

// ── The catalog entries ────────────────────────────────────────────────────
const ids = cat.CATALOG.map((a) => `${a.id}@${a.version}`);
check('the catalog is twelve actions, the two new ones last', ids.length === 12 && ids.slice(-2).join() === 'windows.service.control@1,windows.process.stop@1', ids.join());
for (const a of [cat.SERVICE_CONTROL, cat.PROCESS_STOP]) {
  check(`${a.id}: high impact on a workstation and a server`, a.risk('workstation', 1) === 'high' && a.risk('server', 1) === 'high');
  check(`${a.id}: one computer, never from the Actions tab, never offered to ClientSt0r`, a.maxTargets === 1 && a.direct === false && a.integration === false);
  check(`${a.id}: says it has not run on real Windows`, a.warnings.includes(cat.SERVICE_PROCESS_UNPROVEN) && /not yet run on a real Windows computer/.test(cat.SERVICE_PROCESS_UNPROVEN));
  check(`${a.id}: needs an acknowledgement`, typeof a.acknowledge === 'string' && a.acknowledge.length > 20);
}

// ── windows.service.control params ─────────────────────────────────────────
const S = cat.ServiceControlParams;
const sv = { service: 'Spooler', displayName: 'Print Spooler' };
for (const op of ['start', 'stop', 'restart']) check(`service: ${op} is accepted`, ok(S, { ...sv, op }));
for (const t of ['automatic', 'automatic_delayed', 'manual', 'disabled']) check(`service: set_start_type ${t} is accepted`, ok(S, { ...sv, op: 'set_start_type', startType: t }));
check('service: set_start_type needs a start type', !ok(S, { ...sv, op: 'set_start_type' }));
check('service: start/stop/restart carry no start type', !ok(S, { ...sv, op: 'stop', startType: 'manual' }));
check('service: boot and system start types are refused', !ok(S, { ...sv, op: 'set_start_type', startType: 'boot' }) && !ok(S, { ...sv, op: 'set_start_type', startType: 'system' }));
check('service: no other operation (pause, delete, config)', ['pause', 'continue', 'delete', 'config', 'create', 'STOP'].every((op) => !ok(S, { ...sv, op })));
for (const extra of ['binaryPath', 'binPath', 'account', 'password', 'startName', 'recovery', 'dependencies', 'description', 'imagePath']) {
  check(`service: an extra ${extra} key is refused`, !ok(S, { ...sv, op: 'restart', [extra]: 'x' }) && !ok(S, { ...sv, op: 'set_start_type', startType: 'manual', [extra]: 'x' }));
}
for (const name of ['..', 'a\\b', 'a/b', '-x', 'a b', 'a"b', 'a;b', 'a|b', 'a%x%', 'MSSQL$X', 'a.exe', 'a'.repeat(65), '']) {
  check(`service: name ${JSON.stringify(name).slice(0, 20)} is refused`, !ok(S, { ...sv, service: name, op: 'start' }));
}
for (const dn of ['a"b', 'a<b', 'a>b', 'a\\b', 'a\nb', 'a\u0000b', 'x'.repeat(257), '', ' padded ']) {
  check(`service: display name ${JSON.stringify(dn).slice(0, 20)} is refused`, !ok(S, { ...sv, displayName: dn, op: 'start' }));
}
check('service: a long ordinary display name is accepted', ok(S, { service: 'wuauserv', displayName: 'Windows Update (Microsoft) — 1.0 & more, 50%', op: 'start' }));
check('service: the name charset is the agent\'s', /ServiceNameRE\s*=/.test(readFileSync(path.join(ROOT, 'tools/windows-installer/internal/action/maintenance.go'), 'utf8')) && cat.SERVICE_NAME_RE.source === (readFileSync(path.join(ROOT, 'tools/windows-installer/internal/action/maintenance.go'), 'utf8').match(/ServiceNameRE\s*= regexp\.MustCompile\(`([^`]+)`\)/) ?? [])[1]);
check('service: the display-name charset is the agent\'s', cat.SERVICE_DISPLAY_NAME_RE.source === (goSvc.match(/ServiceDisplayNameRE = regexp\.MustCompile\(`([^`]+)`\)/) ?? [])[1]);

// ── Refusal rules, both sides ──────────────────────────────────────────────
check('service: the protected list is the agent\'s, in order', cat.PROTECTED_SERVICES.join() === goList(goSvc, 'ProtectedServices').join(), `${cat.PROTECTED_SERVICES.length} vs ${goList(goSvc, 'ProtectedServices').length}`);
check('service: keep-running and no-disable lists are the agent\'s', cat.KEEP_RUNNING_SERVICES.join() === goList(goSvc, 'KeepRunningServices').join() && cat.NO_DISABLE_SERVICES.join() === goList(goSvc, 'NoDisableServices').join());
const R = cat.serviceRefusal;
for (const n of ['WinDefend', 'windefend', 'MPSSVC', 'EventLog', 'Schedule', 'RpcSs', 'Dnscache', 'TrustedInstaller']) {
  check(`service: ${n} is refused for every operation`, ['start', 'stop', 'restart'].every((op) => R(n, op)?.code === 'protected') && R(n, 'set_start_type', 'automatic')?.code === 'protected');
}
check('service: Rem0te\'s own services are refused, any case', R('Rem0teAgent', 'restart')?.code === 'own' && R('rem0te-tray', 'start')?.code === 'own');
check('service: RustDesk may be started, restarted, set to Automatic', [R('RustDesk', 'start'), R('RustDesk', 'restart'), R('rustdesk', 'set_start_type', 'automatic'), R('RustDesk', 'set_start_type', 'automatic_delayed')].every((x) => x === null));
check('service: RustDesk is never stopped, set to Manual or Disabled', R('RustDesk', 'stop')?.code === 'keep_running' && R('RUSTDESK', 'set_start_type', 'manual')?.code === 'keep_running' && R('RustDesk', 'set_start_type', 'disabled')?.code === 'keep_running');
check('service: Windows Update can be stopped and set to Manual but not Disabled', R('wuauserv', 'stop') === null && R('wuauserv', 'set_start_type', 'manual') === null && R('wuauserv', 'set_start_type', 'disabled')?.code === 'no_disable' && R('BITS', 'set_start_type', 'disabled')?.code === 'no_disable');
check('service: an ordinary service is allowed everything', ['start', 'stop', 'restart'].every((op) => R('Spooler', op) === null) && R('Spooler', 'set_start_type', 'disabled') === null);
// The Go ServiceRefusal has the same order of cases as the portal's.
const goOrder = [...(goSvc.match(/func ServiceRefusal\([\s\S]*?\n\}/) ?? [''])[0].matchAll(/case ([^:]+):/g)].map((m) => m[1].includes('OwnServicePrefix') ? 'own' : m[1].includes('ProtectedServices') ? 'protected' : m[1].includes('KeepRunning') ? 'keep_running' : m[1].includes('NoDisable') ? 'no_disable' : '?');
check('service: the agent checks the same four rules in the same order', goOrder.join() === 'own,protected,keep_running,no_disable', goOrder.join());

// ── windows.process.stop params ────────────────────────────────────────────
const P = cat.ProcessStopParams;
const pr = { pid: 4242, name: 'notepad', startedAt: '2026-11-14T09:30:01.123Z' };
check('process: pid, name and start time are accepted, with or without tree', ok(P, pr) && ok(P, { ...pr, tree: true }) && ok(P, { ...pr, tree: false }));
check('process: all three are needed', !ok(P, { pid: 1, name: 'x' }) && !ok(P, { pid: 1, startedAt: pr.startedAt }) && !ok(P, { name: 'x', startedAt: pr.startedAt }));
check('process: no extra key (force, path, command line, signal)', ['force', 'path', 'commandLine', 'signal', 'exitCode', 'user'].every((k) => !ok(P, { ...pr, [k]: 1 })));
check('process: pid is a positive 32-bit integer', [0, -1, 1.5, 2 ** 32, '4242', null].every((pid) => !ok(P, { ...pr, pid })) && ok(P, { ...pr, pid: 2 ** 32 - 1 }));
for (const name of ['C:\\x', 'a/b', '-x', ' x', 'x ', 'a"b', 'a;b', 'a|b', 'a&b', 'a%x', 'a`b', 'a$b', 'a\nb', 'a'.repeat(65), '']) {
  check(`process: name ${JSON.stringify(name).slice(0, 20)} is refused`, !ok(P, { ...pr, name }));
}
for (const t of ['2026-11-14T09:30:01Z', '2026-11-14T09:30:01.12Z', '2026-11-14 09:30:01.123Z', '2026-11-14T09:30:01.123+01:00', '2026-13-40T99:99:99.999Z', '']) {
  check(`process: start time ${t || '(empty)'} is refused`, !ok(P, { ...pr, startedAt: t }));
}
check('process: the charsets are the agent\'s', cat.PROCESS_NAME_RE.source === (goProc.match(/ProcessNameRE\s*= regexp\.MustCompile\(`([^`]+)`\)/) ?? [])[1] && cat.PROCESS_STARTED_RE.source === (goProc.match(/ProcessStartedRE\s*= regexp\.MustCompile\(`([^`]+)`\)/) ?? [])[1]);
check('process: the protected list and tree cap are the agent\'s', cat.PROTECTED_PROCESSES.join() === goList(goProc, 'ProtectedProcesses').join() && /const MaxTreeProcesses = 64/.test(goProc) && cat.MAX_TREE_PROCESSES === 64);
const PR = cat.processRefusal;
check('process: System and Idle by pid', PR('anything', 4)?.code === 'kernel' && PR('anything', 0)?.code === 'kernel');
check('process: svchost says stop the service instead', PR('svchost', 1000)?.code === 'svchost' && /stop the service instead/.test(PR('SVCHOST.EXE', 1000).reason));
check('process: Rem0te and RustDesk are refused', ['rem0te-agent', 'Rem0te-Tray.exe', 'rustdesk', 'RustDesk.exe'].every((n) => PR(n, 900)?.code === 'rem0te'));
check('process: Windows and security processes are refused, any case, with or without .exe', ['lsass', 'LSASS.EXE', 'csrss', 'winlogon', 'wininit', 'services', 'smss', 'dwm', 'MsMpEng', 'Registry'].every((n) => PR(n, 900)?.code === 'protected'));
check('process: an ordinary program is allowed', [PR('notepad', 900), PR('chrome', 900), PR('explorer', 900), PR('EXCEL', 900)].every((x) => x === null));

// ── The request DTOs carry identity, op and window only ────────────────────
const SD = dc.ServiceControlDto, PD = dc.ProcessStopDto;
check('dto: a service request is the row, the op and a window', ok(SD, { ...sv, op: 'restart' }) && ok(SD, { ...sv, op: 'set_start_type', startType: 'manual', windowHours: 4, reason: 'ticket 9' }));
check('dto: startType only and always with set_start_type', !ok(SD, { ...sv, op: 'set_start_type' }) && !ok(SD, { ...sv, op: 'stop', startType: 'manual' }));
check('dto: the window is 1 to 4 hours', !ok(SD, { ...sv, op: 'start', windowHours: 0 }) && !ok(SD, { ...sv, op: 'start', windowHours: 5 }));
check('dto: no binary path, account, password or extra key on either request', ['binaryPath', 'account', 'password', 'startName', 'recovery', 'dependencies', 'endpointIds', 'startsInMinutes'].every((k) => !ok(SD, { ...sv, op: 'start', [k]: 'x' }) && !ok(PD, { ...pr, [k]: 'x' })));
check('dto: a process request is pid, name, start time, optional tree', ok(PD, pr) && ok(PD, { ...pr, tree: true, windowHours: 2 }) && !ok(PD, { pid: pr.pid, name: pr.name }));

// ── The stored snapshot row is a valid request ─────────────────────────────
const stored = diag.sanitizeResult('process_list', { processCount: 2, userNamesRead: true, processes: [
  { name: 'notepad', pid: 4242, cpuSeconds: 1.5, workingSetBytes: 1048576, user: 'PC\\sam', startedAt: '2026-11-14T09:30:01.1234567Z' },
  { name: 'EXCEL', pid: 5150, cpuSeconds: 20, workingSetBytes: 9e7, user: null, startedAt: '/Date(1794655801123)/' },
] });
const row = stored?.processes?.[0];
check('snapshot: a stored process row (startedAt to the millisecond) is a valid plan parameter as it is',
  row && ok(P, { pid: row.pid, name: row.name, startedAt: row.startedAt }), JSON.stringify(row));
check('snapshot: the agent compares to the millisecond, as the snapshot stores it',
  /return read\.UTC\(\)\.Truncate\(time\.Millisecond\)\.Equal\(want\.UTC\(\)\)/.test(goProc));

if (failures.length) {
  console.error(`✗ ${failures.length} failed, ${passed} passed`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log(`✓ ${passed} service-control and end-process checks passed`);
