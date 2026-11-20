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
// API's catalogs and the device page.

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
  agentKind: 'signed', readOnlyOs: null, agentVersion: '0.73.0', agentActions: [...ALL_ACTIONS], status: 'ACTIVE', pooled: false, agentBound: true,
  connectivity: 'online', connectivityText: 'Online', signer: { configured: true, approval: 'signed' }, paused: [],
  perms: { view: true, eventLogs: true, requestLow: true, requestHigh: true }, actionRisk: { 'windows.service.start': 'low' }, restartPending: false,
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
  check('eight groups, in the directive order', j(T.TOOL_GROUPS.map((g) => g.label)) === j(['Diagnostics', 'PowerShell / Scripts', 'Services & Processes', 'Software', 'Windows Updates', 'Networking', 'Security', 'Maintenance']));
  check('every tool belongs to a known group', tools.every((t) => T.TOOL_GROUPS.some((g) => g.id === t.group)));
  const later = tools.filter((t) => kindOf(t) === 'later').map((t) => t.id);
  check('only two tools are "coming later" (flush DNS / renew DHCP, security posture)', j(later) === j(['flush-dns', 'security-posture']), j(later));
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
const later = (t) => kindOf(t) === 'later';

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
  const got = scenario('standard', f, (t) => (later(t) ? 'coming_later' : isAction(t) ? 'needs_newer_agent' : 'available'));
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
  scenario('other pauses', r, (t) => (later(t) ? 'coming_later' : isAction(t) ? 'needs_approval' : 'available'));
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
  const gp = scenario('pooled', pool, (t) => (later(t) ? 'coming_later' : ['action', 'diagnostic'].includes(kindOf(t)) ? 'inactive' : 'available'));
  check('pooled: says adopt it first', /unassigned pool/.test(gp['disk-space'].reason));
  const u = base(); u.agentBound = false;
  scenario('unbound', u, (t) => (later(t) ? 'coming_later' : kindOf(t) === 'diagnostic' ? 'inactive' : isAction(t) ? 'needs_approval' : 'available'));
  const unk = base(); unk.agentBound = null;
  scenario('agentBound not read', unk, (t) => (later(t) ? 'coming_later' : isAction(t) ? 'needs_approval' : 'available'));
}
// 13. An agent older than the snapshots (0.33.0).
{
  const f = base(); f.agentKind = 'standard'; f.agentActions = []; f.agentVersion = '0.32.4';
  scenario('agent 0.32.4', f, (t) => (later(t) ? 'coming_later' : ['services', 'processes', 'network'].includes(t.id) || isAction(t) ? 'needs_newer_agent' : 'available'));
  const g = base(); g.agentVersion = 'garbage';
  check('an unparseable version is not "too old"', states(g)['services'].state === 'available');
  const x = base(); x.agentVersion = '0.33.0';
  check('exactly 0.33.0 is new enough', states(x)['services'].state === 'available');
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

if (failures.length) {
  console.log(`${passed} passed, ${failures.length} failed`);
  for (const f of failures) console.log(`  ✗ ${f}`);
  process.exit(1);
}
console.log(`${passed} passed, 0 failed`);
