#!/usr/bin/env node
// Unit tests for device discovery and adoption (0.57, §70), run against dist
// with no database:
//
//   - the unassigned rule: a computer is pooled when its tenant OR its business
//     is null; assertAssigned refuses it with ENDPOINT_UNASSIGNED (403);
//   - deployment keys: 96 hex (never 64, so never a claim token), only the
//     SHA-256 kept, the hint is the last four; the state order (revoked,
//     expired, exhausted, usable); the create schema's limits (90 days, 1 to
//     10,000 uses, review by default, strict, no markup in the name);
//   - assignment rules: the four kinds and nothing about users or e-mail,
//     value normalisation (domains lower-cased, WORKGROUP refused, CIDR
//     /8–/32 and /32–/128, ::ffff: addresses), matching, and the ranking
//     (key, key binding, domain, hostname prefix, address; then priority,
//     then the more specific), with conflicts flagged.
//
// Build first: pnpm --filter @reboot-remote/api build
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const U = require(join(here, '..', 'dist', 'common', 'unassigned.js'));
const K = require(join(here, '..', 'dist', 'adoption', 'deployment-key.js'));
const M = require(join(here, '..', 'dist', 'adoption', 'mapping.js'));
const { ForbiddenException } = require('@nestjs/common');

let pass = 0, fail = 0;
const check = (c, n, d = '') => { if (c) { pass++; console.log(`  \x1b[32m✓\x1b[0m ${n}`); } else { fail++; console.log(`  \x1b[31m✗\x1b[0m ${n}${d ? `\n      ${d}` : ''}`); } };
const section = (t) => console.log(`\n\x1b[1m${t}\x1b[0m`);
const throwsCode = (f, code) => { try { f(); return false; } catch (e) { return e instanceof ForbiddenException && e.getResponse()?.code === code && e.getStatus() === 403; } };

section('The unassigned pool');
check(U.isUnassigned({ tenantId: null, customerId: null }), 'no tenant, no business: pooled');
check(U.isUnassigned({ tenantId: 't', customerId: null }), 'a tenant but no business: pooled');
check(U.isUnassigned({ tenantId: null, customerId: 'c' }), 'a business but no tenant (the old update path): pooled');
check(!U.isUnassigned({ tenantId: 't', customerId: 'c' }), 'both: assigned');
check(throwsCode(() => U.assertAssigned({ tenantId: null, customerId: null }), 'ENDPOINT_UNASSIGNED'), 'assertAssigned refuses a pooled computer: 403 ENDPOINT_UNASSIGNED');
check((() => { try { U.assertAssigned({ tenantId: 't', customerId: 'c' }); return true; } catch { return false; } })(), 'and passes an assigned one');
check(U.ENDPOINT_UNASSIGNED === 'ENDPOINT_UNASSIGNED' && JSON.stringify(U.UNASSIGNED_WHERE) === JSON.stringify({ OR: [{ tenantId: null }, { customerId: null }] }), 'the where clause is tenant null OR business null');

section('Deployment keys');
const k = K.newDeploymentKey();
check(K.KEY_RE.test(k.key) && k.key.length === 96, 'a key is 96 lowercase hex characters', k.key);
check(/^[A-Fa-f0-9]{16,128}$/.test(k.key), "it passes every installer's token check (16–128 hex)");
check(!/^[0-9a-f]{64}$/.test(k.key), 'it can never be mistaken for a 64-character claim token');
check(k.hash === createHash('sha256').update(k.key).digest('hex') && K.hashKey(k.key) === k.hash, 'only its SHA-256 is kept');
check(k.hint === k.key.slice(-4) && /^[0-9a-f]{4}$/.test(k.hint), 'the hint is the last four characters');
check(new Set(Array.from({ length: 200 }, () => K.newDeploymentKey().key)).size === 200, '200 keys, 200 different values');
const now = new Date('2026-11-16T12:00:00Z');
const base = { revokedAt: null, expiresAt: new Date('2026-12-01T00:00:00Z'), useCount: 3, maxUses: 10 };
check(K.keyState(base, now) === 'usable', 'usable');
check(K.keyState({ ...base, revokedAt: now, useCount: 10, expiresAt: new Date(0) }, now) === 'revoked', 'revoked wins over everything');
check(K.keyState({ ...base, expiresAt: now, useCount: 10 }, now) === 'expired', 'expired at the instant, before exhausted');
check(K.keyState({ ...base, useCount: 10 }, now) === 'exhausted', 'exhausted at maxUses');
const create = (o) => K.KeyCreate.safeParse({ businessId: 'cmabcdefghijklmnopqrst', name: 'GPO rollout', maxUses: 100, expiresInDays: 30, ...o });
const good = create({});
check(good.success && good.data.mode === 'review' && good.data.accessMode === 'ASSIGNED_USERS', 'review and assigned users by default', JSON.stringify(good.error?.issues));
check(create({ mode: 'active' }).success, 'active is an explicit choice');
for (const [o, why] of [
  [{ expiresInDays: 91 }, 'more than 90 days'], [{ expiresInDays: 0 }, 'no days'], [{ maxUses: 0 }, 'no uses'], [{ maxUses: 10_001 }, 'more than 10,000 uses'],
  [{ maxUses: 1.5 }, 'a fraction'], [{ mode: 'auto' }, 'an unknown mode'], [{ name: '<b>x</b>' }, 'markup in the name'], [{ name: 'a\nb' }, 'a control character'],
  [{ name: '   ' }, 'a blank name'], [{ businessId: 'x' }, 'not an id'], [{ customerId: 'cmabcdefghijklmnopqrst' }, 'an extra field'], [{ keyHash: 'a'.repeat(64) }, 'a caller-supplied hash'],
]) check(!create(o).success, `refused: ${why}`);
check(K.MAX_KEY_DAYS === 90 && K.MAX_KEY_USES === 10_000 && JSON.stringify(K.KEY_MODES) === '["review","active"]', 'the limits: 90 days, 10,000 uses, two modes');

