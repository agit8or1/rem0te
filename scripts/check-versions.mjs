#!/usr/bin/env node
/**
 * Every version string in the repo must agree.
 *
 * v0.8.0 shipped with apps/api/package.json still on 0.7.1 — a stray
 * `git checkout` reverted the bump and nothing noticed, because nothing was
 * looking. This looks.
 */
import { readFileSync } from 'fs';

const FILES = [
  'version.json',
  'package.json',
  'apps/api/package.json',
  'apps/web/package.json',
];

const found = FILES.map((f) => {
  const version = JSON.parse(readFileSync(new URL(`../${f}`, import.meta.url), 'utf8')).version;
  return { file: f, version };
});

const distinct = [...new Set(found.map((f) => f.version))];

for (const { file, version } of found) {
  console.log(`  ${version.padEnd(10)} ${file}`);
}

if (distinct.length !== 1) {
  console.error(`\n✗ Version mismatch — ${distinct.length} distinct values: ${distinct.join(', ')}`);
  process.exit(1);
}

console.log(`\n✓ All version strings agree on ${distinct[0]}`);
