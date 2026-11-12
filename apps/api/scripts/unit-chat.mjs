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

console.log(`\nunit-chat: ${pass} passed, ${fail} failed`);
if (fail) { for (const f of failures) console.log(`  - ${f}`); process.exit(1); }
