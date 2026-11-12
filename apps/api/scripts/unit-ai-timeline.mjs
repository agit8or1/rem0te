#!/usr/bin/env node
/**
 * Unit tests for the device page's AI summary (0.34): what leaves rem0te for
 * ClientSt0r, how it is redacted, the PROPOSED request/response schemas, and
 * the peers file's optional capabilitiesUrl. No database, no network.
 *
 *   cd apps/api && npx nest build && node scripts/unit-ai-timeline.mjs
 *
 * The behavioural suite against a running API and a reference peer is
 * scripts/e2e-ai-timeline.mjs.
 */
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { generateKeyPairSync } from 'node:crypto';
import path from 'node:path';
import assert from 'node:assert/strict';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const dist = path.join(here, '..', 'dist', 'integration');
const T = require(path.join(dist, 'timeline.js'));
const K = require(path.join(dist, 'contract.js'));
const P = require(path.join(dist, 'peers.js'));
const TC = require(path.join(dist, 'timeline.client.js'));

let n = 0;
const t = (name, fn) => { fn(); n++; console.log(`  ✓ ${name}`); };
const red = (s) => T.redactForPeer(s);

console.log('redaction');
t('key=value and prose credentials are removed, the key kept', () => {
  const r = red('admin password=Hunter2! then pwd: "p a s s" and token=abc123 and the password is Winter2026');
  assert.ok(!/Hunter2|p a s s|abc123|Winter2026/.test(r.text), r.text);
  assert.match(r.text, /password=\[redacted\]/);
  assert.equal(r.counts.secret, 4);
});
t('bearer tokens, URL credentials and prefixed keys are removed', () => {
  const r = red('Authorization header Bearer eyJhbGciOiJIUzI1NiJ9.e30.abcdefgh; https://bob:s3cret@files.example.com/x; key rk_live_ABCDEFGH1234');
  assert.ok(!/eyJhbGci|s3cret|bob:|rk_live/.test(r.text), r.text);
  assert.ok(r.counts.secret >= 2 && r.counts.token >= 1, JSON.stringify(r.counts));
});
t('e-mail addresses are removed', () => {
  const r = red('Called jane.doe+it@acme-corp.co.uk and IT@Example.com about it');
  assert.equal(r.text, 'Called [email] and [email] about it');
  assert.equal(r.counts.email, 2);
});
t('every IPv4 address is removed, private ranges included', () => {
  const r = red('gateway 192.168.1.1, public 203.0.113.9, loopback 127.0.0.1, vpn 10.8.0.2');
  assert.equal(r.text, 'gateway [ip], public [ip], loopback [ip], vpn [ip]');
  assert.equal(r.counts.ip_address, 4);
});
t('IPv6 addresses are removed; times and C++ names are not', () => {
  const r = red('addr 2001:db8::1 and fe80::1ff:fe23:4567:890a, [::1], at 10:30:00 with std::string');
  assert.ok(!/2001:db8|fe80|::1\]/.test(r.text), r.text);
  assert.match(r.text, /10:30:00/);
  assert.match(r.text, /std::string/);
  assert.equal(r.counts.ip_address, 3);
});
t('MAC addresses, RustDesk IDs and user-profile paths are removed', () => {
  const r = red('nic 00:1A:2B:3C:4D:5E / 00-1a-2b-3c-4d-5f, rustdesk 123456789, file C:\\Users\\alice\\Desktop\\x.txt');
  assert.ok(!/00:1A|00-1a|123456789|alice/.test(r.text), r.text);
  assert.equal(r.counts.mac_address, 2);
  assert.equal(r.counts.rustdesk_id, 1);
  assert.equal(r.counts.user_path, 1);
});
t('long opaque strings and long hex are removed', () => {
  const r = red(`hash ${'a1'.repeat(20)} blob ${'Zm9vYmFy'.repeat(6)}`);
  assert.equal(r.text, 'hash [token] blob [token]');
  assert.equal(r.counts.token, 2);
});
t('ordinary technician prose is left alone', () => {
  const s = 'Replaced the toner on 2026-11-03. Windows 10.0.19045 build, KB5034441 failed twice; printer on LPT1 at 9:15. Ticket #48213.';
  const r = red(s);
  assert.equal(r.text, s);
  assert.deepEqual(r.counts, T.zeroCounts());
});
t('an address ending a sentence keeps its full stop', () => {
  assert.equal(red('Moved to 2001:db8::1. Then 10.0.0.1.').text, 'Moved to [ip]. Then [ip].');
});
t('pathological input stays fast (no catastrophic backtracking)', () => {
  for (const s of ['a.'.repeat(50000) + '@', '1.'.repeat(50000), ':'.repeat(100000), 'http://a'.repeat(12000), 'password='.repeat(11000), 'ab:'.repeat(33000)]) {
    const t0 = Date.now(); red(s); const ms = Date.now() - t0;
    assert.ok(ms < 1500, `${s.slice(0, 12)}… took ${ms} ms`);
  }
});
t('control and bidi-override characters are stripped', () => {
  assert.equal(red('a\u0000b\u202ec\u2066d').text, 'abcd');
});

