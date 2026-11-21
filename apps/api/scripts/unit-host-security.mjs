#!/usr/bin/env node
// Server security (0.74), run against dist:
//
//   node apps/api/scripts/unit-host-security.mjs
//
// Pure functions only: src/admin/host-security/parsers.ts and posture.ts, and
// host-runner.ts's closed argument shapes (no process is started). The
// fixtures are what an Ubuntu 24.04 host printed to its service user on
// 2026-11-20, with addresses moved to documentation ranges.

import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const P = require(join(here, '..', 'dist', 'admin', 'host-security', 'parsers.js'));
const S = require(join(here, '..', 'dist', 'admin', 'host-security', 'posture.js'));
const R = require(join(here, '..', 'dist', 'admin', 'host-security', 'host-runner.js'));
const A = require(join(here, '..', 'dist', 'admin', 'host-security', 'acceptance.js'));
const FX = JSON.parse(readFileSync(join(here, 'fixtures', 'host-security.json'), 'utf8'));

let passed = 0;
const failures = [];
const check = (name, ok, detail = '') => { if (ok) passed++; else failures.push(`${name}${detail ? ` — ${detail}` : ''}`); };
const J = JSON.stringify;

// ── sshd_config ─────────────────────────────────────────────────────────────
{
  const files = FX.files;
  const inc = (pattern) => {
    const dir = '/etc/ssh/sshd_config.d';
    if (!pattern.startsWith(dir) && !pattern.startsWith('sshd_config.d')) return [{ path: pattern, text: null }];
    return (FX.dirs[dir] ?? []).sort().map((n) => ({ path: `${dir}/${n}`, text: files[`${dir}/${n}`] ?? null }));
  };
  const c = P.parseSshdConfig({ path: '/etc/ssh/sshd_config', text: files['/etc/ssh/sshd_config'] }, inc);
  check('sshd: the main file is read and both includes are listed', c && c.files.length === 3, J(c?.files));
  check('sshd: the root-only 50-cloud-init.conf is reported unreadable', J(c?.unreadable) === J(['/etc/ssh/sshd_config.d/50-cloud-init.conf']), J(c?.unreadable));
  check('sshd: PermitRootLogin yes comes from the main file and is uncertain (an unreadable include is read first)',
    c.values.permitrootlogin.value === 'yes' && c.values.permitrootlogin.source === '/etc/ssh/sshd_config' && c.values.permitrootlogin.uncertain, J(c.values.permitrootlogin));
  check('sshd: PasswordAuthentication no comes from 60-cloudimg-settings.conf (first value wins), still uncertain',
    c.values.passwordauthentication.value === 'no' && /60-cloudimg/.test(c.values.passwordauthentication.source) && c.values.passwordauthentication.uncertain, J(c.values.passwordauthentication));
  check('sshd: a directive nobody sets takes the OpenSSH default', c.values.maxauthtries.value === '6' && c.values.maxauthtries.source === 'default');

  const clean = P.parseSshdConfig({ path: '/etc/ssh/sshd_config', text: 'PermitRootLogin no\nPasswordAuthentication yes\nPasswordAuthentication no\n' }, () => []);
  check('sshd: with every file readable nothing is uncertain, and the first value wins', !clean.values.permitrootlogin.uncertain && clean.values.passwordauthentication.value === 'yes');
  const match = P.parseSshdConfig({ path: '/x', text: 'X11Forwarding no\nMatch User bob\n  PermitRootLogin yes\n  X11Forwarding yes\n' }, () => []);
  check('sshd: a Match block is not global', match.values.permitrootlogin.source === 'default' && match.values.x11forwarding.value === 'no');
  const eq = P.parseSshdConfig({ path: '/x', text: '  PermitRootLogin=without-password  # old spelling\n' }, () => []);
  check('sshd: key=value, comments and case', eq.values.permitrootlogin.value === 'without-password');
  check('sshd: an unreadable main file is null (unknown), never defaults', P.parseSshdConfig({ path: '/x', text: null }, () => []) === null);
  let loops = 0;
  P.parseSshdConfig({ path: '/a', text: 'Include /a\n' }, () => { loops++; return [{ path: '/a', text: 'Include /a\n' }]; });
  check('sshd: an include loop stops', loops <= 2, String(loops));
}

