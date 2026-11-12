#!/usr/bin/env node
/**
 * The tray (0.36): the rules in src/tray/tray-policy.ts and the tray side of
 * src/chat/chat-policy.ts — one-time codes and the /assist cookie, the page's
 * CSP, tray keys, whether a chat is recorded, the self-help catalog (and that
 * it equals the agent's and the migration's), result text, screenshots and
 * the usage sample, branding, and which computers can chat through the tray.
 * Pure: no database, no API. Needs a built dist (`npx nest build`).
 *
 *   node scripts/unit-tray.mjs
 */
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const dist = path.join(here, '..', 'dist');
const T = require(path.join(dist, 'tray/tray-policy.js'));
const C = require(path.join(dist, 'chat/chat-policy.js'));
const P = require(path.join(dist, 'tray/assist-page.js'));

let pass = 0, fail = 0; const failures = [];
const check = (c, m, d = '') => { if (c) { pass++; console.log(`  \x1b[32m✓\x1b[0m ${m}`); } else { fail++; failures.push(m); console.log(`  \x1b[31m✗\x1b[0m ${m}${d ? `\n      ${d}` : ''}`); } };
const section = (t) => console.log(`\n\x1b[1m${t}\x1b[0m`);

section('One-time codes and the /assist cookie');
const code = T.newSecret();
check(T.isCode(code) && code.length === 43, 'a code is 32 random bytes, base64url (43 characters)', code);
check(T.newSecret() !== code, 'two codes differ');
check(!T.isCode('short') && !T.isCode(code + 'x') && !T.isCode(code.slice(0, 42) + '/') && !T.isCode(null), 'anything else is not a code');
check(T.CODE_TTL_MS === 60_000 && T.SESSION_TTL_MS === 7_200_000, 'a code lives 60 s, a session at most 2 h');
const ck = T.assistCookie(code);
check(/^rem0te_assist=[A-Za-z0-9_-]{43}; Path=\/assist; Max-Age=7200; HttpOnly; Secure; SameSite=Strict$/.test(ck), 'the cookie: Path=/assist, HttpOnly, Secure, SameSite=Strict, 2 h', ck);
check(/Max-Age=0/.test(T.clearAssistCookie()) && /Path=\/assist/.test(T.clearAssistCookie()), 'clearing it uses the same path');
check(T.readAssistCookie(`access_token=abc; rem0te_assist=${code}; other=1`) === code, 'read back from a Cookie header among others');
check(T.readAssistCookie(`rem0te_assist=${code}x`) === null && T.readAssistCookie('rem0te_assist=') === null && T.readAssistCookie(undefined) === null, 'a malformed or missing cookie is no session');
check(T.readAssistCookie(`access_token=${code}`) === null, 'a portal session cookie is not an /assist session');
check(T.sha256('x').length === 64, 'only a hash is stored (sha256 hex)');

