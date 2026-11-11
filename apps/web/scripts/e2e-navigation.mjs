#!/usr/bin/env node
/**
 * The 0.31 navigation (and 0.32's Reports), in a real browser: every sidebar entry and section tab
 * leads to a page that renders, each persona sees exactly its entries, the
 * Settings group works, nothing overflows sideways, at desktop and tablet
 * widths, in the light and dark themes. It also writes screenshots to OUT_DIR
 * (default: a temp directory; never the repository).
 *
 * It seeds three users (a Platform Admin, a Business Owner, and a Business
 * User with only computers:view + connect) and removes them afterwards, so —
 * like the capture scripts — it refuses anything but the isolated docs stack.
 *
 *   cd apps/web && DATABASE_URL=postgresql://…/reboot_remote_docs WEB_URL=http://127.0.0.1:4000 node scripts/e2e-navigation.mjs
 */
import { chromium } from 'playwright';
import { createRequire } from 'module';
import { createHash, randomBytes } from 'crypto';
import { mkdir, mkdtemp } from 'fs/promises';
import { tmpdir } from 'os';
import { fileURLToPath } from 'url';
import path from 'path';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const apiRequire = createRequire(path.resolve(HERE, '../../api/package.json'));
const { PrismaClient } = apiRequire('@prisma/client');
const argon2 = apiRequire('argon2');

const WEB = process.env.WEB_URL ?? 'http://127.0.0.1:4000';
if (/:(3000|443)\b/.test(WEB) || /^https:\/\//.test(WEB)) {
  throw new Error(`Refusing to test against ${WEB} — point WEB_URL at the isolated demo stack`);
}
if (!(process.env.DATABASE_URL ?? '').includes('reboot_remote_docs')) {
  throw new Error('Refusing to run: DATABASE_URL is not the reboot_remote_docs database');
}
const OUT_DIR = process.env.OUT_DIR ?? await mkdtemp(path.join(tmpdir(), 'rem0te-nav-'));
const prisma = new PrismaClient();

let pass = 0, fail = 0; const failures = [];
const check = (c, m, d = '') => { if (c) { pass++; console.log(`  \x1b[32m✓\x1b[0m ${m}`); } else { fail++; failures.push(m); console.log(`  \x1b[31m✗\x1b[0m ${m}${d ? `\n      ${d}` : ''}`); } };

const VIEWPORTS = { desktop: { width: 1440, height: 900 }, tablet: { width: 820, height: 1180 } };
const SETTINGS_ADMIN = ['/settings', '/users', '/offboarding', '/technician-approvals', '/audit', '/businesses', '/admin/technicians', '/admin/access', '/admin/sso',
  '/admin/rollouts', '/admin/security', '/admin/status', '/about'];

async function signIn(context, email, password) {
  const page = await context.newPage();
  await page.goto(`${WEB}/login`);
  await page.fill('input[type=email]', email);
  await page.fill('input[type=password]', password);
  await Promise.all([page.waitForURL((u) => !u.pathname.startsWith('/login'), { timeout: 20_000 }), page.click('button[type=submit]')]);
  return page;
}

async function setTheme(page, theme) {
  await page.evaluate((t) => { try { localStorage.setItem('theme', t); } catch { /* */ } }, theme);
  await page.reload({ waitUntil: 'networkidle' });
}

/** What a person sees: the main-menu sections in order. */
const sections = (page) => page.$$eval('nav[aria-label="Main"] [data-nav]', (els) => els.map((e) => e.getAttribute('data-nav')));

async function pageHealth(page) {
  return page.evaluate(() => {
    const main = document.querySelector('main');
    const h1 = document.querySelector('main h1')?.textContent?.trim() ?? '';
    const notFound = /could not be found|404/i.test(document.body.innerText.slice(0, 2000)) && !h1;
    const overflow = main ? main.scrollWidth - main.clientWidth : 0;
    let culprit = null;
    if (overflow > 1 && main) {
      const limit = main.getBoundingClientRect().right + 1;
      for (const el of main.querySelectorAll('*')) {
        const r = el.getBoundingClientRect();
        if (r.right > limit && r.width > 0) { culprit = `${el.tagName.toLowerCase()}.${String(el.className).slice(0, 80)}`; break; }
      }
    }
    return { h1, notFound, overflow, culprit };
  });
}

/** Click a link and wait for the client-side navigation to land and settle. */
async function follow(page, selector) {
  const href = await page.$eval(selector, (e) => e.getAttribute('href'));
  await page.click(selector);
  if (href) await page.waitForURL((u) => u.pathname === href, { timeout: 20_000 }).catch(() => {});
  await page.waitForLoadState('networkidle').catch(() => {});
  await page.waitForTimeout(600);
}

