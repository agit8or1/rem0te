#!/usr/bin/env node
// Windows lab (0.68.3): merge the lab's parts into lab-evidence.json and a
// Markdown summary.
//
//   node tools/lab/merge-evidence.mjs <parts dir> <out dir>
//
// Parts, each from one Windows runner:
//   rustdesk-<version>.json  rustdesk-lab.ps1's result for one RustDesk release
//   go-evidence.jsonl        one line per Go lab test (internal/labevidence)
//   go-os.json               the Go runner's Windows edition and build
//   preflight-evidence-<v>.jsonl  the agent's RustDesk preflight (0.69.0) against release <v>
//
// Every result is { id, status: pass|fail|skip, detail, real, os }. For the
// RustDesk rows, "fail" means RustDesk did not do what was asked — a finding,
// not a broken lab. A broken lab is a part that says so ("broken"), or a part
// that is missing: those make this script exit 1.

import { readFileSync, readdirSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const [partsDir, outDir] = process.argv.slice(2);
if (!partsDir || !outDir) {
  console.error('usage: merge-evidence.mjs <parts dir> <out dir>');
  process.exit(2);
}
mkdirSync(outDir, { recursive: true });

// Parts may be nested one directory deep (one per downloaded artifact).
function walk(dir) {
  const out = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p));
    else out.push(p);
  }
  return out;
}
const files = existsSync(partsDir) ? walk(partsDir) : [];
const readJson = (p) => JSON.parse(readFileSync(p, 'utf8').replace(/^﻿/, ''));

const results = [];
const runners = [];
const problems = [];
const rustdesk = {};

const osOf = (o) => (o ? { caption: o.caption, version: o.version, build: o.build, ubr: o.ubr ?? null } : null);
const add = (id, status, detail, os, real = true) => results.push({ id, status, detail, real: status === 'skip' ? false : real, os });
const q = (s) => JSON.stringify(s ?? null);

// ── RustDesk ────────────────────────────────────────────────────────────────
const KEYS = ['access-mode', 'enable-keyboard', 'enable-clipboard', 'enable-file-transfer', 'enable-audio', 'enable-tunnel',
  'enable-remote-restart', 'approve-mode', 'verification-method', 'allow-auto-disconnect', 'auto-disconnect-timeout'];
const CALLERS = ['system', 'admin'];