console.log('payload');
const D = (iso) => new Date(iso);
const snap = (over = {}) => ({
  id: 'cmep1abc', platform: 'Windows', osVersion: 'Windows 11 Pro <b>', agentVersion: '0.30.1', status: 'ACTIVE', isOnline: true,
  lastSeenAt: D('2026-11-11T10:00:00Z'), createdAt: D('2025-01-02T00:00:00Z'),
  notes: [
    { createdAt: D('2026-11-01T09:00:00Z'), content: 'Reset password=Sunshine1 for jane@acme.example, PC at 10.0.0.15', isPinned: true },
    { createdAt: D('2026-10-01T09:00:00Z'), content: 'Older note', isPinned: false },
  ],
  sessions: [{ createdAt: D('2026-11-05T09:00:00Z'), status: 'COMPLETED', issueDescription: 'Outlook crash; RustDesk 987654321', disposition: 'Repaired profile C:\\Users\\jane\\AppData', duration: 1800 }],
  ...over,
});
t('segments: facts first, then notes and sessions oldest to newest, positional refs', () => {
  const p = T.buildTimelinePayload(snap());
  assert.deepEqual(p.segments.map((s) => s.ref), ['device:facts', 'note:1', 'note:2', 'session:1']);
  assert.match(p.segments[1].text, /Older note/);
  assert.match(p.segments[2].text, /^date=2026-11-01 pinned=true\n/);
  assert.match(p.segments[3].text, /^date=2026-11-05 state=COMPLETED minutes=30\nissue: /);
  assert.equal(p.counts.notes, 2); assert.equal(p.counts.sessions, 1);
});
t('free text is redacted and the counts add up across notes and sessions', () => {
  const p = T.buildTimelinePayload(snap());
  const all = p.segments.map((s) => s.text).join('\n');
  for (const leak of ['Sunshine1', 'jane@acme.example', '10.0.0.15', '987654321', 'C:\\Users\\jane']) assert.ok(!all.includes(leak), leak);
  assert.deepEqual(p.redactions, { secret: 1, token: 0, email: 1, ip_address: 1, mac_address: 0, rustdesk_id: 1, user_path: 1 });
});
t('device facts pass the inert charset', () => {
  const p = T.buildTimelinePayload(snap());
  assert.match(p.segments[0].text, /^platform=Windows\nos=Windows 11 Pro b\nagent_version=0\.30\.1\nenrolment_status=ACTIVE\nonline=true\nlast_seen=2026-11-11T10:00:00\.000Z\nenrolled=2025-01-02$/);
});
t('the newest notes are kept when there are more than the cap', () => {
  const notes = Array.from({ length: 40 }, (_, i) => ({ createdAt: new Date(Date.UTC(2026, 0, 1 + i)), content: `n${i}`, isPinned: false }));
  const p = T.buildTimelinePayload(snap({ notes, sessions: [] }));
  assert.equal(p.counts.notes, T.MAX_NOTES);
  assert.match(p.segments[1].text, /\nn10$/);
  assert.match(p.segments.at(-1).text, /\nn39$/);
});
t('over the size cap, the oldest are dropped and the facts stay', () => {
  const notes = Array.from({ length: 30 }, (_, i) => ({ createdAt: new Date(Date.UTC(2026, 0, 1 + i)), content: `${i} ${'word '.repeat(399)}`, isPinned: false }));
  const p = T.buildTimelinePayload(snap({ notes, sessions: [] }));
  assert.ok(p.chars <= T.MAX_PAYLOAD_CHARS, String(p.chars));
  assert.ok(p.dropped > 0);
  assert.equal(p.segments[0].ref, 'device:facts');
  assert.match(p.segments.at(-1).text, /\n29 word/);
});
t('the request built from a payload is valid, and the schema is closed', () => {
  const p = T.buildTimelinePayload(snap());
  const r = TC.timelineRequest('org-a', 'summary-fast', 'cmep1abc', p.segments, p.redactions);
  assert.equal(r.task, 'device_timeline_v1');
  assert.ok(K.TimelineInferenceRequest.safeParse(r).success);
  assert.ok(!K.TimelineInferenceRequest.safeParse({ ...r, input: { ...r.input, hostname: 'FRONTDESK' } }).success, 'an extra input field is refused');
  assert.ok(!K.TimelineInferenceRequest.safeParse({ ...r, input: { ...r.input, rem0te_endpoint_id: 'FRONTDESK-01' } }).success, 'a hostname is not an endpoint id');
  assert.ok(!K.TimelineInferenceRequest.safeParse({ ...r, input: { ...r.input, untrusted_segments: [{ ...r.input.untrusted_segments[0], ref: 'note:cmnoteid' }] } }).success, 'database ids are not refs');
  const keys = new Set(Object.keys(r.input));
  assert.deepEqual([...keys].sort(), ['instructions_ref', 'redactions', 'rem0te_endpoint_id', 'untrusted_segments']);
});
t('every payload key is listed in TIMELINE_FIELDS', () => {
  const listed = T.TIMELINE_FIELDS.flatMap((f) => f.field.split(/,\s*/));
  const p = T.buildTimelinePayload(snap());
  for (const line of p.segments[0].text.split('\n')) assert.ok(listed.includes(line.split('=')[0]), line);
  for (const k of ['rem0te_endpoint_id', 'redactions', 'note', 'support_session']) assert.ok(listed.includes(k), k);
});

