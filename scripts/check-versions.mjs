#!/usr/bin/env node
/**
 * Every version string in the repo must agree, and the release must be
 * documented.
 *
 * v0.8.0 shipped with apps/api/package.json still on 0.7.1 — a stray
 * `git checkout` reverted the bump and nothing noticed, because nothing was
 * looking. This looks.
 *
 * It also checks CHANGELOG.md, because the second half of the problem is a
 * version that never moves at all: a long run of changes went out under 0.8.2
 * with the work piling up under an "Unreleased" heading that nobody converted.
 * Requiring the current version to have its own heading means bumping and
 * writing it down are the same action, and neither can be skipped quietly.
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

const version = distinct[0];
console.log(`\n✓ All version strings agree on ${version}`);

// The current version must have a CHANGELOG section of its own. A heading that
// still says "Unreleased" means the work shipped without a version.
const changelog = readFileSync(new URL('../CHANGELOG.md', import.meta.url), 'utf8');
const heading = new RegExp(`^## \\[${version.replace(/\./g, '\\.')}\\]`, 'm');

if (!heading.test(changelog)) {
  console.error(
    `\n✗ CHANGELOG.md has no "## [${version}]" section.\n` +
    `  Every change bumps the version and records what changed. If the work is\n` +
    `  under "## [Unreleased]", give it a version and rename the heading.`,
  );
  process.exit(1);
}

console.log(`✓ CHANGELOG.md documents ${version}`);

// The README's version badge is a version string like any other, and it went
// five releases stale without anything noticing — it still read 0.13.9 at
// 0.18.1. It is the first version a visitor sees, so it is worth checking.
const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
const badge = readme.match(/img\.shields\.io\/badge\/version-([0-9][^-]*)-/);

if (!badge) {
  console.error(
    '\n✗ README.md has no version badge matching' +
    ' img.shields.io/badge/version-<version>-.\n' +
    '  If the badge was removed on purpose, remove this check with it.',
  );
  process.exit(1);
}

if (badge[1] !== version) {
  console.error(
    `\n✗ README.md version badge says ${badge[1]}, not ${version}.\n` +
    '  It is the first version a visitor sees. Update the badge URL.',
  );
  process.exit(1);
}

console.log(`✓ README.md badge shows ${version}`);
