#!/usr/bin/env node
// Unit tests for the 0.35 polish logic, with no database:
//
//   - connectivity (API dist and the web copy): online inside the heartbeat
//     window, agent_silent when isOnline without a heartbeat inside it
//     (including never), offline when not reachable — the boundary exactly at
//     the window, and the two copies answering the same on a grid of ages;
//     the web label "Reachable (RustDesk) · agent silent 12 d" and its hint;
//   - restart and update wording by platform (API and web agree): "Linux is
//     waiting for a restart", never Windows for Linux or macOS, "the computer"
//     for an unreported platform;
//   - ink on a branding accent: black or white, whichever contrasts more, and
//     at least 4.5:1 on every one of 4096 colours (WCAG AA for text).
//
// Build first: pnpm --filter @reboot-remote/api build. The web modules are
// TypeScript and are loaded with Node's type stripping (Node 22.18+).
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const C = require(join(here, '..', 'dist', 'common', 'connectivity.js'));
const P = require(join(here, '..', 'dist', 'common', 'platform.js'));
const web = (f) => import(pathToFileURL(join(here, '..', '..', 'web', 'lib', f)).href);
const WC = await web('connectivity.ts');
const WP = await web('platform-wording.ts');
const K = await web('contrast.ts');

let pass = 0, fail = 0;
const failures = [];
const check = (c, n, d = '') => { if (c) { pass++; console.log(`  \x1b[32m✓\x1b[0m ${n}`); } else { fail++; failures.push(`${n} — ${d}`); console.log(`  \x1b[31m✗\x1b[0m ${n}\n      ${d}`); } };
const section = (t) => console.log(`\n\x1b[1m${t}\x1b[0m`);

section('Connectivity: three states from isOnline and the last heartbeat');
{
  const now = Date.parse('2026-11-12T12:00:00Z');
  const W = C.HEARTBEAT_STALE_MS;
  const at = (ms) => new Date(now - ms);
  check(W === 30 * 60_000 && WC.HEARTBEAT_STALE_MS === W, 'one window, 30 minutes, in the API and the web copy', `${W} ${WC.HEARTBEAT_STALE_MS}`);
  check(C.connectivityOf(true, at(60_000), now) === 'online', 'reachable and a heartbeat a minute ago: online');
  check(C.connectivityOf(true, at(W), now) === 'online' && C.connectivityOf(true, at(W + 1), now) === 'agent_silent', 'exactly at the window: online; a millisecond past it: agent_silent');
  check(C.connectivityOf(true, at(12 * 86400_000), now) === 'agent_silent', 'reachable, agent silent twelve days: agent_silent (the reported DESKTOP case)');
  check(C.connectivityOf(true, null, now) === 'agent_silent', 'reachable and never a heartbeat: agent_silent, not online');
  check(C.connectivityOf(false, at(1000), now) === 'offline' && C.connectivityOf(false, null, now) === 'offline', 'not reachable: offline, however recent the heartbeat');
  check(C.connectivityOf(true, at(-5 * 60_000), now) === 'online', 'a heartbeat stamped slightly in the future (clock skew) still counts as online');
  check(C.heartbeatCutoff(now).getTime() === now - W, 'heartbeatCutoff is now minus the window');
  const ages = [null, 0, 1, 60_000, W - 1, W, W + 1, 3600_000, 86400_000, 12 * 86400_000];
  const diff = [];
  for (const on of [true, false]) for (const a of ages) {
    const t = a === null ? null : at(a);
    const api = C.connectivityOf(on, t, now), w = WC.connectivityOf(on, t === null ? null : t.toISOString(), now);
    if (api !== w) diff.push(`${on}/${a}: api ${api} web ${w}`);
  }
  check(diff.length === 0, `the web derivation agrees with the API's on ${ages.length * 2} cases (ISO strings as the payload carries them)`, diff.join('; '));
  check(WC.connectivityFrom({ connectivity: 'agent_silent', isOnline: true, lastSeenAt: at(1000).toISOString() }, now) === 'agent_silent', "the server's value wins over a local derivation");
  check(WC.connectivityFrom({ connectivity: 'bogus', isOnline: true, lastSeenAt: at(1000).toISOString() }, now) === 'online', 'an unknown server value is ignored and derived instead');
  check(WC.connectivityLabel('agent_silent', at(12 * 86400_000 + 3600_000).toISOString(), now) === 'Reachable (RustDesk) · agent silent 12 d', 'label: "Reachable (RustDesk) · agent silent 12 d"', WC.connectivityLabel('agent_silent', at(12 * 86400_000 + 3600_000).toISOString(), now));
  check(WC.connectivityLabel('agent_silent', at(45 * 60_000).toISOString(), now) === 'Reachable (RustDesk) · agent silent 45 min' && WC.connectivityLabel('agent_silent', at(5 * 3600_000).toISOString(), now) === 'Reachable (RustDesk) · agent silent 5 h', 'minutes and hours below two days');
  check(WC.connectivityLabel('agent_silent', null, now) === 'Reachable (RustDesk) · no agent report', 'never reported: "no agent report"');
  check(WC.connectivityLabel('online') === 'Online' && WC.connectivityLabel('offline') === 'Offline', 'online and offline keep their words');
  const hint = WC.connectivityHint('agent_silent');
  check(/remote control should work/.test(hint) && /monitoring, patching and actions are not reporting/.test(hint) && /Update agent/.test(hint) && /Agent card/.test(hint), 'the hint: what still works, what does not, and Update agent on the Agent card', hint);
  check(WC.CONNECTIVITY_DOT.online === 'bg-green-500' && WC.CONNECTIVITY_DOT.agent_silent === 'bg-amber-500' && WC.CONNECTIVITY_DOT.offline === 'bg-gray-400', 'green, amber, grey');
}

