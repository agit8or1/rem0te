#!/usr/bin/env node
// Rem0te documentation screenshot pipeline.
//
// - Seeds a fresh platform-admin user in the dev DB.
// - Uses Playwright (headless Chromium) against the isolated docs stack (default http://127.0.0.1:4000).
// - Captures in light theme. THEMES below says why dark is not written.
// - Writes to docs/screenshots/{page}-{theme}.png.
// - Cleans up the throwaway user at the end.
//
// Uses fictional demo data only. Redacts any accidentally-visible strings
// matching common credential patterns (ghp_*, rk_*, etc.) via CSS masking
// before capture. Never runs against production.
//
// Usage:  cd apps/web && DATABASE_URL=postgresql://…/reboot_remote_docs WEB_URL=http://127.0.0.1:4000 node scripts/screenshots.mjs
//         ONLY=guide/alerts,guide/docs-index  (optional: capture just these)

import { chromium } from 'playwright';
import { createRequire } from 'module';
import { randomBytes } from 'crypto';
import { mkdir } from 'fs/promises';
import { fileURLToPath } from 'url';
import path from 'path';
import { applyMasks } from './capture-masks.mjs';

// Playwright lives in apps/web; Prisma and argon2 live in apps/api. Rather than
// duplicate either dependency, resolve the API-side ones against the API's own
// package root.
const HERE = path.dirname(fileURLToPath(import.meta.url));
const apiRequire = createRequire(path.resolve(HERE, '../../api/package.json'));
const { PrismaClient } = apiRequire('@prisma/client');
const argon2 = apiRequire('argon2');

const prisma = new PrismaClient();

const WEB = process.env.WEB_URL ?? 'http://127.0.0.1:4000';

// This script seeds a user (and, on an empty database, demo businesses) and
// changes relay settings for the run. Refuse anything that could be live —
// the same guard as capture-media.mjs, plus the database name the demo-data
// module insists on. See docs/screenshots.md ("Regenerating these").
if (/:(3000|443)\b/.test(WEB) || /^https:\/\//.test(WEB)) {
  throw new Error(`Refusing to capture against ${WEB} — point WEB_URL at the isolated demo stack`);
}
if (!(process.env.DATABASE_URL ?? '').includes('reboot_remote_docs')) {
  throw new Error('Refusing to run: DATABASE_URL is not the reboot_remote_docs database');
}
const OUT_DIR = process.env.OUT_DIR ?? path.resolve(HERE, '../../../docs/screenshots');
const VIEWPORT = { width: 1440, height: 900 };

// Only pages that docs/*.md actually embed are captured. Everything else was
// being written, committed and shipped into apps/web/public/docs-img without a
// single reference to it — 34 files and 3.6 MB of it. Adding a page back is one
// line here plus the `![...](screenshots/<name>-light.png)` that uses it; a
// capture nobody references is the state this list is meant to prevent.
const PAGES = [
  { path: '/about', name: 'updates' },
];

/**
 * Pages captured with numbered callouts drawn over them.
 *
 * The guide shots were made by hand once and then could not be regenerated,
 * so they went stale the moment the navigation changed — one of them still
 * highlighted a menu entry that had moved. Marking up in the browser means
 * they are rebuilt with everything else.
 *
 * `find` is a CSS selector, or { text } to match an element by its content
 * when there is nothing stable to select on.
 */
