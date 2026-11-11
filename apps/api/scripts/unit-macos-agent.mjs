#!/usr/bin/env node
/**
 * Unit tests for the standard macOS agent's pure logic (0.33), against the
 * compiled modules, with no database and no Mac:
 *
 *   - the two awk date conversions the agent uses instead of date(1) (BSD
 *     and GNU date disagree), over 2,000 random instants and the edges —
 *     leap days, centuries, offsets — under every POSIX shell here;
 *   - the parser for `defaults read … RecommendedUpdates`, over quoted and
 *     unquoted values, a missing display name, and hostile names;
 *   - which platforms count as a read-only agent, and the refusal codes;
 *   - the template guards: no `${`, no heredoc delimiter inside the agent;
 *   - both generated POSIX agents parse under sh, dash, bash --posix,
 *     busybox sh and zsh's sh emulation (ZSH_BIN, or zsh on PATH).
 *
 *   cd apps/api && npx nest build && node scripts/unit-macos-agent.mjs
 */
import { createRequire } from 'node:module';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const dist = path.join(here, '..', 'dist');
const { buildMacosAgentScript } = require(path.join(dist, 'public', 'macos-agent.js'));
const { buildLinuxAgentScript } = require(path.join(dist, 'public', 'linux-agent.js'));
const { assemblePosixAgent } = require(path.join(dist, 'public', 'posix-agent.js'));
const { readOnlyAgentOs, readOnlyAgentRefusal, isMacPlatform } = require(path.join(dist, 'common', 'platform.js'));