// ── sshd ordering (0.75.1): first match wins across Include'd drop-ins ──────
{
  const D = '/etc/ssh/sshd_config.d';
  const host = (main, drops) => P.parseSshdConfig({ path: '/etc/ssh/sshd_config', text: main },
    () => Object.keys(drops).sort().map((n) => ({ path: `${D}/${n}`, text: drops[n] })));
  const mainTop = 'Include /etc/ssh/sshd_config.d/*.conf\nPermitRootLogin yes\nPasswordAuthentication yes\nX11Forwarding yes\n';
  // The host that prompted 0.75.1: 40-rem0te.conf (readable) sorts before 50-cloud-init.conf (root 0600).
  const prod = host(mainTop, { '40-rem0te.conf': 'PermitRootLogin no\n', '50-cloud-init.conf': null, '60-cloudimg-settings.conf': 'PasswordAuthentication no\n' });
  check('sshd order: a readable earlier drop-in decides the value for certain (PermitRootLogin no from 40-rem0te.conf)',
    prod.values.permitrootlogin.value === 'no' && /40-rem0te/.test(prod.values.permitrootlogin.source) && !prod.values.permitrootlogin.uncertain && J(prod.values.permitrootlogin.unreadableBefore) === '[]', J(prod.values.permitrootlogin));
  check('sshd order: a value first readable after the unreadable file stays unsure, and names the file',
    prod.values.passwordauthentication.uncertain && J(prod.values.passwordauthentication.unreadableBefore) === J([`${D}/50-cloud-init.conf`]), J(prod.values.passwordauthentication));
  const late = host(mainTop, { '50-cloud-init.conf': null, '60-x.conf': 'PermitRootLogin no\n' });
  check('sshd order: the same setting in a drop-in that sorts after the unreadable one is unsure', late.values.permitrootlogin.value === 'no' && late.values.permitrootlogin.uncertain);
  const early = host(mainTop, { '01-first.conf': 'PermitRootLogin prohibit-password\nPasswordAuthentication no\n', '50-cloud-init.conf': null });
  check('sshd order: a drop-in sorting first decides both directives, whatever the unreadable file says', !early.values.permitrootlogin.uncertain && !early.values.passwordauthentication.uncertain && early.values.passwordauthentication.value === 'no');
  const mainFirst = host('PermitRootLogin no\nInclude /etc/ssh/sshd_config.d/*.conf\n', { '50-cloud-init.conf': null });
  check('sshd order: a value set in sshd_config above the Include is certain', mainFirst.values.permitrootlogin.value === 'no' && !mainFirst.values.permitrootlogin.uncertain);
  const allReadable = host(mainTop, { '50-cloud-init.conf': 'PasswordAuthentication yes\n', '60-cloudimg-settings.conf': 'PasswordAuthentication no\n' });
  check('sshd order: with every file readable, the lexically first drop-in wins (50 before 60) and nothing is unsure',
    allReadable.values.passwordauthentication.value === 'yes' && /50-cloud-init/.test(allReadable.values.passwordauthentication.source) && allReadable.unreadable.length === 0);
  const dflt = host(mainTop, { '50-cloud-init.conf': null });
  check('sshd order: a default after an unreadable file is unsure', dflt.values.maxauthtries.source === 'default' && dflt.values.maxauthtries.uncertain);
  const lex = host(mainTop, { '9-a.conf': 'PermitRootLogin no\n', '10-b.conf': null });
  check("sshd order: lexical, not numeric ('10-b' sorts before '9-a', so 9-a's value is unsure)", lex.values.permitrootlogin.uncertain && J(lex.values.permitrootlogin.unreadableBefore) === J([`${D}/10-b.conf`]));
}

