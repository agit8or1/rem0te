#!/usr/bin/env node
// repo-info.mjs DIR summary|target NAME|prune-list
//
// Reads a signed update repository (metadata/ and targets/) the way the
// portal's status page does: unverified, as served. The rem0te-signed-*
// commands use it for decisions that are safe to take on unverified data —
// "is this version older than what is published", "which old files may be
// removed", "when does the timestamp expire" — and never for anything an
// agent trusts: agents verify every byte themselves.
//
// Output is KEY=VALUE lines whose values are checked against narrow
// charsets, so the shell that reads them never sees anything else.
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

const [dir, cmd, arg] = process.argv.slice(2);
if (!dir || !cmd) { console.error('usage: repo-info.mjs DIR summary|target NAME|prune-list'); process.exit(2); }

const read = (f) => { try { return JSON.parse(readFileSync(path.join(dir, 'metadata', f), 'utf8')); } catch { return null; } };
const VERSION_RE = /^\d+\.\d+\.\d+$/;
const COMMIT_RE = /^[0-9a-f]{40}$/;
const SHA_RE = /^[0-9a-f]{64}$/;
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;

function chain(read) {
  const root = read('root.json');
  const ts = read('timestamp.json');
  const snapV = Number(ts?.signed?.meta?.['snapshot.json']?.version) || 0;
  const snap = snapV ? read(`${snapV}.snapshot.json`) : null;
  const tgV = Number(snap?.signed?.meta?.['targets.json']?.version) || 0;
  const targets = tgV ? read(`${tgV}.targets.json`) : null;
  return { root, ts, snap, targets, tgV };
}

/** Target files (relative to the repository) that a targets document lists. */
function referenced(targetsDoc) {
  const out = new Set();
  for (const [name, t] of Object.entries(targetsDoc?.signed?.targets ?? {})) {
    const sha = t?.hashes?.sha256;
    if (typeof sha !== 'string' || !SHA_RE.test(sha)) continue;
    const segs = name.split('/');
    segs[segs.length - 1] = `${sha}.${segs[segs.length - 1]}`;
    out.add(['targets', ...segs].join('/'));
  }
  return out;
}

function walk(rel, out = []) {
  const abs = path.join(dir, rel);
  if (!existsSync(abs)) return out;
  for (const n of readdirSync(abs)) {
    const r = `${rel}/${n}`;
    if (statSync(path.join(dir, r)).isDirectory()) walk(r, out); else out.push(r);
  }
  return out;
}

const c = chain(read);
const now = Date.now();
const expires = (doc) => { const e = String(doc?.signed?.expires ?? ''); return ISO_RE.test(e) ? e : ''; };
const hoursLeft = (doc) => { const e = expires(doc); return e ? Math.floor((Date.parse(e) - now) / 3600_000) : ''; };
const entry = (name) => c.targets?.signed?.targets?.[name];

if (cmd === 'summary') {
  const lines = {};
  lines.CONFIGURED = c.root && c.ts && c.snap && c.targets ? 1 : 0;
  for (const [k, doc] of [['ROOT', c.root], ['TARGETS', c.targets], ['SNAPSHOT', c.snap], ['TIMESTAMP', c.ts]]) {
    lines[`${k}_VERSION`] = Number(doc?.signed?.version) || '';
    lines[`${k}_EXPIRES`] = expires(doc);
    lines[`${k}_LEFT_H`] = hoursLeft(doc);
  }
  const agent = entry('windows/rem0te-agent.exe');
  const tray = entry('windows/rem0te-tray.exe');
  const inst = entry('windows/install.ps1');
  const v = String(agent?.custom?.version ?? '');
  const cm = String(agent?.custom?.commit ?? '');
  lines.AGENT_VERSION = VERSION_RE.test(v) ? v : '';
  lines.AGENT_COMMIT = COMMIT_RE.test(cm) ? cm : '';
  lines.AGENT_SHA256 = SHA_RE.test(agent?.hashes?.sha256 ?? '') ? agent.hashes.sha256 : '';
  const tv = String(tray?.custom?.version ?? '');
  lines.TRAY_VERSION = VERSION_RE.test(tv) ? tv : (tray ? 'unversioned' : '');
  lines.INSTALLER_SHA256 = SHA_RE.test(inst?.hashes?.sha256 ?? '') ? inst.hashes.sha256 : '';
  const ak = entry('approval/keys.json');
  lines.APPROVAL_KEYS_SHA256 = SHA_RE.test(ak?.hashes?.sha256 ?? '') ? ak.hashes.sha256 : '';
  lines.RUSTDESK_VERSIONS = Object.keys(c.targets?.signed?.targets ?? {})
    .map((n) => /^windows\/rustdesk\/rustdesk-(\d+\.\d+\.\d+)-x86_64\.exe$/.exec(n)?.[1]).filter(Boolean).join(',');
  for (const [k, val] of Object.entries(lines)) console.log(`${k}=${val}`);
} else if (cmd === 'target') {
  const sha = entry(String(arg ?? ''))?.hashes?.sha256;
  if (typeof sha === 'string' && SHA_RE.test(sha)) console.log(sha);
} else if (cmd === 'prune-list') {
  if (!c.targets) process.exit(0); // nothing trustworthy to keep by: remove nothing
  const keep = referenced(c.targets);
  const prev = c.tgV > 1 ? read(`${c.tgV - 1}.targets.json`) : null;
  for (const f of referenced(prev)) keep.add(f);
  for (const f of walk('targets')) if (!keep.has(f)) console.log(f);
} else {
  console.error(`unknown command ${cmd}`); process.exit(2);
}