const CALLOUT_PAGES = [
  {
    // 0.36: signed out, so it is captured in the clean context below. It had
    // been made by hand in 0.13 and never regenerated, so it still showed
    // white text on the accent band — 3.7:1 on the default blue.
    name: 'guide/tech-01-signin',
    signedOut: true,
    path: '/login',
    before: async (page) => { await page.waitForSelector('[data-accent-band], input[type=email]', { timeout: 15_000 }); await page.waitForTimeout(800); },
    callouts: [
      { find: 'input[type=email]' },
      { find: 'input[type=password]' },
      { find: 'button[type=submit]' },
    ],
  },
  {
    name: 'guide/tech-02-computers',
    path: '/endpoints',
    callouts: [
      { find: 'a[href="/endpoints"]' },
      // Connect is on each row and on the device's own page.
      { find: 'input[aria-label="Search devices"]' },
      { find: 'table' },
      { find: { text: 'Add device', tag: 'a' } },
    ],
  },
  {
    name: 'guide/tech-03-connect',
    path: '/my-computers',
    callouts: [
      { find: 'a[href="/my-computers"]' },
      { find: { text: 'Connect', tag: 'button' } },
    ],
  },
  {
    name: 'guide/tech-04-quick-connect',
    path: '/quick-connect',
    callouts: [
      { find: 'a[href="/quick-connect"]' },
      { find: 'input' },
    ],
  },
  {
    name: 'guide/tech-05-sessions',
    path: '/sessions',
    callouts: [
      { find: 'a[href="/sessions"]' },
      // Exact selectors: text matching is by substring, and "Connect" is
      // inside "Connected" and "Quick Connect".
      { find: '[role="tab"][id$="-trigger-connected"]' },
      { find: '[role="tab"][id$="-trigger-history"]' },
      { find: 'main .grid button' },
      { find: 'a[href="/quick-connect"]:not(nav a):not([data-section-tabs] a)' },
    ],
  },
  {
    name: 'guide/tech-06-updates',
    path: '/about',
    // The RustDesk client panel sits below the server's own version card.
    height: 1900,
    callouts: [
      { find: 'a[href="/about"]' },
      { find: { text: 'Update all outdated', tag: 'button' } },
      { find: 'button[title="Check for a newer RustDesk release"]' },
    ],
  },
  {
    name: 'guide/downloads',
    path: '/downloads',
    callouts: [
      { find: 'a[href="/downloads"]' },
      { find: { text: 'Set up this computer for Connect' } },
      { find: { text: 'RustDesk client, preconfigured' } },
      { find: { text: 'RustDesk client, unconfigured' } },
    ],
  },
  {
    name: 'guide/docs',
    path: '/docs',
    callouts: [
      { find: 'a[href="/docs"]' },
      { find: 'input[aria-label="Search the documentation"]' },
      { find: '[data-testid="docs-index"] section' },
    ],
  },
  // 0.29 — documentation search with highlighted results.
  {
    name: 'guide/docs-search',
    path: '/docs',
    before: async (page) => { await page.fill('[data-testid="docs-search"]', 'maintenance window'); await page.waitForTimeout(400); },
    callouts: [
      { find: '[data-testid="docs-search"]' },
      { find: '[data-testid="docs-results"] a' },
    ],
  },
  {
    name: 'guide/docs-article',
    height: 1100,
    path: '/docs/monitoring',
    callouts: [
      { find: 'nav[aria-label="Documentation"]' },
      { find: '[data-testid="docs-toc"]' },
      { find: { text: 'min read', tag: 'span' } },
    ],
  },
  // 0.29 — monitoring and alerts.
  {
    name: 'guide/alerts',
    height: 1240,
    path: '/alerts',
    before: async (page) => {
      await page.waitForSelector('text=Tacoma warehouse', { timeout: 15_000 });
      await page.click('button:has-text("Tacoma warehouse")');
      await page.waitForSelector('[data-testid="alert-detail"]', { timeout: 10_000 });
      await page.waitForTimeout(500);
    },
    callouts: [
      { find: 'a[href="/alerts"]' },
      { find: '[data-testid="alerts-summary"]' },
      { find: '[data-testid="alerts-filters"]' },
      { find: { text: 'Computers in this outage' } },
      { find: { text: 'Acknowledge', tag: 'button' } },
    ],
  },
  {
    name: 'guide/monitoring-settings',
    path: '/settings/monitoring',
    before: async (page) => {
      await page.waitForSelector('#mon-business', { timeout: 15_000 });
      await page.selectOption('#mon-business', { label: 'Harbor Logistics' });
      await page.waitForSelector('text=Label printing', { timeout: 10_000 });
      await page.waitForTimeout(500);
    },
    callouts: [
      { find: '#mon-business' },
      { find: '[role="tablist"]' },
      { find: { text: 'Add recommended', tag: 'button' } },
      { find: { text: 'overridden below', tag: 'div' } },
      { find: { text: 'Switch off for this business', tag: 'button' } },
    ],
  },
  {
    name: 'guide/monitoring-notify',
    // 1250 from 0.36: the outbound-email notice (0.34) pushed the ClientSt0r
    // row and Save below a 1000 px window, so callouts 3–4 drew off the page.
    height: 1250,
    path: '/settings/monitoring',
    before: async (page) => {
      await page.waitForSelector('[role="tablist"]', { timeout: 15_000 });
      await page.click('[role="tab"]:has-text("Notifications")');
      await page.waitForSelector('[data-testid="mon-policy"] input', { timeout: 10_000 });
      await page.waitForTimeout(400);
    },
    callouts: [
      { find: { text: 'Level 1', tag: 'div' } },
      { find: { text: 'Level 2', tag: 'div' } },
      { find: { text: 'Offer alerts to ClientSt0r', tag: 'label' } },
      { find: { text: 'Save (re-authenticate)', tag: 'button' } },
    ],
  },
  {
    name: 'guide/endpoint-monitoring',
    height: 1500,
    path: '@endpoint:HARB-DISPATCH-01?tab=monitoring',
    before: async (page) => { await page.waitForSelector('[data-testid="endpoint-monitoring"]', { timeout: 15_000 }); await page.waitForTimeout(500); },
    callouts: [
      { find: '[role="tab"][data-state="active"]' },
      { find: '[data-testid="mon-alerts"]' },
      { find: '[data-testid="mon-effect"]' },
      { find: '[data-testid="mon-changes"]' },
    ],
  },
  {
    name: 'guide/api-keys',
    height: 1000,
    path: '/settings/api-keys',
    before: async (page) => {
      await page.waitForSelector('#ak-business', { timeout: 15_000 });
      await page.selectOption('#ak-business', { label: 'Harbor Logistics' });
      await page.fill('#ak-name', 'PSA sync');
      await page.waitForTimeout(400);
    },
    callouts: [
      { find: '#ak-business' },
      { find: '#ak-name' },
      { find: '[data-testid="apikey-create"] fieldset' },
      { find: { text: 'Create key', tag: 'button' } },
      { find: '[data-testid="apikey-list"]' },
    ],
  },
  // ── 0.31–0.33: the workbench ────────────────────────────────────────────
  {
    name: 'guide/dashboard',
    height: 1000,
    path: '/dashboard',
    before: async (page) => { await page.waitForSelector('text=Work on next', { timeout: 15_000 }); await page.waitForTimeout(2500); },
    callouts: [
      { find: { text: 'Site outage:', tag: 'div' } },
      { find: { text: 'Devices', tag: 'a' }, within: 'main' },
      { find: { text: 'Work on next', tag: 'div' }, card: true },
      { find: { text: 'Customers affected', tag: 'div' }, card: true },
    ],
  },
  {
    // From 0.35 the map is in the dashboard's grid; scrollIntoView is a no-op
    // at this height and kept for narrower runs.
    name: 'guide/dashboard-map',
    height: 1000,
    path: '/dashboard',
    before: async (page) => {
      await page.waitForSelector('[data-testid="dashboard-map"]', { timeout: 15_000 });
      await page.evaluate(() => document.querySelector('[data-testid="dashboard-map"]').scrollIntoView({ block: 'end' }));
      await page.waitForTimeout(3000);
    },
    callouts: [
      { find: '[data-testid="dashboard-map"]' },
      { find: { text: 'Hide device locations', tag: 'button' } },
    ],
  },
  {
    name: 'guide/device-list',
    path: '/endpoints',
    before: async (page) => {
      await page.waitForSelector('table', { timeout: 15_000 });
      for (const n of ['ACF-CAD-WS', 'ACF-SHOPFLOOR-1', 'CASC-AUDIT-02']) {
        await page.check(`input[aria-label="Select ${n}"]`).catch(() => {});
      }
      await page.waitForSelector('[aria-label="Bulk actions"]', { timeout: 10_000 });
      // Checking a box scrolls it into view; put every scroller back at the top.
      await page.evaluate(() => { for (const el of document.querySelectorAll('*')) if (el.scrollTop) el.scrollTop = 0; window.scrollTo(0, 0); });
      await page.waitForTimeout(400);
    },
    callouts: [
      { find: 'input[aria-label="Search devices"]' },
      { find: { text: 'Group:', tag: 'button' } },
      { find: { text: 'Views', tag: 'button' } },
      { find: { text: 'Columns', tag: 'button' } },
      { find: 'input[aria-label="Select ACF-CAD-WS"]' },
      { find: '[aria-label="Bulk actions"]' },
    ],
  },
  {
    name: 'guide/device-views',
    path: '/endpoints',
    before: async (page) => {
      await page.waitForSelector('table', { timeout: 15_000 });
      await page.click('button:has-text("Views")');
      await page.waitForSelector('[role="menu"]', { timeout: 10_000 });
      await page.waitForTimeout(400);
    },
    callouts: [
      { find: { text: 'Views', tag: 'button' } },
      { find: { text: 'Harbor — offline', tag: '[role="menuitem"]' } },
      { find: { text: 'Save', tag: '[role="menuitem"]' } },
    ],
  },
  {
    name: 'guide/search',
    path: '/dashboard',
    before: async (page) => {
      await page.waitForSelector('text=Work on next', { timeout: 15_000 });
      await page.keyboard.press('Control+k');
      await page.waitForSelector('[data-testid="global-search-input"]', { timeout: 10_000 });
      await page.fill('[data-testid="global-search-input"]', 'harb');
      await page.waitForSelector('#gs-results [role="group"]', { timeout: 10_000 });
      await page.waitForTimeout(600);
    },
    callouts: [
      { find: '[data-testid="global-search-input"]' },
      { find: '#gs-results [role="group"]' },
      { find: '#gs-results [role="group"]:nth-of-type(2)' },
    ],
  },
  {
    name: 'guide/device-overview',
    height: 1300,
    path: '@endpoint:HARB-DISPATCH-01',
    before: async (page) => { await page.waitForSelector('[data-testid="device-header"]', { timeout: 15_000 }); await page.waitForTimeout(1200); },
    callouts: [
      { find: '[data-testid="device-status"]' },
      { find: '[data-testid="device-actions"]' },
      { find: '[data-testid="attention-strip"]' },
      { find: '[role="tablist"]' },
      { find: '[data-testid="overview-patches"]' },
    ],
  },
  {
    name: 'guide/device-performance',
    height: 1000,
    path: '@endpoint:HARB-DISPATCH-01?tab=performance',
    before: async (page) => {
      await page.waitForSelector('[data-testid="performance-tab"]', { timeout: 15_000 });
      await page.click('[data-testid="metric-range-7d"]').catch(() => {});
      await page.waitForTimeout(1800);
    },
    callouts: [
      { find: '[data-testid="metric-range"]' },
      { find: { text: 'Processor', tag: 'div' }, card: true },
      { find: { text: 'Volume C: used', tag: 'div' }, card: true },
      { find: { text: 'Show as a table', tag: 'summary' } },
    ],
  },
  {
    name: 'guide/device-processes',
    height: 1000,
    path: '@endpoint:HARB-DISPATCH-01?tab=processes',
    before: async (page) => { await page.waitForSelector('[data-testid="snapshot-age"]', { timeout: 15_000 }); await page.waitForTimeout(600); },
    callouts: [
      { find: { text: 'Read-only snapshot' } },
      { find: '[data-testid="snapshot-age"]' },
      { find: '[data-testid="snapshot-refresh"]' },
      { find: 'input[aria-label="Filter processes"]' },
      { find: 'main table thead' },
    ],
  },
  {
    name: 'guide/device-services',
    height: 1000,
    path: '@endpoint:HARB-DISPATCH-01?tab=services',
    before: async (page) => {
      await page.waitForSelector('input[aria-label="Filter services"]', { timeout: 15_000 });
      await page.fill('input[aria-label="Filter services"]', 'sp');
      await page.waitForTimeout(600);
    },
    callouts: [
      { find: 'input[aria-label="Filter services"]' },
      { find: { text: 'Print Spooler', tag: 'tr' } },
      { find: '[data-testid="snapshot-refresh"]' },
    ],
  },
  {
    name: 'guide/device-network',
    height: 1000,
    path: '@endpoint:HARB-DISPATCH-01?tab=network',
    before: async (page) => { await page.waitForSelector('[data-testid="adapter"]', { timeout: 15_000 }); await page.waitForTimeout(600); },
    callouts: [
      { find: '[data-testid="adapter"]' },
      { find: { text: 'Disconnected' } },
      { find: '[data-testid="snapshot-refresh"]' },
    ],
  },
  {
    name: 'guide/device-patches',
    height: 1300,
    path: '@endpoint:HARB-DISPATCH-01?tab=patches',
    before: async (page) => { await page.waitForSelector('[role="tab"][data-state="active"]', { timeout: 15_000 }); await page.waitForTimeout(1500); },
    callouts: [
      { find: '[role="tab"][data-state="active"]' },
      { find: { text: 'Patch status', tag: 'div' }, card: true },
      { find: { text: 'Install updates', tag: 'div' }, card: true },
      { find: { text: 'Scan now', tag: 'button' } },
      { find: { text: 'Offered', tag: 'div' }, card: true },
    ],
  },
  {
    name: 'guide/add-device-1',
    height: 1100,
    path: '/endpoints/enroll',
    before: async (page) => {
      await page.waitForSelector('#ad-business', { timeout: 15_000 });
      await page.selectOption('#ad-business', { label: 'Harbor Logistics' });
      await page.waitForTimeout(800);
      await page.selectOption('#ad-site', { label: 'Tacoma warehouse' });
      await page.check('input[name="ad-access"] >> nth=1');
      await page.waitForTimeout(400);
    },
    callouts: [
      { find: '#ad-business' },
      { find: '#ad-site' },
      { find: '[data-testid="step-place"] fieldset' },
      { find: '[data-testid="place-next"]' },
      { find: '[data-testid="step-wait"]' },
    ],
  },
  {
    name: 'guide/add-device-2',
    height: 1100,
    path: '/endpoints/enroll',
    before: async (page) => {
      await page.waitForSelector('#ad-business', { timeout: 15_000 });
      await page.selectOption('#ad-business', { label: 'Harbor Logistics' });
      await page.waitForTimeout(800);
      await page.selectOption('#ad-site', { label: 'Tacoma warehouse' });
      await page.check('input[name="ad-access"] >> nth=1');
      await page.click('[data-testid="place-next"]');
      await page.check('input[name="ad-os"] >> nth=0');
      await page.waitForTimeout(400);
    },
    callouts: [
      { find: '[data-testid="place-summary"]' },
      { find: '[role="radiogroup"][aria-label="Operating system"]' },
      { find: '[data-testid="create-stepup-note"]' },
      { find: '[data-testid="make-link"]' },
    ],
  },
  {
    // Makes a real, single-use install link in the docs database (masked
    // below), because the step that shows the command only exists once one
    // has been made. It expires unused like any other.
    name: 'guide/add-device-3',
    height: 1300,
    path: '/endpoints/enroll',
    before: async (page) => {
      await page.waitForSelector('#ad-business', { timeout: 15_000 });
      await page.selectOption('#ad-business', { label: 'Harbor Logistics' });
      await page.waitForTimeout(800);
      await page.selectOption('#ad-site', { label: 'Tacoma warehouse' });
      await page.check('input[name="ad-access"] >> nth=1');
      await page.click('[data-testid="place-next"]');
      await page.check('input[name="ad-os"] >> nth=0');
      await page.click('[data-testid="make-link"]');
      await page.waitForSelector('#stepup-value', { timeout: 10_000 });
      await page.fill('#stepup-value', CAPTURE_PASSWORD);
      await page.click('[role="dialog"] button[type="submit"]');
      await page.waitForSelector('[data-testid="wait-waiting"]', { timeout: 15_000 });
      await page.waitForTimeout(800);
    },
    callouts: [
      { find: '[data-testid="step-command"]' },
      { find: '[data-testid="wait-waiting"]' },
      { find: '[data-testid="step-health"]' },
    ],
  },
  {
    name: 'guide/reports',
    height: 1000,
    path: '/reports',
    before: async (page) => { await page.waitForSelector('text=By business', { timeout: 15_000 }); await page.waitForTimeout(600); },
    callouts: [
      { find: { text: 'Patch compliance', tag: 'a' } },
      { find: 'a[href="/reports/offline-time"]' },
      { find: { text: 'Business', tag: 'label' } },
      { find: { text: 'Export CSV', tag: 'button' } },
      { find: { text: 'Compliant', tag: 'div' }, card: true },
    ],
  },
  {
    name: 'guide/reports-offline',
    height: 1000,
    path: '/reports/offline-time',
    before: async (page) => { await page.waitForSelector('text=Export CSV', { timeout: 15_000 }); await page.waitForTimeout(2000); },
    callouts: [
      { find: 'main select' },
      { find: 'main table' },
      { find: { text: 'Export CSV', tag: 'button' } },
    ],
  },
  {
    name: 'guide/script-library',
    height: 900,
    path: '/automation/scripts',
    before: async (page) => { await page.waitForSelector('text=Clear stuck print queue', { timeout: 15_000 }); await page.waitForTimeout(500); },
    callouts: [
      { find: { text: 'How a script runs', tag: 'div' }, card: true },
      { find: 'main select' },
      { find: { text: 'Clear stuck print queue', tag: 'a' } },
      { find: { text: 'New script', tag: 'button' } },
    ],
  },
  {
    name: 'guide/script-review',
    height: 1400,
    path: '@script:Clear stuck print queue',
    before: async (page) => { await page.waitForSelector('text=Version 2', { timeout: 15_000 }).catch(() => {}); await page.waitForTimeout(1200); },
    callouts: [
      { find: { text: 'from v1' }, card: true },
      { find: { text: 'Content SHA-256' } },
      { find: { text: 'Static checks', tag: 'div' }, card: true },
      { find: 'main pre' },
      { find: { text: 'Approve', tag: 'button', exact: true } },
    ],
  },
  {
    name: 'guide/client-updates',
    // 3400 from 0.36: the Device groups card (0.35) pushed the computers'
    // table below a 2250 px window, so callouts 5–6 drew off the page.
    height: 3400,
    path: '/settings/client-updates',
    before: async (page) => {
      await page.waitForSelector('#cu-business', { timeout: 15_000 });
      await page.selectOption('#cu-business', { label: 'Harbor Logistics' });
      await page.waitForSelector('text=Computers', { timeout: 10_000 });
      await page.waitForTimeout(1200);
    },
    callouts: [
      { find: '#cu-business' },
      { find: { text: 'CLIENT_UPDATE_SWEEP=off', tag: 'div' } },
      { find: { text: '— business policy', tag: 'div' }, card: true },
      { find: { text: 'Override' }, card: true },
      // 0.35: a device-group policy (the docs demo's Remote depots group).
      { find: { text: 'Remote depots', tag: 'div' }, card: true },
      { find: { text: 'Auto, waiting' } },
      { find: { text: 'Not automatic' } },
    ],
  },
  {
    name: 'guide/patch-policies',
    height: 1100,
    path: '/patching',
    before: async (page) => {
      await page.waitForSelector('[data-testid="patching-preflight"]', { timeout: 15_000 });
      await page.selectOption('main select >> nth=0', { label: 'Harbor Logistics' });
      await page.waitForSelector('text=Automatic patch policies', { timeout: 10_000 });
      await page.waitForTimeout(1200);
    },
    callouts: [
      { find: 'main select' },
      { find: '[data-testid="patching-preflight"]' },
      { find: { text: 'Check again', tag: 'button' } },
      { find: { text: 'awaiting approval' } },
      { find: { text: 'active', exact: true } },
      { find: { text: 'New policy', tag: 'button' } },
    ],
  },
];
// The throwaway admin's password, for the one capture that has to confirm a
// step-up (making an install link). Set in main(); never a real credential.
let CAPTURE_PASSWORD = '';
const ONLY = (process.env.ONLY ?? '').split(',').map((s) => s.trim()).filter(Boolean);