// ── Firewall and listeners ──────────────────────────────────────────────────
{
  check('ufw.conf ENABLED=yes', P.parseUfwConf(FX.files['/etc/ufw/ufw.conf']) === true);
  check('ufw.conf ENABLED=no', P.parseUfwConf('ENABLED=no\n') === false);
  check('ufw.conf missing is unknown', P.parseUfwConf(null) === null && P.parseUfwConf('# nothing\n') === null);
  const ls = P.parseSsListeners(FX.commands['ss -Htlnup'].stdout);
  check('ss: every socket parsed', ls && ls.length === 27, String(ls?.length));
  check('ss: loopback, interface-scoped and wildcard addresses', ls.find((l) => l.port === 3001).loopback && ls.find((l) => l.address === '127.0.0.53%lo').loopback && !ls.find((l) => l.proto === 'tcp' && l.port === 443).loopback);
  check('ss: the state column is kept (LISTEN, UNCONN)', ls.find((l) => l.proto === 'tcp' && l.port === 22).state === 'LISTEN' && ls.find((l) => l.port === 33344).state === 'UNCONN');
  check("ss -p: an owner this user may see is kept; root's (hbbs) prints none", ls.find((l) => l.port === 8080).process === 'node' && ls.find((l) => l.port === 3001).process === 'node' && ls.find((l) => l.port === 33344).process === null);
  check('ss -p: an owner outside the charset is dropped', P.parseSsListeners('tcp LISTEN 0 1 0.0.0.0:9 0.0.0.0:* users:(("a b;rm",pid=1,fd=2))\n')[0].process === null);
  const range = P.parsePortRange(FX.files['/proc/sys/net/ipv4/ip_local_port_range']);
  check('port range: 32768–60999 from the tab-separated sysctl', range && range.low === 32768 && range.high === 60999, J(range));
  check('port range: unreadable, garbage or reversed is null', P.parsePortRange(null) === null && P.parsePortRange('abc') === null && P.parsePortRange('60999 32768') === null && P.parsePortRange('0 70000') === null);
  const before = P.unexpectedListeners(ls);
  check('ss: without the range nothing is excused (udp/33344 is unexpected, as in 0.74)', J(before.map((l) => `${l.proto}/${l.port}`)) === J(['udp/33344', 'udp/5353', 'tcp/8080']), J(before));
  const u = P.unexpectedListeners(ls, range);
  check('ss: with the range, an unconnected UDP socket on an ephemeral port is not a public service; udp/5353 and tcp/8080 still are', J(u.map((l) => `${l.proto}/${l.port}`)) === J(['udp/5353', 'tcp/8080']), J(u));
  check('ss: the excused socket is listed as an ephemeral client socket', J(P.ephemeralClientSockets(ls, range).map((l) => `${l.proto}/${l.port}`)) === J(['udp/33344']));
  const tcpEph = P.parseSsListeners('tcp LISTEN 0 128 0.0.0.0:40000 0.0.0.0:*\n');
  check('ss: a TCP listener inside the ephemeral range is still unexpected', P.unexpectedListeners(tcpEph, range).length === 1 && P.ephemeralClientSockets(tcpEph, range).length === 0);
  const edges = P.parseSsListeners('udp UNCONN 0 0 *:32767 *:*\nudp UNCONN 0 0 *:32768 *:*\nudp UNCONN 0 0 *:60999 *:*\nudp UNCONN 0 0 *:61000 *:*\nudp ESTAB 0 0 10.0.0.1:40000 10.0.0.2:53\nudp UNCONN 0 0 127.0.0.1:40001 0.0.0.0:*\n');
  check('ss: the range is inclusive at both ends; outside it, or connected, is judged as before; loopback is never public',
    J(P.unexpectedListeners(edges, range).map((l) => l.port)) === J([32767, 61000, 40000]) && J(P.ephemeralClientSockets(edges, range).map((l) => l.port)) === J([32768, 60999]), J(P.unexpectedListeners(edges, range)));
  check('ss: garbage is unknown', P.parseSsListeners('this is not ss output at all\n') === null);
  check('ss: no listeners is an empty list', J(P.parseSsListeners('')) === '[]');
}

// ── apt ─────────────────────────────────────────────────────────────────────
{
  const pk = P.parseAptUpgradable(FX.commands['apt list --upgradable'].stdout);
  check('apt: eleven packages with versions', pk && pk.length === 11 && pk.every((p) => p.name && p.version && p.from), J(pk?.[0]));
  check('apt: noble-updates alone is not security', pk.every((p) => !p.security));
  const sec = P.parseAptUpgradable('Listing...\nlibc6/noble-updates,noble-security 2.39-0ubuntu8.6 amd64 [upgradable from: 2.39-0ubuntu8.5]\n');
  check('apt: a package also in noble-security is a security update', sec[0].security && J(sec[0].suites) === J(['noble-updates', 'noble-security']));
  check('apt: "Listing..." alone is up to date, not unknown', J(P.parseAptUpgradable('Listing...\n')) === '[]');
  check('apt: an error is unknown, never "up to date"', P.parseAptUpgradable('E: Could not open lock file\n') === null && P.parseAptUpgradable('') === null);
  check('apt: the "unstable CLI" warning is ignored', P.parseAptUpgradable('WARNING: apt does not have a stable CLI interface.\nListing...\n').length === 0);
  const au = P.parseAutoUpgrades(FX.files['/etc/apt/apt.conf.d/20auto-upgrades']);
  check('20auto-upgrades: both on', au.updateLists && au.unattended);
  check('20auto-upgrades: "0" is off, missing is unknown', P.parseAutoUpgrades('APT::Periodic::Unattended-Upgrade "0";\n').unattended === false && P.parseAutoUpgrades(null) === null);
  check('reboot-required.pkgs: deduplicated', J(P.parseRebootPkgs(FX.files['/var/run/reboot-required.pkgs'])) === J(['linux-image-6.8.0-149-generic', 'linux-base', 'libc6', 'linux-image-6.8.0-151-generic']));
}

