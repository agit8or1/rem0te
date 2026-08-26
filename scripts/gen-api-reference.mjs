#!/usr/bin/env node
/**
 * Generate docs/API-REFERENCE.md from the controllers.
 *
 * Hand-written endpoint lists rot silently — a route is added, nobody updates
 * the table, and the documentation is now confidently wrong. This reads the
 * decorators instead, and then checks its own output against the route table
 * Nest prints at startup, so a parsing gap is a build failure rather than a
 * quiet omission.
 *
 *   node scripts/gen-api-reference.mjs                     # generate
 *   node scripts/gen-api-reference.mjs --check routes.txt  # verify coverage
 *
 * routes.txt is `journalctl -u reboot-remote-api | grep RouterExplorer`, or any
 * file with "METHOD /path" lines.
 */
import { readFileSync, writeFileSync, readdirSync, statSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'apps/api/src');
const GLOBAL_PREFIX = '/api/v1';
const VERBS = ['Get', 'Post', 'Put', 'Patch', 'Delete'];

function walk(dir) {
  return readdirSync(dir).flatMap((entry) => {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) return walk(full);
    return full.endsWith('.controller.ts') ? [full] : [];
  });
}

/** Join a controller prefix and a route path into one clean absolute path. */
function joinPath(prefix, route) {
  const parts = [GLOBAL_PREFIX, prefix, route]
    .filter((p) => p !== undefined && p !== null && p !== '')
    .map((p) => String(p).replace(/^\/+|\/+$/g, ''))
    .filter(Boolean);
  return '/' + parts.join('/');
}

/**
 * One file can declare more than one controller, and a controller can declare
 * more than one prefix — `@Controller(['businesses', 'customers'])` mounts the
 * same routes under both, which is how the pre-rename paths stayed alive. Both
 * were missed by the first version of this parser, and the coverage check is
 * what caught it.
 */
