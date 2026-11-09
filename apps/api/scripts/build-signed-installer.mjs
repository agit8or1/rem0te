#!/usr/bin/env node
// Writes the signed-variant Windows installer for the release signer to add as
// target `windows/install.ps1`:
//
//   cd apps/api && npx nest build
//   node scripts/build-signed-installer.mjs --out /path/to/release/install.ps1
//
// The output is deterministic for a given source tree and version, so anyone
// can rebuild it from the release tag and compare its SHA-256 with the one in
// signed targets metadata. That comparison is what makes the signed script
// reviewable: the signer signs what the tagged source produces, not a file
// someone handed them.
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const { buildSignedWindowsScript } = require(join(here, '..', 'dist', 'public', 'windows-script.js'));
const out = process.argv[process.argv.indexOf('--out') + 1];
if (!process.argv.includes('--out') || !out) {
  console.error('usage: node scripts/build-signed-installer.mjs --out FILE');
  process.exit(2);
}
const { version } = JSON.parse(readFileSync(join(here, '..', '..', '..', 'version.json'), 'utf8'));
const script = buildSignedWindowsScript(version);
writeFileSync(out, script);
console.log(`wrote ${out}\nagent version ${version}\nsha256 ${createHash('sha256').update(script).digest('hex')}`);
