#!/usr/bin/env node
/**
 * Rem0te walkthrough recorder.
 *
 * Drives the real application with Playwright and records WebM, which
 * scripts/build-video.sh then turns into MP4 + poster + highlight clip.
 * Same rules as the screenshot pass: isolated demo stack only, the app's own
 * theme switch, capture-only masking that never writes to the database.
 *
 *   WEB_URL=http://127.0.0.1:4000 EMAIL=... PASSWORD=... \
 *   node apps/web/scripts/capture-video.mjs            # full walkthrough
 *   CUT=highlight node apps/web/scripts/capture-video.mjs   # the ~55 s highlight
 *
 * Output: <VIDEO_OUT>/walkthrough.webm (or highlight.webm) and a
 * <name>.captions.json with every caption and chapter and when it appeared,
 * from which docs/media/walkthrough.vtt and walkthrough-script.md are written
 * (media/ is untracked — see .gitignore).
 *
 * The walkthrough is caption-led, not narrated. Every caption is shown in a
 * bar at the bottom of the frame; what is about to be clicked or read is
 * outlined with a ring, and a drawn pointer moves to it (headless Chromium
 * records no mouse pointer of its own).
 *
 * Masking (capture-masks.mjs) runs as a MutationObserver installed before
 * any page script, so a value is replaced in the DOM before it is ever
 * painted — a recording has no "between render and mask" frame.
 *
 * Nothing destructive is pressed. Dialogs that would sign a plan (service
 * control, End process, Uninstall, Install selected, catalog adds) are opened
 * and cancelled; so are the scheduled-install and new-policy forms, and
 * Schedule restart is only pointed at. The only writes are a chat message, a
 * ticket to the docs stack's loopback PSA stand-in, and — when TASK_FINISH_CMD
 * is set — the demo's running update install answered as the agent would
 * (prisma/_docs-demo-almanac.ts finish, docs database only), so the console's
 * "your task finished" toast (0.52) appears on camera.
 */
import { chromium } from 'playwright';
import { mkdir, readdir, rename, writeFile, rm } from 'fs/promises';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { fileURLToPath } from 'url';
import path from 'path';
import { MASKS } from './capture-masks.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../../..');
const OUT = process.env.VIDEO_OUT ?? path.join(ROOT, 'media/raw');
const WEB = process.env.WEB_URL ?? 'http://127.0.0.1:4000';
const CUT = process.env.CUT === 'highlight' ? 'highlight' : 'walkthrough';
const SIZE = { width: 1920, height: 1080 };

if (/https:\/\//.test(WEB) || /:(3000|443)\b/.test(WEB)) {
  throw new Error(`Refusing to record ${WEB} — point WEB_URL at the isolated demo stack`);
}

const STILL = `*{caret-color:transparent!important}
  *::-webkit-scrollbar{display:none!important}`;

/** Caption bar, chapter tag, title card, highlight ring and a drawn pointer. */
const OVERLAY_CSS = `
#rm-cap{position:fixed;left:0;right:0;bottom:0;z-index:2147483647;pointer-events:none;
  font:500 27px/1.38 Inter,system-ui,sans-serif;color:#fff;
  background:linear-gradient(transparent,rgba(9,12,20,.93) 36%);
  padding:72px 120px 38px;text-align:center;opacity:0;transition:opacity .3s ease}
#rm-cap.on{opacity:1}
#rm-cap b{color:#7dd3fc;font-weight:600}
#rm-chap{position:fixed;top:12px;left:50%;transform:translateX(-50%);z-index:2147483647;pointer-events:none;
  font:600 15px/1 Inter,system-ui,sans-serif;letter-spacing:.06em;text-transform:uppercase;
  color:#fff;background:rgba(15,23,42,.86);border:1px solid rgba(125,211,252,.55);
  padding:9px 14px;border-radius:999px;opacity:0;transition:opacity .4s ease}
#rm-chap.on{opacity:1}
#rm-card{position:fixed;inset:0;z-index:2147483647;display:flex;flex-direction:column;
  align-items:center;justify-content:center;gap:18px;background:#0b1220;color:#fff;
  font-family:Inter,system-ui,sans-serif;opacity:0;transition:opacity .5s ease;
  pointer-events:none;visibility:hidden}
#rm-card.on{opacity:1;visibility:visible}
#rm-card .t{font-size:66px;font-weight:700;letter-spacing:-1px}
#rm-card .s{font-size:27px;color:#94a3b8;max-width:1150px;text-align:center;line-height:1.45;white-space:pre-line}
#rm-card .u{font-size:24px;color:#7dd3fc;margin-top:10px}
#rm-ring{position:fixed;z-index:2147483646;pointer-events:none;border:3px solid #f43f5e;border-radius:10px;
  box-shadow:0 0 0 5px rgba(244,63,94,.22),0 0 22px rgba(244,63,94,.35);opacity:0;
  transition:opacity .25s ease,left .35s ease,top .35s ease,width .35s ease,height .35s ease}
#rm-ring.on{opacity:1;animation:rmpulse 1.4s ease-in-out infinite}
@keyframes rmpulse{50%{box-shadow:0 0 0 9px rgba(244,63,94,.12),0 0 28px rgba(244,63,94,.45)}}
#rm-cursor{position:fixed;left:0;top:0;width:28px;height:28px;z-index:2147483647;pointer-events:none;
  transform:translate(-100px,-100px);filter:drop-shadow(0 1px 2px rgba(0,0,0,.45))}
#rm-cursor.down svg{transform:scale(.86);transform-origin:3px 3px}`;
const CURSOR_SVG = '<svg width="28" height="28" viewBox="0 0 28 28"><path d="M3 2 L3 23 L9 17.5 L13 26 L17 24.2 L13 15.8 L21 15.8 Z" fill="#fff" stroke="#111827" stroke-width="1.6" stroke-linejoin="round"/></svg>';

// ── State kept across navigations ────────────────────────────────────────
let T0 = 0;
const events = [];
const misses = [];
let pos = { x: 960, y: 540 };
let chapterName = '';
const now = () => +((Date.now() - T0) / 1000).toFixed(2);
// PACE scales every pause and hold (1 = as written); the defaults land the
// walkthrough at about ten and a half minutes and the highlight under a minute.
// Title cards are not scaled.
const PACE = Number(process.env.PACE ?? (CUT === 'highlight' ? 0.6 : 0.85));
const wait = (p, ms) => p.waitForTimeout(Math.round(ms * PACE));

