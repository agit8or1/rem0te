#!/usr/bin/env node
/**
 * Rem0te walkthrough recorder.
 *
 * Drives the real application with Playwright and records WebM, which
 * scripts/build-video.sh then turns into MP4 + poster + highlight clip.
 * Same rules as the screenshot pass: isolated demo stack only, the app's own
 * theme selector, capture-only masking that never writes to the database.
 *
 *   WEB_URL=http://127.0.0.1:4000 EMAIL=... PASSWORD=... \
 *   node apps/web/scripts/capture-video.mjs
 *
 * Output: <OUT_DIR>/raw/*.webm (untracked — see .gitignore)
 */
import { chromium } from 'playwright';
import { mkdir, readdir, rename } from 'fs/promises';
import { fileURLToPath } from 'url';
import path from 'path';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../../..');
const OUT = process.env.VIDEO_OUT ?? path.join(ROOT, 'media/raw');
const WEB = process.env.WEB_URL ?? 'http://127.0.0.1:4000';
const SIZE = { width: 1920, height: 1080 };

if (/https:\/\//.test(WEB) || /:(3000|443)\b/.test(WEB)) {
  throw new Error(`Refusing to record ${WEB} — point WEB_URL at the isolated demo stack`);
}

const STILL = `*{caret-color:transparent!important}
  *::-webkit-scrollbar{display:none!important}`;

/** On-screen caption bar. The walkthrough is caption-led, not narrated. */
const CAPTION_CSS = `
#rm-cap{position:fixed;left:0;right:0;bottom:0;z-index:2147483647;pointer-events:none;
  font:500 26px/1.35 Inter,system-ui,sans-serif;color:#fff;
  background:linear-gradient(transparent,rgba(9,12,20,.93) 38%);
  padding:70px 64px 40px;text-align:center;opacity:0;transition:opacity .35s ease}
#rm-cap.on{opacity:1}
#rm-cap b{color:#7dd3fc;font-weight:600}
#rm-card{position:fixed;inset:0;z-index:2147483647;display:flex;flex-direction:column;
  align-items:center;justify-content:center;gap:18px;background:#0b1220;color:#fff;
  font-family:Inter,system-ui,sans-serif;opacity:0;transition:opacity .5s ease;
  pointer-events:none;visibility:hidden}
#rm-card.on{opacity:1;visibility:visible}
#rm-card .t{font-size:66px;font-weight:700;letter-spacing:-1px}
#rm-card .s{font-size:27px;color:#94a3b8;max-width:1100px;text-align:center;line-height:1.45}
#rm-card .u{font-size:24px;color:#7dd3fc;margin-top:10px}`;

async function ui(page) {
  await page.addStyleTag({ content: STILL + CAPTION_CSS }).catch(() => {});
  await page.evaluate(() => {
    if (!document.getElementById('rm-cap')) {
      const c = document.createElement('div'); c.id = 'rm-cap'; document.body.appendChild(c);
      const k = document.createElement('div'); k.id = 'rm-card';
      k.innerHTML = '<div class="t"></div><div class="s"></div><div class="u"></div>';
      document.body.appendChild(k);
    }
  });
}
const say = async (page, html) => { await ui(page); await page.evaluate((h) => {
  const c = document.getElementById('rm-cap'); c.innerHTML = h; c.classList.add('on'); }, html); };
const clear = (page) => page.evaluate(() => document.getElementById('rm-cap')?.classList.remove('on')).catch(() => {});
const card = async (page, t, s, u = '') => { await ui(page); await page.evaluate(([t, s, u]) => {
  const k = document.getElementById('rm-card');
  k.querySelector('.t').textContent = t; k.querySelector('.s').textContent = s;
  k.querySelector('.u').textContent = u; k.classList.add('on'); }, [t, s, u]); };
const uncard = (page) => page.evaluate(() => document.getElementById('rm-card')?.classList.remove('on')).catch(() => {});