console.log('output and peer capabilities');
t('output: unknown fields dropped and counted, text cleaned, empty refused', () => {
  const o = T.parseTimelineOutput({ summary: ' Fine.\u202e ', approve_fix: true, run: 'x' });
  assert.equal(o.summary, 'Fine.'); assert.equal(o.dropped, 2);
  assert.equal(T.parseTimelineOutput({ summary: '' }).summary, null);
  assert.equal(T.parseTimelineOutput({ summary: 'x'.repeat(4001) }).summary, null);
  assert.equal(T.parseTimelineOutput('just text').summary, null);
});
t('response schema requires the task echo and refuses unknown fields', () => {
  const ok = { contract: 'ticket-rmm-v1', request_id: '00000000-0000-4000-8000-000000000001', organization_id: 'org-a', model_profile: 'summary-fast', task: 'device_timeline_v1', resolved_model: 'm', status: 'ok', output: { summary: 'x' } };
  assert.ok(K.TimelineInferenceResponse.safeParse(ok).success);
  assert.ok(!K.TimelineInferenceResponse.safeParse({ ...ok, task: 'ticket_triage_v1' }).success);
  assert.ok(!K.TimelineInferenceResponse.safeParse({ ...ok, job_id: ok.request_id }).success);
});
t('peer capabilities tolerate new top-level fields but not bad task names', () => {
  const doc = { contract: 'ticket-rmm-v1', peer_id: 'clientst0r', inference_tasks: [{ task: 'device_timeline_v1', model_profiles: ['summary-fast'] }], later_field: 1 };
  assert.ok(K.PeerCapabilities.safeParse(doc).success);
  assert.ok(!K.PeerCapabilities.safeParse({ ...doc, inference_tasks: [{ task: 'Device Timeline', model_profiles: ['x'] }] }).success);
  assert.ok(!K.PeerCapabilities.safeParse({ ...doc, inference_tasks: [{ task: 'device_timeline_v1', model_profiles: [] }] }).success);
});
t('proposed schemas are not part of the agreed contract', () => {
  for (const k of Object.keys(K.PROPOSED_SCHEMAS)) assert.ok(!(k in K.CONTRACT_SCHEMAS), k);
  assert.equal(K.CONTRACT_REVISION, 2);
});

console.log('peers file');
const key = generateKeyPairSync('ed25519');
const pem = key.publicKey.export({ type: 'spki', format: 'pem' }).toString();
const file = (over = {}) => ({
  self: { keyId: 'k', privateKeyFile: '/x' },
  peers: [{ id: 'cs', audience: 'a', peerAudience: 'b', requestKeys: [{ kid: 'r', publicKeyPem: pem }], delegationKeys: [{ kid: 'd', publicKeyPem: pem }],
    inferenceUrl: 'https://cs.example.com/i', eventsUrl: 'https://cs.example.com/e', modelProfiles: ['summary-fast'], ...over }],
});
const priv = () => key.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
t('capabilitiesUrl is optional', () => {
  assert.equal(P.parseTrust(file(), priv).peers.get('cs').capabilitiesUrl, null);
  assert.equal(P.parseTrust(file({ capabilitiesUrl: 'https://cs.example.com/api/integration/v1/capabilities' }), priv).peers.get('cs').capabilitiesUrl.host, 'cs.example.com');
});
t('capabilitiesUrl follows the peer URL rules', () => {
  assert.throws(() => P.parseTrust(file({ capabilitiesUrl: 'http://cs.example.com/c' }), priv), /https/);
  assert.throws(() => P.parseTrust(file({ capabilitiesUrl: 'https://u:p@cs.example.com/c' }), priv), /credentials/);
  assert.throws(() => P.parseTrust(file({ capabilitiesUrl: 'https://cs.example.com/c?x=1' }), priv), /query/);
  assert.ok(P.parseTrust(file({ capabilitiesUrl: 'http://127.0.0.1:9/c' }), priv));
});

console.log(`\n${n} passed`);