async function visit(page, href) {
  await page.goto(`${WEB}${href}`, { waitUntil: 'networkidle', timeout: 25_000 }).catch(() => {});
  await page.waitForTimeout(500);
  return pageHealth(page);
}

/** No control anywhere on a library page that could read as running a script. */
async function noRunControl(page) {
  return page.evaluate(() => [...document.querySelectorAll('main button, main a, main [role=button]')]
    .map((e) => (e.textContent ?? '').trim()).filter((t) => /\b(run|execute|deploy|dispatch|send to)\b/i.test(t)));
}

async function automationChecks(page) {
  await follow(page, 'nav[aria-label="Main"] [data-nav="automation"]');
  const h = await pageHealth(page);
  check(new URL(page.url()).pathname === '/automation/scripts' && h.h1 === 'Script library', 'Automation opens the Script library', JSON.stringify(h));
  const notice = await page.$eval('[data-not-runnable]', (e) => e.textContent).catch(() => '');
  check(/isn.t available yet/i.test(notice) && /signed agent/i.test(notice) && /real Windows/i.test(notice), 'it says plainly that running scripts is not available yet, and why', notice.slice(0, 200));
  const runs = await noRunControl(page);
  check(runs.length === 0, 'the library page has no Run button', runs.join(' | '));
  const row = await page.$('[data-script-row]');
  if (row) {
    await row.click();
    await page.waitForSelector('[data-script-content]', { timeout: 15_000 }).catch(() => {});
    const d = await pageHealth(page);
    const runs2 = await noRunControl(page);
    check(!!(await page.$('[data-not-runnable]')) && !!(await page.$('[data-static-checks]')) && runs2.length === 0 && d.overflow <= 1, 'a script\'s page shows the notice and the static checks, has no Run button, no overflow', `${runs2.join(' | ')} ${JSON.stringify(d)}`);
  }
}

