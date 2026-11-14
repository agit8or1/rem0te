#!/usr/bin/env node
/**
 * Chat (0.34): the rules in src/chat/chat-policy.ts — message text, names the
 * device reports, which computers can chat, what the technician is told about
 * the far end, receipts, the retention window and its bounds.
 * Pure: no database, no API. Needs a built dist (`npx nest build`).
 *
 *   node scripts/unit-chat.mjs
 */
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const dist = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'dist');
const C = require(path.join(dist, 'chat/chat-policy.js'));

let pass = 0, fail = 0; const failures = [];
const check = (c, m, d = '') => { if (c) { pass++; console.log(`  \x1b[32m✓\x1b[0m ${m}`); } else { fail++; failures.push(m); console.log(`  \x1b[31m✗\x1b[0m ${m}${d ? `\n      ${d}` : ''}`); } };
const section = (t) => console.log(`\n\x1b[1m${t}\x1b[0m`);
const ch = (n) => String.fromCharCode(n);

section('Message text');
let t = C.chatText('  hello\r\nworld\rnext  ');
check(t.ok && t.text === 'hello\nworld\nnext', 'CRLF and CR become LF; trimmed', JSON.stringify(t));
t = C.chatText(`a${ch(0)}b${ch(7)}c${ch(0x1b)}[31md${ch(0x7f)}e${ch(0x85)}f`);
check(t.ok && t.text === 'abc[31mdef', 'C0, C1, ESC and DEL are dropped (no terminal or console escapes survive)', JSON.stringify(t));
t = C.chatText(`invoice${ch(0x202e)}fdp.exe and ${ch(0x2066)}x${ch(0x2069)} and${ch(0x2028)}sep`);
check(t.ok && t.text === 'invoicefdp.exe and x andsep', 'bidi overrides, isolates and the line/paragraph separators are dropped', JSON.stringify(t));
t = C.chatText('tab\tkept');
check(t.ok && t.text === 'tab\tkept', 'tab is kept');
t = C.chatText(`x${'\n'.repeat(50)}y`);
check(t.ok && t.text === `x${'\n'.repeat(20)}y`, 'at most 20 newlines in a row');
check(C.chatText('<a href="javascript:alert(1)">click</a>').text === '<a href="javascript:alert(1)">click</a>', 'markup is kept verbatim as text: escaping is the renderer\'s job, and nothing here makes a link');
check(C.chatText('x'.repeat(2000)).ok && C.chatText('x'.repeat(2001)).code === 'TOO_LONG', '2,000 characters is the limit; 2,001 is refused, not cut');
check(C.chatText(`${'x'.repeat(1999)}${ch(0)}${ch(0)}`).ok, 'the limit applies after control characters are dropped');
check(C.chatText(' \n\t ').code === 'EMPTY' && C.chatText(`${ch(0)}${ch(0x202e)}`).code === 'EMPTY', 'nothing but whitespace or controls is empty');
check(C.chatText(42).code === 'NOT_TEXT' && C.chatText(null).code === 'NOT_TEXT' && C.chatText({ toString: () => 'x' }).code === 'NOT_TEXT', 'only strings');

section('Names');
check(C.deviceName(`CORP\\alice${ch(7)}\r\nInjected: line`) === 'CORP\\alice Injected: line', 'a reported account name is one line, controls replaced');
check(C.deviceName('a'.repeat(100)).length === 64 && C.deviceName('   ') === null && C.deviceName(5) === null, 'at most 64 characters; empty or not a string is null');
check(C.technicianDisplayName({ firstName: 'Jane', lastName: 'Doe' }) === 'Jane Doe', 'the technician is shown by first and last name');
check(C.technicianDisplayName({ firstName: '', lastName: '' }) === 'Technician' && C.technicianDisplayName({}) === 'Technician', 'never the email address: an empty name is "Technician"');

