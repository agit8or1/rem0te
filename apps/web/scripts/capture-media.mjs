#!/usr/bin/env node
/**
 * Rem0te screenshot + video capture.
 *
 * Drives the real UI with Playwright and writes the gallery under
 * docs/images/github/. Themes are set through the application's own theme
 * store (localStorage `theme`, which ThemeProvider reads and turns into
 * `<html class="dark">`) — never a CSS filter, so what is captured is the
 * shipped theme.
 *
 * It refuses to run against anything but an isolated demo stack. See
 * docs/screenshots.md ("Regenerating these") for the full procedure.
 *
 *   WEB_URL=http://127.0.0.1:4000 \
 *   EMAIL=operator@rem0te.example.com PASSWORD=... \
 *   node scripts/capture-media.mjs [--only <name,name>] [--video]
 *
 * Nothing here writes to the application: masking happens in the browser DOM
 * immediately before the shutter, so stored records are untouched.
 */
import { chromium } from 'playwright';
import { mkdir, writeFile } from 'fs/promises';
import { fileURLToPath } from 'url';
import path from 'path';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../../..');
const OUT = process.env.OUT_DIR ?? path.join(ROOT, 'docs/images/github');
const WEB = process.env.WEB_URL ?? 'http://127.0.0.1:4000';
const VIEWPORT = { width: 1440, height: 1000 };
const SCALE = 2;

// A capture run seeds fictional businesses. Refuse anything that looks live.
if (/:(3000|443)\b/.test(WEB) || /https:\/\//.test(WEB)) {
  throw new Error(`Refusing to capture against ${WEB} — point WEB_URL at the isolated demo stack`);
}

/**
 * Capture-only masking. Values are replaced in the DOM just before the
 * screenshot; nothing is written back. Credentials and tokens get an opaque
 * replacement, never a blur — a blurred token is still a token.
 */