async function ui(page) {
  await page.addStyleTag({ content: STILL + OVERLAY_CSS }).catch(() => {});
  await page.evaluate(([svg, p, chap]) => {
    if (document.getElementById('rm-cap')) return;
    const mk = (id, html = '') => { const d = document.createElement('div'); d.id = id; d.innerHTML = html; document.body.appendChild(d); return d; };
    mk('rm-ring'); mk('rm-cap');
    const c = mk('rm-chap'); if (chap) { c.textContent = chap; c.classList.add('on'); }
    mk('rm-card', '<div class="t"></div><div class="s"></div><div class="u"></div>');
    const cur = mk('rm-cursor', svg);
    cur.style.transform = `translate(${p.x - 3}px,${p.y - 2}px)`;
    document.addEventListener('mousemove', (e) => { cur.style.transform = `translate(${e.clientX - 3}px,${e.clientY - 2}px)`; }, true);
    document.addEventListener('mousedown', () => cur.classList.add('down'), true);
    document.addEventListener('mouseup', () => cur.classList.remove('down'), true);
  }, [CURSOR_SVG, pos, chapterName]).catch(() => {});
}

/** A caption. `html` may hold <b>; the log keeps the plain text. */
async function say(page, html, hold = 0) {
  await ui(page);
  await page.evaluate((h) => { const c = document.getElementById('rm-cap'); c.innerHTML = h; c.classList.add('on'); }, html).catch(() => {});
  const text = html.replace(/<[^>]+>/g, '');
  const last = events.filter((e) => e.kind === 'caption').at(-1);
  if (last && last.end == null) last.end = now();
  events.push({ kind: 'caption', start: now(), end: null, text, chapter: chapterName });
  if (hold) await wait(page, hold);
}
async function clear(page) {
  await page.evaluate(() => document.getElementById('rm-cap')?.classList.remove('on')).catch(() => {});
  const last = events.filter((e) => e.kind === 'caption').at(-1);
  if (last && last.end == null) last.end = now();
}
async function chapter(page, name) {
  chapterName = name;
  events.push({ kind: 'chapter', start: now(), text: name });
  await ui(page);
  await page.evaluate((n) => { const c = document.getElementById('rm-chap'); c.textContent = n; c.classList.add('on'); }, name).catch(() => {});
}
async function card(page, t, s, u = '', ms = 5000) {
  await ui(page);
  await page.evaluate(([t, s, u]) => {
    const k = document.getElementById('rm-card');
    k.querySelector('.t').textContent = t; k.querySelector('.s').textContent = s;
    k.querySelector('.u').textContent = u; k.classList.add('on');
    document.getElementById('rm-chap')?.classList.remove('on');
  }, [t, s, u]);
  events.push({ kind: 'card', start: now(), end: null, text: [t, s, u].filter(Boolean).join(' — ') });
  await page.waitForTimeout(ms);
  events.at(-1).end = now();
}
const uncard = (page) => page.evaluate(() => {
  document.getElementById('rm-card')?.classList.remove('on');
  if (document.getElementById('rm-chap')?.textContent) document.getElementById('rm-chap').classList.add('on');
}).catch(() => {});

async function unring(page) { await page.evaluate(() => document.getElementById('rm-ring')?.classList.remove('on')).catch(() => {}); }

async function go(page, route, settle = 1800) {
  await page.goto(`${WEB}${route}`, { waitUntil: 'networkidle', timeout: 40000 }).catch(() => {});
  await ui(page);
  await wait(page, settle);
}

/** Move the drawn pointer (and the real mouse) deliberately, so the eye can follow it. */
async function moveTo(page, x, y, steps = 28) {
  await page.mouse.move(x, y, { steps });
  pos = { x, y };
}

/**
 * Find `sel`, bring it into the middle of the frame (clear of the caption
 * bar), move the pointer to it and ring it. Optionally click. A selector that
 * is not found is logged and skipped, so one moved button never costs the
 * whole recording.
 */
async function show(page, sel, { click = false, hold = 1100, timeout = 8000, pad = 6, ringIt = true, nth = 0 } = {}) {
  const l = page.locator(sel).nth(nth);
  try { await l.waitFor({ state: 'visible', timeout }); } catch { misses.push(sel); console.log(`  (missed: ${sel})`); return null; }
  const pre = await l.boundingBox();
  if (pre && (pre.y < 70 || pre.y + pre.height > SIZE.height - 190)) {
    // A tall element (a whole table) is brought to the top, not centred,
    // or the page jumps to the middle of it.
    const block = pre.height < 700 ? 'center' : 'start';
    await l.evaluate((el, b) => el.scrollIntoView({ block: b, behavior: 'smooth' }), block).catch(() => {});
    await page.waitForTimeout(300);
  }
  // Ring it only once it has stopped moving: a smooth scroll can take longer than any fixed pause.
  // A smooth scroll can start late, so it takes three steady reads in a row.
  let b = await l.boundingBox();
  for (let i = 0, steady = 0; i < 30 && steady < 3; i++) {
    await page.waitForTimeout(120);
    const n = await l.boundingBox();
    steady = b && n && Math.abs(n.y - b.y) < 1 && Math.abs(n.x - b.x) < 1 ? steady + 1 : 0;
    b = n;
    if (!b) break;
  }
  if (!b) { misses.push(sel); return null; }
  await moveTo(page, b.x + Math.min(b.width / 2, 260), b.y + b.height / 2);
  if (ringIt) {
    await page.evaluate(([r, p]) => {
      const g = document.getElementById('rm-ring'); if (!g) return;
      Object.assign(g.style, { left: `${r.x - p}px`, top: `${r.y - p}px`, width: `${r.width + 2 * p}px`, height: `${r.height + 2 * p}px` });
      g.classList.add('on');
    }, [b, pad]).catch(() => {});
  }
  await wait(page, hold);
  if (click) {
    await l.click({ timeout: 6000 }).catch((e) => { misses.push(`${sel} (click)`); console.log(`  (click failed: ${sel}: ${e.message.split('\n')[0]})`); });
    await unring(page);
    await ui(page);
  }
  return l;
}
const press = (page, sel, o = {}) => show(page, sel, { ...o, click: true });

/** Type into a field the way a person does, visibly. */
async function type(page, sel, text, delay = 45) {
  const l = await show(page, sel, { hold: 500 });
  if (!l) return;
  await l.click().catch(() => {});
  await l.pressSequentially(text, { delay }).catch(() => {});
}

/** Pick in a native <select>: ring it, then change it. */
async function pick(page, sel, label, hold = 900) {
  const l = await show(page, sel, { hold });
  if (!l) return;
  await l.selectOption({ label }).catch(() => l.selectOption(label).catch(() => misses.push(`${sel} -> ${label}`)));
  await wait(page, 700);
}

/** Scroll the app's own scroller (main) by `dy`, smoothly. */
async function scroll(page, dy, ms = 1200) {
  await unring(page);
  await page.evaluate((d) => {
    const m = [...document.querySelectorAll('main, main *')].find((el) => el.scrollHeight > el.clientHeight + 20 && /auto|scroll/.test(getComputedStyle(el).overflowY));
    (m ?? document.scrollingElement).scrollBy({ top: d, behavior: 'smooth' });
  }, dy).catch(() => {});
  await wait(page, ms);
}
async function top(page) {
  await unring(page);
  await page.evaluate(() => { for (const el of document.querySelectorAll('main, main *')) if (el.scrollTop) el.scrollTop = 0; window.scrollTo(0, 0); }).catch(() => {});
}

