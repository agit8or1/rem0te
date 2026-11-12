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

// Reading order, grouped. The landing page at /docs shows these groups as an
// index, the sidebar lists them under their group, and prev/next follows this
// order. Each entry: [file, title, group, one-line summary for the index].
// A group name must be in GROUPS.
const GROUPS = [
  'Start here',
  'Connecting and clients',
  'Computers and monitoring',
  'People and access',
  'Security and incidents',
  'Integrations and API',
  'Running the server',
];
const ORDER = [
  ['README.md', 'Overview', 'Start here', 'Which page to read for what you are doing.'],
  ['technician-guide.md', 'Technician guide', 'Start here', 'Day to day: find a computer, connect, help someone unenrolled, review sessions.'],
  ['troubleshooting.md', 'Troubleshooting', 'Start here', 'Start here when something is broken — especially "the target device is offline".'],
  ['connecting.md', 'Connecting', 'Connecting and clients', 'What happens when you click Connect, and why the three connect paths differ.'],
  ['clients.md', 'Clients', 'Connecting and clients', 'Every RustDesk client Rem0te hands out, who it is for, and how it finds this server.'],
  ['support-requests.md', 'Support requests', 'Connecting and clients', 'The customer support link, the status page and the technician queue.'],
  ['capabilities.md', 'What each agent can do', 'Computers and monitoring', 'Capabilities by agent type, what needs configuring, and what has been tested on real Windows.'],
  ['inventory.md', 'Inventory and event logs', 'Computers and monitoring', 'Specs, installed software, change history, pending updates and event-log slices.'],
  ['diagnostics.md', 'One-click diagnostics', 'Computers and monitoring', 'Read-only checks a technician runs with one click: disk, services, errors, network, DNS, updates, restart.'],
  ['monitoring.md', 'Monitoring and alerts', 'Computers and monitoring', 'Monitors, inheritance, alerts, site outages, maintenance windows and escalation.'],
  ['metric-history.md', 'Metric history', 'Computers and monitoring', 'CPU, memory and disk over time: the Performance tab, gaps, roll-up, retention and storage.'],
  ['reports.md', 'Reports', 'Computers and monitoring', 'Patch compliance, agent coverage, alert frequency, offline time and software compliance, from stored data, with audited CSV export.'],
  ['updates.md', 'Updates', 'Computers and monitoring', 'Updating the portal, RustDesk and the agent, and client rollouts.'],
  ['staged-patching.md', 'Staged patching', 'Computers and monitoring', 'Windows updates in rings — canary, approvals, halt on failure.'],
  ['patching-setup.md', 'Patching setup', 'Computers and monitoring', 'Turning on signed patching in production, in order, with a live pre-flight.'],
  ['approved-actions.md', 'Approved actions', 'Computers and monitoring', 'Actions on a computer approved by passkey on a separate signer.'],
  ['software-deployment.md', 'Software deployment', 'Computers and monitoring', 'Allowlisted winget packages pinned by version and hash, installed through rings and two approvals; version compliance.'],
  ['script-library.md', 'Script library', 'Computers and monitoring', 'Write, version and review PowerShell scripts, and run approved ones through the signed approval chain.'],
  ['technicians.md', 'MSP technicians', 'People and access', 'Per-business, time-limited and scheduled technician access.'],
  ['technician-access.md', 'Technician access and abuse prevention', 'People and access', 'L1/L2/L3 presets, policy, independent review and temporary access.'],
  ['access-control.md', 'Access control', 'People and access', 'Roles, capabilities and what each permission allows.'],
  ['security-model.md', 'Security model: who can reach a computer', 'People and access', 'The portal / RustDesk / endpoint boundary and what evidence you will have.'],
  ['sign-in.md', 'Sign-in, SSO and passkeys', 'People and access', 'Passwords, MFA, single sign-on, passkeys and step-up.'],
  ['offboarding.md', 'Access review and offboarding', 'People and access', 'Reviewing who can reach what, and removing someone cleanly.'],
  ['containment.md', 'Containment and audit integrity', 'Security and incidents', 'Stop writes during an incident; the sealed, verifiable audit log.'],
  ['incident-recovery.md', 'Incident recovery', 'Security and incidents', 'What to do, in order, when you suspect a compromise.'],
  ['update-signing.md', 'Update signing', 'Security and incidents', 'The offline-signed update chain and what a compromised portal cannot do.'],
  ['SECURITY-AUDIT.md', 'Security', 'Security and incidents', 'Security review findings and how each was addressed.'],
  ['integration-clientst0r.md', 'ClientSt0r integration', 'Integrations and API', 'Ticket analysis, the device AI summary, alert events and ticket links (contract ticket-rmm-v1).'],
  ['tactical-rmm.md', 'Tactical RMM', 'Integrations and API', 'Connecting from inside Tactical RMM: URL actions and agent matching.'],
  ['PUBLIC-API.md', 'API guide', 'Integrations and API', 'API keys, scopes and the public API with examples.'],
  ['API-REFERENCE.md', 'API reference', 'Integrations and API', 'Every route the server exposes, generated from the route table.'],
  ['setup.md', 'Setup and operations', 'Running the server', 'Installing, configuring and operating the server.'],
  ['server-sizing.md', 'Server sizing', 'Running the server', 'CPU, memory, disk and PostgreSQL for 50 to 5,000 computers, with measured heartbeat cost and database growth.'],
  ['data-retention.md', 'Data retention', 'Running the server', 'What ages out of the database, after how long, what is never removed (the audit log), and how to change it.'],
  ['architecture.md', 'Architecture', 'Running the server', 'How the pieces fit together.'],
];
const badGroup = ORDER.find(([, , g]) => !GROUPS.includes(g));
if (badGroup) { console.error(`✗ ${badGroup[0]}: group "${badGroup[2]}" is not in GROUPS`); process.exit(1); }

