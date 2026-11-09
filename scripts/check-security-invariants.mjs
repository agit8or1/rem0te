#!/usr/bin/env node
/**
 * Static checks for security properties that failed silently once already.
 *
 * Each of these was a real finding, and each shares a shape: the code looks
 * correct, nothing throws, and the protection simply is not there. A test would
 * need a database and a browser to catch them; grep catches them in CI.
 *
 * Run: node scripts/check-security-invariants.mjs
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(ROOT, p), 'utf8');
const failures = [];
const check = (label, ok, detail) => {
  if (ok) console.log(`  ✓ ${label}`);
  else failures.push(`${label}\n      ${detail}`);
};

function walk(dir, out = []) {
  for (const name of readdirSync(join(ROOT, dir))) {
    const rel = `${dir}/${name}`;
    if (name === 'node_modules' || name === 'dist' || name === '.next') continue;
    if (statSync(join(ROOT, rel)).isDirectory()) walk(rel, out);
    else if (/\.tsx?$/.test(name)) out.push(rel);
  }
  return out;
}

// 1. Rate limits: a route override naming a throttler that is not configured is
//    ignored by the guard, silently, and the route runs at the global limit.
const throttling = read('apps/api/src/common/throttling.ts');
const names = [...throttling.matchAll(/THROTTLER_[A-Z]+ = '([a-z]+)'/g)].map((m) => m[1]);
const appModule = read('apps/api/src/app.module.ts');
check(
  'every configured throttler name comes from common/throttling.ts',
  names.length >= 1 && names.every((n) => appModule.includes('THROTTLER_')) && !/name: '/.test(appModule),
  'app.module.ts should name its throttlers with the THROTTLER_* constants, not string literals',
);
for (const file of walk('apps/api/src')) {
  // Skip the definition itself: its doc comment quotes the broken form on purpose.
  if (file.endsWith('common/throttling.ts')) continue;
  const src = read(file);
  for (const m of src.matchAll(/@Throttle\(\{\s*([a-zA-Z_]+)\s*:/g)) {
    check(
      `${file}: @Throttle names a configured throttler`,
      names.includes(m[1]),
      `"${m[1]}" is not one of: ${names.join(', ')} — prefer RateLimit() from common/throttling.ts`,
    );
  }
}

// 2. A pre-MFA token must never authenticate a request.
const strategy = read('apps/api/src/auth/strategies/jwt.strategy.ts');
check(
  'JwtStrategy rejects pre-MFA (partial) tokens',
  /if \(payload\.partial\) \{[\s\S]{0,200}throw new UnauthorizedException/.test(strategy),
  'validate() must throw on payload.partial — accepting one makes the second factor optional',
);

// 3. The device heartbeat must not take the RustDesk ID as identity.
const enrollment = read('apps/api/src/enrollment/enrollment.service.ts');
check(
  'heartbeat checks the device secret before trusting a caller',
  enrollment.includes('secretMatches(') && enrollment.includes('authenticated'),
  'heartbeat() must verify agentSecret against RustdeskNode.agentSecretHash',
);

// 4. sudo grants stay pinned to argument vectors.
const sudoers = read('deploy/scripts/install.sh');
check(
  'no unrestricted sudo grant for fail2ban-client',
  !/NOPASSWD: \/usr\/bin\/fail2ban-client\s*$/m.test(sudoers),
  'an argument-less fail2ban-client grant is a root shell (set <jail> action ... runs as root)',
);

// 4b. …and the two grants that were root shells are gone (0.18.22). Root-side
//     argument checking lives in the wrappers under deploy/sbin; the sudoers
//     file may name only those, never the binaries behind them.
check(
  'fail2ban-client and dpkg are reached only through the root-owned wrappers',
  !/NOPASSWD: \/usr\/bin\/fail2ban-client/.test(sudoers) &&
    !/NOPASSWD: \/usr\/bin\/dpkg/.test(sudoers) &&
    /NOPASSWD: \/usr\/local\/sbin\/rem0te-f2b$/m.test(sudoers) &&
    /NOPASSWD: \/usr\/local\/sbin\/rem0te-rustdesk-server-upgrade$/m.test(sudoers),
  'a sudoers `*` matches spaces, so per-subcommand fail2ban rules admitted actionban; ' +
  'dpkg -i on an API-writable path installs any package the API user drops there',
);

// 3b. A node with no stored secret is never bound by a heartbeat. First-sight
//     binding made the secret worthless for exactly the nodes that lacked one.
const heartbeatBody = enrollment.slice(enrollment.indexOf('async heartbeat('), enrollment.indexOf('async commandResult('));
check(
  'heartbeat never binds a first device secret to an existing node',
  heartbeatBody.length > 0 &&
    !/rustdeskNode\.update\(\{\s*where: \{ id: node\.id \},\s*data: \{ agentSecretHash/.test(heartbeatBody),
  'binding belongs to claimEndpoint, which redeems an operator-issued token',
);

// 3c. Claim tokens are single-use under concurrency too.
check(
  'deviceClaimToken is consumed with a conditional update',
  /deviceClaimToken\.updateMany\(\{[\s\S]{0,120}claimedAt: null/.test(enrollment),
  'read-test-write lets two installers racing one token both enroll',
);

// 3d. Device-reported strings never reach the Connect .cmd unfiltered.
const rustdeskSvc = read('apps/api/src/common/rustdesk.service.ts');
check(
  'buildConnectCmd reduces device-reported names to an inert charset',
  /const endpointName = RustdeskService\.cmdSafe\(opts\.endpointName\)/.test(rustdeskSvc) &&
    /const peerId = RustdeskService\.cmdSafe\(opts\.peerId\)/.test(rustdeskSvc),
  'a hostname of `PC&<command>` ran <command> as the technician who clicked Connect',
);

// 5. The launcher talks only to the server it was built for.
const launcher = read('apps/launcher/src-tauri/src/launch.rs');
check(
  'launcher pins its API origin',
  launcher.includes('allowed_api_base') && launcher.includes('same_origin'),
  'api= from a deep link must be checked against the configured origin, never used directly',
);

// 6. Single-use credentials are claimed conditionally, not read-then-written.
for (const [file, model] of [
  ['apps/api/src/launcher/launcher.service.ts', 'launcherToken'],
  ['apps/api/src/endpoints/endpoints.service.ts', 'connectionGrant'],
]) {
  check(
    `${model} is claimed with a conditional update`,
    new RegExp(`${model}\\.updateMany\\(\\{[\\s\\S]{0,120}usedAt: null`).test(read(file)),
    'read-test-write lets two simultaneous redemptions both succeed',
  );
}

// 7. The security overrides have exactly one home, and the toolchain that
//    reads it is pinned.
//
//    These two facts hold each other up. The overrides used to be mirrored in
//    package.json because pnpm <=10 reads that field and pnpm >=11 reads
//    pnpm-workspace.yaml; CI ran 11 and developers ran 10, so both copies were
//    live in different places and could drift without anything failing. The
//    mirror is gone, which is only safe while `packageManager` pins a pnpm that
//    reads the surviving file — remove the pin and every local install silently
//    loses 22 advisory overrides.
const rootPkg = JSON.parse(read('package.json'));
const pnpmPin = /^pnpm@(\d+)\./.exec(rootPkg.packageManager ?? '');

check(
  'packageManager pins pnpm 11 or newer',
  pnpmPin !== null && Number(pnpmPin[1]) >= 11,
  'pnpm <=10 reads overrides from package.json, which no longer carries them — ' +
  'without this pin a local install drops every security override',
);

check(
  'security overrides are not mirrored back into package.json',
  rootPkg.pnpm === undefined,
  'two hand-maintained copies of a pin list drift; pnpm-workspace.yaml is the only home',
);

const workspace = read('pnpm-workspace.yaml');
check(
  'pnpm-workspace.yaml still carries the overrides and build allowances',
  /^overrides:/m.test(workspace) && /^allowBuilds:/m.test(workspace),
  'the single home for the pins is empty — every advisory override is inert',
);

// 8. Every advisory override survives into the API's production manifest.
//
//    The target installs with npm from a generated manifest, and npm cannot
//    consume the pins as written: the keys use pnpm's `name@range` form, and
//    npm rejects an override for a package that is also a direct dependency.
//    The generator translates both cases — the second by intersecting the pin
//    into the dependency range. Dropping the pin instead would also make npm
//    happy, and would ship the vulnerable version. This asserts the
//    translation, not the mechanism: for every pin, the production manifest
//    must constrain that package somewhere.
const prod = JSON.parse(
  execFileSync(process.execPath, [join(ROOT, 'scripts/make-prod-manifest.mjs')], {
    encoding: 'utf8',
  }),
);
const lost = [];
for (const [, name, range] of workspace.matchAll(/^ {2}'([^'@]+)(?:@[^']*)?'\s*:\s*'([^']+)'/gm)) {
  const asOverride = prod.overrides[name] === range;
  const asDependency = (prod.dependencies[name] ?? '').includes(range);
  if (!asOverride && !asDependency) lost.push(name);
}

check(
  'every pnpm override still constrains the API production manifest',
  lost.length === 0,
  `these advisory pins vanish from the npm install at the target: ${lost.join(', ')}`,
);

// 9. Every link this server hands out is built from the one public address
//    (0.21). The installer download, launcher deep links and Connect scripts
//    embed it, and those run elevated or carry credentials. A new code path
//    reading FRONTEND_URL / PUBLIC_API_URL directly would silently ignore the
//    Settings → General value, and is where a "fall back to the Host header"
//    shortcut tends to creep in. Only PublicUrlService and the config schema
//    may read them (and the recovery CLI, which only prints them).
const ENV_READERS = new Set([
  'apps/api/src/platform/public-url.service.ts',
  'apps/api/src/config/configuration.ts',
  'apps/api/src/cli/auth-recovery.ts',
]);
const rawReaders = walk('apps/api/src').filter((f) => !ENV_READERS.has(f) && !f.endsWith('.spec.ts')).filter((f) =>
  /process\.env\.(FRONTEND_URL|PUBLIC_API_URL)\b|get<[^>]*>\(\s*['"](FRONTEND_URL|PUBLIC_API_URL)['"]/.test(read(f)));
check(
  'the public address is read only through PublicUrlService',
  rawReaders.length === 0,
  `read the address via PublicUrlService (web()/api()/…Configured()), not the environment: ${rawReaders.join(', ')}`,
);

// 10. Ticket ↔ RMM integration (0.22). The worker turns untrusted tickets and
//     model output into results; what keeps that read-only is that nothing it
//     can reach can do anything else. These hold the boundary in place.
{
  const dir = 'apps/api/src/integration';
  const files = walk(dir);
  const src = Object.fromEntries(files.map((f) => [f, read(f)]));
  const imports = (f) => [...src[f].matchAll(/from\s+'([^']+)'/g)].map((m) => m[1]);

  // a) No shell, no process spawning, anywhere in the integration.
  const shell = files.filter((f) => /child_process|\bexecSync\b|\bspawn\(|\bexecFile\(/.test(src[f]));
  check('integration code never spawns a process', shell.length === 0, shell.join(', '));

  // b) Exactly one outbound HTTP call site, and it takes a Peer, not a URL.
  const fetchers = files.filter((f) => /\bfetch\(|\bhttps?\.request\(|axios|got\(/.test(src[f]));
  check('integration has one outbound HTTP call site (signer.ts)', fetchers.length === 1 && fetchers[0].endsWith('/signer.ts'), fetchers.join(', '));
  check('signedPost targets only a peer-file URL', /const url = which === 'inference' \? peer\.inferenceUrl : peer\.eventsUrl;/.test(src[`${dir}/signer.ts`]) && /redirect: 'error'/.test(src[`${dir}/signer.ts`]),
    'signedPost must take its URL from the Peer and refuse redirects');

  // c) The worker and its module reach nothing that opens a session, issues a
  //    launcher token, queues an endpoint command or approves anything.
  const FORBIDDEN = /(sessions|launcher|quick-connect|enrollment|endpoints\/|endpoint-inventory|connection|admin\/|apikeys|downloads|public\/)/;
  for (const f of [`${dir}/worker.service.ts`, `${dir}/worker.module.ts`, `${dir}/worker.main.ts`, `${dir}/gateway.client.ts`, `${dir}/analysis.ts`, `${dir}/delegation.service.ts`]) {
    const bad = imports(f).filter((i) => FORBIDDEN.test(i));
    check(`${f.split('/').pop()} imports nothing that can launch, command or approve`, bad.length === 0, bad.join(', '));
  }
  check('worker writes no endpoint commands', !/endpointCommand|rustdeskNode\.update|supportSession|launcherToken|connectionGrant/.test(src[`${dir}/worker.service.ts`]),
    'the worker must not touch endpointCommand / sessions / launcher / grants');

  // d) Peer trust is never read from or written to the database.
  const dbPeers = files.filter((f) => /prisma\.integrationPeer|integrationPeer\.(create|update|upsert)/.test(src[f]));
  check('peer keys and URLs come from the peers file, not the database', dbPeers.length === 0, dbPeers.join(', '));

  // e) Every integration route is behind the signature guard.
  const ctl = src[`${dir}/integration.controller.ts`];
  check('IntegrationController is guarded by IntegrationAuthGuard at class level', /@UseGuards\(IntegrationAuthGuard\)\s*\n\s*@UseFilters/.test(ctl), 'class-level @UseGuards(IntegrationAuthGuard) missing');
  // f) Nonces and jtis are consumed with an atomic insert, never read-then-write.
  check('replay guard consumes with one atomic insert', /createMany\(\{[\s\S]*skipDuplicates: true/.test(src[`${dir}/replay-guard.service.ts`]), 'consume() must be a single INSERT … ON CONFLICT DO NOTHING');
  // g) The integration never acts as Platform Admin.
  check('delegated actor is never Platform Admin', /isPlatformAdmin: false,/.test(src[`${dir}/delegation.service.ts`]), 'DelegationService.checkActor must pin isPlatformAdmin: false');
  // h) Next steps are text.
  check('analysis next steps are never executable', /executable: false, requires_human_approval: true/.test(src[`${dir}/analysis.ts`]) && /executable: z\.literal\(false\)/.test(src[`${dir}/contract.ts`]), 'next_steps must be executable:false in both code and schema');
}

// 11. Technician presets and abuse prevention (0.23). Each of these is a
//     protection that would fail open without a single error.
{
  const presets = read('apps/api/src/security-controls/presets.ts');
  const derive = presets.match(/export function presetCapabilities[\s\S]*?\n\}/)?.[0] ?? '';
  // a) A preset can never yield connect / edit / add / remove / quick connect / users:manage.
  check('presetCapabilities() never names a launch, credential or admin capability',
    derive.length > 0 && !/COMPUTERS_(CONNECT|EDIT|ADD|REMOVE)|QUICK_CONNECT|USERS_MANAGE/.test(derive),
    'presetCapabilities must derive only view / support / event-log capabilities');
  // b) Capability and computer scope come from the SAME grant.
  const acl = read('apps/api/src/rbac/access-control.service.ts');
  check('technician reach is decided per grant (technicianGrantAllows)',
    /export function technicianGrantAllows[\s\S]*?s\.capabilities[\s\S]*?s\.endpointIds/.test(acl) && /canReachEndpoint[\s\S]*?technicianGrantAllows\(/.test(acl),
    'canReachEndpoint must test capability and endpoint scope on one source');
  // c) Every way of starting a session goes through the launch policy.
  const eps = read('apps/api/src/endpoints/endpoints.service.ts');
  check('authorizeConnect consults AccessPolicyService.evaluateLaunch', /this\.policy\.evaluateLaunch\(/.test(eps), 'the launch policy is not applied');
  check('connect never releases the password unless the policy says so',
    (eps.match(/authz\.revealCredential && /g) ?? []).length >= 2, 'both connectInfo and grant redemption must gate decryptPassword on authz.revealCredential');
  const launcher = read('apps/api/src/launcher/launcher.service.ts');
  check('launcher issue and redemption re-run the launch policy with the minted mode',
    /admit: 'launcher'/.test(launcher) && /mode: record\.launchMode/.test(launcher), 'launcher must admit at issue and re-evaluate the recorded mode at redemption');
  // d) Admission is serialised per identity.
  const guard = read('apps/api/src/security-controls/abuse-guard.service.ts');
  check('abuse guard serialises admission on a per-identity advisory lock',
    /pg_advisory_xact_lock\(hashtextextended\(/.test(guard) && /\$transaction\(async/.test(guard), 'admit() must lock and count inside one transaction');
  // e) Nobody approves their own request.
  const review = read('apps/api/src/security-controls/review.ts');
  check('independent review refuses the requester', /actor\.userId === requesterId/.test(review), 'assertIndependentReviewer must refuse the requester');
  // f) Suppressing an alert never touches a pause.
  const alerts = read('apps/api/src/security-controls/alerts.service.ts');
  check('alert suppression never clears a pause', !/identityPause/.test(alerts), 'alerts.service.ts must not read or write IdentityPause');
}

if (failures.length > 0) {
  console.error(`\n✗ ${failures.length} security invariant(s) broken:\n`);
  for (const f of failures) console.error(`   ✗ ${f}\n`);
  process.exit(1);
}
console.log('\n✓ All security invariants hold');