const MASKS = [
  // Enrollment one-liners and installer URLs embed a single-use claim token.
  { match: /\/install\/(win|linux|mac)\/[A-Za-z0-9_-]{8,}/g, to: '/install/$1/SAMPLE-ENROLLMENT-TOKEN' },
  { match: /\b[a-f0-9]{32,}\b/gi, to: 'SAMPLE-TOKEN-VALUE' },
  // RustDesk IDs are synthetic here, but the gallery should still model the
  // habit of not publishing them.
  { match: /\b\d{9}\b/g, to: '•••••••••' },
  // Endpoint addresses are stored as real routable IPs ONLY so the dashboard
  // map can geolocate them (see prisma/_docs-demo-data.ts). The map renders
  // city names, not addresses, so masking the displayed value costs nothing —
  // and publishing a routable address next to a business name, even a
  // fictional one, is a habit worth not having. Private ranges and loopback
  // are left alone; they are meaningful and carry nothing.
  { match: /\b(?!10\.|192\.168\.|127\.|172\.(?:1[6-9]|2\d|3[01])\.)((?:\d{1,3}\.){3}\d{1,3})\b/g,
    to: '198.51.100.24' },
  // The demo API reads the HOST's real TLS certificates and systemd units, so
  // pages like Security name the live deployment's domain. Replace any FQDN
  // that is not deliberately public. The allowlist keeps intentional branding
  // (mspreboot.com) and upstream references (github.com, rustdesk.com) intact.
  { match: /\b(?!(?:[a-z0-9-]+\.)*(?:mspreboot|github|rustdesk|example)\.(?:com|net|org)\b)(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+(?:com|net|org|io|dev|local|uk|co)\b/gi,
    to: 'remote.example.com' },
];

async function applyMasks(page) {
  await page.evaluate((masks) => {
    const rx = masks.map((m) => ({ re: new RegExp(m.source, m.flags), to: m.to }));
    const walk = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    const hits = [];
    for (let n = walk.nextNode(); n; n = walk.nextNode()) hits.push(n);
    for (const n of hits) {
      let t = n.nodeValue;
      for (const { re, to } of rx) t = t.replace(re, to);
      if (t !== n.nodeValue) n.nodeValue = t;
    }
    // Inputs holding a generated command/link.
    for (const el of document.querySelectorAll('input,textarea')) {
      let v = el.value; if (!v) continue;
      for (const { re, to } of rx) v = v.replace(re, to);
      if (v !== el.value) el.value = v;
    }
    // Anything the app itself flags as secret gets an opaque block.
    for (const el of document.querySelectorAll('[data-secret],[data-sensitive],canvas[aria-label*="QR" i]')) {
      el.style.filter = 'none';
      el.style.background = '#334155';
      el.style.color = 'transparent';
    }
  }, MASKS.map((m) => ({ source: m.match.source, flags: m.match.flags, to: m.to })));
}

/** Kill animation so a capture never lands mid-transition. */
const STILL = `*,*::before,*::after{animation:none!important;transition:none!important;
  animation-duration:0s!important;transition-duration:0s!important;caret-color:transparent!important}
  *{scrollbar-width:none!important}::-webkit-scrollbar{display:none!important}`;

export const SHOTS = [
  // ── Overview and dashboards ────────────────────────────────────────────
  { name: 'dashboard-light', path: '/dashboard', theme: 'light', wait: 'text=Total Computers', settle: 4000 },
  { name: 'dashboard-dark', path: '/dashboard', theme: 'dark', wait: 'text=Total Computers', settle: 4000 },
  { name: 'businesses-light', path: '/businesses', theme: 'light', wait: 'text=Northwind Dental' },
  { name: 'business-overview-dark', maxHeight: 700, path: '@business', theme: 'dark', wait: 'text=Quick Connect' },

  // ── Visual insights and monitoring ─────────────────────────────────────
  { name: 'client-map-dark', path: '/dashboard', theme: 'dark', wait: 'text=Total Computers', settle: 5000,
    clip: '@map' },
  { name: 'sessions-live-dark', path: '/sessions', theme: 'dark', wait: 'text=Connected' },
  { name: 'session-history-light', path: '/sessions', theme: 'light', click: ['button:has-text("Session History")'], settle: 3000 },
  { name: 'audit-timeline-dark', path: '/audit', theme: 'dark', settle: 3500 },
  { name: 'audit-timeline-light', path: '/audit', theme: 'light', settle: 3500 },
  { name: 'system-status-dark', path: '/admin/status', theme: 'dark', settle: 4000 },
  { name: 'security-overview-light', maxHeight: 620, path: '/admin/security', theme: 'light', settle: 4000 },

  // ── Device inventory ───────────────────────────────────────────────────
  { name: 'computers-inventory-light', path: '/endpoints', theme: 'light', wait: 'text=RustDesk ID' },
  { name: 'computers-inventory-dark', path: '/endpoints', theme: 'dark', wait: 'text=RustDesk ID' },
  { name: 'business-computers-dark', path: '@business', theme: 'dark', click: ['button:has-text("Computers")'], settle: 2500 },
  { name: 'device-detail-light', maxHeight: 660, path: '@endpoint', theme: 'light', settle: 3000 },
  { name: 'my-computers-dark', path: '/my-computers', theme: 'dark', settle: 3000 },
  { name: 'unassigned-light', maxHeight: 620, path: '/admin/unassigned', theme: 'light', settle: 2500 },

  // ── Everyday workflows ─────────────────────────────────────────────────
  { name: 'enroll-device-light', path: '/endpoints/enroll', theme: 'light',
    click: ['[role=combobox]', '[role=option]:has-text("Harbor Logistics")', 'text=Ellen Vasquez'], settle: 2500 },
  { name: 'enroll-device-dark', path: '/endpoints/enroll', theme: 'dark',
    click: ['[role=combobox]', '[role=option]:has-text("Cascade Accounting")'], settle: 2500 },
  { name: 'downloads-dark', path: '/downloads', theme: 'dark', settle: 3000 },
  { name: 'quick-connect-light', path: '/quick-connect', theme: 'light', settle: 2500 },
  { name: 'help-dark', path: '/help', theme: 'dark', settle: 3000 },

  // ── Access and administration ──────────────────────────────────────────
  { name: 'access-model-light', path: '/admin/access', theme: 'light', settle: 3000 },
  { name: 'access-users-dark', path: '/admin/access', theme: 'dark',
    click: ['button:has-text("Business Users")'], settle: 3000 },
  { name: 'access-admins-light', maxHeight: 660, path: '/admin/access', theme: 'light',
    click: ['button:has-text("Platform Admins")'], settle: 2500 },
  { name: 'users-dark', path: '/users', theme: 'dark', settle: 2500 },
  { name: 'account-security-light', path: '/account', theme: 'light', settle: 3000 },

  // ── Configuration ──────────────────────────────────────────────────────
  { name: 'settings-dark', maxHeight: 820, path: '/settings', theme: 'dark',
    click: ['button:has-text("RustDesk")'], settle: 3000 },
  { name: 'branding-light', maxHeight: 760, path: '/settings/branding', theme: 'light', settle: 3000 },
  { name: 'release-history-dark', path: '/about', theme: 'dark', settle: 3000 },
  { name: 'documentation-light', path: '/docs', theme: 'light', settle: 3500 },
];

async function signIn(ctx) {
  const page = await ctx.newPage();
  await page.goto(`${WEB}/login`, { waitUntil: 'networkidle' });
  await page.fill('input[type="email"]', process.env.EMAIL);
  await page.fill('input[type="password"]', process.env.PASSWORD);
  await page.click('button[type="submit"]');
  await page.waitForURL((u) => !u.pathname.includes('/login'), { timeout: 30000 });
  return page;
}

async function makeContext(browser, theme) {
  const ctx = await browser.newContext({
    viewport: VIEWPORT, deviceScaleFactor: SCALE,
    colorScheme: theme, reducedMotion: 'reduce',
  });
  // The app reads localStorage.theme on mount — set it before any script runs
  // so the first paint is already the right theme.
  await ctx.addInitScript((t) => { try { localStorage.setItem('theme', t); } catch {} }, theme);
  return ctx;
}

async function run() {
  await mkdir(OUT, { recursive: true });
  const only = process.env.ONLY?.split(',').map((s) => s.trim()).filter(Boolean);
  const shots = only?.length ? SHOTS.filter((s) => only.includes(s.name)) : SHOTS;

  const browser = await chromium.launch();
  const manifest = [];
  let businessId = null, endpointId = null;

  for (const theme of ['light', 'dark']) {
    const themeShots = shots.filter((s) => s.theme === theme);
    if (!themeShots.length) continue;

    const ctx = await makeContext(browser, theme);
    const page = await signIn(ctx);

    // Resolve one business and one endpoint id for the @-placeholders.
    if (!businessId) {
      const r = await page.evaluate(async () => {
        // The API wraps lists under a named key (data.customers / data.endpoints),
        // not a generic `items` — pick whichever array comes back.
        const arr = (d) => d?.data?.customers ?? d?.data?.endpoints ?? d?.data?.items
          ?? (Array.isArray(d?.data) ? d.data : []);
        const b = await fetch('/api/v1/customers?limit=50').then((x) => x.json()).catch(() => null);
        const list = arr(b);
        const harbor = list.find((c) => /Harbor/.test(c.name)) ?? list[0];
        const e = await fetch('/api/v1/endpoints?limit=50').then((x) => x.json()).catch(() => null);
        const eps = arr(e);
        const online = eps.find((x) => x.isOnline && /HARB/.test(x.name ?? '')) ?? eps.find((x) => x.isOnline) ?? eps[0];
        return { businessId: harbor?.id ?? null, endpointId: online?.id ?? null };
      });
      businessId = r.businessId; endpointId = r.endpointId;
    }

    for (const s of themeShots) {
      const target = s.path
        .replace('@business', `/businesses/${businessId}`)
        .replace('@endpoint', `/endpoints/${endpointId}`);
      const p = s.anon ? await (await makeContext(browser, theme)).newPage() : page;
      try {
        await p.goto(`${WEB}${target}`, { waitUntil: 'networkidle', timeout: 40000 });
        await p.addStyleTag({ content: STILL });
        if (s.wait) await p.waitForSelector(s.wait, { timeout: 15000 }).catch(() => {});
        for (const c of s.click ?? []) {
          await p.click(c, { timeout: 8000 }).catch(() => console.log(`    (click missed: ${c})`));
          await p.waitForTimeout(900);
        }
        await p.waitForTimeout(s.settle ?? 2500);
        await p.evaluate(() => document.fonts?.ready);
        await applyMasks(p);
        await p.waitForTimeout(250);

        const file = path.join(OUT, `${s.name}.png`);
        if (s.clip === '@map') {
          // The first <svg> on the page is the sidebar logo. Take the largest
          // one instead — that is the map — and frame its surrounding card.
          const box = await p.evaluate(() => {
            const svgs = [...document.querySelectorAll('svg')];
            if (!svgs.length) return null;
            const biggest = svgs.map((el) => ({ el, r: el.getBoundingClientRect() }))
              .sort((a, b) => b.r.width * b.r.height - a.r.width * a.r.height)[0];
            const card = biggest.el.closest('div.rounded-lg,div.rounded-xl,section') ?? biggest.el;
            const r = card.getBoundingClientRect();
            return { x: Math.max(0, r.x - 4), y: Math.max(0, r.y - 4),
                     width: Math.min(r.width + 8, window.innerWidth - r.x),
                     height: Math.min(r.height + 8, window.innerHeight - r.y) };
          });
          await p.screenshot({ path: file, clip: box ?? undefined });
        } else if (s.maxHeight) {
          // Pages whose content ends well above the fold would otherwise be
          // half empty, which reads badly at GitHub's display width.
          await p.screenshot({ path: file,
            clip: { x: 0, y: 0, width: VIEWPORT.width, height: s.maxHeight } });
        } else {
          await p.screenshot({ path: file });
        }
        manifest.push({ name: s.name, route: target, theme, viewport: `${VIEWPORT.width}x${VIEWPORT.height}@${SCALE}x` });
        console.log(`  ✓ ${s.name}  [${theme}]  ${target}`);
      } catch (e) {
        console.log(`  ✗ ${s.name} — ${e.message.split('\n')[0]}`);
      }
      if (s.anon) await p.context().close();
    }
    await ctx.close();
  }

  await writeFile(path.join(OUT, 'manifest.json'),
    JSON.stringify({ viewport: VIEWPORT, deviceScaleFactor: SCALE,
      demoData: 'apps/api/prisma/_docs-demo-data.ts against reboot_remote_docs',
      shots: manifest }, null, 2) + '\n');
  console.log(`\n${manifest.length} captured -> ${OUT}`);
  await browser.close();
}

run();