section('Which computers can chat');
const base = { platform: 'Windows', updateChannel: 'signed', chatProtocol: 1, status: 'ACTIVE', agentBound: true };
check(C.chatSupport(base).supported === true, 'signed Windows agent with chat protocol 1');
check(C.chatSupport({ ...base, chatProtocol: 2 }).supported === true, 'a later protocol is fine');
const r1 = C.chatSupport({ ...base, updateChannel: 'legacy', chatProtocol: 1 });
check(!r1.supported && r1.reason === 'agent' && /standard agent/.test(r1.message), 'the standard agent cannot chat, even if a row says it can', JSON.stringify(r1));
const r2 = C.chatSupport({ ...base, chatProtocol: null });
check(!r2.supported && r2.reason === 'agent' && /too old/.test(r2.message), 'a signed agent without the protocol is too old', JSON.stringify(r2));
check(C.chatSupport({ ...base, chatProtocol: 0 }).supported === false, 'protocol 0 is none');
for (const p of ['Linux', 'linux', 'macOS', 'Darwin', 'mac']) {
  const r = C.chatSupport({ ...base, platform: p });
  check(!r.supported && r.reason === 'platform' && /not available on (Linux|macOS) yet/.test(r.message), `${p}: not yet supported, said plainly`, JSON.stringify(r));
}
check(C.chatSupport({ ...base, agentBound: false }).reason === 'not_bound', 'no device secret: not bound');
check(C.chatSupport({ ...base, status: 'ARCHIVED' }).reason === 'archived', 'an archived computer cannot chat');

section('What the technician is told about the computer');
const now = Date.parse('2026-11-12T10:00:00Z');
const ago = (ms) => new Date(now - ms);
check(C.presence({ status: 'OPEN', deviceState: null, deviceSeenAt: null }, now).code === 'waiting_for_checkin', 'not picked up yet: waiting for the next check-in');
check(C.presence({ status: 'OPEN', deviceState: 'window_open', deviceSeenAt: ago(5_000) }, now).code === 'window_open', 'window open, recently in touch');
check(C.presence({ status: 'OPEN', deviceState: 'window_open', deviceSeenAt: ago(90_000) }, now).code === 'computer_silent', 'window open but silent for 90 s: the computer has gone quiet (a live agent polls every 25 s)');
check(C.presence({ status: 'OPEN', deviceState: 'no_user', deviceSeenAt: ago(90_000) }, now).code === 'no_user', 'nobody signed in stays "nobody signed in" (the agent polls slower then)');
check(/Nobody is signed in/.test(C.presence({ status: 'OPEN', deviceState: 'no_user', deviceSeenAt: ago(1000) }, now).text), '…in words');
check(C.presence({ status: 'OPEN', deviceState: 'window_failed', deviceSeenAt: ago(1000) }, now).code === 'window_failed', 'the window could not be opened');
for (const [reason, re] of [['end_user', /closed the chat window/], ['inactive', /two hours/], ['technician', /technician/]]) {
  const p = C.presence({ status: 'ENDED', deviceState: 'window_open', deviceSeenAt: ago(1000), endedReason: reason }, now);
  check(p.code === 'ended' && re.test(p.text), `ended (${reason}) says who ended it`, JSON.stringify(p));
}
check(C.deviceState('window_open') === 'window_open' && C.deviceState('delivered') === null && C.deviceState(1) === null, 'device states are a closed list');

section('Receipts');
const T = { sender: 'TECHNICIAN', deliveredAt: null, shownAt: null, readAt: null };
check(C.receipt(T) === 'sent', 'stored, nothing confirmed: sent');
check(C.receipt({ ...T, deliveredAt: new Date() }) === 'delivered', 'the agent confirmed it has it: delivered');
check(C.receipt({ ...T, deliveredAt: new Date(), shownAt: new Date() }) === 'shown', 'the window drew it: shown');
check(C.receipt({ ...T, deliveredAt: new Date(), shownAt: new Date(), readAt: new Date() }) === 'read', 'drawn while in front: read');
check(C.receipt({ ...T, sender: 'END_USER', readAt: new Date() }) === null, 'the person\'s own messages carry no receipt');

section('Ids from the device');
check(JSON.stringify(C.idList(['cmwctcavq000sv9dzg6honbcg', 'cmwctcavq000sv9dzg6honbcg', 'x', 7, '../etc', 'A'.repeat(25)])) === '["cmwctcavq000sv9dzg6honbcg"]', 'only cuid-shaped ids, deduplicated');
check(C.idList(Array.from({ length: 500 }, (_, i) => `c${String(i).padStart(24, '0')}`)).length === 100, 'at most 100');
check(C.idList('cmwctcavq000sv9dzg6honbcg').length === 0, 'not an array: nothing');
check(C.isClientId('clientid-0001') && !C.isClientId('short') && !C.isClientId('has space here'), 'client ids are 8–64 of [A-Za-z0-9_-]');