for (const f of files.filter((p) => /rustdesk-[^/\\]+\.json$/.test(p))) {
  const part = readJson(f);
  const v = part.version;
  const os = osOf(part.os);
  rustdesk[v] = part;
  runners.push({ job: `rustdesk ${v}`, os });
  const d = part.download ?? {};
  if (d.verified) add(`rustdesk/${v}/download`, 'pass', `sha256 matches GitHub's published ${d.publishedDigest}; Authenticode ${d.authenticode?.status} (${d.authenticode?.subject ?? 'no signer'})`, os);
  else add(`rustdesk/${v}/download`, 'fail', d.reason ?? 'not downloaded', os);
  if (!d.verified) {
    for (const c of CALLERS) add(`rustdesk/${v}/${c}`, 'skip', 'not installed: ' + (d.reason ?? 'download not verified'), os);
    continue;
  }
  if (part.broken) problems.push(`rustdesk ${v}: ${part.broken}`);
  const ins = part.install ?? {};
  add(`rustdesk/${v}/install`, ins.serverUp ? 'pass' : 'fail',
    `--silent-install in ${ins.seconds} s; file version ${ins.fileVersion}; service ${ins.service}; server process ${ins.serverUp}; service command line ${q(ins.servicePath)}`, os);
  for (const c of CALLERS) {
    const p = part.probes?.[c];
    if (!p) {
      add(`rustdesk/${v}/${c}`, 'fail', 'no probe result', os);
      problems.push(`rustdesk ${v}: no ${c} probe result`);
      continue;
    }
    const who = `${p.identity} (system ${p.isSystem}, elevated ${p.elevated}, session ${p.session})`;
    if (!p.complete) problems.push(`rustdesk ${v} ${c}: probe incomplete: ${p.fatal}`);
    const r0 = p.readRendezvous ?? {};
    add(`rustdesk/${v}/${c}/read`, r0.matches ? 'pass' : 'fail',
      `as ${who}: --option custom-rendezvous-server returned ${q(r0.value)} (exit ${r0.call?.exitCode}${r0.call?.timedOut ? ', timed out' : ''}${r0.call?.stderr ? ', stderr ' + q(r0.call.stderr) : ''})`, os);
    for (const k of KEYS) {
      const o = p.options?.[k];
      if (!o) {
        add(`rustdesk/${v}/${c}/option/${k}`, 'fail', 'not probed (the probe stopped early)', os);
        continue;
      }
      const files = (fs) => Object.entries(fs ?? {}).map(([n, x]) => `${n}=${x === null ? 'no file' : q(x)}`).join(' ');
      add(`rustdesk/${v}/${c}/option/${k}`, o.matches ? 'pass' : 'fail', [
        `set ${q(o.want)} (exit ${o.set?.exitCode}${o.set?.timedOut ? ', timed out' : ''}${o.set?.stdout ? ', said ' + q(o.set.stdout) : ''}${o.set?.stderr ? ', stderr ' + q(o.set.stderr) : ''})`,
        `before ${q(o.before)}, read back ${q(o.readback)}`,
        `files ${files(o.files)}`,
        `5 s later ${q(o.after5s)} (${o.after5sMatches ? 'held' : 'not held'})`,
        `after restart ${q(o.afterRestart)} (${o.afterRestartMatches ? 'held' : 'not held'}; files ${files(o.filesAfterRestart)})`,
        `second value ${q(o.second?.want)} read back ${q(o.second?.readback)} (${o.second?.matches ? 'took' : 'did not take'})`,
      ].join('; '), os);
    }
    const pw = p.password;
    if (pw) {
      const changed = Object.entries(pw.storedLineChanged ?? {}).filter(([, x]) => x).map(([n]) => n);
      const ok = pw.saidDone || changed.includes('localService') || changed.includes('systemProfile');
      add(`rustdesk/${v}/${c}/password`, ok ? 'pass' : 'fail',
        `--password exit ${pw.call?.exitCode}${pw.call?.timedOut ? ' (timed out)' : ''}, output ${q(pw.call?.stdout)}${pw.call?.stderr ? ', stderr ' + q(pw.call.stderr) : ''}; stored password line changed in: ${changed.length ? changed.join(', ') : 'none'} (password itself never recorded)`, os);
    } else add(`rustdesk/${v}/${c}/password`, 'fail', 'not probed', os);
    const ss = p.stopService;
    if (ss) {
      const procs = (st) => `service ${st?.service}, processes ${(st?.processes ?? []).map((x) => `${x.mode}@s${x.session}`).join(',') || 'none'}`;
      add(`rustdesk/${v}/${c}/stop-service`, ss.yMatches && ss.nMatches ? 'pass' : 'fail',
        `Y: exit ${ss.setY?.exitCode}, read ${q(ss.readY)}, 8 s later ${q(ss.readY8s)}, ${procs(ss.stateAfterY)}; N: exit ${ss.setN?.exitCode}, read ${q(ss.readN)}, ${procs(ss.stateAfterN)}, server back ${ss.serverBackAfterN}`, os);
    } else add(`rustdesk/${v}/${c}/stop-service`, 'fail', 'not probed', os);
    const lv = p.live;
    if (lv) {
      const files = (fs) => Object.entries(fs ?? {}).map(([n, x]) => `${n}=${x === null ? 'no file' : q(x)}`).join(' ');
      add(`rustdesk/${v}/${c}/live/direct-server-reaches-running-server`, lv.listenerAppeared ? 'pass' : 'fail',
        `--option direct-server Y (exit ${lv.setOn?.exitCode}); the running server ${lv.listenerAppeared ? `opened its 21118 listener after ${lv.appearMs} ms` : 'opened no 21118 listener within 30 s'}; files ${files(lv.filesOn)}${lv.before ? '; a listener was already open before' : ''}`, os);
      if (lv.listenerAppeared) {
        add(`rustdesk/${v}/${c}/live/stop-service-Y-stops-serving`, lv.stopServiceClosed ? 'pass' : 'fail',
          `--option stop-service Y (exit ${lv.stopY?.exitCode}): ${lv.stopServiceClosed ? `listener closed after ${lv.stopServiceCloseMs} ms` : 'listener still open after 30 s'}; then service ${lv.stateAfterStop?.service}, processes ${(lv.stateAfterStop?.processes ?? []).map((x) => `${x.mode}@s${x.session}`).join(',') || 'none'}`, os);
        add(`rustdesk/${v}/${c}/live/stop-service-N-resumes`, lv.stopServiceNReopened ? 'pass' : 'fail',
          `--option stop-service N (exit ${lv.stopN?.exitCode}): ${lv.stopServiceNReopened ? `listener back after ${lv.stopServiceReopenMs} ms` : 'no listener within 45 s'}`, os);
        add(`rustdesk/${v}/${c}/live/direct-server-N`, lv.offClosed ? 'pass' : 'fail',
          `--option direct-server N (exit ${lv.setOff?.exitCode}): ${lv.offClosed ? `listener closed after ${lv.offCloseMs} ms` : 'listener still open after 30 s'}`, os);
      }
    } else add(`rustdesk/${v}/${c}/live/direct-server-reaches-running-server`, 'fail', 'not probed', os);
    const ct = p.control;
    if (ct) {
      const files = (fs) => Object.entries(fs ?? {}).map(([n, x]) => `${n}=${x === null ? 'no file' : q(x)}`).join(' ');
      add(`rustdesk/${v}/${c}/control/copied-exe-reaches-running-server`, ct.listenerAppeared ? 'pass' : 'fail',
        `negative control: the same RustDesk files copied to another directory, run as this caller: --option direct-server Y (exit ${ct.setOn?.exitCode}${ct.setOn?.stdout ? ', said ' + q(ct.setOn.stdout) : ''}); the running server ${ct.listenerAppeared ? `opened its listener after ${ct.appearMs} ms (the copy was accepted)` : 'opened no listener within 30 s (the copy was refused or did not reach it)'}; files ${files(ct.filesOn)}`, os);
    }
    const rs = p.restart;
    if (rs) add(`rustdesk/${v}/${c}/service-restart`, rs.restarted && rs.ipcBackWithin60s ? 'pass' : 'fail',
      `Restart-Service as this caller: ${rs.restarted ? 'done' : 'refused ' + q(rs.error)}; command line answered again within 60 s: ${rs.ipcBackWithin60s}`, os);
  }
  const net = part.network ?? {};
  add(`rustdesk/${v}/network/no-off-host-connections`, (net.offHost ?? []).length === 0 ? 'pass' : 'fail',
    `${(net.rustdeskConnections ?? []).length} TCP connections held by rustdesk.exe at the end, ${(net.offHost ?? []).length} to an address that is not loopback ${q(net.offHost)}; firewall drop events naming rustdesk: ${net.firewallBlocks}`, os);
}

