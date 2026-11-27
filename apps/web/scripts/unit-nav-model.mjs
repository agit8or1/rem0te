#!/usr/bin/env node
// Tests for the navigation model (0.87 Compass), apps/web/components/layout/nav-model.ts.
//
//   node apps/web/scripts/unit-nav-model.mjs
//
// The model is transpiled with the workspace's TypeScript and run with two
// stand-ins: lucide-react (every icon a named function) and @/lib/auth (CAP,
// read from lib/auth.ts itself). Covered:
//
//   - every entry is a page that exists, and no URL is listed twice;
//   - every URL the menu had before 0.87 (docs/NAVIGATION_MIGRATION.md's
//     table, which this reads) is still reachable from the menu or the palette;
//   - Standard mode never makes a page unreachable: every advanced entry is a
//     tab of its hub's pages and is in the palette's Pages, for everyone who
//     may see it;
//   - the group ids agree with the API (navigation/model.ts GROUP_IDS) and
//     migration 0104's CHECK, in order;
//   - locate() and the breadcrumbs' owners: longest href wins;
//   - roles: a customer never sees MSP pages, a technician never sees the
//     owner's, a Platform Admin sees every entry;
//   - the 1,080 p budget: the sidebar fits in 950 px with the largest group
//     open, in both modes (36 px group rows, 32 px entries).

import { createRequire } from 'node:module';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const WEB = join(here, '..');
const ROOT = join(WEB, '..', '..');
const API = join(WEB, '..', 'api');
const require = createRequire(join(WEB, 'package.json'));
const ts = require('typescript');

let passed = 0;
const failures = [];
const check = (name, ok, detail = '') => { if (ok) passed++; else failures.push(`${name}${detail ? ` — ${detail}` : ''}`); };

// ── Load the model ──────────────────────────────────────────────────────────
const authSrc = readFileSync(join(WEB, 'lib', 'auth.ts'), 'utf8');
const capBlock = /export const CAP = (\{[\s\S]*?\}) as const;/.exec(authSrc);
if (!capBlock) throw new Error('CAP not found in lib/auth.ts');
const CAP = new Function(`return ${capBlock[1]};`)();

