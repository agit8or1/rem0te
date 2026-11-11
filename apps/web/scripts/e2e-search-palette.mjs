#!/usr/bin/env node
/**
 * Global search (0.33) in a real browser: the top bar's search button and
 * Ctrl+K open the palette, typing is debounced into grouped results, the
 * arrow keys and Enter open the highlighted object's page, a group the person
 * may not use is not drawn, another business's device is not found, and the
 * palette is legible in the light and dark themes and fits a phone-width
 * screen. Screenshots go to OUT_DIR (default: a temp directory; never the
 * repository).
 *
 * It seeds two businesses, a Business Owner and a Business User, and removes
 * them afterwards, so it refuses a database whose name lacks "test" or
 * "scratch" and any production-looking WEB_URL. It needs a web build whose
 * rewrite points at an API on that database (INTERNAL_API_URL at build time).
 *
 *   cd apps/web && DATABASE_URL=postgresql://…/rem0te_search_test WEB_URL=http://127.0.0.1:3283 node scripts/e2e-search-palette.mjs
 */
import { chromium } from 'playwright';
import { createRequire } from 'module';
import { randomBytes } from 'crypto';
import { mkdtemp } from 'fs/promises';
import { tmpdir } from 'os';
import { fileURLToPath } from 'url';
import path from 'path';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const apiRequire = createRequire(path.resolve(HERE, '../../api/package.json'));
const { PrismaClient } = apiRequire('@prisma/client');
const argon2 = apiRequire('argon2');

const WEB = process.env.WEB_URL ?? 'http://127.0.0.1:3283';
if (/:(3000|443)\b/.test(WEB) || /^https:\/\//.test(WEB)) {
  throw new Error(`Refusing to test against ${WEB} — point WEB_URL at a scratch stack`);
}
const dbName = (process.env.DATABASE_URL ?? '').split('/').pop()?.split('?')[0] ?? '';
if (!/test|scratch/.test(dbName)) throw new Error(`Refusing to run: database "${dbName}" is not a test or scratch database`);
const OUT_DIR = process.env.OUT_DIR ?? await mkdtemp(path.join(tmpdir(), 'rem0te-search-'));
const prisma = new PrismaClient();

let pass = 0, fail = 0; const failures = [];
const check = (c, m, d = '') => { if (c) { pass++; console.log(`  \x1b[32m✓\x1b[0m ${m}`); } else { fail++; failures.push(m); console.log(`  \x1b[31m✗\x1b[0m ${m}${d ? `\n      ${d}` : ''}`); } };
const section = (t) => console.log(`\n\x1b[1m${t}\x1b[0m`);

const sfx = randomBytes(3).toString('hex');
const TAG = `PAL${sfx}`;
const PW = `palette-e2e-${randomBytes(6).toString('hex')}`;
const created = { businesses: [], users: [] };

async function seed() {
  const tenant = await prisma.tenant.findFirst({ orderBy: { createdAt: 'asc' } });
  const roleOwner = await prisma.role.findFirst({ where: { type: 'BUSINESS_OWNER' } });
  const roleUser = await prisma.role.findFirst({ where: { type: 'BUSINESS_USER' } });
  const A = await prisma.customer.create({ data: { tenantId: tenant.id, name: `${TAG} Acme` } });
  const B = await prisma.customer.create({ data: { tenantId: tenant.id, name: `${TAG} Birch` } });
  created.businesses.push(A.id, B.id);
  const site = await prisma.site.create({ data: { tenantId: tenant.id, customerId: A.id, name: `${TAG} HQ` } });
  const hash = await argon2.hash(PW, { type: argon2.argon2id });
  const mk = async (tag) => { const u = await prisma.user.create({ data: { email: `pal-${tag}-${sfx}@test.invalid`, passwordHash: hash, firstName: 'Pal', lastName: tag, status: 'ACTIVE' } }); created.users.push(u.id); return u; };
  const owner = await mk('owner'), user = await mk('user');
  await prisma.membership.create({ data: { userId: owner.id, tenantId: tenant.id, customerId: A.id, roleId: roleOwner.id } });
  await prisma.membership.create({ data: { userId: user.id, tenantId: tenant.id, customerId: A.id, roleId: roleUser.id, capabilities: ['computers:view'] } });
  const ep = async (biz, name, online, extra = {}) => prisma.endpoint.create({ data: {
    tenantId: tenant.id, customerId: biz.id, name, hostname: `${name.toLowerCase()}.corp.example.com`, platform: 'Windows', status: 'ACTIVE',
    isOnline: online, isManaged: true, accessMode: 'COMPANY_WIDE', lastSeenAt: new Date(), siteId: extra.siteId ?? null,
  } });
  const e1 = await ep(A, `${TAG}-FRONT-DESK`, true, { siteId: site.id });
  const e2 = await ep(A, `${TAG}-FRONT-DESK-2`, false);
  const e3 = await ep(A, `${TAG}-WAREHOUSE`, true);
  await prisma.endpointInventory.create({ data: { endpointId: e3.id, serialNumber: `SN${TAG}WH` } });
  const eB = await ep(B, `${TAG}-BIRCH-ONLY`, true);
  return { A, B, owner, user, e1, e2, e3, eB, site };
}