// Pages in docs/ that are repo metadata rather than user documentation. They are
// deliberately NOT in the in-app bundle, and the unlisted-pages guard below must
// not treat them as an omission. Keep this list short: if something here would
// help a reader of the app, it belongs in ORDER instead.
const NOT_IN_APP = new Set([
  'github-about.md', // GitHub About panel copy + settings checklist, for maintainers
  'rmm-gap-analysis.md', // Planning record for maintainers: what works, what doesn't, what is next
  // The GitHub gallery. Its images live in docs/images/github/, which this
  // script does not copy (it only mirrors docs/screenshots/), so bundling the
  // page would put 30 broken images inside /docs. It is a repository landing
  // page, not product documentation.
  'screenshots.md',
]);

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
// Headings get ids so the in-page contents can link to them. Ids are unique
// within a page (a second "Setup" becomes setup-2) and every h2/h3 is
// collected into that page's contents list.
let usedIds = new Map();
let toc = [];
const uniqueId = (base) => {
  const n = usedIds.get(base) ?? 0;
  usedIds.set(base, n + 1);
  return n ? `${base}-${n + 1}` : base;
};
renderer.heading = function ({ tokens, depth }) {
  const text = this.parser.parseInline(tokens);
  const plain = text.replace(/<[^>]*>/g, '').replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/&quot;/g, '"');
  const id = uniqueId(slugify(plain) || 'section');
  if (depth === 2 || depth === 3) toc.push({ depth, id, text: plain });
  return `<h${depth} id="${id}">${text}<a class="docs-anchor" href="#${id}" aria-label="Link to this section">#</a></h${depth}>\n`;
};
// Screenshots live at docs/screenshots/…; the app serves them from /docs-img/.
// Each one is a figure: the alt text doubles as its caption, and the image
// opens full size, because annotated callouts are unreadable when shrunk.
renderer.image = ({ href, title, text }) => {
  const src = href.replace(/^(\.\/)?screenshots\//, '/docs-img/');
  const alt = (text ?? '').replace(/"/g, '&quot;');
  return `<figure class="docs-figure"><a href="${src}" target="_blank" rel="noopener"><img src="${src}" alt="${alt}"${title ? ` title="${title}"` : ''} loading="lazy" /></a>${alt ? `<figcaption>${alt}</figcaption>` : ''}</figure>`;
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
const unlisted = [...present].filter(
  (f) => !NOT_IN_APP.has(f) && !ORDER.some(([o]) => o === f),
);
if (unlisted.length) {
  // A new page that nobody added to ORDER would silently never appear in the
  // app — which is the failure this whole exercise started from.
  console.error(`✗ docs/ has pages missing from ORDER in ${path.relative(ROOT, OUT)}: ${unlisted.join(', ')}`);
  process.exit(1);
}

const pages = ORDER.map(([file, title, group, summary]) => {
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

  usedIds = new Map(); toc = [];
  const html = marked.parse(md)
    // A standalone figure must not sit inside a <p>.
    .replace(/<p>(<figure class="docs-figure">[\s\S]*?<\/figure>)<\/p>/g, '$1')
    // Wide tables scroll inside their own box instead of widening the page.
    .replace(/<table>/g, '<div class="docs-table"><table>').replace(/<\/table>/g, '</table></div>');
  const words = toText(md).split(' ').length;
  return {
    slug,
    title,
    file,
    group,
    summary,
    minutes: Math.max(1, Math.round(words / 220)),
    toc: toc.slice(0, 80),
    html,
    // Section ids follow the rendered h2 ids (which are de-duplicated), so a
    // search hit lands on the right heading even when two share a name.
    sections: (() => {
      const h2 = toc.filter((t) => t.depth === 2);
      // Matched by slug, in order — a "## " line inside a code fence is a
      // section here but no heading there, so counting would drift.
      let k = 0;
      return sections.map((sec) => {
        let id = sec.id;
        if (id) {
          const i = h2.findIndex((t, j) => j >= k && (t.id === sec.id || new RegExp(`^${sec.id}-\\d+$`).test(t.id)));
          if (i >= 0) { id = h2[i].id; k = i + 1; }
        }
        return { heading: sec.heading, id, text: toText(sec.md).slice(0, 4000) };
      });
    })(),
  };
});

const banner = `// GENERATED by scripts/gen-docs-bundle.mjs from docs/*.md — do not edit.
// Regenerate with: node scripts/gen-docs-bundle.mjs
`;
writeFileSync(
  OUT,
  banner +
    `\nexport interface DocSection { heading: string; id: string; text: string }\n` +
    `export interface DocTocEntry { depth: number; id: string; text: string }\n` +
    `export interface DocPage { slug: string; title: string; file: string; group: string; summary: string; minutes: number; toc: DocTocEntry[]; html: string; sections: DocSection[] }\n\n` +
    `export const DOC_GROUPS: string[] = ${JSON.stringify(GROUPS)};\n\n` +
    `export const DOCS: DocPage[] = ${JSON.stringify(pages, null, 2)};\n`,
);

const words = pages.reduce((n, p) => n + p.sections.reduce((m, s) => m + s.text.split(' ').length, 0), 0);
console.log(`✓ ${path.relative(ROOT, OUT)} — ${pages.length} pages, ${pages.reduce((n, p) => n + p.sections.length, 0)} sections, ~${words} indexed words, ${imageCount} images`);