const created = [];
try {
  const tenant = await prisma.tenant.findFirst({ where: { isActive: true }, orderBy: { createdAt: 'asc' } });
  const biz = await prisma.customer.findFirst({ where: { tenantId: tenant.id, isActive: true }, orderBy: { name: 'asc' } });
  const ownerRole = await prisma.role.findFirst({ where: { tenantId: tenant.id, type: 'BUSINESS_OWNER' } });
  const userRole = await prisma.role.findFirst({ where: { tenantId: tenant.id, type: 'BUSINESS_USER' } });
  const sfx = randomBytes(3).toString('hex');
  const password = `nav-test-${randomBytes(9).toString('hex')}`;
  const hash = await argon2.hash(password, { type: argon2.argon2id });
  const mk = async (handle, extra, membership) => {
    const u = await prisma.user.create({ data: { email: `nav-${handle}-${sfx}@test.invalid`, passwordHash: hash, firstName: 'Nav', lastName: handle, status: 'ACTIVE', ...extra } });
    created.push(u.id);
    if (membership) await prisma.membership.create({ data: { userId: u.id, tenantId: tenant.id, customerId: biz.id, isActive: true, ...membership } });
    return u.email;
  };
  const personas = {
    admin: { email: await mk('admin', { isPlatformAdmin: true }), expect: ['dashboard', 'devices', 'alerts', 'automation', 'patching', 'remote', 'reports', 'settings'] },
    owner: { email: await mk('owner', {}, { roleId: ownerRole.id, capabilities: [] }), expect: ['dashboard', 'devices', 'alerts', 'automation', 'patching', 'remote', 'reports', 'settings'] },
    // computers:view without monitoring:alerts: the device reports, not the alert ones (0.32).
    user: { email: await mk('user', {}, { roleId: userRole.id, capabilities: ['computers:view', 'computers:connect'] }), expect: ['dashboard', 'devices', 'patching', 'remote', 'reports'] },
  };
  const anyEndpoint = await prisma.endpoint.findFirst({ where: { customerId: biz.id, status: 'ACTIVE' }, select: { id: true } });
  // 0.33: the Processes, Services and Network tabs belong to a Windows computer.
  const windowsEndpoint = await prisma.endpoint.findFirst({ where: { customerId: biz.id, status: 'ACTIVE', platform: { contains: 'indows', mode: 'insensitive' } }, select: { id: true } });

  const browser = await chromium.launch({ headless: true });
  for (const [who, p] of Object.entries(personas)) {
    for (const [vpName, viewport] of Object.entries(VIEWPORTS)) {
      console.log(`\n\x1b[1m${who} · ${vpName}\x1b[0m`);
      const context = await browser.newContext({ viewport, colorScheme: 'light' });
      const page = await signIn(context, p.email, password);
      await page.waitForSelector('nav[aria-label="Main"] [data-nav]', { timeout: 20_000 });
      await page.waitForLoadState('networkidle').catch(() => {});
      await page.waitForTimeout(800);
      const got = await sections(page);
      check(JSON.stringify(got) === JSON.stringify(p.expect), `the menu is exactly: ${p.expect.join(', ')}`, `got ${got.join(', ')}`);

      // Every section entry opens a real page, highlighted, without sideways overflow.
      for (const id of got.filter((s) => s !== 'settings')) {
        await follow(page, `nav[aria-label="Main"] [data-nav="${id}"]`);
        const h = await pageHealth(page);
        const active = await page.$eval(`nav[aria-label="Main"] [data-nav="${id}"]`, (e) => e.className.includes('bg-primary'));
        check(!h.notFound && h.h1 && h.overflow <= 1 && active, `${id} → ${new URL(page.url()).pathname} renders "${h.h1}", highlighted, no overflow`, JSON.stringify(h));
      }

      // Automation: the script library, which says it cannot run scripts and offers nothing that would.
      if (got.includes('automation')) await automationChecks(page);
      else {
        const h = await visit(page, '/automation/scripts');
        const txt = await page.evaluate(() => document.querySelector('main')?.innerText ?? '');
        check(!!h.h1 && /permission/i.test(txt) && !(await page.$('[data-script-row]')), 'without library rights, /automation/scripts loads but lists nothing and says a permission is needed', txt.slice(0, 200));
      }

      // Section tabs: on Devices and Remote Support, never on a device's own page.
      if (got.includes('devices')) {
        await visit(page, who === 'user' ? '/endpoints' : '/endpoints');
        const tabs = await page.$$eval('[data-section-tabs="devices"] a', (els) => els.map((e) => e.textContent.trim()));
        // 0.32: one way to add a device. The Devices page has a single "Add
        // device" button (for whoever may add computers) leading to the guided
        // flow; "Enroll Client" and "Generate Enrollment Link" are gone.
        // The section tab of the same name is not a button on the page: leave it out.
        const header = await page.$$eval('main a, main button', (els) => els.filter((e) => !e.closest('[data-section-tabs]')).map((e) => [e.textContent.trim(), e.getAttribute('href')]));
        const adds = header.filter(([t]) => t === 'Add device' || /Enroll Client|Generate Enrollment Link/i.test(t));
        const mayAdd = who !== 'user';
        check(mayAdd ? adds.length === 1 && adds[0][1] === '/endpoints/enroll' : adds.length === 0,
          mayAdd ? 'Devices has one "Add device" button, to /endpoints/enroll, and no old enrol buttons' : 'without computers:add, Devices offers no Add device button', JSON.stringify(adds));
        if (mayAdd) {
          await follow(page, 'main a[data-testid="add-device"]');
          const flow = await page.$('[data-testid="add-device-flow"]');
          const steps = await page.$$eval('[data-testid^="step-"]', (els) => els.map((e) => e.getAttribute('data-testid')));
          check(new URL(page.url()).pathname === '/endpoints/enroll' && !!flow && JSON.stringify(steps) === JSON.stringify(['step-place', 'step-os', 'step-command', 'step-wait', 'step-health', 'step-next']),
            'Add device opens the guided flow with its six steps', JSON.stringify({ url: page.url(), steps }));
          const h = await pageHealth(page);
          check(h.overflow <= 1, 'the guided flow does not overflow sideways', JSON.stringify(h));
          await visit(page, '/endpoints');
        }
        const want = who === 'admin' ? ['All devices', 'My devices', 'Add device', 'Unassigned'] : who === 'owner' ? ['All devices', 'My devices', 'Add device'] : ['All devices', 'My devices'];
        check(JSON.stringify(tabs) === JSON.stringify(want), `Devices tabs: ${want.join(' · ')}`, `got ${tabs.join(' · ')}`);
        for (const t of tabs) {
          await follow(page, `[data-section-tabs="devices"] a:text-is("${t}")`);
          const h = await pageHealth(page);
          const current = await page.$eval('[data-section-tabs="devices"] a[aria-current="page"]', (e) => e.textContent.trim()).catch(() => null);
          check(!h.notFound && h.h1 && h.overflow <= 1 && current === t, `Devices → ${t} renders "${h.h1}" and is the current tab`, JSON.stringify(h));
        }
        if (anyEndpoint) {
          await visit(page, `/endpoints/${anyEndpoint.id}`);
          check(!(await page.$('[data-section-tabs]')), 'a device\'s own page has no section tabs (it has its own)');
          // 0.33: Performance sits right after Overview for any computer whose agent reports.
          const wtabs = await page.$$eval('[data-testid="workspace-tabs"] [role="tab"]', (els) => els.map((e) => e.textContent.trim()));
          if (wtabs.includes('Performance')) {
            check(wtabs[1] === 'Performance', 'the device workspace has Performance right after Overview', wtabs.join(' · '));
            await page.click('[data-testid="tab-performance"]');
            await page.waitForSelector('[data-testid="performance-tab"] [data-testid="metric-range"]', { timeout: 15000 });
            await page.waitForSelector('[data-testid="metric-cpu-chart"] svg, [data-testid="metric-empty"]', { timeout: 15000 });
            const h = await pageHealth(page);
            check(h.overflow <= 1, `Performance renders (charts or the empty state) without sideways overflow`, JSON.stringify(h));
            await page.click('[data-testid="metric-range-7d"]');
            await page.waitForSelector('[data-testid="metric-range-7d"][aria-pressed="true"]', { timeout: 5000 });
            check(true, 'the range picker switches to 7 d');
            await page.screenshot({ path: path.join(OUT_DIR, `performance-${who}-${vpName}.png`), fullPage: true }).catch(() => {});
          } else {
            check(true, `this device shows no Performance tab (${wtabs.join(' · ')}) — its agent reports nothing`);
          }
        }
        // 0.33: read-only snapshot tabs, each with its age and a Refresh, and no
        // control that acts on the computer (no end task, stop or start).
        if (windowsEndpoint && who !== 'user') {
          await visit(page, `/endpoints/${windowsEndpoint.id}`);
          const wsTabs = await page.$$eval('[data-testid="workspace-tabs"] [role="tab"]', (els) => els.map((e) => e.textContent.trim()));
          check(['Processes', 'Services', 'Network'].every((t) => wsTabs.includes(t)), 'a Windows device has Processes, Services and Network tabs', wsTabs.join(' · '));
          for (const [t, key] of [['processes', 'process_list'], ['services', 'service_list'], ['network', 'network_adapters']]) {
            await page.click(`[data-testid="tab-${t}"]`);
            await page.waitForSelector(`[data-testid="snapshot-${key}"]`, { timeout: 15_000 }).catch(() => {});
            const card = await page.$(`[data-testid="snapshot-${key}"]`);
            const info = card ? await card.evaluate((el) => ({
              age: el.querySelector('[data-testid="snapshot-age"]')?.textContent ?? '',
              refresh: !!el.querySelector('[data-testid="snapshot-refresh"]'),
              actions: [...el.querySelectorAll('button')].map((b) => (b.textContent ?? '').trim()).filter((x) => /\b(end|kill|stop|start|restart|disable|enable)\b/i.test(x)),
            })) : null;
            const h = await pageHealth(page);
            check(!!info && /Taken|Never taken/.test(info.age) && info.refresh && info.actions.length === 0 && h.overflow <= 1, `${t} tab: shows when it was taken, a Refresh, no action buttons, no overflow`, JSON.stringify({ info, overflow: h.overflow }));
          }
        }
      }
      if (got.includes('remote')) {
        await follow(page, 'nav[aria-label="Main"] [data-nav="remote"]');
        const tabs = await page.$$eval('[data-section-tabs="remote"] a', (els) => els.map((e) => e.textContent.trim()));
        check(who === 'user' ? tabs.length === 0 : tabs.includes('Sessions') && tabs.includes('Technician client'), who === 'user' ? 'a user with one Remote Support page sees no tab bar' : `Remote Support tabs: ${tabs.join(' · ')}`, tabs.join(' · '));
      }

      // Reports (0.32): one tab per report the person's permissions allow, each a real page.
      if (got.includes('reports')) {
        await follow(page, 'nav[aria-label="Main"] [data-nav="reports"]');
        const tabs = await page.$$eval('[data-section-tabs="reports"] a', (els) => els.map((e) => e.textContent.trim()));
        const want = who === 'user' ? ['Patch compliance', 'Agent coverage'] : ['Patch compliance', 'Agent coverage', 'Alert frequency', 'Offline time'];
        check(JSON.stringify(tabs) === JSON.stringify(want), `Reports tabs: ${want.join(' · ')}`, `got ${tabs.join(' · ')}`);
        for (const t of tabs) {
          await follow(page, `[data-section-tabs="reports"] a:text-is("${t}")`);
          await page.waitForSelector('main h1', { timeout: 15_000 }).catch(() => {});
          const h = await pageHealth(page);
          const current = await page.$eval('[data-section-tabs="reports"] a[aria-current="page"]', (e) => e.textContent.trim()).catch(() => null);
          const refused = await page.evaluate(() => /not available to you|could not be loaded/i.test(document.querySelector('main')?.innerText ?? ''));
          check(!h.notFound && h.h1 === t && h.overflow <= 1 && current === t && !refused, `Reports → ${t} renders "${h.h1}", is the current tab, and loads`, JSON.stringify({ ...h, refused }));
        }
        if (who === 'user') {
          const h = await visit(page, '/reports/alert-frequency');
          const refused = await page.evaluate(() => /not available to you/i.test(document.querySelector('main')?.innerText ?? ''));
          check(h.h1 === 'Alert frequency' && refused, 'a report without its permission says so instead of drawing an empty report', JSON.stringify(h));
        }
        const h = await visit(page, '/reports');
        check(new URL(page.url()).pathname === '/reports/patch-compliance' || h.h1 === 'Patch compliance', '/reports opens the first report', page.url());
      }

      // Settings: collapsible, every entry renders, the group stays open on its pages.
      if (got.includes('settings')) {
        await visit(page, '/dashboard');
        const before = await page.$$('nav[aria-label="Main"] a[href="/audit"]');
        if (before.length) await page.click('nav[aria-label="Main"] [data-nav="settings"]'); // close if it was left open
        await page.click('nav[aria-label="Main"] [data-nav="settings"]');
        const hrefs = await page.$$eval('nav[aria-label="Main"] [data-nav="settings"] + div a', (els) => els.map((e) => e.getAttribute('href')));
        if (who === 'admin') check(JSON.stringify(hrefs) === JSON.stringify(SETTINGS_ADMIN), 'Settings holds the administration, in order', hrefs.join(' '));
        else check(hrefs.includes('/settings') && hrefs.includes('/users') && !hrefs.includes('/admin/access'), 'an owner\'s Settings has their business, not the platform', hrefs.join(' '));
        for (const href of hrefs) {
          const h = await visit(page, href);
          const open = await page.$$eval('nav[aria-label="Main"] [data-nav="settings"] + div a', (els) => els.length);
          const active = await page.$eval(`nav[aria-label="Main"] a[href="${href}"]`, (e) => e.className.includes('bg-primary')).catch(() => false);
          check(!h.notFound && h.h1 && h.overflow <= 1 && open > 0 && active, `Settings → ${href} renders "${h.h1}"; group open, entry highlighted`, JSON.stringify(h));
        }
      }

      // A dashboard tile's link opens the list already filtered.
      if (got.includes('alerts')) {
        await visit(page, '/alerts?state=open&severity=critical');
        const sel = await page.evaluate(() => [document.querySelector('#al-state')?.value, document.querySelector('#al-sev')?.value]);
        check(sel[0] === 'open' && sel[1] === 'critical', '/alerts?state=open&severity=critical opens filtered', JSON.stringify(sel));
      }

      // Help & docs, at the bottom.
      await follow(page, 'aside a[href="/help"]');
      check(await page.$('main a[href="/docs"]') !== null, 'Help links to the full documentation');

      for (const theme of ['light', 'dark']) {
        await visit(page, '/dashboard');
        await setTheme(page, theme);
        const dark = await page.evaluate(() => document.documentElement.classList.contains('dark'));
        check(dark === (theme === 'dark'), `${theme} theme comes from the app's own store`);
        await mkdir(OUT_DIR, { recursive: true });
        for (const href of ['/dashboard', '/endpoints']) {
          if (who === 'user' && href === '/dashboard') continue;
          await visit(page, href);
          await page.screenshot({ path: path.join(OUT_DIR, `${who}-${vpName}-${theme}${href.replace(/\//g, '_')}.png`), fullPage: false });
        }
      }
      await context.close();
    }
  }
  await browser.close();
} catch (e) {
  fail++; failures.push(`crashed: ${e.stack ?? e}`); console.error(e);
} finally {
  if (created.length) {
    await prisma.membership.deleteMany({ where: { userId: { in: created } } }).catch(() => {});
    await prisma.user.deleteMany({ where: { id: { in: created } } }).catch((e) => console.error('cleanup:', e.message));
  }
  await prisma.$disconnect();
  console.log(`\nscreenshots: ${OUT_DIR}`);
  console.log(`\n${fail ? '\x1b[31m' : '\x1b[32m'}${pass} passed, ${fail} failed\x1b[0m`);
  if (failures.length) { for (const f of failures) console.log(`  - ${f}`); process.exitCode = 1; }
}
