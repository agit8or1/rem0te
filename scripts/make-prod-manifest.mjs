#!/usr/bin/env node
// Generates the API's production manifest — the package.json that lives at
// /opt/reboot-remote/api and drives `npm install --omit=dev` on the target.
//
// Why generate it: it used to be maintained by hand, and it drifted. By
// v0.18.12 the target was running zod 3.25, ioredis 5.10, helmet 7.2 and
// @anthropic-ai/sdk 0.52 while `dist` was being compiled against zod 4,
// ioredis 6, helmet 8 and sdk 0.125. Nothing caught it: `dist` carries no
// dependencies, so new code lands on old libraries and only fails on the next
// restart, which may be an unattended reboot.
//
// It is generated rather than copied because apps/api/package.json cannot be
// used as-is: its devDependencies carry an eslint 9 / @eslint/js 10 peer
// conflict that pnpm tolerates and npm refuses outright, so `npm install
// --omit=dev` at the target dies on dependencies the target will never
// install.
//
//   node scripts/make-prod-manifest.mjs            # print
//   node scripts/make-prod-manifest.mjs -o FILE    # write
//
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const api = JSON.parse(readFileSync(join(root, 'apps/api/package.json'), 'utf8'));
const workspace = readFileSync(join(root, 'pnpm-workspace.yaml'), 'utf8');

// The repo has no yaml parser at the root and the other scripts here read this
// file with regexes rather than add one. The `overrides:` block is a flat map
// of quoted key to quoted value, so a line scanner is enough — and it stops at
// the next top-level key, which is what keeps `allowBuilds` out.
function readOverridesBlock(text) {
  const out = {};
  let inside = false;
  for (const raw of text.split('\n')) {
    if (/^overrides:\s*$/.test(raw)) { inside = true; continue; }
    if (!inside) continue;
    if (/^\S/.test(raw)) break;                       // next top-level key
    const line = raw.replace(/^\s+/, '');
    if (line === '' || line.startsWith('#')) continue;
    const m = /^'([^']+)'\s*:\s*'([^']+)'\s*$/.exec(line);
    if (!m) throw new Error(`unparsed override line: ${raw}`);
    out[m[1]] = m[2];
  }
  if (Object.keys(out).length === 0) throw new Error('no overrides parsed from pnpm-workspace.yaml');
  return out;
}
const wsOverrides = readOverridesBlock(workspace);

// pnpm keys an override by name or by `name@range`; npm only understands the
// name. The range form exists to spare a package that is unaffected by the
// advisory (ajv 6, see pnpm-workspace.yaml) — and the only consumer that needs
// sparing is eslint, which is a devDependency and never installed here.
const overrides = {};
for (const [key, value] of Object.entries(wsOverrides)) {
  const at = key.lastIndexOf('@');
  overrides[at > 0 ? key.slice(0, at) : key] = value;
}

// The prisma CLI is a devDependency in the workspace, but the target runs
// `prisma generate` after every install. Without it pinned here, npx fetches
// whatever prisma is newest and generates a client the installed
// @prisma/client cannot load. Pin it to the client's own range.
const prismaRange = api.dependencies['@prisma/client'];

const dependencies = { ...api.dependencies, prisma: prismaRange };

// npm rejects an override for a package that is also a direct dependency
// (EOVERRIDE) — it will not let the two disagree silently. pnpm has no such
// rule, so the overrides list contains pins for packages this manifest depends
// on directly: multer is pinned >=2.2.0 and depended on at ^2.4.0, nanoid is
// pinned >=5.1.7 and depended on at ^5.0.7.
//
// Dropping those overrides would be the easy fix and the wrong one: ^5.0.7
// admits 5.0.7, which is the version the advisory is about. So the pin moves
// into the dependency range as an intersection — `^5.0.7 >=5.1.7` is a single
// semver range satisfied only by versions in both — and the override is
// removed, which is the one form npm accepts without losing the pin.
const intersected = [];
for (const name of Object.keys(dependencies)) {
  if (!(name in overrides)) continue;
  dependencies[name] = `${dependencies[name]} ${overrides[name]}`;
  delete overrides[name];
  intersected.push(`${name} -> ${dependencies[name]}`);
}
if (process.env.VERBOSE) for (const line of intersected) console.error(`  pin folded into dependency: ${line}`);

const manifest = {
  name: 'api',
  version: api.version,
  private: true,
  scripts: { start: 'node dist/main', prisma: 'prisma' },
  dependencies,
  overrides,
};

const out = JSON.stringify(manifest, null, 2) + '\n';
const flag = process.argv.indexOf('-o');
if (flag !== -1 && process.argv[flag + 1]) {
  writeFileSync(process.argv[flag + 1], out);
  console.log(`wrote ${process.argv[flag + 1]}`);
} else {
  process.stdout.write(out);
}