const icons = new Proxy({}, { get: (_t, name) => { const f = () => null; f.iconName = String(name); return f; } });
const src = readFileSync(join(WEB, 'components', 'layout', 'nav-model.ts'), 'utf8');
const js = ts.transpileModule(src, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2021 } }).outputText;
const mod = { exports: {} };
// 0.90: the technician workspaces (pure, no imports).
const wsSrc = readFileSync(join(WEB, 'lib', 'workspace-modes.ts'), 'utf8');
const wsJs = ts.transpileModule(wsSrc, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2021 } }).outputText;
if (/\brequire\s*\(/.test(wsJs)) throw new Error('lib/workspace-modes.ts imports a module: it must stay pure');
const wsMod = { exports: {} };
new Function('module', 'exports', wsJs)(wsMod, wsMod.exports);
const W = wsMod.exports;
const req = (id) => {
  if (id === 'lucide-react') return icons;
  if (id === '@/lib/auth') return { CAP };
  if (id === '@/lib/workspace-modes') return W;
  throw new Error(`nav-model.ts imports ${id}: only lucide-react, @/lib/auth and @/lib/workspace-modes are allowed`);
};
new Function('module', 'exports', 'require', js)(mod, mod.exports, req);
const M = mod.exports;
const { NAV, EXTRA_PAGES } = M;

const ALL_CAPS = new Set(Object.values(CAP));
const ctx = (over = {}) => ({
  can: (c) => (over.caps ?? ALL_CAPS).has(c),
  isPlatformAdmin: false, isBusinessOwner: false, technician: false, hasAssignments: false,
  canManageTechnicians: false, isIndependentReviewer: false, ...over,
});
const ROLES = {
  platformAdmin: ctx({ isPlatformAdmin: true, canManageTechnicians: true, isIndependentReviewer: true, isBusinessOwner: true, hasAssignments: true }),
  mspManager: ctx({ canManageTechnicians: true, caps: new Set([CAP.COMPUTERS_VIEW, CAP.COMPUTERS_EDIT, CAP.ALERTS_VIEW, CAP.SESSIONS_VIEW, CAP.QUICK_CONNECT]) }),
  technician: ctx({ technician: true, hasAssignments: true, caps: new Set([CAP.COMPUTERS_VIEW, CAP.ALERTS_VIEW, CAP.SESSIONS_VIEW]) }),
  businessOwner: ctx({ isBusinessOwner: true }),
  businessUser: ctx({ caps: new Set([CAP.COMPUTERS_VIEW, CAP.SESSIONS_VIEW]) }),
};
const leaves = NAV.flatMap((s) => s.items.map((i) => ({ ...i, section: s.id })));

// ── Every entry is a page; no URL twice ─────────────────────────────────────
for (const l of [...leaves, ...EXTRA_PAGES]) {
  const page = join(WEB, 'app', '(app)', ...l.href.split('/').filter(Boolean), 'page.tsx');
  check(`${l.href} is a page`, existsSync(page), page);
  check(`${l.href} has a tier`, l.tier === 'standard' || l.tier === 'advanced');
}
const hrefs = leaves.map((l) => l.href);
check('no URL is in the menu twice', new Set(hrefs).size === hrefs.length, hrefs.filter((h, i) => hrefs.indexOf(h) !== i).join(', '));
for (const s of NAV) {
  const labels = s.items.map((i) => i.label);
  check(`${s.id}: labels are unique`, new Set(labels).size === labels.length);
  check(`${s.id}: has an entry`, s.items.length > 0);
}
check('nine groups', NAV.length === 9, String(NAV.length));
check('the Add device entry keeps its test id', leaves.some((l) => l.href === '/endpoints/enroll' && l.testId === 'nav-shortcut-devices'));

// ── Old URLs (docs/NAVIGATION_MIGRATION.md) ─────────────────────────────────
const mig = readFileSync(join(ROOT, 'docs', 'NAVIGATION_MIGRATION.md'), 'utf8');
const rows = [...mig.matchAll(/^\| *([^|]+?) *\| *([^|]+?) *\| *`(\/[^`]*)` *\| *([^|]+?) *\|/gm)].map((m) => ({ label: m[1], before: m[2], href: m[3], after: m[4] }));
check('the migration table lists the old menu (at least 60 rows)', rows.length >= 60, String(rows.length));
const reachable = new Set([...hrefs, ...EXTRA_PAGES.map((p) => p.href)]);
for (const r of rows) {
  check(`migration: ${r.href} (${r.label}) is still in the menu or the palette`, reachable.has(r.href));
  const now = leaves.find((l) => l.href === r.href) ?? EXTRA_PAGES.find((l) => l.href === r.href);
  if (now && leaves.includes(now)) {
    const group = NAV.find((s) => s.items.some((i) => i.href === r.href));
    check(`migration: ${r.href} is documented under its group (${group.label})`, r.after.includes(group.label), r.after);
  }
}
for (const l of leaves) check(`migration: ${l.href} is in the table`, rows.some((r) => r.href === l.href));

// ── Standard never makes a page unreachable ────────────────────────────────
for (const [role, c] of Object.entries(ROLES)) {
  const pages = new Set(M.allPages(c).map((p) => p.href));
  for (const s of NAV) {
    const visible = M.visibleItems(s, c);
    const standard = M.sidebarItems(s, c, 'standard');
    const advanced = M.sidebarItems(s, c, 'advanced');
    check(`${role}/${s.id}: Advanced lists every visible entry`, advanced.length === visible.length);
    for (const l of visible) {
      check(`${role}: ${l.href} is in the palette's Pages`, pages.has(l.href));
      if (standard.includes(l)) continue;
      // Not in the Standard sidebar: it must be a tab of a page that is.
      const tabs = M.hubTabs(l.href, c);
      check(`${role}: advanced ${l.href} is a tab of its hub`, !!tabs && tabs.items.some((i) => i.href === l.href));
      const sibling = tabs?.items.find((i) => standard.includes(i));
      check(`${role}: advanced ${l.href} is reachable from a Standard entry's tabs`, !!sibling || standard.length === 0, l.hub ?? 'no hub');
    }
  }
  // Every item the sidebar can draw passes its own show().
  for (const s of NAV) for (const l of M.sidebarItems(s, c, 'advanced')) check(`${role}: ${l.href} shown only when show() says so`, l.show(c));
}
for (const l of leaves) if (l.tier === 'advanced') check(`${l.href}: an advanced entry has a hub`, !!l.hub);