// ── fail2ban ────────────────────────────────────────────────────────────────
{
  const st = FX.commands['sudo -n /usr/local/sbin/rem0te-f2b status'].stdout;
  check('f2b: the jail list', J(P.parseF2bStatus(st)) === J(['sshd', 'www']));
  check('f2b: sudo refusing is unknown, not "no jails"', P.parseF2bStatus('sudo: a password is required\n') === null && P.parseF2bStatus('') === null);
  check('f2b: no jails is an empty list', J(P.parseF2bStatus('Status\n|- Number of jail:\t0\n`- Jail list:\t\n')) === '[]');
  const j = P.parseF2bJail(FX.commands['sudo -n /usr/local/sbin/rem0te-f2b status sshd'].stdout);
  check('f2b jail: counts and banned addresses', j && j.currentBanned === 2 && j.totalBanned === 41 && j.currentFailed === 3 && J(j.bannedIps) === J(['198.51.100.7', '203.0.113.9']), J(j));
  check('f2b jail: the journal match is kept', j.journalMatches === '_SYSTEMD_UNIT=sshd.service + _COMM=sshd' && j.fileList === null);
  check('f2b jail: a journal match on sshd.service on a host running ssh.service is noticed', P.jailWatchesOtherUnit(j.journalMatches, 'ssh.service') === 'sshd.service');
  check('f2b jail: the right unit, or a file backend, is not', P.jailWatchesOtherUnit('_SYSTEMD_UNIT=ssh.service + _COMM=sshd', 'ssh.service') === null && P.jailWatchesOtherUnit(null, 'ssh.service') === null);
  check('f2b jail: unparsable is null', P.parseF2bJail('Sorry but the jail does not exist') === null);
  check('f2b ignoreip', J(P.parseIgnoreIps('These IP addresses/networks are ignored:\n|- 127.0.0.0/8\n|- ::1\n`- 192.0.2.0/24\n')) === J(['127.0.0.0/8', '::1', '192.0.2.0/24']));
  check('f2b ignoreip: none', J(P.parseIgnoreIps('No IP address/network is ignored\n')) === '[]');
  check('f2b numbers', P.parseF2bNumber('3600\n') === 3600 && P.parseF2bNumber('-1') === -1 && P.parseF2bNumber('abc') === null);
  check('address: v4, v4 CIDR, v6, v6 CIDR', ['192.0.2.1', '10.0.0.0/8', '2001:db8::1', '2001:db8::/32', '::1'].every(P.validAddress));
  check('address: refuses junk, bad octets, bad prefixes and option-looking input', !['', '1.2.3', '256.1.1.1', '1.2.3.4/33', '1.2.3.4/8/8', '-1.2.3.4', '2001:db8::1::2', '1.2.3.4 actionban', 'a.b.c.d', 12].some(P.validAddress));
  check('jail names', P.validJail('sshd') && P.validJail('reboot-remote') && !P.validJail('a b') && !P.validJail('') && !P.validJail('x'.repeat(65)));
}