async function endpointId(page, name) {
  return page.evaluate(async (n) => {
    const r = await fetch(`/api/v1/endpoints?search=${encodeURIComponent(n)}&pageSize=25`).then((x) => x.json()).catch(() => null);
    return (r?.data?.endpoints ?? r?.data?.items ?? []).find((x) => x.name === n)?.id ?? null;
  }, name);
}
async function deploymentId(page, businessId, name) {
  return page.evaluate(async ([b, n]) => {
    const r = await fetch(`/api/v1/patching/deployments?businessId=${encodeURIComponent(b)}`).then((x) => x.json()).catch(() => null);
    const l = r?.data?.deployments ?? r?.data?.items ?? (Array.isArray(r?.data) ? r.data : []);
    return l.find((d) => d.name === n)?.id ?? null;
  }, [businessId, name]);
}
/** Answer the demo's running install (TASK_FINISH_CMD), so a task of yours finishes on camera. */
async function finishTask() {
  const cmd = process.env.TASK_FINISH_CMD;
  if (!cmd) { misses.push('TASK_FINISH_CMD (no toast)'); return false; }
  try { await promisify(execFile)('/bin/sh', ['-c', cmd], { timeout: 120000 }); return true; } catch (e) { misses.push(`TASK_FINISH_CMD: ${e.message.split('\n')[0]}`); return false; }
}
async function businessId(page, name) {
  return page.evaluate(async (n) => {
    const r = await fetch('/api/v1/customers?limit=50').then((x) => x.json()).catch(() => null);
    const l = r?.data?.customers ?? r?.data?.items ?? (Array.isArray(r?.data) ? r.data : []);
    return l.find((c) => c.name === n)?.id ?? null;
  }, name);
}
const tab = (page, id) => press(page, `[data-testid="tab-${id}"]`, { hold: 700 });
async function cancelDialog(page) {
  const sel = '[role="dialog"] button:has-text("Cancel"), [role="alertdialog"] button:has-text("Cancel")';
  if (await page.locator(sel).first().isVisible().catch(() => false)) await press(page, sel, { hold: 700, timeout: 4000 });
  else { await unring(page); await page.keyboard.press('Escape'); }
  await wait(page, 600);
}

// ── The walkthrough ──────────────────────────────────────────────────────
async function signIn(page) {
  await page.fill('input[type="email"]', '');
  await type(page, 'input[type="email"]', process.env.EMAIL, 28);
  await wait(page, 300);
  await show(page, 'input[type="password"]', { hold: 300 });
  await page.fill('input[type="password"]', process.env.PASSWORD);
  await wait(page, 500);
  await press(page, 'button[type="submit"]', { hold: 600 });
  await page.waitForURL((u) => !u.pathname.includes('/login'), { timeout: 30000 });
  await ui(page);
  await wait(page, 2500);
}