async function signIn(context, email) {
  const page = await context.newPage();
  await page.goto(`${WEB}/login`);
  await page.fill('input[type=email]', email);
  await page.fill('input[type=password]', PW);
  await Promise.all([page.waitForURL((u) => !u.pathname.startsWith('/login'), { timeout: 30_000 }), page.click('button[type=submit]')]);
  return page;
}
const palette = (page) => page.locator('[data-testid="global-search"]');
async function typeAndWait(page, text) {
  const input = page.locator('[data-testid="global-search-input"]');
  await input.fill('');
  await input.type(text, { delay: 25 });
  await page.waitForResponse((r) => r.url().includes('/api/v1/search') && r.status() === 200, { timeout: 15_000 }).catch(() => {});
  await page.waitForTimeout(400);
}
const lum = (rgb) => { const m = rgb.match(/\d+(\.\d+)?/g)?.map(Number) ?? [0, 0, 0]; return (0.2126 * m[0] + 0.7152 * m[1] + 0.0722 * m[2]) / 255; };

async function run() {
  const f = await seed();
  const browser = await chromium.launch();
  try {
    section('Business Owner, desktop, light theme');
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await signIn(ctx, f.owner.email);
    await page.goto(`${WEB}/dashboard`, { waitUntil: 'networkidle' });
    await page.evaluate(() => { try { localStorage.setItem('theme', 'light'); } catch { /* */ } });
    await page.reload({ waitUntil: 'networkidle' });
    check(await page.locator('[data-testid="global-search-trigger"]').isVisible(), 'the top bar shows the search button');
    await page.keyboard.press('Control+k');
    check(await palette(page).isVisible(), 'Ctrl+K opens the palette');
    check(await page.locator('[data-testid="global-search-input"]').evaluate((el) => el === document.activeElement), 'the input has focus');
    await page.locator('[data-testid="global-search-input"]').type('a');
    await page.waitForTimeout(400);
    check(await page.locator('[data-testid="global-search-hint"]').isVisible(), 'one character shows the hint, not results');
    await typeAndWait(page, `${TAG}-front`);
    const devs = page.locator('[data-group="computers"] [role="option"]');
    check(await devs.count() === 2, 'two devices match, grouped under Devices', `count ${await devs.count()}`);
    check(/Online/.test(await devs.nth(0).innerText()) && /Offline/.test(await devs.nth(1).innerText()), 'online first, each with its state');
    check(await page.locator('[role="option"][aria-selected="true"]').count() === 1, 'one result is highlighted');
    await page.screenshot({ path: path.join(OUT_DIR, 'palette-light-desktop.png') });
    const bgLight = await palette(page).evaluate((el) => getComputedStyle(el).backgroundColor);
    const fgLight = await page.locator('[data-group="computers"] [role="option"] .font-medium').first().evaluate((el) => getComputedStyle(el).color);
    check(lum(bgLight) > 0.8 && lum(fgLight) < 0.3, 'light theme: light surface, dark text', `${bgLight} / ${fgLight}`);
    await page.keyboard.press('ArrowDown');
    const second = await page.locator('[role="option"][aria-selected="true"]').getAttribute('href');
    check(second === `/endpoints/${f.e2.id}`, 'ArrowDown moves to the second result', second);
    await page.keyboard.press('Enter');
    await page.waitForURL((u) => u.pathname === `/endpoints/${f.e2.id}`, { timeout: 15_000 }).catch(() => {});
    check(new URL(page.url()).pathname === `/endpoints/${f.e2.id}` && !(await palette(page).isVisible()), 'Enter opens that device and closes the palette', page.url());

    await page.keyboard.press('Control+k');
    await typeAndWait(page, `SN${TAG}WH`);
    const wh = page.locator('[data-group="computers"] [role="option"]');
    check(await wh.count() === 1 && /Serial: SN/.test(await wh.first().innerText()), 'a serial number finds the device and says it matched on the serial', await wh.first().innerText().catch(() => ''));
    await typeAndWait(page, `${TAG} HQ`);
    check(await page.locator('[data-group="sites"] [role="option"]').count() === 1, 'the site is found under Sites');
    const siteHref = await page.locator('[data-group="sites"] [role="option"]').first().getAttribute('href');
    check(siteHref === `/endpoints?businessId=${f.A.id}&siteId=${f.site.id}`, 'a site opens the device list filtered to it', siteHref);
    await typeAndWait(page, `pal-user-${sfx}`);
    check(await page.locator('[data-group="users"] [role="option"]').count() === 1, 'a person is found under People');
    await typeAndWait(page, `${TAG}-BIRCH-ONLY`);
    check(await page.locator('[data-testid="global-search-empty"]').isVisible() && await page.locator('[role="option"]').count() === 0, "another business's device is not found");
    await page.keyboard.press('Escape');
    check(!(await palette(page).isVisible()), 'Esc closes the palette');

    section('Dark theme');
    await page.evaluate(() => { try { localStorage.setItem('theme', 'dark'); } catch { /* */ } });
    await page.reload({ waitUntil: 'networkidle' });
    check(await page.evaluate(() => document.documentElement.classList.contains('dark')), 'the application theme is dark');
    await page.locator('[data-testid="global-search-trigger"]').click();
    await typeAndWait(page, `${TAG}-front`);
    const bgDark = await palette(page).evaluate((el) => getComputedStyle(el).backgroundColor);
    const fgDark = await page.locator('[data-group="computers"] [role="option"] .font-medium').first().evaluate((el) => getComputedStyle(el).color);
    check(lum(bgDark) < 0.25 && lum(fgDark) > 0.7, 'dark theme: dark surface, light text', `${bgDark} / ${fgDark}`);
    await page.screenshot({ path: path.join(OUT_DIR, 'palette-dark-desktop.png') });
    await ctx.close();

    section('Phone width (390 × 844)');
    const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
    const pp = await signIn(phone, f.owner.email);
    await pp.goto(`${WEB}/dashboard`, { waitUntil: 'networkidle' });
    await pp.locator('[data-testid="global-search-trigger"]').click();
    await typeAndWait(pp, `${TAG}-front`);
    const box = await palette(pp).boundingBox();
    check(box && box.x >= 0 && box.x + box.width <= 390.5 && box.y >= 0 && box.y + box.height <= 844.5, 'the palette fits the screen', JSON.stringify(box));
    check(await palette(pp).evaluate((el) => [...el.querySelectorAll('*')].every((n) => n.scrollWidth <= n.clientWidth + 1 || getComputedStyle(n).overflowX !== 'visible' || n.clientWidth === 0)), 'nothing in it scrolls sideways');
    check(await pp.locator('[data-group="computers"] [role="option"]').count() === 2, 'results at phone width');
    await pp.screenshot({ path: path.join(OUT_DIR, 'palette-light-phone.png') });
    await pp.locator('[data-group="computers"] [role="option"]').first().tap();
    await pp.waitForURL((u) => u.pathname === `/endpoints/${f.e1.id}`, { timeout: 15_000 }).catch(() => {});
    check(new URL(pp.url()).pathname === `/endpoints/${f.e1.id}`, 'tapping a result opens it', pp.url());
    await phone.close();

    section('Business User (computers:view only)');
    const uc = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const up = await signIn(uc, f.user.email);
    await up.goto(`${WEB}/dashboard`, { waitUntil: 'networkidle' });
    await up.keyboard.press('Control+k');
    await typeAndWait(up, TAG);
    check(await up.locator('[data-group="computers"] [role="option"]').count() === 3, 'their three company-wide devices');
    check(await up.locator('[data-group="users"]').count() === 0 && await up.locator('[data-group="alerts"]').count() === 0, 'no People or Alerts group without those permissions — not an empty one');
    await uc.close();
  } finally {
    await browser.close();
  }
}

async function cleanup() {
  try {
    const ids = created.businesses;
    const eps = (await prisma.endpoint.findMany({ where: { customerId: { in: ids } }, select: { id: true } })).map((e) => e.id);
    await prisma.endpointInventory.deleteMany({ where: { endpointId: { in: eps } } });
    await prisma.endpoint.deleteMany({ where: { id: { in: eps } } });
    await prisma.site.deleteMany({ where: { customerId: { in: ids } } });
    await prisma.membership.deleteMany({ where: { customerId: { in: ids } } });
    await prisma.customer.deleteMany({ where: { id: { in: ids } } });
    await prisma.user.deleteMany({ where: { id: { in: created.users } } });
  } catch (e) { console.error('cleanup:', e.message); }
  await prisma.$disconnect();
}

run()
  .catch((e) => { fail++; failures.push(`fatal: ${e.stack ?? e.message}`); console.error(e); })
  .finally(async () => {
    await cleanup();
    console.log(`\nScreenshots: ${OUT_DIR}`);
    console.log(`${fail ? '\x1b[31m' : '\x1b[32m'}${pass} passed, ${fail} failed\x1b[0m`);
    if (failures.length) { for (const x of failures) console.log(`  - ${x}`); process.exit(1); }
    process.exit(0);
  });
