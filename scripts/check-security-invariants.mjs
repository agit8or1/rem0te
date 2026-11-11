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

// 12. Signed update chain (0.24). The portal is a mirror that holds no key;
//     the signed installer runs nothing the portal chose; the legacy path is
//     contained when the platform says signed_only.
{
  const ws = read('apps/api/src/public/windows-script.ts');
  const signedFn = ws.match(/export function buildSignedWindowsScript[\s\S]*?\n\}\n\nfunction template/)?.[0] ?? '';
  // a) The signed variant's own slots carry no iex, no download, no portal value.
  check('signed installer variant has no iex / download / Invoke-Expression',
    signedFn.length > 0 && !/\biex\b|Invoke-Expression|Invoke-WebRequest|github\.com/i.test(signedFn),
    'buildSignedWindowsScript must not fetch or evaluate anything');
  check('signed installer heartbeat hook runs rem0te-agent.exe update',
    /updateHook:[\s\S]*?rem0te-agent\.exe[\s\S]*?@\('update'\)/.test(signedFn), 'the signed heartbeat must update only through the verifying agent');
  // b) The mirror never signs and never reads a key.
  const mirror = [read('apps/api/src/update-trust/update-trust.service.ts'), read('apps/api/src/update-trust/update-trust.controller.ts')].join('\n');
  check('update mirror holds no signing code or key material',
    !/createSign|\.sign\(|privateKey|PRIVATE KEY|ed25519|keygen/i.test(mirror), 'the portal must only serve the offline-signed repository');
  check('update mirror resolves paths inside the repository after realpath',
    /realpathSync\(base\)/.test(mirror) && /real\.startsWith\(realBase \+ path\.sep\)/.test(mirror), 'targetPath/metadataPath must refuse symlink and traversal escapes');
  check('timestamp.json is served no-store', /'no-store'/.test(mirror), 'a cacheable timestamp turns a CDN into a freeze attack');
  // c) Containment: the heartbeat withholds legacy update triggers in signed_only,
  //    and windows.ps1 serves no installer there.
  const enr = read('apps/api/src/enrollment/enrollment.service.ts');
  check('heartbeat consults the update-trust gate for legacy agents',
    /updateTrust\.gateForHeartbeat\(/.test(enr) && /gate === 'withhold'[\s\S]{0,120}updateRustdesk = null;[\s\S]{0,40}reinstallAgent = null;/.test(enr),
    'signed_only must withhold reinstall/update from legacy agents');
  const pub = read('apps/api/src/public/public.controller.ts');
  check('windows.ps1 serves only a refusal or the pinned migration script in signed_only',
    /trustMode\.mode === 'signed_only'[\s\S]{0,700}buildMigrationScript\([\s\S]{0,120}SIGNED_ONLY_REFUSAL[\s\S]{0,400}return;/.test(pub),
    'the legacy installer must not be served in signed_only');
  // d) Loosening goes through independent review.
  const ut = read('apps/api/src/update-trust/update-trust.service.ts');
  check('loosening update trust is a reviewed trust change', /widening\.length\)[\s\S]{0,80}this\.trust\.request\(actor, \{ kind: 'update_trust'/.test(ut),
    'legacy_allowed / portal migration must go to an independent reviewer');
  // e) The agent's stage 2 refuses to run from anything but the signed binary,
  //    and an update keeps the pinned relay.
  const agent = read('tools/windows-installer/internal/agent/agent.go');
  check('agent stage 2 verifies its own digest against signed metadata', /selfSum != agentT\.SHA256/.test(agent), 'stage 2 must refuse an unsigned self');
  check('agent update keeps the pinned relay', /case haveExisting:[\s\S]{0,120}return existing,/.test(agent), 'a portal must not repoint an installed agent');
  check('agent refuses an unsigned RustDesk downgrade', /CompareVersions\(prm\.RustdeskVersion, cur\) < 0 && !rdT\.DowngradeAllowed\(\)/.test(agent), 'downgrade protection removed');
  const client = read('tools/windows-installer/internal/trust/client.go');
  check('trust client refuses plain-http mirrors outside tests', /u\.Scheme != "https" && !\(cfg\.AllowInsecureHTTP/.test(client), 'https enforcement removed');
}

// 13. Security Features view (0.25). The view is the answer an MSP owner reads
//     to decide what is protected, so it must neither leak configuration nor
//     overstate an endpoint restriction.
{
  const svc = read('apps/api/src/security-controls/security-features.service.ts');
  check('Security Features refuses every technician context', /if \(actor\.technician\) throw new ForbiddenException/.test(svc),
    'a technician acting in a business must not read its security configuration');
  check('a Business Owner sees only their own business', /businessId && businessId !== actor\.businessId\) throw new ForbiddenException/.test(svc),
    'an owner must not scope the view to another business');
  check('clipboard and file transfer report no effective state', !/out\['clipboard'\]|out\['file-transfer'\]/.test(svc),
    'nothing observes them; an effective value would claim an endpoint restriction that does not exist');
  const cat = read('apps/api/src/security-controls/security-features.ts');
  for (const id of ['clipboard', 'file-transfer', 'elevation', 'remote-shell', 'chat', 'mdm', 'backup-recovery', 'scripts-fixes']) {
    check(`catalog lists ${id} as unavailable`, new RegExp(`id: '${id}',[^\\n]*status: 'unavailable'`).test(cat), `${id} must not be presented as available`);
  }
  check('session length is advisory, not enforced', /id: 'session-length',[^\n]*status: 'advisory'/.test(cat), 'nothing ends a session');
  // Since 0.31 the button lives in the device workspace's More menu: the page
  // passes the technician context in, the menu offers view-only only with it.
  const page = read('apps/web/app/(app)/endpoints/[id]/page.tsx');
  const devActions = read('apps/web/components/endpoints/workspace/device-actions.tsx');
  check('View only is offered only in a technician context',
    /technician: !!technician\b/.test(page) && /onViewOnly=\{\(\) => launchMutation\.mutate\('view_only'\)\}/.test(page)
      && /\{perms\.technician && \(\s*<DropdownMenuItem[^>]*onSelect=\{onViewOnly\}/.test(devActions)
      && (devActions.match(/onViewOnly/g) ?? []).length === 3,
    'for members view-only is not applied; the menu must not imply it is');
}

// 14. Approved actions (0.26). A compromised portal or database alone must
//     not be able to make a computer act, so the signer stays out of the
//     portal's code, the portal has no way to approve, and the agent runs only
//     what it compiles in, at most once.
{
  const signerDir = 'apps/api/src/approval-signer';
  const signerFiles = readdirSync(join(ROOT, signerDir)).filter((f) => f.endsWith('.ts')).map((f) => `${signerDir}/${f}`);
  const ALLOWED_IMPORT = /^(node:|crypto$|\.\/|@simplewebauthn\/server$|zod$|\.\.\/actions\/catalog$|\.\.\/integration\/crypto$)/;
  const importsOf = (src) => [...src.matchAll(/(?:from|require\()\s*['"]([^'"]+)['"]/g)].map((m) => m[1]);
  const bad = [];
  for (const f of [...signerFiles, 'apps/api/src/actions/catalog.ts', 'apps/api/src/integration/crypto.ts']) {
    const own = f.startsWith(signerDir) ? ALLOWED_IMPORT : /^(node:|crypto$|zod$|\.\/crypto$|\.\.\/integration\/crypto$)/;
    for (const i of importsOf(read(f))) if (!own.test(i)) bad.push(`${f} imports ${i}`);
  }
  check('approval signer loads no Nest, Prisma or portal module', signerFiles.length >= 4 && bad.length === 0,
    bad.join('; ') || 'approval-signer sources not found');
  const portal = walk('apps/api/src').filter((f) => !f.startsWith(signerDir));
  const reachIn = portal.filter((f) => /from ['"][./]*approval-signer\//.test(read(f)));
  check('no portal module imports the approval signer', reachIn.length === 0, `imports it: ${reachIn.join(', ')}`);
  const ctl = read('apps/api/src/actions/actions.controller.ts');
  const routes = [...ctl.matchAll(/@(?:Get|Post|Put|Patch|Delete)\('([^']*)'\)/g)].map((m) => m[1]);
  check('the portal has no approve route', routes.length > 0 && !routes.some((r) => /approv|sign/i.test(r)) && !walk('apps/api/src').filter((f) => /controller\.ts$/.test(f)).some((f) => /@(?:Post|Put|Patch)\('[^']*approve/i.test(read(f)) && !/trust|grant|elevation|technician|support/i.test(f)),
    `actions routes: ${routes.join(', ')}`);
  check('the portal never reads an approval private key', !portal.some((f) => /APPROVAL_SIGNER_DIR|signing\.key|loadSigningKey/.test(read(f))),
    'only the signer may load the job-approval key');
  const goCat = read('tools/windows-installer/internal/action/catalog.go');
  const goIds = [...goCat.matchAll(/ID: "([^"]+)"/g)].map((m) => m[1]);
  // 0.27 added windows.update.install (§ 15). Anything further is a review.
  check('agent catalog is the Spooler start and Windows update install, nothing else',
    goIds.length === 2 && goIds[0] === 'windows.service.start' && goIds[1] === 'windows.update.install' && /const ServiceName = "Spooler"/.test(goCat) && /s == ServiceName/.test(goCat),
    `agent catalog ids: ${goIds.join(', ')}`);
  const tsCat = read('apps/api/src/actions/catalog.ts');
  check('portal catalog has no command, script, path or URL parameter', !/\b(command|script|path|url|args|cmd)\s*:/i.test(tsCat.replace(/\/\/.*$|\/\*[\s\S]*?\*\//gm, '')),
    'the catalog must not grow a free-form parameter');
  const act = read('tools/windows-installer/internal/action/action.go');
  const iExec = act.indexOf('State: "executing"'), iRun = act.indexOf('r := Lookup(plan.Action.ID, plan.Action.Version).Execute(plan, o)'), iJournal = act.indexOf('readJournal(o, jobID)');
  check('agent journals a job before executing it, and consults the journal first',
    iJournal > 0 && iExec > iJournal && iRun > iExec && /if err := writeJournal\(o, journal\{JobID: jobID, State: "executing"[\s\S]{0,240}return Result\{\}, fmt\.Errorf/.test(act),
    'the journal write must precede execute() and a failed write must stop it');
  // class-transformer's implicit conversion turns an untyped array of objects
  // into [[]] — silently. It broke command-result events in production.
  const untyped = [];
  for (const f of walk('apps/api/src').filter((f) => /dto/.test(f))) {
    const lines = read(f).split('\n');
    lines.forEach((l, n) => {
      if (/^\s*(?:@[^\n]*\s)?\w+\??:\s*(?:unknown|object|any|Record<[^>]+>)\[\];/.test(l) && !/@Type\(|@ValidateNested/.test(lines.slice(Math.max(0, n - 3), n + 1).filter((x) => !/^\s*(\/\/|\*|\/\*)/.test(x)).join('\n')))
        untyped.push(`${f}:${n + 1}`);
    });
  }
  check('no DTO array of objects without @Type', untyped.length === 0, `class-transformer will turn these into [[]]: ${untyped.join(', ')}`);
}

// 15. Staged Windows patching (0.27). An update plan can name only Windows
//     Update identities, installs only what Windows Update itself offers as
//     eligible, never restarts or accepts a licence, and can never be
//     approved or promoted past its canary by the portal alone.
{
  const upd = read('tools/windows-installer/internal/action/updates.go');
  check('agent update params are closed: exactly updates + reboot "never", each {updateId, revision}',
    /len\(p\) != 2 \|\| p\["reboot"\] != "never"/.test(upd) && /!ok \|\| len\(m\) != 2/.test(upd),
    'the update action must not accept any other parameter');
  const goCat = read('tools/windows-installer/internal/action/catalog.go');
  const updEntry = goCat.slice(goCat.indexOf('ID: "windows.update.install"'));
  check('agent update risk is always high, whatever the device', /Risk:\s*func\([^)]*\) string \{\s*return "high"\s*\}/.test(updEntry),
    'an update install must always need two approvers');
  const ps = read('tools/windows-installer/internal/patch/wua.ps1').replace(/^\s*#.*$/gm, '');
  const banned = ['Restart-Computer', 'shutdown', 'AcceptEula', 'Invoke-Expression', 'iex ', 'Invoke-WebRequest', 'DownloadString', 'Start-Process', 'Set-ItemProperty', 'New-ItemProperty'].filter((b) => ps.toLowerCase().includes(b.toLowerCase()));
  check('the Windows Update script never restarts, accepts a licence or runs downloaded text', banned.length === 0, `wua.ps1 contains: ${banned.join(', ')}`);
  const inst = read('tools/windows-installer/internal/patch/install.go');
  const iMgr = inst.indexOf('if m := Managers(reg); len(m) > 0'), iInstall = inst.indexOf('w.Run("install"');
  check('the agent refuses a computer managed by WSUS / WUfB / MDM / ConfigMgr before installing anything',
    iMgr > 0 && iInstall > iMgr && /Eligible\(/.test(inst), 'Managers() and Eligible() must be checked before the install call');
  const elig = read('tools/windows-installer/internal/patch/patch.go');
  check('the agent installs only security, critical, rollup and ordinary updates',
    /var Installable = map\[string\]string\{[\s\S]{0,600}\}/.test(elig) && !/ebfc1fc5-71a4-4f7b-9aca-3b9a503104a0[^\n]*Installable|Installable[^}]*ebfc1fc5/.test(elig),
    'drivers (and other classifications) must not be in the allowlist');
  const pctl = read('apps/api/src/patching/patching.controller.ts');
  check('the patching API has no approve or sign route', !/@(?:Get|Post|Put|Patch|Delete)\('[^']*(approv|sign)/i.test(pctl), 'approval happens on the approval signer only');
  const psvc = read('apps/api/src/patching/patching.service.ts');
  check('the canary gate requires every update effective, and a ring over threshold is retried, never promoted past',
    /reason: 'canary_not_effective'/.test(psvc) && /g\.reason === 'too_many_failures'\) return \{ ring: i, canRequest: true/.test(psvc),
    'promotion must be gated on the canary and on the failure threshold');
  const asvc = read('apps/api/src/actions/actions.service.ts');
  check('updates cannot be requested one computer at a time, around the deployment', /ACTION_NOT_DIRECT/.test(asvc) && /direct: false/.test(read('apps/api/src/actions/catalog.ts')),
    'POST /endpoints/:id/actions must refuse windows.update.install');
}

// 16. Containment and evidence (0.28). A pause is enforced at three layers
//     and each layer can only be lifted by its own operator; the audit chain
//     is guarded in the database, and health detail needs a token.
{
  const sigSrv = read('apps/api/src/approval-signer/server.ts');
  const pauseRoute = sigSrv.slice(sigSrv.indexOf("url.pathname === '/internal/v1/pauses'"), sigSrv.indexOf("url.pathname === '/internal/v1/pauses'") + 1400);
  check('the approval signer has no HTTP route that lifts a pause',
    pauseRoute.length > 100 && !/clearedAt\s*:/.test(pauseRoute) && !/savePause\(/.test(sigSrv) && !/\/internal\/v1\/pauses\/[^']*clear/.test(sigSrv),
    'only the signer CLI (main.ts pause clear) may clear a pause');
  check('the signer refuses plans and decisions while paused',
    /throw new Refused\('paused'/.test(sigSrv) && (sigSrv.match(/activePause\(/g) ?? []).length >= 3,
    'plan submit, challenge and decide must each consult the pause');
  const cctl = read('apps/api/src/containment/containment.controller.ts');
  const clearFn = cctl.slice(cctl.indexOf("@Post('pauses/:id/clear')"));
  check('lifting a portal pause needs fresh authentication', /assertFresh\(/.test(clearFn.slice(0, 600)), 'POST containment/pauses/:id/clear must call assertFresh');
  const csvc = read('apps/api/src/containment/containment.service.ts');
  check('a customer\'s own suspension is lifted only by that customer; an MSP pause by a second person',
    /p\.setBy === 'customer'[\s\S]{0,200}isOwnerOf\(actor, p\.customerId\)/.test(csvc) && /actor\.userId === p\.setById[\s\S]{0,80}SAME_PERSON/.test(csvc),
    'clear() must keep the CUSTOMER_SUSPENSION and SAME_PERSON rules');
  const pol = read('apps/api/src/security-controls/access-policy.service.ts');
  const asvc = read('apps/api/src/actions/actions.service.ts');
  const enr = read('apps/api/src/enrollment/enrollment.service.ts');
  const qc = read('apps/api/src/quick-connect/quick-connect.service.ts');
  const jobs = read('apps/api/src/integration/jobs.service.ts');
  const worker = read('apps/api/src/integration/worker.service.ts');
  const roll = read('apps/api/src/admin/update-rollout.service.ts');
  const missing = [
    [/async evaluateAction\([\s\S]{0,800}containment\.blocking\('actions'/.test(pol), 'evaluateAction (requests and dispatch recheck)'],
    [/async evaluateLaunch\([\s\S]{0,400}containment\.blocking\('remote'/.test(pol), 'evaluateLaunch (every connection)'],
    [/const held = !!\(await this\.containment\.blocking\('actions'/.test(asvc) && (asvc.match(/if \(held\) continue;/g) ?? []).length >= 2, 'forHeartbeat (delivery and re-delivery held)'],
    [/const updatesHeld = authenticated[\s\S]{0,200}containment\.blocking\('updates'/.test(enr) && /authenticated && !updatesHeld && node\.reinstallRequestedAt/.test(enr) && /contained: updatesHeld/.test(enr) && /f\.contained \? 'contained'/.test(roll), 'heartbeat update / reinstall / rollout flags'],
    [/async admitLaunch\([\s\S]{0,200}containment\.assertOpen\('remote'/.test(qc), 'Quick Connect admission'],
    [/activePause\(this\.prisma, 'integration'/.test(jobs) && /activePause\(/.test(worker), 'integration submit and worker'],
  ].filter(([ok]) => !ok).map(([, n]) => n);
  check('every write path consults containment', missing.length === 0, `missing: ${missing.join('; ')}`);
  const act = read('tools/windows-installer/internal/action/action.go');
  const iPause = act.indexOf('o.Pause.ActionsPaused('), iExecJ = act.indexOf('State: "executing"'), iVerify = act.indexOf('// 1b.');
  check('the agent checks the signed pause after verifying the plan and before journaling it as executing',
    iPause > 0 && iVerify > 0 && iPause > iVerify && iExecJ > iPause, 'action.Run must refuse "paused" before the executing journal entry');
  const ag = read('tools/windows-installer/internal/agent/agent.go');
  const sp = ag.slice(ag.indexOf('func signedPause('), ag.indexOf('func signedPause(') + 1200);
  check('a listed signed pause that cannot be read is a pause (fail closed)',
    (sp.match(/return closed/g) ?? []).length >= 4 && /Actions: action\.PauseScope\{All: true\}, Updates: action\.PauseScope\{All: true\}/.test(sp),
    'signedPause must return the all-paused value on every read or parse failure');
  const pz = read('tools/windows-installer/internal/action/pause.go');
  check('the signed pause is parsed strictly', /DisallowUnknownFields\(\)/.test(pz) && /d\.More\(\)/.test(pz), 'unknown fields and trailing data must be refused');
  const mig = read('apps/api/prisma/migrations/0027_containment_audit_chain/migration.sql');
  check('sealed audit entries are guarded by a database trigger',
    /CREATE TRIGGER "ActivityLog_sealed_guard" BEFORE UPDATE ON "ActivityLog"/.test(mig) && /IF OLD\."chainHash" IS NULL THEN/i.test(mig),
    'migration 0027 must install rem0te_audit_sealed_guard');
  const hc = read('apps/api/src/health/health.controller.ts');
  check('/healthz says only up or down without its token',
    /if \(!this\.authorized\(token\)\) \{[\s\S]{0,200}return \{ status: 'ok' \};/.test(hc) && /timingSafeEqual\(/.test(hc) && /want\.length < 24/.test(hc),
    'detail must need HEALTH_TOKEN (24+ chars, compared in constant time)');
  const chain = read('apps/api/src/audit/chain.ts');
  check('the audit chain module loads no Nest or Prisma client', !/from '@nestjs|from '@prisma\/client'/.test(chain), 'chain.ts is shared with the verify CLI and must stay plain');
}

// 17. Monitoring (0.29). Read-side only: the agent's monitor block reads and
//     counts and changes nothing, the server keeps only what it asked for,
//     a maintenance window never touches containment or security alerts,
//     notification destinations need fresh authentication, and linking a
//     ClientSt0r ticket grants nothing.
{
  const ws = read('apps/api/src/public/windows-script.ts');
  const blk = ws.slice(ws.indexOf('# ---- Monitoring (0.29)'), ws.indexOf('# Apply a staged RustDesk upgrade.'));
  check('the heartbeat\'s monitor block only reads (Get-Service, Get-WinEvent) and posts one report',
    blk.length > 500 && !/(Start|Stop|Restart|Set|Suspend|Resume)-Service|Invoke-Expression|\biex\b|Start-Process|Remove-|Clear-EventLog|wevtutil|sc(\.exe)? (config|stop|start)/i.test(blk)
      && (blk.match(/Invoke-RestMethod/g) ?? []).length === 1 && /enrollment\/monitor-report/.test(blk),
    'the monitor block must not change a service, run a process or clear a log');
  check('the monitor block checks every service name and log before using it',
    /-notmatch '\^\[A-Za-z0-9_\.-\]\{1,64\}\\\$'/.test(blk) && /\$allowedLogs -contains \\\$ln/.test(blk.replace(/\\\$allowedLogs/g, '$allowedLogs')),
    'service names must match the fixed charset and logs the fixed list');
  const eng = read('apps/api/src/monitoring/engine.ts');
  check('the server keeps only the services and event keys it asked about',
    /export function sanitizeReport\([\s\S]{0,700}wantSvc\.get\(name\.toLowerCase\(\)\)[\s\S]{0,200}if \(!canon/.test(eng) && /if \(!wantEv\.has\(key\)/.test(eng),
    'sanitizeReport must drop unrequested services and event keys');
  check('an event monitor must name ids, levels or a provider, on an allowed log',
    /log: z\.enum\(MONITOR_EVENT_LOGS\)/.test(eng) && /ids\.length > 0 \|\| p\.levels\.length > 0 \|\| !!p\.provider/.test(eng), 'EVENT_MATCH params');
  const enr = read('apps/api/src/enrollment/enrollment.service.ts');
  const mr = enr.slice(enr.indexOf('async monitorReport('), enr.indexOf('async monitorReport(') + 900);
  check('a monitor report needs the device secret', /secretMatches\(node\.agentSecretHash, dto\.agentSecret\)/.test(mr) && /UnauthorizedException/.test(mr), 'monitor-report must authenticate like command-result');
  check('only an authenticated heartbeat is handed monitor queries', /if \(authenticated\) \{\s*try \{\s*await this\.monitoring\.onLiveSample/.test(enr), 'heartbeatConfig must be gated on authenticated');
  const mon = [read('apps/api/src/monitoring/monitoring.service.ts'), read('apps/api/src/monitoring/monitoring-admin.service.ts'), read('apps/api/src/monitoring/alert-events.service.ts'), eng].join('\n');
  check('monitoring never sets or lifts a containment pause, or touches security alerts',
    !/containmentPause\.|securityAlert\.|alertSuppression\./.test(mon), 'maintenance windows are MonitorSuppression only');
  const mctl = read('apps/api/src/monitoring/monitoring.controller.ts');
  check('changing who is notified needs fresh authentication', /@Put\('notify-policy'\)[\s\S]{0,200}this\.fresh\(req\)/.test(mctl) && /assertFresh\(/.test(mctl), 'PUT monitoring/notify-policy must call assertFresh');
  check('business notification destinations must be public HTTPS hosts', /isIP\(h\)[\s\S]{0,120}localhost/.test(read('apps/api/src/monitoring/monitoring-admin.service.ts')), 'checkDestination must refuse IP literals and internal names for business policies');
  check('one open alert per problem is enforced in the database',
    /CREATE UNIQUE INDEX "MonitorAlert_dedup_open" ON "MonitorAlert"\("dedupKey"\) WHERE "state" <> 'RESOLVED'/.test(read('apps/api/prisma/migrations/0028_monitoring/migration.sql')), 'migration 0028 partial unique index');
  const ae = read('apps/api/src/monitoring/alert-events.service.ts');
  const link = ae.slice(ae.indexOf('async linkTicket('));
  check('linking a ClientSt0r ticket acknowledges, resolves and suppresses nothing',
    link.length > 200 && !/state:\s*'(ACKNOWLEDGED|RESOLVED)'|suppressed:|acknowledgedAt|resolvedAt/.test(link.slice(0, 2500)), 'linkTicket may only set the ticket fields');
  check('alert events sign under their own prefix', /rem0te-alert-event-v1\\n/.test(read('apps/api/src/integration/crypto.ts')), 'alertEventSigningString must differ from job events');
}

// 18. Capture scripts (0.29). Every script that seeds or drives the UI for
//     documentation media refuses a production-looking target before it
//     touches anything. screenshots.mjs had no such guard and defaulted to
//     port 3000 — the production web port — until 0.29.
{
  for (const f of ['apps/web/scripts/screenshots.mjs', 'apps/web/scripts/capture-media.mjs', 'apps/web/scripts/capture-video.mjs', 'apps/web/scripts/e2e-navigation.mjs']) {
    const src = read(f);
    check(`${f.split('/').pop()} refuses https and ports 3000/443`, /:\(3000\|443\)\\b/.test(src) && /https:\\\/\\\//.test(src) && /throw new Error\(`Refusing/.test(src), `${f} must throw before capturing against a production-looking WEB_URL`);
  }
  check('screenshots.mjs refuses any database but reboot_remote_docs', /DATABASE_URL[^\n]*includes\('reboot_remote_docs'\)/.test(read('apps/web/scripts/screenshots.mjs')), 'it seeds a user and changes relay settings');
}

// 19. Credential release, audit integrity, step-up and the updater (0.30.1).
{
  const ctl = read('apps/api/src/endpoints/endpoints.controller.ts');
  const svc = read('apps/api/src/endpoints/endpoints.service.ts');
  const connect = ctl.slice(ctl.indexOf("@Post(':id/connect')"), ctl.indexOf("@Get(':id/connect.cmd')"));
  check('POST :id/connect withholds the password and gates a credential-carrying grant',
    /password: _withheld/.test(connect) && /createConnectionGrant\(actor, id, launchMode, \(\) => this\.credentialGate\(req, u\)\)/.test(connect) && !/releaseCredential/.test(connect),
    'Connect must strip `password` from connectInfo, never ask for releaseCredential, and pass credentialGate to the grant');
  const script = ctl.slice(ctl.indexOf("@Get(':id/connect.cmd')"), ctl.indexOf("@Post('grants/redeem')"));
  check('the Connect script releases the password only through credentialGate',
    /releaseCredential: true, credentialGate: \(\) => this\.credentialGate\(req, u\)/.test(script), 'connect.cmd embeds the password: it is a reveal');
  const gate = ctl.slice(ctl.indexOf('private async credentialGate'), ctl.indexOf("@Get(':id/password')"));
  check('credentialGate checks MFA and the credential.reveal step-up',
    /userHasMfa/.test(gate) && /stepUp\.assert\(req, 'credential\.reveal'\)/.test(gate), 'the same gate as Reveal');
  check('authorizeConnect runs credentialGate before a launch is counted',
    svc.indexOf('opts.credentialGate && decision.revealCredential') > 0 && svc.indexOf('opts.credentialGate && decision.revealCredential') < svc.indexOf('if (opts.admit) {'),
    'a refused step-up must not count a launch');
  // Every audit write of a released password is the strict one.
  const reveals = [...svc.matchAll(/await this\.audit\.(log|logOrFail)\(\{[^}]*?action: '?ENDPOINT_PASSWORD_REVEALED/g)].map((m) => m[1]);
  check('every ENDPOINT_PASSWORD_REVEALED for a release uses logOrFail', reveals.length >= 3 && reveals.every((k) => k === 'logOrFail'), `found ${reveals.join(', ') || 'none'}`);
  check('AuditService.logOrFail rethrows', /async logOrFail[\s\S]{0,400}throw new ServiceUnavailableException/.test(read('apps/api/src/audit/audit.service.ts')), 'a reveal nobody can see afterwards must be refused');

  // The latest definition of the audit guard checks content before the
  // "not sealed yet" early return.
  const migDir = join(ROOT, 'apps/api/prisma/migrations');
  const guards = readdirSync(migDir).sort().filter((d) => { try { return /rem0te_audit_sealed_guard\(\) RETURNS trigger/.test(readFileSync(join(migDir, d, 'migration.sql'), 'utf8')); } catch { return false; } });
  const latest = guards.length ? readFileSync(join(migDir, guards[guards.length - 1], 'migration.sql'), 'utf8') : '';
  const early = latest.search(/IF OLD\."chainHash" IS NULL THEN RETURN NEW/);
  check('audit entries are insert-only: content is checked before the unsealed early return',
    early > 0 && latest.slice(0, early).includes('NEW."metadata"::text IS DISTINCT FROM OLD."metadata"::text'), `latest guard: ${guards[guards.length - 1] ?? 'none'}`);

  const auth = read('apps/api/src/auth/auth.service.ts');
  check('a session token never asserts mfaVerified: true unconditionally', !/mfaVerified: true,/.test(auth.slice(auth.indexOf('private issueFullToken'))), 'mfaVerified must come from the sign-in');
  check('step-up refuses the password when an authenticator is enrolled', /hasTotp && !input\.totpCode[\s\S]{0,300}TOTP_REQUIRED/.test(auth), 'verifyStepUp');

  const upd = read('apps/api/src/admin/update.service.ts');
  check('the panel updater verifies against the pinned key in a dedicated keyring',
    !/'tag', '--verify'/.test(upd) && /'verify-tag', '--raw'/.test(upd) && /GNUPGHOME: key\.gnupgHome/.test(upd) && /checkTagSignature\(/.test(upd),
    'plain `git tag --verify` trusts any key in the service account\'s keyring');
}

// 20. The read-only diagnostics catalog (0.31). A console user picks a KEY;
//     the agent maps it to a fixed read-only block and runs nothing else.
//     Closed on every side: the agent's switch and list, the server's
//     request and result paths, and the database. Results are capped on the
//     agent, in the service and by a CHECK constraint, and only an
//     authenticated heartbeat is handed a run or may report one.
{
  const cat = read('apps/api/src/diagnostics-catalog/catalog.ts');
  const keys = [...(/export const DIAGNOSTIC_KEYS = \[([\s\S]*?)\] as const;/.exec(cat)?.[1] ?? '').matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
  const ws = read('apps/api/src/public/windows-script.ts');
  const blk = ws.slice(ws.indexOf('# ---- Diagnostics catalog (0.31)'), ws.indexOf('# ---- Monitoring (0.29)'));
  const sw = /switch -Exact \(\\\$dk\) \{([\s\S]*?)\n {12}\}/.exec(blk)?.[1] ?? '';
  const arms = [...sw.matchAll(/^\s+'([a-z_]+)' \{/gm)].map((m) => m[1]);
  const listed = [...(/\\\$diagKeys = @\(([^)]*)\)/.exec(blk)?.[1] ?? '').matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
  check('the agent\'s diagnostics switch has exactly the catalog keys and a default that runs nothing',
    keys.length >= 9 && JSON.stringify(arms) === JSON.stringify(keys) && /default \{ throw /.test(sw),
    `catalog: ${keys.join(',')}; switch: ${arms.join(',')}`);
  check('the agent refuses a key not in its own copy of the catalog before running anything',
    JSON.stringify(listed) === JSON.stringify(keys) && /if \(-not \(\\\$diagKeys -contains \\\$dk\)\) \{ Send-Rem0teDiag [^}]*'failed'[^}]*; continue \}/.test(blk)
      && blk.indexOf('\\$diagKeys -contains') < blk.indexOf('switch -Exact'),
    '$diagKeys must equal DIAGNOSTIC_KEYS and be checked before the switch');
  check('the diagnostics block runs no process, expression or download, and writes nothing',
    blk.length > 5000 && !/Invoke-Expression|\biex\b|Start-Process|Invoke-WebRequest|DownloadString|DownloadFile|Net\.WebClient|Invoke-Command|Start-Job|(Set|Stop|Start|Restart|Suspend|Remove|Clear|New)-(Service|Item|ItemProperty|EventLog)\b|Set-Content|Out-File|Add-Content|& \\\$/i.test(blk)
      && (blk.match(/Invoke-RestMethod/g) ?? []).length === 1 && /enrollment\/diagnostic-result/.test(blk),
    'read-only blocks only, and one post to /enrollment/diagnostic-result');
  check('the agent caps a diagnostic result before posting it',
    /if \(\\\$j\.Length -gt 600000\) \{\s*\\\$p\.Remove\('result'\)/.test(blk) && /MAX_AGENT_RESULT_CHARS = 600_000/.test(cat), 'Send-Rem0teDiag must drop an oversized result');
  const dsvc = read('apps/api/src/diagnostics-catalog/diagnostics-catalog.service.ts');
  const reqFn = dsvc.slice(dsvc.indexOf('async request('), dsvc.indexOf('async history('));
  const repFn = dsvc.slice(dsvc.indexOf('async report('), dsvc.indexOf('private async shapeAgentResult('));
  check('the server accepts only catalog keys, on request and on result',
    /^\s*if \(!isCatalogKey\(key\)\) \{\s*throw new BadRequestException/m.test(reqFn.split('\n').slice(0, 3).join('\n'))
      && /^\s*if \(!isCatalogKey\(dto\.key\)\) return \{ accepted: false/m.test(repFn.split('\n').slice(0, 3).join('\n'))
      && /if \(run\.key !== dto\.key\) return \{ accepted: false/.test(repFn)
      && /export function isCatalogKey\(k: unknown\): k is DiagnosticKey \{\s*return typeof k === 'string' && BY_KEY\.has\(k\);/.test(cat),
    'request() and report() must refuse a non-catalog key first; report() must match the run\'s key');
  const mig = read('apps/api/prisma/migrations/0031_diagnostic_runs/migration.sql');
  const dbKeys = [...(/"DiagnosticRun_key_catalog" CHECK \("key" IN \(([\s\S]*?)\)\)/.exec(mig)?.[1] ?? '').matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
  check('the database refuses a key outside the catalog', JSON.stringify(dbKeys) === JSON.stringify(keys), `CHECK lists: ${dbKeys.join(',')}`);
  check('a request carries a key and nothing else',
    /export class RequestDiagnosticDto \{\s*@IsString\(\)\s*@Length\(1, 64\)\s*@Matches\([^\n]*\)\s*key!: string;\s*\}/.test(read('apps/api/src/diagnostics-catalog/diagnostics-catalog.controller.ts'))
      && /out\.push\(\{ id: r\.id, key: r\.key \}\)/.test(dsvc) && !/params/.test(dsvc.slice(dsvc.indexOf('async forHeartbeat('), dsvc.indexOf('private async requesterStillAllowed('))),
    'no parameters from the console, none to the agent');
  check('stored diagnostic results are size-capped',
    /const capped = capResult\(shaped\);[\s\S]{0,300}result: capped\.result/.test(repFn) && /export const MAX_RESULT_BYTES = 32_768;/.test(cat)
      && /CHECK \("result" IS NULL OR octet_length\("result"::text\) <= 65536\)/.test(mig),
    'report() must store capResult\'s output; the migration keeps the 64 KB backstop');
  const enr = read('apps/api/src/enrollment/enrollment.service.ts');
  const dr = enr.slice(enr.indexOf('async diagnosticResult('), enr.indexOf('async diagnosticResult(') + 1000);
  check('a diagnostic result needs the device secret', /secretMatches\(node\.agentSecretHash, dto\.agentSecret\)/.test(dr) && /UnauthorizedException/.test(dr), 'diagnostic-result must authenticate like command-result');
  check('only an authenticated heartbeat is handed diagnostic runs', /if \(authenticated\) \{\s*try \{\s*diagnostics = await this\.diagnostics\.forHeartbeat\(node\.endpointId\);/.test(enr), 'forHeartbeat must be gated on authenticated');
  check('a run is re-authorized against its requester at delivery', /const why = !entry \? 'unknown_key' : !ep \? 'endpoint_missing' : await this\.requesterStillAllowed\(r, entry, ep\);/.test(dsvc), 'forHeartbeat must check the requester before DELIVERED');
}

// 21. Scheduled client updates (0.32). A business's update policy makes the
//     server re-run an installer on its computers with nobody clicking
//     Update, so: only an owner, a whole-business technician with
//     computers:edit or the MSP may set it; turning it on needs fresh
//     authentication; the sweep queues only inside an open window, honours
//     containment and is bounded; the heartbeat hands a POLICY request out
//     only when the policy allows it NOW and fails closed if it cannot tell;
//     withdrawing never touches a request someone made by hand.
{
  const svc = read('apps/api/src/client-updates/client-updates.service.ts');
  const ctl = read('apps/api/src/client-updates/client-updates.controller.ts');
  const sweep = read('apps/api/src/client-updates/client-update-sweep.service.ts');
  const enr = read('apps/api/src/enrollment/enrollment.service.ts');
  const refusal = svc.slice(svc.indexOf('editRefusal(a: ActorContext'), svc.indexOf('private assertEdit('));
  check('only a whole-business technician with computers:edit may set a client-update policy',
    /if \(a\.technician\) \{[\s\S]*?a\.technician\.businessId !== customerId[\s\S]*?\.includes\(CAP\.COMPUTERS_EDIT\) && s\.endpointIds === null\)/.test(refusal),
    'editRefusal must require computers:edit from one grant whose endpointIds is null, in the same business');
  check('a Business User may not set a client-update policy; an owner only for their own business',
    /if \(a\.businessId !== customerId\) return [^;]+;\s*if \(!a\.isPlatformAdmin && this\.acl\.isBusinessOwner\(a\)\) return null;\s*return '[^']+';\s*\}/.test(refusal),
    'after the technician branch: other business refused, owner allowed, everyone else refused');
  check('both policy writes check permission before anything else changes',
    /async putPolicy\([\s\S]{0,700}this\.assertEdit\(a, customerId\);/.test(svc) && /async deleteSiteOverride\([\s\S]{0,400}this\.assertEdit\(a, customerId\);/.test(svc),
    'putPolicy and deleteSiteOverride must call assertEdit');
  check('turning a policy on, or removing a site override, needs fresh authentication',
    /if \(input\.enabled && !fresh\) throw new FreshAuthNeeded\(\);/.test(svc) && /\/\/ The site falls back to the business policy, which may be on\.\s*if \(!fresh\) throw new FreshAuthNeeded\(\);/.test(svc)
      && (ctl.match(/this\.isFresh\(req\)/g) ?? []).length === 2 && /code: 'STEP_UP_REQUIRED'/.test(ctl),
    'the service must refuse without fresh auth and the controller must pass isFresh(req) on both writes');
  check('a site override must belong to the business it is set in',
    /if \(!site \|\| site\.customerId !== customerId\) throw new NotFoundException/.test(svc), 'siteOf must compare site.customerId');
  check('withdrawing automatic requests never touches a manual one',
    /updateMany\(\{\s*where: \{ id: \{ in: drop \}, updateRequestSource: 'POLICY' \}/.test(svc), 'clearUnwanted must be conditional on POLICY');
  const pass_ = sweep.slice(sweep.indexOf('private async pass('));
  check('the client-update sweep can be turned off', /onModuleInit\(\) \{\s*if \(process\.env\.CLIENT_UPDATE_SWEEP === 'off'\) return;/.test(sweep), 'CLIENT_UPDATE_SWEEP=off must stop it');
  check('the sweep skips a business under an "updates" containment pause',
    /if \(await this\.containment\.blocking\('updates', customerId\)\) continue;/.test(pass_), 'pass() must ask containment per business');
  check('the sweep queues only where the window is open now',
    /const open = policies\.filter\(\(p\) => p\.enabled && isWindowOpen\(policyWindow\(p\), now\)\);/.test(pass_) && /if \(!p \|\| !open\.some\(\(o\) => o\.id === p\.id\)\) continue;/.test(pass_),
    'every candidate must be governed by an enabled policy whose window is open at this sweep');
  check('the sweep is bounded and queues each computer once',
    /let budget = this\.batch\(\);/.test(pass_) && /Math\.min\(n, 500\)/.test(sweep) && /where: \{ id: n\.id, updateRequestedAt: null \}/.test(pass_) && /if \(w\.count !== 1\) continue;\s*budget--;/.test(pass_),
    'a per-sweep budget (max 500) and a conditional write that only counts what it changed');
  check('every automatic queuing is audited', /if \(w\.count !== 1\) continue;[\s\S]{0,80}await this\.audit\.log\(\{[\s\S]{0,120}action: 'CLIENT_UPDATE_AUTO_QUEUED'/.test(pass_), 'audit after each queued computer');
  check('the heartbeat holds a POLICY request unless the policy allows it now, and fails closed',
    /if \(updateRustdesk && node\.updateRequestSource === 'POLICY'\) \{\s*const hold = await this\.clientUpdates\.holdForHeartbeat\([\s\S]{0,300}\.catch\(\(e\) => \{[\s\S]{0,200}?return 'error'; \}\);\s*if \(hold\) updateRustdesk = null;\s*\}/.test(enr),
    'a policy check error must hold the update, not hand it out');
  check('a POLICY request is weighed only after containment and the device secret',
    enr.indexOf('authenticated && !updatesHeld &&\n      node.updateRequestedAt') !== -1
      && enr.indexOf("node.updateRequestSource === 'POLICY'") > enr.indexOf('authenticated && !updatesHeld &&\n      node.updateRequestedAt'),
    'the hold must refine the existing authenticated, uncontained instruction');
  const run = read('scripts/run-e2e.sh');
  check('scratch APIs in run-e2e.sh run without the client-update sweep', /MONITOR_SWEEP=off CLIENT_UPDATE_SWEEP=off/.test(run), 'it acts on every enabled policy in the database');
}

if (failures.length > 0) {
  console.error(`\n✗ ${failures.length} security invariant(s) broken:\n`);
  for (const f of failures) console.error(`   ✗ ${f}\n`);
  process.exit(1);
}
console.log('\n✓ All security invariants hold');