// ── The closed command list (host-runner.ts), as the rem0te-f2b wrapper checks ──
{
  check('argv: f2b status goes through sudo -n and the wrapper', J(R.argvFor({ id: 'f2b', args: ['status'] }, '/c')) === J(['sudo', '-n', '/usr/local/sbin/rem0te-f2b', 'status']));
  check('argv: a read cannot be a set', R.argvFor({ id: 'f2b', args: ['set', 'sshd', 'banip', '192.0.2.1'] }, '/c') === null);
  check('argv: a change cannot be a read', R.argvFor({ id: 'f2b.change', args: ['status'] }, '/c') === null);
  check('argv: the actionban root shell shape is refused', R.argvFor({ id: 'f2b.change', args: ['set', 'sshd', 'action', 'x'] }, '/c') === null
    && R.argvFor({ id: 'f2b.change', args: ['set', 'sshd', 'banip', "1 actionban 'id'"] }, '/c') === null);
  check('argv: numbers only for bantime', R.argvFor({ id: 'f2b.change', args: ['set', 'sshd', 'bantime', '-1'] }, '/c') === null && R.argvFor({ id: 'f2b.change', args: ['set', 'sshd', 'bantime', '3600'] }, '/c') !== null);
  check('argv: units are a closed list', R.argvFor({ id: 'unit.active', unit: 'sshd; reboot' }, '/c') === null && R.argvFor({ id: 'unit.active', unit: 'caddy' }, '/c')[2] === 'caddy');
  check('argv: apt upgrade is exactly the sudoers line', J(R.argvFor({ id: 'apt.upgrade' }, '/c')) === J(['sudo', '-n', '/usr/bin/apt-get', 'upgrade', '-y', '--allow-downgrades', '-o', 'Dpkg::Options::=--force-confold']));
  const sudoers = readFileSync(join(here, '..', '..', '..', 'deploy', 'scripts', 'install.sh'), 'utf8');
  const granted = [...sudoers.matchAll(/^reboot ALL=\(root\) NOPASSWD: (\/\S+(?: [^\n!]+)?)$/gm)].map((m) => m[1].replace(/\\:/g, ':').replace(/\\=/g, '='));
  const sudoCmds = ['f2b.install', 'f2b.enable', 'f2b.start', 'apt.update', 'apt.upgrade'].map((id) => R.argvFor({ id }, '/c').slice(2).join(' '));
  const missing = sudoCmds.filter((c) => !granted.includes(c));
  check('argv: every sudo command is a line the installer grants, word for word', missing.length === 0, `not granted: ${J(missing)}`);
  check('argv: npm audit is production-only JSON', J(R.argvFor({ id: 'npm.audit' }, '/c')) === J(['npm', 'audit', '--omit=dev', '--json', '--cache', '/c']));
}

// ── Caddy, certificates, headers ────────────────────────────────────────────
{
  check('Caddyfile: the TLS sites only (not the http:// IP redirect)', J(P.parseCaddyDomains(FX.files['/etc/caddy/Caddyfile'])) === J(['remote.example.com', 'approve.example.com']), J(P.parseCaddyDomains(FX.files['/etc/caddy/Caddyfile'])));
  check('Caddyfile: several names on one line', J(P.parseCaddyDomains('a.example.com, b.example.com {\n}\n')) === J(['a.example.com', 'b.example.com']));
  check('Caddyfile: unreadable is empty', J(P.parseCaddyDomains(null)) === '[]');
  const now = Date.parse('2026-11-20T12:00:00Z');
  const cs = (d) => P.certStatus(d, now);
  check('cert: 63 days is ok', cs('Jan 22 09:43:00 2027 GMT').level === 'ok' && cs('Jan 22 09:43:00 2027 GMT').daysLeft === 62);
  check('cert: 15 days means renewal is failing', cs('Dec 5 12:00:00 2026 GMT').level === 'renewal_failing');
  check('cert: 3 days is urgent, past is expired', cs('Nov 23 12:00:00 2026 GMT').level === 'urgent' && cs('Nov 1 00:00:00 2026 GMT').level === 'expired');
  check('cert: no date is unknown', P.certStatus(null, now) === null && P.certStatus('not a date', now) === null);

  const h = P.evaluateHeaders(FX.https.headers);
  const v = Object.fromEntries(h.map((x) => [x.id, x.verdict]));
  check('headers: the production set passes HSTS, CSP, framing, nosniff, referrer', v.hsts === 'ok' && v.csp === 'ok' && v.framing === 'ok' && v.nosniff === 'ok' && v.referrer === 'ok', J(v));
  check('headers: no Permissions-Policy is reported', v.permissions === 'missing');
  check('headers: no Server header on https (Caddy -Server)', !('server' in v));
  const bad = Object.fromEntries(P.evaluateHeaders({ 'strict-transport-security': 'max-age=300', server: 'Caddy', 'x-powered-by': 'Express', 'referrer-policy': 'unsafe-url' }).map((x) => [x.id, x.verdict]));
  check('headers: short HSTS is weak, missing CSP and framing, disclosure noticed', bad.hsts === 'weak' && bad.csp === 'missing' && bad.framing === 'missing' && bad.server === 'disclosed' && bad.powered === 'disclosed' && bad.referrer === 'weak', J(bad));
  check('headers: frame-ancestors alone protects framing', P.evaluateHeaders({ 'content-security-policy': "default-src 'self'; frame-ancestors 'none'" }).find((x) => x.id === 'framing').verdict === 'ok');
}

