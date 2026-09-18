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
import { mkdir, writeFile, readFile } from 'fs/promises';
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
  // The device page is mostly collected inventory now, so it needs more than
  // the old 660px: that height cropped it at the Assignment card, above
  // everything the page is actually for.
  { name: 'device-detail-light', maxHeight: 1100, path: '@endpoint', theme: 'light', settle: 3500 },
  { name: 'device-resources-light', path: '@endpoint', theme: 'light', settle: 3500,
    clip: '@resources' },
  { name: 'device-specs-dark', path: '@endpoint', theme: 'dark', settle: 3500,
    clip: '@specs' },
  { name: 'device-event-log-dark', maxHeight: 1000, path: '@endpoint', theme: 'dark',
    click: ['button[role=tab]:has-text("Event Log")'], settle: 2500 },
  { name: 'my-computers-dark', path: '/my-computers', theme: 'dark', settle: 3000 },
  { name: 'unassigned-light', maxHeight: 620, path: '/admin/unassigned', theme: 'light', settle: 2500 },

  // ── Everyday workflows ─────────────────────────────────────────────────
  { name: 'enroll-device-light', path: '/endpoints/enroll', theme: 'light',
    click: ['[role=combobox]', '[role=option]:has-text("Harbor Logistics")', 'text=Ellen Vasquez'], settle: 2500 },
  { name: 'enroll-device-dark', path: '/endpoints/enroll', theme: 'dark',
    click: ['[role=combobox]', '[role=option]:has-text("Cascade Accounting")'], settle: 2500 },
  { name: 'downloads-dark', path: '/downloads', theme: 'dark', settle: 3000 },
  { name: 'quick-connect-light', path: '/quick-connect', theme: 'light', settle: 2500 },
  // What a Tactical RMM URL Action lands on when a hostname is ambiguous. The
  // demo data carries a deliberate cross-business collision on "reception-pc"
  // for exactly this, because the refusal to guess is the point of the feature.
  // No `client` on purpose. Passing one would narrow the two candidates to a
  // single business, and a single match does not show a picker — it connects,
  // which during a capture means a credential issued and a .cmd download. The
  // shot needs the ambiguous case, which is the hostname alone.
  { name: 'trmm-match-dark', maxHeight: 900, theme: 'dark', settle: 2500,
    path: '/trmm?host=reception-pc&agent=demo-agent-0001' },
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
        } else if (s.clip === '@resources') {
          // The live-sample gauges, on their own. Anchored on the card's own
          // heading: it sits above the specs grid rather than inside it, so
          // the @specs anchor below deliberately does not include it.
          const found = await p.evaluate(() => {
            const head = [...document.querySelectorAll('div,section')]
              .find((el) => /^Resources$/.test((el.textContent ?? '').trim()));
            const card = head?.closest('div.rounded-lg,div.rounded-xl,section');
            if (!card) return false;
            card.setAttribute('data-capture-resources', '');
            return true;
          });
          if (found) {
            await p.locator('[data-capture-resources]').screenshot({ path: file });
          } else {
            console.log('    (resources card not found — full page instead)');
            await p.screenshot({ path: file });
          }
        } else if (s.clip === '@specs') {
          // The collected-inventory grid on a device page, on its own.
          //
          // Taken as an ELEMENT screenshot, not a clip. A clip is bounded by
          // the viewport, and this grid is taller than one — the first attempt
          // produced an image that stopped halfway through the Hardware card,
          // mid-row, which looks like a rendering fault rather than a crop.
          // Playwright scrolls an element into view and captures all of it.
          //
          // Anchored on the Hardware card's heading rather than a position or
          // a class: the grid re-flows between one and two columns with the
          // window, so anything geometric breaks at the next viewport change.
          const found = await p.evaluate(() => {
            const heads = [...document.querySelectorAll('div,section')]
              .filter((el) => /^Hardware$/.test((el.textContent ?? '').trim()));
            const card = heads[0]?.closest('div.rounded-lg,div.rounded-xl,section');
            const grid = card?.parentElement?.closest('div.grid') ?? card?.parentElement;
            if (!grid) return false;
            grid.setAttribute('data-capture-specs', '');
            return true;
          });
          if (found) {
            await p.locator('[data-capture-specs]').screenshot({ path: file });
          } else {
            // No cards at all is what an endpoint that has never reported
            // looks like; fall back rather than failing the whole run.
            console.log('    (specs grid not found — full page instead)');
            await p.screenshot({ path: file });
          }
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

  // A partial run (ONLY=...) must not throw away the rest of the manifest.
  // It did once: re-shooting three images rewrote the file with three entries,
  // and the gallery page then referenced thirty images the manifest denied
  // existed. Merge by name, keeping this run's entries and preserving the
  // order already recorded.
  const manifestPath = path.join(OUT, 'manifest.json');
  let merged = manifest;
  if (only?.length) {
    let existing = [];
    try {
      existing = JSON.parse(await readFile(manifestPath, 'utf8')).shots ?? [];
    } catch { /* no manifest yet - this run's entries are the whole of it */ }
    const fresh = new Map(manifest.map((m) => [m.name, m]));
    merged = [
      ...existing.map((e) => fresh.get(e.name) ?? e),
      ...manifest.filter((m) => !existing.some((e) => e.name === m.name)),
    ];
  }

  await writeFile(manifestPath,
    JSON.stringify({ viewport: VIEWPORT, deviceScaleFactor: SCALE,
      demoData: 'apps/api/prisma/_docs-demo-data.ts against reboot_remote_docs',
      shots: merged }, null, 2) + '\n');
  console.log(`\n${manifest.length} captured -> ${OUT}`);
  await browser.close();
}

run();