// ── The agent's RustDesk preflight (0.69.0), one file per installed release ──
for (const f of files.filter((p) => /preflight-evidence-[^/\\]+\.jsonl$/.test(p))) {
  const v = f.match(/preflight-evidence-([^/\\]+)\.jsonl$/)[1];
  const os = osOf(rustdesk[v]?.os);
  for (const line of readFileSync(f, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    const r = JSON.parse(line);
    add(r.id, r.status, r.detail, os, r.real);
  }
}
for (const v of Object.keys(rustdesk)) {
  if (rustdesk[v].download?.verified && !files.some((p) => p.endsWith(`preflight-evidence-${v}.jsonl`))) {
    problems.push(`rustdesk ${v}: no agent preflight evidence (preflight-evidence-${v}.jsonl)`);
  }
}

// ── Go ───────────────────────────────────────────────────────────────────────
const goOsFile = files.find((p) => /go-os\.json$/.test(p));
const goOs = goOsFile ? osOf(readJson(goOsFile)) : null;
if (goOs) runners.push({ job: 'go', os: goOs });
const goFile = files.find((p) => /go-evidence\.jsonl$/.test(p));
if (goFile) {
  for (const line of readFileSync(goFile, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    const r = JSON.parse(line);
    add(r.id, r.status, r.detail, goOs, r.real);
  }
} else problems.push('no Go lab evidence (go-evidence.jsonl)');

const evidence = {
  schema: 'rem0te-lab-evidence/1',
  generatedAt: new Date().toISOString(),
  commit: process.env.GITHUB_SHA ?? null,
  run: process.env.GITHUB_RUN_ID ? `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}` : null,
  runners,
  counts: ['pass', 'fail', 'skip'].reduce((a, s) => ({ ...a, [s]: results.filter((r) => r.status === s).length }), {}),
  problems,
  results,
  rustdesk,
};
writeFileSync(join(outDir, 'lab-evidence.json'), JSON.stringify(evidence, null, 2));

// ── Summary ─────────────────────────────────────────────────────────────────
const md = [];
md.push('# Windows lab evidence', '');
for (const r of runners) md.push(`- ${r.job}: ${r.os?.caption} ${r.os?.version} (build ${r.os?.build}.${r.os?.ubr})`);
md.push('', `Results: ${evidence.counts.pass} pass, ${evidence.counts.fail} fail, ${evidence.counts.skip} skip.`, '');
if (problems.length) md.push('**Lab problems:**', ...problems.map((p) => `- ${p}`), '');
const versions = Object.keys(rustdesk).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
if (versions.length) {
  md.push('## RustDesk: set with `--option`, read back with `--option`', '',
    '`ok` = the value read back is the value set; `no` = it was not (the value read back follows). `held` columns count keys still matching 5 s later / after a service restart.', '');
  const short = { 'access-mode': 'access', 'enable-keyboard': 'kbd', 'enable-clipboard': 'clip', 'enable-file-transfer': 'file', 'enable-audio': 'audio', 'enable-tunnel': 'tunnel', 'enable-remote-restart': 'restart', 'approve-mode': 'approve', 'verification-method': 'verify', 'allow-auto-disconnect': 'autodisc', 'auto-disconnect-timeout': 'timeout' };
  md.push(`| version | caller | read | ${KEYS.map((k) => short[k]).join(' | ')} | held 5 s | held restart | 2nd value | password | stop-service readback | live: server took direct-server | live: stop-service Y closes / N reopens | control: copied exe reaches server |`);
  md.push(`|${'---|'.repeat(KEYS.length + 11)}`);
  for (const v of versions) {
    const part = rustdesk[v];
    if (!part.download?.verified) {
      md.push(`| ${v} | — | ${part.download?.reason ?? 'not downloaded'} |${' |'.repeat(KEYS.length + 8)}`);
      continue;
    }
    for (const c of CALLERS) {
      const p = part.probes?.[c];
      if (!p) { md.push(`| ${v} | ${c} | no result |${' |'.repeat(KEYS.length + 8)}`); continue; }
      const cells = KEYS.map((k) => { const o = p.options?.[k]; return !o ? '—' : o.matches ? 'ok' : `no ${q(o.readback).slice(0, 40)}`; });
      const cnt = (f) => `${KEYS.filter((k) => p.options?.[k]?.[f]).length}/${KEYS.length}`;
      const pw = p.password;
      const pwc = pw ? `exit ${pw.call?.exitCode} ${pw.saidDone ? '"Done"' : q(pw.call?.stdout).slice(0, 30)}; stored ${Object.entries(pw.storedLineChanged ?? {}).filter(([, x]) => x).map(([n]) => n).join('+') || 'unchanged'}` : '—';
      const ss = p.stopService;
      const ssc = ss ? `Y→${q(ss.readY)} N→${q(ss.readN)} server back ${ss.serverBackAfterN}` : '—';
      const lv = p.live;
      const live = !lv ? '—' : lv.listenerAppeared ? `yes (${lv.appearMs} ms)` : 'no';
      const stop = !lv?.listenerAppeared ? '—' : `${lv.stopServiceClosed ? 'closes' : 'stays open'} / ${lv.stopServiceNReopened ? 'reopens' : 'stays closed'}`;
      const ctl = !p.control ? '—' : p.control.listenerAppeared ? 'yes (accepted)' : 'no (refused)';
      md.push(`| ${v} | ${c} | ${p.readRendezvous?.matches ? 'ok' : 'no ' + q(p.readRendezvous?.value).slice(0, 40)} | ${cells.join(' | ')} | ${cnt('after5sMatches')} | ${cnt('afterRestartMatches')} | ${KEYS.filter((k) => p.options?.[k]?.second?.matches).length}/${KEYS.length} | ${pwc} | ${ssc} | ${live} | ${stop} | ${ctl} |`);
    }
  }
  md.push('');
}
md.push('## Every result', '', '| id | status | detail |', '|---|---|---|');
for (const r of results) md.push(`| ${r.id} | ${r.status} | ${String(r.detail ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ').slice(0, 600)} |`);
writeFileSync(join(outDir, 'summary.md'), md.join('\n') + '\n');
console.log(md.slice(0, 40).join('\n'));
if (problems.length) {
  console.error('\nlab problems:\n' + problems.join('\n'));
  process.exit(1);
}