// Captured without signing in — it is the page someone who needs help lands on.
// Light only. Nothing consumes a dark capture: the app has no theme-based image
// swapping, and the generated docs bundle references no -dark.png. Set
// SCREENSHOT_THEMES=light,dark to write them anyway.
const THEMES = (process.env.SCREENSHOT_THEMES ?? 'light').split(',').map((t) => t.trim());

// Signed-out pages. Empty for the same reason PAGES is short: the /quick
// capture was written every run and referenced by nothing. Re-add it here when
// a doc page actually embeds it.
const PUBLIC_PAGES = [];

// Fictional businesses and computers, so the docs show a populated product
// rather than an empty one. Everything here is torn down afterwards.
const DEMO_BUSINESSES = [
  { name: 'ACME Manufacturing', code: 'ACME', city: 'Detroit', email: 'it@acme.example' },
  { name: 'Smith Accounting',   code: 'SMTH', city: 'Boston',  email: 'admin@smith.example' },
  { name: 'Northwind Clinic',   code: 'NWND', city: 'Portland', email: 'ops@northwind.example' },
];
const DEMO_COMPUTERS = [
  ['ACME-RECEPTION', 'Windows', 'Windows 11 Pro 23H2', true],
  ['ACME-CAD-01',    'Windows', 'Windows 11 Pro 23H2', true],
  ['ACME-SERVER',    'Windows', 'Windows Server 2022', false],
  ['SMITH-FRONTPC',  'Windows', 'Windows 11 Home',     true],
  ['NWND-NURSE-02',  'Windows', 'Windows 10 Pro 22H2', false],
];