section('Retention and the sweep');
let cfg = C.chatConfig({});
check(cfg.enabled && cfg.retentionDays === 400 && cfg.maxWaiters === 500 && cfg.sweepSeconds === 3600, 'defaults: on, 400 days, 500 held polls, hourly', JSON.stringify(cfg));
check(C.chatConfig({ CHAT_RETENTION_SWEEP: 'off' }).enabled === false, 'CHAT_RETENTION_SWEEP=off turns it off');
check(C.chatConfig({ CHAT_RETENTION_DAYS: '1' }).retentionDays === 30 && C.chatConfig({ CHAT_RETENTION_DAYS: '99999' }).retentionDays === 3650 && C.chatConfig({ CHAT_RETENTION_DAYS: 'abc' }).retentionDays === 400, 'CHAT_RETENTION_DAYS is clamped to 30–3650 days; nonsense is the default');
check(C.chatConfig({ CHAT_MAX_WAITERS: '0' }).maxWaiters === 1 && C.chatConfig({ CHAT_MAX_WAITERS: '1e9' }).maxWaiters === 20000, 'CHAT_MAX_WAITERS is clamped to 1–20,000');
const cut = C.retentionCutoff(now, 400);
check(cut.toISOString() === new Date(now - 400 * 86400e3).toISOString(), 'the cutoff is exactly 400 days before now');
check(C.POLL_HOLD_MS === 25_000 && C.POLL_RECHECK_MS === 10_000 && C.INACTIVE_MS === 7_200_000, 'the poll is held 25 s, re-read every 10 s; two hours of quiet ends a chat');
check(C.MAX_PER_MINUTE.technician === 20 && C.MAX_PER_MINUTE.endUser === 20 && C.MAX_DEVICE_PER_MINUTE === 30 && C.MAX_MESSAGE_CHARS === 2000, 'caps: 20 a minute per side, 30 per computer, 2,000 characters');

// ── 0.44 ─────────────────────────────────────────────────────────────────────