async function walkthrough(page, ids) {

  // Title and sign-in
  await page.goto(`${WEB}/login`, { waitUntil: 'networkidle' });
  await card(page, 'Rem0te', 'Self-hosted remote support and management for the computers of your customer businesses, built on RustDesk.', 'A captioned tour of every feature · v0.53', 6000);
  await uncard(page); await wait(page, 600);
  await chapter(page, 'Sign in');
  await say(page, 'A <b>demo environment</b>: every business, person and computer here is fictitious');
  await signIn(page);
  await ids.resolve();
  await say(page, 'The computers report through a <b>simulated agent</b>: nothing shown here ran on a real Windows PC', 4200);
  await clear(page);

  // Dashboard
  await chapter(page, 'Dashboard');
  await go(page, '/dashboard', 2500);
  await say(page, 'The dashboard: what needs attention now, across every customer business');
  await show(page, 'text=Work on next', { hold: 3200 });
  await say(page, 'A site outage is grouped into one alert instead of one per computer');
  await show(page, 'text=Site outage:', { hold: 3000 });
  await say(page, 'Counts, customers affected and patch status, each a link into the detail');
  await show(page, 'text=Customers affected', { hold: 3000 });
  await unring(page); await clear(page);

  // Devices list
  await chapter(page, 'Devices');
  await go(page, '/endpoints', 2200);
  await say(page, '<b>Devices</b>: every enrolled computer you may see, with health, agent and patches');
  await show(page, 'table', { hold: 2600, pad: 2 });
  await say(page, 'Search by name, host, IP, user or business');
  await type(page, 'input[aria-label="Search devices"]', 'harb', 90);
  await wait(page, 2200);
  await page.fill('input[aria-label="Search devices"]', '');
  await wait(page, 900);
  await say(page, 'Filters for business, site, group, online state, alerts and agent');
  await press(page, 'button[aria-label="Business"]', { hold: 900 });
  await press(page, '[role="option"]:has-text("Harbor Logistics")', { hold: 900 });
  await unring(page);
  await wait(page, 1800);
  await say(page, '<b>Views</b> save a filter set, private or shared with the team');
  await press(page, 'button:has-text("Views")', { hold: 800 });
  await wait(page, 2400);
  await page.keyboard.press('Escape');
  await say(page, '<b>Columns</b> come in at the window widths where they fit');
  await press(page, 'button:has-text("Columns")', { hold: 800 });
  await wait(page, 2400);
  await page.keyboard.press('Escape');
  await say(page, 'Tick computers for <b>bulk</b> actions: update, reinstall, tags, groups, export');
  await press(page, 'input[aria-label="Select HARB-DISPATCH-01"]', { hold: 500 });
  await press(page, 'input[aria-label="Select HARB-DISPATCH-02"]', { hold: 500 });
  await show(page, '[aria-label="Bulk actions"]', { hold: 3200 });
  await unring(page); await clear(page);

  // A computer's workspace
  await chapter(page, 'A computer');
  await go(page, `/endpoints/${ids.dispatch}`, 2200);
  await say(page, 'One computer\'s workspace: status, the actions you may take, and a tab per job');
  await show(page, '[data-testid="workspace-tabs"]', { hold: 3200, pad: 3 });
  await say(page, 'The header says what is wrong at a glance: alerts, pending updates, which agent');
  await show(page, '[data-testid="device-status"]', { hold: 2800 });
  await say(page, 'The <b>Tasks</b> panel: everything sent to this computer, and where each one is');
  await show(page, '[data-testid="device-tasks"]', { hold: 2600, pad: 3 });
  await press(page, '[data-testid="device-tasks-toggle"]', { hold: 600 });
  await say(page, 'Recent tasks stay listed for two weeks, each with its steps and its result');
  await show(page, '[data-testid="device-tasks"] [data-testid="task-row"] >> nth=0', { hold: 3200, pad: 3 });
  await press(page, '[data-testid="device-tasks-toggle"]', { hold: 400 });
  await say(page, 'The <b>Agent</b> card: version, channel, and automatic agent updates');
  await show(page, '[data-testid="agent-auto-update"]', { hold: 2600 });
  await say(page, 'Automatic updates can be set <b>per computer</b>: Inherit, On or Off');
  await show(page, '[data-testid="agent-auto-update-select"]', { hold: 3000 });
  await say(page, 'This demo server runs with automatic agent updates switched off, which wins over the computer\'s On');
  await show(page, '[data-testid="agent-auto-update-effective"]', { hold: 3800 });
  await top(page);
  await say(page, '<b>Inventory</b>: hardware, operating system, disks and the logged-on user');
  await scroll(page, 900, 1500);
  await wait(page, 2400);
  await top(page);
  await tab(page, 'performance');
  await say(page, '<b>Performance</b>: processor, memory and disk over up to 30 days');
  await wait(page, 3000);

  await tab(page, 'software');
  await say(page, '<b>Software</b>: the catalog, ready to install, and every installed program');
  await wait(page, 1500);
  await say(page, 'Install a package from the catalog: one signed plan for this computer');
  await press(page, 'tr:has-text("Mozilla Firefox") button:has-text("Install")', { hold: 900 });
  await wait(page, 2600);
  await cancelDialog(page);
  await say(page, 'Remove an installed program: the agent reads the uninstall entry itself and decides how');
  await press(page, 'tr:has-text("7-Zip 24.08") button:has-text("Uninstall")', { hold: 900 });
  await wait(page, 3000);
  await cancelDialog(page);
  await say(page, 'Rem0te and RustDesk are protected and never offered for removal');
  await show(page, 'text=protected (remote access)', { hold: 2600 });

  await tab(page, 'services');
  await say(page, '<b>Services</b>: start, stop, restart, or change the startup type');
  await type(page, 'input[aria-label="Filter services"]', 'spool', 80);
  await wait(page, 900);
  await show(page, 'tr:has-text("Print Spooler")', { hold: 2400, pad: 3 });
  await press(page, 'tr:has-text("Print Spooler") button:has-text("Startup type")', { hold: 700 });
  await say(page, 'Each change is a signed plan; the agent checks the service again before it acts');
  await wait(page, 3200);
  await cancelDialog(page);

  await tab(page, 'processes');
  await say(page, '<b>Processes</b>: end one process, matched by name and start time, never a reused PID');
  await press(page, 'tr:has-text("SearchIndexer") button:has-text("End process")', { hold: 900 });
  await wait(page, 3200);
  await cancelDialog(page);

  await tab(page, 'events');
  await say(page, '<b>Event logs</b>, with <b>Ask AI</b> and <b>Create ticket</b> on any entry');
  await wait(page, 1500);
  await press(page, 'button:has-text("Ask AI")', { hold: 900 });
  await say(page, 'Ask AI explains an entry in plain language. Here the provider is a local stand-in');
  await page.waitForSelector('text=Safe next steps', { timeout: 30000 }).catch(() => misses.push('Ask AI answer'));
  await wait(page, 3200);
  await scroll(page, 300, 900);
  await wait(page, 1500);
  await press(page, '[role="dialog"] button:has-text("Close")', { hold: 500 });
  await say(page, 'Create ticket sends the entry to your PSA, with the AI explanation if you want it');
  // The ticket for the entry Ask AI just explained, so its answer can go with it.
  await press(page, 'button:has-text("Ask AI") >> nth=0 >> xpath=ancestor::*[.//button[contains(., "Create ticket") or contains(., "Ticket again")]][1] >> button:text-matches("Create ticket|Ticket again")', { hold: 800 });
  await type(page, '#ticket-note', 'Dispatch cannot print labels; watching for a repeat.', 22);
  await show(page, '[role="dialog"] label:has-text("Include AI explanation")', { hold: 1200 });
  await page.check('[role="dialog"] input[type="checkbox"]', { timeout: 2000 }).catch(() => misses.push('Include AI explanation (disabled)'));
  await press(page, '[role="dialog"] button:text-is("Send")', { hold: 800 });
  await say(page, 'The ticket number comes back from the PSA (a loopback stand-in in this demo)');
  await wait(page, 3200);
  await page.keyboard.press('Escape');

  await tab(page, 'patches');
  await say(page, '<b>Patches</b>: the signed agent\'s last Windows Update scan, and what it offers');
  await wait(page, 1200);
  await show(page, 'text=Signed agent scan', { hold: 2400 });
  await say(page, 'The <b>Latest install</b> follows an install from the request to the scan after it');
  await show(page, '[data-testid="patch-after-install"]', { hold: 2600, pad: 3 });
  await show(page, '[data-testid="patch-after-install"] [data-testid="task-steps"]', { hold: 2600 });
  await say(page, 'One row per update, with Windows\' own error code and what it means');
  await show(page, '[data-testid="patch-after-results"]', { hold: 3800, pad: 3 });
  await say(page, 'Windows wants a restart: <b>Schedule restart</b> warns the signed-in user first, and never interrupts a session');
  await show(page, '[data-testid="patch-schedule-restart"]', { hold: 3400 });
  await say(page, '<b>Scan now</b>, or let the scan two minutes after the restart refresh the list');
  await show(page, '[data-testid="patch-after-scan"]', { hold: 2600 });
  await say(page, 'Updates that install put on the computer wait for the restart instead of being offered again');
  await show(page, '[data-testid="patch-installed-waiting"]', { hold: 3200 });
  await say(page, 'Tick the update that failed to try it again');
  await press(page, 'label:has-text("KB5070112") input[type="checkbox"]', { hold: 700 });
  await say(page, '<b>Install now</b>, or <b>Schedule</b> it: a date, a time and a time zone, up to 14 days ahead');
  await press(page, '[data-testid="schedule-later"]', { hold: 900 });
  await show(page, '[data-testid="schedule-at"]', { hold: 1800 });
  await show(page, '[data-testid="schedule-tz"]', { hold: 1800 });
  await say(page, 'Or start at the next opening of this computer\'s <b>patch policy window</b>');
  await press(page, '[data-testid="schedule-use-policy-window"]', { hold: 1100 });
  await wait(page, 1200);
  await show(page, '[data-testid="schedule-choice"]', { hold: 3600, pad: 3 });
  await say(page, 'Nothing is handed to the computer before then, and until it starts it can be canceled');
  await show(page, '[data-testid="patch-install-go"]', { hold: 3000 });
  await page.locator('[data-testid="schedule-now"]').check().catch(() => {});
  await page.locator('label:has-text("KB5070112") input[type="checkbox"]').uncheck().catch(() => {});
  await say(page, 'Each computer\'s <b>Patch policy</b>: Inherit the company-wide policy, Exclude, or use another policy');
  await show(page, '[data-testid="patch-policy-setting"]', { hold: 3000, pad: 3 });
  await say(page, 'It says when the policy\'s window next opens');
  await show(page, '[data-testid="policy-next-window"]', { hold: 3000 });
  await pick(page, '[data-testid="patch-policy-setting"] select', 'Exclude — no automatic patching', 1000);
  await say(page, 'Exclude stops automatic patching at once; Install updates on this tab still works');
  await wait(page, 3000);
  await unring(page);
  await page.locator('[data-testid="patch-policy-setting"] select').selectOption('inherit').catch(() => {});
  await wait(page, 900);

  await tab(page, 'monitoring');
  await say(page, '<b>Monitoring</b>: this computer\'s alerts, and which monitors apply to it');
  await wait(page, 3400);
  await tab(page, 'actions');
  await say(page, '<b>Actions</b>: approved maintenance, like starting the Print Spooler, with its current state');
  await show(page, '[data-testid="action-service-state"]', { hold: 3400 });
  await tab(page, 'diagnostics');
  await say(page, '<b>Diagnostics</b>: a fixed catalog of read-only checks, run on the computer');
  await wait(page, 3400);

  await tab(page, 'chat');
  await say(page, '<b>Chat</b> with the person at the computer, in the tray on their screen');
  await page.waitForSelector('[data-testid="chat-transcript"]', { timeout: 15000 }).catch(() => {});
  await wait(page, 1200);
  await say(page, 'Pictures and files go both ways; a picture is shown only if its bytes really are one');
  await show(page, '[data-testid="chat-attachment-image"]', { hold: 3200 });
  await say(page, 'A built-in emoji picker');
  await press(page, '[data-testid="chat-emoji-open"]', { hold: 800 });
  await wait(page, 1200);
  await press(page, '[data-testid="chat-emoji-panel"] button >> nth=0', { hold: 600 });
  await type(page, '[data-testid="chat-input"]', ' Thanks, I can see the error. Restarting the spooler now.', 30);
  await press(page, '[data-testid="chat-send"]', { hold: 600 });
  await wait(page, 2200);
  await say(page, 'Unread replies from every computer collect in the header\'s chat inbox');
  await press(page, '[data-testid="chat-inbox-trigger"]', { hold: 900 });
  await wait(page, 3000);
  await page.keyboard.press('Escape');
  await tab(page, 'history');
  await say(page, '<b>History</b>: sessions, changes and actions on this computer, newest first');
  await wait(page, 3400);
  await top(page);

  // Tasks (0.52)
  await chapter(page, 'Tasks');
  await say(page, 'The number in the top bar is <b>your tasks in progress</b>, on every page');
  await show(page, '[data-testid="task-watcher"]', { hold: 3000 });
  await press(page, '[data-testid="task-watcher"]', { hold: 300 });
  await page.waitForSelector('[data-testid="tasks-list"]', { timeout: 15000 }).catch(() => {});
  await ui(page); await wait(page, 1000);
  await say(page, '<b>Automation → Tasks</b>: every task on every computer you can see');
  await pick(page, '#tasks-state', 'All (last 14 days)', 900);
  await show(page, '[data-testid="tasks-list"]', { hold: 2800, pad: 2 });
  await say(page, 'Queued for the next check-in, handed out, scheduled, held, or done');
  await show(page, '[data-testid="task-row"][data-state="handed_out"] >> nth=0', { hold: 3200, pad: 3 });
  await say(page, '<b>Overdue</b> when it takes longer than its kind usually does, with what that usually means');
  await show(page, '[data-testid="task-row"][data-overdue] >> nth=0', { hold: 3600, pad: 3 });
  await say(page, 'A scheduled install, held until its time; it can be canceled until then');
  await show(page, '[data-testid="task-row"][data-state="scheduled"]', { hold: 3400, pad: 3 });
  await say(page, 'Filter by state and by type');
  await pick(page, '#tasks-type', 'Update install', 900);
  await wait(page, 1800);
  await say(page, 'Now the gatehouse install answers. A task you started finishing shows a <b>toast</b>, wherever you are');
  if (await finishTask()) {
    await page.waitForSelector('[data-testid="task-toast"]', { timeout: 30000 }).catch(() => misses.push('task toast'));
    await ui(page);
    await show(page, 'li[role="status"]:has([data-testid="task-toast"]), [data-testid="task-toast"]', { hold: 4200, pad: 6 });
  }
  await say(page, 'Done, with each update\'s result');
  await show(page, '[data-testid="task-row"][data-state="succeeded"] >> nth=0', { hold: 3200, pad: 3 });
  await clear(page);

  // Connect
  await chapter(page, 'Connect');
  await go(page, `/endpoints/${ids.dispatch}`, 2000);
  await say(page, '<b>Connect</b> opens RustDesk on your computer, configured for this server');
  await press(page, '[data-testid="action-connect"]', { hold: 1000 });
  await wait(page, 1500);
  await say(page, 'It releases the computer\'s password, so it asks you to confirm it is you first');
  await show(page, '[role="dialog"]', { hold: 3600, ringIt: false });
  await cancelDialog(page);
  await clear(page);

  // Reinstall link
  await chapter(page, 'Reinstall link');
  await go(page, `/endpoints/${ids.warehouse2}`, 2200);
  await say(page, 'A computer that has gone quiet says so under its buttons, with a link to reinstall its agent');
  await show(page, '[data-testid="header-reinstall-hint"]', { hold: 3800 });
  await say(page, 'The same is under <b>More → Reinstall manually (download link)</b>');
  await press(page, 'button:has-text("More")', { hold: 700 });
  await show(page, '[data-testid="action-reinstall-link"]', { hold: 2200 });
  await press(page, '[data-testid="action-reinstall-link"]', { hold: 300 });
  await page.waitForSelector('[data-testid="reinstall-banner"]', { timeout: 15000 }).catch(() => {});
  await ui(page); await wait(page, 1000);
  await say(page, 'The link re-attaches to the same record: history, site and settings kept, no duplicate');
  await show(page, '[data-testid="reinstall-banner"]', { hold: 4200 });
  await clear(page);

  // Add device
  await chapter(page, 'Add device');
  await go(page, '/endpoints/enroll', 1800);
  await say(page, '<b>Add device</b>: choose where the computer lands, and who may connect to it');
  await pick(page, '#ad-business', 'Harbor Logistics');
  await pick(page, '#ad-site', 'Tacoma warehouse');
  await show(page, 'input[name="ad-access"] >> nth=1', { hold: 800 });
  await page.check('input[name="ad-access"] >> nth=1').catch(() => {});
  await say(page, 'The business is fixed into the link; the computer that runs it cannot choose another');
  await press(page, '[data-testid="place-next"]', { hold: 800 });
  await wait(page, 1200);
  await press(page, 'input[name="ad-os"] >> nth=0', { hold: 700 });
  await say(page, 'Then pick the operating system and make a one-time install link', 3600);
  await clear(page); await unring(page);

  // Dark theme for the middle of the tour
  await say(page, 'Light and dark themes ship with the product');
  await press(page, 'button[title*="click to switch to"]', { hold: 900 });
  await wait(page, 2400);

  // Patching
  await chapter(page, 'Patching');
  await go(page, '/patching', 1800);
  await say(page, '<b>Patching</b>: Windows updates a canary first, then rings, inside a maintenance window');
  await pick(page, 'main select >> nth=0', 'Harbor Logistics');
  await wait(page, 1200);
  await say(page, 'The pre-flight reads what signed patching needs and says what is missing');
  await show(page, '[data-testid="patching-preflight"]', { hold: 3600, pad: 3 });
  await say(page, 'A <b>company-wide policy</b> covers every computer set to Inherit');
  await show(page, '[data-testid="company-policies"] div.rounded-md:has(strong:has-text("Tuesday night")) >> nth=-1', { hold: 3400, pad: 2 });
  await say(page, 'The portal builds the rings: a canary that checks in reliably, then rings of at most 25');
  await show(page, 'text=Next revision would name 3', { hold: 3600 });
  await say(page, 'A computer that cannot be patched is listed with the reason');
  await press(page, '[data-testid="company-policies"] summary:has-text("Left out")', { hold: 700 });
  await wait(page, 3200);
  await say(page, 'When computers join or leave, a new revision is proposed and signed like any policy');
  await show(page, '[data-testid="company-policies"] div.rounded-md:has(strong:has-text("Tuesday night")) >> nth=-1 >> li:has-text("Revision 1")', { hold: 3200 });
  await say(page, 'An <b>assignable policy</b> covers only the computers set to use it: here the depots, monthly');
  await show(page, '[data-testid="company-policies"] div.rounded-md:has(strong:has-text("Thursday after Patch Tuesday")) >> nth=-1', { hold: 3800, pad: 2 });
  await say(page, 'Two days after Patch Tuesday, and it says when its window next opens');
  await show(page, '[data-testid="company-policies"] div.rounded-md:has(strong:has-text("Thursday after Patch Tuesday")) >> nth=-1 >> [data-testid="series-next-window"]', { hold: 3400 });
  await say(page, 'Every computer\'s setting in one place: Inherit, Exclude or Use policy');
  await press(page, '[data-testid="company-policies"] summary:has-text("Each computer")', { hold: 700 });
  await wait(page, 3800);
  await say(page, 'A new policy chooses its classes, window, soak between rings, restart rule and canary');
  await press(page, 'button:has-text("Assignable policy")', { hold: 800 });
  await wait(page, 1200);
  await show(page, '#ser-canary', { hold: 3000 });
  await press(page, 'button:text-is("Cancel")', { hold: 600 });
  await clear(page);

  // Monthly windows (0.53)
  await chapter(page, 'Monthly windows');
  await say(page, 'A policy\'s maintenance window is <b>weekly</b> or <b>monthly</b>');
  await press(page, 'button:has-text("New policy")', { hold: 800 });
  await page.waitForSelector('[data-testid="pol-window"]', { timeout: 10000 }).catch(() => {});
  await show(page, '[data-testid="pol-window"]', { hold: 1800, pad: 3 });
  await press(page, '[data-testid="pol-monthly"]', { hold: 900 });
  await say(page, 'The nth or last weekday of the month, plus up to 14 days: second Tuesday + 2 is the Thursday after Patch Tuesday');
  await show(page, '[data-testid="pol-week"]', { hold: 1600 });
  await show(page, '[data-testid="pol-offset"]', { hold: 600 });
  await page.locator('[data-testid="pol-offset"]').fill('2').catch(() => {});
  await page.locator('input[type="number"][max="90"]').fill('90').catch(() => {});
  await wait(page, 1500);
  await say(page, 'Its next three openings come from the server, worked out exactly as the approval signer checks them');
  await show(page, '[data-testid="pol-preview"]', { hold: 4600, pad: 3 });
  await say(page, 'Or a day of the month, 1 to 28, so it opens every month, February included');
  await press(page, '[data-testid="pol-monthly-day"]', { hold: 900 });
  await show(page, '[data-testid="pol-preview"]', { hold: 3600, pad: 3 });
  await press(page, 'button:text-is("Cancel")', { hold: 600 });
  await clear(page);

  // Scheduled rings (0.52)
  await chapter(page, 'Scheduled installs');
  await go(page, `/patching/${ids.depotsDeployment}`, 2200);
  await say(page, 'A deployment\'s next ring can start now or at a time too');
  await type(page, '#ring-reason', 'Defender and MSRT for both depots, after the morning scan run', 18);
  await press(page, '[data-testid="schedule-later"]', { hold: 900 });
  await show(page, '[data-testid="schedule-choice"]', { hold: 3600, pad: 3 });
  await say(page, 'The time becomes the signed plan\'s start, and the agent refuses it early. Not sent in this demo');
  await show(page, 'button:has-text("Schedule canary")', { hold: 3200 });
  await go(page, `/patching/${ids.dispatch02Deployment}`, 2200);
  await say(page, 'A scheduled ring shows when it starts, and can be canceled until then');
  await show(page, '[data-testid="ring-scheduled"]', { hold: 3600 });
  await say(page, 'The <b>patch compliance</b> report, by business and by computer');
  await chapter(page, 'Patching');
  await go(page, '/reports/patch-compliance', 2500);
  await wait(page, 3600);
  await clear(page);

  // Software catalog
  await chapter(page, 'Software catalog');
  await go(page, '/automation/software', 2000);
  await say(page, 'The <b>software catalog</b>: approved packages with the installer\'s hash pinned');
  await wait(page, 3000);
  await say(page, 'Browse the winget community index and add packages by selection');
  await show(page, '[data-testid="winget-catalog"]', { hold: 1600, pad: 2 });
  for (const n of ['7-Zip', 'Mozilla Firefox', 'Notepad++']) await press(page, `input[aria-label="Select ${n}"]`, { hold: 450 });
  await show(page, '[data-testid="winget-catalog"] button:has-text("Add")', { hold: 3200 });
  await clear(page); await unring(page);

  // Scripts
  await chapter(page, 'Scripts');
  await go(page, '/automation/scripts', 2000);
  await say(page, 'The <b>script library</b>: versioned PowerShell, reviewed before it can run anywhere');
  await wait(page, 3000);
  await press(page, 'a:has-text("Clear stuck print queue")', { hold: 700 });
  await ui(page); await wait(page, 1500);
  await say(page, 'Each version shows its content hash and static checks, and needs approving');
  await show(page, 'text=Static checks', { hold: 3600 });
  await clear(page);

  // Monitoring and alerts
  await chapter(page, 'Monitoring and alerts');
  await go(page, '/alerts', 2000);
  await say(page, '<b>Alerts</b> from every monitor, grouped and filtered');
  await wait(page, 2800);
  await press(page, 'button:has-text("Tacoma warehouse")', { hold: 700 });
  await say(page, 'An outage lists the computers in it; acknowledge or resolve it with a note');
  await wait(page, 3600);
  await go(page, '/settings/monitoring', 1500);
  await say(page, 'Monitors are set globally, per business, site, group or computer, the most specific winning');
  await pick(page, '#mon-business', 'Harbor Logistics');
  await wait(page, 3400);
  await clear(page);

  // Reports
  await chapter(page, 'Reports');
  await go(page, '/reports', 2000);
  await say(page, '<b>Reports</b>: patch status, offline time, alerts, agent coverage and software');
  await wait(page, 3400);
  await go(page, '/reports/offline-time', 2000);
  await say(page, 'Each one can be exported as CSV, or emailed on a schedule');
  await wait(page, 3400);
  await clear(page);

  // Businesses
  await chapter(page, 'Businesses');
  await go(page, '/businesses', 1800);
  await say(page, '<b>Businesses</b>: each customer owns its computers, people, sites and history');
  await wait(page, 3000);
  await go(page, `/businesses/${ids.harbor}`, 2000);
  await say(page, 'Automatic agent updates <b>per business</b>: Inherit, On, Off or in its maintenance window');
  await show(page, '[data-testid="business-agent-auto-update-select"]', { hold: 3800 });
  await clear(page);

  // Settings
  await chapter(page, 'Settings');
  await go(page, '/settings?tab=confirm', 2200);
  await say(page, '<b>Confirm it is you</b>: choose, function by function, which changes ask again after sign-in');
  await show(page, '[data-testid="confirm-policy"] > div:first-child', { hold: 3200, pad: 2 });
  await say(page, 'Here the everyday changes are set to Don\'t ask; install links and security changes still ask');
  await show(page, '[data-testid="confirm-group-Patching & updates"]', { hold: 3200, pad: 2 });
  await show(page, '[data-testid="confirm-group-Devices & enrolment"]', { hold: 2600, pad: 2 });
  await say(page, 'Some always ask: your password, authenticator and passkeys, and turning a confirmation off');
  await show(page, '[data-testid="confirm-always-ask"]', { hold: 3400 });
  await go(page, '/settings/ai', 1800);
  await say(page, '<b>AI</b>: your own provider and key. This demo answers from a local stand-in, with a fake key');
  await wait(page, 3800);
  await go(page, '/settings/psa', 1800);
  await say(page, '<b>PSA / ticketing</b>: a connector per business or for the whole platform');
  await wait(page, 3600);
  await go(page, '/settings/email', 1800);
  await say(page, '<b>Email</b>: your SMTP relay for alerts and scheduled reports, to confirmed recipients only');
  await wait(page, 3600);
  await go(page, '/admin/access', 2000);
  await say(page, '<b>Access control</b>: Platform Admin, Business Owner and Business User');
  await wait(page, 3000);
  await press(page, 'button:has-text("Business Users")', { hold: 700 });
  await say(page, 'Each user holds exactly the capabilities granted to them');
  await wait(page, 3200);
  await go(page, '/users', 1800);
  await say(page, '<b>Users</b>: invitations, roles, MFA status and offboarding');
  await wait(page, 3200);
  await go(page, '/admin/security', 2200);
  await say(page, '<b>Security</b>: what protects the server, read from the server itself');
  await wait(page, 3600);
  await clear(page);

  // Audit
  await chapter(page, 'Audit log');
  await go(page, '/audit', 2200);
  await say(page, 'Every change is in the <b>audit log</b>, in a hash chain that shows any deletion');
  await wait(page, 4200);
  await clear(page);

  // Docs and help
  await chapter(page, 'Docs and help');
  await go(page, '/docs', 2000);
  await say(page, 'The full documentation is built into the app, with search');
  await type(page, '[data-testid="docs-search"]', 'patch policy', 70);
  await wait(page, 3000);
  // Reached by its link, not loaded: the page is server-rendered, and the
  // masks rewriting its text (the menu example names a host) before React
  // hydrates it makes the page fail to load.
  await go(page, '/docs', 1200);
  await press(page, 'main a[href="/docs/tray"] >> nth=0', { hold: 600 });
  await wait(page, 2000);
  await say(page, 'The <b>tray</b> runs on Windows. These are its generated icons; its menu has not been photographed on Windows');
  await show(page, 'main img[src*="tray-icons"] >> nth=0', { hold: 4800, pad: 3 });
  await say(page, 'Its menu opens with the business and its IT provider, and offers a support request only when a PSA is set up');
  await show(page, 'main pre >> nth=0', { hold: 4400, pad: 3 });
  await go(page, '/help', 2000);
  await say(page, '<b>Help</b>: short answers for technicians, in the app');
  await wait(page, 3400);
  await clear(page);

  // Back to light, end card
  await press(page, 'button[title*="click to switch to"]', { hold: 700 });
  await go(page, '/dashboard', 2500);
  await chapter(page, 'Rem0te');
  await say(page, 'Self-hosted. Open source. <b>No RustDesk Pro required.</b>', 4200);
  await clear(page); await wait(page, 500);
  await card(page, 'Rem0te', 'Self-hosted remote support and management, built on RustDesk.\nInstall guide, docs and source on GitHub.', 'github.com/agit8or1/rem0te  ·  mspreboot.com', 6000);
}