// ── Groups agree with the API and 0104 ──────────────────────────────────────
const apiModel = readFileSync(join(API, 'src', 'navigation', 'model.ts'), 'utf8');
const apiGroups = JSON.parse((/export const GROUP_IDS = (\[[^\]]+\])/.exec(apiModel)?.[1] ?? '[]').replace(/'/g, '"'));
check('GROUP_IDS: the web model and navigation/model.ts agree, in order', JSON.stringify(M.GROUP_IDS) === JSON.stringify(apiGroups), `${M.GROUP_IDS} / ${apiGroups}`);
const sql = readFileSync(join(API, 'prisma', 'migrations', '0104_navigation', 'migration.sql'), 'utf8');
const sqlGroups = [...(/<@ ARRAY\[([^\]]+)\]/.exec(sql)?.[1] ?? '').matchAll(/'([^']+)'/g)].map((m) => m[1]);
check('GROUP_IDS: 0104 CHECK names the same groups, in order', JSON.stringify(sqlGroups) === JSON.stringify(apiGroups), sqlGroups.join(','));

// ── locate() ────────────────────────────────────────────────────────────────
const owner = (p) => { const r = M.locate(p); return r ? `${r.section.id}:${r.leaf?.href ?? '-'}` : null; };
const cases = [
  ['/endpoints', 'devices:/endpoints'], ['/endpoints/abc123def', 'devices:/endpoints'], ['/endpoints/enroll', 'devices:/endpoints/enroll'],
  ['/endpoints/remote-readiness', 'remote:/endpoints/remote-readiness'], ['/businesses/xyz12345', 'devices:/businesses'],
  ['/settings/security/containment', 'security:/settings/security/containment'], ['/settings', 'admin:/settings'],
  ['/settings/monitoring', 'monitoring:/settings/monitoring'], ['/patching/policies/abc', 'patching:/patching'],
  ['/automation/scripts/abc12345', 'automation:/automation/scripts'], ['/reports', 'reports:-'], ['/dashboard', 'dashboard:/dashboard'],
  ['/alerts/quality', 'monitoring:/alerts/quality'], ['/nowhere', null],
];
for (const [p, want] of cases) check(`locate(${p})`, owner(p) === want, `${owner(p)} ≠ ${want}`);
check('hubTabs: only on the entry\'s own page', M.hubTabs('/endpoints/abc123def', ROLES.platformAdmin) === null && !!M.hubTabs('/endpoints', ROLES.platformAdmin));

// ── Roles (cosmetic, but it should not mislead) ─────────────────────────────
const sees = (c) => new Set(NAV.flatMap((s) => M.visibleItems(s, c)).map((l) => l.href));
const pa = sees(ROLES.platformAdmin);
check('a Platform Admin sees every entry', leaves.every((l) => pa.has(l.href)), leaves.filter((l) => !pa.has(l.href)).map((l) => l.href).join(', '));
const PA_ONLY = ['/businesses', '/admin/unassigned', '/admin/deploy', '/admin/security', '/admin/access', '/admin/sso', '/settings/ai', '/settings/email', '/settings/warranty', '/settings/backups', '/settings/mobile-devices', '/admin/status', '/admin/rollouts', '/settings/security/update-signing'];
for (const role of ['businessOwner', 'businessUser', 'technician']) {
  const s = sees(ROLES[role]);
  for (const h of PA_ONLY) check(`${role} does not see ${h}`, !s.has(h));
}
const tech = sees(ROLES.technician);
for (const h of ['/technician-approvals', '/offboarding', '/reports/schedules', '/settings/security/features']) check(`a technician does not see the owner's ${h}`, !tech.has(h));
check('a technician sees All assigned', tech.has('/technician'));
const user = sees(ROLES.businessUser);
for (const h of ['/settings', '/users', '/audit', '/settings/security/containment', '/settings/monitoring']) check(`a Business User does not see ${h}`, !user.has(h));