section('The page\'s Content-Security-Policy');
const csp = T.ASSIST_CSP;
for (const d of ["default-src 'none'", "script-src 'self'", "style-src 'self'", "connect-src 'self'", "base-uri 'none'", "form-action 'none'", "frame-ancestors 'none'"]) {
  check(csp.includes(d), `CSP has ${d}`);
}
check(!/unsafe-inline|unsafe-eval|https:|data:|\*/.test(csp), 'no unsafe-inline, unsafe-eval, wildcard, data: or https: source', csp);
check(!/<script(?![^>]*\bsrc=)/i.test(P.ASSIST_HTML) && !/\son[a-z]+=/i.test(P.ASSIST_HTML) && !/style=/i.test(P.ASSIST_HTML), 'the page has no inline script, no inline handler and no inline style');
check(/src="assist\.js"/.test(P.ASSIST_HTML) && /href="assist\.css"/.test(P.ASSIST_HTML), 'it loads its script and stylesheet by relative URL (works behind /assist and on the API alike)');
check(!/innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval\(|new Function/.test(P.ASSIST_JS), 'the script never builds HTML from strings or evaluates code');
check(/textContent/.test(P.ASSIST_JS) && !/createElement\(['"]a['"]\)/.test(P.ASSIST_JS) && !/href\s*=/.test(P.ASSIST_JS), 'messages are rendered as text and never made into links');
check(/'x-assist': '1'/.test(P.ASSIST_JS), 'every write from the page carries x-assist: 1');
check(!/localStorage|sessionStorage|indexedDB|document\.cookie/.test(P.ASSIST_JS), 'the page keeps nothing in browser storage and cannot read its cookie');

section('Tray keys');
const k = T.newTrayKey();
check(/^tk_[a-z0-9]{24}\.[A-Za-z0-9_-]{43}$/.test(k.token) && k.hash === T.sha256(k.secret), 'tk_<24 hex>.<43 base64url>; the hash is of the secret part', k.token);
check(JSON.stringify(T.parseTrayKey(k.token)) === JSON.stringify({ keyId: k.keyId, secret: k.secret }), 'parsed back into id and secret');
check(T.parseTrayKey(k.token + 'x') === null && T.parseTrayKey('tk_ABC.x') === null && T.parseTrayKey(k.secret) === null, 'malformed keys are refused');
check(T.hashMatches(k.hash, k.secret) && !T.hashMatches(k.hash, T.newSecret()) && !T.hashMatches(null, k.secret) && !T.hashMatches('zz', k.secret), 'constant-time match of the secret with the stored hash');

section('Recorded or not');
check(T.chatRecorded(true, false) === true && T.chatRecorded(false, true) === false, 'the business\'s choice wins over the platform default');
check(T.chatRecorded(null, true) === true && T.chatRecorded(null, false) === false && T.chatRecorded(undefined, undefined) === true, 'no business choice: the platform default, itself on unless turned off');

section('Self-help catalog');
check(JSON.stringify(T.SELF_HELP_IDS) === JSON.stringify(['dns.check', 'dns.flush', 'ip.renew', 'net.test', 'net.details', 'rustdesk.restart']), 'exactly six tools, in order', JSON.stringify(T.SELF_HELP_IDS));
check(T.SELF_HELP.filter((t) => t.elevated).map((t) => t.id).join() === 'dns.flush,ip.renew,rustdesk.restart', 'three elevated: flush, renew, RustDesk restart');
check(T.SELF_HELP.every((t) => !t.elevated || t.blockedBy.includes('actions')), 'every elevated tool is stopped by an actions pause');
check(T.selfHelpTool('rustdesk.restart').blockedBy.includes('remote') && T.SELF_HELP.filter((t) => t.blockedBy.includes('remote')).length === 1, 'only the RustDesk restart is also stopped by a remote pause');
check(T.SELF_HELP.filter((t) => !t.elevated).every((t) => t.blockedBy.length === 0), 'read-only tools are not stopped by containment');
check(T.toolsFor('tray_key').every((t) => !t.elevated) && T.toolsFor('tray_key').length === 3 && T.toolsFor('signed').length === 6, 'a tray key gets the three read-only tools; the signed agent all six');
check(T.selfHelpTool('cmd.exe') === null && T.selfHelpTool('__proto__') === null && T.selfHelpTool(undefined) === null, 'an unknown id is no tool');
check(T.SELF_HELP_PER_HOUR === 30 && T.selfHelpTool('ip.renew').perWindow === 2 && T.selfHelpTool('ip.renew').windowMs === 900_000, 'rates: 30 an hour in all; renew twice per 15 minutes');
const goCat = fs.readFileSync(path.join(here, '..', '..', '..', 'tools', 'windows-installer', 'internal', 'tray', 'catalog.go'), 'utf8');
const goIds = [...goCat.matchAll(/\{ID: "([a-z.]+)", Title: "([^"]+)", Elevated: (true|false), PerWindow: (\d+), Window: (\d+) \* time\.Minute(?:, BlockedBy: \[\]string\{([^}]*)\})?\}/g)]
  .map((m) => ({ id: m[1], title: m[2], elevated: m[3] === 'true', perWindow: +m[4], windowMs: +m[5] * 60_000, blockedBy: (m[6] ?? '').split(',').map((s) => s.trim().replace(/"/g, '')).filter(Boolean) }));
check(JSON.stringify(goIds) === JSON.stringify(T.SELF_HELP.map((t) => ({ id: t.id, title: t.title, elevated: t.elevated, perWindow: t.perWindow, windowMs: t.windowMs, blockedBy: t.blockedBy }))), 'the agent\'s catalog (internal/tray/catalog.go) is the same list', JSON.stringify(goIds));
const sql = fs.readFileSync(path.join(here, '..', 'prisma', 'migrations', '0062_tray', 'migration.sql'), 'utf8');
check(sql.includes(`"tool" IN (${T.SELF_HELP_IDS.map((i) => `'${i}'`).join(', ')})`), 'and so is the database CHECK (migration 0062)');

section('Result text from the agent');
check(T.summaryLine('ok\r\nnext\u202eline\u0007') === 'ok next line', 'one inert line: controls, bidi and line breaks become spaces');
check(T.summaryLine('x'.repeat(400)).length === 300 && T.summaryLine('   ') === null && T.summaryLine(5) === null, 'at most 300 characters; empty is nothing');
const lines = T.detailLines(Array.from({ length: 50 }, (_, i) => `l${i}\u0000${'y'.repeat(300)}`));
check(lines.length === 40 && lines.every((l) => l.length <= 200 && !l.includes('\u0000')), 'detail: at most 40 lines of 200 characters, inert');
check(T.detailLines('not a list').length === 0 && T.detailLines([{ a: 1 }]).length === 0, 'anything but a list of strings is dropped');

section('Screenshots');
const png = (w, h) => {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); return Buffer.concat([len, Buffer.from(type), data, Buffer.alloc(4)]); };
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(Buffer.alloc(10))), chunk('IEND', Buffer.alloc(0))]);
};
const jpeg = (w, h) => Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0, 0xff, 0xc0, 0, 17, 8, h >> 8, h & 255, w >> 8, w & 255, 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1, 0xff, 0xd9]);
let s = T.screenshot(png(1600, 900).toString('base64'));
check(s.ok && s.contentType === 'image/png' && s.width === 1600 && s.height === 900, 'a PNG: type and size from its header', JSON.stringify({ ...s, bytes: undefined }));
s = T.screenshot(jpeg(1280, 720).toString('base64'));
check(s.ok && s.contentType === 'image/jpeg' && s.width === 1280 && s.height === 720, 'a JPEG: type and size from its SOF marker', JSON.stringify({ ...s, bytes: undefined }));
check(!T.screenshot(png(5000, 100).toString('base64')).ok, 'wider than 4096 px: refused');
check(!T.screenshot(Buffer.from('<svg onload=alert(1)>').toString('base64')).ok && !T.screenshot(Buffer.from('GIF89a....').toString('base64')).ok, 'SVG, GIF or anything else: refused, never sniffed');
check(!T.screenshot('not base64!').ok && !T.screenshot(12).ok, 'not base64: refused');
const big = Buffer.concat([jpeg(100, 100), Buffer.alloc(T.SCREENSHOT_MAX_BYTES)]);
check(!T.screenshot(big.toString('base64')).ok && T.SCREENSHOT_MAX_BYTES === 716800, 'over 700 KiB: refused (base64 of the cap fits the 1 MB request limit)');
check(Math.ceil(T.SCREENSHOT_MAX_BYTES / 3) * 4 < 960_000, 'the DTO\'s 960,000-character cap admits a full-size screenshot');

section('Resource usage');
let u = T.usageSample({ cpuPercent: 140, memoryTotalMb: 16000, memoryUsedMb: 8000, topProcesses: [{ name: 'chrome.exe', cpuPercent: 30, memoryMb: 900 }, { name: '<img src=x>', cpuPercent: 1 }, { name: 'C:\\Users\\bob\\x.exe' }] });
check(u && u.cpuPercent === null && u.memoryTotalMb === 16000 && u.topProcesses.length === 1 && u.topProcesses[0].name === 'chrome.exe', 'out-of-range numbers are dropped, not clamped into a lie; only inert image names kept', JSON.stringify(u));
check(T.usageSample({}) === null && T.usageSample('x') === null && T.usageSample([]) === null, 'nothing usable is no sample');
u = T.usageSample({ cpuPercent: 5, sampledAt: '1999-01-01T00:00:00Z' });
check(u && Math.abs(Date.parse(u.sampledAt) - Date.now()) < 5000, 'a sample time far from now is replaced by now');
check(T.usageSample({ cpuPercent: 5, topProcesses: Array.from({ length: 30 }, () => ({ name: 'a.exe' })) }).topProcesses.length === 10, 'at most ten processes');

section('Branding');
check(T.accent('#112233') === '#112233' && T.accent('red') === '#3B82F6' && T.accent('#112233;x') === '#3B82F6', 'the accent is a #RRGGBB colour or the default');
check(T.supportLine({ supportPhone: '555-0100', supportEmail: 'help@example.com' }) === 'Support: 555-0100 · help@example.com' && /Contact your IT provider/.test(T.supportLine(null)), 'the support line comes from branding, or a fixed sentence');

section('Which computers can chat through the tray');
const sup = (o) => C.chatSupport({ platform: 'Windows 11', updateChannel: 'signed', chatProtocol: null, trayProtocol: null, trayPaired: false, agentBound: true, ...o });
let r = sup({ chatProtocol: 2 });
check(r.supported && r.via === 'tray', 'signed agent, chat protocol 2: the tray', JSON.stringify(r));
r = sup({ chatProtocol: 1 });
check(r.supported && r.via === 'window', 'signed agent, chat protocol 1 (0.34): the old window', JSON.stringify(r));
r = sup({ updateChannel: 'legacy', trayProtocol: 1, trayPaired: true });
check(r.supported && r.via === 'tray', 'standard agent with a paired tray: the tray', JSON.stringify(r));
r = sup({ updateChannel: 'legacy', trayProtocol: 1, trayPaired: false });
check(!r.supported && /tray is installed/.test(r.message), 'standard agent whose tray is not paired: not yet, saying why', JSON.stringify(r));
r = sup({ updateChannel: 'legacy' });
check(!r.supported && /standard agent/.test(r.message), 'standard agent without a tray: re-run the installer', JSON.stringify(r));
for (const plat of ['Linux', 'macOS']) {
  r = sup({ platform: plat, chatProtocol: 2, trayProtocol: 1, trayPaired: true });
  check(!r.supported && r.reason === 'platform', `${plat}: not supported, whatever it reports`, JSON.stringify(r));
}
const stale = new Date(Date.now() - 120_000);
let pr = C.presence({ status: 'OPEN', deviceState: 'window_open', deviceSeenAt: stale }, Date.now(), 'tray');
check(pr.code === 'window_closed' && /tray icon/.test(pr.text), 'through the tray, a page that stopped polling is a closed window the person can reopen from the tray icon', JSON.stringify(pr));
pr = C.presence({ status: 'OPEN', deviceState: 'window_open', deviceSeenAt: stale }, Date.now(), 'window');
check(pr.code === 'computer_silent', 'the 0.34 window going quiet is still "the computer is silent"', JSON.stringify(pr));
pr = C.presence({ status: 'ENDED', deviceState: 'window_open', deviceSeenAt: stale, endedReason: 'end_user' }, Date.now(), 'tray');
check(pr.code === 'ended' && /ended the chat/.test(pr.text), 'the person ending it from the page is "ended", not "closed the window"', JSON.stringify(pr));

console.log(`\nunit-tray: ${pass} passed, ${fail} failed`);
if (fail) { for (const f of failures) console.log(`  - ${f}`); process.exit(1); }