/** The ~55 s highlight: the same app, fewer stops. */
async function highlight(page, ids) {
  await page.goto(`${WEB}/login`, { waitUntil: 'networkidle' });
  await card(page, 'Rem0te', 'Self-hosted remote support and management, built on RustDesk.', 'v0.53 in under 90 seconds', 3000);
  await uncard(page);
  await page.fill('input[type="email"]', process.env.EMAIL);
  await page.fill('input[type="password"]', process.env.PASSWORD);
  await page.click('button[type="submit"]');
  await page.waitForURL((u) => !u.pathname.includes('/login'), { timeout: 30000 });
  await ids.resolve();
  await go(page, '/dashboard', 1800);
  await chapter(page, 'Dashboard');
  await say(page, 'What needs attention now, across every customer business (demo data, simulated agent)');
  await show(page, 'text=Work on next', { hold: 3000 });
  await chapter(page, 'Devices');
  await go(page, '/endpoints', 1400);
  await say(page, 'Every computer, with health, agent and pending patches, and bulk actions');
  await press(page, 'input[aria-label="Select HARB-DISPATCH-01"]', { hold: 300 });
  await show(page, '[aria-label="Bulk actions"]', { hold: 1600 });
  await chapter(page, 'A computer');
  await go(page, `/endpoints/${ids.dispatch}?tab=patches`, 1600);
  await say(page, 'Follow an install to its result, then <b>schedule the restart</b> Windows asks for');
  await show(page, '[data-testid="patch-restart-banner"]', { hold: 2600, pad: 3 });
  await say(page, 'Install now or <b>schedule</b> it, even for the patch policy\'s next window');
  await press(page, '[data-testid="schedule-use-policy-window"]', { hold: 700 });
  await show(page, '[data-testid="schedule-choice"]', { hold: 2400, pad: 3 });
  await tab(page, 'events');
  await say(page, '<b>Ask AI</b> about an event, or turn it into a ticket');
  await show(page, 'button:has-text("Ask AI")', { hold: 2200 });
  await tab(page, 'chat');
  await say(page, '<b>Chat</b> with the person at the computer, with pictures and files');
  await page.waitForSelector('[data-testid="chat-transcript"]', { timeout: 15000 }).catch(() => {});
  await show(page, '[data-testid="chat-attachment-image"]', { hold: 2600 });
  await chapter(page, 'Tasks');
  await go(page, '/automation/tasks', 1400);
  await say(page, '<b>Tasks</b>: where everything sent to a computer is, across every customer');
  await show(page, '[data-testid="task-row"][data-overdue] >> nth=0', { hold: 2600, pad: 3 });
  await chapter(page, 'Patching');
  await go(page, '/patching', 1200);
  await pick(page, 'main select >> nth=0', 'Harbor Logistics', 400);
  await say(page, '<b>Monthly</b> patch windows: two days after Patch Tuesday');
  await show(page, '[data-testid="company-policies"] div.rounded-md:has(strong:has-text("Thursday after Patch Tuesday")) >> nth=-1', { hold: 2600, pad: 2 });
  await say(page, 'A <b>company-wide patch policy</b>: canary first, then rings, revised as computers change');
  await show(page, '[data-testid="company-policies"] div.rounded-md:has(strong:has-text("Tuesday night")) >> nth=-1', { hold: 3600, pad: 2 });
  await chapter(page, 'Settings');
  await go(page, '/settings?tab=confirm', 1600);
  await say(page, '<b>Confirm it is you</b>, chosen function by function');
  await show(page, '[data-testid="confirm-group-Patching & updates"]', { hold: 3000, pad: 2 });
  await clear(page);
  await card(page, 'Rem0te', 'Self-hosted. Open source. No RustDesk Pro required.', 'github.com/agit8or1/rem0te  ·  mspreboot.com', 3800);
}