// ── The 1,080 p budget ──────────────────────────────────────────────────────
// Group rows 36 px, the rows inside a group 32 px (globals.css --nav-row / --nav-child-row).
const ROW = 36, CHILD = 32, HEADER = 48, FOOTER = 37, PAD = 16;
for (const mode of ['standard', 'advanced']) {
  for (const [role, c] of Object.entries(ROLES)) {
    const groups = NAV.filter((s) => M.visibleItems(s, c).length);
    const rowsOf = (s) => { const n = M.sidebarItems(s, c, mode).length; return s.kind === 'link' || n <= 1 ? 0 : n; };
    const biggest = Math.max(0, ...groups.map(rowsOf));
    const h = HEADER + PAD + groups.length * ROW + biggest * CHILD + FOOTER;
    check(`${role}/${mode}: fits a 1,080 p screen with the largest group open (${h} px ≤ 950)`, h <= 950, `${h}`);
  }
}


// ── Technician workspaces (0.90, P1-4; directive §11) ───────────────────────
{
  const allHrefs = new Set([...leaves.map((l) => l.href)]);
  const apiModel = readFileSync(join(API, 'src', 'navigation', 'model.ts'), 'utf8');
  const apiWs = [...((apiModel.match(/export const WORKSPACES = \[([^\]]*)\] as const;/) ?? ['', ''])[1]).matchAll(/'([^']+)'/g)].map((m) => m[1]);
  const sqlWs = [...((readFileSync(join(API, 'prisma', 'migrations', '0105_nav_workspace', 'migration.sql'), 'utf8').match(/"workspace" IN \(([^)]*)\)/) ?? ['', ''])[1]).matchAll(/'([^']+)'/g)].map((m) => m[1]);
  check('workspaces: the web, the API and 0105 name the same ids in the same order', JSON.stringify(W.WORKSPACE_IDS) === JSON.stringify(apiWs) && JSON.stringify(apiWs) === JSON.stringify(sqlWs), `${W.WORKSPACE_IDS} / ${apiWs} / ${sqlWs}`);
  check('workspaces: "all" is first and is every page (the default)', W.WORKSPACES[0].id === 'all' && W.WORKSPACES[0].pages === null && W.WORKSPACES[0].deviceGroups === null);
  const dm = readFileSync(join(WEB, 'components', 'endpoints', 'workspace', 'device-model.ts'), 'utf8');
  const groupIds = [...((dm.match(/export const TAB_GROUPS[\s\S]*?\n\];/) ?? [''])[0]).matchAll(/\{ id: '([a-z]+)'/g)].map((m) => m[1]);
  check('workspaces: the device page has seven tab groups to order', groupIds.length === 7, groupIds.join(','));
  let prev = null;
  for (const w of W.WORKSPACES.slice(1)) {
    for (const h of w.pages) check(`workspace ${w.id}: ${h} is a menu page`, allHrefs.has(h));
    check(`workspace ${w.id}: no page twice`, new Set(w.pages).size === w.pages.length);
    check(`workspace ${w.id}: starts at the dashboard`, w.pages[0] === '/dashboard');
    if (prev) check(`workspace ${w.id}: includes every page of ${prev.id}`, prev.pages.every((h) => w.pages.includes(h)));
    check(`workspace ${w.id}: orders every device tab group exactly once`, JSON.stringify([...w.deviceGroups].sort()) === JSON.stringify([...groupIds].sort()), w.deviceGroups.join(','));
    check(`workspace ${w.id}: Overview stays first on the device page`, w.deviceGroups[0] === 'overview');
    prev = w;
  }
  // §11 L1: assigned customers, device search, health, alerts, remote support, support requests, action status.
  for (const h of ['/technician', '/endpoints', '/dashboard', '/alerts', '/sessions', '/support-requests', '/automation/tasks']) check(`workspace l1 has ${h}`, W.inWorkspace('l1', h));
  for (const h of ['/patching', '/automation/software', '/automation/scripts']) check(`workspace l2 has ${h} (L1 does not)`, W.inWorkspace('l2', h) && !W.inWorkspace('l1', h));
  for (const h of ['/automation/schedules', '/admin/rollouts', '/settings/client-updates', '/settings/security/containment']) check(`workspace l3 has ${h} (L2 does not)`, W.inWorkspace('l3', h) && !W.inWorkspace('l2', h));
  check('workspace l1 puts Tools before System on the device page', W.WORKSPACES[1].deviceGroups.indexOf('tools') < W.WORKSPACES[1].deviceGroups.indexOf('system'));
  check('an unknown workspace is "all"', W.workspaceOf('l9').id === 'all' && W.workspaceOf(undefined).id === 'all' && W.inWorkspace('nope', '/admin/sso'));
  const groupsIn = [{ id: 'overview' }, { id: 'health' }, { id: 'software' }, { id: 'system' }, { id: 'tools' }, { id: 'remote' }, { id: 'history' }];
  check('orderGroups("all") keeps the page\'s order', JSON.stringify(W.orderGroups('all', groupsIn).map((g) => g.id)) === JSON.stringify(groupsIn.map((g) => g.id)));
  check('orderGroups never drops or adds a group', W.WORKSPACES.every((w) => W.orderGroups(w.id, groupsIn).length === groupsIn.length));
  check('orderGroups keeps a group the list does not name, at the end', W.orderGroups('l1', [...groupsIn, { id: 'extra' }]).at(-1).id === 'extra');
  check('the not-a-page list names escalation and PSA tickets, each with a reason', ['Escalation', 'Related PSA tickets'].every((l) => W.NOT_A_PAGE.some((n) => n.label === l && n.why.length > 20)));

  // Presentation only: in every role and workspace, the sidebar lists only what show() allows, and nothing outside the workspace.
  for (const [role, c] of Object.entries(ROLES)) {
    for (const w of W.WORKSPACES) {
      for (const mode of ['standard', 'advanced']) {
        for (const s of NAV) {
          const items = M.sidebarItems(s, c, mode, w.id);
          for (const l of items) {
            check(`${role}/${w.id}/${mode}: ${l.href} only when show() says so`, l.show(c));
            check(`${role}/${w.id}/${mode}: ${l.href} is in the workspace`, W.inWorkspace(w.id, l.href));
          }
          if (w.pages) check(`${role}/${w.id}/${mode}/${s.id}: the mode does not matter inside a workspace`, JSON.stringify(items.map((i) => i.href)) === JSON.stringify(M.sidebarItems(s, c, mode === 'standard' ? 'advanced' : 'standard', w.id).map((i) => i.href)));
        }
      }
      // Every page this person can open is still in the palette, in every workspace (allPages takes no workspace).
      check(`${role}/${w.id}: the palette still offers every page`, M.allPages.length === 1);
    }
  }
  check('sidebarItems defaults to every page ("all")', NAV.every((s) => JSON.stringify(M.sidebarItems(s, ROLES.platformAdmin, 'advanced')) === JSON.stringify(M.sidebarItems(s, ROLES.platformAdmin, 'advanced', 'all'))));
}

console.log(`unit-nav-model: ${passed} passed, ${failures.length} failed`);
if (failures.length) { for (const f of failures) console.log(`  ✗ ${f}`); process.exit(1); }