// ── npm audit ───────────────────────────────────────────────────────────────
{
  const clean = P.parseNpmAudit(J({ auditReportVersion: 2, vulnerabilities: {}, metadata: { vulnerabilities: { info: 0, low: 0, moderate: 0, high: 0, critical: 0, total: 0 }, dependencies: { prod: 244, total: 244 } } }));
  check('npm audit: a clean report', clean && clean.counts.critical === 0 && clean.dependencies === 244 && clean.packages.length === 0);
  const dirty = P.parseNpmAudit(J({ vulnerabilities: {
    a: { severity: 'moderate', isDirect: false, via: ['b'], fixAvailable: true },
    b: { severity: 'critical', isDirect: true, via: [{ title: 'Prototype pollution' }], fixAvailable: false },
  }, metadata: { vulnerabilities: { critical: 1, moderate: 1 }, dependencies: { prod: 10 } } }));
  check('npm audit: severities sorted, titles from advisories only', dirty.packages[0].name === 'b' && J(dirty.packages[0].titles) === J(['Prototype pollution']) && dirty.packages[1].titles.length === 0 && dirty.counts.high === 0);
  check('npm audit: an error object is unknown, never clean', P.parseNpmAudit(J({ error: { code: 'ENOLOCK', summary: 'This command requires an existing lockfile.' } })) === null);
  check('npm audit: not JSON is unknown', P.parseNpmAudit('npm ERR! network') === null && P.parseNpmAudit('') === null);
}

// ── Posture: the score never treats unknown as passing ──────────────────────
{
  const f = (status, severity) => ({ id: `${status}-${severity}-${Math.random()}`, area: 'host', title: 't', status, severity, evidence: 'e', checkedAt: 'x' });
  const all = S.scoreOf([f('pass', 'high'), f('pass', 'medium')]);
  check('score: all passing is 100, good, full coverage', all.score === 100 && all.grade === 'good' && all.coverage === 100);
  const unk = S.scoreOf([f('unknown', 'critical'), f('unknown', 'high')]);
  check('score: nothing decided is no score at all', unk.score === null && unk.grade === 'unknown' && unk.coverage === 0);
  const mixed = S.scoreOf([f('pass', 'high'), f('unknown', 'critical'), f('unknown', 'high'), f('unknown', 'low')]);
  check('score: unknowns lower the coverage, never raise the grade on their own', mixed.score === 100 && mixed.coverage === 25);
  const crit = S.scoreOf([f('fail', 'critical'), f('pass', 'low')]);
  check('score: a failing critical is poor', crit.grade === 'poor' && crit.score === 75);
  const high = S.scoreOf([f('fail', 'high'), f('pass', 'low')]);
  check('score: a failing high is at best fair', high.grade === 'fair' && high.score === 88);
  check('score: info findings neither score nor count against coverage', S.scoreOf([f('info', 'info'), f('pass', 'low')]).coverage === 100);
  const sw = S.offSwitches({ STALE_SWEEP: 'off', MONITOR_SWEEP: 'OFF', SSO_SESSION_SWEEP: '0', AUDIT_SEALER: 'off' }).map((s) => s.name);
  check('switches: exactly "off" counts', J(sw) === J(['STALE_SWEEP', 'AUDIT_SEALER']), J(sw));
  check('switches: STALE_SWEEP and SSO_SESSION_SWEEP are critical (CLAUDE.md: never in production)', S.OFF_SWITCHES.find((s) => s.name === 'STALE_SWEEP').severity === 'critical' && S.OFF_SWITCHES.find((s) => s.name === 'SSO_SESSION_SWEEP').severity === 'critical');
  check('NODE_ENV=test is critical, production passes', S.nodeEnvFinding({ NODE_ENV: 'test' }, 'x').severity === 'critical' && S.nodeEnvFinding({ NODE_ENV: 'production' }, 'x').status === 'pass' && S.nodeEnvFinding({}, 'x').status === 'fail');
}

