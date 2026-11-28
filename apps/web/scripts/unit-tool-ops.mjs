#!/usr/bin/env node
// Background technician tools, presented (0.93, UX P1-7): apps/web/lib/tool-ops.ts.
//
//   node apps/web/scripts/unit-tool-ops.mjs
//
// The module is pure, so it is transpiled with the workspace's TypeScript and
// run as it is. Covered: the audit link names the record and nothing else;
// deadlines come only from a date the server sent; every error code with a
// next step is one the API really returns; the server's own words are always
// kept; each audit resource is the one its service writes; the filters keep
// every row on an empty query; the tool tabs no longer hard-code a deadline.

import { createRequire } from 'node:module';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const WEB = join(here, '..');
const ROOT = join(WEB, '..', '..');
const API = join(ROOT, 'apps', 'api', 'src');
const require = createRequire(join(WEB, 'package.json'));
const ts = require('typescript');
const src = readFileSync(join(WEB, 'lib', 'tool-ops.ts'), 'utf8');
const js = ts.transpileModule(src, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2021 } }).outputText;
if (/\brequire\s*\(/.test(js)) throw new Error('lib/tool-ops.ts imports a module: it must stay pure');
const mod = { exports: {} };
new Function('module', 'exports', js)(mod, mod.exports);
const T = mod.exports;

let passed = 0;
const failures = [];
const check = (name, ok, detail = '') => { if (ok) passed++; else failures.push(`${name}${detail ? ` — ${detail}` : ''}`); };
const walk = (d, out = []) => { for (const n of readdirSync(d)) { const p = join(d, n); if (n === 'node_modules' || n.startsWith('.')) continue; if (statSync(p).isDirectory()) walk(p, out); else if (/\.tsx?$/.test(n)) out.push(p); } return out; };
const apiSrc = walk(API).map((f) => readFileSync(f, 'utf8')).join('\n');

// The audit link.
check('auditHref names resource and id', T.auditHref({ resource: 'terminal_session', resourceId: 'abc' }) === '/audit?resource=terminal_session&resourceId=abc');
check('auditHref adds an action only when given', T.auditHref({ resource: 'endpoint', resourceId: 'e1', action: 'ENDPOINT_DIAGNOSTIC_REQUESTED' }) === '/audit?resource=endpoint&resourceId=e1&action=ENDPOINT_DIAGNOSTIC_REQUESTED');
check('auditHref escapes', !T.auditHref({ resource: 'x', resourceId: 'a&b=c' }).includes('a&b=c'));
const audit = readFileSync(join(WEB, 'app', '(app)', 'audit', 'page.tsx'), 'utf8');
check('the audit page reads resource, resourceId and action from the URL', /sp\.get\('resourceId'\)/.test(audit) && /sp\.get\('action'\)/.test(audit) && /sp\.get\('resource'\)/.test(audit) && /resourceId && \{ resourceId \}/.test(audit));
const ctl = readFileSync(join(API, 'audit', 'audit.controller.ts'), 'utf8');
check('the API takes resourceId after resolving scope, and refuses a malformed one or an unknown action',
  ctl.indexOf('resolveScope(') < ctl.indexOf('RESOURCE_ID.test(resourceId)') && /BAD_RESOURCE_ID/.test(ctl) && /BAD_ACTION/.test(ctl) && /customerId: scope \?\? undefined/.test(ctl));

// Each audit resource is the one its service writes.
const svc = (p) => readFileSync(join(API, p), 'utf8');
check('terminal rows are terminal_session / the session id', /resource: 'terminal_session', resourceId: /.test(svc('remote-ops/terminal.service.ts')) && T.AUDIT_RESOURCE.terminal === 'terminal_session');
check('file rows are file_transfer / the transfer id', /resource: 'file_transfer', resourceId: /.test(svc('remote-ops/file-transfer.service.ts')) && T.AUDIT_RESOURCE.file === 'file_transfer');
check('action rows are action_job / the job id', /action: 'ACTION_REQUESTED', resource: 'action_job', resourceId: job\.id/.test(svc('actions/actions.service.ts')) && T.AUDIT_RESOURCE.action === 'action_job');
const schema = readFileSync(join(ROOT, 'apps', 'api', 'prisma', 'schema.prisma'), 'utf8');
for (const a of ['ENDPOINT_EVENT_LOG_REQUESTED', 'ENDPOINT_DIAGNOSTIC_REQUESTED']) check(`${a} is an audit action, logged on the device`, new RegExp(`\\b${a}\\b`).test(schema) && new RegExp(`action: '${a}'[^}]*resource: 'endpoint'`).test(apiSrc));
check('migration 0106 indexes (resource, resourceId)', /CREATE INDEX "ActivityLog_resource_resourceId_idx" ON "ActivityLog"\("resource", "resourceId"\)/.test(readFileSync(join(ROOT, 'apps', 'api', 'prisma', 'migrations', '0106_audit_resource_index', 'migration.sql'), 'utf8')));

// Deadlines.
const now = new Date(2026, 10, 27, 14, 0, 0).getTime();
check('a future deadline: clock time and time left', T.deadlineText(new Date(now + 12 * 60_000), now) === 'ends at 14:12 (in 12 min)');
check('over an hour', T.deadlineText(new Date(now + 65 * 60_000), now) === 'ends at 15:05 (in 1 h 05 min)');
check('a passed deadline', T.deadlineText(new Date(now - 60_000), now) === 'ended at 13:59');
check('custom verbs', T.deadlineText(new Date(now + 60_000), now, { future: 'expires', past: 'expired' }) === 'expires at 14:01 (in 1 min)');
check('no date or a bad date: nothing is invented', T.deadlineText(null, now) === null && T.deadlineText('nonsense', now) === null && T.deadlineText(undefined, now) === null);
check('leftText never goes negative', T.leftText(-5) === 'now' && T.leftText(NaN) === 'now');
check('shortRef keeps short ids and shortens long ones', T.shortRef('abc') === 'abc' && T.shortRef('cmabcdefghijklmnop1234') === 'cmabcdef…1234');

// Errors.
for (const code of Object.keys(T.TOOL_FIXES)) check(`${code} is a code the API returns`, new RegExp(`code: '${code}'`).test(apiSrc));
check('every fix is a sentence', Object.values(T.TOOL_FIXES).every((f) => f.length > 15 && /[.]$/.test(f)));
const e1 = T.toolError({ code: 'FILES_TOO_LARGE', message: 'This customer allows files up to 100 MB.' });
check('the server\'s own words are kept, with the fix after', e1.words === 'This customer allows files up to 100 MB.' && /raise/.test(e1.fix) && e1.code === 'FILES_TOO_LARGE');
check('an unknown code keeps the message and adds no fix', (() => { const x = T.toolError({ code: 'NOPE', message: 'Nope.' }); return x.words === 'Nope.' && x.fix === null; })());
check('no message at all says so, and never shows a code as words', T.toolError({ code: 'TERMINAL_TOO_MANY' }).words === 'Something went wrong, and the server did not say what.');
check('no error at all is handled', T.toolError(null).fix === null);
const chrome = readFileSync(join(WEB, 'components', 'endpoints', 'workspace', 'tool-chrome.tsx'), 'utf8');
check('errors never show axios\'s "Request failed with status code"', /message: m \?\? null/.test(chrome));

// Filters.
const rows = [{ m: 'Disk C: full' }, { m: 'Printer stuck' }, { m: 'disk D: ok' }];
check('filterRows: empty keeps all', T.filterRows(rows, '  ', (r) => r.m).length === 3);
check('filterRows: case-insensitive', T.filterRows(rows, 'DISK', (r) => r.m).length === 2);
check('findLines: numbers from 1, capped', JSON.stringify(T.findLines('a\nbX\nc\nbx', 'x')) === JSON.stringify([{ n: 2, line: 'bX' }, { n: 4, line: 'bx' }]) && T.findLines('x\n'.repeat(500), 'x', 10).length === 10 && T.findLines('abc', '').length === 0);
check('findLines handles CRLF', T.findLines('a\r\nb', 'b')[0]?.n === 2);

// The tabs use it.
const tab = (p) => readFileSync(join(WEB, 'components', 'endpoints', p), 'utf8');
const term = tab('workspace/terminal-tab.tsx'), files = tab('workspace/files-tab.tsx'), ev = tab('endpoint-event-log.tsx'), diag = tab('endpoint-diagnostics-catalog.tsx'), ctrl = tab('workspace/device-control.tsx');
check('terminal: target, hard-limit clock, reference, output and transcript search, plain errors',
  /<ToolTarget ep=\{ep\} runsAs="SYSTEM" \/>/.test(term) && /deadlineText\(session\.notAfter, now\)/.test(term) && /resource=\{AUDIT_RESOURCE\.terminal\}/.test(term)
    && /testId="terminal-find"/.test(term) && /testId="transcript-find"/.test(term) && /errorLine\(e, fallback\)/.test(term));
check('files: target, both clocks, reference, filter, others\' progress, plain errors',
  /<ToolTarget ep=\{ep\} runsAs="SYSTEM" \/>/.test(files) && /deadlineText\(t\.notAfter, now\)/.test(files) && /stallMinutes \* 60_000/.test(files) && /resource=\{AUDIT_RESOURCE\.file\}/.test(files)
    && /data-testid="files-filter"/.test(files) && /t\.bytesDone \/ t\.size/.test(files) && /errorLine\(e, fallback\)/.test(files));
check('event log: filter keeping each row\'s index, the server\'s expiry, a reference',
  /filterRows\(events\.map\(\(row, i\) => \(\{ row, i \}\)\)/.test(ev) && /index=\{i\}/.test(ev) && /deadlineText\(shown\.expiresAt/.test(ev) && /action="ENDPOINT_EVENT_LOG_REQUESTED"/.test(ev));
check('diagnostics: the server\'s expiry instead of "within fifteen", and a reference',
  /deadlineText\(run\.expiresAt/.test(diag) && !/If it does not check in within fifteen/.test(diag) && /action="ENDPOINT_DIAGNOSTIC_REQUESTED"/.test(diag));
check('a device-control request shows its signed window and its reference', /deadlineText\(done\.notAfter/.test(ctrl) && /resource=\{AUDIT_RESOURCE\.action\}/.test(ctrl));
check('no new hex colour, amber, yellow, orange or emerald, and no text under 12 px in the new code',
  [src, chrome].every((t) => !/#[0-9a-fA-F]{3,6}\b|\b(amber|yellow|orange|emerald)-|text-\[(?:[0-9]|1[01])px\]/.test(t)));
check('nothing in the new code starts, extends or cancels anything', !/Api\.|api\.|fetch\(|useMutation/.test(chrome) && !/fetch\(/.test(src));

if (failures.length) console.error(failures.map((f) => `✗ ${f}`).join('\n'));
console.log(`unit-tool-ops: ${passed} passed, ${failures.length} failed`);
process.exit(failures.length ? 1 : 0);