section('Assignment rules: the kinds and the facts');
check(JSON.stringify(M.MAPPING_KINDS) === '["deployment_key","domain","cidr","hostname_prefix"]', 'exactly four kinds; none is about a user or an e-mail address');
const mk = (o) => M.MappingCreate.safeParse({ businessId: 'cmabcdefghijklmnopqrst', kind: 'domain', value: 'acme.local', ...o });
check(mk({}).success && mk({}).data.priority === 100, 'a domain rule parses, priority 100 by default');
for (const kind of ['username', 'email', 'logged_on_user', 'user', 'upn']) check(!mk({ kind }).success, `kind "${kind}" is refused`);
check(!mk({ extra: 1 }).success && !mk({ priority: 1001 }).success && !mk({ note: '<script>' }).success, 'strict: no extra field, priority ≤ 1000, no markup in a note');

section('Assignment rules: values');
const nv = (kind, v) => M.normaliseValue(kind, v);
check(nv('domain', 'ACME.Local.').ok && nv('domain', 'ACME.Local.').value === 'acme.local', 'a domain is lower-cased, its trailing dot dropped');
check(nv('domain', 'CONTOSO').ok, 'a NetBIOS name is a domain');
for (const v of ['WORKGROUP', 'localdomain', 'local']) check(!nv('domain', v).ok, `"${v}" is refused (every computer outside a domain)`);
for (const v of ['acme..local', '-acme.local', 'ac me.local', 'a'.repeat(64) + '.local', 'acme_local']) check(!nv('domain', v).ok, `domain "${v.slice(0, 20)}" is refused`);
check(nv('hostname_prefix', 'ACME-').ok && nv('hostname_prefix', 'ACME-').value === 'acme-', 'a hostname prefix is lower-cased');
for (const v of ['a', '-acme', 'acme*', 'ac.me']) check(!nv('hostname_prefix', v).ok, `prefix "${v}" is refused`);
check(nv('cidr', '203.0.113.0/24').value === '203.0.113.0/24' && nv('cidr', '203.0.113.9').value === '203.0.113.9/32', 'an IPv4 range; a bare address is one host');
check(nv('cidr', '::ffff:203.0.113.9').value === '203.0.113.9/32', 'an IPv4-mapped IPv6 address is the IPv4 address');
check(nv('cidr', '2001:DB8::/48').value === '2001:db8::/48', 'an IPv6 range, lower-cased');
for (const v of ['0.0.0.0/0', '10.0.0.0/7', '2001:db8::/31', '203.0.113.0/33', '203.0.113.0/24/1', 'example.com/24', '203.0.113.0/2a', '']) check(!nv('cidr', v).ok, `range "${v}" is refused`);
check(nv('deployment_key', 'cmabcdefghijklmnopqrst').ok && !nv('deployment_key', 'f'.repeat(96)).ok, 'a key rule names the key by id, never by the key itself');