/**
 * Outline each target and pin a numbered badge to it, then screenshot.
 *
 * Drawn in the page as real DOM so the browser does the layout — an overlay
 * composited afterwards would have to guess at positions and would be wrong
 * the moment anything reflowed.
 */
async function captureWithCallouts(page, spec, outDir, theme) {
  // "@endpoint:<name>?query" resolves to that demo computer's page.
  let target = spec.path;
  const m = /^@endpoint:([^?]+)(\?.*)?$/.exec(target);
  if (m) {
    const e = await prisma.endpoint.findFirst({ where: { name: m[1] }, select: { id: true } });
    if (!e) throw new Error(`demo computer ${m[1]} not found`);
    target = `/endpoints/${e.id}${m[2] ?? ''}`;
  }
  // "@script:<name>" resolves to that demo script's page.
  const sm = /^@script:(.+)$/.exec(target);
  if (sm) {
    const sc = await prisma.script.findFirst({ where: { name: sm[1] }, select: { id: true } });
    if (!sc) throw new Error(`demo script ${sm[1]} not found`);
    target = `/automation/scripts/${sc.id}`;
  }
  try {
    await page.goto(`${WEB}${target}`, { waitUntil: 'networkidle', timeout: 20_000 });
  } catch { /* long-polling pages never go idle; the waits below are what matter */ }
  await page.waitForTimeout(600);
  if (spec.before) await spec.before(page);
  // The app scrolls inside <main>, so a "full page" screenshot is only ever
  // the viewport. A spec with `height` grows the viewport instead, before the
  // callouts are measured, so targets below the fold are drawn and captured.
  if (spec.height) { await page.setViewportSize({ width: VIEWPORT.width, height: spec.height }); await page.waitForTimeout(400); }
  await applyMasks(page);

  const drawn = await page.evaluate((callouts) => {
    const old = document.getElementById('rem0te-callouts');
    if (old) old.remove();

    const layer = document.createElement('div');
    layer.id = 'rem0te-callouts';
    Object.assign(layer.style, {
      position: 'absolute', inset: '0', pointerEvents: 'none', zIndex: '2147483647',
    });
    document.body.appendChild(layer);

    let n = 0;
    for (const c of callouts) {
      let el = null;
      if (typeof c.find === 'string') {
        el = document.querySelector(c.find);
      } else if (c.find && c.find.text) {
        const tag = c.find.tag || '*';
        const root = c.within ? document.querySelector(c.within) : document;
        const candidates = [...(root ?? document).querySelectorAll(tag)];
        // Deepest match wins: an ancestor also "contains" the text, and
        // outlining the whole card instead of the button is not a callout.
        // `exact` compares the whole text, for short words like "active"
        // that appear inside longer ones.
        const hits = candidates.filter((e) => {
          const t = (e.textContent || '').trim();
          return c.find.exact ? t === c.find.text : t.includes(c.find.text);
        });
        el = hits.find((e) => !hits.some((o) => o !== e && e.contains(o))) || null;
      }
      // `card` outlines the card the match sits in (a chart, a summary tile)
      // rather than the heading that identified it.
      if (el && c.card) el = el.closest('div.rounded-lg,div.rounded-xl,section,[class*="rounded-"][class*="border"]') || el;
      if (!el) continue;

      const r = el.getBoundingClientRect();
      if (!r.width || !r.height) continue;
      n += 1;

      const pad = 4;
      const top = r.top + window.scrollY - pad;
      const left = r.left + window.scrollX - pad;

      const box = document.createElement('div');
      Object.assign(box.style, {
        position: 'absolute',
        top: `${top}px`, left: `${left}px`,
        // Clamped to the window: `main` scrolls on its own, so a target
        // taller than the screen (a 34-row table) would otherwise draw a box
        // that stretches the full-page shot far past the content (0.34).
        width: `${Math.min(r.width + pad * 2, window.innerWidth - left - 4)}px`,
        height: `${Math.min(r.height + pad * 2, window.innerHeight - top - 4)}px`,
        border: '2px solid #e11d48', borderRadius: '8px',
        boxShadow: '0 0 0 3px rgba(225,29,72,0.18)',
      });
      layer.appendChild(box);

      const badge = document.createElement('div');
      badge.textContent = String(n);
      Object.assign(badge.style, {
        position: 'absolute',
        // Kept inside the frame: a target at the top or left edge (a section
        // tab, a sidebar entry) would otherwise lose half its number.
        top: `${Math.max(2, top - 11)}px`, left: `${Math.max(2, left - 11)}px`,
        width: '22px', height: '22px', borderRadius: '11px',
        background: '#e11d48', color: '#fff',
        font: '600 12px/22px ui-sans-serif, system-ui, sans-serif',
        textAlign: 'center', boxShadow: '0 1px 3px rgba(0,0,0,0.3)',
      });
      layer.appendChild(badge);
    }
    return n;
  }, spec.callouts);

  const file = path.join(outDir, `${spec.name}${theme === 'dark' ? '-dark' : ''}.png`);
  await mkdir(path.dirname(file), { recursive: true });
  await page.screenshot({ path: file, fullPage: true });
  await page.evaluate(() => document.getElementById('rem0te-callouts')?.remove());
  if (spec.height) await page.setViewportSize(VIEWPORT);

  const expected = spec.callouts.length;
  console.log(
    `  ${drawn === expected ? '✓' : '!'} ${spec.name}/${theme} → ${file}` +
    (drawn === expected ? '' : `  (${drawn}/${expected} targets found)`),
  );
  return drawn === expected;
}