section('Restart and update wording by platform');
{
  const cases = [['Windows', 'Windows'], ['windows', 'Windows'], ['Linux', 'Linux'], ['linux', 'Linux'], ['macOS', 'macOS'], ['darwin', 'macOS'], [null, null], ['', null], ['Plan9', null]];
  const bad = [];
  for (const [p, want] of cases) {
    if (P.osName(p) !== want) bad.push(`api osName(${p}) = ${P.osName(p)}`);
    if (WP.osName(p) !== want) bad.push(`web osName(${p}) = ${WP.osName(p)}`);
    const s = P.restartPendingSentence(p);
    // The web sentence stands alone ("This computer …"); the API's sits inside a reason ("… the computer …").
    const w = WP.restartPendingSentence(p);
    if (want ? w !== s : w !== 'This computer is waiting for a restart') bad.push(`web restart(${p}) = "${w}"`);
    if (want && s !== `${want} is waiting for a restart`) bad.push(`restart(${p}) = "${s}"`);
    if (!want && s !== 'the computer is waiting for a restart') bad.push(`restart(${p}) = "${s}"`);
  }
  check(bad.length === 0, `${cases.length} platforms: the OS named, or "the computer" / "This computer"; API and web agree`, bad.join('; '));
  check(!/Windows/.test(P.restartPendingSentence('Linux')) && !/Windows/.test(P.restartPendingSentence('macOS')), 'Linux and macOS never read "Windows"');
  check(WP.updateSourceLabel('Windows') === 'Windows Update' && WP.updateSourceLabel('Linux') === 'Package updates' && WP.updateSourceLabel('macOS') === 'Software Update' && WP.updateSourceLabel(null) === 'Updates',
    'the update source: Windows Update, Package updates, Software Update, or plain Updates');
}

section('Ink on a branding accent');
{
  check(K.inkOn('#FDE68A') === '#000000' && K.inkOn('#1E3A8A') === '#ffffff' && K.inkOn('#fff') === '#000000' && K.inkOn('000') === '#ffffff', 'pale yellow and white get black; navy and black get white');
  check(K.inkOn('not a colour') === null && K.inkOn(null) === null && K.inkOn('#12345') === null, 'not a hex colour: null (the caller keeps its theme colours)');
  check(K.inkOn('#3B82F6cc') === K.inkOn('#3B82F6'), 'alpha is ignored');
  check(Math.abs(K.contrastRatio(K.luminance([255, 255, 255]), K.luminance([0, 0, 0])) - 21) < 1e-9, 'white on black is 21:1');
  let worst = Infinity, worstHex = '';
  for (let r = 0; r < 256; r += 17) for (let g = 0; g < 256; g += 17) for (let b = 0; b < 256; b += 17) {
    const hex = `#${[r, g, b].map((x) => x.toString(16).padStart(2, '0')).join('')}`;
    const ink = K.inkOn(hex);
    const ratio = K.contrastRatio(K.luminance([r, g, b]), ink === '#000000' ? 0 : 1);
    if (ratio < worst) { worst = ratio; worstHex = hex; }
  }
  check(worst >= 4.5, `every one of 4096 colours gets ink at 4.5:1 or better (worst ${worst.toFixed(2)}:1 on ${worstHex})`);
}

console.log(`\n${fail ? '\x1b[31m' : '\x1b[32m'}${pass} passed, ${fail} failed\x1b[0m`);
if (failures.length) { for (const f of failures) console.log(`  - ${f}`); process.exit(1); }