// ── Accepted risks (0.75.1) ─────────────────────────────────────────────────
{
  const never = A.NEVER_ACCEPTABLE.map((n) => n.id);
  check('accept: the never-acceptable list is exactly the decided one', J(never) === J(['portal.mfa.admins', 'portal.admins', 'portal.audit_chain', 'host.ssh.empty_passwords', 'process.node_env', 'process.switch.', 'web.tls']), J(never));
  check('accept: no acceptable id is never-acceptable (the lists are disjoint)', A.ACCEPTABLE_FINDINGS.every((id) => A.neverAcceptable(id) === null));
  check('accept: a Platform Admin without MFA, NODE_ENV, a test switch, the chain and TLS are refused with a reason',
    ['portal.mfa.admins', 'process.node_env', 'process.switch.STALE_SWEEP', 'process.switch.AGENT_AUTO_UPDATE', 'portal.audit_chain', 'web.tls', 'web.tls.remote.example.com', 'host.ssh.empty_passwords'].every((id) => !A.isAcceptable(id) && typeof A.neverAcceptable(id) === 'string'));
  check('accept: SSH, listeners and audit export are acceptable; an unknown id is not', A.isAcceptable('host.ssh.password_auth') && A.isAcceptable('network.listeners') && A.isAcceptable('portal.audit_export') && !A.isAcceptable('host.nope') && !A.isAcceptable('network.ephemeral_sockets'));
  const mig = readFileSync(join(here, '..', 'prisma', 'migrations', '0093_security_risk_acceptance', 'migration.sql'), 'utf8');
  const sqlIds = [...(/"findingId" IN \(([\s\S]*?)\)\);/.exec(mig)?.[1] ?? '').matchAll(/'([^']+)'/g)].map((m) => m[1]);
  check("accept: migration 0093's CHECK names exactly ACCEPTABLE_FINDINGS, in order", J(sqlIds) === J(A.ACCEPTABLE_FINDINGS), `${sqlIds.length} vs ${A.ACCEPTABLE_FINDINGS.length}`);

  check('reason: trimmed, 3–300 characters', A.cleanReason('  behind the hardware firewall  ') === 'behind the hardware firewall' && A.cleanReason('ab') === null && A.cleanReason('  ab  ') === null && A.cleanReason('x'.repeat(300)) !== null && A.cleanReason('x'.repeat(301)) === null);
  check('reason: not a string, or with control characters, is refused', A.cleanReason(42) === null && A.cleanReason(undefined) === null && A.cleanReason('ok\u0000then') === null && A.cleanReason('line\u001bescape') === null);
  const now = new Date('2026-11-21T12:00:00Z');
  check('expiry: none by default', A.expiryFor(undefined, now) === null && A.expiryFor(null, now) === null);
  check('expiry: 1 and 365 days are allowed', A.expiryFor(1, now).toISOString() === '2026-11-22T12:00:00.000Z' && A.expiryFor(365, now).getTime() - now.getTime() === 365 * 86_400_000);
  check('expiry: 0, 366, fractions and strings are refused', [0, 366, 1.5, '30', -1].every((d) => A.expiryFor(d, now) === undefined));

  const base = { id: 'network.listeners', status: 'fail', evidence: 'Not loopback and not expected: udp/5353 on 0.0.0.0, tcp/8080 on 0.0.0.0 (node).', basis: { unexpected: ['tcp/8080@0.0.0.0', 'udp/5353@0.0.0.0'], rangeRead: true } };
  const fp = A.fingerprintOf(base);
  check('fingerprint: sha256 hex, the same for the same facts', /^[0-9a-f]{64}$/.test(fp) && fp === A.fingerprintOf({ ...base }));
  check('fingerprint: key order in the basis does not matter', fp === A.fingerprintOf({ ...base, basis: { rangeRead: true, unexpected: base.basis.unexpected } }));
  check('fingerprint: the wording and the time it was read do not matter (only the basis)', fp === A.fingerprintOf({ ...base, evidence: 'reworded', checkedAt: 'later' }));
  check('fingerprint: a new offending port changes it', fp !== A.fingerprintOf({ ...base, basis: { ...base.basis, unexpected: [...base.basis.unexpected, 'tcp/9000@0.0.0.0'] } }));
  check('fingerprint: the status is part of it (fail → unknown moves it)', fp !== A.fingerprintOf({ ...base, status: 'unknown' }));
  check('fingerprint: without a basis it is the evidence', A.fingerprintOf({ id: 'x', status: 'unknown', evidence: 'a' }) !== A.fingerprintOf({ id: 'x', status: 'unknown', evidence: 'b' }));
  const sshA = { id: 'host.ssh.password_auth', status: 'unknown', evidence: 'e', basis: { value: 'no', source: '/etc/ssh/sshd_config.d/60-cloudimg-settings.conf', unreadableBefore: ['/etc/ssh/sshd_config.d/50-cloud-init.conf'] } };
  check('fingerprint: an SSH value that moves to another file changes it', A.fingerprintOf(sshA) !== A.fingerprintOf({ ...sshA, basis: { ...sshA.basis, source: '/etc/ssh/sshd_config.d/01-rem0te.conf', unreadableBefore: [] } }));

  const row = { id: 'r1', findingId: 'network.listeners', status: 'fail', fingerprint: fp, reason: 'r', evidence: 'e', acceptedById: 'u', acceptedAt: new Date('2026-11-20T00:00:00Z'), expiresAt: null };
  const live = { ...base, area: 'network', title: 't', severity: 'medium', checkedAt: 'x', fingerprint: fp };
  check('standing: the same evidence holds', A.acceptanceStanding(row, live, now) === 'holds');
  check('standing: moved evidence re-opens (evidence_changed)', A.acceptanceStanding(row, { ...live, fingerprint: 'f'.repeat(64) }, now) === 'evidence_changed');
  check('standing: a check that now passes, is info, or is gone re-opens (resolved)', A.acceptanceStanding(row, { ...live, status: 'pass' }, now) === 'resolved' && A.acceptanceStanding(row, { ...live, status: 'info' }, now) === 'resolved' && A.acceptanceStanding(row, undefined, now) === 'resolved');
  check('standing: at its expiry it re-opens (expired), even with the same evidence', A.acceptanceStanding({ ...row, expiresAt: now }, live, now) === 'expired' && A.acceptanceStanding({ ...row, expiresAt: new Date(now.getTime() + 1000) }, live, now) === 'holds');
  check('standing: expiry is checked before the evidence', A.acceptanceStanding({ ...row, expiresAt: new Date(0) }, { ...live, fingerprint: 'f'.repeat(64) }, now) === 'expired');
  check('reopen causes are a closed list', J(A.REOPEN_CAUSES) === J(['evidence_changed', 'expired', 'resolved', 'unaccepted']));

  // The score: accepted is never pass, carries no penalty, and leaves coverage alone.
  const f = (status, severity, accepted) => ({ id: `${status}-${severity}-${Math.random()}`, area: 'host', title: 't', status, severity, evidence: 'e', checkedAt: 'x', ...(accepted ? { acceptance: { id: 'a' } } : {}) });
  const plain = S.scoreOf([f('fail', 'high'), f('unknown', 'medium'), f('pass', 'low')]);
  const acc = S.scoreOf([f('fail', 'high', true), f('unknown', 'medium', true), f('pass', 'low')]);
  check('score: accepted findings carry no penalty and are counted as accepted, not fail, unknown or pass',
    acc.score === 100 && acc.counts.accepted === 2 && acc.counts.fail === 0 && acc.counts.unknown === 0 && acc.counts.pass === 1 && plain.score === 88, J(acc));
  check('score: accepting does not change coverage (an accepted unknown was still not read)', acc.coverage === plain.coverage && acc.coverage === 67, `${acc.coverage} vs ${plain.coverage}`);
  check('score: an acceptance on a passing finding is ignored', S.scoreOf([f('pass', 'low', true)]).counts.accepted === 0);
}

// ── The service's lockout rule: tightening never asks ───────────────────────
{
  const Svc = require(join(here, '..', 'dist', 'admin', 'security.service.js')).SecurityService;
  const w = (b, n) => Svc.weakens(b, n);
  const base = { maxLoginAttempts: 5, lockoutMinutes: 15 };
  check('lockout: more attempts weakens', w(base, { maxLoginAttempts: 6 }));
  check('lockout: turning it off weakens', w(base, { maxLoginAttempts: 0 }));
  check('lockout: a shorter lockout weakens', w(base, { lockoutMinutes: 5 }));
  check('lockout: fewer attempts or a longer lockout does not', !w(base, { maxLoginAttempts: 3 }) && !w(base, { lockoutMinutes: 60 }) && !w(base, {}));
  check('lockout: turning it back on from off does not', !w({ maxLoginAttempts: 0, lockoutMinutes: 15 }, { maxLoginAttempts: 10 }));
}

console.log(`unit-host-security: ${passed} passed, ${failures.length} failed`);
if (failures.length) { for (const f of failures) console.log(`  ✗ ${f}`); process.exit(1); }