async function main() {
  await mkdir(OUT_DIR, { recursive: true });

  const suffix = randomBytes(3).toString('hex');
  const email = `screenshots-${suffix}@test.invalid`;
  const password = 'screenshots-only-1234';
  CAPTURE_PASSWORD = password;

  const admin = await prisma.user.create({
    data: {
      email,
      passwordHash: await argon2.hash(password, { type: argon2.argon2id }),
      firstName: 'Alex',
      lastName: 'Admin',
      isPlatformAdmin: true,
      status: 'ACTIVE',
    },
  });
  console.log(`Seeded ${email}`);

  // ── Demo data ────────────────────────────────────────────────────────────
  const tenant = await prisma.tenant.findFirst({ where: { isActive: true }, orderBy: { createdAt: 'asc' } });
  if (!tenant) throw new Error('no platform container — run the seed first');

  const demoBusinessIds = [];
  const demoUserIds = [];
  const demoEndpointIds = [];

  // The docs database normally already carries the full demo estate
  // (prisma/_docs-demo-data.ts and _docs-demo-monitoring.ts). Seed the small
  // set below only into an empty one, so the guide images and the gallery
  // show the same businesses.
  const seedDemo = (await prisma.customer.count()) === 0;
  if (!seedDemo) {
    const existing = await prisma.endpoint.findMany({ take: 5, orderBy: { name: 'asc' }, select: { id: true } });
    for (const e of existing) {
      await prisma.computerAccess.create({ data: { tenantId: tenant.id, endpointId: e.id, userId: admin.id, grantedBy: admin.id } });
    }
  }
  if (seedDemo) for (const b of DEMO_BUSINESSES) {
    const biz = await prisma.customer.create({
      data: { ...b, tenantId: tenant.id, isActive: true, quickConnectEnabled: true },
    });
    demoBusinessIds.push(biz.id);
  }

  const ownerRole = await prisma.role.findFirst({ where: { tenantId: tenant.id, type: 'BUSINESS_OWNER' } });
  const userRole  = await prisma.role.findFirst({ where: { tenantId: tenant.id, type: 'BUSINESS_USER' } });
  const demoPeople = [
    ['dana.owner',  'Dana',  'Whitfield', 0, ownerRole, []],
    ['sam.tech',    'Sam',   'Okoye',     0, userRole,  ['computers:view', 'computers:connect', 'support:quick_connect']],
    ['riley.desk',  'Riley', 'Fernandez', 0, userRole,  ['computers:view', 'computers:connect']],
    ['jo.owner',    'Jo',    'Patel',     1, ownerRole, []],
    ['casey.front', 'Casey', 'Lindqvist', 2, userRole,  ['computers:view']],
  ];
  const stubHash = await argon2.hash(randomBytes(24).toString('hex'), { type: argon2.argon2id });
  for (const [handle, first, last, bizIdx, role, caps] of seedDemo ? demoPeople : []) {
    if (!role) continue;
    const u = await prisma.user.create({
      data: {
        email: `${handle}-${suffix}@example.invalid`,
        passwordHash: stubHash, firstName: first, lastName: last, status: 'ACTIVE',
      },
    });
    demoUserIds.push(u.id);
    await prisma.membership.create({
      data: {
        userId: u.id, tenantId: tenant.id, customerId: demoBusinessIds[bizIdx],
        roleId: role.id, capabilities: caps, isActive: true,
      },
    });
  }

  for (const [name, platform, osVersion, online] of seedDemo ? DEMO_COMPUTERS : []) {
    const bizIdx = name.startsWith('ACME') ? 0 : name.startsWith('SMITH') ? 1 : 2;
    const ep = await prisma.endpoint.create({
      data: {
        tenantId: tenant.id, customerId: demoBusinessIds[bizIdx],
        name, hostname: name.toLowerCase(), platform, osVersion,
        status: 'ACTIVE', isManaged: true, isOnline: online,
        lastSeenAt: new Date(Date.now() - (online ? 30_000 : 3 * 3600_000)),
        accessMode: 'COMPANY_WIDE',
        rustdeskNode: {
          create: {
            tenantId: tenant.id,
            rustdeskId: String(100000000 + Math.floor(Math.random() * 800000000)),
            platform, hostname: name.toLowerCase(), lastSeenAt: new Date(),
          },
        },
      },
    });
    demoEndpointIds.push(ep.id);
    // The screenshot admin needs a grant so "My Computers" is not empty.
    await prisma.computerAccess.create({
      data: { tenantId: tenant.id, endpointId: ep.id, userId: admin.id, grantedBy: admin.id },
    });
  }
  console.log(`Seeded ${demoBusinessIds.length} businesses, ${demoUserIds.length} people, ${demoEndpointIds.length} computers`);

  // The Downloads page and Quick Connect both render an "not configured yet"
  // warning until a RustDesk relay host is set, which is an accurate but
  // useless thing to show in documentation. Fictional host and key — the key
  // is only ever echoed back into a filename here, never used to reach
  // anything.
  const priorSettings = await prisma.tenantSettings.findFirst({
    where: { tenantId: tenant.id },
    select: { id: true, rustdeskRelayHost: true, rustdeskRelayPort: true, rustdeskPublicKey: true },
  });
  const DEMO_RELAY_HOST = 'remote.example.net';
  const DEMO_RELAY_KEY = 'YmFzZTY0ZXhhbXBsZWtleWZvcmRvY3Nvbmx5bm90cmVhbA=';
  if (priorSettings) {
    await prisma.tenantSettings.update({
      where: { id: priorSettings.id },
      data: {
        rustdeskRelayHost: DEMO_RELAY_HOST,
        rustdeskRelayPort: 21116,
        rustdeskPublicKey: DEMO_RELAY_KEY,
      },
    });
  } else {
    await prisma.tenantSettings.create({
      data: {
        tenantId: tenant.id,
        rustdeskRelayHost: DEMO_RELAY_HOST,
        rustdeskRelayPort: 21116,
        rustdeskPublicKey: DEMO_RELAY_KEY,
      },
    });
  }

  // Quick Connect must be on for its pages to render anything useful.
  const priorQuickConnect =
    (await prisma.platformSettings.findUnique({ where: { id: 'singleton' } }))?.quickConnectEnabled ?? false;
  await prisma.platformSettings.upsert({
    where: { id: 'singleton' },
    update: { quickConnectEnabled: true },
    create: { id: 'singleton', quickConnectEnabled: true },
  });

  const calloutMisses = [];

  try {
    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({
      viewport: VIEWPORT,
      colorScheme: 'light',
      ignoreHTTPSErrors: true,
      // The demo businesses are in the Pacific Northwest; times on screen
      // (maintenance windows, "next opens") read in their zone.
      timezoneId: 'America/Los_Angeles',
    });

    // ── Login once, reuse the cookie for all page captures ──────────────
    const page = await context.newPage();
    await page.goto(`${WEB}/login`);
    await page.fill('input[type=email]', email);
    await page.fill('input[type=password]', password);
    await Promise.all([
      page.waitForURL((u) => !u.pathname.startsWith('/login'), { timeout: 15_000 }),
      page.click('button[type=submit]'),
    ]);
    console.log('Logged in.');

    for (const theme of THEMES) {
      // Set the app's theme (Tailwind: html.dark for dark mode).
      await page.emulateMedia({ colorScheme: theme });
      await page.evaluate((t) => {
        try { localStorage.setItem('theme', t); } catch {}
        const html = document.documentElement;
        html.classList.remove('light', 'dark');
        html.classList.add(t);
      }, theme);

      for (const p of ONLY.length ? [] : PAGES) {
        const url = `${WEB}${p.path}`;
        try {
          await page.goto(url, { waitUntil: 'networkidle', timeout: 20_000 });
        } catch {
          console.log(`  · ${p.name}/${theme}: navigation slow, continuing`);
        }
        // Small settle for React query / animations
        await page.waitForTimeout(1200);
        await applyMasks(page);
        // Redact any potentially-secret text that snuck onto the page.
        await page.addStyleTag({ content: `
          :is(code,pre,input[type=password]) { filter: none; }
          [data-secret], [data-sensitive] { filter: blur(6px); }
        `});
        const file = path.join(OUT_DIR, `${p.name}-${theme}.png`);
        await page.screenshot({ path: file, fullPage: true });
        console.log(`  ✓ ${p.name}/${theme} → ${file}`);
      }
      for (const spec of CALLOUT_PAGES) {
        if (spec.signedOut) continue;
        if (ONLY.length && !ONLY.includes(spec.name)) continue;
        try {
          const ok = await captureWithCallouts(page, spec, OUT_DIR, theme);
          if (!ok) calloutMisses.push(`${spec.name}/${theme}`);
        } catch (e) {
          console.log(`  ✗ ${spec.name}/${theme} — ${e.message.split('\n')[0]}`);
          calloutMisses.push(`${spec.name}/${theme}`);
        }
      }
    }


    // ── Public pages, captured signed-OUT in a clean context ──────────────
    for (const theme of THEMES) {
      const anon = await browser.newContext({ viewport: VIEWPORT, colorScheme: theme, ignoreHTTPSErrors: true, timezoneId: 'America/Los_Angeles' });
      const anonPage = await anon.newPage();
      for (const p of ONLY.length ? [] : PUBLIC_PAGES) {
        try {
          await anonPage.goto(`${WEB}${p.path}`, { waitUntil: 'networkidle', timeout: 20_000 });
        } catch {
          console.log(`  · ${p.name}/${theme}: navigation slow, continuing`);
        }
        await anonPage.evaluate((t) => {
          const html = document.documentElement;
          html.classList.remove('light', 'dark');
          html.classList.add(t);
        }, theme);
        await anonPage.waitForTimeout(900);
        const file = path.join(OUT_DIR, `${p.name}-${theme}.png`);
        await anonPage.screenshot({ path: file, fullPage: true });
        console.log(`  ✓ ${p.name}/${theme} → ${file}`);
      }
      // Marked-up signed-out pages (the sign-in page), same zone and theme store.
      for (const spec of CALLOUT_PAGES) {
        if (!spec.signedOut || (ONLY.length && !ONLY.includes(spec.name))) continue;
        await anonPage.addInitScript((t) => { try { localStorage.setItem('theme', t); } catch { /* */ } }, theme);
        try {
          const ok = await captureWithCallouts(anonPage, spec, OUT_DIR, theme);
          if (!ok) calloutMisses.push(`${spec.name}/${theme}`);
        } catch (e) {
          console.log(`  ✗ ${spec.name}/${theme} — ${e.message.split('\n')[0]}`);
          calloutMisses.push(`${spec.name}/${theme}`);
        }
      }
      await anon.close();
    }

    await browser.close();
    if (calloutMisses.length) {
      // Loud rather than fatal: a moved selector should be obvious, but it
      // should not throw away the whole run's output.
      console.log(`\n! ${calloutMisses.length} marked-up capture(s) did not find every target:`);
      for (const m of calloutMisses) console.log(`    ${m}`);
      console.log('  Update the selectors in CALLOUT_PAGES.');
    }
    console.log('\n✓ Screenshots regenerated.');
  } finally {
    // Cleanup — remove every throwaway record, in FK-safe order.
    try {
      await prisma.platformSettings.update({
        where: { id: 'singleton' }, data: { quickConnectEnabled: priorQuickConnect },
      });
      // Put the real relay settings back. Leaving a documentation hostname in
      // place would point every generated installer at nowhere.
      if (priorSettings) {
        await prisma.tenantSettings.update({
          where: { id: priorSettings.id },
          data: {
            rustdeskRelayHost: priorSettings.rustdeskRelayHost,
            rustdeskRelayPort: priorSettings.rustdeskRelayPort,
            rustdeskPublicKey: priorSettings.rustdeskPublicKey,
          },
        });
      }
      const allUsers = [admin.id, ...demoUserIds];
      await prisma.computerAccess.deleteMany({ where: { userId: { in: allUsers } } });
      await prisma.connectionGrant.deleteMany({ where: { userId: { in: allUsers } } });
      await prisma.supportSession.deleteMany({ where: { technicianId: { in: allUsers } } });
      await prisma.launcherToken.deleteMany({ where: { userId: { in: allUsers } } });
      await prisma.activityLog.deleteMany({ where: { actorId: { in: allUsers } } });
      await prisma.membership.deleteMany({ where: { userId: { in: allUsers } } });
      await prisma.invitation.deleteMany({ where: { invitedById: { in: allUsers } } });
      await prisma.rustdeskNode.deleteMany({ where: { endpointId: { in: demoEndpointIds } } });
      await prisma.endpoint.deleteMany({ where: { id: { in: demoEndpointIds } } });
      await prisma.deviceClaimToken.deleteMany({ where: { customerId: { in: demoBusinessIds } } });
      // The install link guide/add-device-3 made, unused.
      await prisma.deviceClaimToken.deleteMany({ where: { createdById: admin.id } });
      await prisma.activityLog.updateMany({
        where: { customerId: { in: demoBusinessIds } }, data: { customerId: null },
      });
      await prisma.customer.deleteMany({ where: { id: { in: demoBusinessIds } } });
      await prisma.user.deleteMany({ where: { id: { in: allUsers } } });
      console.log('Demo data removed.');
    } catch (e) {
      console.error('Cleanup failed — inspect manually:', e.message);
    }
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