section('Assignment rules: matching');
const facts = (o = {}) => ({ deploymentKeyId: null, domain: null, sourceIp: null, hostname: null, ...o });
check(M.mappingMatches({ kind: 'domain', value: 'acme.local', deploymentKeyId: null }, facts({ domain: 'ACME.LOCAL.' })), 'domain: case-insensitive, trailing dot ignored');
check(!M.mappingMatches({ kind: 'domain', value: 'acme.local', deploymentKeyId: null }, facts({ domain: 'sub.acme.local' })), 'domain: exact, a subdomain is not a match');
check(M.mappingMatches({ kind: 'hostname_prefix', value: 'acme-', deploymentKeyId: null }, facts({ hostname: 'ACME-LT042' })), 'hostname prefix: case-insensitive');
check(!M.mappingMatches({ kind: 'hostname_prefix', value: 'acme-', deploymentKeyId: null }, facts({ hostname: 'XACME-1' })), 'hostname prefix: only at the start');
check(M.mappingMatches({ kind: 'cidr', value: '198.51.100.0/24', deploymentKeyId: null }, facts({ sourceIp: '::ffff:198.51.100.77' })), 'address: an IPv4-mapped source matches an IPv4 range');
check(!M.mappingMatches({ kind: 'cidr', value: '198.51.100.0/24', deploymentKeyId: null }, facts({ sourceIp: '198.51.101.1' })), 'address: outside the range');
check(!M.mappingMatches({ kind: 'cidr', value: '2001:db8::/32', deploymentKeyId: null }, facts({ sourceIp: '198.51.100.1' })), 'address: another family never matches');
check(M.mappingMatches({ kind: 'deployment_key', value: 'k1', deploymentKeyId: 'k1' }, facts({ deploymentKeyId: 'k1' })) && !M.mappingMatches({ kind: 'deployment_key', value: 'k1', deploymentKeyId: 'k1' }, facts()), 'deployment key: only the computer enrolled with it');
check(!M.mappingMatches({ kind: 'username', value: 'bob', deploymentKeyId: null }, { ...facts(), loggedOnUser: 'bob', email: 'bob@acme.example' }), 'an unknown kind matches nothing, whatever else is passed');

section('Assignment rules: the suggestion');
const t0 = new Date('2026-01-01');
const rule = (id, kind, value, customerId, o = {}) => ({ id, kind, value, customerId, siteId: null, deploymentKeyId: kind === 'deployment_key' ? value : null, priority: 100, createdAt: t0, ...o });
const rules = [
  rule('r-cidr', 'cidr', '198.51.100.0/24', 'B'), rule('r-cidr-narrow', 'cidr', '198.51.100.0/28', 'C'),
  rule('r-dom', 'domain', 'acme.local', 'A', { siteId: 'hq' }), rule('r-pre', 'hostname_prefix', 'acme-', 'A'), rule('r-pre-long', 'hostname_prefix', 'acme-lt', 'D'),
  rule('r-key', 'deployment_key', 'k1', 'E'),
];
let s = M.suggest(facts(), rules);
check(s.suggestion === null && s.matches.length === 0 && s.conflict === false, 'no facts: no suggestion');
s = M.suggest(facts({ sourceIp: '198.51.100.3' }), rules);
check(s.suggestion.mappingId === 'r-cidr-narrow' && s.conflict === true, 'two address rules: the narrower first, and they disagree', JSON.stringify(s.matches));
s = M.suggest(facts({ domain: 'acme.local', sourceIp: '198.51.100.200' }), rules);
check(s.suggestion.source === 'domain' && s.suggestion.customerId === 'A' && s.suggestion.siteId === 'hq' && s.conflict === true, 'domain before address; the address rule is still listed as a conflict');
s = M.suggest(facts({ hostname: 'ACME-LT9' }), rules);
check(s.suggestion.mappingId === 'r-pre-long', 'two prefixes: the longer first');
s = M.suggest(facts({ hostname: 'ACME-LT9' }), rules.map((r) => (r.id === 'r-pre' ? { ...r, priority: 1 } : r)));
check(s.suggestion.mappingId === 'r-pre', 'priority beats specificity inside a kind');
s = M.suggest(facts({ deploymentKeyId: 'k1', domain: 'acme.local' }), rules, { keyId: 'k1', customerId: 'F', siteId: 's' });
check(s.matches.map((m) => m.source).join() === 'deployment_key,key_binding,domain' && s.suggestion.customerId === 'E', 'a rule on the key, then the key\'s own business, then the domain', JSON.stringify(s.matches));
s = M.suggest(facts({ deploymentKeyId: 'k2' }), [], { keyId: 'k2', customerId: 'F', siteId: 's' });
check(s.suggestion.source === 'key_binding' && s.suggestion.mappingId === null && s.suggestion.siteId === 's' && !s.conflict, "a review key with no rule: its own business and site");
s = M.suggest(facts({ deploymentKeyId: 'k3' }), [], { keyId: 'k2', customerId: 'F', siteId: null });
check(s.suggestion === null, 'a binding for another key is ignored');
s = M.suggest(facts({ domain: 'acme.local', hostname: 'acme-1' }), rules);
check(s.conflict === false && s.matches.length === 2, 'two rules naming the same business: no conflict');

section('Nothing about users');
const src = ['mapping.js', 'deployment-key.js', 'adoption.service.js'].map((f) => require('node:fs').readFileSync(join(here, '..', 'dist', 'adoption', f), 'utf8')).join('\n');
check(!/loggedOnUser|lastUser|email/i.test(src.replace(/e-mail address/g, '')), 'the rules, keys and adoption service never read a signed-in user or an e-mail address');

console.log(`\n${fail ? '\x1b[31m' : '\x1b[32m'}${pass} passed, ${fail} failed\x1b[0m`);
process.exit(fail ? 1 : 0);