section('Emoji (0.44): ordinary text, untouched, counted as the browser and the agent count');
const A = require(path.join(dist, 'chat/chat-attachment.js'));
const smile = '\u{1F600}', thumb = '\u{1F44D}\u{1F3FD}', family = '\u{1F468}\u200D\u{1F469}\u200D\u{1F467}', heart = '\u2764\uFE0F', flag = '\u{1F1F3}\u{1F1F4}';
t = C.chatText(`Fixed it ${smile} ${thumb} ${family} ${heart} ${flag}`);
check(t.ok && t.text === `Fixed it ${smile} ${thumb} ${family} ${heart} ${flag}`, 'emoji, skin tones, ZWJ sequences, variation selectors and flags pass through unchanged', JSON.stringify(t));
check(C.chatText(smile.repeat(1000)).ok && C.chatText(smile.repeat(1001)).code === 'TOO_LONG', '1,000 emoji are 2,000 UTF-16 code units: allowed; 1,001 refused (the textarea\'s maxlength counts the same way)');
check(C.chatText(`${'x'.repeat(1998)}${smile}`).ok && C.chatText(`${'x'.repeat(1999)}${smile}`).code === 'TOO_LONG', 'an emoji counts two: 1,998 + one fits, 1,999 + one does not');
const goTxt = (await import('node:fs')).readFileSync(path.join(dist, '..', '..', '..', 'tools', 'windows-installer', 'internal', 'chat', 'text.go'), 'utf8');
check(/if utf16Len\(s\) > MaxMessageChars \{/.test(goTxt) && /if r >= 0x10000 \{\s*\n\s*n \+= 2/.test(goTxt), 'the agent counts UTF-16 code units too (internal/chat utf16Len)');
const fs0 = await import('node:fs');
const apiEmoji = fs0.readFileSync(path.join(dist, '..', 'src', 'chat', 'emoji.ts'), 'utf8');
const webEmoji = fs0.readFileSync(path.join(dist, '..', '..', 'web', 'lib', 'emoji.ts'), 'utf8');
const listOf = (src) => src.slice(src.indexOf('= ['), src.indexOf('];') + 2);
const E = require(path.join(dist, 'chat/emoji.js')).EMOJI;
check(E.length >= 100 && listOf(apiEmoji) === listOf(webEmoji), `the picker offers the same ${E.length} emoji on the console and on /assist`);
check(E.every((e) => C.chatText(e).ok && C.chatText(e).text === e), 'every emoji the picker offers survives chatText exactly');

section('Attachments (0.44): what a file is comes from its bytes');
const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]), Buffer.from('IHDR'), Buffer.alloc(13)]);
const jpg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46]);
const gif = Buffer.from('GIF89a\x01\x00\x01\x00\x00\x00', 'latin1');
const webp = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBPVP8 '), Buffer.alloc(8)]);
const html = Buffer.from('<!doctype html><script>alert(document.cookie)</script>');
const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>');
for (const [b, want] of [[png, 'image/png'], [jpg, 'image/jpeg'], [gif, 'image/gif'], [webp, 'image/webp']]) {
  const s = A.sniff(b);
  check(s.kind === 'image' && s.contentType === want, `${want} by its magic number`, JSON.stringify(s));
}
for (const [name, b] of [['HTML', html], ['SVG', svg], ['a PNG signature with no IHDR', png.subarray(0, 12)], ['RIFF that is not WebP', Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('AVI LIST'), Buffer.alloc(8)])], ['empty', Buffer.alloc(0)]]) {
  const s = A.sniff(b);
  check(s.kind === 'file' && s.contentType === 'application/octet-stream', `${name}: a file, application/octet-stream`, JSON.stringify(s));
}
let k = A.checkAttachment({ buffer: html, originalname: 'cute-cat.png', mimetype: 'image/png' });
check(k.ok && k.kind === 'file' && k.contentType === 'application/octet-stream' && k.fileName === 'cute-cat.png.bin', 'HTML named .png and declared image/png: a download, renamed .png.bin — the declared type is never read', JSON.stringify(k));
k = A.checkAttachment({ buffer: svg, originalname: 'logo.svg' });
check(k.ok && k.kind === 'file' && k.fileName === 'logo.svg.bin', 'SVG is never an image here: a download named .svg.bin', JSON.stringify(k));
k = A.checkAttachment({ buffer: jpg, originalname: 'photo.png' });
check(k.ok && k.kind === 'image' && k.contentType === 'image/jpeg' && k.fileName === 'photo.png.jpg', 'a JPEG named .png is a JPEG, saved as .jpg', JSON.stringify(k));
k = A.checkAttachment({ buffer: png, originalname: 'shot.PNG' });
check(k.ok && k.fileName === 'shot.png' && /^[0-9a-f]{64}$/.test(k.sha256) && k.sizeBytes === png.length, 'a PNG keeps its name (extension lower-cased); size and SHA-256 recorded', JSON.stringify(k));
check(A.checkAttachment({ buffer: Buffer.alloc(0), originalname: 'x' }).code === 'ATTACHMENT_EMPTY', 'an empty file is refused');
check(A.checkAttachment({ buffer: Buffer.alloc(A.MAX_ATTACHMENT_BYTES + 1), originalname: 'x' }).code === 'ATTACHMENT_TOO_LARGE' && A.checkAttachment({ buffer: Buffer.alloc(A.MAX_ATTACHMENT_BYTES), originalname: 'x' }).ok, '10 MiB is the limit; one byte more is refused');
check(A.checkAttachment(undefined).code === 'ATTACHMENT_MISSING' && A.checkAttachment({ buffer: 'not a buffer' }).code === 'ATTACHMENT_MISSING', 'no file: refused');