/** Mask capture-only: enrollment tokens and RustDesk IDs never reach the frame. */
async function mask(page) {
  await page.evaluate(() => {
    const rx = [[/\/install\/(win|linux|mac)\/[A-Za-z0-9_-]{8,}/g, '/install/$1/SAMPLE-ENROLLMENT-TOKEN'],
                [/\b[a-f0-9]{32,}\b/gi, 'SAMPLE-TOKEN-VALUE'], [/\b\d{9}\b/g, '•••••••••'],
                // Public endpoint addresses exist only so the map can geolocate
                // them; never publish them. Private ranges and loopback stay.
                [/\b(?!10\.|192\.168\.|127\.|172\.(?:1[6-9]|2\d|3[01])\.)((?:\d{1,3}\.){3}\d{1,3})\b/g, '198.51.100.24']];
    const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT); const ns = [];
    for (let n = w.nextNode(); n; n = w.nextNode()) ns.push(n);
    for (const n of ns) { let t = n.nodeValue;
      for (const [re, to] of rx) t = t.replace(re, to);
      if (t !== n.nodeValue) n.nodeValue = t; }
    for (const el of document.querySelectorAll('input,textarea')) { let v = el.value; if (!v) continue;
      for (const [re, to] of rx) v = v.replace(re, to); if (v !== el.value) el.value = v; }
  }).catch(() => {});
}

const wait = (p, ms) => p.waitForTimeout(ms);
async function go(page, route, settle = 2600) {
  await page.goto(`${WEB}${route}`, { waitUntil: 'networkidle', timeout: 40000 }).catch(() => {});
  await ui(page); await mask(page); await wait(page, settle);
}
/** Move the pointer deliberately, so the eye can follow it. */
async function point(page, sel) {
  const el = await page.$(sel); if (!el) return;
  const b = await el.boundingBox(); if (!b) return;
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 26 });
  await wait(page, 700);
}
async function setTheme(page, t) {
  await page.evaluate((v) => {
    localStorage.setItem('theme', v);
    // Apply immediately so the transition is visible in-frame; the store is
    // what carries it across the navigations that follow.
    document.documentElement.classList.toggle('dark', v === 'dark');
  }, t);
  await wait(page, 1400);
}

