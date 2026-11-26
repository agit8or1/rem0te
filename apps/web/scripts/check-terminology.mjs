#!/usr/bin/env node
// The console says "customer" and "device" (0.87.1, UX_ROADMAP.md P1-1).
//
//   node apps/web/scripts/check-terminology.mjs          # check
//   node apps/web/scripts/check-terminology.mjs --list   # every allowed occurrence too
//
// Reads every .ts / .tsx under apps/web/{app,components,lib}, finds the text a
// person reads (scripts/lib/visible-text.mjs: JSX text, and string or template
// literals that are prose and not in a code position) and fails on the words
// "business", "computer" and "endpoint" in it, except:
//
//   - the phrases in scripts/lib/terminology.mjs's KEEP_PHRASES (role names,
//     other vendors' names, an HTTP endpoint, an evidence statement), and
//   - the files and properties in ALLOWED below, each with its reason.
//
// It also fails on a menu path 0.87 retired ("Settings → Security → …"),
// because a sentence that sends someone to a menu that is not there is the
// same kind of drift (decision N4).
//
// Pure: the workspace's TypeScript parses, nothing runs. A self-test of the
// scanner runs first, so a parser change that stops it seeing text fails here
// rather than passing everything.

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { visibleTexts } from './lib/visible-text.mjs';
import { oldTerms, STALE_PATHS } from './lib/terminology.mjs';

const WEB = join(dirname(fileURLToPath(import.meta.url)), '..');
const list = process.argv.includes('--list');

/** Whole files or properties allowed to keep the old words, and why. */
const ALLOWED = [
  // Owner decision (0.87.1): pages for the person at the computer, not the
  // console. They are not signed in, the word "computer" is theirs, and
  // "customer" is what they are, not what they read.
  { file: /^app\/(download|quick|support|verify-email)\//, why: 'public page for the person at the computer' },
  // MDM M5 (0.88) is changing these pages; their wording is the follow-up
  // listed in CHANGELOG 0.87.1.
  { file: /(^|\/)mobile-devices\//, why: 'MDM pages: follow-up after M5' },
  { file: /^components\/mobile\//, why: 'MDM pages: follow-up after M5' },
  // Generated from docs/*.md; the docs are worded at the source.
  { file: /\.generated\.ts$/, why: 'generated' },
  // Search keywords: the old words still find the page.
  { prop: 'keywords', why: 'palette search keywords' },
];

const CODE_TAGS = new Set(['code', 'pre', 'kbd', 'samp']);

function allowed(rel, t) {
  return ALLOWED.find((a) => (a.file && a.file.test(rel)) || (a.prop && t.prop === a.prop));
}

function* walk(d) {
  for (const f of readdirSync(d)) {
    if (f === 'node_modules' || f.startsWith('.')) continue;
    const p = join(d, f);
    if (statSync(p).isDirectory()) yield* walk(p);
    else if (/\.tsx?$/.test(f)) yield p;
  }
}

/** Violations in one source text. */
export function scan(rel, src) {
  const bad = [];
  for (const t of visibleTexts(rel, src)) {
    // A command line or an identifier set in <code> is code: `--business` is a CLI flag.
    if (CODE_TAGS.has(t.tag)) continue;
    const a = allowed(rel, t);
    const words = oldTerms(t.text);
    const paths = STALE_PATHS.filter((p) => p.re.test(t.text));
    if (!words.length && !paths.length) continue;
    if (a) { if (list) console.log(`  allowed (${a.why}) ${rel}:${t.line} ${t.text.trim().slice(0, 100)}`); continue; }
    for (const w of words) bad.push({ rel, line: t.line, what: `"${w.word}"`, text: t.text });
    for (const p of paths) bad.push({ rel, line: t.line, what: `a retired menu path (now ${p.now})`, text: t.text });
  }
  return bad;
}

// ── Self-test: the scanner sees text and leaves code alone. ───────────────
{
  const fixture = [
    "import { businessApi } from '@/lib/business';",
    "const q = { queryKey: ['businesses'], kind: 'business' };",
    "if (x.kind === 'computer') go(`/businesses/${id}`);",
    "export function A() {",
    "  return <div className=\"computer\" data-testid=\"business-row\" title=\"Open this business\">",
    "    Add a computer{' '}<b>{`${n} computers`}</b>",
    "    <a href=\"/endpoints\">Computer name</a> <i>{toast('Saved for every endpoint.')}</i>",
    "    <p>Ask the Business Owner. See Settings → Security → Containment.</p><code>policy set --business default</code>",
    "  </div>;",
    "}",
  ].join('\n');
  const got = scan('fixture.tsx', fixture).map((b) => `${b.line}:${b.what}`);
  const want = ['5:"business"', '6:"computer"', '6:"computers"', '7:"endpoint"', '8:a retired menu path (now Security → …)'];
  const ok = JSON.stringify([...got].sort()) === JSON.stringify([...want].sort());
  if (!ok) {
    console.error(`check-terminology: the scanner's self-test failed.\n  wanted ${JSON.stringify(want)}\n  got    ${JSON.stringify(got)}`);
    process.exit(2);
  }
}

const bad = [];
let files = 0;
for (const dir of ['app', 'components', 'lib']) {
  for (const f of walk(join(WEB, dir))) {
    files++;
    bad.push(...scan(relative(WEB, f), readFileSync(f, 'utf8')));
  }
}

if (bad.length) {
  console.error(`check-terminology: ${bad.length} visible text(s) use an old word or a retired menu path (${files} files).`);
  console.error('Use "customer" for a business and "device" for a computer or endpoint (docs/UI_DESIGN_SYSTEM.md, Words).');
  console.error('If the word is right where it is, add the phrase to KEEP_PHRASES in scripts/lib/terminology.mjs with its reason.\n');
  for (const b of bad) console.error(`  ${b.rel}:${b.line}  ${b.what}  ${b.text.replace(/\s+/g, ' ').trim().slice(0, 140)}`);
  process.exit(1);
}
console.log(`check-terminology: ${files} files, no old word in visible text (self-test passed).`);