function parseFile(file) {
  const src = readFileSync(file, 'utf8');
  const lines = src.split('\n');

  // Index every line that opens a @Controller decorator, so each class can be
  // parsed against its own prefix rather than the first one in the file.
  const starts = [];
  lines.forEach((l, i) => { if (l.trim().startsWith('@Controller(')) starts.push(i); });
  if (!starts.length) return [];

  return starts.flatMap((startLine, n) => {
    const endLine = n + 1 < starts.length ? starts[n + 1] : lines.length;
    const block = lines.slice(startLine, endLine);

    // Prefixes: a single quoted string, or an array of them.
    const decl = block.join('\n');
    const ctrlArgs = decl.slice(decl.indexOf('@Controller('), decl.indexOf(')') + 1);
    const prefixes = [...ctrlArgs.matchAll(/'([^']*)'|"([^"]*)"/g)].map((m) => m[1] ?? m[2]);
    if (!prefixes.length) prefixes.push('');

    // Decorators between @Controller and `export class` apply to every route.
    const classLine = block.findIndex((l) => /export class/.test(l));
    const classDecorators = block.slice(0, classLine === -1 ? 1 : classLine).join('\n');
    const classPublic = /@Public\(\)/.test(classDecorators);

    const routes = [];
    let pending = [];
    for (const line of block.slice(classLine === -1 ? 0 : classLine)) {
      const t = line.trim();
      if (t.startsWith('@')) { pending.push(t); continue; }

      const verbLine = pending.find((d) => VERBS.some((v) => d.startsWith(`@${v}(`)));
      if (verbLine && (t.startsWith('async ') || /^[A-Za-z_][\w]*\s*\(/.test(t))) {
        const verb = VERBS.find((v) => verbLine.startsWith(`@${v}(`)).toUpperCase();
        // A verb decorator takes a string or an array of them, same as
        // @Controller — `@Get(['businesses', 'companies'])` is one handler on
        // two paths, and reading only the first silently halves the reference.
        const routePaths = [...verbLine.matchAll(/'([^']*)'|"([^"]*)"/g)].map((m) => m[1] ?? m[2]);
        if (!routePaths.length) routePaths.push('');
        const cap = pending.find((d) => d.startsWith('@RequireCapability('));
        const isPublic = classPublic || pending.some((d) => d === '@Public()');
        const throttled = pending.some((d) => d.startsWith('@Throttle('));
        const handler = t.replace(/^async\s+/, '').split('(')[0];

        for (const prefix of prefixes) for (const route of routePaths) {
          routes.push({
            method: verb,
            path: joinPath(prefix, route),
            public: isPublic,
            capability: cap?.match(/CAP\.([A-Z0-9_]+)/)?.[1] ?? null,
            throttled,
            handler,
          });
        }
        pending = [];
        continue;
      }
      if (t && !t.startsWith('@') && !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*')) {
        pending = [];
      }
    }

    if (!routes.length) return [];
    return [{
      file: path.relative(ROOT, file),
      group: path.basename(file).replace('.controller.ts', '') + (starts.length > 1 ? `-${prefixes[0].replace(/[^a-z]/gi, '') || n}` : ''),
      prefixes,
      routes,
    }];
  });
}

const controllers = walk(SRC).flatMap(parseFile);
controllers.sort((a, b) => a.group.localeCompare(b.group));
const all = controllers.flatMap((c) => c.routes);

// ── Coverage check against the runtime route table ─────────────────────────
const checkIdx = process.argv.indexOf('--check');
if (checkIdx !== -1) {
  const raw = readFileSync(process.argv[checkIdx + 1], 'utf8');
  const runtime = new Set(
    raw.split('\n')
      .map((l) => l.match(/Mapped \{([^,]+), ([A-Z]+)\}/) ?? l.match(/^([A-Z]+) (\/\S+)$/))
      .filter(Boolean)
      .map((m) => (m[2].startsWith('/') ? `${m[1]} ${m[2]}` : `${m[2]} ${m[1]}`)),
  );
  const parsed = new Set(all.map((r) => `${r.method} ${r.path}`));
  const missing = [...runtime].filter((r) => !parsed.has(r));
  const extra = [...parsed].filter((r) => !runtime.has(r));
  console.log(`runtime routes: ${runtime.size}   parsed: ${parsed.size}`);
  if (missing.length) console.error(`\n✗ ${missing.length} route(s) the parser missed:\n  ${missing.slice(0, 40).join('\n  ')}`);
  if (extra.length) console.error(`\n✗ ${extra.length} parsed route(s) not in the runtime table:\n  ${extra.slice(0, 40).join('\n  ')}`);
  process.exit(missing.length || extra.length ? 1 : 0);
}

// ── Emit ────────────────────────────────────────────────────────────────────
const TITLES = {
  auth: 'Authentication', mfa: 'Multi-factor authentication', users: 'Users',
  businesses: 'Businesses', sites: 'Sites', endpoints: 'Computers',
  sessions: 'Support sessions', launcher: 'Launcher', enrollment: 'Endpoint enrolment',
  notes: 'Notes', dashboard: 'Dashboard', audit: 'Audit log', apikeys: 'API keys',
  'public-api': 'Public API (API-key authenticated)', public: 'Public (unauthenticated)',
  'quick-connect': 'Quick Connect', 'quick-connect-public': 'Quick Connect (public)',
  downloads: 'Client downloads', update: 'Updates', admin: 'Administration',
  platform: 'Platform settings', tenants: 'Tenants', rbac: 'Roles and capabilities',
  security: 'Security', status: 'System status',
};

const lines = [
  '# API reference',
  '',
  '_Generated from the controllers by `scripts/gen-api-reference.mjs`. Do not edit by hand._',
  '',
  `Every route is prefixed with \`${GLOBAL_PREFIX}\`. There are **${all.length}** of them across`,
  `**${controllers.length}** controllers.`,
  '',
  'For request and response shapes, worked examples and error codes, see',
  '[PUBLIC-API.md](PUBLIC-API.md) — this page is the complete surface, that one is the guide.',
  '',
  '## Authentication',
  '',
  'Unless a route is marked **public**, it needs a signed-in session: a JWT in the',
  '`access_token` cookie, or `Authorization: Bearer <token>`. Role, business and',
  'capabilities are re-read from the database on every request — the token is used',
  'for identity only, never for authorisation.',
  '',
  'A **capability** column names the permission a Business User must hold. Platform',
  'Admins and Business Owners are not confined by it; see',
  '[access-control.md](access-control.md).',
  '',
  '**Throttled** routes have a per-route rate limit on top of the global one.',
  '',
  '---',
  '',
];

for (const c of controllers) {
  const title = TITLES[c.group] ?? c.group.replace(/-/g, ' ').replace(/^./, (ch) => ch.toUpperCase());
  lines.push(`## ${title}`, '');
  lines.push(`\`${c.file}\`${c.prefixes.length > 1 ? ` — mounted at ${c.prefixes.map((p) => `\`/${p}\``).join(' and ')}` : ''}`, '');
  lines.push('| Method | Path | Access | Capability |', '|---|---|---|---|');
  for (const r of c.routes.sort((a, b) => a.path.localeCompare(b.path))) {
    const access = r.public ? 'public' : 'signed in';
    const cap = r.capability ? `\`${r.capability}\`` : '—';
    lines.push(`| \`${r.method}\` | \`${r.path}\` | ${access}${r.throttled ? ', throttled' : ''} | ${cap} |`);
  }
  lines.push('');
}

writeFileSync(path.join(ROOT, 'docs/API-REFERENCE.md'), lines.join('\n') + '\n');
console.log(`✓ docs/API-REFERENCE.md — ${all.length} routes, ${controllers.length} controllers`);