let pass = 0, fail = 0;
const check = (c, n, d = '') => { if (c) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n}\n      ${d}`); } };
const section = (t) => console.log(`\n${t}`);
const which = (t) => { try { return execFileSync('sh', ['-c', `command -v ${t}`], { encoding: 'utf8' }).trim(); } catch { return ''; } };
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'rem0te-unit-macos-'));

const agent = buildMacosAgentScript('0.33.0');
const zsh = process.env.ZSH_BIN || which('zsh');
const SHELLS = [['dash', ['dash']], ['bash --posix', ['bash', '--posix']], ['busybox sh', ['busybox', 'sh']], ['zsh (sh emulation)', [zsh, '--emulate', 'sh']]]
  .filter(([, [b]]) => b && (b.includes('/') ? fs.existsSync(b) : which(b)));

try {
  section('The agent\'s date conversions match JavaScript, in every shell');
  const fns = agent.slice(agent.indexOf('iso_from_epoch() {'), agent.indexOf('NOW=$(date'));
  check(fns.includes('epoch_from_plist_date() {') && fns.length < 3000, 'both functions extracted from the generated agent');
  const edges = [0, 951782400 /* 2000-02-29 */, 951868799, 4107542399 /* 2100-02-28 23:59:59 */, 4107542400, 1709164800 /* 2024-02-29 */, 1735689599, 1735689600];
  let seed = 7; const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  const instants = [...edges, ...Array.from({ length: 2000 }, () => Math.floor(631152000 + rnd() * (4102444800 - 631152000)))];
  const iso = (t) => new Date(t * 1000).toISOString().replace(/\.\d+Z$/, 'Z');
  const offsets = ['+0000', '+0530', '-0800', '+1345', '-0000'];
  const plist = (t, off) => {
    const sign = off[0] === '-' ? -1 : 1; const mins = sign * (Number(off.slice(1, 3)) * 60 + Number(off.slice(3)));
    return `${new Date((t + mins * 60) * 1000).toISOString().replace('T', ' ').replace(/\.\d+Z$/, '')} ${off}`;
  };
  const script = path.join(TMP, 'dates.sh');
  fs.writeFileSync(script, `${fns}\nwhile read -r t; do printf '%s\\n' "$(iso_from_epoch "$t")"; done < "$1"\nwhile IFS= read -r d; do printf '%s\\n' "$(epoch_from_plist_date "$d")"; done < "$2"\n`);
  fs.writeFileSync(path.join(TMP, 'epochs'), `${instants.join('\n')}\n`);
  const dates = instants.filter((t) => t >= 631152000).map((t, k) => plist(t, offsets[k % offsets.length]));
  fs.writeFileSync(path.join(TMP, 'dates'), `${dates.join('\n')}\n`);
  for (const [label, [bin, ...pre]] of SHELLS) {
    const out = spawnSync(bin, [...pre, script, path.join(TMP, 'epochs'), path.join(TMP, 'dates')], { encoding: 'utf8', env: { PATH: process.env.PATH, LC_ALL: 'C' } });
    const lines = out.stdout.split('\n');
    const isoGot = lines.slice(0, instants.length), epGot = lines.slice(instants.length, instants.length + dates.length);
    const isoBad = instants.findIndex((t, k) => isoGot[k] !== iso(t));
    const epWant = instants.filter((t) => t >= 631152000);
    const epBad = epWant.findIndex((t, k) => epGot[k] !== String(t));
    check(out.status === 0 && isoBad === -1, `${label}: epoch → ISO for ${instants.length} instants, leap days and centuries included`, isoBad >= 0 ? `${instants[isoBad]}: got ${isoGot[isoBad]}, want ${iso(instants[isoBad])}` : out.stderr);
    check(epBad === -1, `${label}: "YYYY-MM-DD hh:mm:ss ±hhmm" → epoch for ${dates.length} dates in five offsets`, epBad >= 0 ? `${dates[epBad]}: got ${epGot[epBad]}, want ${epWant[epBad]}` : '');
  }
  const bad = spawnSync('sh', ['-c', `${fns}\nfor d in 'garbage' '' '1989-12-31 23:59:59 +0000' '2024-13-01 00:00:00 +0000' '2024-01-01'; do printf '[%s]' "$(epoch_from_plist_date "$d")"; done; printf '[%s]' "$(iso_from_epoch -5)" "$(iso_from_epoch x1)"`], { encoding: 'utf8' });
  check(bad.stdout === '[][][][][][][]', 'junk, pre-1990, a 13th month or a missing time give nothing (unknown), never a number', bad.stdout);

  section('The RecommendedUpdates parser');
  const awkStart = agent.indexOf("  awk '\n    function val(s)");
  const awkEnd = agent.indexOf('\' "$TMPD/su.list"', awkStart);
  const prog = agent.slice(agent.indexOf("'", awkStart) + 1, awkEnd);
  check(awkStart > 0 && awkEnd > awkStart && prog.includes('Display Name'), 'the awk program extracted from the generated agent');
  const parse = (text) => spawnSync('awk', [prog], { input: text, encoding: 'utf8' }).stdout.split('\n').filter(Boolean).map((l) => l.replace(/\t$/, ''));
  const rec = (pairs) => `(\n${pairs.map((p) => `        {\n${p.map((l) => `        ${l};`).join('\n')}\n    }`).join(',\n')}\n)\n`;
  let got = parse(rec([['"Display Name" = "macOS Sonoma 14.6"', '"Display Version" = "14.6"', 'Identifier = "MSU_UPDATE_23G80_patch_14.6"'], ['"Display Name" = Safari', '"Display Version" = "17.6"', 'Identifier = "Safari17.6SonomaAuto"']]));
  check(JSON.stringify(got) === '["macOS Sonoma 14.6","Safari 17.6"]', 'quoted and unquoted names; the version appended only when the name lacks it', JSON.stringify(got));
  got = parse(rec([['"Display Version" = "2.0"', 'Identifier = "com.apple.pkg.XProtectPayloads"'], ['Identifier = ""']]));
  check(JSON.stringify(got) === '["com.apple.pkg.XProtectPayloads 2.0"]', 'no display name: the identifier; nothing at all: skipped', JSON.stringify(got));
  got = parse('(\n)\n');
  check(got.length === 0, 'an empty list is no updates');
  got = parse(rec([['"Display Name" = "A \\"quoted\\" $(x) name"', '"Display Version" = "1"']]));
  check(got.length === 1 && got[0].startsWith('A \\"quoted\\" $(x) name'), 'a hostile name comes out as text, for txt() to reduce (it is never evaluated)', JSON.stringify(got));

  section('Which platforms run a read-only agent');
  const cases = [['macos', 'macOS'], ['macOS', 'macOS'], ['darwin', 'macOS'], ['Mac', 'macOS'], ['osx', 'macOS'], ['linux', 'Linux'], ['Linux', 'Linux'], ['linux-gnu', 'Linux'],
    ['Windows', null], ['windows', null], ['', null], [null, null], ['machine', null], ['macintosh-ish', null], ['android', null]];
  const wrong = cases.filter(([p, want]) => readOnlyAgentOs(p) !== want);
  check(!wrong.length, `${cases.length} platform names map as expected (and "machine" or "macintosh-ish" are not macOS)`, JSON.stringify(wrong.map(([p]) => [p, readOnlyAgentOs(p)])));
  check(isMacPlatform(' macos ') && !isMacPlatform('windows'), 'surrounding whitespace is ignored');
  const rm = readOnlyAgentRefusal('macos', 'Rotating the password'), rl = readOnlyAgentRefusal('linux', 'Rotating the password');
  check(rm?.code === 'MACOS_AGENT_READ_ONLY' && /not available on macOS: the macOS agent/.test(rm.message) && rl?.code === 'LINUX_AGENT_READ_ONLY' && readOnlyAgentRefusal('Windows', 'x') === null,
    'refusal codes: MACOS_AGENT_READ_ONLY, and LINUX_AGENT_READ_ONLY unchanged; none for Windows');

  section('Template guards');
  let threw = ''; try { assemblePosixAgent('t', ['echo ${HOME}'], '1'); } catch (e) { threw = String(e.message); }
  check(/must not contain/.test(threw), 'a fragment containing ${ is refused (it would be a template interpolation)');
  threw = ''; try { assemblePosixAgent('t', ['echo a\nREM0TE_AGENT_EOF\necho b'], '1'); } catch (e) { threw = String(e.message); }
  check(/heredoc delimiter/.test(threw), 'a fragment containing the heredoc delimiter on a line of its own is refused');
  check(buildMacosAgentScript('1.2.3; rm -rf /').includes("AGENT_VERSION='unknown'") && buildMacosAgentScript('0.33.0').includes("AGENT_VERSION='0.33.0'"), 'an unsafe version string becomes "unknown"');

  section('Both POSIX agents parse in every shell');
  for (const [name, text] of [['macOS', agent], ['Linux', buildLinuxAgentScript('0.33.0')]]) {
    const f = path.join(TMP, `${name}.sh`); fs.writeFileSync(f, text);
    for (const [label, [bin, ...pre]] of [['sh', ['sh']], ...SHELLS]) {
      const r = spawnSync(bin, [...pre, '-n', f], { encoding: 'utf8' });
      check(r.status === 0, `${name} agent: ${label} -n`, r.stderr);
    }
  }
  if (!SHELLS.some(([l]) => l.startsWith('zsh'))) console.log('  (zsh not found: set ZSH_BIN to include its sh emulation)');
} finally {
  fs.rmSync(TMP, { recursive: true, force: true });
}
console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
