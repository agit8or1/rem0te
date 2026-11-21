#!/usr/bin/env node
// Tests for the device page's Tools panel rules (0.75), apps/web/lib/device-tools.ts.
//
//   node apps/web/scripts/unit-device-tools.mjs
//
// The module is pure (no imports), so it is transpiled with the workspace's
// TypeScript and run as it is — no build needed. Covered: every tool in every
// state it can reach (signed, direct mode, standard, an agent missing an
// action, Linux, macOS, RustDesk only, containment, offline and agent-silent,
// each permission, no signer and a catalog not yet read, archived, not
// enrolled, pooled, an unbound agent, an agent too old for snapshots), the
// order the states are decided in, the restart-pending wording (unknown is
// never "No"), who may request an action (mirroring AccessPolicyService), and
// that every action id, diagnostics key and tab the panel names exists in the
// API's catalogs and the device page. 0.76: the palette's tools, the
// diagnostics catalog's allowed / needsNewerAgent facts, and that
// lib/diagnostic-params.ts gives the API's answer on every input tried.

import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const WEB = join(here, '..');
const API = join(WEB, '..', 'api');
const require = createRequire(join(WEB, 'package.json'));
const ts = require('typescript');
const src = readFileSync(join(WEB, 'lib', 'device-tools.ts'), 'utf8');
const js = ts.transpileModule(src, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2021 } }).outputText;
if (/\brequire\s*\(/.test(js)) throw new Error('lib/device-tools.ts imports a module: it must stay pure');
const mod = { exports: {} };
new Function('module', 'exports', js)(mod, mod.exports);
const T = mod.exports;

let passed = 0;
const failures = [];
const check = (name, ok, detail = '') => { if (ok) passed++; else failures.push(`${name}${detail ? ` — ${detail}` : ''}`); };
const j = (x) => JSON.stringify(x);

const EP = 'ep_1';
const ALL_ACTIONS = ['windows.service.start@1', 'windows.update.install@1', 'windows.service.restart@1', 'windows.reboot.schedule@1', 'windows.reboot.cancel@1',
  'windows.logs.collect@1', 'windows.script.run@1', 'windows.software.install@1', 'windows.software.uninstall@1', 'windows.software.remove@1',
  'windows.service.control@1', 'windows.process.stop@1'];
const base = () => ({
  diagAllowed: null, diagNeedsNewer: null,
  agentKind: 'signed', readOnlyOs: null, agentVersion: '0.77.0', agentActions: [...ALL_ACTIONS], status: 'ACTIVE', pooled: false, agentBound: true,
  connectivity: 'online', connectivityText: 'Online', signer: { configured: true, approval: 'signed' }, paused: [],
  perms: { view: true, eventLogs: true, terminal: true, requestLow: true, requestHigh: true }, actionRisk: { 'windows.service.start': 'low' }, restartPending: false,
});
const tools = T.toolCatalog(EP);
const kindOf = (t) => t.need.kind;
const states = (f) => Object.fromEntries(T.deviceTools(EP, f).map((t) => [t.id, t]));
const reached = new Set();
/** Every tool's state under facts `f`, against `expect(tool) → state`. */
function scenario(name, f, expect) {
  const got = states(f);
  for (const t of tools) {
    const want = expect(t);
    const g = got[t.id];
    reached.add(g.state);
    check(`${name}: ${t.id} is ${want}`, g.state === want, `got ${g.state}: ${g.reason}`);
    check(`${name}: ${t.id} has a reason`, typeof g.reason === 'string' && g.reason.length > 3, j(g));
  }
  return got;
}

// ── The catalog itself ──────────────────────────────────────────────────────
{
  const ids = tools.map((t) => t.id);
  check('tool ids are unique', new Set(ids).size === ids.length, j(ids));
  for (const g of T.TOOL_GROUPS) check(`group ${g.id} has at least one tool`, tools.some((t) => t.group === g.id));
  check('nine groups, in the directive order (0.77: Terminal after Diagnostics)', j(T.TOOL_GROUPS.map((g) => g.label)) === j(['Diagnostics', 'Terminal', 'PowerShell / Scripts', 'Services & Processes', 'Software', 'Windows Updates', 'Networking', 'Security', 'Maintenance']));
  check('every tool belongs to a known group', tools.every((t) => T.TOOL_GROUPS.some((g) => g.id === t.group)));
  const later = tools.filter((t) => kindOf(t) === 'later').map((t) => t.id);
  check('only one tool is "coming later" (flush DNS / renew DHCP); 0.76 replaced the security-posture placeholder with its checks', j(later) === j(['flush-dns']), j(later));
  const keysOf = (g) => tools.filter((t) => t.group === g && kindOf(t) === 'diagnostic').map((t) => t.need.key);
  check('0.76: the security group lists the five palette security checks', ['defender_status', 'firewall_status', 'bitlocker_status', 'secure_boot_tpm', 'local_admins'].every((k) => keysOf('security').includes(k)), j(keysOf('security')));
  check('0.76: the networking group lists DNS lookup, TCP port and routes', ['dns_lookup', 'tcp_port', 'route_table'].every((k) => keysOf('networking').includes(k)), j(keysOf('networking')));
  check('0.76: the maintenance group lists the five palette maintenance checks', ['time_sync', 'windows_activation', 'unexpected_shutdowns', 'scheduled_tasks', 'signed_in_sessions'].every((k) => keysOf('maintenance').includes(k)), j(keysOf('maintenance')));
  check('0.76: the OS support row is the server\'s own check, opening the Diagnostics tab at os_support', (() => { const o = tools.find((t) => t.id === 'os-support'); return o && kindOf(o) === 'server' && j(o.target) === j({ kind: 'tab', tab: 'diagnostics', check: 'os_support' }); })());
  check('a "coming later" tool has no target', tools.filter((t) => kindOf(t) === 'later').every((t) => t.target === null));
  check('every other tool has a target', tools.filter((t) => kindOf(t) !== 'later').every((t) => t.target !== null));

  // Action ids: the API's catalog (apps/api/src/actions/catalog.ts), by id and version 1.
  const apiCatalog = readFileSync(join(API, 'src', 'actions', 'catalog.ts'), 'utf8');
  const apiIds = [...apiCatalog.matchAll(/^\s*id: '([a-z.]+)'/gm)].map((m) => m[1]);
  for (const t of tools.filter((x) => kindOf(x) === 'action')) {
    check(`${t.id}: action ${t.need.action} is in the API's catalog`, apiIds.includes(t.need.action), j(apiIds));
    check(`${t.id}: version 1`, t.need.version === 1);
  }
  // Diagnostics keys: the API's diagnostics catalog, and not a snapshot key (those have their own tabs and no row).
  const diag = readFileSync(join(API, 'src', 'diagnostics-catalog', 'catalog.ts'), 'utf8');
  for (const t of tools.filter((x) => kindOf(x) === 'diagnostic')) {
    const m = diag.match(new RegExp(`key: '${t.need.key}'[^\\n]*`));
    check(`${t.id}: diagnostic ${t.need.key} is in the API's catalog`, !!m);
    check(`${t.id}: ${t.need.key} is a listed check, not a snapshot tab`, !!m && !/tab: '/.test(m[0]), m?.[0]);
    check(`${t.id}: opens the Diagnostics tab at ${t.need.key}`, t.target.kind === 'tab' && t.target.tab === 'diagnostics' && t.target.check === t.need.key, j(t.target));
    const ev = /capability: 'computers:event_logs'/.test(m?.[0] ?? '');
    check(`${t.id}: needs Read event logs exactly when the API's entry does`, !!t.need.eventLogs === ev);
    const cn = /capability: 'computers:connect'/.test(m?.[0] ?? '');
    check(`${t.id}: needs Connect exactly when the API's entry does`, !!t.need.connect === cn);
    const pal = /\.\.\.PAL\b/.test(m?.[0] ?? '');
    check(`${t.id}: a palette key names minAgent 0.76.0, as PALETTE_MIN_AGENT does`, !pal || t.need.minAgent === '0.76.0', j(t.need));
  }
  // The logs collection needs event logs, as the catalog's requiresCapability says.
  check('logs-collect needs Read event logs (requiresCapability)', tools.find((t) => t.id === 'logs-collect').need.eventLogs === true && /requiresCapability: 'computers:event_logs'/.test(apiCatalog));
  // Tabs: every target tab is a device page tab.
  const model = readFileSync(join(WEB, 'components', 'endpoints', 'workspace', 'device-model.ts'), 'utf8');
  for (const t of tools.filter((x) => x.target?.kind === 'tab')) check(`${t.id}: tab ${t.target.tab} is a device page tab`, new RegExp(`\\b${t.target.tab}: '`).test(model));
  // Pages: only existing app routes.
  for (const t of tools.filter((x) => x.target?.kind === 'href')) {
    const seg = t.target.href.replace(/^\//, '');
    let ok = false;
    try { readFileSync(join(WEB, 'app', '(app)', seg, 'page.tsx')); ok = true; } catch { /* missing */ }
    check(`${t.id}: page ${t.target.href} exists`, ok);
  }
  const report = tools.find((t) => t.id === 'diagnostics-report');
  check('the report link is the existing route GET /endpoints/:id/diagnostics/report', report.target.kind === 'download' && report.target.href === `/api/v1/endpoints/${EP}/diagnostics/report`
    && /@Get\(':id\/diagnostics\/report'\)|diagnostics\/report/.test(readFileSync(join(API, 'src', 'diagnostics', 'diagnostics.controller.ts'), 'utf8')), j(report.target));
  check('an endpoint id is URL-encoded in a link', T.toolCatalog('a/b').find((t) => t.id === 'diagnostics-report').target.href.includes('a%2Fb'));
  check('Security log opens with the Security log chosen', j(tools.find((t) => t.id === 'security-log').target) === j({ kind: 'tab', tab: 'events', log: 'Security' }));
}

// ── Scenarios: every tool in every state ────────────────────────────────────
const isAction = (t) => kindOf(t) === 'action';
const isTerm = (t) => kindOf(t) === 'terminal';
const later = (t) => kindOf(t) === 'later';
const palette = (t) => kindOf(t) === 'diagnostic' && t.need.minAgent === '0.76.0';

// 1. A signed agent, online, everything supported, two-approver mode.
{
  const got = scenario('signed', base(), (t) => (later(t) ? 'coming_later' : isAction(t) ? 'needs_approval' : 'available'));
  check('signed: needs approval says who approves', /Two approvers/.test(got['restart-schedule'].reason), got['restart-schedule'].reason);
  check('signed: the restart-pending row says No from a scan that said no', /^No/.test(got['restart-pending'].reason), got['restart-pending'].reason);
}
// 2. Direct mode: an action is available, and says it is signed at once after a fresh sign-in.
{
  const f = base(); f.signer.approval = 'direct';
  const got = scenario('direct', f, (t) => (later(t) ? 'coming_later' : 'available'));
  check('direct: the reason names direct mode and the fresh sign-in', /Direct mode/.test(got['logs-collect'].reason) && /fresh sign-in/.test(got['logs-collect'].reason), got['logs-collect'].reason);
}
// 2b. The signer did not answer the approval mode: still needs approval (never assumed direct).
{
  const f = base(); f.signer.approval = null;
  scenario('approval unknown', f, (t) => (later(t) ? 'coming_later' : isAction(t) ? 'needs_approval' : 'available'));
}
// 3. The standard Windows agent: every action needs the full agent; reads work.
{
  const f = base(); f.agentKind = 'standard'; f.agentActions = [];
  const got = scenario('standard', f, (t) => (later(t) ? 'coming_later' : isAction(t) || isTerm(t) ? 'needs_newer_agent' : 'available'));
  check('standard: the terminal needs the full (signed) agent', /full \(signed\) agent/.test(got['terminal'].reason), got['terminal'].reason);
  check('standard: the reason says the full (signed) agent', /full \(signed\) agent/.test(got['service-restart'].reason), got['service-restart'].reason);
}
// 4. A signed agent that does not report one action.
{
  const f = base(); f.agentActions = ALL_ACTIONS.filter((a) => a !== 'windows.process.stop@1');
  const got = scenario('missing action', f, (t) => (later(t) ? 'coming_later' : t.id === 'process-stop' ? 'needs_newer_agent' : isAction(t) ? 'needs_approval' : 'available'));
  check('missing action: says let it update', /update/.test(got['process-stop'].reason), got['process-stop'].reason);
  const v2 = base(); v2.agentActions = ALL_ACTIONS.map((a) => a.replace('@1', '@2'));
  const g2 = states(v2);
  check('an agent reporting only @2 does not satisfy @1', g2['restart-schedule'].state === 'needs_newer_agent', g2['restart-schedule'].state);
}
// 5–6. The read-only Linux and macOS agents: only scans, status and the server's own checks.
for (const os of ['Linux', 'macOS']) {
  const f = base(); f.agentKind = 'standard'; f.readOnlyOs = os; f.agentActions = [];
  const got = scenario(os, f, (t) => (later(t) ? 'coming_later' : ['scan', 'status', 'server'].includes(kindOf(t)) ? 'available' : 'unsupported'));
  check(`${os}: the reason names the read-only ${os} agent`, got['services'].reason.includes(`${os} agent is read-only`), got['services'].reason);
}
// 7. RustDesk only: nothing but the server's own checks.
{
  const f = base(); f.agentKind = 'rustdesk-only'; f.agentActions = []; f.agentVersion = null;
  scenario('RustDesk only', f, (t) => (later(t) ? 'coming_later' : kindOf(t) === 'server' ? 'available' : 'unsupported'));
}
// 8. Containment: an actions pause stops actions only.
{
  const f = base(); f.paused = ['actions'];
  const got = scenario('contained', f, (t) => (later(t) ? 'coming_later' : isAction(t) ? 'contained' : 'available'));
  check('contained: says where the pause is', /Containment/.test(got['run-script'].reason), got['run-script'].reason);
  const r = base(); r.paused = ['remote', 'updates'];
  const gr = scenario('other pauses', r, (t) => (later(t) ? 'coming_later' : isTerm(t) ? 'contained' : isAction(t) ? 'needs_approval' : 'available'));
  check('a remote pause stops the terminal (0.77), and says so', /paused by containment/.test(gr['terminal'].reason), gr['terminal'].reason);
}
// 9. Offline, and reachable with a silent agent: what reaches the agent waits; status and server checks do not.
for (const c of ['offline', 'agent_silent']) {
  const f = base(); f.connectivity = c; f.connectivityText = c === 'offline' ? 'Offline since 3d ago' : 'Reachable (RustDesk) · agent silent 12 d';
  const got = scenario(c, f, (t) => (later(t) ? 'coming_later' : ['server', 'status'].includes(kindOf(t)) ? 'available' : 'offline'));
  check(`${c}: a diagnostic says it expires`, /expires/.test(got['disk-space'].reason), got['disk-space'].reason);
  check(`${c}: a view says it shows the last report`, /last report/.test(got['services'].reason), got['services'].reason);
  check(`${c}: the reason starts with the connectivity`, got['restart-schedule'].reason.startsWith(f.connectivityText), got['restart-schedule'].reason);
  check(`${c}: offline still opens its flow`, T.opens(got['restart-schedule'].state));
}
// 10. Permissions.
{
  const f = base(); f.perms.view = false;
  scenario('no view', f, (t) => (later(t) ? 'coming_later' : 'not_permitted'));
  const e = base(); e.perms.eventLogs = false;
  const got = scenario('no event logs', e, (t) => (later(t) ? 'coming_later' : ['recent-errors', 'security-log', 'logs-collect'].includes(t.id) ? 'not_permitted' : isAction(t) ? 'needs_approval' : 'available'));
  check('no event logs: names the permission', /Read event logs/.test(got['security-log'].reason));
  const h = base(); h.perms.requestHigh = false;
  const gh = scenario('low-risk requests only', h, (t) => (later(t) ? 'coming_later' : t.id === 'spooler-start' ? 'needs_approval' : isAction(t) ? 'not_permitted' : 'available'));
  check('low-risk only: says higher-risk', /higher-risk/.test(gh['restart-schedule'].reason), gh['restart-schedule'].reason);
  const tn = base(); tn.perms.terminal = false;
  const gt = scenario('no terminal capability', tn, (t) => (later(t) ? 'coming_later' : isTerm(t) ? 'not_permitted' : isAction(t) ? 'needs_approval' : 'available'));
  check('no terminal capability: says only a Platform Admin, and SYSTEM', /Platform Admin/.test(gt['terminal'].reason) && /SYSTEM/.test(gt['terminal'].reason), gt['terminal'].reason);
  const n = base(); n.perms.requestLow = false; n.perms.requestHigh = false;
  scenario('no requests', n, (t) => (later(t) ? 'coming_later' : isAction(t) ? 'not_permitted' : 'available'));
  const srv = base(); srv.actionRisk = {}; srv.perms.requestHigh = false;
  check('an action with no listed risk counts as high', states(srv)['spooler-start'].state === 'not_permitted');
}
// 11. No approval signer, and a catalog not read yet.
{
  const f = base(); f.signer.configured = false;
  scenario('no signer', f, (t) => (later(t) ? 'coming_later' : isAction(t) ? 'not_configured' : 'available'));
  const c = base(); c.signer.configured = null;
  scenario('catalog not read', c, (t) => (later(t) ? 'coming_later' : isAction(t) ? 'checking' : 'available'));
}
// 12. Archived, not enrolled, pooled, unbound.
{
  const a = base(); a.status = 'ARCHIVED';
  const ga = scenario('archived', a, (t) => (later(t) ? 'coming_later' : kindOf(t) === 'server' ? 'available' : 'inactive'));
  check('archived: says so', /archived/.test(ga['services'].reason));
  const p = base(); p.status = 'PENDING_ENROLLMENT';
  scenario('not enrolled', p, (t) => (later(t) ? 'coming_later' : kindOf(t) === 'server' ? 'available' : 'inactive'));
  const pool = base(); pool.pooled = true;
  const gp = scenario('pooled', pool, (t) => (later(t) ? 'coming_later' : ['action', 'diagnostic', 'terminal'].includes(kindOf(t)) ? 'inactive' : 'available'));
  check('pooled: says adopt it first', /unassigned pool/.test(gp['disk-space'].reason));
  const u = base(); u.agentBound = false;
  scenario('unbound', u, (t) => (later(t) ? 'coming_later' : ['diagnostic', 'terminal'].includes(kindOf(t)) ? 'inactive' : isAction(t) ? 'needs_approval' : 'available'));
  const unk = base(); unk.agentBound = null;
  scenario('agentBound not read', unk, (t) => (later(t) ? 'coming_later' : isAction(t) ? 'needs_approval' : 'available'));
}
// 13. An agent older than the snapshots (0.33.0).
{
  const f = base(); f.agentKind = 'standard'; f.agentActions = []; f.agentVersion = '0.32.4';
  scenario('agent 0.32.4', f, (t) => (later(t) ? 'coming_later' : ['services', 'processes', 'network'].includes(t.id) || palette(t) || isAction(t) || isTerm(t) ? 'needs_newer_agent' : 'available'));
  const g = base(); g.agentVersion = 'garbage';
  check('an unparseable version is not "too old"', states(g)['services'].state === 'available');
  const x = base(); x.agentVersion = '0.33.0';
  check('exactly 0.33.0 is new enough', states(x)['services'].state === 'available');
}

// 14. 0.76: the palette, from the diagnostics catalog's allowed and needsNewerAgent.
{
  const f = base(); f.agentVersion = '0.75.0';
  const g = scenario('agent 0.75.0', f, (t) => (later(t) ? 'coming_later' : palette(t) || isTerm(t) ? 'needs_newer_agent' : isAction(t) ? 'needs_approval' : 'available'));
  check('0.75 agent: a palette check names 0.76.0', /0\.76\.0/.test(g['defender'].reason), g['defender'].reason);
  const n = base(); n.diagNeedsNewer = { defender_status: true };
  const gn = states(n);
  check('the server saying needsNewerAgent wins over a version the browser thinks is new enough', gn['defender'].state === 'needs_newer_agent' && gn['firewall'].state === 'available', `${gn['defender'].state} ${gn['firewall'].state}`);
  const c = base(); c.diagAllowed = { dns_lookup: false, tcp_port: false, route_table: true };
  const gc = scenario('no connect', c, (t) => (later(t) ? 'coming_later' : ['dns-lookup', 'tcp-port'].includes(t.id) ? 'not_permitted' : isAction(t) ? 'needs_approval' : 'available'));
  check('no connect: names the Remote connect permission', /Remote connect/.test(gc['tcp-port'].reason), gc['tcp-port'].reason);
  const o = base(); o.diagAllowed = {};
  check('a key the catalog did not list is not refused by the browser (the server decides)', states(o)['dns-lookup'].state === 'available');
  const w = base(); w.diagAllowed = { dns_lookup: false }; w.diagNeedsNewer = { dns_lookup: true };
  check('order: permission before agent', states(w)['dns-lookup'].state === 'not_permitted');
  const os = base(); os.agentKind = 'rustdesk-only'; os.agentActions = []; os.agentVersion = null;
  check('the OS support row is available with RustDesk only (it reads the inventory on the server)', states(os)['os-support'].state === 'available');
}

// ── The terminal (0.77) ─────────────────────────────────────────────────────
{
  const t = tools.find((x) => x.id === 'terminal');
  check('one terminal tool, in the Terminal group, opening the Terminal tab', !!t && t.group === 'remote' && j(t.target) === j({ kind: 'tab', tab: 'terminal' }) && tools.filter(isTerm).length === 1, j(t));
  check('its description says SYSTEM, full control, and no screen sharing', /SYSTEM/.test(t.description) && /full control/.test(t.description) && /no screen sharing/.test(t.description));
  check('it needs agent 0.77.0, the API\'s TERMINAL_MIN_AGENT', t.need.minAgent === '0.77.0' && /TERMINAL_MIN_AGENT = '0\.77\.0'/.test(readFileSync(join(API, 'src', 'remote-ops', 'limits.ts'), 'utf8')));
  const old = base(); old.agentVersion = '0.76.9';
  const go = states(old);
  check('a signed agent 0.76.9: the terminal needs a newer agent, the rest unchanged', go['terminal'].state === 'needs_newer_agent' && /0\.77\.0/.test(go['terminal'].reason) && go['restart-schedule'].state === 'needs_approval', go['terminal'].reason);
  const none = base(); none.agentVersion = null;
  check('a signed agent that never said its version: needs a newer agent (unknown is not new enough)', states(none)['terminal'].state === 'needs_newer_agent');
  const ok = states(base())['terminal'];
  check('available: says it asks for confirmation and how long it takes to start', ok.state === 'available' && /confirm it is you/.test(ok.reason) && /three minutes/.test(ok.reason), ok.reason);
  const off = base(); off.connectivity = 'offline'; off.connectivityText = 'Offline';
  check('offline: says a terminal needs a reporting computer', /reporting/.test(states(off)['terminal'].reason), states(off)['terminal'].reason);
  const ctl = readFileSync(join(API, 'src', 'remote-ops', 'terminal.controller.ts'), 'utf8');
  check('the tab it opens is backed by the API\'s terminal routes', /@Controller\('endpoints\/:id\/terminal'\)/.test(ctl));
}

check('every state is reached by some scenario', T.TOOL_STATES.every((s) => reached.has(s)), `missing: ${T.TOOL_STATES.filter((s) => !reached.has(s)).join(', ')}`);
check('every state has a label', T.TOOL_STATES.every((s) => typeof T.STATE_LABEL[s] === 'string' && T.STATE_LABEL[s].length > 0));
check('only available, needs approval and offline open a flow', j(T.TOOL_STATES.filter(T.opens)) === j(['available', 'needs_approval', 'offline']));

// ── The order of the decision ───────────────────────────────────────────────
{
  const f = base(); f.agentKind = 'standard'; f.readOnlyOs = 'Linux'; f.perms.view = false; f.status = 'ARCHIVED';
  check('order: unsupported before archived and permission', states(f)['services'].state === 'unsupported');
  const g = base(); g.status = 'ARCHIVED'; g.perms.view = false; g.signer.configured = false;
  check('order: archived before permission and signer', states(g)['restart-schedule'].state === 'inactive');
  const h = base(); h.perms.requestHigh = false; h.signer.configured = false;
  check('order: permission before signer', states(h)['restart-schedule'].state === 'not_permitted');
  const i = base(); i.signer.configured = false; i.agentKind = 'standard';
  check('order: signer before agent', states(i)['restart-schedule'].state === 'not_configured');
  const k = base(); k.agentKind = 'standard'; k.paused = ['actions'];
  check('order: agent before containment', states(k)['restart-schedule'].state === 'needs_newer_agent');
  const m = base(); m.paused = ['actions']; m.connectivity = 'offline'; m.connectivityText = 'Offline';
  check('order: containment before offline', states(m)['restart-schedule'].state === 'contained');
  const n = base(); n.connectivity = 'offline'; n.connectivityText = 'Offline'; n.signer.approval = 'direct';
  check('order: offline before approval', states(n)['restart-schedule'].state === 'offline');
}

// ── Restart pending: unknown is never "No" ──────────────────────────────────
{
  for (const [v, re] of [[true, /^Yes/], [false, /^No/], [null, /^Unknown/]]) {
    const f = base(); f.restartPending = v;
    const r = states(f)['restart-pending'];
    check(`restart pending ${v}: ${re}`, r.state === 'available' && re.test(r.reason), r.reason);
  }
  const f = base(); f.restartPending = null;
  check('restart pending unknown: does not say No', !/\bNo\b/.test(states(f)['restart-pending'].reason));
}

// ── Version comparison ──────────────────────────────────────────────────────
check('compareVersions', T.compareVersions('0.33.0', '0.33.0') === 0 && T.compareVersions('0.9.1', '0.33.0') === -1 && T.compareVersions('1.0.0', '0.99.9') === 1
  && T.compareVersions('0.33.1+5', '0.33.0') === 1 && T.compareVersions('x', '0.33.0') === null);

// ── Who may request an action (AccessPolicyService.evaluateActionAccess) ────
{
  const may = T.mayRequestActions;
  const member = (caps, roleType = 'BUSINESS_USER') => ({ isPlatformAdmin: false, capabilities: caps, roleType, technician: null });
  check('nobody signed in: no', may(null, EP, 'WORKSTATION', 'low') === false);
  check('Platform Admin: yes', may({ isPlatformAdmin: true, capabilities: [], roleType: null, technician: null }, EP, 'SERVER', 'high'));
  check('member with actions:request: yes', may(member(['computers:view', 'actions:request']), EP, 'WORKSTATION', 'high'));
  check('member without: no', !may(member(['computers:view']), EP, 'WORKSTATION', 'low'));
  for (const r of ['BUSINESS_OWNER', 'TENANT_OWNER', 'TENANT_ADMIN']) check(`owner role ${r}: yes`, may(member([], r), EP, 'WORKSTATION', 'high'));
  const tech = (sources) => ({ isPlatformAdmin: false, capabilities: ['computers:view'], roleType: null, technician: { sources } });
  check('technician, custom grant with actions:request covering every computer: yes', may(tech([{ capabilities: ['actions:request'], endpointIds: null, presetId: null, presetPolicy: null }]), EP, 'WORKSTATION', 'high'));
  check('technician, custom grant naming this computer: yes', may(tech([{ capabilities: ['actions:request'], endpointIds: [EP], presetId: null, presetPolicy: null }]), EP, 'WORKSTATION', 'high'));
  check('technician, custom grant naming another computer: no', !may(tech([{ capabilities: ['actions:request'], endpointIds: ['other'], presetId: null, presetPolicy: null }]), EP, 'WORKSTATION', 'high'));
  check('technician, custom grant without actions:request: no', !may(tech([{ capabilities: ['computers:view'], endpointIds: null, presetId: null, presetPolicy: null }]), EP, 'WORKSTATION', 'low'));
  const preset = (fixRequests, standardWorkstationsOnly = false) => tech([{ capabilities: [], endpointIds: null, presetId: 'p1', presetPolicy: { fixRequests, standardWorkstationsOnly } }]);
  check('preset higher_risk: high yes', may(preset('higher_risk'), EP, 'WORKSTATION', 'high'));
  check('preset low_risk: low yes', may(preset('low_risk'), EP, 'WORKSTATION', 'low'));
  check('preset low_risk: high no', !may(preset('low_risk'), EP, 'WORKSTATION', 'high'));
  check('preset off: no', !may(preset('off'), EP, 'WORKSTATION', 'low'));
  check('preset standardWorkstationsOnly: a server no', !may(preset('higher_risk', true), EP, 'SERVER', 'high'));
  check('preset standardWorkstationsOnly: a workstation yes', may(preset('higher_risk', true), EP, 'WORKSTATION', 'high'));
  check('a preset grant ignores actions:request in its capabilities (as the API does)', !may(tech([{ capabilities: ['actions:request'], endpointIds: null, presetId: 'p1', presetPolicy: { fixRequests: 'off' } }]), EP, 'WORKSTATION', 'low'));
  // The API's rule, read from source, still has these branches.
  const ap = readFileSync(join(API, 'src', 'security-controls', 'access-policy.service.ts'), 'utf8');
  check('the API still decides by actions:request, owner role, custom grant and preset fixRequests',
    /CAP\.ACTIONS_REQUEST/.test(ap) && /isOwnerRole\(actor\.roleType\)/.test(ap) && /fixRequests === 'higher_risk'/.test(ap) && /standardWorkstationsOnly/.test(ap));
  const caps = readFileSync(join(API, 'src', 'rbac', 'capabilities.ts'), 'utf8');
  check('owner roles agree with LEGACY_OWNER_ROLES', /LEGACY_OWNER_ROLES: RoleType\[\] = \[RoleType\.TENANT_OWNER, RoleType\.TENANT_ADMIN\]/.test(caps));
}

// ── 0.76: lib/diagnostic-params.ts mirrors the API's parseDiagnosticParams ──
{
  const load = (file) => {
    const out = ts.transpileModule(readFileSync(file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2021 } }).outputText;
    if (/\brequire\s*\(/.test(out)) throw new Error(`${file} imports a module: it must stay pure`);
    const m = { exports: {} };
    new Function('module', 'exports', out)(m, m.exports);
    return m.exports;
  };
  const W = load(join(WEB, 'lib', 'diagnostic-params.ts'));
  const A = load(join(API, 'src', 'diagnostics-catalog', 'catalog.ts'));
  check('params: the host-name pattern is the API\'s, character for character', W.HOSTNAME_RE_SOURCE === A.HOSTNAME_RE_SOURCE);
  check('params: the same maximum, timeouts, default and fields', W.HOSTNAME_MAX === A.HOSTNAME_MAX && j(W.TCP_TIMEOUTS) === j(A.TCP_TIMEOUTS)
    && W.DEFAULT_TCP_TIMEOUT === A.DEFAULT_TCP_TIMEOUT && j(W.PARAM_FIELDS) === j(A.PARAM_FIELDS));
  const long = `${'a'.repeat(63)}.`.repeat(4).slice(0, 254);
  const names = ['intranet.example.com', '10.0.0.1', 'a', 'A-1.b-2', '-bad.example', 'bad-.example', 'bad_name', 'has space', 'trailing.', '.lead', 'x..y', 'ok\n', 'a\r', '*.example.com',
    'http://x', 'x:80', `${'a'.repeat(63)}.com`, `${'a'.repeat(64)}.com`, long, long.slice(0, 253), '', 'ünïcode.example', 42, null];
  const inputs = [undefined, null, {}, [], 'x', { name: 'x' }, { extra: 1 }, Object.create(null)];
  for (const n of names) {
    inputs.push({ name: n }, { name: n, extra: true }, { host: n, port: 445 }, { host: n, port: 445, timeoutSeconds: 3 });
  }
  for (const port of [0, 1, 22, 65535, 65536, -1, 1.5, '445', NaN, null]) inputs.push({ host: 'h.example', port });
  for (const t of [1, 2, 3, 4, 5, 10, 11, 0, '5', null]) inputs.push({ host: 'h.example', port: 80, timeoutSeconds: t });
  const LABELS = { dns_lookup: 'DNS lookup', tcp_port: 'TCP port test', disk_space: 'Disk space' };
  let compared = 0;
  for (const [key, schema] of [['dns_lookup', 'dns_lookup'], ['tcp_port', 'tcp_port'], ['disk_space', undefined]]) {
    for (const raw of inputs) {
      const a = A.parseDiagnosticParams(key, raw);
      const w = W.parseDiagnosticParams(schema, LABELS[key], raw);
      compared++;
      check(`params: ${key} ${j(raw)} gives the API's answer`, j(a) === j(w), `api ${j(a)} web ${j(w)}`);
    }
  }
  check('params: compared a few hundred inputs', compared > 200, String(compared));
  check('params: portFromText takes digits only', W.portFromText('445') === 445 && Number.isNaN(W.portFromText('44 5')) && Number.isNaN(W.portFromText('0x1BD')) && Number.isNaN(W.portFromText('1e3')) && Number.isNaN(W.portFromText('')));
  check('params: the summary of a run', W.paramsSummary({ name: 'x.example' }) === 'x.example' && W.paramsSummary({ host: 'h', port: 1, timeoutSeconds: 5 }) === 'h:1 (5 s)' && W.paramsSummary(null) === null);
}

if (failures.length) {
  console.log(`${passed} passed, ${failures.length} failed`);
  for (const f of failures) console.log(`  ✗ ${f}`);
  process.exit(1);
}
console.log(`${passed} passed, 0 failed`);