section('Attachment names');
const fileS = { kind: 'file', contentType: 'application/octet-stream', ext: null };
const nm = (n) => A.attachmentName(n, fileS);
check(nm('../../Windows/System32/evil.dll') === 'evil.dll' && nm('C:\\Users\\a\\report.pdf') === 'report.pdf', 'only the last path segment survives');
check(nm(`invoice${ch(0x202e)}fdp.exe`) === 'invoice fdp.exe' && nm(`a${ch(0)}b${ch(0x200b)}c.txt`) === 'a b c.txt', 'bidi overrides, controls and zero-width characters are removed (an extension cannot be hidden)', `${nm(`invoice${ch(0x202e)}fdp.exe`)} | ${nm(`a${ch(0)}b${ch(0x200b)}c.txt`)}`);
check(nm('a<b>c:d"e|f?g*h.txt') === 'a_b_c_d_e_f_g_h.txt', 'Windows-reserved characters become _', nm('a<b>c:d"e|f?g*h.txt'));
check(nm('CON.txt') === '_CON.txt' && nm('lpt1') === '_lpt1' && nm('console.txt') === 'console.txt', 'Windows device names are prefixed, other names are not');
check(nm('  ..hidden.txt.. ') === 'hidden.txt' && nm('') === 'file' && nm('...') === 'file' && nm(42) === 'file', 'no leading or trailing dots or spaces; never empty');
const long = nm(`${'n'.repeat(300)}.docx`);
check([...long].length === 120 && long.endsWith('.docx'), 'at most 120 characters, the extension kept', long.length);
check(nm(`${smile} party.zip`) === `${smile} party.zip` && [...nm(`${smile.repeat(200)}.zip`)].length === 120, 'emoji in a name are kept, and counted as characters');
check(nm('page.html') === 'page.html.bin' && nm('report.PDF') === 'report.pdf' && nm('archive.tar.gz') === 'archive.tar.gz', 'a web page or image name on a file gets .bin; other extensions are kept');
check(A.decodeName(Buffer.from('café ☕.txt', 'utf8').toString('latin1')) === 'café ☕.txt' && A.decodeName('plain.txt') === 'plain.txt', 'a UTF-8 name busboy read as latin1 is decoded back');

section('How an attachment is served');
let h = A.attachmentHeaders({ kind: 'image', contentType: 'image/png', fileName: 'shot.png', sizeBytes: 10 });
check(h['Content-Type'] === 'image/png' && h['Content-Disposition'].startsWith('inline;') && h['X-Content-Type-Options'] === 'nosniff' && h['Content-Security-Policy'] === "default-src 'none'; sandbox" && h['Cache-Control'] === 'private, no-store', 'an image: its own type, inline, nosniff, a sandbox CSP, never cached', JSON.stringify(h));
h = A.attachmentHeaders({ kind: 'file', contentType: 'application/octet-stream', fileName: 'tool.exe', sizeBytes: 10 });
check(h['Content-Type'] === 'application/octet-stream' && h['Content-Disposition'].startsWith('attachment;') && h['X-Content-Type-Options'] === 'nosniff' && h['Content-Security-Policy'] === "default-src 'none'; sandbox", 'a file: application/octet-stream, as an attachment, nosniff, a sandbox CSP', JSON.stringify(h));
h = A.attachmentHeaders({ kind: 'image', contentType: 'image/svg+xml', fileName: 'x.svg', sizeBytes: 10 });
check(h['Content-Type'] === 'application/octet-stream' && h['Content-Disposition'].startsWith('attachment;'), 'a row claiming an image of any other type is still served as a download', JSON.stringify(h));
const cd = A.contentDisposition('attachment', `r"ep\\ort ${smile};.pdf`);
check(cd === `attachment; filename="r_ep_ort __.pdf"; filename*=UTF-8''r%22ep%5Cort%20%F0%9F%98%80%3B.pdf`, 'Content-Disposition: an ASCII fallback with quotes, backslashes and ; replaced, and the RFC 5987 UTF-8 name', cd);

section('Caps on one chat');
check(A.withinConversationCaps(19, 0, 1) === 'ok' && A.withinConversationCaps(20, 0, 1) === 'ATTACHMENT_COUNT', 'at most 20 files in one chat');
check(A.withinConversationCaps(0, 40 * 1048576, 10 * 1048576) === 'ok' && A.withinConversationCaps(0, 40 * 1048576 + 1, 10 * 1048576) === 'ATTACHMENT_TOTAL', 'at most 50 MiB in one chat');
check(A.MAX_ATTACHMENT_BYTES === 10485760 && A.MAX_ATTACHMENTS_PER_CONVERSATION === 20 && A.MAX_ATTACHMENT_BYTES_PER_CONVERSATION === 52428800, 'caps: 10 MiB a file, 20 files and 50 MiB a chat (the CHECK constraints say the same)');

console.log(`\nunit-chat: ${pass} passed, ${fail} failed`);
if (fail) { for (const f of failures) console.log(`  - ${f}`); process.exit(1); }
