#!/usr/bin/env node
// Writes the signed-variant Windows installer for the release signer to add as
// target `windows/install.ps1`:
//
//   cd apps/api && npx nest build
//   node scripts/build-signed-installer.mjs --out /path/to/release/install.ps1
//
// or, with no build (0.37, what `rem0te-signed-publish` runs against a
// `git archive` copy that has no node_modules and no dist):
//
//   node scripts/build-signed-installer.mjs --from-source --typescript DIR --out FILE|-
//
// --from-source transpiles src/public/windows-script.ts on its own with the
// TypeScript package at DIR. That file imports nothing, which is checked: if it
// ever does, this mode refuses rather than build half a module. `--out -`
// writes the script to stdout and the summary to stderr.
//
// The output is deterministic for a given source tree and version, so anyone
// can rebuild it from the release tag and compare its SHA-256 with the one in
// signed targets metadata. That comparison is what makes the signed script
// reviewable: the signer signs what the tagged source produces, not a file
// someone handed them. Both modes produce the same bytes (e2e-signed-release
// checks it).
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const argv = process.argv.slice(2);
const opt = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
const out = opt('--out');
if (!out) {
  console.error('usage: node scripts/build-signed-installer.mjs [--from-source --typescript DIR] --out FILE|-');
  process.exit(2);
}

function fromSource() {
  const tsDir = opt('--typescript');
  const ts = require(tsDir ? resolve(tsDir) : 'typescript');
  const src = readFileSync(join(here, '..', 'src', 'public', 'windows-script.ts'), 'utf8');
  const js = ts.transpileModule(src, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2021 } }).outputText;
  if (/\brequire\s*\(/.test(js)) throw new Error('src/public/windows-script.ts now imports a module: --from-source cannot build it on its own');
  const mod = { exports: {} };
  new Function('module', 'exports', js)(mod, mod.exports);
  return mod.exports;
}

const { buildSignedWindowsScript } = argv.includes('--from-source')
  ? fromSource()
  : require(join(here, '..', 'dist', 'public', 'windows-script.js'));
const { version } = JSON.parse(readFileSync(join(here, '..', '..', '..', 'version.json'), 'utf8'));
// A UTF-8 byte-order mark first (0.37.1). The agent runs this file with
// `powershell.exe -File`, and Windows PowerShell 5.1 reads a BOM-less script
// as the ANSI code page: an em dash's last byte (0x94) becomes U+201D, which
// PowerShell takes for a closing quote, so the script fails to parse and exits
// 1 before running a line. PowerShell 7 (the tests) reads UTF-8 either way.
// The BOM is part of the signed bytes.
const script = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(buildSignedWindowsScript(version), 'utf8')]);
const summary = `agent version ${version}\nsha256 ${createHash('sha256').update(script).digest('hex')}`;
if (out === '-') {
  process.stdout.write(script);
  console.error(`wrote install.ps1 to stdout\n${summary}`);
} else {
  writeFileSync(out, script);
  console.log(`wrote ${out}\n${summary}`);
}