async function main() {
  await mkdir(OUT, { recursive: true });
  const browser = await chromium.launch();
  const ctx = await browser.newContext({
    viewport: SIZE, deviceScaleFactor: 1, colorScheme: 'light',
    recordVideo: { dir: OUT, size: SIZE },
  });
  // Seed the starting theme only if the store is empty. This runs on EVERY
  // navigation, so writing unconditionally would undo the mid-walkthrough
  // switch to dark on the very next page load.
  await ctx.addInitScript(() => {
    try { if (!localStorage.getItem('theme')) localStorage.setItem('theme', 'light'); } catch {}
  });
  const page = await ctx.newPage();

  // ── Title ──────────────────────────────────────────────────────────────
  await page.goto(`${WEB}/login`, { waitUntil: 'networkidle' });
  await card(page, 'Rem0te', 'Self-hosted remote support for customer businesses, powered by RustDesk.', 'For MSPs and internal IT teams');
  await wait(page, 5200);
  await uncard(page); await wait(page, 700);

  // ── Sign in ────────────────────────────────────────────────────────────
  await say(page, 'Sign in — <b>demo environment</b>, fictitious businesses and synthetic devices');
  await page.fill('input[type="email"]', process.env.EMAIL);
  await wait(page, 500);
  await page.fill('input[type="password"]', process.env.PASSWORD);
  await wait(page, 600);
  await page.click('button[type="submit"]');
  await page.waitForURL((u) => !u.pathname.includes('/login'), { timeout: 30000 });
  await wait(page, 3000); await clear(page);

  // ── Dashboard ──────────────────────────────────────────────────────────
  await go(page, '/dashboard', 4200);
  await say(page, 'Every customer business, computer and session in <b>one overview</b>');
  await wait(page, 4200);
  await say(page, 'Client locations are plotted from each device’s last known address');
  await point(page, 'text=Client Locations'); await wait(page, 4200);
  await clear(page);

  // ── Workflow 1: businesses -> computers ────────────────────────────────
  await go(page, '/businesses');
  await say(page, '<b>Workflow 1</b> — find a customer, then their computers');
  await wait(page, 3600);
  await page.click('text=Harbor Logistics').catch(() => {});
  await wait(page, 2600); await mask(page);
  await say(page, 'Each business owns its own computers, people and history');
  await wait(page, 3400);
  await page.click('button:has-text("Computers")').catch(() => {});
  await wait(page, 2600); await mask(page);
  await say(page, 'Platform, live status and last-seen for every enrolled machine');
  await wait(page, 4200); await clear(page);

  // ── Dark mode transition ───────────────────────────────────────────────
  await say(page, 'Light and dark themes ship with the product');
  await wait(page, 1800);
  await setTheme(page, 'dark');
  await wait(page, 3200); await clear(page);

  // ── Workflow 2: enrolment ──────────────────────────────────────────────
  await go(page, '/endpoints/enroll');
  await say(page, '<b>Workflow 2</b> — enrol a managed device');
  await wait(page, 3200);
  await page.click('[role=combobox]').catch(() => {}); await wait(page, 1200);
  await page.click('[role=option]:has-text("Harbor Logistics")').catch(() => {}); await wait(page, 1800);
  await say(page, 'The business is fixed into the installer — the machine cannot pick another');
  await wait(page, 4200);
  await page.click('text=Ellen Vasquez').catch(() => {}); await wait(page, 1600);
  await say(page, 'Choose exactly who may connect once it is enrolled');
  await wait(page, 3800); await mask(page); await clear(page);

  // ── Workflow 3: access management ──────────────────────────────────────
  await go(page, '/admin/access');
  await say(page, '<b>Workflow 3</b> — three levels: Platform Admin, Business Owner, Business User');
  await wait(page, 4200);
  await page.click('button:has-text("Business Users")').catch(() => {}); await wait(page, 2600);
  await mask(page);
  await say(page, 'Owners hold everything; each user shows the capabilities actually granted');
  await wait(page, 4400); await clear(page);

  // ── Quick Connect ──────────────────────────────────────────────────────
  await go(page, '/quick-connect');
  await say(page, '<b>Quick Connect</b> — one-off help for a machine that is not enrolled');
  await wait(page, 4200);
  await say(page, 'No install, no managed computer created — it ends when they close the client');
  await wait(page, 4000); await clear(page);

  // ── Monitoring and history ─────────────────────────────────────────────
  await go(page, '/sessions', 3400);
  await say(page, 'Live sessions and full history, per business');
  await wait(page, 3800);
  await page.click('button:has-text("Session History")').catch(() => {}); await wait(page, 2600);
  await mask(page); await wait(page, 3200);
  await go(page, '/audit', 3400);
  await say(page, 'Every action is written to an append-only <b>audit log</b>');
  await wait(page, 4200);
  await go(page, '/admin/status', 3600);
  await say(page, 'Service health, CPU, memory and disk on the host');
  await wait(page, 4000); await clear(page);

  // ── Light again + end card ─────────────────────────────────────────────
  await setTheme(page, 'light'); await wait(page, 1600);
  await go(page, '/dashboard', 3400);
  await say(page, 'Self-hosted. Open source. <b>No RustDesk Pro required.</b>');
  await wait(page, 4200); await clear(page); await wait(page, 600);

  await card(page, 'Rem0te',
    'Self-hosted remote support for customer businesses, powered by RustDesk.\nInstall guide, docs and source on GitHub.',
    'github.com/agit8or1/rem0te  ·  mspreboot.com');
  await wait(page, 6000);

  await page.close(); await ctx.close(); await browser.close();

  const files = (await readdir(OUT)).filter((f) => f.endsWith('.webm'));
  if (files.length) {
    await rename(path.join(OUT, files[0]), path.join(OUT, 'walkthrough.webm'));
    console.log('recorded ->', path.join(OUT, 'walkthrough.webm'));
  }
}
main();