async function main() {
  await mkdir(OUT, { recursive: true });
  for (const f of await readdir(OUT)) if (/^(page@)?[0-9a-f]{32}\.webm$/.test(f)) await rm(path.join(OUT, f));
  const browser = await chromium.launch();
  const ctx = await browser.newContext({
    viewport: SIZE, deviceScaleFactor: 1, colorScheme: 'light', timezoneId: 'America/Los_Angeles',
    recordVideo: { dir: OUT, size: SIZE },
  });
  // Start in light; the app's own switch changes it mid-walkthrough, and
  // this runs on every navigation, so it only seeds an empty store.
  await ctx.addInitScript(() => {
    try { if (!localStorage.getItem('theme')) localStorage.setItem('theme', 'light'); } catch { /* */ }
  });
  // Masking before paint: every text node the page adds or changes is
  // checked against MASKS in the same task, before the frame is drawn.
  await ctx.addInitScript((masks) => {
    const rx = masks.map((m) => [new RegExp(m.source, m.flags), m.to]);
    const fix = (n) => {
      const o = n.nodeValue; if (!o) return;
      let t = o; for (const [re, to] of rx) { re.lastIndex = 0; t = t.replace(re, to); }
      if (t !== o) n.nodeValue = t;
    };
    const walk = (root) => {
      if (root.nodeType === 3) { fix(root); return; }
      if (root.nodeType !== 1) return;
      const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      for (let n = w.nextNode(); n; n = w.nextNode()) fix(n);
    };
    new MutationObserver((ms) => {
      for (const m of ms) { if (m.type === 'characterData') fix(m.target); else m.addedNodes.forEach(walk); }
    }).observe(document, { subtree: true, childList: true, characterData: true });
    setInterval(() => {
      for (const el of document.querySelectorAll('input,textarea')) {
        if (el === document.activeElement) continue;
        let v = el.value; if (!v) continue;
        for (const [re, to] of rx) { re.lastIndex = 0; v = v.replace(re, to); }
        if (v !== el.value) el.value = v;
      }
    }, 250);
    document.addEventListener('DOMContentLoaded', () => {
      const s = document.createElement('style');
      s.textContent = '[data-secret],[data-sensitive],canvas[aria-label*="QR" i]{filter:none!important;background:#334155!important;color:transparent!important}';
      document.head.appendChild(s);
      walk(document.body);
    });
  }, MASKS.map((m) => ({ source: m.match.source, flags: m.match.flags, to: m.to })));

  const page = await ctx.newPage();
  T0 = Date.now();
  // Ids for the routes below, read as the browser reads them once signed in.
  const ids = {};
  ids.resolve = async () => {
    ids.dispatch = await endpointId(page, 'HARB-DISPATCH-01');
    ids.warehouse2 = await endpointId(page, 'HARB-WAREHOUSE-2');
    ids.harbor = await businessId(page, 'Harbor Logistics');
    ids.depotsDeployment = await deploymentId(page, ids.harbor, 'Defender and MSRT — depots');
    ids.dispatch02Deployment = await deploymentId(page, ids.harbor, 'Install on harb-dispatch-02');
  };

  try {
    if (CUT === 'highlight') await highlight(page, ids); else await walkthrough(page, ids);
  } finally {
    const end = now();
    for (const e of events) if (e.end == null) e.end = end;
    await page.close(); await ctx.close(); await browser.close();
    const files = (await readdir(OUT)).filter((f) => /^(page@)?[0-9a-f]{32}\.webm$/.test(f));
    if (files.length) await rename(path.join(OUT, files[0]), path.join(OUT, `${CUT}.webm`));
    await writeFile(path.join(OUT, `${CUT}.captions.json`), JSON.stringify({ duration: end, events, misses }, null, 2));
    console.log(`recorded -> ${path.join(OUT, `${CUT}.webm`)} (${end}s, ${events.filter((e) => e.kind === 'caption').length} captions)`);
    if (misses.length) console.log(`! ${misses.length} target(s) not found:\n  ${misses.join('\n  ')}`);
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
