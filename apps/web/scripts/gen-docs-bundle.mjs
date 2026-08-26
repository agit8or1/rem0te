#!/usr/bin/env node
/**
 * Turn docs/*.md into something the web app can render and search.
 *
 * The documentation lived only in the repository, which meant the people using
 * the product could not read it — the answer to "where are the docs" was a
 * GitHub URL. This compiles it into the app instead.
 *
 * Conversion happens here, at build time, so the running app ships no markdown
 * parser and no filesystem access: the output is a plain data module.
 */
import { readFileSync, writeFileSync, readdirSync, mkdirSync, copyFileSync, rmSync, statSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { marked } from 'marked';

// Lives in apps/web/scripts because that is the package that owns `marked`;
// ESM resolves dependencies from the script's own location, not the cwd.
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const DOCS = path.join(ROOT, 'docs');
const OUT = path.join(ROOT, 'apps/web/lib/docs-content.generated.ts');
// Screenshots are copied rather than committed twice. The directory is
// gitignored and rebuilt on every run, so a deleted screenshot cannot linger.
const IMG_SRC = path.join(DOCS, 'screenshots');
const IMG_OUT = path.join(ROOT, 'apps/web/public/docs-img');

// Order is the reading order, not alphabetical: someone landing here with a
// broken connection should meet troubleshooting before architecture.
const ORDER = [
  ['README.md', 'Overview'],
  ['troubleshooting.md', 'Troubleshooting'],
  ['technician-guide.md', 'Technician guide'],
  ['connecting.md', 'Connecting'],
  ['clients.md', 'Clients'],
  ['updates.md', 'Updates'],
  ['setup.md', 'Setup and operations'],
  ['architecture.md', 'Architecture'],
  ['access-control.md', 'Access control'],
  ['API-REFERENCE.md', 'API reference'],
  ['PUBLIC-API.md', 'API guide'],
  ['SECURITY-AUDIT.md', 'Security'],
];

const slugify = (s) =>
  s.toLowerCase().replace(/[^\w\s-]/g, '').trim().replace(/\s+/g, '-').slice(0, 80);

/** Plain text of a markdown string, for the search index. */
function toText(md) {
  return md
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`[^`]*`/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[#>*_|-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const renderer = new marked.Renderer();
// Headings get ids so the in-page contents can link to them.
renderer.heading = function ({ tokens, depth }) {
  const text = this.parser.parseInline(tokens);
  const id = slugify(text.replace(/<[^>]*>/g, ''));
  return `<h${depth} id="${id}">${text}</h${depth}>\n`;
};
// Screenshots live at docs/screenshots/…; the app serves them from /docs-img/.
renderer.image = ({ href, title, text }) => {
  const src = href.replace(/^(\.\/)?screenshots\//, '/docs-img/');
  return `<img src="${src}" alt="${text ?? ''}"${title ? ` title="${title}"` : ''} loading="lazy" />`;
};
// Links between documents become in-app routes; anything external opens away.
renderer.link = function ({ href, title, tokens }) {
  const text = this.parser.parseInline(tokens);
  const internal = /^[\w-]+\.md(#.*)?$/i.test(href);
  if (internal) {
    const [file, hash] = href.split('#');
    return `<a href="/docs/${file.replace(/\.md$/i, '').toLowerCase()}${hash ? `#${hash}` : ''}"${title ? ` title="${title}"` : ''}>${text}</a>`;
  }
  const external = /^https?:/.test(href);
  return `<a href="${href}"${external ? ' target="_blank" rel="noopener noreferrer"' : ''}${title ? ` title="${title}"` : ''}>${text}</a>`;
};

marked.use({ renderer, gfm: true, breaks: false });

function copyTree(from, to) {
  mkdirSync(to, { recursive: true });
  let n = 0;
  for (const entry of readdirSync(from)) {
    const src = path.join(from, entry);
    const dst = path.join(to, entry);
    if (statSync(src).isDirectory()) n += copyTree(src, dst);
    else if (/\.(png|jpe?g|svg|gif|webp)$/i.test(entry)) { copyFileSync(src, dst); n += 1; }
  }
  return n;
}
rmSync(IMG_OUT, { recursive: true, force: true });
const imageCount = copyTree(IMG_SRC, IMG_OUT);

const present = new Set(readdirSync(DOCS).filter((f) => f.endsWith('.md')));
const missing = ORDER.map(([f]) => f).filter((f) => !present.has(f));
if (missing.length) {
  console.error(`✗ listed in the bundle but not on disk: ${missing.join(', ')}`);
  process.exit(1);
}
const unlisted = [...present].filter((f) => !ORDER.some(([o]) => o === f));
if (unlisted.length) {
  // A new page that nobody added to ORDER would silently never appear in the
  // app — which is the failure this whole exercise started from.
  console.error(`✗ docs/ has pages missing from ORDER in ${path.relative(ROOT, OUT)}: ${unlisted.join(', ')}`);
  process.exit(1);
}

const pages = ORDER.map(([file, title]) => {
  const md = readFileSync(path.join(DOCS, file), 'utf8');
  const slug = file.replace(/\.md$/i, '').toLowerCase();

  // Split on h2 so search can point at a section rather than a whole page.
  const sections = [];
  let current = { heading: title, id: '', md: '' };
  for (const line of md.split('\n')) {
    const h2 = line.match(/^##\s+(.*)$/);
    if (h2) {
      if (current.md.trim()) sections.push(current);
      const heading = h2[1].replace(/[*_`]/g, '').trim();
      current = { heading, id: slugify(heading), md: '' };
      continue;
    }
    current.md += line + '\n';
  }
  if (current.md.trim()) sections.push(current);

  return {
    slug,
    title,
    file,
    html: marked.parse(md),
    sections: sections.map((s) => ({ heading: s.heading, id: s.id, text: toText(s.md).slice(0, 1200) })),
  };
});

const banner = `// GENERATED by scripts/gen-docs-bundle.mjs from docs/*.md — do not edit.
// Regenerate with: node scripts/gen-docs-bundle.mjs
`;
writeFileSync(
  OUT,
  banner +
    `\nexport interface DocSection { heading: string; id: string; text: string }\n` +
    `export interface DocPage { slug: string; title: string; file: string; html: string; sections: DocSection[] }\n\n` +
    `export const DOCS: DocPage[] = ${JSON.stringify(pages, null, 2)};\n`,
);

const words = pages.reduce((n, p) => n + p.sections.reduce((m, s) => m + s.text.split(' ').length, 0), 0);
console.log(`✓ ${path.relative(ROOT, OUT)} — ${pages.length} pages, ${pages.reduce((n, p) => n + p.sections.length, 0)} sections, ~${words} indexed words, ${imageCount} images`);
