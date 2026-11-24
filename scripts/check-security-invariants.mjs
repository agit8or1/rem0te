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
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
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
    /technician: !!technician\b/.test(page)
      // 0.73: view-only goes through a session grant on a verified managed
      // computer (where RustDesk enforces it), and the Legacy launch otherwise.
      && /onViewOnly=\{\(\) => startConnect\('view_only'\)\}/.test(page)
      && /const startConnect = \(mode\?: 'view_only'\) => \(viaGrant \? managedConnect\.connect\(mode\) : launchMutation\.mutate\(mode\)\);/.test(page)
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
  const ALLOWED_IMPORT = /^(node:|crypto$|\.\/|@simplewebauthn\/server$|zod$|\.\.\/actions\/catalog$|\.\.\/actions\/patch-policy$|\.\.\/actions\/automation-policy$|\.\.\/actions\/device-result$|\.\.\/actions\/script-run$|\.\.\/integration\/crypto$)/;
  const importsOf = (src) => [...src.matchAll(/(?:from|require\()\s*['"]([^'"]+)['"]/g)].map((m) => m[1]);
  const bad = [];
  // 0.32: the patch-policy evaluator (and the posture module it judges with)
  // run inside the signer, so they are held to the same rule; so (0.34) is
  // the device-result verifier, and the script-run rules (argument schema,
  // plan block, allowlist proposal), and (0.58) the automation-policy evaluator.
  for (const f of [...signerFiles, 'apps/api/src/actions/catalog.ts', 'apps/api/src/integration/crypto.ts', 'apps/api/src/actions/patch-policy.ts', 'apps/api/src/patching/posture.ts', 'apps/api/src/actions/device-result.ts', 'apps/api/src/actions/script-run.ts', 'apps/api/src/actions/automation-policy.ts']) {
    const own = f.startsWith(signerDir) ? ALLOWED_IMPORT : /^(node:|crypto$|zod$|\.\/crypto$|\.\/catalog$|\.\/device-result$|\.\/script-run$|\.\/patch-policy$|\.\.\/actions\/catalog$|\.\.\/actions\/device-result$|\.\.\/patching\/posture$|\.\.\/integration\/crypto$)/;
    for (const i of importsOf(read(f))) if (!own.test(i)) bad.push(`${f} imports ${i}`);
  }
  check('approval signer loads no Nest, Prisma or portal module', signerFiles.length >= 4 && bad.length === 0,
    bad.join('; ') || 'approval-signer sources not found');
  const portal = walk('apps/api/src').filter((f) => !f.startsWith(signerDir));
  const reachIn = portal.filter((f) => /from ['"][./]*approval-signer\//.test(read(f)));
  check('no portal module imports the approval signer', reachIn.length === 0, `imports it: ${reachIn.join(', ')}`);
  const ctl = read('apps/api/src/actions/actions.controller.ts');
  const routes = [...ctl.matchAll(/@(?:Get|Post|Put|Patch|Delete)\('([^']*)'\)/g)].map((m) => m[1]);
  check('the portal has no approve route', routes.length > 0 && !routes.some((r) => /approv|sign/i.test(r)) && !walk('apps/api/src').filter((f) => /controller\.ts$/.test(f)).some((f) => /@(?:Post|Put|Patch)\('[^']*approve/i.test(read(f)) && !/trust|grant|elevation|technician|support|alert-quality/i.test(f)),
    `actions routes: ${routes.join(', ')}`);
  check('the portal never reads an approval private key', !portal.some((f) => /APPROVAL_SIGNER_DIR|signing\.key|loadSigningKey/.test(read(f))),
    'only the signer may load the job-approval key');
  const goCat = read('tools/windows-installer/internal/action/catalog.go');
  const goIds = [...goCat.matchAll(/ID: "([^"]+)"/g)].map((m) => m[1]);
  // 0.27 added windows.update.install (§ 15); 0.32 the four maintenance
  // actions; 0.34 windows.script.run (§ 39), then software install and
  // uninstall (§ 40). The list is exact and ordered: anything further is a
  // review.
  // 0.41 adds windows.software.remove (§ 59); 0.45 windows.service.control
  // and windows.process.stop (§ 60).
  const CATALOG_IDS = ['windows.service.start', 'windows.update.install', 'windows.service.restart', 'windows.reboot.schedule', 'windows.reboot.cancel', 'windows.logs.collect', 'windows.script.run', 'windows.software.install', 'windows.software.uninstall', 'windows.software.remove', 'windows.service.control', 'windows.process.stop'];
  check('agent catalog is exactly the Spooler start, update install, service restart, restart schedule/cancel, log collection, approved-script run, software install/uninstall, program removal, service control and ending a process',
    goIds.join(',') === CATALOG_IDS.join(',') && /const ServiceName = "Spooler"/.test(goCat) && /s == ServiceName/.test(goCat),
    `agent catalog ids: ${goIds.join(', ')}`);
  const tsCat = read('apps/api/src/actions/catalog.ts');
  const tsIds = [...tsCat.matchAll(/^export const [A-Z_]+: CatalogAction = \{\s*id: '([^']+)'/gm)].map((m) => m[1]);
  const tsList = (tsCat.match(/^export const CATALOG: CatalogAction\[\] = \[([^\]]*)\];/m) ?? [])[1] ?? '';
  check('portal catalog is the same exact list, in the same order',
    tsIds.join(',') === CATALOG_IDS.join(',') && tsList.split(',').map((x) => x.trim()).length === CATALOG_IDS.length,
    `portal catalog ids: ${tsIds.join(', ')}; CATALOG = [${tsList}]`);
  // Every agent entry's parameters are one of the closed forms below, and
  // nothing else: a fixed service, update identities, an allowlisted service,
  // a bounded integer, no parameters at all, or (0.34) a script version, its
  // hash, typed arguments and a timeout from a fixed list (§ 39 holds that
  // form to its rules).
  const entries = goCat.slice(goCat.indexOf('var catalog = []Action{')).split(/\n\t\{\n/).slice(1);
  const CLOSED = [/ParamsOK: func\(p map\[string\]any\) bool \{\s*if len\(p\) != 1 \{\s*return false\s*\}\s*s, ok := p\["service"\]\.\(string\)\s*return ok && s == ServiceName/,
    /ParamsOK:\s+updateParamsOK,/, /ParamsOK:\s+func\(p map\[string\]any\) bool \{ return RestartService\(p\) != "" \},/,
    /ParamsOK:\s+func\(p map\[string\]any\) bool \{ return RestartDelay\(p\) != 0 \},/, /ParamsOK:\s+func\(p map\[string\]any\) bool \{ return len\(p\) == 0 \},/, /ParamsOK:\s+scriptParamsOK,/,
    // 0.34: the five closed software keys, checked in § 40.
    /ParamsOK:\s+softwareParamsOK,/,
    // 0.41: the key, its view and the expected DisplayName, checked in § 59.
    /ParamsOK:\s+removeParamsOK,/,
    // 0.45: a service, its display name, an operation and a start type; a process id, name and creation time (§ 60).
    /ParamsOK:\s+serviceControlParamsOK,/, /ParamsOK:\s+processStopParamsOK,/];
  const openParams = entries.filter((e) => !CLOSED.some((re) => re.test(e))).map((e) => (e.match(/ID: "([^"]+)"/) ?? [])[1] ?? '?');
  check('every agent catalog entry has closed parameters', entries.length === CATALOG_IDS.length && openParams.length === 0, `not closed: ${openParams.join(', ')}`);
  const maint = read('tools/windows-installer/internal/action/maintenance.go');
  const goSvc = ((maint.match(/var RestartableServices = \[\]string\{([^}]*)\}/) ?? [])[1] ?? '').split(',').map((x) => x.trim().replace(/"/g, '')).filter(Boolean);
  const tsSvc = [...(tsCat.match(/export const RESTARTABLE_SERVICES = \[([\s\S]*?)\] as const;/) ?? [])[1]?.matchAll(/name: '([^']+)'/g) ?? []].map((m) => m[1]);
  const NEVER = /^(WinDefend|WdNisSvc|Sense|SecurityHealthService|wscsvc|mpssvc|BFE|lsass|SamSs|KeyIso|VaultSvc|Netlogon|EventLog|RpcSs|RpcEptMapper|DcomLaunch|SgrmBroker|WinHttpAutoProxySvc|CryptSvc|gpsvc|ProfSvc|Schedule|TermService)$/i;
  check('service restart names a fixed allowlist, the same on both sides, with no security or core service on it',
    goSvc.length > 0 && goSvc.join(',') === tsSvc.join(',') && !goSvc.some((n) => NEVER.test(n))
      && /if !ok \|\| !ServiceNameRE\.MatchString\(s\) \{\s*return ""\s*\}\s*for _, a := range RestartableServices \{\s*if s == a \{/.test(maint)
      && /var ServiceNameRE = regexp\.MustCompile\(`\^\[A-Za-z0-9_\]\{1,64\}\$`\)/.test(maint),
    `agent ${goSvc.join(', ')}; portal ${tsSvc.join(', ')}`);
  check('a restart is never immediate: the delay is a whole number of minutes, 5 to 1440, on both sides',
    // 0.54 (§ 67): besides delayMinutes, only the two closed flags, each exactly true.
    /const \(\s*MinRestartDelayMinutes = 5\s*MaxRestartDelayMinutes = 24 \* 60\s*\)/.test(maint)
      && /want := 1\s*for _, k := range RestartFlags \{\s*if _, has := p\[k\]; has \{\s*if !SignedTrue\(p, k\) \{\s*return 0\s*\}\s*want\+\+\s*\}\s*\}\s*if len\(p\) != want \{\s*return 0\s*\}\s*d, ok := p\["delayMinutes"\]\.\(float64\)\s*if !ok \|\| d != math\.Trunc\(d\) \|\| d < MinRestartDelayMinutes \|\| d > MaxRestartDelayMinutes \{/.test(maint)
      && /var RestartFlags = \[\]string\{"onlyIfRequired", "ignoreRemoteSession"\}/.test(maint)
      && /delayMinutes: z\.number\(\)\.int\(\)\.min\(MIN_RESTART_DELAY_MINUTES\)\.max\(MAX_RESTART_DELAY_MINUTES\),\s*onlyIfRequired: z\.literal\(true\)\.optional\(\),\s*ignoreRemoteSession: z\.literal\(true\)\.optional\(\),\s*\}\)\.strict\(\)/.test(tsCat) && /MIN_RESTART_DELAY_MINUTES = 5;/.test(tsCat),
    'RestartDelay and REBOOT_SCHEDULE.params must keep the 5-minute floor');
  const maintEntries = entries.filter((e) => /ID: "windows\.(service\.restart|reboot\.|logs\.)/.test(e));
  check('every maintenance action is high impact on any computer, and the RustDesk restart and the restart wait for no open session',
    maintEntries.length === 4 && maintEntries.every((e) => /Risk:\s+func\(int, int\) string \{ return "high" \},/.test(e))
      // 0.54: the restart's precheck is rebootPrecheck, which skips the session check only on the signed exception (§ 67).
      && /Precheck:\s+rebootPrecheck,/.test(goCat) && /if SignedTrue\(p\.Params, "ignoreRemoteSession"\) \{\s*return nil\s*\}\s*return sessionCheck\("the restart"\)\(p, o\)\s*\}/.test(maint) && /if RestartService\(p\.Params\) == "RustDesk" \{\s*return sessionCheck\(/.test(maint)
      && /if err != nil \{\s*return &Result\{Outcome: "not_executed", Reason: "session_state_unknown"/.test(maint),
    'maintenance risk must be "high" and "cannot tell" must count as a session');
  check('the agent\'s action package runs no process; the Windows side runs only shutdown.exe and wevtutil.exe from System32',
    !/"os\/exec"|exec\.Command/.test(maint + read('tools/windows-installer/internal/action/action.go') + goCat + read('tools/windows-installer/internal/action/software.go') + read('tools/windows-installer/internal/action/remove.go')
      + read('tools/windows-installer/internal/action/svcctl.go') + read('tools/windows-installer/internal/action/procstop.go'))
      && [...read('tools/windows-installer/action_windows.go').matchAll(/runSystem32\([^,]+, "([^"]+)"/g)].map((m) => m[1]).every((x) => x === 'shutdown.exe' || x === 'wevtutil.exe')
      && (read('tools/windows-installer/action_windows.go').match(/exec\.Command(?:Context)?\(/g) ?? []).length === 2,
    'maintenance must not grow a way to run something else');
  // Four maintenance actions (0.32), the script run and the two software actions (0.34), program removal (0.41), service control and ending a process (0.45).
  check('the maintenance actions, the script run and the software actions are not offered to ClientSt0r', (tsCat.match(/integration: false,/g) ?? []).length === 10 && /export const SCRIPT_RUN: CatalogAction = \{[\s\S]{0,2000}?\bintegration: false,/.test(tsCat) && /proposable\(\): string\[\] \{[^}]{0,200}CATALOG\.filter\(\(a\) => a\.integration\)\.map/.test(read('apps/api/src/integration/action-proposals.service.ts'))
      && /if \(!catalogEntry\(body\.action\.id, body\.action\.version\)\?\.integration\)/.test(read('apps/api/src/integration/action-proposals.service.ts')),
    'advertising them changes the ticket-rmm contract');
  // 0.34: the plan's one `script:` field is the signed ScriptBlock — hashes,
  // ids and declared parameters, never text — and is allowed once, exactly.
  const tsCatCode = tsCat.replace(/\/\/.*$|\/\*[\s\S]*?\*\//gm, '');
  check('portal catalog has no command, script, path or URL parameter',
    (tsCatCode.match(/^ {2}script: ScriptBlock\.optional\(\),$/gm) ?? []).length === 1 && !/\b(command|script|path|url|args|cmd)\s*:/i.test(tsCatCode.replace(/^ {2}script: ScriptBlock\.optional\(\),$/m, '')),
    'the catalog must not grow a free-form parameter');
  const act = read('tools/windows-installer/internal/action/action.go');
  const iExec = act.indexOf('State: "executing"'), iRun = act.indexOf('r := Lookup(plan.Action.ID, plan.Action.Version).Execute(plan, o)'), iJournal = act.indexOf('readJournal(o, jobID)');
  check('agent journals a job before executing it, and consults the journal first',
    iJournal > 0 && iExec > iJournal && iRun > iExec && /if err := writeJournal\(o, journal\{JobID: jobID, State: "executing"[\s\S]{0,240}return Result\{\}, fmt\.Errorf/.test(act),
    'the journal write must precede execute() and a failed write must stop it');
  const iPre = act.indexOf('a.Precheck(plan, o)'), iPz = act.indexOf('o.Pause.ActionsPaused(');
  check('an action\'s own checks run after verification and the signed pause, before the executing journal entry, and end the job',
    iPre > iPz && iPz > 0 && iExec > iPre && /if pr := a\.Precheck\(plan, o\); pr != nil \{[\s\S]{0,200}return final\(o, jobID, planSHA, r\)/.test(act) && /func final\([\s\S]{0,400}writeJournal\(o, journal\{JobID: jobID, State: "done"[\s\S]{0,120}return report\(o, r\)/.test(act),
    'Precheck must sit between the pause and the executing journal, and its result must be final');
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
//
//     0.62 reverses "every rollout has a canary" at the owner's request
//     ("remove the goofy canary thing in update policy"), as §41, §62 and
//     §67 were reversed: a deployment or policy may install all at once
//     (staging none, §75), with no canary and no gate. The canary rule below
//     holds for every canary rollout — which is every document and deployment
//     made before 0.62, and any API caller that does not say otherwise.
{
  const upd = read('tools/windows-installer/internal/action/updates.go');
  // 0.32 adds an optional "allow" filter (a patch policy's classes, severities
  // and excluded KBs). It can only narrow: closed keys, fixed values.
  // 0.34: reboot is one of two fixed strings (§ 37 has the restart's rules).
  check('agent update params are closed: exactly updates + reboot "never" | "if_required_in_window" (+ optional allow, + 0.54 ignoreRemoteSession: true beside the in-window rule), each {updateId, revision}',
    /want := 2\s*if hasAllow \{\s*want\+\+\s*\}[\s\S]{0,200}if _, has := p\["ignoreRemoteSession"\]; has \{\s*if !SignedTrue\(p, "ignoreRemoteSession"\) \|\| UpdateReboot\(p\) != RebootInWindow \{\s*return nil, nil, paramErr\([^)]*\)\s*\}\s*want\+\+\s*\}\s*if len\(p\) != want \|\| UpdateReboot\(p\) == ""/.test(upd) && /!ok \|\| len\(m\) != 2/.test(upd)
      && /func UpdateReboot\(p map\[string\]any\) string \{\s*switch s, _ := p\["reboot"\]\.\(string\); s \{\s*case RebootNever, RebootInWindow:\s*return s\s*\}\s*return ""\s*\}/.test(upd)
      && /RebootNever = "never"/.test(upd) && /RebootInWindow = "if_required_in_window"/.test(upd)
      && /if k != "classifications" && k != "severities" && k != "excludeKbs" \{\s*return nil, paramErr/.test(upd)
      && /_, ok := patch\.Installable\[s\]; return ok/.test(upd),
    'the update action must not accept any other parameter, and allow may only narrow');
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
  // 0.42: drivers and definition updates joined the allowlist, at the
  // owner's request. Upgrades, feature packs, service packs, tools and
  // anything unclassified never do: those are OS migrations, not patches.
  const INSTALLABLE = ['ClassCritical', 'ClassDefinitions', 'ClassDrivers', 'ClassSecurity', 'ClassUpdateRollups', 'ClassUpdates'];
  const NEVER = ['ClassUpgrades', 'ClassFeaturePacks', 'ClassServicePacks', 'ClassTools'];
  const instBody = (elig.match(/var Installable = map\[string\]string\{([\s\S]*?)\n\}/) ?? [])[1] ?? '';
  const instKeys = [...instBody.matchAll(/^\s*(\w+):\s*"[^"]*",?\s*$/gm)].map((x) => x[1]).sort();
  const instLines = instBody.split('\n').map((l) => l.replace(/\/\/.*$/, '').trim()).filter(Boolean);
  const guidOf = (c) => (elig.match(new RegExp(`\\b${c}\\s*=\\s*"([0-9a-f-]{36})"`)) ?? [])[1] ?? null;
  const goGuids = INSTALLABLE.map(guidOf);
  const neverGuids = NEVER.map(guidOf);
  const tolBody = (elig.match(/var UserInputTolerated = map\[string\]bool\{([^}]*)\}/) ?? [])[1] ?? null;
  check('the agent installs exactly six classifications — never upgrades, feature packs, service packs, tools or unclassified',
    instKeys.join() === INSTALLABLE.join() && instLines.length === INSTALLABLE.length
      && NEVER.every((c) => !instBody.includes(c)) && goGuids.every(Boolean) && neverGuids.every((g) => g && !instBody.includes(g))
      && /if _, ok := Installable\[u\.Classification\]; !ok \{\s*return false, "excluded_classification"/.test(elig),
    `Installable is ${instKeys.join(', ') || '(not found)'}; must be exactly ${INSTALLABLE.join(', ')}`);
  check('only drivers may be installed although Windows says they can request input; browse-only and licence rules hold for every class',
    tolBody !== null && tolBody.trim() === 'ClassDrivers: true'
      && /if u\.BrowseOnly \{\s*return false, "optional_update"/.test(elig) && /if u\.UserInput && !UserInputTolerated\[u\.Classification\] \{\s*return false, "needs_user_input"/.test(elig)
      && /if !u\.EulaAccepted \{[\s\S]{0,120}return false, "eula_required"/.test(elig),
    'Eligible: UserInputTolerated must be exactly drivers, and optional / licence refusals unconditional');
  const post = read('apps/api/src/patching/posture.ts');
  const tsBody = (post.match(/export const CLASSIFICATIONS: Record<string, string> = \{([\s\S]*?)\n\};/) ?? [])[1] ?? '';
  const tsGuids = [...tsBody.matchAll(/'([0-9a-f-]{36})':/g)].map((x) => x[1]).sort();
  check('the portal\'s installable list is the agent\'s, guid for guid, and its user-input exception is drivers only',
    tsGuids.join() === [...goGuids].sort().join() && neverGuids.every((g) => !tsBody.includes(g))
      && /export const USER_INPUT_TOLERATED: ReadonlySet<string> = new Set\(\[CLASS_DRIVERS\]\);/.test(post) && post.includes(`export const CLASS_DRIVERS = '${guidOf('ClassDrivers')}';`)
      && /if \(u\.userInput && !USER_INPUT_TOLERATED\.has\(u\.classification\)\) return/.test(post),
    `portal CLASSIFICATIONS ${tsGuids.join(', ')}`);
  const pctl = read('apps/api/src/patching/patching.controller.ts');
  check('the patching API has no approve or sign route', !/@(?:Get|Post|Put|Patch|Delete)\('[^']*(approv|sign)/i.test(pctl), 'approval happens on the approval signer only');
  const psvc = read('apps/api/src/patching/patching.service.ts');
  // 0.32: the gate moved to actions/patch-policy.ts so the signer runs the same rule.
  const gateSrc = read('apps/api/src/actions/patch-policy.ts');
  check('the canary gate requires every update effective, and a ring over threshold is retried, never promoted past',
    /reason: 'canary_not_effective'/.test(gateSrc) && /return evaluateRingGate\(/.test(psvc) && /g\.reason === 'too_many_failures'\) return \{ ring: i, canRequest: true/.test(psvc),
    'promotion must be gated on the canary and on the failure threshold');
  const asvc = read('apps/api/src/actions/actions.service.ts');
  check('updates cannot be requested one computer at a time, around the deployment', /ACTION_NOT_DIRECT/.test(asvc) && /direct: false/.test(read('apps/api/src/actions/catalog.ts')),
    'POST /endpoints/:id/actions must refuse windows.update.install');
}

// 16. Containment and evidence (0.28). A pause is enforced at three layers
//     and each layer can only be lifted by its own operator; the audit chain
//     is guarded in the database, and health detail needs a token.
//     0.49 (§ 62, at the owner's request): every "fresh authentication" here
//     is a step-up that names its catalog key (containment.lift); a Platform Admin
//     may turn a key off under Settings → Confirm it is you. Until 0.49 it
//     could not be configured.
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
//     0.49 (§ 62, at the owner's request): every "fresh authentication" here
//     is a step-up that names its catalog key (monitoring.notify); a Platform Admin
//     may turn a key off under Settings → Confirm it is you. Until 0.49 it
//     could not be configured.
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
  for (const f of ['apps/web/scripts/screenshots.mjs', 'apps/web/scripts/capture-media.mjs', 'apps/web/scripts/capture-video.mjs', 'apps/web/scripts/e2e-navigation.mjs', 'apps/web/scripts/e2e-search-palette.mjs', 'apps/web/scripts/e2e-ui.mjs']) {
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
  // The 0.76 palette functions sit inside this block under their own guard and
  // their own section (§86), which allows one fixed System32 w32tm.exe call.
  const blkNoPal = blk.slice(0, blk.indexOf('# ---- Read-only palette (0.76)')) + blk.slice(blk.indexOf('# ---- Snapshots (0.33)'));
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
    blk.length > 5000 && !/Invoke-Expression|\biex\b|Start-Process|Invoke-WebRequest|DownloadString|DownloadFile|Net\.WebClient|Invoke-Command|Start-Job|(Set|Stop|Start|Restart|Suspend|Remove|Clear|New)-(Service|Item|ItemProperty|EventLog)\b|Set-Content|Out-File|Add-Content|& \\\$/i.test(blkNoPal)
      && blk.indexOf('# ---- Read-only palette (0.76)') > 0 && blkNoPal.length > 5000
      && (blk.match(/Invoke-RestMethod/g) ?? []).length === 1 && /enrollment\/diagnostic-result/.test(blk),
    'read-only blocks only, and one post to /enrollment/diagnostic-result');
  check('the agent caps a diagnostic result before posting it',
    /if \(\\\$j\.Length -gt 600000\) \{\s*\\\$p\.Remove\('result'\)/.test(blk) && /MAX_AGENT_RESULT_CHARS = 600_000/.test(cat), 'Send-Rem0teDiag must drop an oversized result');
  const dsvc = read('apps/api/src/diagnostics-catalog/diagnostics-catalog.service.ts');
  const reqFn = dsvc.slice(dsvc.indexOf('async request('), dsvc.indexOf('async history('));
  const repFn = dsvc.slice(dsvc.indexOf('async report('), dsvc.indexOf('private async shapeAgentResult('));
  check('the server accepts only catalog keys, on request and on result',
    /^\s*if \(!isCatalogKey\(key\)\) \{\s*throw new BadRequestException/m.test(reqFn.split('\n').slice(0, 3).join('\n'))
      && /^\s*if \(!isCatalogKey\(dto\.key\)\) return dto\.key === 'unknown' && dto\.state === 'failed' \? this\.refusedByAgent\(endpointId, dto\.runId\) : \{ accepted: false/m.test(repFn.split('\n').slice(0, 3).join('\n'))
      // 0.76: an agent older than a key reports key 'unknown'; that only fails this device's own open run.
      && /private async refusedByAgent\(endpointId: string, runId: string\) \{\s*const run = await this\.prisma\.diagnosticRun\.findFirst\(\{ where: \{ id: runId, endpointId \} \}\);[\s\S]{0,300}if \(run\.status !== 'DELIVERED' && run\.status !== 'RUNNING'\) return/.test(dsvc)
      && /if \(run\.key !== dto\.key\) return \{ accepted: false/.test(repFn)
      && /export function isCatalogKey\(k: unknown\): k is DiagnosticKey \{\s*return typeof k === 'string' && BY_KEY\.has\(k\);/.test(cat),
    'request() and report() must refuse a non-catalog key first; report() must match the run\'s key');
  const mig = read('apps/api/prisma/migrations/0031_diagnostic_runs/migration.sql');
  // 0042 (0.33) and 0092 (0.76) redefine the key list; the newest definition is the one in force.
  const migKeys = read('apps/api/prisma/migrations/0092_diagnostics_palette/migration.sql');
  const dbKeys = [...(/"DiagnosticRun_key_catalog" CHECK \("key" IN \(([\s\S]*?)\)\)/.exec(migKeys)?.[1] ?? '').matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
  check('the database refuses a key outside the catalog', JSON.stringify(dbKeys) === JSON.stringify(keys), `CHECK lists: ${dbKeys.join(',')}`);
  // 0.76: a key and, for dns_lookup and tcp_port only, the closed schema of
  // parseDiagnosticParams — at request, again at delivery, in 0092's CHECK
  // and on the agent (§86).
  const hbFn = dsvc.slice(dsvc.indexOf('async forHeartbeat('), dsvc.indexOf('private async requesterStillAllowed('));
  check('a request carries a key and, only where the catalog has a schema, its closed parameters',
    /export class RequestDiagnosticDto \{\s*@IsString\(\)\s*@Length\(1, 64\)\s*@Matches\([^\n]*\)\s*key!: string;\s*@IsOptional\(\)\s*@IsObject\(\)\s*params\?: Record<string, unknown>;\s*\}/.test(read('apps/api/src/diagnostics-catalog/diagnostics-catalog.controller.ts'))
      && /const parsed = parseDiagnosticParams\(key, rawParams\);\s*if \(!parsed\.ok\) throw new BadRequestException\(\{ code: 'INVALID_DIAGNOSTIC_PARAMS'/.test(reqFn)
      && reqFn.indexOf('parseDiagnosticParams(') < reqFn.indexOf('this.assertVisible(')
      && /const reparsed = parseDiagnosticParams\(r\.key, r\.params \?\? undefined\);/.test(hbFn)
      && /out\.push\(reparsed\.ok && reparsed\.params \? \{ id: r\.id, key: r\.key, params: reparsed\.params \} : \{ id: r\.id, key: r\.key \}\)/.test(hbFn),
    'parameters only through parseDiagnosticParams, at request (before anything is read) and again at delivery; the agent is handed only the re-parsed copy');
  check('stored diagnostic results are size-capped',
    /const capped = capResult\(shaped, resultCapFor\(run\.key\)\);[\s\S]{0,300}result: capped\.result/.test(repFn) && /export const MAX_RESULT_BYTES = 32_768;/.test(cat)
      && /CHECK \("result" IS NULL OR octet_length\("result"::text\) <= 65536\)/.test(mig),
    'report() must store capResult\'s output; the migration keeps the 64 KB backstop');
  const enr = read('apps/api/src/enrollment/enrollment.service.ts');
  const dr = enr.slice(enr.indexOf('async diagnosticResult('), enr.indexOf('async diagnosticResult(') + 1000);
  check('a diagnostic result needs the device secret', /secretMatches\(node\.agentSecretHash, dto\.agentSecret\)/.test(dr) && /UnauthorizedException/.test(dr), 'diagnostic-result must authenticate like command-result');
  check('only an authenticated heartbeat is handed diagnostic runs', /if \(authenticated\) \{\s*try \{\s*diagnostics = await this\.diagnostics\.forHeartbeat\(node\.endpointId\);/.test(enr), 'forHeartbeat must be gated on authenticated');
  // 0.35: a run with no requester (an automatic snapshot, §50) has nobody to
  // re-check; every run that has one still is.
  check('a run is re-authorized against its requester at delivery', /const why = !entry \? 'unknown_key' : !ep \? 'endpoint_missing' : !reparsed\.ok \? 'bad_params' : r\.requestedById === null \? \(isSnapshotKey\(r\.key\) \? null : 'not_a_snapshot'\) : await this\.requesterStillAllowed\(r, entry, ep\);/.test(dsvc), 'forHeartbeat must check the requester before DELIVERED');
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
  // 0.49: the step-up names its catalog key (updates.schedule), which the confirm policy may turn off (§ 62).
  check('turning a policy on, or removing a site override, needs fresh authentication (catalog key updates.schedule)',
    /if \(input\.enabled && !fresh\('updates\.schedule'\)\) throw new FreshAuthNeeded\('updates\.schedule'\);/.test(svc) && /\/\/ The site falls back to the business policy, which may be on\.\s*if \(!fresh\('updates\.schedule'\)\) throw new FreshAuthNeeded\('updates\.schedule'\);/.test(svc)
      && (ctl.match(/this\.isFresh\(req\)/g) ?? []).length === 4 && /code: 'STEP_UP_REQUIRED'/.test(ctl),
    'the service must refuse without fresh auth and the controller must pass isFresh(req) on all four writes (0.35 added removing a group policy, §46; 0.46 the business agent mode, §53)');
  check('a site override must belong to the business it is set in',
    /if \(!site \|\| site\.customerId !== customerId\) throw new NotFoundException/.test(svc), 'siteOf must compare site.customerId');
  // 0.36: clearUnwanted is reconcileQueued, which the sweep also runs every
  // tick: it reads only POLICY requests and writes only the one it read.
  check('withdrawing automatic requests never touches a manual one',
    /return \(await this\.reconcileQueued\(\{ customerId \}\)\)\.withdrawn;/.test(svc)
      && /where: \{ updateRequestSource: 'POLICY', updateRequestedAt: \{ not: null \},/.test(svc)
      && /const same = \{ id: n\.id, updateRequestSource: 'POLICY' as const, updateRequestedAt: n\.updateRequestedAt, updatePolicyId: n\.updatePolicyId \};\s*const w = await this\.prisma\.rustdeskNode\.updateMany\(\{\s*where: same,/.test(svc),
    'clearUnwanted → reconcileQueued: reads POLICY requests only, and each write is conditional on POLICY and on the request it read');
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

// 22. Reports (0.32). A report is a disclosure like a list: every device
//     query starts from the visibility rule AND-ed (never spread beside
//     another OR, which is how 0.31's first fix leaked), every alert query
//     from the alerts list's own rule, each route names its capability, and
//     an export is capped and audited before it leaves.
{
  const rsvc = read('apps/api/src/reports/reports.service.ts');
  const rctl = read('apps/api/src/reports/reports.controller.ts');
  const fn = (name, next) => rsvc.slice(rsvc.indexOf(`private ${name}(`), rsvc.indexOf(next, rsvc.indexOf(`private ${name}(`) + 10));
  const dw = fn('devicesWhere', 'private ');
  const aw = fn('alertsWhere', 'private ');
  check('reports: devices start from the visibility rule, AND-ed, with computers:view asserted',
    /this\.acl\.assertCapability\(actor, CAP\.COMPUTERS_VIEW\);/.test(dw) && /\[this\.acl\.endpointVisibilityWhere\(actor, q\.businessId\), \{ status: 'ACTIVE' \}\]/.test(dw) && /return \{ AND: and \};/.test(dw),
    'devicesWhere must assert computers:view and AND the visibility fragment');
  check('reports: alerts start from MonitoringAdminService.alertWhere, AND-ed with device visibility',
    /this\.monitoring\.alertWhere\(actor, q\.businessId\)/.test(aw) && /\{ OR: \[\{ endpointId: null \}, \{ endpoint: \{ is: this\.acl\.endpointVisibilityWhere\(actor, q\.businessId\) \} \}\] \}/.test(aw) && /return \{ AND: and \};/.test(aw),
    // `is:` (0.34): a bare `{ endpoint: {} }` inside an OR matches nothing in
    // Prisma 5, which emptied a Platform Admin's alert reports.
    'alertsWhere must call alertWhere and AND the visibility rule, as `endpoint: { is: … }`');
  const epQueries = [...rsvc.matchAll(/this\.prisma\.endpoint\.(findMany|groupBy|count|aggregate)\(\{[\s\S]{0,160}/g)].map((m) => m[0]);
  const alQueries = [...rsvc.matchAll(/this\.prisma\.monitorAlert\.(findMany|groupBy|count|aggregate)\(\{[\s\S]{0,160}/g)].map((m) => m[0]);
  check('reports: every endpoint query is scoped by devicesWhere and every alert query by alertsWhere',
    epQueries.length >= 4 && epQueries.every((q) => /this\.devicesWhere\(actor, /.test(q)) && alQueries.length >= 4 && alQueries.every((q) => /this\.alertsWhere\(actor, |\[base, /.test(q))
      && /const base = this\.alertsWhere\(actor, q\);/.test(rsvc),
    `endpoint queries ${epQueries.length}, alert queries ${alQueries.length}`);
  check('reports: the visibility rule is never spread into another object', !/\.\.\.\s*this\.acl\.endpointVisibilityWhere/.test(rsvc), 'spread found');
  const routes = rctl.split('@Get(').slice(1);
  check('reports: every route names its capability; every export is throttled',
    routes.length === 12 && routes.every((r) => /^\s*'[^']+'\)\s*@RequireCapability\(CAP\.(COMPUTERS_VIEW|ALERTS_VIEW)\)/.test(r)) && routes.filter((r) => /export\.csv/.test(r.slice(0, 60))).every((r) => /@RateLimit\(10\)/.test(r.slice(0, 200)))
      && routes.filter((r) => /^'(alert-frequency|offline-time)/.test(r)).every((r) => /CAP\.ALERTS_VIEW/.test(r.slice(0, 120))),
    'twelve routes (0.34 added software compliance, 0.56 warranty, each with its export), each @RequireCapability; alert reports need ALERTS_VIEW; exports @RateLimit');
  const ex = rsvc.slice(rsvc.indexOf('async exportCsv('));
  check('reports: an export is capped, neutralised and audited (logOrFail) before it is returned',
    /if \(lines\.length > EXPORT_MAX_ROWS\) \{\s*throw new BadRequestException/.test(ex) && /cells\.map\(csvCell\)/.test(ex)
      && ex.indexOf("await this.audit.logOrFail({\n      action: 'REPORT_EXPORTED'") > 0 && ex.indexOf('logOrFail') < ex.indexOf('return { filename'),
    'exportCsv must refuse above the cap, quote through csvCell and logOrFail REPORT_EXPORTED before returning');
  check('reports: a device secret is reported as bound or not, never returned',
    (rsvc.match(/agentSecretHash/g) ?? []).length === 2 && /rustdeskNode: \{ select: \{ agentSecretHash: true \} \}/.test(rsvc) && /e\.rustdeskNode\.agentSecretHash \? 'bound'/.test(rsvc),
    'agentSecretHash may appear only in the select and the bound/none mapping');
}

// 23. The script library. It stores, hashes and reviews scripts and has no
//     way to run one: a script would run only as a signed action, approved on
//     the approval signer and verified by the signed agent
//     (docs/script-library.md). So the library reaches nothing that touches
//     a computer, has no run route, never lets a contributor approve, and its
//     versions cannot change once written.
{
  const dir = 'apps/api/src/script-library';
  const files = readdirSync(join(ROOT, dir)).filter((f) => f.endsWith('.ts')).map((f) => `${dir}/${f}`);
  const src = Object.fromEntries(files.map((f) => [f, read(f)]));
  const code = (s) => s.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
  // 0.34: the pure parameter/hash rules live in actions/script-run (zod and
  // node:crypto only, also loaded by the signer); the library takes them from there.
  const ALLOWED = /^(node:crypto|zod|express|@nestjs\/common|@prisma\/client|\.\/(definition|static-checks|script-library\.(service|controller))|\.\.\/(prisma\/prisma\.service|audit\/audit\.(service|module)|rbac\/(access-control\.service|capabilities|platform-permissions)|security-controls\/review|common\/guards\/jwt-auth\.guard|common\/decorators\/actor\.decorator|common\/throttling|auth\/step-up\.service|actions\/script-run|actions\/approval-mode))$/;
  const importsOf = (s) => [...s.matchAll(/^\s*(?:import|export)\b[^;]*?\bfrom\s*['"]([^'"]+)['"]|\b(?:require|import)\(\s*['"]([^'"]+)['"]/gm)].map((m) => m[1] ?? m[2]);
  const badImports = files.flatMap((f) => importsOf(src[f]).filter((i) => !ALLOWED.test(i)).map((i) => `${f} imports ${i}`));
  const touches = files.flatMap((f) => [...code(src[f]).matchAll(/\b(actionJob|actionTarget|ActionsService|SignerClient|createPlan|endpointCommand|diagnosticRun|rustdeskNode|EnrollmentService|DiagnosticsCatalogService|PatchingService|heartbeat|forHeartbeat|envelope)\b|\.endpoint\./gi)].map((m) => `${f}: ${m[0]}`));
  const reachIn = walk('apps/api/src').filter((f) => !f.startsWith(dir) && f !== 'apps/api/src/app.module.ts' && /from ['"][./]*script-library\//.test(read(f)));
  const mod = src[`${dir}/script-library.module.ts`] ?? '';
  check('the script library creates no action job and reaches no agent, signer or heartbeat',
    files.length >= 5 && badImports.length === 0 && touches.length === 0 && reachIn.length === 0 && !/@Global\(\)/.test(code(mod)) && !/exports\s*:/.test(code(mod)),
    [...badImports, ...touches, ...reachIn.map((f) => `${f} imports the library`)].join('; ') || 'script-library module missing, global, or exporting');

  const ctl = src[`${dir}/script-library.controller.ts`] ?? '';
  const routes = [...ctl.matchAll(/@(Get|Post|Put|Patch|Delete)\(\s*(?:'([^']*)')?\s*\)/g)].map((m) => `${m[1].toUpperCase()} ${m[2] ?? ''}`);
  const EXPECT = ['GET ', 'POST ', 'GET :id', 'GET :id/diff', 'POST :id/versions', 'GET :id/versions/:version', 'POST :id/versions/:version/submit', 'POST :id/versions/:version/withdraw', 'POST :id/versions/:version/review'];
  // 0.34: the one other controller with script routes is the script-run
  // module's, and its routes are exactly these (§ 39 checks what they do).
  const RUN_CTL = 'apps/api/src/script-run/script-run.controller.ts';
  const runRoutes = [...read(RUN_CTL).matchAll(/@(Get|Post|Put|Patch|Delete)\(\s*(?:'([^']*)')?\s*\)/g)].map((m) => `${m[1].toUpperCase()} ${m[2] ?? ''}`);
  const RUN_EXPECT = ['GET versions/:versionId', 'POST versions/:versionId/allowlist', 'POST versions/:versionId/allowlist/revoke', 'POST '];
  const elsewhere = walk('apps/api/src').filter((f) => /controller\.ts$/.test(f) && !f.startsWith(dir))
    // 0.77: a terminal session's `transcript` route is not a script (the word only contains it).
    .filter((f) => /@(?:Get|Post|Put|Patch|Delete)\('[^']*scripts?\b|@Controller\(\s*\[?\s*'[^']*scripts?\b/i.test(read(f).replace(/'sessions\/:sid\/transcript'/g, "''")))
    .filter((f) => !(f === RUN_CTL && /@Controller\('script-runs'\)/.test(read(f)) && JSON.stringify(runRoutes) === JSON.stringify(RUN_EXPECT)));
  check('the script library has no run route, here or anywhere else',
    /@Controller\('scripts'\)/.test(ctl) && JSON.stringify(routes) === JSON.stringify(EXPECT) && !routes.some((r) => /run|exec|dispatch|deploy|send|schedule|push|approve/i.test(r)) && elsewhere.length === 0,
    `routes: ${routes.join(', ')}${elsewhere.length ? `; other controllers with script routes: ${elsewhere.join(', ')}` : ''}`);

  const svc = code(src[`${dir}/script-library.service.ts`] ?? '');
  const rev = svc.slice(svc.indexOf('async review('));
  // 0.40: the one exception is direct mode on the signer's default policy (§ 58), recorded as selfReviewed.
  const iSame = rev.search(/const self = v\.authorId === actor\.userId \|\| v\.contributorIds\.includes\(actor\.userId\);\s*const selfReviewed = self && await this\.approvalMode\.allowlistDirect\(\);\s*if \(self && !selfReviewed\) \{\s*await refuse\('same_person'\);\s*throw new ForbiddenException\(\{ code: 'SAME_PERSON'/);
  const iHash = rev.search(/if \(d\.expectedSha256 !== v\.contentSha256\) \{/);
  // 0.49: named by its catalog key, scripts.review (§ 62).
  const iFresh = rev.search(/if \(d\.decision === 'approve'\) assertFresh\(freshMethod, \{ action: 'scripts\.review' \}\);/);
  const iWrite = rev.search(/tx\.scriptVersion\.updateMany\(\{\s*where: \{ id: v\.id, status: 'IN_REVIEW', contentSha256: d\.expectedSha256 \}/);
  const mig = read('apps/api/prisma/migrations/0035_script_library/migration.sql');
  check('approval refuses SAME_PERSON (author and contributors), binds the hash seen, and needs fresh authentication — before it writes',
    iSame >= 0 && iHash > iSame && iFresh > iHash && iWrite > iFresh
      && /const contributorIds = contributorsOf\(actor\.userId, base\);/.test(svc)
      && /if \(base && base\.status !== 'APPROVED'\) for \(const c of base\.contributorIds\) out\.add\(c\);/.test(read(`${dir}/definition.ts`))
      && /"decidedById" <> "authorId"\s*AND NOT \("decidedById" = ANY \("contributorIds"\)\)\s*AND "approvedSha256" IS NOT NULL\s*AND "approvedSha256" = "contentSha256"/.test(mig)
      && /\("selfReviewed" OR \("decidedById" <> "authorId" AND NOT \("decidedById" = ANY \("contributorIds"\)\)\)\)\s*AND "approvedSha256" IS NOT NULL\s*AND "approvedSha256" = "contentSha256"/.test(read('apps/api/prisma/migrations/0065_direct_mode_self_review/migration.sql'))
      && /selfReviewed: approve && selfReviewed \}/.test(rev),
    'review() must check SAME_PERSON (relaxed only by the direct-mode probe, recorded), then the hash, then assertFresh, then write; new versions inherit unapproved contributors; 0035/0065 keep the CHECK');

  const guard = mig.slice(mig.indexOf('CREATE OR REPLACE FUNCTION rem0te_script_version_guard()'));
  const IMMUTABLE = ['content', 'contentSha256', 'definitionSha256', 'contentBytes', 'parameters', 'risk', 'language', 'targetOs', 'description', 'authorId', 'contributorIds', 'scriptId', 'version', 'basedOnId'];
  const missing = IMMUTABLE.filter((c) => !new RegExp(`NEW\\."${c}" (<>|IS DISTINCT FROM) OLD\\."${c}"`).test(guard));
  const writes = [...svc.matchAll(/scriptVersion\.(update|updateMany|upsert)\(\{[\s\S]*?data: \{([^}]*)\}/g)].map((m) => m[2]);
  check('script versions are immutable: the trigger fixes content and definition, the service never rewrites them',
    missing.length === 0 && /CREATE TRIGGER "ScriptVersion_immutable" BEFORE INSERT OR UPDATE ON "ScriptVersion"/.test(mig)
      && /CREATE TRIGGER "Script_immutable" BEFORE UPDATE ON "Script"/.test(mig)
      && /IF NEW\."contentSha256" <> encode\(sha256\(convert_to\(NEW\."content", 'UTF8'\)\), 'hex'\) THEN/.test(guard)
      && /IF NEW\."status" <> 'DRAFT'/.test(guard)
      && writes.length >= 2 && writes.every((w) => !/\b(content|contentSha256|definitionSha256|contentBytes|parameters|risk|language|targetOs|description|authorId|contributorIds)\b/.test(w)),
    `trigger does not fix: ${missing.join(', ') || '-'}; service writes: ${writes.join(' | ')}`);
}

// 24. The standard Linux agent (0.32). It reports and never acts: the only
//     things it reads from a heartbeat response are command ids and three
//     fixed type names, it runs no expression, shell, download or
//     package-changing command, it reads os-release and its config with sed
//     (never sources them), keeps the secret out of argv, and refuses a
//     world-readable secret or one another account owns. The installer
//     writes the secret 0600 and its --uninstall removes it. Server side:
//     device strings are made inert on heartbeat and claim, and the console
//     refuses to stage what the Linux agent would ignore. Since 0.33 the
//     parts that touch the secret, the server and its response live in
//     posix-agent.ts, shared with macOS (§ 32), so both are checked here.
// The shell text of an agent module: every String.raw template in it, with
// comment lines dropped (they name what the agent does NOT do).
const shellCode = (...files) => files.map((f) => [...read(f).matchAll(/String\.raw`([\s\S]*?)`;/g)].map((m) => m[1]).join('\n')).join('\n')
  .split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');
const POSIX_PARTS = ['POSIX_SETUP', 'POSIX_TRANSPORT', 'POSIX_HEARTBEAT', 'POSIX_COMMANDS'];
{
  const la = read('apps/api/src/public/linux-agent.ts');
  const code = shellCode('apps/api/src/public/linux-agent.ts', 'apps/api/src/public/posix-agent.ts');
  const build = la.slice(la.indexOf('export function buildLinuxAgentScript('), la.indexOf('}', la.indexOf('export function buildLinuxAgentScript(')));
  check('the Linux agent is assembled with every shared POSIX guard',
    POSIX_PARTS.every((p) => build.includes(p)) && /assemblePosixAgent\('linux'/.test(build),
    `buildLinuxAgentScript must include ${POSIX_PARTS.join(', ')}`);
  check('the Linux agent runs no expression, shell, download or state-changing command',
    code.length > 8000
      && !/\beval\b|^\s*\.\s|\bsource\b|\b(sh|bash|dash) -c\b|\|\s*(sh|bash|dash)\b|\bwget\b|\bpython3?\b|\bperl\b/m.test(code)
      && !/\brustdesk\s+--|\bsystemctl\b|(^|[\s;&|(])(reboot|shutdown|poweroff)(\s|;|$)|\bapt-get\b|\bapt (update|upgrade|install|remove|full-upgrade)\b|\bdpkg -i\b|\bdnf (-[a-zA-Z]+ )*(install|upgrade|update|makecache|remove)\b|\bzypper\b[^\n]*(?<![-\w])(refresh|ref|update|up|install|in|patch|remove|dup)(?![-\w])|\brpm -[iUe]/m.test(code)
      && (code.match(/\bcurl -/g) ?? []).length === 1,
    'the agent must stay read-only: one curl (in post()), and nothing that changes the machine');
  check('the Linux agent reads only command ids and three fixed types from the response',
    /grep -oE '\\\{"id":"\[A-Za-z0-9_-\]\{1,64\}","type":"\(INVENTORY_REFRESH\|UPDATE_SCAN\|EVENT_LOG_QUERY\)"'/.test(code)
      && !/rotate|updateRustdesk|reinstallAgent|confirm-rotation|diagnostic-result|monitor-report/.test(code),
    'no other field of the heartbeat response may be read');
  check('the Linux agent never refreshes a repository to list updates',
    /apt list --upgradable/.test(code) && /dnf -q -C check-update/.test(code) && /zypper --non-interactive --no-refresh list-updates/.test(code),
    'apt list (no apt update), dnf -C, zypper --no-refresh');
  check('the Linux agent parses its config and os-release with sed, and keeps the secret out of argv',
    /conf_get\(\) \{ sed -n "s\/\^\$1=\/\/p" "\$CONF"/.test(code) && /osr_get\(\) \{ sed -n "s\/\^\$1=\/\/p" "\$OS_RELEASE"/.test(code)
      && /--data-binary @"\$TMPD\/req"/.test(code) && !/curl[^\n]*\$SECRET/.test(code),
    'never source a file; the body (with the secret) goes through a 0700 temp file');
  check('the Linux agent refuses a readable secret and non-https servers',
    /case "\$mode" in\s*600\|400\) ;;\s*\*\) log "refusing/.test(code) && /\^https:\/\/\[A-Za-z0-9\.-\]\+/.test(code)
      && /\^http:\/\/\(127\\\.0\\\.0\\\.1\|localhost\)/.test(code),
    'secret must be 600/400; plain http only to loopback');
  check('the POSIX agents refuse a secret owned by any account but their own',
    /owner=\$\(file_owner "\$SECRET_FILE"\)\nif \[ -z "\$owner" \] \|\| \[ "\$owner" != "\$\(id -u\)" \]; then\n\s*log "refusing[^\n]*\n\s*exit 1/.test(code),
    'posix-agent.ts must compare the secret file\'s owner with id -u and exit before sending');
  check('every string the Linux agent sends goes through txt or nm',
    /txt\(\) \{ printf '%s' "\$1" \| tr -cd ' -~' \| tr -d '"\\\\' \| cut -c1-"\$2"; \}/.test(code)
      && /nm\(\) \{ printf '%s' "\$1" \| tr -cd 'A-Za-z0-9\._-' \| cut -c1-"\$2"; \}/.test(code),
    'printable ASCII without " or \\, clamped; host names to the inert charset');
  const pc = read('apps/api/src/public/public.controller.ts');
  const lin = pc.slice(pc.indexOf('private buildLinuxScript('), pc.indexOf('private buildMacosScript('));
  check('the Linux installer writes the device secret 0600 and --uninstall removes it',
    /\( umask 077; printf '%s' "\\\$\{AGENT_SECRET\}" > "\\\$\{AGENT_STATE\}" \)/.test(lin) && /chmod 600 "\\\$\{AGENT_STATE\}"/.test(lin)
      && /rm -f \$\{LINUX_AGENT_PATH\} \$\{LINUX_AGENT_CONF\} \$\{LINUX_AGENT_SECRET\}/.test(lin)
      && /<<'\$\{LINUX_AGENT_HEREDOC\}'/.test(lin),
    'secret under umask 077 + chmod 600; agent embedded in a quoted heredoc; uninstall removes the secret');
  const enr = read('apps/api/src/enrollment/enrollment.service.ts');
  const hb = enr.slice(enr.indexOf('async heartbeat('), enr.indexOf('const node = await this.prisma.rustdeskNode.findUnique({', enr.indexOf('async heartbeat(')));
  check('device-reported names are made inert on heartbeat and claim',
    /dto = withDeviceText\(dto\);/.test(hb) && /this\.claimWithConsumedToken\(withDeviceText\(dto\), record, claimedByIp\)/.test(enr)
      && /const CONTROL = \/\[\\x00-\\x1f\\x7f-\\x9f/.test(read('apps/api/src/enrollment/device-text.ts')),
    'heartbeat() must pass its dto through withDeviceText before the node lookup; claim likewise');
  const eps = read('apps/api/src/endpoints/endpoints.service.ts');
  const fn = (name) => eps.slice(eps.indexOf(`async ${name}(`), eps.indexOf(`async ${name}(`) + 900);
  check('the console refuses to stage for Linux and macOS what their agents would ignore',
    /await this\.refuseOnReadOnlyAgent\(endpointId, /.test(fn('rotateCredential')) && /await this\.refuseOnReadOnlyAgent\(id, /.test(fn('requestAgentReinstall'))
      && /await this\.refuseOnReadOnlyAgent\(id, /.test(fn('requestEventLog'))
      && /const refusal = readOnlyAgentRefusal\(ep\?\.platform, what\);\s*if \(refusal\) throw new BadRequestException\(refusal\);/.test(eps)
      && /!readOnlyAgentOs\(n\.endpoint\?\.platform\)/.test(read('apps/api/src/admin/update.service.ts')),
    'rotation, reinstall, event-log query and one-click client update must refuse or skip Linux and macOS');
}

// 25. Patch policies and installing from the Patches tab (0.32). A policy is
//     approved once, on the signer, by two people; after that the signer —
//     never the portal — signs each ring plan, and only inside the policy.
//     Manual installs are one-computer deployments that still need two
//     approvals. (§19 and §20 were taken by 0.30.1 and 0.31.)
{
  const pctl = read('apps/api/src/patching/patching.controller.ts');
  const psvc = read('apps/api/src/patching/patching.service.ts');
  const proutes = [...pctl.matchAll(/@(?:Get|Post|Put|Patch|Delete)\('([^']*)'\)/g)].map((m) => m[1]);
  check('the patching API has no route that approves or signs a policy or a plan',
    proutes.includes('patching/policies') && !proutes.some((r) => /approv|sign|activate|unrevoke|reinstate/i.test(r)),
    `patching routes: ${proutes.join(', ')}`);
  const sigClient = read('apps/api/src/actions/signer.client.ts').replace(/\/\/.*$|\/\*[\s\S]*?\*\//gm, '');
  check('the portal\'s signer client cannot approve, sign or un-revoke a policy',
    /submitUnderPolicy\(/.test(sigClient) && !/\/(approve|decide|challenge|unrevoke|restore)\b/.test(sigClient),
    'only propose, read, revoke and submit-under-policy');
  const at = (src, marker, n) => src.slice(src.indexOf(marker), src.indexOf(marker) + n);
  const createFn = at(pctl, "@Post('patching/policies')", 400);
  const revokeFn = at(pctl, "@Post('patching/policies/:id/revoke')", 400);
  check('creating or revoking a policy needs fresh authentication',
    /this\.fresh\(req\)/.test(createFn) && /this\.fresh\(req\)/.test(revokeFn) && /assertFresh\(/.test(pctl),
    'POST patching/policies and patching/policies/:id/revoke must call assertFresh');
  const core = read('apps/api/src/approval-signer/core.ts');
  const sun = at(core, 'export function signUnderPolicy(', 1800);
  check('the signer signs under a policy only after the pure evaluator accepts the plan',
    /const decision: PolicyDecision = evaluatePolicyPlan\(/.test(sun) && /if \(!decision\.ok\) throw new Refused\(decision\.code/.test(sun) && sun.indexOf('evaluatePolicyPlan(') < sun.indexOf('signJob(job'),
    'signUnderPolicy must evaluate, and refuse, before signJob');
  const ev = read('apps/api/src/actions/patch-policy.ts');
  const evFn = ev.slice(ev.indexOf('export function evaluatePolicyPlan('));
  const need = ['policy_revoked', 'policy_signature_invalid', 'policy_digest_mismatch', 'policy_expired', 'policy_not_approved', 'computer_not_in_policy', 'class_not_allowed', 'kb_excluded', 'filter_mismatch', 'outside_window', 'ring_out_of_order', 'reboot_not_allowed', 'evidence_mismatch'];
  const missing = need.filter((c) => !evFn.includes(`'${c}'`) && !ev.includes(`'${c}'`));
  check('the policy evaluator refuses out-of-policy plans (computers, classes, KBs, window, ring order, expiry, revocation, digest)',
    missing.length === 0 && /evaluateRingGate\(\{/.test(evFn) && /canary_not_effective/.test(evFn) && !/from '@nestjs|from '@prisma\/client'/.test(ev),
    `missing refusals: ${missing.join(', ')}`);
  check('the canary needs no evidence and a later ring needs the previous ring signed by this signer',
    /if \(ring === 0\) \{\s*if \(r\.evidence\) return no\('bad_evidence'/.test(evFn) && /if \(!prev\) return no\('ring_out_of_order'/.test(evFn),
    'ring order comes from the signer\'s own ledger');
  const store = read('apps/api/src/approval-signer/store.ts');
  check('a revocation is a write-once file on the signer, merged on every read',
    /revokePatchPolicy\([\s\S]{0,600}'wx'/.test(store) && /patchPolicy\(id: string\)[\s\S]{0,600}revocations/.test(store),
    'revocations/<id>.json, created with wx, never rewritten');
  const srv = read('apps/api/src/approval-signer/server.ts');
  check('the signer refuses policy plans and new policies while paused',
    /async function internalPolicy[\s\S]{0,900}assertNotPaused\(doc\.businessId\)/.test(srv) && /assertNotPaused\(r\.doc\.businessId\);\s*const existing = jobId/.test(srv),
    'propose and plans must consult the pause');
  const pol = read('apps/api/src/patching/policies.service.ts');
  check('the policy sweep can be switched off (PATCH_POLICY_SWEEP=off), and never runs twice at once',
    /static sweepEnabled\(\) \{ return process\.env\.PATCH_POLICY_SWEEP !== 'off'; \}/.test(pol) && /onModuleInit\(\) \{\s*if \(!PatchPolicyService\.sweepEnabled\(\)\) return;/.test(pol) && /if \(this\.busy\) return;/.test(pol),
    'onModuleInit must return before scheduling when the sweep is off');
  check('the sweep proposes once per window (unique policy + window) and consults containment',
    /@@unique\(\[policyId, windowKey\]\)/.test(read('apps/api/prisma/schema.prisma')) && /containment\.blocking\('actions', r\.customerId\)/.test(pol) && /e\.code === 'P2002'/.test(pol),
    'PatchDeployment(policyId, windowKey) must be unique and the sweep must check the pause');
  check('e2e and docs stacks run with the sweep off unless testing it',
    /export PATCH_POLICY_SWEEP=off/.test(read('scripts/run-e2e.sh')) && /PATCH_POLICY_SWEEP=off/.test(read('docs/screenshots.md')),
    'scripts/run-e2e.sh and the docs stack (docs/screenshots.md) must set PATCH_POLICY_SWEEP=off');
  const ins = at(psvc, 'async installOnEndpoint(', 2400);
  check('a manual install is a one-computer deployment whose canary still awaits two approvals',
    /rings: \[\[endpointId\]\]/.test(ins) && /'MANUAL', null\)/.test(ins) && /this\.requestRing\(actor, d\.id, 0, \{ reason: dto\.reason, startsInMinutes: dto\.startsInMinutes, \.\.\.\(dto\.schedule \? \{ schedule: dto\.schedule \} : \{\}\) \}, undefined, freshMethod\);/.test(ins) && !/underPolicy|UnderPolicy/.test(ins),
    'installOnEndpoint must not pass a policy (which would sign without approvals)');
  check('only the sweep requests a ring under a policy, and a person cannot request one beside it',
    /if \(!under && d\.origin === 'POLICY'\) throw new ConflictException/.test(psvc) && (pctl.match(/requestRing\(/g) ?? []).length === 2
      && /this\.patching\.requestRing\(actor, id, Number\(ring\), body, undefined, this\.freshMethod\(req\)\) \}/.test(pctl),
    'the controller must never pass an UnderPolicy');
  check('ACTION_NOT_DIRECT still holds for updates',
    /ACTION_NOT_DIRECT/.test(read('apps/api/src/actions/actions.service.ts')) && /direct: false/.test(read('apps/api/src/actions/catalog.ts')),
    'POST /endpoints/:id/actions must refuse windows.update.install');
  // 0.34: the reboot rule is the closed pair (§ 37); a policy defaults to never.
  check('a policy\'s restart rule is the closed pair, defaults to never, and is signed into the policy',
    /reboot: UpdateReboot,/.test(ev) && /reboot: UpdateReboot\.default\('never'\),/.test(pol) && /window: dto\.window, reboot: dto\.reboot,/.test(pol),
    'PolicyDoc.reboot must be UpdateReboot and CreatePolicyDto must default to never');
}

// 26. Within-business computer visibility (0.31.2). A Business User sees only
//     computers granted to them or COMPANY_WIDE. The per-id check every `:id`
//     route uses must apply that rule, not business scope alone, and must
//     take it from endpointVisibilityWhere so the two cannot drift. Until
//     0.31.2 it checked business and technician grants only, and
//     GET /admin/search filtered computers by `customerId`: both let a
//     Business User read (and the per-id routes change) computers granted
//     only to someone else. Proof: apps/api/scripts/e2e-endpoint-visibility.mjs.
{
  const acl = read('apps/api/src/rbac/access-control.service.ts');
  const start = acl.indexOf('  async assertEndpointInScope(');
  const fn = acl.slice(start, acl.indexOf('\n  }\n', start));
  check('assertEndpointInScope applies the Business User visibility rule from endpointVisibilityWhere',
    start > 0
      && /\} else if \(!this\.isBusinessOwner\(actor\) && endpoint\.accessMode !== 'COMPANY_WIDE'\) \{/.test(fn)
      && /where: \{ AND: \[\{ id: endpoint\.id \}, this\.endpointVisibilityWhere\(actor\)\] \}/.test(fn)
      && /if \(visible === 0\) throw new NotFoundException\('Computer not found'\);/.test(fn),
    'a Business User (not owner, not technician) must be checked against endpointVisibilityWhere, with the same NotFound');
  // Any variant that skips the rule must be named for it and justified, never
  // a silent default. None exists today; a new one is a review.
  const variants = [...acl.matchAll(/async (assertEndpoint\w*)\(/g)].map((m) => m[1]);
  check('assertEndpointInScope is the only per-computer scope check', JSON.stringify(variants) === JSON.stringify(['assertEndpointInScope']),
    `found: ${variants.join(', ')} — a weaker variant needs its own review and its own invariant`);
  const adminCtl = read('apps/api/src/admin/admin.controller.ts');
  const adminSvc = read('apps/api/src/admin/admin.service.ts');
  const hasSearch = /@Get\('search'\)/.test(adminCtl);
  const searchFn = adminSvc.slice(adminSvc.indexOf('async search('), adminSvc.indexOf('async search(') + 4000);
  check('GET /admin/search is gone, or scopes computers with endpointVisibilityWhere',
    !hasSearch || (/async search\(/.test(adminSvc) && /this\.acl\.endpointVisibilityWhere\(actor/.test(searchFn)),
    'admin search must not filter computers by business scope alone');
}

// 27. Enrolment step-up (0.33). An enrolment token puts a machine of the
//     holder's choosing into a business, so a session alone must not mint
//     one: a person needs a fresh re-authentication, whatever their role
//     (assertFresh with its own catalog key, enrollment.create — 0.49 made
//     every step-up configurable per key at the owner's request, § 62, so
//     turning other keys off never turns this one off). An API key cannot step up and keeps
//     the ability, so minting a key needs the same fresh re-authentication
//     (0.33: keys carrying enrollment:write; 0.34: every key, § 34). Every
//     caller must say which proof it has; nothing else writes a
//     DeviceClaimToken. Registering by RustDesk ID mints no credential and so
//     is not gated.
{
  const enr = read('apps/api/src/enrollment/enrollment.service.ts');
  const ctl = read('apps/api/src/enrollment/enrollment.controller.ts');
  const pub = read('apps/api/src/public-api/public-api.controller.ts');
  const rev = read('apps/api/src/security-controls/review.ts');
  const mintFn = enr.slice(enr.indexOf('async createClaimToken('), enr.indexOf('async listClaimTokens('));
  check('assertFresh refuses a missing method unless the confirm policy has its key off',
    // 0.49: the one exception is a catalog key a Platform Admin set to 'off' (§ 62).
    /export function assertFresh\(method: string \| null,[^)]*\) \{\s*if \(!opts\.phishingResistant && !confirmRequired\(opts\.action\)\) return;\s*if \(!method\) \{\s*throw new ForbiddenException\(\{\s*code: 'STEP_UP_REQUIRED'/.test(rev),
    'review.ts: assertFresh must throw STEP_UP_REQUIRED whenever method is null; the only skip is confirmRequired(action) being false');
  check('createClaimToken demands a mint proof and checks it before the token is written',
    /async createClaimToken\(actor: ActorContext, dto: [^)]*\}, auth: TokenMintAuth\)/.test(mintFn)
      && /export type TokenMintAuth =\s*\| \{ via: 'session'; freshMethod: string \| null \}\s*\| \{ via: 'api-key'; apiKeyId: string \| undefined \};/.test(enr)
      && /if \(auth\.via === 'session'\) \{\s*assertFresh\(auth\.freshMethod, \{\s*action: 'enrollment\.create'/.test(mintFn)
      && /\} else if \(!auth\.apiKeyId\) \{\s*throw new ForbiddenException/.test(mintFn)
      && mintFn.indexOf('assertFresh(auth.freshMethod') !== -1
      && mintFn.indexOf('assertFresh(auth.freshMethod') < mintFn.indexOf('deviceClaimToken.create(')
      && mintFn.indexOf('assertFresh(auth.freshMethod') > mintFn.indexOf('this.acl.requireScope(actor'),
    'session → assertFresh (after scope, before the create); api-key → refused without a key id');
  const writers = walk('apps/api/src').filter((f) => !f.endsWith('.spec.ts') && /deviceClaimToken\.(create|createMany|upsert)\(/.test(read(f)));
  const callers = walk('apps/api/src').filter((f) => !f.endsWith('.spec.ts') && /\.createClaimToken\(/.test(read(f)));
  check('only createClaimToken writes a new DeviceClaimToken, and only the two known routes call it',
    writers.length === 1 && writers[0].endsWith('enrollment/enrollment.service.ts') && (enr.match(/deviceClaimToken\.create\(/g) ?? []).length === 1
      && callers.length === 2 && callers.some((f) => f.endsWith('enrollment/enrollment.controller.ts')) && callers.some((f) => f.endsWith('public-api/public-api.controller.ts')),
    `writers: ${writers.join(', ')}; callers: ${callers.join(', ')} — a new mint path needs its own step-up decision here`);
  check('the console route passes the step-up it read; the public route passes the API key',
    /const freshMethod = u\?\.sub \? this\.stepUp\.read\(req, u\.sub, u\.iat\)\?\.method \?\? null : null;\s*const token = await this\.enrollment\.createClaimToken\(actor, dto, \{ via: 'session', freshMethod \}\);/.test(ctl)
      && /\{ via: 'api-key', apiKeyId: this\.apiKeyMeta\(req\)\.apiKeyId \},\s*\);/.test(pub)
      && /@Controller\('pub\/v1'\)\s*@Public\(\)\s*@UseGuards\(ApiKeyAuthGuard\)/.test(pub),
    'enrollment.controller must read StepUpService; public-api must sit behind ApiKeyAuthGuard and pass apiKeyId');
  const keys = read('apps/api/src/apikeys/apikeys.service.ts');
  const keysCtl = read('apps/api/src/apikeys/apikeys.controller.ts');
  const keyFn = keys.slice(keys.indexOf('async create('), keys.indexOf('async revoke('));
  check('a key that can mint enrolment tokens needs a fresh re-authentication to create (every key does since 0.34, § 34)',
    /\n    assertFresh\(freshMethod, \{\s*action: 'apikey\.create',/.test(keyFn)
      && keyFn.indexOf('assertFresh(freshMethod') < keyFn.indexOf('apiKey.create(')
      && /this\.stepUp\.read\(req, u\.sub, u\.iat\)\?\.method \?\? null : null;\s*return \{ success: true, data: await this\.svc\.create\(actor, dto, freshMethod\) \};/.test(keysCtl),
    'ApiKeysService.create must assertFresh before writing; the controller passes the step-up');
  const eps = read('apps/api/src/endpoints/endpoints.service.ts');
  check('registering by RustDesk ID mints no credential (which is why it is not gated)',
    /rustdeskNode: \{ create: \{ tenantId: business\.tenantId, rustdeskId: dto\.rustdeskId, platform: dto\.platform \} \},/.test(eps)
      && /if \(dto\.rustdeskId\) \{\s*this\.acl\.assertPlatformAdmin\(actor\);/.test(eps),
    'the node created by ID must carry no secret or password, and stay Platform Admin only — if it ever mints one, gate it');
  check('the enrolment step-up suite runs in CI', /\benrol-stepup\b/.test(read('scripts/run-e2e.sh')), 'add e2e-enrol-stepup to run-e2e.sh');
}

// 28. Global search (0.33). A search result is a disclosure like a list row,
//     so every group starts from its own list route's where builder — the
//     device list's scopedWhere (visibility AND-ed), GET /businesses' and
//     GET /sites' listWhere, GET /users' memberWhere, the alerts list's
//     alertWhere — with the match AND-ed onto it, and is gated by that list's
//     capability. The list routes use the same builders, so the two cannot
//     drift. Results name no secret; searches are throttled, not audited and
//     not logged; query text reaches LIKE only escaped.
{
  const code = (s) => s.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
  const svc = code(read('apps/api/src/search/search.service.ts'));
  const ctl = code(read('apps/api/src/search/search.controller.ts'));
  const qry = read('apps/api/src/search/query.ts');
  const fn = (name) => { const i = svc.indexOf(`private async ${name}(`); return i < 0 ? '' : svc.slice(i, svc.indexOf('\n  }\n', i)); };
  const comp = fn('computers'), biz = fn('businessGroup'), site = fn('siteGroup'), usr = fn('userGroup'), alr = fn('alertGroup');
  check('search: each group starts from its list route\'s where builder, with the match AND-ed onto it',
    /where: \{ AND: \[this\.devices\.scopedWhere\(actor, \{ status: 'current' \}\), match\] \}/.test(comp)
      && /where: this\.businesses\.listWhere\(actor, likeEscape\(q\)\)/.test(biz)
      && /where: \{ AND: \[this\.sites\.listWhere\(actor\), \{ OR: /.test(site)
      && /AND: \[\s*this\.users\.memberWhere\(actor\),/.test(usr)
      && /where: \{ AND: \[this\.monitoring\.alertWhere\(actor\), /.test(alr)
      && !/\.\.\.\s*this\.(acl|devices|businesses|sites|users|monitoring)\./.test(svc) && !/endpointVisibilityWhere|businessWhere|resolveScope/.test(svc),
    'computers: AND [scopedWhere, match]; businesses: listWhere; sites/users/alerts: AND [builder, …]; no builder spread, no hand-written scope');
  check('search: phase two reads only the ids phase one returned',
    /const ids = found\.map\(\(r\) => r\.id\);/.test(comp) && /FROM unnest\(\$\{ids\}::text\[\]\) AS u\(id\)/.test(comp)
      && (comp.match(/FROM "Endpoint"/g) ?? []).length === 0 && (comp.match(/JOIN "Endpoint" e ON e\.id = (u|k)\.id/g) ?? []).length === 2
      && /SELECT \* FROM ranked ORDER BY/.test(comp) && /FROM kept k/.test(comp),
    'the ranked SQL must start from unnest(ids) and the output from kept rows only');
  check('search: the list routes use the same builders',
    /where: this\.listWhere\(actor, search \? likeEscape\(search\) : undefined\),/.test(read('apps/api/src/businesses/businesses.service.ts'))
      && /where: this\.listWhere\(actor, businessId\),/.test(read('apps/api/src/sites/sites.service.ts'))
      && /where: this\.memberWhere\(actor, businessId\),/.test(read('apps/api/src/users/users.service.ts'))
      && /const scoped = this\.scopedWhere\(actor, \{ status: q\.status \}\);[\s\S]{0,200}where: scoped,/.test(read('apps/api/src/endpoints/endpoint-list.service.ts')),
    'GET /businesses, /sites, /users and the device list must build their where with the builders search uses');
  {
    // 0.33: the list routes' own searches escape too, with the same helper —
    // before, GET /endpoints?search=% (or _) matched every computer in scope.
    const eps = read('apps/api/src/endpoints/endpoints.service.ts');
    const lst = read('apps/api/src/endpoints/endpoint-list.service.ts');
    const term = eps.slice(eps.indexOf('const term = params.search'), eps.indexOf('const where = { AND: [visibility, filters] };'));
    check('search: GET /businesses, GET /endpoints and the device list escape LIKE metacharacters in a search',
      /const term = params\.search \? likeEscape\(params\.search\) : undefined;/.test(eps) && !/contains: params\.search/.test(eps)
        && (term.match(/contains: term,/g) ?? []).length === 6
        && /const c = \{ contains: likeEscape\(f\.search\), mode: 'insensitive' as const \};/.test(lst) && /const c = \{ contains: likeEscape\(f\.os\), mode: 'insensitive' as const \};/.test(lst)
        && !/contains: [qf]\.(search|os)/.test(lst)
        && [eps, lst, read('apps/api/src/businesses/businesses.service.ts')].every((src) => /import \{ likeEscape \} from '\.\.\/common\/like';/.test(src)),
      'every user-typed contains: on those routes must go through common/like.ts likeEscape');
  }
  check('search: each group is gated by its list page\'s capability',
    /computers: 'computers:view',\s*businesses: null,\s*sites: 'computers:view',\s*users: 'users:view',\s*alerts: 'monitoring:alerts',/.test(qry)
      && /return this\.acl\.can\(actor, GROUP_CAPABILITY\[group\]\);/.test(svc)
      && /^\s*if \(!this\.allowed\(actor, 'computers'\)\) return null;/m.test(comp) && /^\s*if \(!this\.allowed\(actor, 'sites'\)\) return null;/m.test(site)
      && /^\s*if \(!this\.allowed\(actor, 'users'\)\) return null;/m.test(usr)
      && /catch \(e\) \{ if \(e instanceof ForbiddenException\) return null; throw e; \}/.test(svc)
      && ['computers', 'businessGroup', 'siteGroup', 'userGroup', 'alertGroup'].every((g) => new RegExp(`gated\\(\\(\\) => this\\.${g}\\(actor, q\\)\\)`).test(svc)),
    'GROUP_CAPABILITY must name computers:view / none / computers:view / users:view / monitoring:alerts, and each group must check it (alerts through alertWhere)');
  const containsArgs = [...svc.matchAll(/contains: ([^,}]+)/g)].map((m) => m[1].trim());
  check('search: query text reaches LIKE only escaped',
    containsArgs.length >= 6 && containsArgs.every((a) => /^likeEscape\((q|t)\)$/.test(a)) && /listWhere\(actor, likeEscape\(q\)\)/.test(biz)
      && /ILIKE \$\{p\.contains\}/.test(comp) && !/ILIKE \$\{q\}|LIKE '%' \|\|/.test(svc)
      && /export \{ likeEscape \};/.test(qry) && /import \{ likeEscape \} from '\.\.\/common\/like';/.test(qry)
      && /return s\.replace\(\/\[\\\\%_\]\/g, \(c\) => `\\\\\$\{c\}`\);/.test(read('apps/api/src/common/like.ts')),
    `every contains: must be likeEscape(q|t) (got ${containsArgs.join(', ')}); raw SQL only through likePatterns`);
  check('search: results name no secret, hash, token or credential',
    !/passwordHash|permanentPassword|agentSecretHash|hasPassword|mfa|totp|secret|token|apiKey|capabilities:/i.test(svc),
    'nothing secret may be selected or returned by SearchService');
  const filt = read('apps/api/src/common/filters/global-exception.filter.ts');
  check('search: one GET route, throttled, not audited, never logs the query',
    (ctl.match(/@(Get|Post|Put|Patch|Delete)\(/g) ?? []).length === 1 && /@Get\(\)\s*@RateLimit\(SEARCH_RATE_LIMIT\)/.test(ctl)
      && /export const SEARCH_RATE_LIMIT = (\d+);/.test(ctl) && Number(/SEARCH_RATE_LIMIT = (\d+)/.exec(ctl)?.[1]) <= 120
      && /@Controller\('search'\)\s*@UseGuards\(JwtAuthGuard\)/.test(ctl) && /parseSearchQuery\(q\)/.test(ctl)
      && ![svc, ctl].some((s) => /AuditService|audit\.|Logger|console\./.test(s))
      && /const logged = SEARCH_PATH\.test\(request\.path \?\? ''\) \? request\.path : request\.url;/.test(filt) && /\$\{request\.method\} \$\{logged\} →/.test(filt),
    'GET /search only, @RateLimit ≤ 120/min, JWT, parsed q; no audit or logger in search; the 5xx log line drops its query string');
  const others = walk('apps/api/src').filter((f) => /controller\.ts$/.test(f) && f !== 'apps/api/src/search/search.controller.ts')
    .filter((f) => /@Get\(\s*'[^']*\bsearch\b[^']*'\s*\)/.test(read(f)));
  check('search: there is one search route — /admin/search (business-only scoping) stays removed', others.length === 0, `search routes in: ${others.join(', ')}`);
}

// 29. Device groups, saved views and bulk actions (0.33). A bulk request is
//     only the four repeatable actions, capped at 200, every computer found
//     through the visibility rule AND-ed and decided by the single action's
//     own path; group and shared-view writes need manageRefusal (a Business
//     User never, a technician only with computers:edit over the whole
//     business); a group holds only its own business's computers wherever a
//     computer gets one; a view stores list parameters and nothing runs it.
{
  const dir = 'apps/api/src/device-views';
  const code = (s) => s.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
  const rules = read(`${dir}/rules.ts`);
  const bulkSvc = read(`${dir}/device-bulk.service.ts`);
  const groupSvc = read(`${dir}/device-groups.service.ts`);
  const viewSvc = read(`${dir}/saved-views.service.ts`);
  const ctl = read(`${dir}/device-views.controller.ts`);
  const listSvc = read('apps/api/src/endpoints/endpoint-list.service.ts');
  const listQuery = read('apps/api/src/endpoints/list-query.ts');

  // 0.34 adds agent.update and agent.migrate, through AgentUpgradeService (§ 43).
  // 0.54 adds restart.schedule, through RestartBulkService (§ 67): each computer
  // is the Actions tab's own request, and this service still names no plan.
  check('bulk: exactly seven repeatable actions, and nothing that connects, archives, deletes or runs an action itself',
    /export const BULK_ACTIONS = \['group\.add', 'group\.remove', 'inventory\.refresh', 'client\.update', 'agent\.update', 'agent\.migrate', 'restart\.schedule'\] as const;/.test(rules)
      && !/\b(authorizeConnect|connect\(|archive|restore\(|\.delete\(|deleteMany|ActionsService|actionJob|createPlan|SignerClient|scriptVersion)\b/i.test(code(bulkSvc).replace(/this\.prisma\.endpointGroupMember\.deleteMany\(\{ where: \{ endpointGroupId: g\.id, endpointId: t\.id \} \}\)/g, '')),
    'BULK_ACTIONS must stay the seven, and the bulk service must not reach connect/archive/delete/approved actions');
  check('bulk: at most 200 per request, counted before de-duplication, for the export too',
    /export const BULK_MAX = 200;/.test(rules)
      && /if \(ids\.length > BULK_MAX\) throw bad\('BULK_TOO_LARGE'/.test(rules) && rules.indexOf('ids.length > BULK_MAX') < rules.indexOf('[...new Set(ids as string[])]')
      && /const endpointIds = byGroup \? undefined : parseSelection\(body\.endpointIds\);/.test(rules) && /const ids = parseSelection\(body\.endpointIds\);/.test(bulkSvc),
    'parseSelection must cap the raw list; parseBulk and exportSelection must both use it');
  check('bulk: every computer is found through the visibility rule, AND-ed, and anything else is NOT_FOUND',
    /where: \{ AND: \[this\.acl\.endpointVisibilityWhere\(a\), \{ id: \{ in: ids \} \}\] \}/.test(bulkSvc)
      && /if \(!seen\.has\(id\)\) results\.set\(id, \{ endpointId: id, ok: false, code: 'NOT_FOUND', reason: 'Computer not found' \}\);/.test(bulkSvc)
      && !/\.\.\.\s*this\.acl\.endpointVisibilityWhere/.test(bulkSvc + groupSvc + viewSvc)
      && (code(bulkSvc).match(/this\.prisma\.endpoint\.findMany\(/g) ?? []).length === 1,
    'visible() must AND endpointVisibilityWhere with the ids, and be the only endpoint read');
  check('bulk: refresh is the single route’s own call; client update is Platform Admin, containment-checked, staged by the one-click path',
    /await this\.endpoints\.requestInventoryRefresh\(a, t\.id\);/.test(bulkSvc)
      && /if \(!a\.isPlatformAdmin\) \{/.test(bulkSvc) && bulkSvc.indexOf('if (!a.isPlatformAdmin) {') < bulkSvc.indexOf("this.containment.blocking('updates', t.customerId)")
      && /if \(pause\) \{ results\.set\(t\.id, \{ \.\.\.base, ok: false, code: 'CONTAINED'/.test(bulkSvc)
      && /await this\.updates\.requestRustdeskUpdate\(stage\.map\(\(t\) => t\.id\), /.test(bulkSvc)
      && !/rustdeskNode\.(update|updateMany)\(/.test(bulkSvc),
    'no bulk path may write a RustDesk request itself or skip the admin/containment checks');
  check('bulk: the fleet budget only refuses — every computer it lets through is still admitted by the guard',
    /const limit = budget\.wouldExceed\(t\.id, t\.customerId, controls\.thresholds\[this\.policy\.tierFor\(a, t\.id\)\]\);\s*if \(limit\) \{/.test(bulkSvc)
      && bulkSvc.indexOf('budget.admitted(t.id, t.customerId)') > bulkSvc.indexOf('await this.endpoints.requestInventoryRefresh(a, t.id);')
      && !/abuse\.admit|privilegedActivity\.create/.test(bulkSvc),
    'FleetBudget may refuse before the guard, never admit in its place');

  const refusal = rules.slice(rules.indexOf('export function manageRefusal('), rules.indexOf('// ── Saved views'));
  check('groups and shared views: a technician needs computers:edit on the whole business; a Business User never',
    /if \(a\.technician\) \{[\s\S]*?a\.technician\.businessId !== customerId[\s\S]*?\.includes\(CAP\.COMPUTERS_EDIT\) && s\.endpointIds === null\)/.test(refusal)
      && /if \(a\.businessId !== customerId\) return [^;]+;\s*if \(isOwnerRole\(a\.roleType\)\) return null;\s*return '[^']+';\s*\}/.test(refusal),
    'manageRefusal must mirror the client-update rule');
  check('groups: every write checks manageRefusal first, and a member must be in the group’s business',
    /async create\(a: ActorContext, raw: unknown\) \{[\s\S]{0,900}const why = manageRefusal\(a, customerId\);\s*if \(why\) throw new ForbiddenException/.test(groupSvc)
      && /const g = await this\.findManageable\(a, id\);/.test(groupSvc.slice(groupSvc.indexOf('async update('))) && /const g = await this\.findManageable\(a, id\);/.test(groupSvc.slice(groupSvc.indexOf('async remove(')))
      && /const why = manageRefusal\(a, g\.customerId\);/.test(bulkSvc)
      && /const step = membershipStep\(action, t, group, members\.has\(t\.id\), why\);\s*if \(step\.kind === 'refuse'\)/.test(bulkSvc)
      && /if \(refusal\) return \{ kind: 'refuse', code: 'NOT_ALLOWED'/.test(rules) && /if \(t\.customerId !== group\.customerId\) return \{ kind: 'refuse', code: 'OTHER_BUSINESS'/.test(rules),
    'create/update/remove and bulk membership must check manageRefusal and the business (membershipStep); the 0049 trigger backs the insert (§ 34)');
  check('groups: another business’s group is a 404',
    /if \(!g\.customerId \|\| g\.customerId !== a\.businessId\) throw new NotFoundException\('Group not found'\);/.test(groupSvc), 'findVisible must compare the business');
  const eps = read('apps/api/src/endpoints/endpoints.service.ts');
  const enr = read('apps/api/src/enrollment/enrollment.service.ts');
  check('a computer gets only its own business’s group: creation, enrolment tokens, claims (moving business: § 34’s trigger)',
    /if \(dto\.endpointGroupId\) await this\.assertGroupFor\(dto\.endpointGroupId, businessId, business\.tenantId\);/.test(eps)
      && /where: \{ id: groupId, OR: \[\{ customerId: businessId \}, \{ customerId: null, tenantId \}\] \}/.test(eps)
      && /where: \{ id: dto\.endpointGroupId, OR: \[\{ customerId: businessId \}, \{ customerId: null, tenantId: business\.tenantId \}\] \}/.test(enr)
      && /groupMemberships: \{ create: \{ endpointGroupId: groupId \} \}/.test(enr) && /data: \[\{ endpointGroupId: groupId, endpointId: endpoint\.id \}\]/.test(enr)
      && !/endpointGroupId: record\.endpointGroupId/.test(enr.replace(/where: \{ id: record\.endpointGroupId,/, '')),
    'create, token minting and claim must all tie the group to the business; the claim uses the re-checked groupId, never the token\'s raw id');
  const views = [...ctl.matchAll(/@(Get|Post|Put|Patch|Delete)\(\s*(?:'([^']*)')?\s*\)/g)].map((m) => `${m[1].toUpperCase()} ${m[2] ?? ''}`);
  const handlers = ctl.split(/\n  @(?:Get|Post|Put|Patch|Delete)\(/).slice(1);
  check('views and groups: every route names its capability, no route runs a view, bulk has two routes',
    JSON.stringify(views) === JSON.stringify(['GET ', 'GET :id', 'POST ', 'PATCH :id', 'DELETE :id', 'GET ', 'POST ', 'PATCH :id', 'DELETE :id', 'POST ', 'POST export.csv'])
      && handlers.length === 11 && handlers.every((h) => /^[^\n]*\)\s*\n\s*@RequireCapability\(CAP\.(COMPUTERS_VIEW|COMPUTERS_EDIT)\)/.test(h))
      && /@Controller\('device-views'\)/.test(ctl) && /@Controller\('device-groups'\)/.test(ctl) && /@Controller\('endpoints\/bulk'\)/.test(ctl),
    `routes: ${views.join(', ')}`);
  check('views store list parameters only, parsed by the list’s own parser; nothing in the view service reads computers',
    /const unknown = Object\.keys\(raw\)\.filter\(\(k\) => !\(LIST_FILTER_KEYS as readonly string\[\]\)\.includes\(k\)\);\s*if \(unknown\.length\) throw bad/.test(rules)
      && /const out: StoredFilters = storedForm\(parseListFilters\(asQuery\)\);/.test(rules)
      && /export const ViewUpdate = z\.object\(viewFields\)\.partial\(\)\.strict\(\);/.test(rules) && !/shared|businessId/.test(rules.slice(rules.indexOf('const viewFields = {'), rules.indexOf('export const ViewInput')))
      && !/this\.prisma\.endpoint\./.test(viewSvc) && /if \(f\.businessId && f\.businessId !== customerId\) \{/.test(viewSvc),
    'normalizeViewFilters must refuse unknown keys and use the list’s parseListFilters; updates cannot change who a view is for; shared filters stay in the business');
  check('a personal view is its author’s alone; a shared view is its business’s',
    /if \(!v\.shared\) \{\s*if \(v\.userId !== a\.userId\) throw new NotFoundException/.test(viewSvc)
      && /if \(!v\.customerId \|\| !\(a\.isPlatformAdmin \|\| v\.customerId === a\.businessId\)\) throw new NotFoundException/.test(viewSvc)
      && /const why = manageRefusal\(a, v\.customerId!\);/.test(viewSvc) && /const why = manageRefusal\(a, customerId\);\s*if \(why\) throw new ForbiddenException\(\{ code: 'NOT_ALLOWED', message: why \}\);\s*await this\.assertFiltersInBusiness/.test(viewSvc),
    'findVisible must 404 other people’s and other businesses’ views; shared writes need manageRefusal');
  check('the selection export is the list’s audited export with the selection AND-ed; no query string can set it',
    /const out = await this\.list\.exportCsv\(a, q\);/.test(bulkSvc) && /if \(q\.ids\) and\.push\(\{ id: \{ in: q\.ids \} \}\);/.test(listSvc)
      && !/\bids:/.test(listQuery.slice(listQuery.indexOf('export function parseListQuery('))),
    'exportSelection must call exportCsv; filteredWhere must AND ids; parseListQuery must never set ids');
  check('group, shared-view and bulk changes are audited',
    ['DEVICE_GROUP_CREATED', 'DEVICE_GROUP_UPDATED', 'DEVICE_GROUP_DELETED'].every((x) => groupSvc.includes(`action: '${x}'`))
      && bulkSvc.includes("action: 'DEVICE_GROUP_MEMBERS_CHANGED'") && bulkSvc.includes("action: 'DEVICE_BULK_ACTION'") && viewSvc.includes("action: 'DEVICE_VIEW_SHARED_CHANGED'")
      && /if \(v\.shared\) await this\.auditShared\(a, v, 'created', null\);/.test(viewSvc) && /if \(v\.shared\) await this\.auditShared\(a, v, 'updated', before\);/.test(viewSvc) && /if \(v\.shared\) await this\.auditShared\(a, v, 'deleted', v\);/.test(viewSvc)
      && /await this\.auditBulk\(a, input\.action, targets, ordered, group, target\);/.test(bulkSvc),
    'every write path must write its audit entry');
}

// 30. Metric history (0.33). History is evidence a technician reads, so only
//     the device may write it: a sample comes only from the heartbeat's
//     authenticated branch, from the values recordLiveState sanitised, and a
//     per-volume sample only from the sanitised disk list of an inventory pass
//     (a command result, which requires the device secret). Nothing else in
//     the API writes either. The read route names computers:view and scopes
//     with assertEndpointInScope AND endpointVisibilityWhere. The sweep honours
//     METRIC_SWEEP=off, and every pass and retention setting is bounded.
{
  const enr = read('apps/api/src/enrollment/enrollment.service.ts');
  const hb = enr.slice(enr.indexOf('async heartbeat('), enr.indexOf('async monitorReport('));
  const authBlock = hb.match(/if \(authenticated\) \{\n(?:\s*\/\/[^\n]*\n)*\s*try \{\n\s*const live = await this\.inventory\.recordLiveState\(node\.endpointId, \{[\s\S]*?\}\);\n([\s\S]*?)commands = await this\.inventory\.collectForHeartbeat/);
  check('a heartbeat writes metric history only inside its authenticated branch, from recordLiveState\'s sanitised values',
    !!authBlock && /await this\.metrics\.recordHeartbeat\(node\.endpointId, live\)/.test(authBlock[1])
      && (hb.match(/this\.metrics\.recordHeartbeat\(/g) ?? []).length === 1,
    'enrollment.service heartbeat(): metrics.recordHeartbeat(node.endpointId, live) must sit between recordLiveState and collectForHeartbeat inside `if (authenticated) {`');
  const inv = read('apps/api/src/endpoint-inventory/endpoint-inventory.service.ts');
  const ri = inv.slice(inv.indexOf('async recordInventory('), inv.indexOf('async recordUpdateScan('));
  check('per-volume history comes only from an inventory pass\'s sanitised disk list',
    /disks: this\.sanitizeDisks\(r\.disks\)/.test(ri) && /await this\.metrics\.recordDisks\(endpointId, data\.disks\)/.test(ri),
    'recordInventory must pass data.disks (sanitizeDisks output) to metrics.recordDisks');
  const writers = walk('apps/api/src').filter((f) => !f.startsWith('apps/api/src/metrics/'))
    .filter((f) => /\.(recordHeartbeat|recordDisks)\(|endpointMetricSample\.(create|update|upsert)|endpointDiskSample\.(create|update|upsert)|endpointMetricHourly\.(create|update|upsert)|"EndpointMetric(Sample|Hourly)"|"EndpointDiskSample"/.test(read(f)));
  check('nothing outside the heartbeat and the inventory pass writes metric history',
    JSON.stringify(writers.sort()) === JSON.stringify(['apps/api/src/endpoint-inventory/endpoint-inventory.service.ts', 'apps/api/src/enrollment/enrollment.service.ts']),
    `writers: ${writers.join(', ')}`);
  const ms = read('apps/api/src/metrics/metrics.service.ts');
  const mc = read('apps/api/src/metrics/metrics.controller.ts');
  const hist = ms.slice(ms.indexOf('async history('), ms.indexOf('private async diskHistory('));
  check('the history route names computers:view and is scoped and visibility-filtered',
    /@Get\(':id\/metrics'\)\s*@RequireCapability\(CAP\.COMPUTERS_VIEW\)/.test(mc) && /@UseGuards\(JwtAuthGuard, CapabilitiesGuard\)/.test(mc)
      && /await this\.acl\.assertEndpointInScope\(actor, endpointId, CAP\.COMPUTERS_VIEW\)/.test(hist)
      && /where: \{ AND: \[this\.acl\.endpointVisibilityWhere\(actor\), \{ id: endpointId \}\] \}/.test(hist)
      && /if \(!ep\) throw new NotFoundException/.test(hist),
    'MetricsController GET :id/metrics needs computers:view; history() must assertEndpointInScope and AND endpointVisibilityWhere, 404 otherwise');
  const mm = read('apps/api/src/metrics/metrics-math.ts');
  const lim = (k) => Number((mm.match(new RegExp(`${k}: \\{ def: \\d+, min: \\d+, max: ([\\d_]+) \\}`)) ?? [])[1]?.replace(/_/g, ''));
  check('the metric sweep honours METRIC_SWEEP=off and every pass and retention is bounded',
    /if \(process\.env\.METRIC_SWEEP === 'off'\) return;/.test(ms) && (ms.match(/LIMIT \$\{this\.cfg\.rollupHoursPerPass\}/g) ?? []).length === 2
      && (ms.match(/LIMIT \$\{n\}\)\)/g) ?? []).length === 3
      && lim('rawHours') <= 168 && lim('hourlyDays') <= 400 && lim('rollupHoursPerPass') <= 48 && lim('pruneBatch') <= 50000 && lim('pruneBatches') <= 100
      && /Math\.min\(lim\.max, Math\.max\(lim\.min,/.test(mm)
      && /at: \{ gt: new Date\(now\.getTime\(\) - this\.cfg\.minIntervalSeconds \* 1000\) \}/.test(ms),
    'onModuleInit must return on METRIC_SWEEP=off; roll-up and the three prunes LIMITed; METRIC_LIMITS ceilings finite and applied; one sample per minIntervalSeconds');
}

// 31. System inventory snapshots (0.33): process list, full service list and
//     network adapter details. They ride the diagnostics catalog (§20) — a
//     key, the authenticated heartbeat, the device-secret result — and add
//     no channel. The agent's snapshot functions only call Get-* cmdlets
//     (plus Sort-Object / Select-Object), never read command lines, binary
//     paths, modules or the environment, and put every string through a
//     charset helper; a build-time guard refuses the script otherwise. The
//     server bounds rows and bytes, drops what the charsets refuse, keeps
//     results out of the history, scopes every diagnostics read by the
//     device-list visibility rule, and the workspace tabs write only a
//     Refresh (0.45: their controls are approved actions, § 60).
{
  const ws = read('apps/api/src/public/windows-script.ts');
  // The template's own copy (column 0), not the guard's SNAPSHOT_BLOCK_START constant.
  const start = ws.indexOf('\n# ---- Snapshots (0.33): processes, services, network adapters');
  const blk = ws.slice(start, ws.indexOf('if (\\$state.agentSecret -and \\$resp -and \\$resp.data -and \\$resp.data.diagnostics) {', start));
  const code = blk.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');
  const cmds = [...new Set([...code.matchAll(/\b[A-Z][a-z]+-[A-Z][A-Za-z0-9]+\b/g)].map((m) => m[0]))];
  check('the snapshot functions call only Get-* cmdlets (and Sort-Object / Select-Object)',
    start > 0 && code.length > 4000 && cmds.length > 0 && cmds.every((c) => /^(Get-[A-Za-z0-9]+|Sort-Object|Select-Object)$/.test(c)),
    `commands: ${cmds.join(', ')}`);
  check('the snapshot functions run no expression, script block or process, and read no command line, path, module or environment',
    !/Invoke-|\biex\b|\[scriptblock\]|\.Invoke\(|\.Create\(|&\s*[\\$'"({]|Add-Type|New-Object|Start-|PathName|CommandLine|ExecutablePath|MainModule|\.Modules\b|\.Path\b|\\\$env:/i.test(code),
    'Get-Process / Win32_Service / Win32_NetworkAdapter[Configuration] fields only');
  check('every snapshot string goes through a charset helper',
    /\\\$t = \(\(\[string\]\\\$v\) -replace '\[\\\\x00-\\\\x1f\\\\x7f\]', ' '\)\.Trim\(\)/.test(code)
      && /if \(\\\$null -eq \\\$t -or \\\$t -notmatch \\\$re\) \{ return \\\$null \}/.test(code)
      && !/= \[string\]\\\$(pr|s|a|c)\./.test(code.replace(/\[string\]\\\$s\.StartMode/g, '').replace(/\(\[string\]\\\$s\.State\)/g, '')),
    'Get-Rem0teSnapText strips control characters and clamps; Get-Rem0teSnapMatch drops a value failing its charset; no raw [string] field');
  check('a build-time guard refuses an unsafe snapshot block, on both installer variants',
    (ws.match(/return assertSnapshotBlockSafe\(template\(v, /g) ?? []).length === 2
      && /const SNAP_ALLOWED_COMMANDS = \/\^\(Get-\[A-Za-z0-9\]\+\|Sort-Object\|Select-Object\)\$\/;/.test(ws)
      && /const SNAP_FORBIDDEN = \/Invoke-\|\\biex\\b/.test(ws) && /PathName\|CommandLine\|ExecutablePath\|MainModule/.test(ws),
    'buildLegacyWindowsScript and buildSignedWindowsScript must return assertSnapshotBlockSafe(template(...))');
  check('the snapshot functions run only from the catalog switch',
    /'process_list' \{ \\\$out = Get-Rem0teSnapProcesses \}/.test(ws) && /'service_list' \{ \\\$out = Get-Rem0teSnapServices \}/.test(ws) && /'network_adapters' \{ \\\$out = Get-Rem0teSnapNetwork \}/.test(ws)
      && (ws.match(/Get-Rem0teSnap(Processes|Services|Network)\b/g) ?? []).length === 6,
    'each defined once and called once, from switch -Exact ($dk)');
  const cat = read('apps/api/src/diagnostics-catalog/catalog.ts');
  const caseOf = (k) => cat.slice(cat.indexOf(`case '${k}':`), cat.indexOf('case ', cat.indexOf(`case '${k}':`) + 10));
  check('snapshot results are bounded in rows and bytes, with a database backstop',
    /export const SNAPSHOT_ROWS = \{ process_list: 1000, service_list: 1000, network_adapters: 32 \} as const;/.test(cat)
      && /export const MAX_SNAPSHOT_BYTES = 131_072;/.test(cat)
      && /return isSnapshotKey\(key\) \? MAX_SNAPSHOT_BYTES : MAX_RESULT_BYTES;/.test(cat)
      && /THEN 262144 ELSE 65536 END/.test(read('apps/api/prisma/migrations/0042_system_inventory/migration.sql')),
    '1000/1000/32 rows, 128 KB stored, 256 KB CHECK');
  check('the snapshot sanitizers keep no command line, path or binary, and check accounts, MACs and addresses',
    ['process_list', 'service_list', 'network_adapters'].every((k) => !/commandLine|pathName|binaryPath|\.path\b|modules|environment/i.test(caseOf(k)))
      && /user: u && ACCOUNT_RE\.test\(u\)/.test(caseOf('process_list')) && /account: acct && ACCOUNT_RE\.test\(acct\)/.test(caseOf('service_list'))
      && /mac && isMac\(mac\)/.test(caseOf('network_adapters')) && /ipv4: ips\(a\.ipv4, 16\)/.test(caseOf('network_adapters'))
      && /const base = procRow\(p\);/.test(caseOf('process_list')),
    'process names via procRow (path cut), ACCOUNT_RE, isMac, IP_RE');
  const dsvc = read('apps/api/src/diagnostics-catalog/diagnostics-catalog.service.ts');
  const fnOf = (n) => dsvc.slice(dsvc.indexOf(`async ${n}(`), dsvc.indexOf('\n  }\n', dsvc.indexOf(`async ${n}(`)));
  check('every diagnostics read and request is scoped by the device-list visibility rule',
    /const visible = await this\.prisma\.endpoint\.count\(\{ where: \{ AND: \[this\.acl\.endpointVisibilityWhere\(actor\), \{ id: endpointId \}\] \} \}\);\s*if \(!visible\) throw new NotFoundException/.test(dsvc)
      && ['catalogFor', 'request', 'history', 'getRun', 'snapshot'].every((n) => /await this\.assertVisible\(actor, endpointId, /.test(fnOf(n)))
      && (dsvc.match(/this\.acl\.assertEndpointInScope\(/g) ?? []).length === 1,
    'catalogFor, request, history, getRun and snapshot must call assertVisible (business scope AND endpointVisibilityWhere)');
  check('a snapshot read names a snapshot key and its capability; the history leaves snapshot results out',
    /if \(!isSnapshotKey\(key\)\) \{\s*throw new BadRequestException/.test(fnOf('snapshot')) && /const cap = entry\.capability as Capability;/.test(fnOf('snapshot'))
      && /isSnapshotKey\(r\.key\) \? \{ \.\.\.r, result: null, resultOnTab: true \}/.test(fnOf('history'))
      && /@Get\('snapshots\/:key'\)\s*@RequireCapability\(CAP\.COMPUTERS_VIEW\)/.test(read('apps/api/src/diagnostics-catalog/diagnostics-catalog.controller.ts')),
    'UNKNOWN_SNAPSHOT before anything else; resultOnTab in history');
  const tabs = read('apps/web/components/endpoints/workspace/snapshot-tabs.tsx');
  const posts = [...tabs.matchAll(/api\.(post|put|patch|delete)\(([^)]*)\)/g)].map((m) => m[0]);
  // 0.45: the tabs' own writes are still only a Refresh (the button, and
  // Keep refreshing on the Processes tab). Their Start / Stop / Restart /
  // Startup type… and End process go through device-control.tsx, whose only
  // writes are the two approved-action routes and the same Refresh (§ 60).
  const dcUi = read('apps/web/components/endpoints/workspace/device-control.tsx');
  const dcPosts = [...dcUi.matchAll(/api\.(post|put|patch|delete)\(([^,)]*)/g)].map((m) => m[2]);
  check('the Processes, Services and Network tabs write only a Refresh (a catalog key); their controls write only the two approved-action routes',
    posts.length === 2 && /api\.post\(`\/endpoints\/\$\{endpointId\}\/diagnostics\/runs`, \{ key: snapKey \}\)/.test(posts[0]) && /api\.post\(`\/endpoints\/\$\{endpointId\}\/diagnostics\/runs`, \{ key \}\)/.test(posts[1])
      && dcPosts.length === 3 && dcPosts.every((x) => ['`/endpoints/${endpointId}/diagnostics/runs`', '`/endpoints/${endpointId}/services/control`', '`/endpoints/${endpointId}/processes/stop`'].includes(x.trim()))
      && !/dangerouslySetInnerHTML/.test(tabs + dcUi),
    `writes: ${[...posts, ...dcPosts].join(' | ')}`);
}

// 32. The standard macOS agent (0.33). The Linux agent's rules (§ 24, whose
//     shared POSIX parts it must include), plus macOS's own ways to change a
//     machine: it never runs softwareupdate in any form (pending updates come
//     from macOS's own last check, read with defaults read), and never
//     launchctl, shutdown, pmset, systemsetup, defaults write, or plutil
//     other than converting to stdout. It runs as root from /Library/Rem0te
//     with the system PATH, never from /usr/local (admin-writable with
//     Homebrew). The installer writes the secret root-only 0600, adopts a
//     pre-0.33 secret only from a copy root wrote, installs the daemon only
//     as root, and --uninstall removes the daemon, script, config and secret.
//     The console refuses for macOS what it refuses for Linux.
{
  const ma = read('apps/api/src/public/macos-agent.ts');
  const code = shellCode('apps/api/src/public/macos-agent.ts', 'apps/api/src/public/posix-agent.ts');
  const build = ma.slice(ma.indexOf('export function buildMacosAgentScript('), ma.indexOf('}', ma.indexOf('export function buildMacosAgentScript(')));
  check('the macOS agent is assembled with every shared POSIX guard',
    POSIX_PARTS.every((p) => build.includes(p)) && /assemblePosixAgent\('macos'/.test(build),
    `buildMacosAgentScript must include ${POSIX_PARTS.join(', ')}`);
  check('the macOS agent runs no expression, shell, download or state-changing command',
    code.length > 8000
      && !/\beval\b|^\s*\.\s|\bsource\b|\b(sh|bash|dash|zsh) -c\b|\|\s*(sh|bash|dash|zsh)\b|\bwget\b|\bpython3?\b|\bperl\b|\bosascript\b/m.test(code)
      && !/\bsoftwareupdate\b|\blaunchctl\b|(^|[\s;&|(])(reboot|shutdown|halt|pmset|systemsetup|nvram|diskutil|scutil|open|killall|pkill|networksetup|profiles)(\s|;|$)|\binstaller -|\brustdesk\s+--|\bdefaults (write|delete|import|rename)\b/m.test(code)
      && (code.match(/\bplutil\b[^\n]*/g) ?? []).every((l) => /plutil -convert xml1 -o - "\$plist"/.test(l))
      && (code.match(/\bdefaults [a-z]+/g) ?? []).every((l) => l === 'defaults read')
      && (code.match(/\bcurl -/g) ?? []).length === 1,
    'the agent must stay read-only: one curl (in post()), defaults read only, plutil to stdout only, and no softwareupdate at all');
  check('the macOS agent runs with the system PATH only, from /Library/Rem0te',
    /\nPATH=\/usr\/bin:\/bin:\/usr\/sbin:\/sbin\n/.test(code) && !/\/usr\/local/.test(code)
      && /export const MACOS_AGENT_DIR = '\/Library\/Rem0te';/.test(ma) && /const SYSTEM_PATH = '\/usr\/bin:\/bin:\/usr\/sbin:\/sbin';/.test(ma)
      && /<key>PATH<\/key>\s*<string>\$\{SYSTEM_PATH\}<\/string>/.test(ma),
    'PATH fixed in the script and the LaunchDaemon; no /usr/local anywhere (Homebrew makes it admin-writable)');
  check('the macOS agent bounds system_profiler and reads nothing else from the response',
    /bounded "\$TMPD\/sp" system_profiler SPHardwareDataType/.test(code) && (code.match(/system_profiler/g) ?? []).length === 1
      && !/rotate|updateRustdesk|reinstallAgent|confirm-rotation|diagnostic-result|monitor-report/.test(code),
    'system_profiler only through bounded(); no other heartbeat field read');
  const pc = read('apps/api/src/public/public.controller.ts');
  const mac = pc.slice(pc.indexOf('private buildMacosScript('));
  check('the macOS installer writes the secret root-only and adopts an old one only from a root-written copy',
    /AGENT_STATE="\$\{MACOS_AGENT_SECRET\}"/.test(mac) && /\( umask 077; printf '%s' "\\\$\{AGENT_SECRET\}" > "\\\$\{AGENT_STATE\}" \)\n\s*chown root:wheel "\\\$\{AGENT_STATE\}"\n\s*chmod 600 "\\\$\{AGENT_STATE\}"/.test(mac)
      && /\[ ! -L "\\\$\{f\}" \] && \[ "\$\(stat -f '%u %Lp' "\\\$\{f\}" 2>\/dev\/null\)" = "0 600" \]/.test(mac),
    'umask 077, chown root:wheel, chmod 600; a legacy secret only if owner 0, mode 600, not a symlink');
  check('the macOS installer installs the daemon only as root, from a quoted heredoc, and --uninstall removes it all',
    /if \[ "\\\$\{IS_ROOT\}" = 1 \] && \[ -n "\\\$\{HOST_ADDR\}" \]; then/.test(mac) && /<<'\$\{MACOS_AGENT_HEREDOC\}'/.test(mac)
      && /rm -f \$\{MACOS_AGENT_PLIST\} \$\{MACOS_AGENT_NEWSYSLOG\}\n\s*rm -f \$\{MACOS_AGENT_PATH\} \$\{MACOS_AGENT_CONF\} \$\{MACOS_AGENT_SECRET\}/.test(mac)
      && /launchctl bootout system\/\$\{MACOS_AGENT_LABEL\}/.test(mac.slice(0, mac.indexOf('VERSION="'))),
    'agent block under IS_ROOT; --uninstall boots out the daemon and removes the plist, script, config and secret');
  check('the installers survive their own random-string pipelines under pipefail',
    [...pc.matchAll(/< \/dev\/urandom \| head -c \d+[^)\n]*\)/g)].length >= 4
      && [...pc.matchAll(/< \/dev\/urandom \| head -c \d+[^)\n]*\)/g)].every((m) => / \|\| true\)$/.test(m[0])),
    'tr < /dev/urandom | head -c N exits 141 (SIGPIPE) under set -o pipefail: end each with || true');
  const plat = read('apps/api/src/common/platform.ts');
  check('macOS is a read-only agent platform for every console refusal',
    /if \(isMacPlatform\(platform\)\) return 'macOS';/.test(plat) && /'MACOS_AGENT_READ_ONLY'/.test(plat),
    'readOnlyAgentOs must return macOS for a Mac, with its own refusal code');
}

// 33. Data retention (0.34). One sweep ages out operational history; it must
//     never become a way to erase evidence or a live record. The audit chain
//     (ActivityLog, AuditCheckpoint, AuditChainState) is named nowhere in the
//     sweep — its one audit entry per pass is an insert through AuditService —
//     and every statement writes only to an allow-listed table. Every
//     statement names the finished states, so a pending command, an open
//     diagnostic, an OPEN or ACKNOWLEDGED alert, a live session, or a used
//     token or grant (offboarding's evidence of access) is never touched.
//     Every statement is bounded and run through the batch loop.
//     RETENTION_SWEEP=off stops it, and the status route is a Platform Admin
//     read with no way to run or change the sweep.
{
  const svcRaw = read('apps/api/src/retention/retention.service.ts');
  const svc = svcRaw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/\s\/\/ [^\n`]*$/gm, '');
  const policy = read('apps/api/src/retention/retention-policy.ts');
  const ctl = read('apps/api/src/retention/retention.controller.ts');
  const ALLOWED = ['EndpointCommand', 'DiagnosticRun', 'EndpointChange', 'MonitorAlert', 'MonitorAlertEvent', 'SupportSessionEvent', 'LauncherToken', 'ConnectionGrant', 'PrivilegedActivity'];
  const writes = [...svc.matchAll(/\b(DELETE FROM|(?<!FOR )UPDATE|INSERT INTO|TRUNCATE)\s+"?([A-Za-z]+)"?/g)].map((m) => [m[1], m[2]]);
  check('retention: the sweep never names the audit chain, and writes only to allow-listed tables',
    !/ActivityLog|AuditCheckpoint|AuditChainState|activityLog|auditCheckpoint|auditChainState|TRUNCATE|INSERT INTO/i.test(svc)
      && writes.length >= 9 && writes.every(([op, t]) => (op === 'DELETE FROM' || op === 'UPDATE') && ALLOWED.includes(t))
      && !/\$(execute|query)RawUnsafe|\.(delete|deleteMany|update|updateMany|upsert|create|createMany)\(/.test(svc)
      && (svc.match(/this\.audit\.(log|logOrFail)\(/g) ?? []).length === 1 && /action: 'RETENTION_PRUNED'/.test(svc),
    `writes: ${writes.map((w) => w.join(' ')).join(' | ')}; the only audit call is one RETENTION_PRUNED insert`);
  check('retention: the audit log and its checkpoints are evidence the policy never sweeps',
    /key: 'audit', table: 'ActivityLog', label: '[^']+', class: 'evidence', sweep: 'none'/.test(policy)
      && /key: 'checkpoints', table: 'AuditCheckpoint', label: '[^']+', class: 'evidence', sweep: 'none'/.test(policy)
      && /export const NEVER_SWEPT = \['ActivityLog', 'AuditCheckpoint', 'AuditChainState'\] as const;/.test(policy),
    'ActivityLog and AuditCheckpoint must be class evidence, sweep none');
  const stmt = (table) => { const i = svc.indexOf(`DELETE FROM "${table}"`) >= 0 ? svc.indexOf(`DELETE FROM "${table}"`) : svc.indexOf(`UPDATE "${table}"`); return i < 0 ? '' : svc.slice(i, svc.indexOf('`', i)); };
  const alertSel = svc.slice(svc.indexOf('SELECT a."id" FROM "MonitorAlert" a'), svc.indexOf('SKIP LOCKED'));
  check('retention: nothing open, live or used is ever touched',
    /const DONE_COMMAND = Prisma\.raw\(`\('SUCCEEDED','FAILED','EXPIRED'\)`\);/.test(svc)
      && /const DONE_DIAGNOSTIC = Prisma\.raw\(`\('COMPLETED','FAILED','EXPIRED'\)`\);/.test(svc)
      && /const DONE_SESSION = Prisma\.raw\(`\('SESSION_COMPLETED','FAILED','CANCELED','STATUS_UNKNOWN'\)`\);/.test(svc)
      && (stmt('EndpointCommand').match(/"status" IN \$\{DONE_COMMAND\}/g) ?? []).length === 2
      && (stmt('DiagnosticRun').match(/"status" IN \$\{DONE_DIAGNOSTIC\}/g) ?? []).length === 2
      && /a\."state" = 'RESOLVED'/.test(alertSel) && /k\."state" <> 'RESOLVED'/.test(alertSel)
      && /DELETE FROM "MonitorAlert" WHERE "state" = 'RESOLVED' AND/.test(svc)
      && /s\."status"::text IN \$\{DONE_SESSION\}/.test(stmt('SupportSessionEvent'))
      && ['LauncherToken', 'ConnectionGrant'].every((t) => (stmt(t).match(/"usedAt" IS NULL/g) ?? []).length === 2),
    'commands/diagnostics finished states twice (outer and inner); alerts RESOLVED, no open child; sessions finished; tokens and grants unused, outer and inner');
  check('retention: the newest command of each type, and the newest that succeeded, survive at any age',
    /x\."type" = c\."type"\s+AND \(x\."createdAt", x\."id"\) > \(c\."createdAt", c\."id"\)\)\s+AND \(c\."status" <> 'SUCCEEDED' OR EXISTS/.test(stmt('EndpointCommand'))
      && /x\."key" = r\."key"\s+AND \(x\."requestedAt", x\."id"\) > \(r\."requestedAt", r\."id"\)\)\s+AND \(r\."status" <> 'COMPLETED' OR EXISTS/.test(stmt('DiagnosticRun')),
    'the "newer exists" and "newer success exists" conditions');
  const limits = (svc.match(/LIMIT \$\{n\}/g) ?? []).length, runs = (svc.match(/await run\(\(\) => /g) ?? []).length;
  check('retention: every statement is bounded and runs through the batch loop',
    // Eight tables, eight bounded statements; the alert batch's two DELETEs
    // act on the ids its bounded, locked SELECT returned.
    limits === 8 && runs === 8 && /= ANY\(\$\{ids\}::text\[\]\)/.test(svc) && /const run = \(one: \(\) => Promise<number>\) => drain\(one, n, k\);/.test(svc)
      && /for \(let i = 0; i < batches; i\+\+\) \{[\s\S]{0,120}if \(k < batch\) break;/.test(policy)
      && /batch: \{ def: 2000, min: 1, max: 50_000/.test(policy) && /batches: \{ def: 10, min: 1, max: 100/.test(policy),
    `${limits} LIMIT \${n}, ${runs} run(); want 8 of each`);
  const e2e = read('scripts/run-e2e.sh');
  check('retention: RETENTION_SWEEP=off stops the sweep, and the suites run with it off',
    /export const sweepEnabled = \(env: Record<string, string \| undefined>\) => env\.RETENTION_SWEEP !== 'off';/.test(policy)
      && /onModuleInit\(\) \{\s*if \(!this\.enabled\) return;/.test(svc)
      && /^export RETENTION_SWEEP=off$/m.test(e2e) && /METRIC_SWEEP=off RETENTION_SWEEP=off/.test(e2e),
    'sweepEnabled, onModuleInit guard, and run-e2e.sh exports it and passes it to the scratch API');
  check('retention: the status route is a Platform Admin read and nothing else',
    /@Get\(\)\s*async status\(@Actor\(\) actor: ActorContext, @Query\('fresh'\) fresh\?: string\) \{\s*this\.acl\.assertPlatformAdmin\(actor\);/.test(ctl)
      && !/@(Post|Put|Patch|Delete)\(/.test(ctl) && (ctl.match(/@Get\(/g) ?? []).length === 1
      && /private async countOf\(t: TableEntry\)/.test(svcRaw) && !/countOf\([^t)]/.test(svc),
    'one GET, assertPlatformAdmin first; countOf only takes RETENTION_TABLES entries');
}

// 34. API keys and device-group membership (0.34).
//     A key is long-lived Business Owner access that outlives the session
//     that made it, so creating ANY key needs a fresh re-authentication
//     (assertFresh, catalog key apikey.create, which only a Platform Admin can
//     turn off, § 62 — 0.33 asked only for enrollment:write; until 0.49 the
//     step-up here was not configurable),
//     after scope and before the row is written. Keys are immutable: the only
//     routes are list, create and revoke; nothing widens a key's scopes or
//     clears revokedAt, so creation is the one way to get a key's access, and
//     revoking (never gated) only ever takes it away.
//     A computer may be in many groups (EndpointGroupMember). The rule that a
//     group holds only its own business's computers is two database
//     triggers (migration 0049): the insert is refused across businesses, and
//     a computer that changes business or tenant leaves every group not its
//     new business's own. Endpoint.endpointGroupId is gone, and only the
//     known paths write membership rows.
{
  const keys = read('apps/api/src/apikeys/apikeys.service.ts');
  const keysCtl = read('apps/api/src/apikeys/apikeys.controller.ts');
  const keyFn = keys.slice(keys.indexOf('async create('), keys.indexOf('async revoke('));
  const strip = (x) => x.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
  check('creating any API key needs a fresh re-authentication, after scope and validation, before the write',
    /\n    assertFresh\(freshMethod, \{\s*action: 'apikey\.create',/.test(keyFn)
      && !/if \([^)]*\) \{\s*assertFresh\(freshMethod/.test(keyFn)
      && keyFn.indexOf('this.acl.requireScope(actor') < keyFn.indexOf('assertFresh(freshMethod')
      && keyFn.indexOf("if (validScopes.length === 0)") < keyFn.indexOf('assertFresh(freshMethod')
      && keyFn.indexOf('assertFresh(freshMethod') < keyFn.indexOf('this.prisma.apiKey.create(')
      && /stepUpMethod: freshMethod/.test(keyFn),
    'ApiKeysService.create: requireScope → validate → assertFresh (no condition around it) → apiKey.create; the audit records the method');
  const routes = [...keysCtl.matchAll(/@(Get|Post|Put|Patch|Delete)\(\s*(?:'([^']*)')?\s*\)/g)].map((m) => `${m[1].toUpperCase()} ${m[2] ?? ''}`.trim());
  check('API keys are immutable: list, create and revoke are the only routes, and revoke needs no step-up',
    JSON.stringify(routes) === JSON.stringify(['GET', 'POST', 'DELETE :id'])
      && !/stepUp|freshMethod/.test(keysCtl.slice(keysCtl.indexOf("@Delete(':id')")))
      && /@Controller\('apikeys'\)/.test(keysCtl),
    `routes: ${routes.join(', ')} — a route that edits a key needs its own step-up decision here`);
  const keyWriters = walk('apps/api/src').filter((f) => !f.endsWith('.spec.ts') && /\.apiKey\.(create|createMany|update|updateMany|upsert)\(/.test(read(f)));
  const updates = [...strip(keys).matchAll(/this\.prisma\.apiKey\.update\(\{[^;]*?data: \{([^}]*)\}/g)].map((m) => m[1].trim());
  check('nothing widens a key or restores a revoked one',
    keyWriters.length === 1 && keyWriters[0].endsWith('apikeys/apikeys.service.ts')
      && !/\.apiKey\.(updateMany|upsert|createMany)\(/.test(keys)
      && updates.length === 2 && updates.every((d) => /^(revokedAt: new Date\(\)|lastUsedAt: new Date\(\))$/.test(d))
      && !/revokedAt:\s*null/.test(strip(keys)),
    `apiKey writers: ${keyWriters.join(', ')}; update data: ${JSON.stringify(updates)}`);
  const dlg = read('apps/web/components/auth/step-up-dialog.tsx');
  check('the console asks for the step-up and retries, keeping the form',
    // 0.49: the dialog words every catalog key (apikey.create among them) from the API's catalog prompts.
    /policy\?\.catalog\.find\(\(f\) => f\.key === action\)\?\.prompt/.test(dlg) && /cfg\._stepUpRetried = true;\s*return api\.request\(cfg\);/.test(read('apps/web/lib/api-client.ts')),
    'StepUpDialog must label the action from the catalog; the interceptor must retry the original request');

  const mig = read('apps/api/prisma/migrations/0049_device_group_members/migration.sql');
  const schema = read('apps/api/prisma/schema.prisma');
  const model = schema.slice(schema.indexOf('model Endpoint {'), schema.indexOf('}', schema.indexOf('model Endpoint {')));
  check('membership is a join table and Endpoint.endpointGroupId is gone',
    /model EndpointGroupMember \{[\s\S]*?@@id\(\[endpointGroupId, endpointId\]\)/.test(schema)
      && !/^\s*endpointGroupId\b/m.test(model) && /groupMemberships EndpointGroupMember\[\]/.test(model)
      && /ALTER TABLE "Endpoint" DROP COLUMN "endpointGroupId";/.test(mig),
    'EndpointGroupMember with a composite key; no endpointGroupId on Endpoint');
  check('the database refuses a cross-business membership and drops foreign groups on a move',
    /CREATE TRIGGER endpoint_group_member_same_business\s+BEFORE INSERT OR UPDATE ON "EndpointGroupMember"/.test(mig)
      && /IF g_customer IS NOT NULL THEN\s+IF e_customer IS DISTINCT FROM g_customer THEN\s+RAISE EXCEPTION/.test(mig)
      && /ELSIF e_tenant IS DISTINCT FROM g_tenant THEN\s+RAISE EXCEPTION/.test(mig)
      && /CREATE TRIGGER endpoint_leaves_foreign_groups\s+AFTER UPDATE OF "customerId", "tenantId" ON "Endpoint"/.test(mig)
      && /AND \(g\."customerId" IS NULL OR g\."customerId" IS DISTINCT FROM NEW\."customerId"\);/.test(mig)
      && mig.indexOf('CREATE TRIGGER endpoint_group_member_same_business') < mig.indexOf('INSERT INTO "EndpointGroupMember"'),
    'migration 0049 must create both triggers, the insert check before the copy of 0.33 memberships');
  const memberWriters = walk('apps/api/src').filter((f) => !f.endsWith('.spec.ts') && /endpointGroupMember\.(create|createMany|upsert|update|updateMany)\(|groupMemberships: \{ create:/.test(read(f))).sort();
  check('only the known paths add a computer to a group',
    JSON.stringify(memberWriters) === JSON.stringify(['apps/api/src/adoption/adoption.service.ts', 'apps/api/src/device-views/device-bulk.service.ts', 'apps/api/src/endpoints/endpoints.service.ts', 'apps/api/src/enrollment/enrollment.service.ts'])
      && !/endpointGroupMember\.(update|updateMany|upsert)\(/.test(memberWriters.map(read).join('\n')),
    `writers: ${memberWriters.join(', ')} — a new path must check the business (and rely on the trigger)`);
  const listSvc = read('apps/api/src/endpoints/endpoint-list.service.ts');
  check('the group filter and facet stay inside the caller’s visibility',
    /\} else if \(q\.groupId\) \{\s*and\.push\(\{ groupMemberships: \{ some: \{ endpointGroupId: q\.groupId \} \} \}\);/.test(listSvc)
      && /this\.prisma\.endpointGroupMember\.groupBy\(\{ by: \['endpointGroupId'\], where: \{ endpoint: scoped \}/.test(listSvc)
      && /const scoped = this\.scopedWhere\(actor, \{ status: q\.status \}\);/.test(listSvc)
      && /where: \{ endpointGroupId: \{ in: groups\.map\(\(g\) => g\.id\) \}, endpoint: \{ AND: \[this\.acl\.endpointVisibilityWhere\(a, scope\),/.test(read('apps/api/src/device-views/device-groups.service.ts')),
    'filteredWhere AND-s the membership filter; facet and group-list counts go through scopedWhere / endpointVisibilityWhere');
  check('the API key and device-group suites run in CI',
    /\benrol-stepup\b/.test(read('scripts/run-e2e.sh')) && /\bdevice-views\b/.test(read('scripts/run-e2e.sh')) && /unit-device-views\.mjs/.test(read('.github/workflows/ci.yml')),
    'run-e2e.sh must run enrol-stepup and device-views; ci.yml unit-device-views');
}

// 35. Rule-based device groups (0.34). A rule group's members are computed on
//     every read, never stored: the rule (the device list's own closed
//     filters, parsed by the list's own parser) AND the group's business AND
//     the reader's visibility, through scopedWhere. A rule's values reach SQL
//     only as bound parameters. Nothing — bulk, an enrolment token, a claim,
//     endpoint creation, or a direct insert (0053 trigger) — adds a computer
//     to a rule group, and a group's kind never changes. A rule that reads
//     alerts is not evaluated for a reader who may not see alerts. Bulk on a
//     group resolves membership at request time, as the caller, capped, and
//     then takes the ordinary per-computer path. Edits carry the rule before
//     and after in the audit.
{
  const strip = (x) => x.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
  const gr = read('apps/api/src/device-views/group-rule.ts');
  const lq = read('apps/api/src/endpoints/list-query.ts');
  const listSvc = read('apps/api/src/endpoints/endpoint-list.service.ts');
  const groupSvc = read('apps/api/src/device-views/device-groups.service.ts');
  const bulkSvc = read('apps/api/src/device-views/device-bulk.service.ts');
  const mig = read('apps/api/prisma/migrations/0053_dynamic_device_groups/migration.sql').replace(/--.*$/gm, '');
  const ruleKeys = (gr.match(/export const RULE_KEYS = \[([\s\S]*?)\] as const/) ?? [])[1] ?? '';
  const listKeys = (lq.match(/export const LIST_FILTER_KEYS = \[([\s\S]*?)\] as const/) ?? [])[1] ?? '';
  const keysOf = (x) => [...x.matchAll(/'([a-zA-Z]+)'/g)].map((m) => m[1]);
  const parseFn = gr.slice(gr.indexOf('export function parseRule('), gr.indexOf('export function ruleFilters('));
  check('a rule is closed: only list filters, never search/businessId/groupId/status, unknown keys refused, parsed by the list’s parser, never empty',
    keysOf(ruleKeys).length >= 10 && keysOf(ruleKeys).every((k) => keysOf(listKeys).includes(k))
      && !['search', 'businessId', 'groupId', 'status'].some((k) => keysOf(ruleKeys).includes(k))
      && /const refused = keys\.filter\(\(k\) => k in RULE_REFUSED\);\s*if \(refused\.length\) throw bad/.test(parseFn)
      && /const unknown = keys\.filter\(\(k\) => !\(RULE_KEYS as readonly string\[\]\)\.includes\(k\)\);\s*if \(unknown\.length\) throw bad/.test(parseFn)
      && /f = parseListFilters\(asQuery\);/.test(parseFn) && /if \(!Object\.keys\(out\)\.length\) throw bad\('A rule needs at least one condition\.'\);/.test(parseFn)
      && /if \(groupRule|groupRule:/.test(strip(lq.slice(lq.indexOf('export function parseListFilters(')))) === false,
    'RULE_KEYS ⊆ LIST_FILTER_KEYS minus search/businessId/groupId/status; parseRule refuses refused and unknown keys, parses with parseListFilters, refuses an empty rule; no parser reads groupRule from a request');
  const derived = listSvc.slice(listSvc.indexOf('private derivedConds('), listSvc.indexOf('private filteredWhere('));
  const rawUses = walk('apps/api/src').filter((f) => /\$queryRawUnsafe|\$executeRawUnsafe/.test(strip(read(f))) && /device-views|endpoint-list|list-query/.test(f));
  check('a rule never becomes SQL text: bound parameters only, one whitelisted Prisma.raw, no unsafe raw query',
    rawUses.length === 0 && (strip(listSvc).match(/Prisma\.raw\(/g) ?? []).length === 1
      && /return Prisma\.raw\(`\$\{expr\[sort\]\}/.test(listSvc)
      && derived.split('\n').filter((l) => /out\.push\(/.test(l)).every((l) => /out\.push\(Prisma\.sql`[^`]*`\);/.test(l))
      && !/Prisma\.raw|Unsafe/.test(strip(gr) + strip(groupSvc) + strip(bulkSvc))
      && /export const OS_TERM = /.test(lq) && /export function isVersion\(/.test(lq),
    `derivedConds must push only Prisma.sql templates; the only Prisma.raw is orderSql; unsafe raw in: ${rawUses.join(', ')}`);
  const evalFn = listSvc.slice(listSvc.indexOf('async evaluateRuleGroups('), listSvc.indexOf('private async withRuleGroups('));
  const fw = listSvc.slice(listSvc.indexOf('private filteredWhere('), listSvc.indexOf('private orderSql('));
  const wgr = listSvc.slice(listSvc.indexOf('private async withGroupRule('), listSvc.indexOf('async ruleGroupsOf('));
  check('membership is computed as the reader: scopedWhere AND the group’s business AND the rule; an unreadable rule matches nothing',
    /const scoped = this\.scopedWhere\(actor, \{ status: opts\.status \}\);/.test(evalFn)
      && /AND: \[scoped, \{ customerId: g\.customerId \}, \.\.\.this\.filterConds\(g\.rule\)/.test(evalFn)
      && /if \(!g\.rule\) return \[\];/.test(evalFn)
      && /const and: Prisma\.EndpointWhereInput\[\] = \[this\.scopedWhere\(actor, q\), \.\.\.this\.filterConds\(q\)\];/.test(fw)
      && /if \(q\.groupRule\) \{\s*and\.push\(\{ customerId: q\.groupRule\.customerId \}\);\s*\/\/[^\n]*\n\s*and\.push\(\.\.\.\(q\.groupRule\.rule \? this\.filterConds\(q\.groupRule\.rule\) : \[\{ id: \{ in: \[\] \} \}\]\)\);/.test(fw)
      && /customerId: actor\.isPlatformAdmin \? \{ not: null \} : \(actor\.businessId \?\? '__none__'\)/.test(wgr)
      && /if \(q\.groupRule\?\.rule\) conds\.push\(\.\.\.this\.derivedConds\(q\.groupRule\.rule\)\);/.test(listSvc)
      && !/endpointGroupMember\.(create|createMany)/.test(listSvc + groupSvc.slice(groupSvc.indexOf('async create('))),
    'evaluateRuleGroups and filteredWhere must AND scopedWhere, the business and the rule; withGroupRule only attaches a rule the caller may address');
  check('a rule on alerts is not evaluated for a reader without monitoring:alerts',
    /if \(ruleNeedsAlerts\(g\.rule\) && !alerts\.visible\) return null;/.test(evalFn)
      && /if \(q\.groupRule && ruleNeedsAlerts\(q\.groupRule\.rule\)\) \{\s*throw new ForbiddenException/.test(listSvc)
      && listSvc.indexOf('const q = await this.withGroupRule(actor, query);\n    this.assertAlertUse(q, alerts);') > 0
      && /if \(got === null \|\| got === undefined\) throw new ForbiddenException/.test(bulkSvc),
    'evaluateRuleGroups returns null, the list filter and bulk refuse');
  const eps = read('apps/api/src/endpoints/endpoints.service.ts');
  const enr = read('apps/api/src/enrollment/enrollment.service.ts');
  const ga = bulkSvc.slice(bulkSvc.indexOf('private async groupAction('), bulkSvc.indexOf('// ── Refresh inventory'));
  check('nothing adds a computer to a rule group, and a group’s kind never changes',
    /if \(g\.kind === 'RULE'\) \{\s*throw new BadRequestException\(\{ code: 'RULE_GROUP'/.test(ga) && ga.indexOf("g.kind === 'RULE'") < ga.indexOf('endpointGroupMember.create(')
      && /if \(g\.kind === 'RULE'\) throw new BadRequestException\(\{ code: 'RULE_GROUP'/.test(eps)
      && /if \(group\.kind === 'RULE'\) throw new BadRequestException\(\{ code: 'RULE_GROUP'/.test(enr)
      && /where: \{ id: record\.endpointGroupId, kind: 'STATIC',/.test(enr)
      && /CREATE TRIGGER endpoint_group_member_static_only\s+BEFORE INSERT OR UPDATE ON "EndpointGroupMember"/.test(mig)
      && /IF EXISTS \(SELECT 1 FROM "EndpointGroup" WHERE id = NEW\."endpointGroupId" AND "kind" = 'RULE'\) THEN\s+RAISE EXCEPTION/.test(mig)
      && /CREATE TRIGGER endpoint_group_kind_fixed\s+BEFORE UPDATE OF "kind" ON "EndpointGroup"/.test(mig)
      && /IF NEW\."kind" IS DISTINCT FROM OLD\."kind" THEN\s+RAISE EXCEPTION/.test(mig)
      && /CHECK \(\("kind" = 'RULE' AND "rule" IS NOT NULL/.test(mig)
      && /const GroupUpdate = z\.object\(\{\s*name: GroupInput\.shape\.name,\s*description: GroupInput\.shape\.description,\s*rule: z\.unknown\(\),\s*\}\)\.partial\(\)\.strict\(\);/.test(groupSvc),
    'bulk group.add/remove, endpoint creation and enrolment tokens refuse RULE groups; the claim takes STATIC only; 0053 has the static-only and kind-fixed triggers and the CHECK; PATCH has no kind');
  const rt = bulkSvc.slice(bulkSvc.indexOf('private async resolveTarget('), bulkSvc.indexOf('async run('));
  const run = bulkSvc.slice(bulkSvc.indexOf('async run('), bulkSvc.indexOf('// ── Groups'));
  check('bulk on a group: resolved now, as the caller, capped, then the ordinary per-computer path',
    /const g = await this\.groups\.findVisible\(a, groupId\);/.test(rt)
      && /await this\.list\.evaluateRuleGroups\(a, \[/.test(rt)
      && /endpoint: \{ AND: \[this\.acl\.endpointVisibilityWhere\(a\), \{ status: \{ not: 'ARCHIVED' \} \}\] \}/.test(rt)
      && /if \(ids\.length > BULK_MAX\) \{\s*throw new BadRequestException\(\{ code: 'BULK_TOO_LARGE'/.test(rt)
      && /const input = \{ \.\.\.parsed, endpointIds: target \? target\.ids : parsed\.endpointIds! \};\s*const seen = await this\.visible\(a, input\.endpointIds\);/.test(run)
      && /if \(byGroup && body\.endpointIds !== undefined\) throw bad/.test(read('apps/api/src/device-views/rules.ts')),
    'resolveTarget must use findVisible and the list’s evaluation (or visible static members), refuse over BULK_MAX, and feed visible()');
  const upd = groupSvc.slice(groupSvc.indexOf('async update('), groupSvc.indexOf('async remove('));
  check('rule groups: same manage rule as static ones, a site from the business, audited with the rule before and after',
    /const g = await this\.findManageable\(a, id\);/.test(upd) && /await this\.validRule\(d\.rule, g\.customerId\)/.test(upd)
      && /before: \{ name: g\.name, description: g\.description, \.\.\.\(g\.kind === 'RULE' \? \{ rule: g\.rule \} : \{\}\) \}/.test(upd)
      && /after: \{ name: after\.name, description: after\.description, \.\.\.\(g\.kind === 'RULE' \? \{ rule: after\.rule \} : \{\}\) \}/.test(upd)
      && /kind: rule \? 'rule' : 'static', \.\.\.\(rule \? \{ rule \} : \{\}\)/.test(groupSvc)
      && /where: \{ id: rule\.siteId, customerId \}/.test(groupSvc)
      && /const rule = d\.kind === 'rule' \? await this\.validRule\(d\.rule, customerId\) : null;/.test(groupSvc)
      && groupSvc.indexOf('const why = manageRefusal(a, customerId);') < groupSvc.indexOf('const rule = d.kind === \'rule\''),
    'update must go through findManageable and validRule and audit before/after rule; create audits kind and rule');
  check('the dynamic-group suites run in CI',
    /\bdynamic-groups\b/.test(read('scripts/run-e2e.sh')) && /unit-dynamic-groups\.mjs/.test(read('.github/workflows/ci.yml')),
    'run-e2e.sh must run dynamic-groups; ci.yml unit-dynamic-groups');
}

// ─────────────────────────────────────────────────────────────────────────────
// 36. The shared hbbs peer snapshot (0.34). Whether hbbs has ever registered a
//     RustDesk ID decides whether the Windows installer may report success
//     (`rustdeskRegistered`), and it used to be one sqlite3 process per
//     heartbeat. It is now one read shared for a short window, and the window
//     is the only staleness allowed: a snapshot is never consulted after it
//     (age measured from when its read started, and a clock that went
//     backwards is stale), the window is clamped to 30 s whatever is
//     configured, a failed read answers null and discards the older snapshot
//     rather than falling back to it, the query keeps digit IDs only (so a
//     peer ID with a newline cannot add a second "ID" to the output), and
//     nothing else on the heartbeat path spawns sqlite3.
{
  const snap = read('apps/api/src/enrollment/hbbs-peer-snapshot.ts');
  const en = read('apps/api/src/enrollment/enrollment.service.ts');
  const maxW = /export const MAX_WINDOW_MS = ([0-9_]+);/.exec(snap);
  check('the peer snapshot window is clamped to at most 30 s',
    !!maxW && Number(maxW[1].replace(/_/g, '')) <= 30_000
      && /return Math\.min\(MAX_WINDOW_MS, Math\.max\(MIN_WINDOW_MS, Math\.round\(n\)\)\);/.test(snap)
      && /this\.windowMs = clampWindowMs\(windowMs\);/.test(snap),
    'MAX_WINDOW_MS ≤ 30000 and the constructor must clamp the configured window');
  check('a peer snapshot is used only inside its window, measured from the start of its read',
    /const age = this\.now\(\) - s\.startedAt;\s*\n(?:\s*\/\/[^\n]*\n)*\s*return age >= 0 && age < this\.windowMs;/.test(snap)
      && /const startedAt = this\.now\(\);\s*\n\s*this\.loads\+\+;\s*\n\s*this\.inflight = this\.load\(\)/.test(snap),
    'fresh() must be age >= 0 && age < windowMs, with startedAt taken before load() is called');
  check('an expired or unreadable peer snapshot never answers from an older copy',
    /if \(this\.fresh\(this\.snap\)\) return this\.snap;\s*\n(?:\s*\/\/[^\n]*\n)*\s*this\.snap = null;/.test(snap)
      && /\.then\(\(ids\) => \(\{ startedAt, ids \}\), \(\) => \(\{ startedAt, ids: null \}\)\)/.test(snap)
      && /return s\.ids === null \? null : s\.ids\.has\(rustdeskId\);/.test(snap),
    'drop the expired snapshot before re-reading; a rejected read is ids: null, answered as null');
  check('the peer snapshot query and parser keep 6–15 digit IDs only',
    /PEER_SNAPSHOT_SQL =\s*\n?\s*"SELECT id FROM peer WHERE length\(id\) BETWEEN 6 AND 15 AND id NOT GLOB '\*\[\^0-9\]\*';"/.test(snap)
      && /export const PEER_ID_RE = \/\^\[0-9\]\{6,15\}\$\/;/.test(snap)
      && /if \(PEER_ID_RE\.test\(id\)\) ids\.add\(id\);/.test(snap)
      && /if \(!PEER_ID_RE\.test\(rustdeskId\)\) return null;/.test(snap),
    'the SQL must refuse non-digit IDs and both the parser and the lookup must apply PEER_ID_RE');
  check('the heartbeat asks hbbs registration only through the shared snapshot',
    (en.match(/'sqlite3'/g) ?? []).length === 1
      && /async peerRegisteredWithHbbs\(rustdeskId: string\): Promise<boolean \| null> \{\s*\n\s*return this\.hbbsPeers\.has\(rustdeskId\);\s*\n\s*\}/.test(en)
      && /\[`file:\$\{dbPath\}\?mode=ro`, PEER_SNAPSHOT_SQL\]/.test(en),
    'one sqlite3 call in enrollment.service.ts, read-only, running PEER_SNAPSHOT_SQL, and peerRegisteredWithHbbs delegating to it');
}

// 37. Restarts after Windows updates (0.34). An update plan's restart rule
//     is one of two fixed strings: never, or if_required_in_window. Under the
//     second the agent restarts only when Windows reports a restart required
//     after something was installed, only through windows.reboot.schedule's
//     own path (shutdown.exe via Maintenance.ScheduleRestart, the fixed
//     message, the reboot record), after a fixed warning, never while a
//     RustDesk session is open or when it cannot tell, and never after the
//     plan's signed window closes — otherwise restart_deferred. wua.ps1 still
//     never restarts (§ 15). The portal, the signer (a plan may not ask for
//     more than its policy allows) and the agent each check the closed form,
//     and every way to ask for an install defaults to never.
{
  const upd = read('tools/windows-installer/internal/action/updates.go');
  const maint = read('tools/windows-installer/internal/action/maintenance.go');
  const tsCat = read('apps/api/src/actions/catalog.ts');
  const fn = upd.slice(upd.indexOf('func restartInWindow('), upd.indexOf('\n}\n', upd.indexOf('func restartInWindow(')));
  const goWarn = Number((upd.match(/UpdateRestartWarningMinutes = (\d+)/) ?? [])[1]);
  const tsWarn = Number((tsCat.match(/export const UPDATE_RESTART_WARNING_MINUTES = (\d+);/) ?? [])[1]);
  check('the update restart warning is fixed, the same on both sides, and no shorter than a scheduled restart\'s',
    goWarn === tsWarn && goWarn >= 5 && /MinRestartDelayMinutes = 5/.test(maint),
    `agent ${goWarn}, portal ${tsWarn}`);
  check('an update restart goes through the one scheduling path windows.reboot.schedule uses',
    /when, err := scheduleWarnedRestart\(p, o, UpdateRestartWarningMinutes\)/.test(fn) && /at, err := scheduleWarnedRestart\(p, o, minutes\)/.test(maint)
      && (`${upd}\n${maint}`.match(/o\.Maint\.ScheduleRestart\(/g) ?? []).length === 1
      && /func scheduleWarnedRestart\([^)]*\) \(time\.Time, error\) \{\s*at := o\.now\(\)\.Add\(time\.Duration\(minutes\) \* time\.Minute\)\s*if err := o\.Maint\.ScheduleRestart\(minutes\*60, RestartMessage\(at\.Local\(\), minutes, p\.JobID\)\); err != nil/.test(maint),
    'one call to Maint.ScheduleRestart, with the fixed RestartMessage, shared by both actions');
  const iUnc = fn.indexOf('case r.Outcome == "uncertain":'), iPend = fn.indexOf('case !pending:'), iInst = fn.indexOf('case r.Outcome != "restart_required" && r.Outcome != "partial":');
  const iWin = fn.indexOf('if err != nil || at.After(na) {'), iSess = fn.indexOf('if pr := sessionCheck("the restart")(p, o); pr != nil {'), iSched = fn.indexOf('scheduleWarnedRestart(');
  check('the agent restarts only after an install Windows says needs one, inside the window, with no session open — else restart_deferred',
    iUnc > 0 && iPend > iUnc && iInst > iPend && iWin > iInst && iSess > iWin && iSched > iSess
      && /na, err := time\.Parse\(time\.RFC3339Nano, p\.Window\.NotAfter\)\s*at := o\.now\(\)\.Add\(UpdateRestartWarningMinutes \* time\.Minute\)/.test(fn)
      && /deferred\("window_closed"/.test(fn) && /deferred\("install_uncertain"/.test(fn) && /State: "restart_deferred"/.test(fn)
      && /if UpdateReboot\(p\.Params\) == RebootInWindow \{\s*restartInWindow\(p, o, &r\)/.test(upd),
    'restartInWindow must check outcome, pending, window, then sessions, in that order, before scheduling');
  check('wua.ps1 still never restarts: the only restart is the agent\'s shutdown.exe path',
    !/Restart-Computer|shutdown|InitiateSystemShutdown|CommitInstall|\.Reboot\(/i.test(read('tools/windows-installer/internal/patch/wua.ps1').replace(/^\s*#.*$/gm, ''))
      && /runSystem32\(30\*time\.Second, "shutdown\.exe", "\/r", "\/t", strconv\.Itoa\(seconds\)/.test(read('tools/windows-installer/action_windows.go')),
    'no restart in the Windows Update script');
  check('the portal\'s restart rule is the same closed pair, and an install asked for any way defaults to never',
    /export const UPDATE_REBOOT_RULES = \['never', 'if_required_in_window'\] as const;/.test(tsCat) && /reboot: UpdateReboot,\s*(?:\/\/[^\n]*\s*){0,3}ignoreRemoteSession: z\.literal\(true\)\.optional\(\),\s*\/\/ 0\.32/.test(tsCat)
      && (read('apps/api/src/patching/patching.service.ts').match(/reboot: UpdateReboot\.default\('never'\),/g) ?? []).length === 2
      && /reboot: UpdateReboot\.default\('never'\),/.test(read('apps/api/src/patching/policies.service.ts')),
    'UPDATE_INSTALL.params.reboot, CreateDeploymentDto, InstallDto and CreatePolicyDto');
  const ev = read('apps/api/src/actions/patch-policy.ts');
  check('the signer refuses a plan whose restart rule asks for more than its policy allows',
    /if \(!rebootWithin\(params\.reboot, doc\.reboot\)\) return no\('reboot_not_allowed'/.test(ev)
      && /export const rebootWithin = \(plan: unknown, allowed: UpdateRebootRule\) =>\s*UpdateReboot\.safeParse\(plan\)\.success && UPDATE_REBOOT_RULES\.indexOf\(plan as UpdateRebootRule\) <= UPDATE_REBOOT_RULES\.indexOf\(allowed\);/.test(tsCat),
    'evaluatePolicyPlan must compare the plan\'s rule with the policy\'s');
  check('the database holds a deployment\'s rule to the pair',
    /^ALTER TABLE "PatchDeployment" ADD CONSTRAINT "PatchDeployment_reboot_check" CHECK \("reboot" IN \('never', 'if_required_in_window'\)\);$/m.test(read('apps/api/prisma/migrations/0047_patch_reboot/migration.sql')),
    'PatchDeployment_reboot_check');
  const asvc = read('apps/api/src/actions/actions.service.ts');
  check('a restart report is kept only from an update plan whose signed rule allowed a restart',
    /if \(r\.restart && !\(t\.job\.actionId === UPDATE_INSTALL\.id && planReboot === 'if_required_in_window'\)\) r\.restart = undefined;/.test(asvc),
    'recordResults must drop restart from any other plan');
  const UNPROVEN = 'The in-window restart has been tested against a simulated Windows only; it has not yet run on a real Windows computer.';
  const comp = read('apps/web/components/patching/patch-reboot-choice.tsx');
  const doc = read('docs/staged-patching.md').replace(/\n>\s*/g, ' ').replace(/\s+/g, ' ');
  check('the UI, the approval page and the docs say the restart has not run on real Windows',
    tsCat.includes(`REBOOT_UNPROVEN = '${UNPROVEN}'`) && comp.includes(`REBOOT_UNPROVEN = '${UNPROVEN}'`) && /<strong>\{REBOOT_UNPROVEN\}<\/strong>/.test(comp)
      && (read('apps/api/src/approval-signer/page.ts').match(/esc\(REBOOT_UNPROVEN\)/g) ?? []).length === 4 && doc.includes(`**Not proven on Windows.** ${UNPROVEN}`),
    'catalog.ts and patch-reboot-choice.tsx define it, the reboot choice shows it, the signer page and docs/staged-patching.md say it');
}

// 38. Agent-signed action results (0.34). A later ring of a patch policy
//     opens only on results the computers signed with their own key, which
//     two approvers bound to each computer in the policy and the signer then
//     pinned. So: the portal and signer only VERIFY device statements (the
//     statement prefixes appear in one file, which signs nothing); the
//     evaluator verifies every previous-ring result under the policy's key —
//     never the key a statement names — before the gate runs, and the gate
//     reads only the signed facts; a missing signature can only count
//     against a ring and never opens the canary's; the portal relays the
//     signatures as received; a pin is write-once and nothing over HTTP
//     removes one; a policy whose gating computers cannot sign is refused;
//     and the agent signs every final result in one place, with prefixes
//     that match the verifier's.
{
  const dr = read('apps/api/src/actions/device-result.ts');
  const drCode = dr.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
  const PREFIXES = ['rem0te-device-result-v1', 'rem0te-device-scan-v1'];
  // The docs bundle is docs/ compiled to prose (staged-patching.md names the prefixes); it is not code.
  const elsewhere = walk('apps/api/src').concat(walk('apps/web')).filter((f) => !f.endsWith('actions/device-result.ts') && !f.endsWith('lib/docs-content.generated.ts') && PREFIXES.some((x) => read(f).includes(x)));
  check('device statements are only verified in the portal and signer: one file holds the prefixes, and it signs nothing',
    PREFIXES.every((x) => drCode.includes(x)) && elsewhere.length === 0 && !/\bsign\s*\(|edSign|createPrivateKey|generateKeyPair|createSign\b/.test(drCode),
    elsewhere.length ? `the statement prefixes appear in ${elsewhere.join(', ')}` : 'device-result.ts must not sign or hold a private key');
  check('a statement is verified under the trusted key, never the key it names',
    /if \(env\.data\.key !== trustedKey\) return \{ ok: false, code: 'result_wrong_device'/.test(dr) && /const pub = publicKey\(trustedKey\);/.test(dr) && !/publicKey\(env\.data\.key\)/.test(dr),
    'openDeviceStatement must compare the named key with the trusted one and verify with the trusted one');
  const pp = read('apps/api/src/actions/patch-policy.ts');
  const evFn = pp.slice(pp.indexOf('export function evaluatePolicyPlan('), pp.indexOf('// ── Signed evidence (v0.34)'));
  const vi = evFn.indexOf('const verified = verifiedGateTargets(doc.rings[ring - 1], prev, r.evidence, now);');
  check('the signer verifies the previous ring\'s signatures before any later-ring gate, and the gate reads only the verified facts',
    vi > 0 && vi < evFn.indexOf('evaluateRingGate({') && /if \(!verified\.ok\) return verified;/.test(evFn) && /targets: verified\.targets,/.test(evFn) && !/fromEvidenceTarget\(/.test(evFn),
    'evaluatePolicyPlan must call verifiedGateTargets and pass verified.targets (never fromEvidenceTarget) to evaluateRingGate');
  const vg = pp.slice(pp.indexOf('export function verifiedGateTargets('));
  check('each previous-ring result and scan is checked: the policy\'s key, the identity, the plan, the time; missing never opens the canary',
    /openDeviceStatement\('result', t\.signedResult, c\.resultKey\)/.test(vg) && /openDeviceStatement\('scan', t\.signedScan, c\.resultKey\)/.test(vg)
      && /st\.jobId !== prev\.jobId \|\| \(prev\.planSha256 && st\.planSha256 !== prev\.planSha256\)/.test(vg)
      && /st\.rustdeskId !== c\.rustdeskId \|\| st\.deviceSecretSha256 !== c\.deviceSecretSha256/.test(vg)
      && ['result_key_not_pinned', 'result_signature_missing', 'result_wrong_plan', 'result_wrong_device', 'result_stale'].every((x) => vg.includes(`'${x}'`))
      && /if \(canary\) return \{ ok: false, code: 'result_signature_missing'/.test(vg) && /if \(t\.status === 'SUCCEEDED'\) return \{ ok: false, code: 'result_signature_missing'/.test(vg)
      && /status: RESULT_STATUS\[st\.outcome\]/.test(vg) && /resultAt: new Date\(at\)/.test(vg),
    'verifiedGateTargets must open each signature under c.resultKey, bind job, plan, identity and time, and refuse an unsigned canary or "succeeded"');
  // 0.62 (§75): only a canary document's results open a ring; an all-at-once document opens none, so needs no key.
  check('a policy whose results would open a ring must name a result key for each such computer (fail closed)',
    /const unsigned = staging === 'none' \? \[\] : doc\.rings\.slice\(0, -1\)\.flat\(\)\.filter\(\(c\) => !c\.resultKey\);/.test(pp) && /reason: 'result_key_missing'/.test(pp)
      && /const staging = stagingOf\(doc\);\s*if \(!staging\) return \{ ok: false, reason: 'staging_unknown'/.test(pp)
      && /if \(canary && !resultKey && dto\.rings\.length > 1 && i < dto\.rings\.length - 1\) \{\s*throw new ConflictException\(\{ code: 'RESULT_KEY_MISSING'/.test(read('apps/api/src/patching/policies.service.ts')),
    'validatePolicyDoc (signer and portal) and PatchPolicyService.admit must refuse it under canary staging (and an unknown staging before anything)');
  const toEv = pp.slice(pp.indexOf('export function toEvidenceTarget('), pp.indexOf('export function fromEvidenceTarget('));
  check('the portal relays device signatures as received',
    /const signedResult = \(t\.result as \{ signed\?: unknown \} \| null\)\?\.signed \?\? null;/.test(toEv) && /const signedScan = \(s as \{ signed\?: unknown \} \| null\)\?\.signed \?\? null;/.test(toEv) && /signedResult, signedScan,/.test(toEv),
    'toEvidenceTarget must copy result.signed and scan.signed unchanged');
  const st = read('apps/api/src/approval-signer/store.ts');
  const srv = read('apps/api/src/approval-signer/server.ts');
  const core = read('apps/api/src/approval-signer/core.ts');
  check('a device key pin is write-once, made only on approval, checked on proposal and on every policy plan, and removed only by the operator CLI',
    /pinDeviceKey\(p: DevicePin\)[\s\S]{0,400}flag: 'wx'/.test(st) && !/forgetDevicePin/.test(srv) && /forgetDevicePin/.test(read('apps/api/src/approval-signer/main.ts'))
      && /if \(status === 'ACTIVE'\) for \(const p of newPins\(cur, pins, now\(\)\)\) store\.pinDeviceKey\(p\);/.test(srv)
      && /const changed = pinConflicts\(doc\.rings\.flat\(\), pins\);\s*if \(changed\.length\) throw new Refused\('device_key_changed'/.test(srv)
      && /signUnderPolicy\(r, b, k, store\.policy\(\), now\(\), pins\)/.test(srv)
      && core.indexOf("throw new Refused('device_key_changed'") > core.indexOf('export function signUnderPolicy(') && core.indexOf("throw new Refused('device_key_changed'") < core.indexOf('evaluatePolicyPlan({', core.indexOf('export function signUnderPolicy(')),
    'store.pinDeviceKey must use wx; the server pins on ACTIVE only, checks pins at proposal and passes them to signUnderPolicy, which refuses before evaluating; only main.ts forgets');
  const goSig = read('tools/windows-installer/internal/devsig/devsig.go');
  const goAct = read('tools/windows-installer/internal/action/action.go');
  check('the agent signs with the verifier\'s prefixes, keeps only a seed on disk, and signs every final result in one place',
    /ResultPrefix = "rem0te-device-result-v1\\n"/.test(goSig) && /ScanPrefix\s+= "rem0te-device-scan-v1\\n"/.test(goSig)
      && /const RESULT_PREFIX = 'rem0te-device-result-v1\\n';/.test(dr) && /const SCAN_PREFIX = 'rem0te-device-scan-v1\\n';/.test(dr)
      && /type keyFile struct \{\s*Schema string `json:"schema"`\s*Seed\s+string `json:"seed"`\s*\}/.test(goSig) && !/Seed|Private/.test(goSig.slice(goSig.indexOf('type Signed struct'), goSig.indexOf('type keyFile struct')))
      && (goAct.match(/State: "done"/g) ?? []).length === 1 && /func final\([\s\S]{0,300}signResult\(&o, &r, planSHA, [\s\S]{0,200}State: "done"/.test(goAct),
    'devsig prefixes must equal device-result.ts; the key file holds only a seed; action.go journals "done" only in final(), after signResult');
}

// 39. Running approved scripts (0.34): windows.script.run@1. A script runs as
//     SYSTEM with full PowerShell, so everything rests on WHICH bytes run and
//     WHO agreed. No run without an APPROVED library version and an ACTIVE
//     entry on the approval signer's own allowlist, which only two passkey
//     approvals on the signer's origin can create and the portal can neither
//     write nor un-revoke; the typed argument schema is checked by the
//     portal, the signer and the agent, with the same closed charsets; the
//     agent never builds a command line from anything in a plan; and output
//     is redacted on the computer and again by the portal before it is
//     stored. Behavioural proof: apps/api/scripts/e2e-script-run.mjs (real
//     PowerShell 7 through the sim) and unit-approval-signer.mjs.
{
  const code = (s) => s.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
  const runSvc = code(read('apps/api/src/script-run/script-run.service.ts'));
  const req = runSvc.slice(runSvc.indexOf('async requestRun('));
  const iApproved = req.search(/if \(v\.status !== 'APPROVED' \|\| !v\.decidedById\) throw new ConflictException\(\{ code: 'NOT_APPROVED'/);
  const iActive = req.search(/const entry = \(await this\.entries\(v\.id\)\)\.find\(\(e\) => e\.status === 'ACTIVE'\);\s*if \(!entry\) throw new ConflictException\(\{ code: 'SCRIPT_NOT_ALLOWLISTED'/);
  const iPlan = req.indexOf('this.actions.createPlan(');
  const core = code(read('apps/api/src/approval-signer/core.ts'));
  const server = code(read('apps/api/src/approval-signer/server.ts'));
  const assertFn = core.slice(core.indexOf('export function assertScriptAllowed('), core.indexOf('export function rolesFor('));
  check('no run without an APPROVED version and an ACTIVE entry on the signer\'s own allowlist (portal asks; the signer decides at admission and again at signing)',
    iApproved > 0 && iActive > iApproved && iPlan > iActive
      && /if \(p\.action\.id === SCRIPT_RUN_ACTION\) assertScriptAllowed\(p, scripts\);/.test(core)
      && /if \(!s \|\| !entry\) throw new Refused\('script_not_allowlisted'/.test(assertFn) && /if \(st === 'REVOKED'\) throw new Refused\('script_revoked'/.test(assertFn)
      && /if \(st !== 'ACTIVE'\) throw new Refused\('script_not_allowlisted'/.test(assertFn)
      && /if \(canonical\(s\) !== canonical\(scriptBlockOf\(entry\.proposal\)\)\) throw new Refused\('script_mismatch'/.test(assertFn)
      && /admitPlan\(b\.plan, store\.policy\(\), now\(\), \(id\) => store\.scriptEntry\(id\)(, softwareRevoked)?\)/.test(server)
      && /if \(cur\.plan\.action\.id === SCRIPT_RUN_ACTION && c\.decision === 'approve'\) assertScriptAllowed\(cur\.plan, \(id\) => store\.scriptEntry\(id\)\);/.test(server),
    'requestRun must refuse a non-APPROVED version and a missing ACTIVE entry before createPlan; the signer must check its own entry (exact block, ACTIVE, not revoked) at admission and before signing');

  const internal = server.slice(server.indexOf('async function internalScript('), server.indexOf('// ── internal: patch policies'));
  const store = code(read('apps/api/src/approval-signer/store.ts'));
  const client = code(read('apps/api/src/actions/signer.client.ts'));
  const clientPaths = [...client.matchAll(/this\.call<[^>]*>\('(GET|POST|PUT|PATCH|DELETE)', `?'?(\/internal\/v1\/scripts[^'`,]*)/g)].map((m) => `${m[1]} ${m[2].replace(/\$\{[^}]+\}/g, ':id')}`);
  const decide = core.slice(core.indexOf('export function recordScriptDecision('));
  const scriptCore = core.slice(core.indexOf('export function admitScriptProposal('), core.indexOf('export function recordScriptDecision(') + decide.slice(1).search(/\nexport |$/) + 1);
  check('the portal cannot write the signer\'s allowlist: propose, read and revoke only; ACTIVE only from two passkey approvals; revocation is write-once by content hash',
    /if \(req\.method !== 'POST' \|\| sub !== 'revoke'\) return send\(res, 405/.test(internal)
      && /const direct = allowlistDirect\(store\.policy\(\)\);\s*const r = admitScriptProposal\(b\.proposal, now\(\), direct\);/.test(internal) && /if \(store\.scriptRevocation\(r\.contentSha256\)\) throw new Refused\('script_revoked'/.test(internal)
      && /throw new Refused\('script_id_reused'/.test(internal)
      && /id: p\.allowlistId, status: direct \? 'ACTIVE' : 'AWAITING_APPROVAL'/.test(core) && /if \(sha !== p\.contentSha256\) throw new Refused\('hash_mismatch'/.test(core)
      && (scriptCore.match(/status = 'ACTIVE'|status: 'ACTIVE'/g) ?? []).length === 1 && /\.size >= SCRIPT_ALLOWLIST_APPROVALS\) r\.status = 'ACTIVE';/.test(decide)
      && /export const SCRIPT_ALLOWLIST_APPROVALS = 2;/.test(read('apps/api/src/actions/script-run.ts'))
      && (server.match(/recordScriptDecision\(/g) ?? []).length === 1 && /const member = await verifiedMember\(c, b\.assertion\);[\s\S]{0,200}recordScriptDecision\(cur, member,/.test(server)
      && /'script-revocations', `\$\{contentSha256\}\.json`\), JSON\.stringify\(rev, null, 2\), \{ mode: 0o600, flag: 'wx' \}/.test(store)
      && !/this\.write\([^)]*'script-revocations'/.test(store) && !/rmSync|\bunlink\(|\brm\(/.test(store)
      // The store's only deletion is the operator CLI's device-pin removal (§ 38); nothing removes a script entry or revocation.
      && [...store.matchAll(/unlinkSync\(([^;]*)\)/g)].every((m) => /^path\.join\(this\.dir, 'device-keys', /.test(m[1]))
      && JSON.stringify(clientPaths.sort()) === JSON.stringify(['GET /internal/v1/scripts/:id', 'POST /internal/v1/scripts', 'POST /internal/v1/scripts/:id/revoke']),
    `signer client script calls: ${clientPaths.join(', ')}`);

  const goScript = read('tools/windows-installer/internal/action/script.go');
  const tsRun = read('apps/api/src/actions/script-run.ts');
  const tsCs = Object.fromEntries([...((tsRun.match(/export const CHARSETS = \{([\s\S]*?)\} as const;/) ?? [])[1] ?? '').matchAll(/(\w+): \/(.+?)\/,$/gm)].map((m) => [m[1], m[2]]));
  const goCs = Object.fromEntries([...((goScript.match(/scriptCharsets = map\[string\]\*regexp\.Regexp\{([\s\S]*?)\n\t\}/) ?? [])[1] ?? '').matchAll(/"(\w+)":\s+regexp\.MustCompile\(`([^`]+)`\)/g)].map((m) => [m[1], m[2]]));
  const tsTimeouts = (tsRun.match(/export const TIMEOUT_MINUTES = \[([^\]]+)\] as const;/) ?? [])[1]?.replace(/\s/g, '');
  const goTimeouts = (goScript.match(/var ScriptTimeouts = \[\]int\{([^}]+)\}/) ?? [])[1]?.replace(/\s/g, '');
  const pre = goScript.slice(goScript.indexOf('func scriptPrecheck('), goScript.indexOf('const scriptWrapper'));
  const actSvc = code(read('apps/api/src/actions/actions.service.ts'));
  check('the argument schema is checked by the portal, the signer and the agent, with the same closed charsets and timeouts',
    Object.keys(tsCs).length === 4 && JSON.stringify(tsCs) === JSON.stringify(goCs)
      && tsTimeouts === '1,5,10,15,30' && goTimeouts === tsTimeouts
      && /const why = argumentsProblem\(decls, d\.parameters\);[\s\S]{0,300}throw new BadRequestException\(\{ code: 'PARAMS_NOT_ALLOWED'/.test(req)
      && /const scriptProblem = scriptPlanProblem\(check\.data\);\s*if \(scriptProblem\) throw/.test(actSvc)
      && /const sp = scriptPlanProblem\(p\);\s*if \(sp\) return \{ ok: false, reason: sp \};/.test(read('apps/api/src/actions/catalog.ts'))
      && /if \(argumentsProblem\(s\.parameters, params\.data\.parameters\)\) return 'arguments_not_allowed';/.test(tsRun)
      && /const why = argumentsProblem\(entry\.proposal\.parameters, \(p\.params as \{ parameters\?: unknown \}\)\.parameters\);\s*if \(why\) throw new Refused\('arguments_not_allowed'/.test(assertFn)
      && /if why := declsProblem\(s\.Parameters\); why != "" \{\s*return refuse\("bad_declarations"/.test(pre) && /if why := argumentsProblem\(s\.Parameters, args\); why != "" \{\s*return refuse\("arguments_not_allowed"/.test(pre)
      && /if hex\.EncodeToString\(sum\[:\]\) != s\.ContentSHA256 \{\s*return refuse\("content_mismatch"/.test(pre)
      && /if ap\.UserID == c \{\s*return refuse\("contributor_approved"/.test(pre),
    `charsets portal ${JSON.stringify(tsCs)} agent ${JSON.stringify(goCs)}; timeouts ${tsTimeouts} / ${goTimeouts}`);

  const actDir = 'tools/windows-installer/internal/action';
  const execFiles = readdirSync(join(ROOT, actDir)).filter((f) => f.endsWith('.go') && !f.endsWith('_test.go') && /exec\.Command|"os\/exec"/.test(read(`${actDir}/${f}`)));
  const se = read(`${actDir}/scriptexec.go`);
  const wrapper = (goScript.match(/const scriptWrapper = `([\s\S]*?)`/) ?? [])[1] ?? '';
  const aw = read('tools/windows-installer/action_windows.go');
  check('the agent never builds a command line: one fixed PowerShell invocation, a fixed wrapper, arguments as data in params.json',
    JSON.stringify(execFiles.sort()) === JSON.stringify(['scriptexec.go', 'scriptexec_unix.go', 'scriptexec_windows.go'])
      && (se.match(/exec\.Command(?:Context)?\(/g) ?? []).length === 1 && /cmd := exec\.Command\(h\.PowerShell, scriptArgs\(wrapper\)\.\.\.\)/.test(se)
      && /return \[\]string\{"-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", wrapper\}/.test(se)
      && !/exec\.Command/.test(read(`${actDir}/scriptexec_unix.go`) + read(`${actDir}/scriptexec_windows.go`))
      && /run := o\.Scripts\.RunPowerShell\(dir, filepath\.Join\(dir, "run\.ps1"\), timeoutOf\(p, o\), MaxScriptOutput\)/.test(goScript)
      && /"run\.ps1": \[\]byte\(scriptWrapper\)/.test(goScript) && /pj, _ := json\.Marshal\(args\)/.test(goScript)
      && /ConvertFrom-Json/.test(wrapper) && /& \(Join-Path \$here 'script\.ps1'\) @bound/.test(wrapper) && !/Invoke-Expression|\biex\b|-Command|\[scriptblock\]|ExpandString|Start-Process/i.test(wrapper)
      && /o\.Scripts = action\.ExecHost\{PowerShell: filepath\.Join\(d, "WindowsPowerShell", "v1\.0", "powershell\.exe"\)\}/.test(aw),
    `files that start a process: ${execFiles.join(', ')}`);

  const out = code(read('apps/api/src/actions/script-output.ts'));
  const rec = actSvc.slice(actSvc.indexOf('async recordResults('));
  check('script output is redacted twice — on the computer and again by the portal — and only the redacted copy is stored',
    /sr\.Stdout, sr\.StdoutTruncated = streamOut\(run\.Stdout, run\.StdoutTotal\)/.test(goScript) && /sr\.Stderr, sr\.StderrTruncated = streamOut\(run\.Stderr, run\.StderrTotal\)/.test(goScript)
      && /func streamOut\(b \[\]byte, total int64\) \(string, bool\) \{\s*s := RedactLog\(/.test(goScript)
      && /const red = redactLog\(decoded\);\s*const text = headBytes\(red, MAX_SCRIPT_OUTPUT_BYTES\);/.test(out)
      && /stdout: sanitizeStream\(r\.stdout, r\.stdoutTruncated\), stderr: sanitizeStream\(r\.stderr, r\.stderrTruncated\)/.test(out)
      && /const stored = \{ \.\.\.r, script: script \? scriptSummary\(script\) : undefined \};/.test(rec)
      && /const o = sanitizeScriptOutput\(script\);[\s\S]{0,800}stdout: o\.stdout\.text, stderr: o\.stderr\.text,/.test(rec)
      && (rec.match(/scriptRunOutput\.create\(/g) ?? []).length === 1,
    'streamOut must call RedactLog; recordResults must store sanitizeScriptOutput\'s text, and the target row only the summary');

  const mig = read('apps/api/prisma/migrations/0050_script_run/migration.sql');
  check('run output is kept 90 days and pruned by its own sweep',
    /export const SCRIPT_OUTPUT_RETENTION_DAYS = 90;/.test(tsRun) && /if \(process\.env\.SCRIPT_OUTPUT_SWEEP === 'off'\) return;/.test(runSvc)
      && /scriptRunOutput\.deleteMany\(\{ where: \{ createdAt: \{ lt: new Date\(now\.getTime\(\) - SCRIPT_OUTPUT_RETENTION_DAYS \* 86_400_000\) \} \} \}\)/.test(runSvc)
      && /octet_length\("stdout"\) <= 65536/.test(mig) && /octet_length\("stderr"\) <= 65536/.test(mig),
    'SCRIPT_OUTPUT_RETENTION_DAYS = 90, the prune query, and the 64 KiB column limits');
}

// 40. Software deployment (0.34). A catalog entry pins one winget package id,
//     one version and one installer SHA-256; installing or uninstalling it is
//     a signed, two-approver plan. The parameters are closed and charset-checked
//     the same way on both sides (a package id can never start with "-", so
//     winget can never read it as an option); the agent passes them to winget
//     as an argument array from one exec site, never a shell string, never an
//     override flag, and refuses an installer whose hash is not the pin before
//     installing; the portal installs only through ActionsService.createPlan,
//     changes the catalog only after a fresh sign-in, and has no route that
//     accepts a file.
{
  const goSw = read('tools/windows-installer/internal/action/software.go');
  const goWg = read('tools/windows-installer/internal/winget/winget.go');
  const goWin = read('tools/windows-installer/software_windows.go');
  const tsCat = read('apps/api/src/actions/catalog.ts');
  const goRe = (name) => (goSw.match(new RegExp(`${name}\\s*= regexp\\.MustCompile\\(\`([^\`]+)\`\\)`)) ?? [])[1] ?? null;
  const tsRe = (name) => (tsCat.match(new RegExp(`(?:export )?const ${name} = /(.+)/;`)) ?? [])[1] ?? null;
  const pairs = [['PackageIDRE', 'PACKAGE_ID_RE'], ['PkgVersionRE', 'SOFTWARE_VERSION_RE'], ['sha256RE', 'SHA256_RE'], ['displayNameRE', 'DISPLAY_NAME_RE'], ['uninstallKeyRE', 'UNINSTALL_KEY_RE'], ['fileSegmentRE', 'FILE_SEGMENT_RE']];
  const differ = pairs.filter(([g, t]) => !goRe(g) || goRe(g) !== tsRe(t)).map(([g, t]) => `${g}=${goRe(g)} vs ${t}=${tsRe(t)}`);
  check('software: every parameter charset is the same regular expression on the agent and the portal', differ.length === 0, differ.join('; '));
  // Whatever the regex is, these must never be a package id or a version.
  const HOSTILE = ['-h.x', '--override.x', '--force', '7zip.7zip;calc', '7zip.7zip calc', '7zip.7zip"', "7zip.7zip'", '7zip.7zip&calc', '7zip.7zip|calc', '$(calc).x', '7zip.`calc`', '%TEMP%.x', '7zip\\7zip', '7zip/7zip', '7zip.7zip\n--force', 'a.b>c'];
  const idRe = goRe('PackageIDRE'), verRe = goRe('PkgVersionRE');
  const lets = idRe && verRe ? HOSTILE.filter((h) => new RegExp(idRe).test(h) || new RegExp(verRe).test(h)) : ['(regex not found)'];
  check('software: no package id or version can start with "-" or carry a space, quote or shell character', lets.length === 0 && /^\^\[A-Za-z0-9\]/.test(idRe) && /^\^\[0-9A-Za-z\]/.test(verRe), `accepted: ${lets.map((x) => JSON.stringify(x)).join(', ')}`);
  check('software: the params are exactly five keys, scope machine, on both sides',
    /if !exactKeys\(p, "packageId", "version", "installerSha256", "scope", "detection"\) \{/.test(goSw) && /func softwareParamsOK\(p map\[string\]any\) bool \{\s*_, err := SoftwareParams\(p\)\s*return err == nil\s*\}/.test(goSw) && /!ok \|\| s\.Scope != "machine"/.test(goSw) && /func ValidPackageID\(s string\) bool \{ return len\(s\) <= 128 && PackageIDRE\.MatchString\(s\) \}/.test(goSw)
      && /export const SoftwareParams = z\.object\(\{\s*packageId: z\.string\(\)\.max\(PACKAGE_ID_MAX\)\.regex\(PACKAGE_ID_RE\),\s*version: SwVersion,\s*installerSha256: z\.string\(\)\.regex\(SHA256_RE\),\s*scope: z\.literal\('machine'\),\s*detection: Detection,\s*\}\)\.strict\(\);/.test(tsCat)
      && (tsCat.match(/\}\)\.strict\(\),?\n/g) ?? []).length >= 3 && /z\.discriminatedUnion\('kind', \[\s*z\.object\(\{ kind: z\.literal\('display_name'\)[\s\S]{0,200}\.strict\(\),\s*z\.object\(\{ kind: z\.literal\('uninstall_key'\)[\s\S]{0,200}\.strict\(\),\s*z\.object\(\{ kind: z\.literal\('file_version'\)[\s\S]{0,300}\.strict\(\),\s*\]\)/.test(tsCat),
    'SoftwareParams (Go and zod) must stay exactly packageId, version, installerSha256, scope "machine" and one of three strict detection forms');
  const swEntries = read('tools/windows-installer/internal/action/catalog.go').split(/\n\t\{\n/).filter((e) => /ID: "windows\.software\.(install|uninstall)"/.test(e));
  const tsSw = [...tsCat.matchAll(/export const SOFTWARE_(INSTALL|UNINSTALL): CatalogAction = \{([\s\S]*?)\n\};/g)].map((m) => m[2]);
  check('software: install and uninstall are high impact on any computer, never direct, never offered to ClientSt0r, at most one ring',
    swEntries.length === 2 && swEntries.every((e) => /Risk:\s+func\(int, int\) string \{ return "high" \},/.test(e) && /MaxTargets:\s+MaxRingTargets,/.test(e) && /ParamsOK:\s+softwareParamsOK,/.test(e))
      && tsSw.length === 2 && tsSw.every((e) => /risk: \(\) => 'high',/.test(e) && /direct: false,/.test(e) && /integration: false,/.test(e) && /maxTargets: MAX_RING_TARGETS,/.test(e) && /params: SoftwareParams,/.test(e)),
    'both entries: Risk "high", MaxRingTargets, softwareParamsOK; portal risk high, direct false, integration false');
  // The one process: winget.exe by its located path, an argument array.
  const execs = (src) => (src.match(/exec\.Command(?:Context)?\(/g) ?? []).length;
  const swPath = goSw + goWin;
  check('software: the agent starts winget from exactly one place, with an argument array, and never a shell',
    execs(goWg) === 1 && /exec\.CommandContext\(ctx, r\.Path, args\.\.\.\)/.test(goWg) && execs(swPath) === 0 && !/"os\/exec"/.test(swPath)
      && !/cmd\.exe|cmd \/c|powershell|pwsh|ShellExecute|CreateProcess|\/bin\/sh/i.test(swPath + goWg.replace(/^\s*\/\/.*$/gm, '')) && !/strings\.Join\(|fmt\.Sprint|"\s*\+|\+\s*"/.test(goSw.slice(goSw.indexOf('func downloadArgs('), goSw.indexOf('// wingetVersion'))),
    'internal/winget is the only exec site (exec.CommandContext(ctx, r.Path, args...)); software.go and software_windows.go start nothing, and the argument lists are literals');
  const runs = [...goSw.matchAll(/o\.Winget\.Run\((.+?), swTimeout\(/g)].map((m) => m[1].trim());
  check('software: winget is only ever given --version or one of the three fixed argument lists',
    runs.length === 4 && runs.every((r) => ['[]string{"--version"}', 'downloadArgs(s, dir)', 'installArgs(s)', 'uninstallArgs(s)'].includes(r)),
    `o.Winget.Run arguments: ${runs.join(' | ')}`);
  const argFns = goSw.slice(goSw.indexOf('func downloadArgs('), goSw.indexOf('// wingetVersion'));
  check('software: no override, force, custom, location, manifest, header or hash-skipping flag; always --exact, --source winget, --scope machine',
    !/--ignore-security-hash|--force|--override|--custom|--location|--manifest|"-h"|--header|--rainbow|--ignore-local-archive-malware-scan|--allow-reboot/.test(goSw + goWin)
      && (argFns.match(/"--exact", "--source", "winget"/g) ?? []).length === 3 && (argFns.match(/"--scope", "machine"/g) ?? []).length === 3
      && /func installArgs[\s\S]{0,300}"--skip-dependencies"/.test(argFns) && /func downloadArgs[\s\S]{0,300}"--skip-dependencies"/.test(argFns),
    'the three lists must stay fixed: exact id from the winget source, machine scope, no dependencies, nothing that weakens winget\'s own checks');
  const iHash = goSw.indexOf('if got != s.InstallerSHA256 {'), iMan = goSw.indexOf('if !manifestDeclares(yamls, s.InstallerSHA256) {'), iInst = goSw.indexOf('o.Winget.Run(installArgs(s)');
  check('software: the agent hashes the downloaded installer itself and refuses a mismatch before installing',
    iHash > 0 && iMan > iHash && iInst > iMan && /if got != s\.InstallerSHA256 \{\s*r\.Outcome, r\.Reason, r\.Detail = "refused", "hash_mismatch",[^\n]*\n\s*return r/.test(goSw)
      && /if !manifestDeclares\(yamls, s\.InstallerSHA256\) \{\s*r\.Outcome, r\.Reason, r\.Detail = "refused", "manifest_hash_mismatch",[^\n]*\n\s*return r/.test(goSw)
      && /got, err := fileSHA256\(inst\)/.test(goSw) && /s, err := SoftwareParams\(p\.Params\) \/\/ verified already; checked again before use/.test(goSw),
    'Execute re-parses the params, computes the installer hash, refuses hash_mismatch / manifest_hash_mismatch, and only then runs install');
  check('software: the agent refuses when something else manages the computer\'s applications, before winget is asked anything',
    /if m := o\.Software\.AppManagers\(\); len\(m\) > 0 \{\s*obs\["managers"\][^\n]*\n\s*return &Result\{Outcome: "refused", Reason: "managed_elsewhere"/.test(goSw) && goSw.indexOf('o.Software.AppManagers()') < goSw.indexOf('wingetVersion(o)', goSw.indexOf('func softwarePrecheck(')),
    'softwarePrecheck must refuse managed_elsewhere before it locates or runs winget');
  // The portal side.
  const svc = read('apps/api/src/software/software.service.ts');
  const ctl = read('apps/api/src/software/software.controller.ts');
  const swDir = readdirSync(join(ROOT, 'apps/api/src/software')).filter((f) => f.endsWith('.ts')).map((f) => read(`apps/api/src/software/${f}`)).join('\n');
  check('software: a plan is made only by ActionsService.createPlan; nothing here writes jobs or talks to the signer itself',
    (svc.match(/this\.actions\.createPlan\(/g) ?? []).length === 2 && /async removeProgram\([\s\S]{0,2000}?this\.actions\.createPlan\(actor, \{\s*action: SOFTWARE_REMOVE,/.test(svc) && !/actionJob\.(create|update|upsert)|actionTarget\.(create|update|upsert)|signer\.submit|\/internal\/v1\/plans/.test(swDir),
    'requestRing must go through createPlan, which re-checks access, readiness and containment and submits to the signer');
  const routeList = [...ctl.matchAll(/@(Get|Post|Put|Patch|Delete)\('([^']*)'\)\s*(?:@HttpCode\([^)]*\)\s*)?@RequireCapability\(CAP\.([A-Z_]+)\)/g)].map((m) => [m[1], m[2], m[3]]);
  const allRoutes = [...ctl.matchAll(/@(?:Get|Post|Put|Patch|Delete)\('([^']*)'\)/g)].map((m) => m[1]);
  check('software: every route names its capability; there is no approve, sign or upload route',
    allRoutes.length === 21 && routeList.length === allRoutes.length && !allRoutes.some((r) => /approv|sign|upload|installer|file|blob|binary/i.test(r))
      && routeList.filter(([m, r]) => m === 'Post' && /^software\/(catalog|manifest-preview|winget\/(catalog|refresh))/.test(r)).every(([, , c]) => c === 'COMPUTERS_EDIT'),
    `routes: ${allRoutes.join(', ')}`);
  check('software: nothing in the software module accepts a file',
    !/FileInterceptor|FilesInterceptor|UploadedFile|multer|multipart|@Req\(\) req: Request\)[^{]*\{[^}]*req\.pipe|express\.raw/.test(swDir),
    'the portal never receives an installer: each computer downloads it with winget and checks the pinned hash');
  const method = (name) => svc.slice(svc.indexOf(`  async ${name}(`), svc.indexOf('\n  }\n', svc.indexOf(`  async ${name}(`)));
  const fresh = ['create', 'update', 'archive'].map((n) => { const b = method(n); const a = b.indexOf("assertFresh(freshMethod, { action: 'software.catalog' });"); const w = b.search(/this\.prisma\.softwareCatalogEntry\.(create|updateMany)\(/); const au = b.indexOf("action: 'SOFTWARE_CATALOG_"); return [n, a > 0 && w > a && au > w]; });
  check('software: adding, changing or archiving a catalog entry needs a fresh sign-in before the write, and is audited after it',
    // 0.40: the two request routes also pass this.fresh(req) on, for direct mode (§ 58).
    fresh.every(([, ok]) => ok) && (ctl.match(/this\.fresh\(req\)/g) ?? []).length === 9 && /requestRing\(actor, id, Number\(ring\), body, this\.fresh\(req\)\)/.test(ctl) && /single\(actor, id, entryId, operation, body, this\.fresh\(req\)\)/.test(ctl) && /this\.stepUp\.read\(req, u\.sub, u\.iat\)/.test(ctl),
    `per method: ${fresh.map(([n, ok]) => `${n}=${ok}`).join(', ')}`);
  check('software: only a business\'s own owner (not a technician) or a Platform Admin changes its entries; only an admin the global ones',
    /private canEdit\(actor: ActorContext, e: [^)]*\): boolean \{\s*if \(actor\.isPlatformAdmin\) return true;\s*if \(e\.scope === 'GLOBAL'\) return false;[\s\S]{0,120}return !actor\.technician && actor\.businessId === e\.customerId && this\.acl\.isBusinessOwner\(actor\);/.test(svc),
    'canEdit must keep the owner-in-person rule');
  check('software: another business\'s entry or deployment looks like a missing one',
    /if \(!e \|\| !this\.canRead\(actor, e\)\) throw new NotFoundException\('Catalog entry not found'\);/.test(svc)
      && /for \(const e of r\.endpointIds\) await this\.acl\.assertEndpointInScope\(actor, e\)\.catch\(\(\) => \{ throw new NotFoundException\('Deployment not found'\); \}\);/.test(svc),
    'entry() and scoped() must 404');
  check('software: a deployment\'s first ring is one computer and no ring exceeds the signed maximum',
    /if \(dto\.rings\[0\]\.length !== 1\) throw new BadRequestException\(\{ code: 'BAD_RINGS'/.test(svc) && /rings: z\.array\(z\.array\(Id\)\.min\(1\)\.max\(MAX_RING_TARGETS\)\)\.min\(1\)\.max\(MAX_SOFTWARE_RINGS\),/.test(read('apps/api/src/software/definition.ts')),
    'ring 0 is the canary; each ring at most MAX_RING_TARGETS (25)');
  const man = read('apps/api/src/software/manifest.ts');
  check('software: the manifest fetch is one bounded GET with no credentials, no redirects, and a loopback-only test override',
    /redirect: 'error', credentials: 'omit'/.test(man) && /signal: AbortSignal\.timeout\(10_000\)/.test(man) && /if \(n > MANIFEST_MAX_BYTES\)/.test(man)
      && /if \(o && \/\^http:\\\/\\\/127\\\.0\\\.0\\\.1:\[0-9\]\{2,5\}\(\\\/\[A-Za-z0-9\._\/-\]\*\)\?\$\/\.test\(o\)\)/.test(man)
      && /export const WINGET_PKGS_RAW = 'https:\/\/raw\.githubusercontent\.com\/microsoft\/winget-pkgs\/master\/manifests';/.test(read('apps/api/src/software/definition.ts')),
    'fetchInstallerManifest must stay bounded and WINGET_MANIFEST_BASE loopback-only');
}

// 41. AI providers (0.48 — reversing 0.34's "AI without a provider key", at
//     the owner's request). From 0.34 to 0.47 the API held no provider key
//     and the only AI was ClientSt0r's gateway. 0.48 lets a Platform Admin
//     store one provider key so "Ask AI" works with no ClientSt0r peer. What
//     keeps that safe is fixed here:
//       - provider endpoints, key headers and SDK names live only in
//         apps/api/src/ai/, and no provider SDK is a dependency;
//       - the one call site is ai/client.ts, through common/safe-https.ts
//         (resolved and checked on every call, connected to the checked
//         address, certificate verified, no redirects; plain http only to
//         127.0.0.1 under NODE_ENV=test);
//       - the key is AES-256-GCM under ENCRYPTION_KEY and is in no response,
//         audit row or log line; setting it is a Platform Admin's with
//         assertFresh, catalog key ai.settings (§ 62);
//       - every prompt is built from the server's own copy of the entry and
//         passes redactForAi (which ends in redactForPeer); the browser names
//         an entry and cannot supply text; AI_ASKED is written before it leaves.
//     The ClientSt0r device-timeline path (0.34) keeps its own checks below.
{
  const files = walk('apps/api/src');
  const PROVIDER = /@anthropic-ai\/|\bopenai\b|@google\/generative-ai|@google-cloud\/vertexai|@mistralai\/|cohere-ai|groq-sdk|\b(ANTHROPIC|OPENAI|AZURE_OPENAI|GEMINI|GOOGLE_AI|MISTRAL|COHERE|GROQ)_[A-Z_]*KEY\b|api\.anthropic\.com|api\.openai\.com|generativelanguage\.googleapis\.com|x-api-key|anthropic-version/i;
  const hits = files.filter((f) => PROVIDER.test(read(f)) && !f.startsWith('apps/api/src/ai/'));
  check('AI: provider endpoints, key headers and names appear only in apps/api/src/ai/', hits.length === 0, hits.join(', '));
  const pkg = JSON.parse(read('apps/api/package.json'));
  const deps = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies });
  const sdk = deps.filter((d) => /^(@anthropic-ai\/|openai$|@google\/generative-ai|@mistralai\/|cohere-ai$|groq-sdk$|@ai-sdk\/|ai$)/.test(d));
  check('apps/api/package.json depends on no model-provider SDK (plain HTTPS through safe-https)', sdk.length === 0, sdk.join(', '));
  const aiFiles = files.filter((f) => f.startsWith('apps/api/src/ai/'));
  const aiSrc = Object.fromEntries(aiFiles.map((f) => [f, read(f)]));
  const A = (n) => aiSrc[`apps/api/src/ai/${n}`] ?? '';
  const net = aiFiles.filter((f) => /\bfetch\(|\bhttps?\.request\(|axios|got\(|undici/.test(aiSrc[f]));
  check('AI: no fetch or raw request anywhere in ai/ — only safePost', net.length === 0, net.join(', '));
  const callers = aiFiles.filter((f) => /\bsafePost\(/.test(aiSrc[f]));
  check('AI: the one provider call site is ai/client.ts, through safePost, with the 60 s bound and a size cap',
    callers.length === 1 && callers[0].endsWith('/ai/client.ts') && /export const AI_TIMEOUT_MS = 60_000;/.test(A('client.ts')) && /safePost\(req\.url, req\.headers, req\.body, \{ timeoutMs: AI_TIMEOUT_MS, maxBytes: AI_MAX_RESPONSE \}\)/.test(A('client.ts')),
    `safePost callers: ${callers.join(', ')}`);
  // 0.56: and the warranty lookup client (warranty/client.ts), held to the same rule by § 69.
  // 0.80: and MDM drivers (mdm/drivers/), held to it by §90; in 0.80 only the loopback stand-in.
  // 0.81: and the backup drivers (backups/drivers/), held to the same rule by § 91.
  // 0.84: and common/safe-h2.ts (its URL check and error type), mdm/apple/apns.ts (the error type, §93) and
  //       mdm/apple/apple-enrollment.service.ts (testLoopbackAllowed for the test API's base), none of which calls safeGet/safePost.
  const H2_OK = ['apps/api/src/common/safe-h2.ts', 'apps/api/src/mdm/apple/apns.ts', 'apps/api/src/mdm/apple/apple-enrollment.service.ts'];
  const outside = files.filter((f) => /from '[./]*common\/safe-https'|from '\.\/safe-https'/.test(read(f))).filter((f) => !f.startsWith('apps/api/src/ai/') && f !== 'apps/api/src/psa/connectors/webhook.ts' && f !== 'apps/api/src/warranty/client.ts' && !f.startsWith('apps/api/src/mdm/drivers/') && !f.startsWith('apps/api/src/backups/drivers/')
    && !(H2_OK.includes(f) && !/\bsafe(Get|Post|Request)\(/.test(read(f))));
  check('AI/PSA/warranty/MDM/backups: only ai/, the PSA webhook connector, the warranty client, MDM drivers and the backup drivers use the typed-destination client', outside.length === 0, outside.join(', '));
  const sh = read('apps/api/src/common/safe-https.ts');
  const post = sh.slice(sh.indexOf('export async function safePost('));
  check('safe-https: the URL is checked, resolved, every address judged with no local allowance, and the checked address is what is connected to',
    post.indexOf('checkPublicHttpsUrl(rawUrl)') > 0 && post.indexOf('checkPublicHttpsUrl(rawUrl)') < post.indexOf('lookup(name, { all: true')
      && /const r = checkResolved\(addrs, 'none'\);/.test(post) && /address = r\.address;/.test(post) && /host: address,/.test(post)
      && /servername: name, rejectUnauthorized: true, minVersion: 'TLSv1\.2'/.test(post) && /agent: false as const/.test(post),
    'safePost: checkPublicHttpsUrl, lookup all, checkResolved(…, none), host: address, servername: name, rejectUnauthorized');
  check('safe-https: redirects are refused, never followed; the response is capped',
    /if \(status >= 300 && status < 400\) \{ res\.destroy\(\); return done\(\(\) => reject\(new OutboundError\('REDIRECT_REFUSED'/.test(post) && /if \(total > opts\.maxBytes\)/.test(post), 'a 3xx must reject; the body must be capped');
  check('safe-https: plain http only to 127.0.0.1 and only under NODE_ENV=test; https, public DNS names otherwise',
    /return process\.env\.NODE_ENV === 'test' && TEST_LOOPBACK\.test\(base\) && \(q < 0 \|\| TEST_QUERY\.test\(raw\.slice\(q \+ 1\)\)\);/.test(sh) && /const TEST_QUERY = \/\^\[A-Za-z0-9\._~=&-\]\{0,200\}\$\/;/.test(sh) && /const TEST_LOOPBACK = \/\^http:\\\/\\\/127\\\.0\\\.0\\\.1:\[0-9\]\{2,5\}/.test(sh)
      && /if \(u\.protocol !== 'https:'\) return \{ ok: false/.test(sh) && /if \(isIP\(h\)\) return \{ ok: false/.test(sh) && /INTERNAL_SUFFIX\.test\(h\)\) \{\s*\n\s*return \{ ok: false/.test(sh),
    'checkPublicHttpsUrl must refuse http, IP literals, localhost and internal names; the loopback exception must stay test-only');
  check('AI: AI_TEST_BASE_URL is honoured only through testLoopbackAllowed',
    /const v = process\.env\.AI_TEST_BASE_URL;\s*\n\s*return v && testLoopbackAllowed\(v\)/.test(A('providers.ts')) && (A('providers.ts').match(/AI_TEST_BASE_URL/g) ?? []).length <= 3,
    'providers.ts testBase()');
  const set = A('ai-settings.service.ts');
  check('AI: the key is sealed with its own purpose and only its last four characters are kept in the clear',
    /apiKeyEnc = sealSecret\(this\.encKey, 'rem0te-ai-key-v1', d\.data\.apiKey\); apiKeyLast4 = last4\(d\.data\.apiKey\);/.test(set) && /createCipheriv\('aes-256-gcm'/.test(read('apps/api/src/common/secret-box.ts')) && /c\.setAAD\(Buffer\.from\(purpose\)\)/.test(read('apps/api/src/common/secret-box.ts')),
    'ai-settings.service put(): sealSecret(…, rem0te-ai-key-v1, …)');
  const view = set.slice(set.indexOf('  view(s: AiSettings | null) {'), set.indexOf('  async get()'));
  const statusFn = set.slice(set.indexOf('  async status() {'), set.indexOf('  async put('));
  check('AI: no response carries the key or its ciphertext (view and status)', view.length > 100 && !/apiKeyEnc:|apiKey:|\.\.\.s\b/.test(view) && !/apiKey|baseUrl:/.test(statusFn.replace('!!s.apiKeyEnc', '')), 'view() / status() must not spread the row or name the key');
  const putFn = set.slice(set.indexOf('  async put('), set.indexOf('  async active('));
  check('AI: the settings audit says only whether the key changed; a moved destination drops the key',
    /meta: \{ before: pub\(cur\), after: pub\(row\), key: keyChange \}/.test(putFn) && /const pub = \(s: AiSettings \| null\) => s && \{ enabled: s\.enabled, provider: s\.provider, model: s\.model, baseUrl: s\.baseUrl, authStyle: s\.authStyle \};/.test(putFn)
      && /else if \(cur\?\.apiKeyEnc && moved\) \{ apiKeyEnc = null;/.test(putFn),
    'AI_SETTINGS_CHANGED meta must be before/after without the key, and changing provider/baseUrl/authStyle must clear it');
  check('AI: nothing in ai/ logs (no Logger, no console)', aiFiles.every((f) => !/new Logger\(|console\.|this\.log(ger)?\./.test(aiSrc[f])), aiFiles.filter((f) => /new Logger\(|console\./.test(aiSrc[f])).join(', '));
  const ctl = A('ai.controller.ts');
  check('AI: setting the provider or key is a Platform Admin\'s (class guard) with assertFresh first, naming ai.settings',
    /@Controller\('ai\/settings'\)\s*\n@UseGuards\(PlatformAdminGuard\)/.test(ctl) && /@Put\(\)\s*\n\s*@RateLimit\(20\)\s*\n\s*async put\([^\n]*\) \{\s*\n\s*const u = [^\n]*\n\s*assertFresh\([^\n]*\{ action: 'ai\.settings'/.test(ctl),
    'AiSettingsController: PlatformAdminGuard at class level, assertFresh first in put() with its catalog key (0.49, § 62)');
  const svcAi = A('ai.service.ts');
  const ask = svcAi.slice(svcAi.indexOf('  async ask('), svcAi.indexOf('  async preview('));
  const pcalls = [...aiFiles].flatMap((f) => [...aiSrc[f].matchAll(/await callProvider\(([^;]*)\);/g)].map((m) => `${f.split('/').pop()}: ${m[1]}`));
  check('AI: every prompt is the fixed system prompt and the redacted payload (or the fixed test prompt)',
    pcalls.length === 2 && pcalls.includes('ai.service.ts: cfg, key, SYSTEM_PROMPT, userPrompt(src.payload.text)') && pcalls.includes('ai-settings.service.ts: cfg, key, TEST_SYSTEM, TEST_USER, 16'),
    `callProvider calls: ${pcalls.join(' | ')}`);
  const red = A('redact.ts');
  check('AI: the payload is built only by eventPayload/alertPayload, through redactForAi, which ends in redactForPeer',
    /payload: eventPayload\(event, endpoint\.osVersion, names\)/.test(svcAi) && /payload: alertPayload\(alert, endpoint\.osVersion, names\)/.test(svcAi)
      && /const message = redactForAi\(/.test(red) && /const peer = redactForPeer\(s, counts\);/.test(red) && /export const INPUT_CAP = 8000;/.test(red)
      && !/name: true[^}]*\}\s*,?\s*payload/.test(svcAi),
    'resolveSource → eventPayload/alertPayload → redactForAi → redactForPeer');
  check('AI: the browser names an entry and cannot supply text (strict source objects)',
    /z\.object\(\{ source: z\.literal\('event'\), commandId: z\.string\(\)\.regex\([^)]*\), index: z\.number\(\)\.int\(\)\.min\(0\)\.max\(999\) \}\)\.strict\(\)/.test(svcAi) && /z\.object\(\{ source: z\.literal\('alert'\), alertId: z\.string\(\)\.regex\([^)]*\) \}\)\.strict\(\)/.test(svcAi),
    'SourceInput must stay two strict objects of ids');
  check('AI: scope, then the entry\'s own capability (event logs / alerts), before anything is read',
    /const ep = await this\.acl\.assertEndpointInScope\(actor, endpointId, CAP\.COMPUTERS_VIEW\);/.test(svcAi) && /assertEndpointInScope\(actor, endpointId, CAP\.COMPUTERS_EVENT_LOGS\);\s*\n\s*this\.acl\.assertCapability\(actor, CAP\.COMPUTERS_EVENT_LOGS\);/.test(svcAi) && /this\.acl\.assertCapability\(actor, CAP\.ALERTS_VIEW\);/.test(svcAi),
    'resolveSource checks');
  check('AI: AI_ASKED is written (logOrFail) before the request leaves; audit meta never carries text',
    ask.indexOf("await this.audit.logOrFail({ ...base, action: 'AI_ASKED'") > 0 && ask.indexOf("await this.audit.logOrFail({ ...base, action: 'AI_ASKED'") < ask.indexOf('callProvider(')
      && ![...ask.matchAll(/meta: \{([^}]*)\}/g)].some((m) => /(^|[\s,{])answer\s*[,:}]|answer\.text|text|message|prompt/.test(m[1])),
    'ask(): logOrFail(AI_ASKED) before callProvider; no answer/text in meta');
  check('AI: a per-user budget, besides the route limit',
    /private readonly budget = new UserBudget\(/.test(svcAi) && /if \(!this\.budget\.take\(actor\.userId\)\)/.test(ask) && /@RateLimit\(10\)\s*\n\s*async explain/.test(ctl), 'AiService budget + @RateLimit on explain');
  const psa = read('apps/api/src/psa/psa.service.ts'), wh = read('apps/api/src/psa/connectors/webhook.ts'), pctl = read('apps/api/src/psa/psa.controller.ts');
  const create = psa.slice(psa.indexOf('  async create('));
  check('PSA: a ticket needs scope and the entry\'s capability (resolveSource), tickets:create, the budget and no notifications pause, before the send',
    create.indexOf('this.ai.resolveSource(') > 0 && create.indexOf('this.acl.assertCapability(a, CAP.TICKETS_CREATE)') > create.indexOf('this.ai.resolveSource(')
      && create.indexOf("activePause(this.prisma, 'notifications'") > create.indexOf('CAP.TICKETS_CREATE') && create.indexOf('drv.send(') > create.indexOf("activePause(this.prisma, 'notifications'")
      && /this\.budget\.take\(a\.userId\)/.test(create),
    'PsaService.create order');
  check('PSA: the ticket audit carries ids, the kind and the reference — never the subject, note or body',
    ![...create.matchAll(/meta: \{([^}]*)\}/g)].some((m) => /subject|body|draft\.note\b|note:|text/.test(m[1])) && /action: 'PSA_TICKET_CREATED', meta: \{ \.\.\.ids, ticketId: ticket\.id, ref: ticket\.ref/.test(create),
    'PSA_TICKET_CREATED / _FAILED meta');
  check('PSA: connector writes need fresh authentication, naming psa.connector',
    (pctl.match(/fresh\(this\.stepUp, req\);/g) ?? []).length === 2 && /assertFresh\(u\?\.sub[^\n]*\{ action: 'psa\.connector'/.test(pctl), 'PsaConnectorsController put/remove (catalog key psa.connector, § 62)');
  check('PSA: the webhook secret is sealed, kept only for the same URL, and never shown; only the host is shown or audited',
    /enc = sealSecret\(deps\.encKey, 'rem0te-psa-webhook-secret-v1', given\)/.test(wh) && /else if \(cur\?\.webhookSecretEnc && cur\.webhookUrl === url\)/.test(wh)
      && /return \{ webhookHost: hostOf\(row\.webhookUrl\), webhookUrlSet: !!row\.webhookUrl, signed: !!row\.webhookSecretEnc \};/.test(wh) && /audit: \{ host: c\.url\.host, secret: change \}/.test(wh),
    'webhook driver');
  check('PSA: the webhook URL obeys the typed-destination rule and is sent only through safePost',
    /const c = checkPublicHttpsUrl\(raw\.webhookUrl, 'The webhook URL'\);/.test(wh) && /safePost\(row\.webhookUrl, headers, body,/.test(wh) && !/\bfetch\(/.test(wh), 'webhook driver');
  const mig = read('apps/api/prisma/migrations/0070_ai_psa/migration.sql');
  check('0070 CHECKs the provider, the connector kind and the scope',
    /CHECK \("provider" IN \('anthropic', 'openai', 'openai_compatible'\)\)/.test(mig) && /CHECK \("kind" IN \('email', 'webhook', 'clientst0r'\)\)/.test(mig) && /"PsaConnector_scope" CHECK/.test(mig),
    'migration 0070');
  const eml = read('apps/api/src/psa/connectors/email.ts');
  check('PSA: email-to-ticket goes only to a confirmed recipient of the connector\'s own scope, through EmailService',
    /deps\.email\.sendToRecipients\(\[row\.emailRecipientId \?\? ''\], row\.scopeKey,/.test(eml) && /if \(!r\.verifiedAt\) return \{ ok: false/.test(eml) && !/createTransport|nodemailer/.test(eml), 'email driver');

  // The ClientSt0r device-timeline summary (0.34) still holds every rule it had.
  const svc = read('apps/api/src/integration/timeline.service.ts');
  const cli = read('apps/api/src/integration/timeline.client.ts');
  const signer = read('apps/api/src/integration/signer.ts');
  const writers = files.filter((f) => [...read(f).matchAll(/aiTimeline:\s*([^,}\s]+)/g)].some((m) => m[1] !== 'true' && m[1] !== 'dto.aiTimeline'));
  check('the stored AI summary is written from a model only by timeline.service.ts',
    writers.length === 1 && writers[0].endsWith('integration/timeline.service.ts') && /data: \{ aiTimeline: result\.summary \}/.test(svc),
    `aiTimeline writers: ${writers.join(', ')} (the PATCH route's dto.aiTimeline is a person's edit and is allowed)`);
  check('the summary request goes only through the integration client, to the peer\'s inference URL',
    /from '\.\/timeline\.client'/.test(svc) && /signedPost\(peer, 'inference', JSON\.stringify\(request\)/.test(cli) && !/\bfetch\(/.test(svc + cli),
    'timeline.service → timeline.client.requestTimeline → signer.signedPost(peer, "inference")');
  check('the peer\'s capabilities document is fetched only from the peers file\'s capabilitiesUrl, signed, with redirects refused',
    /export async function signedGetCapabilities\(peer: Peer[^)]*\)[^{]*\{\n\s*const url = peer\.capabilitiesUrl;/.test(signer) && /redirect: 'error'/.test(signer),
    'signedGetCapabilities must take its URL from peer.capabilitiesUrl');
  const gate = svc.slice(svc.indexOf('async gate('), svc.indexOf('async status('));
  check('containment is asked before the peer is contacted at all',
    gate.indexOf("activePause(this.prisma, 'integration'") > 0 && gate.indexOf("activePause(this.prisma, 'integration'") < gate.indexOf('this.peerCaps('),
    "gate() must call activePause('integration') before peerCaps()");
  check('nothing is sent until the peer advertises device_timeline_v1 with a profile the peers file allows',
    /inference_tasks\.find\(\(t\) => t\.task === TIMELINE_TASK\)/.test(gate) && /peer\.modelProfiles\.includes\(p\)/.test(gate),
    'gate() must require the task in the peer capabilities and intersect profiles with the peers file');
  const gen = svc.slice(svc.indexOf('async generate('));
  check('generate needs computers:edit and integration:ticket_analysis, checked after scope and before the gate',
    /assertEndpointInScope\(actor, id, CAP\.COMPUTERS_EDIT\)/.test(gen) && /!this\.acl\.can\(actor, CAP\.COMPUTERS_EDIT\) \|\| !this\.acl\.can\(actor, CAP\.TICKET_ANALYSIS\)/.test(gen)
      && gen.indexOf('!this.acl.can(actor, CAP.TICKET_ANALYSIS)') < gen.indexOf('this.gate('),
    'scope, then both capabilities, then the gate');
  check('every request is audited before it leaves, and the audit carries no text',
    gen.indexOf("action: 'AI_TIMELINE_REQUESTED'") > 0 && /await this\.audit\.logOrFail\(\{\s*\.\.\.base, action: 'AI_TIMELINE_REQUESTED'/.test(gen)
      && gen.indexOf('logOrFail') < gen.indexOf('requestTimeline(') && !/meta: \{[^}]*(segments|content|text|summary:)/.test(gen),
    'logOrFail(AI_TIMELINE_REQUESTED) before requestTimeline(); no segments/content/text/summary in audit meta');
  const snap = svc.slice(svc.indexOf('private async snapshot('), svc.indexOf('private async peerCaps('));
  const forbidden = ['name:', 'hostname:', 'ipAddress', 'customer', 'site', 'tags', 'author', 'contactName', 'contactEmail', 'notes: true', 'technician', 'rustdesk', 'inventory'];
  const selected = forbidden.filter((f) => snap.includes(f));
  check('the summary reads only the fields it sends: no name, hostname, address, business, site, tags, authors, contacts or RustDesk',
    snap.length > 200 && selected.length === 0 && /noteRels: \{.*select: \{ createdAt: true, content: true, isPinned: true \} \}/.test(snap), `reads: ${selected.join(', ') || '(note select changed)'}`);
  const tl = read('apps/api/src/integration/timeline.ts');
  check('every free-text field passes redactForPeer before it is sent',
    /redactForPeer\(n\.content(\.slice\([^)]*\))?, counts\)/.test(tl) && /redactForPeer\(s\.issueDescription(\.slice\([^)]*\))?, counts\)/.test(tl) && /redactForPeer\(s\.disposition(\.slice\([^)]*\))?, counts\)/.test(tl)
      && !/\$\{n\.content\}|\$\{s\.issueDescription\}|\$\{s\.disposition\}/.test(tl),
    'notes, session issue and resolution must go through redactForPeer()');
  const contract = read('apps/api/src/integration/contract.ts');
  const agreed = contract.slice(contract.indexOf('export const CONTRACT_SCHEMAS = {'), contract.indexOf('} as const;', contract.indexOf('export const CONTRACT_SCHEMAS = {')));
  check('the proposed timeline operation is not presented as agreed contract',
    !/timeline|peer-capabilities/.test(agreed) && /export const CONTRACT_REVISION = 2 as const;/.test(contract) && /PROPOSED, revision 4/.test(contract),
    'P11/P12 stay in PROPOSED_SCHEMAS until ClientSt0r acknowledges them (INTEGRATION_COORDINATION.md §9)');
}

// 42. Outbound email (0.34). Mail leaves for good, so: the relay is a Platform
//     Admin's, changed with fresh authentication; its host is a public DNS
//     name checked on save AND resolved and checked on send, the connection
//     made to the checked address (SSRF and DNS rebinding); plaintext only to
//     loopback; nothing in a message is read from disk or a URL. Mail goes
//     only to recipients confirmed by their mailbox, of the policy's or
//     schedule's own scope, added and removed with fresh authentication; the
//     confirmation token is consumed conditionally. The relay password is in
//     no audit row, response or log line, and pointing the relay elsewhere
//     drops it. A `notifications` pause stops every send. A scheduled report
//     is claimed (unique per period) before it is sent, and its owner's
//     access is rebuilt from the database before anything is produced.
//     0.49 (§ 62, at the owner's request): every "fresh authentication" here
//     is a step-up that names its catalog key (email.relay / email.recipients / reports.schedule); a Platform Admin
//     may turn a key off under Settings → Confirm it is you. Until 0.49 it
//     could not be configured.
{
  const ctl = read('apps/api/src/email/email.controller.ts');
  const svc = read('apps/api/src/email/email.service.ts');
  const host = read('apps/api/src/email/smtp-host.ts');
  const smtpCtl = ctl.slice(ctl.indexOf("@Controller('email/settings')"), ctl.indexOf("@Controller('email')"));
  check('the SMTP relay settings are Platform Admin only and saving them needs fresh authentication',
    /@UseGuards\(PlatformAdminGuard\)\s*export class SmtpSettingsController/.test(smtpCtl) && /@Put\(\)[\s\S]{0,200}fresh\(this\.stepUp, req, 'email\.relay'\)/.test(smtpCtl) && /assertFresh\(/.test(ctl),
    'SmtpSettingsController must carry PlatformAdminGuard, and PUT must call fresh()');
  const rcpCtl = ctl.slice(ctl.indexOf("@Controller('email')"));
  check('adding, re-sending to and removing an email recipient need fresh authentication',
    /@Post\('recipients'\)[\s\S]{0,200}fresh\(this\.stepUp, req, 'email\.recipients'\)/.test(rcpCtl) && /@Post\('recipients\/:id\/resend'\)[\s\S]{0,250}fresh\(this\.stepUp, req, 'email\.recipients'\)/.test(rcpCtl) && /@Delete\('recipients\/:id'\)[\s\S]{0,200}fresh\(this\.stepUp, req, 'email\.recipients'\)/.test(rcpCtl),
    'POST recipients, POST recipients/:id/resend and DELETE recipients/:id must call fresh()');
  const sch = read('apps/api/src/reports/report-schedules.controller.ts');
  check('creating or changing a scheduled report needs fresh authentication',
    /@Post\(\)[\s\S]{0,200}this\.fresh\(req\)/.test(sch) && /@Patch\(':id'\)[\s\S]{0,250}this\.fresh\(req\)/.test(sch) && /assertFresh\(/.test(sch),
    'POST and PATCH reports/schedules must call assertFresh');
  check('the SMTP host must be a public DNS name unless the operator allows a local relay',
    /if \(c === 'public'\) return \{ ok: false/.test(host) && /if \(!h\.includes\('\.'\) \|\| INTERNAL_SUFFIX\.test\(h\)\)/.test(host)
      && /if \(a === 0 \|\| \(a === 169 && b === 254\) \|\| a >= 224\) return 'blocked'/.test(host) && /process\.env\.SMTP_ALLOW_LOCAL_RELAY/.test(host)
      && /const h = checkSmtpHostName\(d\.data\.host\);\s*if \(!h\.ok\) throw/.test(svc),
    'checkSmtpHostName must refuse IP literals, internal names and link-local; putSettings must call it');
  const send = svc.slice(svc.indexOf('async send('), svc.indexOf('private errorCode('));
  check('every send resolves the relay, checks every address, and connects to the checked one',
    /for \(const a of addresses\) \{\s*const c = classifyAddress\(a\);\s*if \(!addressAllowed\(c, allow\)\) return \{ ok: false/.test(host)
      && /await lookup\(h\.host, \{ all: true/.test(send) && /const r = checkResolved\(addresses, allow\);\s*if \(!r\.ok\)/.test(send) && /host: r\.address,/.test(send) && /servername: h\.host/.test(send),
    'send() must lookup → checkResolved(all addresses) → createTransport({ host: r.address, tls.servername: name })');
  check('plaintext SMTP only to loopback, TLS certificates always verified',
    /return mode !== 'none' \|\| isLoopback;/.test(host) && /tlsModeAllowed\(d\.data\.tlsMode, loop\)/.test(svc) && /tlsModeAllowed\(s\.tlsMode as TlsMode, r\.loopback\)/.test(send)
      && /rejectUnauthorized: true/.test(send) && /requireTLS: s\.tlsMode === 'starttls'/.test(send),
    'tlsModeAllowed on save and on send (with the resolved address); rejectUnauthorized true; STARTTLS required, never opportunistic');
  check('nothing in a message is read from disk or fetched from a URL',
    /disableFileAccess: true, disableUrlAccess: true/.test(send), 'createTransport must set disableFileAccess and disableUrlAccess');
  check('a `notifications` containment pause stops every send',
    /'notifications'\] as const/.test(read('apps/api/src/containment/pause.ts')) && /activePause\(this\.prisma, 'notifications', opts\.customerId\);\s*if \(pause\) return all\('contained'\)/.test(send)
      && /activePause\(this\.prisma, 'notifications', s\.customerId\)/.test(read('apps/api/src/reports/report-schedules.service.ts')),
    'send() and the schedule delivery must consult the notifications pause');
  check('mail goes only to recipients confirmed in the right scope',
    /emailRecipient\.findMany\(\{ where: \{ id: \{ in: ids \}, scopeKey, verifiedAt: \{ not: null \} \} \}\)/.test(svc)
      && /await this\.email\.assertConfirmed\(emailIds, scopeKey\)/.test(read('apps/api/src/monitoring/monitoring-admin.service.ts'))
      && /await this\.email\.assertConfirmed\(d\.data\.recipientIds, s\.scopeKey\)/.test(read('apps/api/src/reports/report-schedules.service.ts'))
      && /this\.email\.sendToRecipients\(\[d\.recipientId\], scopeKey/.test(read('apps/api/src/monitoring/monitoring.service.ts')),
    'sendToRecipients must filter on scopeKey + verifiedAt; putPolicy and schedules must assertConfirmed; alert mail must go through sendToRecipients');
  const ver = svc.slice(svc.indexOf('async verify('), svc.indexOf('async assertConfirmed('));
  check('a confirmation link is consumed conditionally, and a GET never confirms',
    /updateMany\(\{ where: \{ tokenHash: hash, verifiedAt: null, tokenExpiresAt: \{ gt: now \} \}/.test(ver) && /if \(!u\.count/.test(ver)
      && /@Post\('verify'\)\s*@Public\(\)/.test(ctl) && !/@Get\('verify/.test(ctl),
    'verify must updateMany on (token, unverified, unexpired) and check the count; only POST verify is public');
  const put = svc.slice(svc.indexOf('async putSettings('), svc.indexOf('async sendTest('));
  const auditCall = put.slice(put.indexOf("action: 'SMTP_SETTINGS_CHANGED'"), put.indexOf('return {', put.indexOf("action: 'SMTP_SETTINGS_CHANGED'")));
  check('the relay password is in no audit row, response or log line',
    auditCall.length > 50 && !/passwordEnc|d\.data\.password|\bpass\b/.test(auditCall) && /password: passwordChange/.test(auditCall)
      && !/passwordEnc/.test(svc.slice(svc.indexOf('private settingsView('), svc.indexOf('async getSettings(')).replace('passwordSet: !!s.passwordEnc', ''))
      && !/this\.log\.[a-z]+\([^)]*(pass|password)/.test(svc) && !/\.message\b|\.response\b/.test(svc.slice(svc.indexOf('private errorCode('), svc.indexOf('async sendToRecipients('))),
    'audit only whether the password changed; the view only passwordSet; errorCode must not echo the server\'s text');
  check('pointing the relay elsewhere drops the saved password',
    /else if \(cur\?\.passwordEnc && relayMoved\) \{ passwordEnc = null;/.test(put) && /cur\.host !== h\.host \|\| cur\.port !== d\.data\.port/.test(put),
    'a change of host, port, username or TLS mode must clear passwordEnc unless a new password is given');
  const rs = read('apps/api/src/reports/report-schedules.service.ts');
  const run = rs.slice(rs.indexOf('private async runOne('), rs.indexOf('private async finish('));
  check('a scheduled report is claimed once per period before anything is sent',
    /CREATE UNIQUE INDEX "ReportDelivery_scheduleId_periodKey_key" ON "ReportDelivery"\("scheduleId", "periodKey"\)/.test(read('apps/api/prisma/migrations/0054_outbound_email/migration.sql'))
      && run.indexOf('reportDelivery.create(') > 0 && run.indexOf('reportDelivery.create(') < run.indexOf('this.deliver(') && /'P2002'\) return;/.test(run),
    'runOne must create the (schedule, period) delivery row first and return on a unique violation');
  const del = rs.slice(rs.indexOf('private async deliver('), rs.indexOf('private ownerRefusal('));
  check('a scheduled report is evaluated as its owner, re-checked from the database at send',
    /const actor = await this\.actors\.contextFor\(s\.ownerId/.test(del) && del.indexOf('this.ownerRefusal(actor, s)') < del.indexOf('this.reports.exportCsv(') && /if \(refusal\) \{[\s\S]{0,600}enabled: false/.test(del)
      && /this\.reports\.exportCsv\(actor!, report, q, \{ scheduleId: s\.id/.test(del),
    'deliver must rebuild the owner (contextFor), refuse before exporting and switch the schedule off; the CSV is the audited exportCsv');
  const mon = read('apps/api/src/monitoring/monitoring.service.ts');
  const am = mon.slice(mon.indexOf('const mail = alertMail({'), mon.indexOf("}, type, `${this.urls.web()}/alerts"));
  const content = read('apps/api/src/email/mail-content.ts');
  const alertFn = content.slice(content.indexOf('export function alertMail('), content.indexOf('export const REPORT_TITLE'));
  check('an alert email carries the title, computer, business and a link — not the detail or a hostname',
    am.length > 50 && !/detail|hostname|ticket/.test(am) && !/\.detail|hostname/.test(alertFn) && /oneLine\(/.test(alertFn),
    'alertMail must be built from the listed fields only, each through oneLine()');
}

// 43. Agent upgrade from the console (0.34). One computer can be moved from
//     the standard agent to the signed agent, or have its agent updated. A
//     per-computer migration is allowed without independent review because a
//     standard agent already runs whatever reinstall the portal hands it — so
//     it must stay exactly that: it never writes the platform's update-trust
//     mode, it is refused (and held, and served nothing) in Signed only
//     without portal migration, the script it serves always pins the digest
//     of the signed agent the offline-signed repository lists, only the
//     requesting computer's authenticated heartbeat is handed its nonce, the
//     request needs a fresh sign-in (single and bulk) and computers:edit, and
//     an updates pause holds it like every other update flag.
//     0.49 (§ 62, at the owner's request): every "fresh authentication" here
//     is a step-up that names its catalog key (agent.migrate); a Platform Admin
//     may turn a key off under Settings → Confirm it is you. Until 0.49 it
//     could not be configured.
{
  const mig = read('apps/api/src/update-trust/agent-migration.ts');
  const msvc = read('apps/api/src/update-trust/agent-migration.service.ts');
  const usvc = read('apps/api/src/agent-upgrade/agent-upgrade.service.ts');
  const uctl = read('apps/api/src/agent-upgrade/agent-upgrade.controller.ts');
  check('a per-computer migration never writes the update-trust mode',
    ![msvc, usvc].some((t) => /platformSettings\s*\.\s*(update|upsert|create|updateMany)\b|\.setMode\(|trust\.request\(|updateTrustMode\s*:|\$execute/.test(t)),
    'agent-migration.service.ts / agent-upgrade.service.ts must not write PlatformSettings or request a trust change');
  const build = mig.slice(mig.indexOf('export function buildMigrationScript('), mig.indexOf('export const MIGRATION_UNAVAILABLE'));
  check('the migration script pins and checks the signed agent digest',
    /!\/\^\[0-9a-f\]\{64\}\$\/\.test\(agentSha256\)/.test(build) && /targets\/windows\/\$\{agentSha256\}\.rem0te-agent\.exe/.test(build)
      && /\(Get-FileHash -Algorithm SHA256 -LiteralPath \$exe\)\.Hash\.ToLower\(\) -ne '\$\{agentSha256\}'\) \{ Remove-Item -LiteralPath \$exe -Force; exit 12 \}/.test(build)
      && build.indexOf('Get-FileHash') < build.indexOf('& $exe migrate'),
    'buildMigrationScript must validate the digest, download by it, and refuse a mismatch before running migrate');
  // 0.38: the Agent card's run-it-yourself command is the same check, in one line.
  const local = mig.slice(mig.indexOf('export function buildLocalMigrationCommand('));
  check('the local migration command pins and checks the signed agent digest',
    /!\/\^\[0-9a-f\]\{64\}\$\/\.test\(agentSha256\)/.test(local) && /!validPortalHost\(portalHost\)/.test(local)
      && /targets\/windows\/\$\{agentSha256\}\.rem0te-agent\.exe/.test(local)
      && /\(Get-FileHash -Algorithm SHA256 -LiteralPath \$e\)\.Hash\.ToLower\(\) -ne '\$\{agentSha256\}'\) \{ Remove-Item -LiteralPath \$e -Force;/.test(local)
      && local.indexOf('Get-FileHash') < local.indexOf('& $e migrate')
      && /migration\.local = \{ command: buildLocalMigrationCommand\(host, served\.sha256\), stuck \}/.test(usvc),
    'buildLocalMigrationCommand validates host and digest, downloads by it and refuses a mismatch before migrate; the card builds it from the served target');
  // 0.39: Add device's one-liner installs the full agent for a new computer.
  const sis = mig.slice(mig.indexOf('export function buildSignedInstallScript('));
  const pubc = read('apps/api/src/public/public.controller.ts');
  check('the new-computer install script pins the published digest, checks it first, and is served only for a valid unclaimed token',
    /!\/\^\[0-9a-f\]\{64\}\$\/\.test\(agentSha256\)/.test(sis) && /!\/\^\[A-Fa-f0-9\]\{16,128\}\$\/\.test\(claimToken\)/.test(sis) && /!validPortalHost\(portalHost\)/.test(sis)
      && sis.indexOf('Get-FileHash') < sis.indexOf('& $e install') && /Remove-Item -LiteralPath \$e -Force/.test(sis) && !/^\s*exit\b/m.test(sis.slice(sis.indexOf('return `')))
      && /if \(validatedToken && !jobNonce\) \{\s*const agentT = this\.updateTrust\.agentTarget\(\);/.test(pubc)
      // 0.65: the lookup moved into usableToken, shared with windows.msi.
      && /if \(tokenRecord\) return !tokenRecord\.claimedAt && tokenRecord\.expiresAt >= new Date\(\);/.test(pubc)
      && /const validatedToken = enrollToken && \(await this\.usableToken\(enrollToken\)\) \? enrollToken : undefined;/.test(pubc)
      && /res\.send\(buildSignedInstallScript\(portalHost, agentT\.sha256, validatedToken\)\)/.test(pubc),
    'buildSignedInstallScript validates host, digest and token, hashes before install, never exits; served only when the token is validated (unclaimed, unexpired) and not for a rollout nonce');
  const sfn = msvc.slice(msvc.indexOf('async scriptForNonce('));
  check('the served script takes its digest from the signed repository, at the moment it is fetched',
    /const agent = this\.updateTrust\.agentTarget\(\);/.test(sfn) && /return buildMigrationScript\(host, agent\.sha256\);/.test(sfn) && !/sha256\s*:/.test(read('apps/api/prisma/migrations/0055_agent_migration/migration.sql')),
    'scriptForNonce must pin updateTrust.agentTarget().sha256 (no stored digest)');
  const pub = read('apps/api/src/public/public.controller.ts');
  check('windows.ps1 serves a migration only for an open migration nonce',
    /if \(updateNonce && !jobNonce\) \{\s*const mig = await this\.agentMigration\.scriptForNonce\(updateNonce\);/.test(pub)
      && /MIGRATION_NONCE_RE\.test\(nonce\)/.test(sfn) && /where: \{ nonce, \.\.\.OPEN \}/.test(sfn),
    'the nonce branch must go through scriptForNonce, which matches only open requests');
  check('Signed only without portal migration: refused, held and served nothing',
    /\n\s*if \(f\.mode === 'signed_only' && !f\.legacyPortalMigration\) \{\s*return \{\s*code: 'SIGNED_ONLY'/.test(mig)
      && /const allowed = mode\.mode === 'legacy_allowed' \|\| mode\.legacyPortalMigration;\s*if \(!allowed \|\| !agent \|\| !host\) return MIGRATION_UNAVAILABLE;/.test(sfn)
      && /i\.updatesHeld \? 'contained'\s*: i\.gate === 'withhold' \? 'signed_only'/.test(msvc)
      && !/Invoke-|iex|Start-|&\s*\$/.test(mig.slice(mig.indexOf('export const MIGRATION_UNAVAILABLE'), mig.indexOf('export const MIGRATION_NONCE_RE'))),
    'migrationBlock, scriptForNonce and forHeartbeat must each keep the Signed only boundary; MIGRATION_UNAVAILABLE runs nothing');
  const enr = read('apps/api/src/enrollment/enrollment.service.ts');
  const step = enr.slice(enr.indexOf('// Per-computer migration to the signed agent (0.34).'), enr.indexOf('// v0.28: updates paused everywhere or for this business.'));
  const fh = msvc.slice(msvc.indexOf('async forHeartbeat('), msvc.indexOf('async scriptForNonce('));
  check('only the requesting computer\'s authenticated heartbeat is handed its nonce, before the updates-pause null',
    step.length > 200 && /if \(authenticated\) \{\s*try \{\s*const mig = await this\.agentMigration\.forHeartbeat\(\{\s*endpointId: node\.endpointId,/.test(step)
      && /updatesHeld, rolloutManaged,/.test(step) && /const open = await this\.openFor\(i\.endpointId\);/.test(fh)
      && /openFor\(endpointId: string\) \{\s*return this\.prisma\.agentMigration\.findFirst\(\{ where: \{ endpointId, \.\.\.OPEN \} \}\);/.test(msvc)
      && /if \(updatesHeld\) \{\s*updateRustdesk = null;\s*reinstallAgent = null;/.test(enr.slice(enr.indexOf('// v0.28: updates paused everywhere'))),
    'forHeartbeat must run under authenticated, read only this endpoint\'s open request, and precede the updatesHeld block');
  const mfn = usvc.slice(usvc.indexOf('async migrate('), usvc.indexOf('async cancelMigration('));
  check('a migration request needs computers:edit and a fresh sign-in, single and bulk',
    /assertEndpointInScope\(actor, id, CAP\.COMPUTERS_EDIT\);\s*this\.acl\.assertCapability\(actor, CAP\.COMPUTERS_EDIT\);\s*assertFresh\(freshMethod,/.test(mfn)
      && mfn.indexOf('assertFresh(') < mfn.indexOf('this.migration.request(')
      && /if \(action === 'agent\.migrate'\) \{\s*assertFresh\(opts\.freshMethod,/.test(usvc)
      && /@Post\(':id\/agent\/migrate'\)\s*@RequireCapability\(CAP\.COMPUTERS_EDIT\)/.test(uctl) && /this\.svc\.migrate\(actor, id, body\?\.reason, this\.freshMethod\(req\)\)/.test(uctl)
      && /@Post\(':id\/agent\/update'\)\s*@RequireCapability\(CAP\.COMPUTERS_EDIT\)/.test(uctl),
    'migrate() must assert computers:edit then assertFresh before recording; bulk agent.migrate must assertFresh once');
  const rq = msvc.slice(msvc.indexOf('async request('), msvc.indexOf('async cancel('));
  check('a migration request is recorded only with its audit entry, and re-checks every precondition',
    /const b = await this\.block\(endpointId\);\s*if \(b\) throw/.test(rq) && /await this\.audit\.logOrFail\(\{[\s\S]{0,200}action: 'AGENT_MIGRATION_REQUESTED'/.test(rq)
      && /catch \(e\) \{\s*await this\.prisma\.agentMigration\.delete\(/.test(rq),
    'request() must refuse on migrationBlock and roll back a request whose audit entry failed');
}

// 44. The browser UI suite (0.34). e2e-ui.mjs is the first browser test CI
//     runs, and it starts a web server, an API and a seeding Prisma client by
//     itself, on a runner and on the production host alike. Everything that
//     keeps it off production is a refusal before anything starts, and the
//     one that matters most is the rewrite: a standalone build carries the API
//     address it was built with — on this host, the production API on 3001 —
//     so a copy whose patch silently missed would drive the live API from a
//     browser seeding fixtures.
{
  const ui = read('apps/web/scripts/e2e-ui.mjs');
  const before = ui.slice(0, ui.indexOf('// ── The stack'));
  check('e2e-ui.mjs refuses ports 3000, 3001, 443, 4000 and 4001 before it starts anything',
    /const FORBIDDEN_PORTS = \[3000, 3001, 443, 4000, 4001\];/.test(before)
      && /for \(const p of \[WEB_PORT, API_PORT(, SMTP_PORT, PEER_PORT)?\]\) \{\s*if \(!Number\.isInteger\(p\) \|\| FORBIDDEN_PORTS\.includes\(p\)\) throw new Error\(`Refusing/.test(before),
    'production (3000/3001/443) and the docs stack (4000/4001) are refused for the web and API ports (and, from 0.35, the SMTP sink and reference peer ports)');
  check('e2e-ui.mjs refuses a database whose name lacks test or scratch, before Prisma is loaded',
    /if \(!\/test\|scratch\/\.test\(dbName\)\) throw new Error\(`Refusing/.test(before) && before.indexOf('test|scratch') < before.indexOf('new PrismaClient'),
    'it migrates, seeds and deletes fixtures');
  const prep = ui.slice(ui.indexOf('function prepareWeb('), ui.indexOf('function startWeb('));
  check('e2e-ui.mjs patches a copy of the web build, never the build',
    /const COPY = mkdtempSync\(/.test(prep) && /cpSync\(standalone, COPY/.test(prep)
      && (prep.match(/writeFileSync\(/g) ?? []).length === 1 && /for \(const f of files\) \{\s*const before = readFileSync\(f, 'utf8'\);\s*writeFileSync\(f,/.test(prep)
      && /const files = \[[^\]]+\]\.map\(\(f\) => path\.join\(COPY, f\)\)/.test(prep),
    'the only write is to files joined from the temporary copy');
  check('e2e-ui.mjs stops if the build\'s API destination survives the patch',
    /if \(after\.includes\(`\$\{origin\}\/api\/`\) \|\| !after\.includes\(`\$\{API_ORIGIN\}\/api\/`\)\) throw new Error/.test(prep),
    'every patched file must lose the old destination and gain the suite\'s own API');
  check('e2e-ui.mjs runs its API with every background sweep off',
    /MONITOR_SWEEP: 'off', CLIENT_UPDATE_SWEEP: 'off', PATCH_POLICY_SWEEP: 'off', METRIC_SWEEP: 'off'/.test(ui)
      // 0.34 integration: and the four sweeps the other 0.34 branches added.
      && /RETENTION_SWEEP: 'off', REPORT_SCHEDULE_SWEEP: 'off', SCRIPT_OUTPUT_SWEEP: 'off', CHAT_RETENTION_SWEEP: 'off',/.test(ui),
    'a sweep acts on everything in the database, fixtures included');
  // 0.35 integration: two more switches arrived (STALE_SWEEP, SNAPSHOT_SWEEP),
  // each from a different branch. Rather than list them again, every
  // `X_SWEEP` / `X_SEALER` off switch the API reads must be 'off' here.
  const switches = [...new Set(walk('apps/api/src').flatMap((f) => [...read(f).matchAll(/\b([A-Z][A-Z_]*(?:SWEEP|SEALER))\s*[!=]==\s*'off'/g)].map((m) => m[1])))].sort();
  const missing = switches.filter((n) => !new RegExp(`\\b${n}: 'off'`).test(ui));
  check(`e2e-ui.mjs turns off every sweep switch the API reads (${switches.length})`,
    switches.length >= 11 && missing.length === 0,
    `not set to 'off' in e2e-ui.mjs's API env: ${missing.join(', ')}`);
}

// 45. Chat (0.34). A technician and the person at a computer. Every portal
//     route names its capability and reaches the computer through the
//     device-list visibility rule AND-ed with the id, so another business's
//     computer is a 404; starting and writing consult the `remote`
//     containment pause. The two device routes need the device secret
//     (secretMatches, never a RustDesk ID alone), and the heartbeat hands
//     chat only to an authenticated signed agent. Audit rows carry ids and
//     counts, never message text, and chat never updates or deletes an
//     ActivityLog row (pruning deletes transcripts, not audit). The 2,000
//     character cap is the same in the API, the database and the agent; the
//     400-day retention sweep has its off switch set in run-e2e.sh. On the
//     agent (0.36: the tray replaced the 0.34 Win32 chat window), the tray
//     process holds no secret and speaks no HTTP in the signed agent: it
//     talks only over two first-instance, local-only pipes whose DACL names
//     SYSTEM and the session user, checked against the launched PID. Its
//     chat window is a WebView2 control that loads only /assist on the pinned
//     portal, and the page draws text with textContent. The portal renders
//     transcripts as React text.
{
  const ctl = read('apps/api/src/chat/chat.controller.ts');
  const svc = read('apps/api/src/chat/chat.service.ts');
  const pol = read('apps/api/src/chat/chat-policy.ts');
  const routeRe = /@(Get|Post)\(([^)]*)\)\s*\n((?:\s*@[A-Za-z]+\([^)]*\)\s*\n)*)\s*async (\w+)/g;
  const chatCls = ctl.slice(ctl.indexOf('export class ChatController'), ctl.indexOf('export class ChatReadDto'));
  const inboxCls = ctl.slice(ctl.indexOf("@Controller('chat/inbox')"));
  const routes = [...chatCls.matchAll(routeRe)];
  const capOf = Object.fromEntries(routes.map((m) => [m[4], (m[3].match(/@RequireCapability\(CAP\.(\w+)\)/) ?? [])[1]]));
  const inboxRoutes = [...inboxCls.matchAll(routeRe)];
  check('every chat route names its capability: viewing and reading a file need COMPUTERS_VIEW, starting, writing, sending a file, acknowledging and ending need CHAT_SEND',
    routes.length === 8 && /@Controller\('endpoints\/:id\/chat'\)\s*\n@UseGuards\(JwtAuthGuard, CapabilitiesGuard\)\s*\nexport class ChatController/.test(ctl) && !/@Public\(\)/.test(ctl)
      && capOf.overview === 'COMPUTERS_VIEW' && capOf.transcript === 'COMPUTERS_VIEW' && capOf.attachment === 'COMPUTERS_VIEW'
      && capOf.start === 'CHAT_SEND' && capOf.send === 'CHAT_SEND' && capOf.upload === 'CHAT_SEND' && capOf.ack === 'CHAT_SEND' && capOf.end === 'CHAT_SEND'
      // The inbox (0.44): computers:view, behind the same guards.
      && /@Controller\('chat\/inbox'\)\s*\n@UseGuards\(JwtAuthGuard, CapabilitiesGuard\)\s*\nexport class ChatInboxController/.test(ctl)
      && inboxRoutes.length === 2 && inboxRoutes.every((m) => /@RequireCapability\(CAP\.COMPUTERS_VIEW\)/.test(m[3])),
    `routes: ${JSON.stringify(capOf)}; inbox: ${inboxRoutes.length}`);
  const methods = ['overview', 'transcript', 'start', 'send', 'sendAttachment', 'readAttachment', 'ack', 'end'];
  const body = (name) => { const i = svc.indexOf(`  async ${name}(`); const j = svc.indexOf('\n  }\n', i); return i < 0 ? '' : svc.slice(i, j); };
  check('chat reaches a computer only through visibleEndpoint: assertEndpointInScope, then the visibility rule AND-ed with the id',
    /await this\.acl\.assertEndpointInScope\(actor, endpointId, capability\);\s*\n\s*const ep = await this\.prisma\.endpoint\.findFirst\(\{\s*\n\s*where: \{ AND: \[this\.acl\.endpointVisibilityWhere\(actor\), \{ id: endpointId \}\] \},/.test(svc)
      && methods.every((m) => /await this\.visibleEndpoint\(actor, endpointId/.test(body(m)))
      && ['start', 'send', 'sendAttachment', 'ack', 'end'].every((m) => /this\.visibleEndpoint\(actor, endpointId, CAP\.CHAT_SEND\)/.test(body(m))),
    'each technician method must begin with this.visibleEndpoint(actor, endpointId[, CAP.CHAT_SEND]); a spread visibility clause beside an OR widens it');
  check('starting a chat, sending in one and sending a file (either side) all consult the remote containment pause',
    ['start', 'send', 'sendAttachment'].every((m) => /await this\.containment\.assertOpen\('remote', ep\.customerId\)/.test(body(m)))
      && /^\s*async assistSendAttachment\([^)]*\) \{\s*\n\s*await this\.containment\.assertOpen\('remote', customerId\);/.test(body('assistSendAttachment'))
      && body('sendAttachment').indexOf("assertOpen('remote'") < body('sendAttachment').indexOf('checkAttachment('),
    "start(), send() and sendAttachment() call assertOpen('remote', ep.customerId); assistSendAttachment() starts with assertOpen('remote', customerId), before the file is looked at");
  const ec = read('apps/api/src/enrollment/enrollment.controller.ts');
  const es = read('apps/api/src/enrollment/enrollment.service.ts');
  const auth = es.slice(es.indexOf('async authenticateDevice('), es.indexOf('async authenticateDevice(') + 1200);
  check('the device chat routes need the device secret, and the heartbeat offers chat only to an authenticated signed agent',
    (ec.match(/await this\.enrollment\.authenticateDevice\(dto\.rustdeskId, dto\.agentSecret, 'chat_(poll|reply)_unauthenticated'\);/g) ?? []).length === 2
      && /if \(!node\?\.agentSecretHash \|\| !agentSecret \|\| !this\.secretMatches\(node\.agentSecretHash, agentSecret\)\)/.test(auth)
      && /throw new UnauthorizedException/.test(auth)
      && /if \(authenticated && \(\(dto\.updateChannel === 'signed' && \(dto\.agentChat \?\? 0\) >= 1\) \|\| \(trayProtocol \?\? 0\) >= 1\)\) \{/.test(es)
      // 0.51 (§64): and only from a heartbeat that may act (not a legacy report on a signed computer).
      && /if \(authenticated && mayAct && node\.endpointId && \(dto\.agentTray \?\? 0\) >= 1\) \{/.test(es)
      && /chatProtocol: dto\.updateChannel === 'signed' \? dto\.agentChat \?\? null : null/.test(es),
    'chat/poll and chat/reply call authenticateDevice (secretMatches); the heartbeat gate is authenticated && (signed chat || a tray recorded only from an authenticated heartbeat)');
  const metas = [...svc.matchAll(/meta: \{([^}]*)\}/g)].map((m) => m[1]);
  check('chat audit rows carry ids and counts only — an attachment\'s ids, kind, type and size, never its name or bytes — and chat never changes or deletes an ActivityLog row',
    metas.length === 5 && metas.every((m) => !/\b(body|text|authorName|deviceUser|deviceDetail|fileName|bytes|sha256|buffer|originalname)\b/.test(m))
      && /meta: \{ conversationId: c\.id, attachmentId: att\.id, by: tech \? 'technician' : 'end_user', kind: a\.kind, contentType: a\.contentType, sizeBytes: a\.sizeBytes \},/.test(svc)
      && !/activityLog\.(update|updateMany|delete|deleteMany|upsert)/.test(svc) && !/\$executeRaw/.test(svc),
    `audit meta must hold no message text, names, file names or bytes; no activityLog update/delete in chat.service.ts. meta: ${JSON.stringify(metas)}`);
  const sql = read('apps/api/prisma/migrations/0056_chat/migration.sql');
  const sql67 = read('apps/api/prisma/migrations/0067_chat_attachments/migration.sql');
  const txt = read('tools/windows-installer/internal/chat/text.go');
  check('the message cap is 2,000 UTF-16 code units in the API, the database and the agent (an emoji counts two everywhere, as a textarea\'s maxlength does)',
    /export const MAX_MESSAGE_CHARS = 2000;/.test(pol) && /if \(text\.length > MAX_MESSAGE_CHARS\)/.test(pol)
      && /char_length\("body"\) BETWEEN 1 AND 2000\)/.test(sql)
      && /ALTER TABLE "ChatMessage" DROP CONSTRAINT "ChatMessage_body_bounded";\s*\nALTER TABLE "ChatMessage" ADD CONSTRAINT "ChatMessage_body_bounded" CHECK \(\s*\n\s*char_length\("body"\) >= 1\s*\n\s*AND char_length\("body"\) \+ char_length\(regexp_replace\("body", '\[\^\\U00010000-\\U0010FFFF\]', '', 'g'\)\) <= 2000\);/.test(sql67)
      && /const MaxMessageChars = 2000\n/.test(txt) && /if utf16Len\(s\) > MaxMessageChars \{/.test(txt) && /if r >= 0x10000 \{\s*\n\s*n \+= 2/.test(txt)
      && /maxlength="2000"/.test(read('apps/api/src/tray/assist-page.ts')),
    'MAX_MESSAGE_CHARS (String.length), 0067\'s ChatMessage_body_bounded (code points + supplementary ones) and MaxMessageChars (utf16Len) must agree');
  {
    // Attachments (0.44).
    const att = read('apps/api/src/chat/chat-attachment.ts');
    const tctl0 = read('apps/api/src/tray/tray.controller.ts');
    const asv0 = read('apps/api/src/tray/assist.service.ts');
    const sniffFn = att.slice(att.indexOf('export function sniff('), att.indexOf('\n}\n', att.indexOf('export function sniff(')));
    const checkFn = att.slice(att.indexOf('export function checkAttachment('), att.indexOf('\n}\n', att.indexOf('export function checkAttachment(')));
    check('an attachment is an image only by its magic bytes — PNG, JPEG, GIF, WebP — and never by its declared type; SVG and HTML are files',
      /export const IMAGE_TYPES = \['image\/png', 'image\/jpeg', 'image\/gif', 'image\/webp'\] as const;/.test(att)
        && /b\.subarray\(0, 8\)\.equals\(PNG_MAGIC\) && b\.subarray\(12, 16\)\.toString\('latin1'\) === 'IHDR'/.test(sniffFn)
        && /b\[0\] === 0xff && b\[1\] === 0xd8 && b\[2\] === 0xff/.test(sniffFn) && /'GIF87a'/.test(sniffFn) && /'GIF89a'/.test(sniffFn)
        && /toString\('latin1'\) === 'RIFF' && b\.subarray\(8, 12\)\.toString\('latin1'\) === 'WEBP'/.test(sniffFn)
        && /return \{ kind: 'file', contentType: FILE_TYPE, ext: null \};\s*$/.test(sniffFn) && !/svg|html|text\//i.test(sniffFn)
        && /const s = sniff\(b\);/.test(checkFn) && !/mimetype|contentType:\s*file\./.test(checkFn)
        && /\("kind" = 'image' AND "contentType" IN \('image\/png', 'image\/jpeg', 'image\/gif', 'image\/webp'\)\)\s*\n\s*OR \("kind" = 'file' AND "contentType" = 'application\/octet-stream'\)\);/.test(sql67),
      'sniff(): four magic numbers, else file/octet-stream; checkAttachment() classifies with sniff(b) and never reads the declared mimetype; ChatAttachment_kind_type agrees');
    const hdr = att.slice(att.indexOf('export function attachmentHeaders('), att.indexOf('\n}\n', att.indexOf('export function attachmentHeaders(')));
    check('an attachment is served inert: its sniffed image type inline, anything else application/octet-stream as an attachment; nosniff and a sandbox CSP always; both routes serve through the one function',
      /const image = a\.kind === 'image' && \(IMAGE_TYPES as readonly string\[\]\)\.includes\(a\.contentType\);/.test(hdr)
        && /'Content-Type': image \? a\.contentType : FILE_TYPE,/.test(hdr) && /contentDisposition\(image \? 'inline' : 'attachment', a\.fileName\)/.test(hdr)
        && /'X-Content-Type-Options': 'nosniff',/.test(hdr) && /'Content-Security-Policy': "default-src 'none'; sandbox",/.test(hdr)
        && /export const FILE_TYPE = 'application\/octet-stream';/.test(att)
        && /for \(const \[k, v\] of Object\.entries\(attachmentHeaders\(a\)\)\) res\.setHeader\(k, v\);/.test(ctl)
        && /sendAttachment\(res, await this\.chat\.readAttachment\(actor, id, cid, aid\)\);/.test(ctl)
        && /sendAttachment\(res, await this\.assist\.attachment\(req\.headers\.cookie, aid\)\);/.test(tctl0)
        && /const ascii = Array\.from\(fileName, \(c\) => \(\/\^\[\\x20-\\x7e\]\$\/\.test\(c\) && !\/\["\\\\%;\]\/\.test\(c\) \? c : '_'\)\)\.join\(''\);/.test(att),
      'attachmentHeaders(): type, disposition, nosniff, sandbox CSP; chat.controller sendAttachment() sets exactly those; the console and /assist both use it; the ASCII filename drops quotes, backslashes, % and ;');
    check('reading a file needs what reading the transcript needs: computers:view on a visible computer, the file found only under its own conversation and computer; the page reads only its own chat',
      /^\s*async readAttachment\([^)]*\) \{\s*\n\s*await this\.visibleEndpoint\(actor, endpointId\);\s*\n\s*return this\.attachmentOf\(endpointId, conversationId, attachmentId\);/.test(body('readAttachment'))
        && /where: \{ id: attachmentId, conversationId, conversation: \{ endpointId \} \},/.test(svc)
        && /const \{ s, cid \} = await this\.bound\(cookie\);\s*\n\s*return this\.chat\.assistAttachment\(s\.endpointId, cid, attachmentId\);/.test(asv0)
        && (svc.match(/this\.attachmentOf\(/g) ?? []).length === 2 && (svc.match(/chatAttachment\.findFirst\(/g) ?? []).length === 1,
      'readAttachment(): visibleEndpoint then attachmentOf; attachmentOf: { id, conversationId, conversation: { endpointId } }; AssistService.attachment uses the session\'s bound conversation');
    check('sending a file: support:chat on the console; on /assist x-assist and a live cookie are checked by a guard before multer reads a byte; memory only, 10 MB',
      /@Post\('api\/attachments'\)\s*\n\s*@Public\(\)\s*\n\s*@RateLimit\(20\)\s*\n\s*@UseGuards\(AssistUploadGuard\)\s*\n\s*@UseInterceptors\(CHAT_UPLOAD\)/.test(tctl0)
        && /assertPageWrite\(req\);\s*\n\s*await this\.assist\.session\(req\.headers\.cookie\);\s*\n\s*return true;/.test(tctl0)
        && /export const CHAT_UPLOAD = FileInterceptor\('file', \{\s*\n\s*storage: memoryStorage\(\),\s*\n\s*limits: \{ fileSize: MAX_ATTACHMENT_BYTES, files: 1,/.test(ctl)
        && /export const MAX_ATTACHMENT_BYTES = 10 \* 1024 \* 1024;/.test(att)
        && /"sizeBytes" BETWEEN 1 AND 10485760 AND octet_length\("bytes"\) = "sizeBytes"\);/.test(sql67)
        && /"attachmentCount" BETWEEN 0 AND 20 AND "attachmentBytes" BETWEEN 0 AND 52428800\);/.test(sql67)
        && /attachmentCount: \{ lt: MAX_ATTACHMENTS_PER_CONVERSATION \},\s*\n\s*attachmentBytes: \{ lte: MAX_ATTACHMENT_BYTES_PER_CONVERSATION - a\.sizeBytes \},/.test(svc),
      '/assist upload: @UseGuards(AssistUploadGuard) before @UseInterceptors(CHAT_UPLOAD); the guard runs assertPageWrite and session(); CHAT_UPLOAD memoryStorage, fileSize 10 MB; the chat caps are claimed by one conditional update and backed by CHECKs');
    check('files go with their chat: deleted by foreign key with the message and the conversation (retention, an unrecorded chat\'s end), and counted in CHAT_PRUNED',
      /ALTER TABLE "ChatAttachment" ADD CONSTRAINT "ChatAttachment_conversationId_fkey" FOREIGN KEY \("conversationId"\) REFERENCES "ChatConversation"\("id"\) ON DELETE CASCADE/.test(sql67)
        && /ALTER TABLE "ChatAttachment" ADD CONSTRAINT "ChatAttachment_messageId_fkey" FOREIGN KEY \("messageId"\) REFERENCES "ChatMessage"\("id"\) ON DELETE CASCADE/.test(sql67)
        && /meta: \{ conversations, messages, attachments, retentionDays: this\.cfg\.retentionDays, endedBefore: cutoff\.toISOString\(\) \},/.test(svc)
        && /attachments \+= rows\.reduce\(\(s, x\) => s \+ x\.attachmentCount, 0\);/.test(svc),
      'ChatAttachment conversationId and messageId FKs ON DELETE CASCADE; prune() counts attachments into CHAT_PRUNED');
    const inb = read('apps/api/src/chat/chat-inbox.service.ts');
    check('the chat inbox lists only open chats on computers the caller can see, reads the caller\'s own marks, and marks read only a visible computer\'s chat',
      /where: \{ status: 'OPEN', endpoint: \{ AND: \[this\.acl\.endpointVisibilityWhere\(actor\), \{ status: \{ not: 'ARCHIVED' \} \}\] \} \},/.test(inb)
        && /readStates: \{ where: \{ userId: actor\.userId \}, select: \{ lastReadAt: true \} \},/.test(inb)
        && /LEFT JOIN "ChatReadState" r ON r\."conversationId" = c\.id AND r\."userId" = \$\{actor\.userId\}/.test(inb)
        && /WHERE c\.id = ANY\(\$\{ids\}::text\[\]\)`\);/.test(inb) && !/\$queryRawUnsafe|\$executeRaw/.test(inb) && !/"bytes"/.test(inb)
        && /await this\.acl\.assertEndpointInScope\(actor, c\.endpointId, 'computers:view'\);\s*\n\s*const visible = await this\.prisma\.endpoint\.count\(\{ where: \{ AND: \[this\.acl\.endpointVisibilityWhere\(actor\), \{ id: c\.endpointId \}\] \} \}\);\s*\n\s*if \(!visible\) throw new NotFoundException/.test(inb)
        && /where: \{ userId_conversationId: \{ userId: actor\.userId, conversationId: c\.id \} \},/.test(inb),
      'inbox(): endpointVisibilityWhere AND not archived; only this user\'s ChatReadState; one parameterised query over those ids, never the bytes; markRead(): assertEndpointInScope + visibility, keyed by actor.userId');
    const apiE = read('apps/api/src/chat/emoji.ts'), webE = read('apps/web/lib/emoji.ts');
    const list = (s) => s.slice(s.indexOf('= ['), s.indexOf('];') + 2);
    check('the emoji pickers are built in and the same on the console and on /assist; an emoji is inserted as text',
      list(apiE).length > 100 && list(apiE) === list(webE) && !/https?:|cdn|import\(/i.test(apiE + webE)
        && /var EMOJI = \$\{JSON\.stringify\(EMOJI\)\};/.test(read('apps/api/src/tray/assist-page.ts'))
        && /b\.textContent = e;/.test(read('apps/api/src/tray/assist-page.ts')),
      'apps/api/src/chat/emoji.ts and apps/web/lib/emoji.ts hold the same list; assist.js embeds it and draws each with textContent');
  }
  const e2e = read('scripts/run-e2e.sh');
  check('transcripts are kept 400 days by default, and the e2e runner turns the sweep off for scratch APIs',
    /export const RETENTION_DEFAULT_DAYS = 400;/.test(pol) && /enabled: env\.CHAT_RETENTION_SWEEP !== 'off',/.test(pol)
      && /export CHAT_RETENTION_SWEEP=off/.test(e2e),
    "RETENTION_DEFAULT_DAYS = 400; CHAT_RETENTION_SWEEP=off exported in scripts/run-e2e.sh");
  const win = read('tools/windows-installer/cmd/rem0te-tray/chatwin_windows.go');
  const trayMain = read('tools/windows-installer/cmd/rem0te-tray/main_windows.go');
  const host = read('tools/windows-installer/trayhost_windows.go');
  const pipe = read('tools/windows-installer/internal/tray/pipe.go');
  const ajs = read('apps/api/src/tray/assist-page.ts');
  check('the chat window loads only /assist on the pinned portal, with dev tools, host objects and web messages off, and the page draws text as text',
    /if err == nil && tray\.AllowedNavigation\(portal, uri\) \{\s*\n\s*return\s*\n\s*\}/.test(win)
      && /CreateWebResourceResponse\(nil, 403, "Forbidden", ""\)/.test(win)
      && /v\.AddWebResourceRequestedFilter\("\*", edge\.COREWEBVIEW2_WEB_RESOURCE_CONTEXT_ALL\)/.test(win)
      && ['PutAreDevToolsEnabled', 'PutAreHostObjectsAllowed', 'PutIsWebMessageEnabled', 'PutAreDefaultContextMenusEnabled'].every((k) => new RegExp(`s\\.${k}\\(false\\)`).test(win))
      && !/AddHostObjectToScript|Bind\(|net\/http|heartbeat\.dat|AgentSecret|agentSecret/.test(win)
      && !/innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval\(|new Function/.test(ajs.slice(ajs.indexOf('export const ASSIST_JS'), ajs.indexOf('export const ASSIST_EXPIRED_HTML')))
      && /body\.textContent = m\.text;/.test(ajs),
    'chatwin_windows.go: AllowedNavigation gate answering 403 on filter "*"; dev tools, host objects, web messages, context menus off; assist.js sets textContent, never innerHTML');
  check('the signed tray holds no secret and speaks no HTTP: everything goes through the SYSTEM host over the pipes',
    !/heartbeat\.dat|AgentSecret|agentSecret|net\/http/.test(trayMain.slice(trayMain.indexOf('func runSigned('), trayMain.indexOf('func runStandard(')))
      && !/heartbeat\.dat|AgentSecret|agentSecret/.test(trayMain)
      && (trayMain.match(/exec\.Command/g) ?? []).length === 1 && /exec\.Command\(exe, "--chat-window", "--portal", a\.portal\)/.test(trayMain)
      && /cmd\.Stdin = strings\.NewReader\(u \+ "\\n"\)/.test(trayMain),
    'main_windows.go runSigned: no heartbeat.dat, agent secret or net/http; the one exec is itself as --chat-window, the URL (with its one-time code) on stdin, never on a command line');
  check('the tray pipes are first-instance, local-only, ACL\'d to SYSTEM and the session user, and checked against the launched PID',
    /return "D:P\(A;;GA;;;SY\)\(A;;GRGW;;;" \+ userSID \+ "\)", nil/.test(pipe)
      && /windows\.PIPE_REJECT_REMOTE_CLIENTS/.test(host) && /access\|windows\.FILE_FLAG_FIRST_PIPE_INSTANCE/.test(host)
      && /sddl, err := tray\.PipeSDDL\(u\.User\.Sid\.String\(\)\)/.test(host)
      && /windows\.GetNamedPipeClientProcessId\(hp, &pid\); err == nil && pid != pi\.ProcessId \{/.test(host)
      // 0.51: and one more, the host starting its successor from the install directory (startHost).
      && (host.match(/exec\.Command/g) ?? []).length === 2 && /exec\.CommandContext\(ctx, rd, "--get-id"\)/.test(host)
      && /exec\.Command\(paths\.AgentExe\(\), "tray-host"\)/.test(host),
    'PipeSDDL protected DACL (SY + user GRGW); FIRST_PIPE_INSTANCE and REJECT_REMOTE_CLIENTS; client PID == launched PID; two execs (rustdesk --get-id, and the installed agent as tray-host)');
  const tab = read('apps/web/components/endpoints/workspace/chat-tab.tsx');
  const attTsx = read('apps/web/components/endpoints/workspace/chat-attachment.tsx');
  const inboxTsx = read('apps/web/components/chat/chat-inbox.tsx');
  check('the portal renders chat as text: no HTML injection, no links made from messages; an attachment link is built from ids alone',
    !/dangerouslySetInnerHTML|<a\s|href=|linkify|marked|markdown/i.test(tab) && /: m\.body\}/.test(tab)
      && !/dangerouslySetInnerHTML|linkify|markdown/i.test(attTsx + inboxTsx) && !/<a\s|href=/.test(inboxTsx)
      && (attTsx.match(/href=/g) ?? []).length === 1 && /href=\{url\}/.test(attTsx) && /const url = chatAttachmentUrl\(endpointId, conversationId, a\.id\);/.test(attTsx)
      && /src=\{url\}/.test(attTsx) && /\{a\.fileName\}/.test(attTsx),
    'chat-tab.tsx renders m.body as React text, with no dangerouslySetInnerHTML or anchors; chat-attachment.tsx has one href and one src, both chatAttachmentUrl(ids); the inbox has no links');
  const ws = read('apps/api/src/public/windows-script.ts');
  check('only the signed agent starts the tray host, and the remote pause says it covers chat',
    (ws.match(/ArgumentList @\('tray-host'\)/g) ?? []).length === 1 && ws.indexOf("ArgumentList @('tray-host')") > ws.indexOf('export function buildSignedWindowsScript(')
      && !/ArgumentList @\('chat'\)/.test(ws)
      && /remote: 'remote connections and chat'/.test(read('apps/api/src/containment/pause.ts')),
    "one Start-Process ... @('tray-host'), in the signed variant's hook; pause label 'remote connections and chat'");
}

// 46. Device groups as a policy scope (0.35). Monitors and client-update
//     policies may be set for a device group. Rule-group membership is
//     computed, never stored: the group's business AND its rule AND
//     endpointVisibilityWhere for the business as a whole, through the device
//     list's own evaluator, with an unreadable or alert-reading rule matching
//     nothing. The sweeps build membership once per tick and keep it nowhere.
//     Precedence is computer > group > site > business > global, groups by a
//     priority that is unique per business (partial unique indexes) and tie-
//     broken by id, never by row order. Another business's group is a 404;
//     turning a group client-update policy on, or removing one, needs fresh
//     authentication, and deleting the group is not a way round that (NO
//     ACTION foreign keys, and a 409). Who is notified stays global or
//     business and keeps §17's step-up.
{
  const mem = read('apps/api/src/group-policy/membership.service.ts');
  const prec = read('apps/api/src/group-policy/precedence.ts');
  const eng = read('apps/api/src/monitoring/engine.ts');
  const msvc = read('apps/api/src/monitoring/monitoring.service.ts');
  const madm = read('apps/api/src/monitoring/monitoring-admin.service.ts');
  const cpol = read('apps/api/src/client-updates/policy.ts');
  const csvc = read('apps/api/src/client-updates/client-updates.service.ts');
  const cctl = read('apps/api/src/client-updates/client-updates.controller.ts');
  const csw = read('apps/api/src/client-updates/client-update-sweep.service.ts');
  const dgs = read('apps/api/src/device-views/device-groups.service.ts');
  const mctl = read('apps/api/src/monitoring/monitoring.controller.ts');
  const sql = read('apps/api/prisma/migrations/0057_group_policy_scope/migration.sql');
  const schema = read('apps/api/prisma/schema.prisma');
  const body = (src, sig) => { const i = src.indexOf(sig); const j = src.indexOf('\n  }\n', i); return i < 0 ? '' : src.slice(i, j); };

  check('group membership is computed, never stored: the membership service writes nothing and keeps no state between calls',
    !/prisma\.\w+\.(create|createMany|update|updateMany|upsert|delete|deleteMany)\(|\$executeRaw/.test(mem)
      && !/(private|protected|public|static) (readonly )?\w+\s*(:\s*(Map|Set|Membership)|=\s*new (Map|Set))/.test(mem.slice(mem.indexOf('export class GroupMembershipService')).replace(/constructor\([\s\S]*?\) \{\}/, ''))
      && /^export class Membership \{\s*\n\s*constructor\(private readonly byEndpoint: Map<string, Set<string>>, readonly groups: Map<string, PolicyGroup>\) \{\}/m.test(mem)
      && !/model \w*(GroupPolicyMember|PolicyMembership)\w* \{/.test(schema),
    'membership.service.ts must not write to the database or hold a Map field; no membership model in schema.prisma');
  check('a rule group is evaluated by the device list’s own evaluator, as the business AND its rule AND endpointVisibilityWhere; unreadable and alert-reading rules match nothing',
    /this\.list\.evaluateRuleGroups\(actor, ruled,/.test(mem)
      && /const visible = \{ AND: \[this\.acl\.endpointVisibilityWhere\(actor\), \{ status: \{ not: 'ARCHIVED' as const \} \}/.test(mem)
      && /if \(g\.kind !== 'rule' \|\| g\.use !== 'ok'\) continue;/.test(mem)
      && /userId: 'policy-evaluation', email: '', tenantId: null, businessId: customerId, isPlatformAdmin: false,\s*\n\s*roleType: 'BUSINESS_OWNER', capabilities: \[CAP\.COMPUTERS_VIEW, CAP\.ALERTS_VIEW\], technician: null,/.test(mem)
      && /use: f === null \? 'unreadable' : ruleNeedsAlerts\(f\) \? 'reads_alerts' : 'ok'/.test(mem)
      && (read('apps/api/src/group-policy/membership.service.ts').match(/businessWide\(/g) ?? []).length === 2
      && !walk('apps/api/src').some((f) => f !== 'apps/api/src/group-policy/membership.service.ts' && /policy-evaluation/.test(read(f))),
    'snapshot(): evaluateRuleGroups(actor, …) with businessWide(customerId) (never a Platform Admin), visibility AND not-archived, skip use !== ok; the synthetic actor exists only in membership.service.ts');
  check('the sweeps build membership once per tick, inside the pass, and keep it on nothing',
    /const membership = await this\.groups\.snapshot\(rules\.filter\(\(r\) => r\.groupId\)\.map\(\(r\) => r\.groupId!\)\);\s*\n\s*for \(const ep of eps\) \{\s*\n\s*const eff = effectiveRules\(rules, scopesFor\(ep, membership\.groupsOf\(ep\.id\)\)\);/.test(body(msvc, 'private async evaluateSweepRules('))
      && /const membership = await this\.svc\.membershipFor\(policies\);/.test(body(csw, 'private async queue('))
      && /effectivePolicy\(policies, customerId, e\.siteId, membership\.groupsOf\(e\.id\)\)/.test(csw)
      && ![msvc, csw, csvc, mem].some((s) => /this\.(membership|snapshotCache|groupCache)\b/.test(s)),
    'evaluateSweepRules and the client-update pass call snapshot/membershipFor locally; no this.membership anywhere');
  check('precedence is computer > group > site > business > global, groups by priority then id — never by row order',
    /export const SCOPE_RANK: Record<PolicyScope, number> = \{ global: 0, business: 1, site: 2, group: 3, endpoint: 4 \};/.test(prec)
      && /if \(pa !== pb\) return pa - pb;\s*\n\s*\}\s*\n\s*return a\.id < b\.id \? -1 : a\.id > b\.id \? 1 : 0;/.test(prec)
      && /const ranked = \[\.\.\.applicable\]\.sort\(comparePrecedence\);/.test(prec)
      && /l\.sort\(\(a, b\) => comparePrecedence\(asScoped\(a\), asScoped\(b\)\)\);/.test(eng)
      && /return resolve\(cands\);/.test(cpol) && !/mine\.find\(/.test(cpol),
    'precedence.ts SCOPE_RANK and comparePrecedence (priority, then id); effectiveRules and resolvePolicy sort with it');
  check('the database refuses priority ties, scope mixtures, another business’s group, and deleting a group that carries a policy',
    /CREATE UNIQUE INDEX "MonitorRule_group_priority_key" ON "MonitorRule"\("customerId", "key", "priority"\) WHERE "groupId" IS NOT NULL;/.test(sql)
      && /CREATE UNIQUE INDEX "ClientUpdatePolicy_group_priority_key" ON "ClientUpdatePolicy"\("customerId", "priority"\) WHERE "groupId" IS NOT NULL;/.test(sql)
      && /CREATE UNIQUE INDEX "ClientUpdatePolicy_business_row" ON "ClientUpdatePolicy"\("customerId"\) WHERE "siteId" IS NULL AND "groupId" IS NULL;/.test(sql)
      && /"scopeKey" = 'g:' \|\| "groupId"/.test(sql) && /"groupId" IS NOT NULL AND "siteId" IS NULL AND "priority" BETWEEN 1 AND 999/.test(sql)
      && (sql.match(/EXECUTE FUNCTION group_policy_same_business\(\)/g) ?? []).length === 2
      && (sql.match(/REFERENCES "EndpointGroup"\("id"\) ON DELETE NO ACTION/g) ?? []).length === 2
      && (schema.match(/group +EndpointGroup\? @relation\(fields: \[groupId\], references: \[id\], onDelete: NoAction\)/g) ?? []).length === 2,
    '0057: two partial unique priority indexes, business_row excluding groups, the CHECKs, the same-business trigger on both tables, NO ACTION FKs');
  check('another business’s group is a 404 for monitors and client updates',
    /const g = await this\.prisma\.endpointGroup\.findFirst\(\{ where: \{ id: groupId, customerId \}/.test(mem)
      && /if \(!g\?\.customerId\) throw new NotFoundException\('Group not found'\);/.test(mem)
      && /if \(!this\.isMsp\(a\) && customerId !== a\.businessId\) throw new NotFoundException\('Group not found'\);\s*\n\s*const g = await this\.groups\.groupForPolicy\(customerId, s\.groupId\);\s*\n\s*this\.assertConfigure\(a, g\.customerId\);/.test(madm)
      && /const group = groupId \? await this\.groups\.groupForPolicy\(customerId, groupId\) : null;/.test(csvc)
      && /const before = await this\.prisma\.clientUpdatePolicy\.findFirst\(\{ where: \{ customerId, groupId \} \}\);/.test(body(csvc, 'async deleteGroupPolicy(')),
    'groupForPolicy finds by id AND business; monitoring scopeFor and putPolicy use it; deleteGroupPolicy looks up by business AND group');
  check('turning a group client-update policy on, or removing one, needs fresh authentication; deleting the group is refused while it carries one',
    /const group = groupId \? await this\.groups\.groupForPolicy[\s\S]{0,900}if \(input\.enabled && !fresh\('updates\.schedule'\)\) throw new FreshAuthNeeded\('updates\.schedule'\);/.test(body(csvc, 'async putPolicy('))
      && /if \(!before\) throw new NotFoundException\('This group has no policy'\);\s*\n\s*if \(!fresh\('updates\.schedule'\)\) throw new FreshAuthNeeded\('updates\.schedule'\);/.test(body(csvc, 'async deleteGroupPolicy('))
      && /this\.fresh\(\(\) => this\.svc\.deleteGroupPolicy\(a, biz\(q\), groupId, this\.isFresh\(req\)\)\)/.test(cctl)
      && /const held = await this\.policiesOn\(g\.id\);\s*\n\s*if \(held\) throw new ConflictException\(\{ code: 'GROUP_HAS_POLICIES'/.test(body(dgs, 'async remove(')),
    'putPolicy: enabled && !fresh after the group checks; deleteGroupPolicy: !fresh → FreshAuthNeeded, routed through this.fresh; DeviceGroupsService.remove refuses a group with policies');
  check('who is notified stays global or business only, and changing it still needs fresh authentication (§17)',
    /export const NotifyPolicyInput = z\.object\(\{\s*\n\s*scope: z\.enum\(\['global', 'business'\]\),/.test(eng)
      && /@Put\('notify-policy'\)\s*\n\s*async putPolicy\(@Actor\(\) a: ActorContext, @Body\(\) body: unknown, @Req\(\) req: Request\) \{\s*\n\s*this\.fresh\(req\);/.test(mctl),
    'NotifyPolicyInput scope is exactly global|business; PUT notify-policy calls this.fresh(req) first');
  check('a computer’s effective client-update policy is read through assertEndpointInScope and the visibility rule AND-ed with the id',
    /await this\.acl\.assertEndpointInScope\(a, endpointId, CAP\.COMPUTERS_VIEW\);\s*\n\s*const ep = await this\.prisma\.endpoint\.findFirst\(\{\s*\n\s*where: \{ AND: \[this\.acl\.endpointVisibilityWhere\(a\), \{ id: endpointId \}\] \},/.test(body(csvc, 'async endpointPolicy(')),
    'endpointPolicy: assertEndpointInScope(a, endpointId, CAP.COMPUTERS_VIEW), then findFirst AND [visibility, id]');
}

// 47. UI coverage (0.35). The browser suite now drives the 0.34 screens, and
//     what it found is held here. The Run panel offers Request a run and
//     Revoke only when an approval signer is configured: both go through the
//     signer, and a mirrored ACTIVE entry without one showed both beside
//     "scripts cannot be run here". Saving Email settings puts the saved
//     relay into the cache before the form is rebuilt, or the form came back
//     blank with "Send email" unticked, one Save away from switching it off.
//     The suite's own servers (the SMTP sink, the reference ClientSt0r peer)
//     listen on loopback, on ports the same refusal list covers, and the
//     global SMTP settings it changes are put back.
{
  const svc = read('apps/api/src/script-run/script-run.service.ts');
  check('the Run panel offers a run or a revoke only when an approval signer is configured',
    /const signerConfigured = this\.signer\.configured\(\);/.test(svc)
      && /canRevoke: signerConfigured && this\.mayPropose\(/.test(svc)
      && /canRun: signerConfigured && v\.status === 'APPROVED' && current\?\.status === 'ACTIVE',/.test(svc),
    'script-run.service.ts readiness(): canRun and canRevoke must both start with signerConfigured');
  const email = read('apps/web/app/(app)/settings/email/page.tsx');
  const set = email.indexOf("qc.setQueryData(['smtp-settings'], r);"), clear = email.indexOf('setF(null); qc.invalidateQueries');
  check('saving Email settings rebuilds the form from what was saved, not from the settings before the save',
    set > 0 && clear > set,
    "settings/email/page.tsx: qc.setQueryData(['smtp-settings'], r) before setF(null) in the save's onSuccess");
  const ui = read('apps/web/scripts/e2e-ui.mjs');
  check('e2e-ui.mjs: the SMTP sink and the reference peer listen on loopback, on refused-port-checked ports, and the SMTP settings are restored',
    /for \(const p of \[WEB_PORT, API_PORT, SMTP_PORT, PEER_PORT\]\) \{/.test(ui)
      && /srv\.listen\(port, '127\.0\.0\.1', r\)/.test(ui)
      && /smtpBefore\.row = await prisma\.smtpSettings\.findUnique\(/.test(ui) && /await cleanup035\(\);\n\s*await cleanup\(\);/.test(ui),
    'ports loop over WEB/API/SMTP/PEER; listen on 127.0.0.1; smtpBefore saved in seed035 and restored by cleanup035 in the final clean-up');
}

// 48. Groups on the device page (0.35). GET /endpoints/:id (and the public
//     API's copy of it) lists the rule groups a computer is in, so it must
//     answer exactly what the device list would, for the same reader: rule
//     groups only of that computer's own business, evaluated by the list's
//     evaluateRuleGroups AS the caller (their visibility and alert access),
//     over that one computer. A group whose rule reads alerts evaluates to
//     null for a reader without monitoring:alerts and must be dropped, not
//     shown — membership of "computers with critical alerts" would tell them
//     the alert state the list refuses them. findOne still checks scope
//     before anything is read, so another business's computer is a 404 and
//     its groups are never computed.
{
  const strip = (x) => x.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
  const es = strip(read('apps/api/src/endpoints/endpoints.service.ts'));
  const ls = strip(read('apps/api/src/endpoints/endpoint-list.service.ts'));
  const findOne = es.slice(es.indexOf('async findOne('), es.indexOf('async findOne(') + 2400);
  check('the device page’s groups come from the device list’s own evaluation, after the scope check',
    /^\s*async findOne\(actor: ActorContext, id: string\) \{\s*await this\.acl\.assertEndpointInScope\(actor, id\);/m.test(findOne)
      && /const groups = await this\.deviceList\.groupsOfComputer\(actor, \{ id: endpoint\.id, customerId: endpoint\.customerId \}, groupMemberships\.map\(\(m\) => m\.group\)\);/.test(findOne)
      && !/endpointGroup\.findMany|kind: 'RULE'/.test(findOne),
    'findOne: assertEndpointInScope first; groups = this.deviceList.groupsOfComputer(actor, {id, customerId}, static); no RULE-group query of its own');
  const fn = ls.slice(ls.indexOf('async groupsOfComputer('), ls.indexOf('private rowView('));
  check('a rule group is evaluated as the caller, only in the computer’s own business, and dropped when the caller may not evaluate it',
    /const groups = e\.customerId \? await this\.ruleGroupsOf\(\[e\.customerId\]\) : \[\];/.test(fn)
      && /await this\.evaluateRuleGroups\(actor, groups, \{ status: 'all', within: \[e\.id\] \}\)/.test(fn)
      && /groups\.filter\(\(g\) => members\.get\(g\.id\)\?\.includes\(e\.id\)\)/.test(fn)
      && /if \(ruleNeedsAlerts\(g\.rule\) && !alerts\.visible\) return null;/.test(ls),
    'groupsOfComputer: ruleGroupsOf([e.customerId]); evaluateRuleGroups(actor, …, { within: [e.id] }); keep only members.get(id)?.includes(e.id); evaluateRuleGroups returns null for an alert rule without alert access');
}

// 49. Reachable is not reporting (0.35). `isOnline` is true while the agent
//     heartbeats AND while hbbs can reach the computer with its agent silent
//     — the stale sweep keeps it so on purpose. Drawn as "Online", a computer
//     whose agent had been dead for twelve days looked healthy while its
//     monitoring, patching and actions were twelve days stale. Not an access
//     rule, but a console that says a machine is reporting when it is not is
//     the same kind of silent failure this file exists for. So: one window
//     (the API's HEARTBEAT_STALE_MS, which the sweep itself uses, and the web
//     copy of it must agree); the list's "online" filter needs a heartbeat
//     inside it and "silent" is the rest of isOnline; and the dashboard
//     counts online from connectivityOf, never from isOnline.
{
  const strip = (x) => x.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
  const windowOf = (file) => {
    const m = /^export const HEARTBEAT_STALE_MS = ([0-9_ *]+);$/m.exec(read(file));
    return m ? Function(`return (${m[1].replace(/_/g, '')});`)() : NaN;
  };
  const apiMs = windowOf('apps/api/src/common/connectivity.ts');
  const webMs = windowOf('apps/web/lib/connectivity.ts');
  const en = strip(read('apps/api/src/enrollment/enrollment.service.ts'));
  const ec = strip(read('apps/api/src/enrollment/enrollment.controller.ts'));
  const dm = strip(read('apps/web/components/endpoints/workspace/device-model.ts'));
  check('one heartbeat window: the sweep, the API and the console agree',
    Number.isFinite(apiMs) && apiMs > 0 && apiMs === webMs
      && /async markStaleEndpointsOffline\(thresholdMinutes = HEARTBEAT_STALE_MS \/ 60_000\)/.test(en)
      && /this\.enrollment\.markStaleEndpointsOffline\(\)/.test(ec) && !/markStaleEndpointsOffline\(\s*\d/.test(ec)
      && /import \{[^}]*\bHEARTBEAT_STALE_MS\b[^}]*\} from '@\/lib\/connectivity';/.test(dm) && /^export \{ HEARTBEAT_STALE_MS \};$/m.test(dm) && !/HEARTBEAT_STALE_MS\s*=/.test(dm),
    `API ${apiMs} ms, web ${webMs} ms; markStaleEndpointsOffline(thresholdMinutes = HEARTBEAT_STALE_MS / 60_000) called with no argument; device-model re-exports the web constant`);
  const ls = strip(read('apps/api/src/endpoints/endpoint-list.service.ts'));
  check('the device list’s “online” needs a heartbeat inside the window; “silent” is reachable without one',
    /if \(f\.online === 'online'\) and\.push\(\{ isOnline: true, lastSeenAt: \{ gte: heartbeatCutoff\(\) \} \}\);/.test(ls)
      && /if \(f\.online === 'silent'\) and\.push\(\{ isOnline: true, OR: \[\{ lastSeenAt: null \}, \{ lastSeenAt: \{ lt: heartbeatCutoff\(\) \} \}\] \}\);/.test(ls)
      && /connectivity: connectivityOf\(r\.isOnline, r\.lastSeenAt, now\)/.test(ls),
    "filterConds: online → { isOnline: true, lastSeenAt: { gte: heartbeatCutoff() } }; silent → isOnline and (null or older); rows carry connectivityOf");
  const ov = strip(read('apps/api/src/dashboard/overview.service.ts'));
  const ds = strip(read('apps/api/src/dashboard/dashboard.service.ts'));
  check('the dashboard counts online from connectivityOf and agent-silent apart',
    /const c = connectivityOf\(e\.isOnline, e\.lastSeenAt, now\.getTime\(\)\);\s*if \(c === 'online'\) online\+\+;/.test(ov)
      && !/if \(e\.isOnline\) online\+\+/.test(ov)
      && /isOnline: true, lastSeenAt: \{ gte: heartbeatCutoff\(\) \}, status: 'ACTIVE'/.test(ds)
      && /if \(c === 'online'\) p\.online \+= 1;/.test(ds) && !/if \(r\.isOnline\) p\.online/.test(ds),
    "overview: online++ only when connectivityOf is 'online'; GET /dashboard and the map count online with the heartbeat cutoff");
  // Integration (0.35): the automatic-snapshot scheduler (§50) has its own
  // "agent silent" reason. It was written against 10 minutes, so for twenty
  // minutes a computer's header said Online while its Processes tab said the
  // agent was silent. It must be the same constant.
  const sch = strip(read('apps/api/src/diagnostics-catalog/snapshot-schedule.ts'));
  check('the snapshot tabs call an agent silent on the same window as the header',
    /^export const AGENT_SILENT_MS = HEARTBEAT_STALE_MS;$/m.test(sch)
      && /import \{ HEARTBEAT_STALE_MS \} from '\.\.\/common\/connectivity';/.test(sch),
    'snapshot-schedule.ts: AGENT_SILENT_MS = HEARTBEAT_STALE_MS, imported from common/connectivity');
}

// 50. Automatic snapshots (0.35). The server asks a checking-in computer for
//     its process list, service list and network adapters on its own. What
//     must hold: only the three snapshot keys can ever be asked for without
//     a requester (the database CHECK, and the scheduler iterating
//     SNAPSHOT_KEYS); the scheduler runs only inside forHeartbeat, which only
//     an authenticated heartbeat reaches; a requester-less run skips the
//     requester re-check only for a snapshot key; reading a snapshot marks
//     the tab "watched" (which shortens the interval) only after the
//     visibility and capability checks, so nobody can make a computer they
//     cannot see collect anything; automatic runs are not audited one by one
//     but the schedule change is, Platform Admin only; pruning deletes only
//     finished automatic runs and never touches ActivityLog; and the off
//     switch is exact and set for the e2e runner and the browser suite.
{
  const svc = read('apps/api/src/diagnostics-catalog/diagnostics-catalog.service.ts');
  const sch = read('apps/api/src/diagnostics-catalog/snapshot-schedule.ts');
  const sql = read('apps/api/prisma/migrations/0059_auto_snapshots/migration.sql');
  const ctl = read('apps/api/src/diagnostics-catalog/diagnostics-catalog.controller.ts');
  const body = (name) => { const i = svc.indexOf(`  ${name}(`); const j = svc.indexOf('\n  }\n', i); return i < 0 ? '' : svc.slice(i, j); };
  const asyncBody = (name) => body(`async ${name}`) || body(`private async ${name}`);
  check('automatic runs are snapshot keys only: the database refuses any other key without a requester',
    /ADD CONSTRAINT "DiagnosticRun_automatic_snapshot_only" CHECK \(\s*"requestedById" IS NOT NULL OR "key" IN \('process_list', 'service_list', 'network_adapters'\)\s*\);/.test(sql)
      && /CREATE UNIQUE INDEX "DiagnosticRun_one_open_automatic" ON "DiagnosticRun"\("endpointId", "key"\)\s*WHERE "requestedById" IS NULL AND "status" IN \('REQUESTED', 'DELIVERED', 'RUNNING'\);/.test(sql),
    'migration 0059: DiagnosticRun_automatic_snapshot_only and the one-open-automatic partial unique index');
  const sched = asyncBody('scheduleAutomatic');
  check('the scheduler stages only what dueKeys returns, and dueKeys walks SNAPSHOT_KEYS',
    /for \(const key of SNAPSHOT_KEYS\) \{/.test(sch.slice(sch.indexOf('export function dueKeys('), sch.indexOf('export function automaticState(')))
      && /const due = dueKeys\(schedule, now,/.test(sched) && /for \(const d of due\) \{/.test(sched) && /key: d\.key,\s*requestedById: null, expiresAt:/.test(sched)
      && (svc.match(/requestedById: null, expiresAt:/g) ?? []).length === 1 && !/diagnosticRun\.(create|createMany|upsert)\(/.test(svc.replace(sched, '').replace(asyncBody('request'), '')),
    'one requester-less create in the service, inside scheduleAutomatic, keyed by dueKeys');
  check('the scheduler runs only from forHeartbeat, and only for an eligible computer with the switches on',
    (svc.match(/this\.scheduleAutomatic\(/g) ?? []).length === 1 && /await this\.scheduleAutomatic\(endpointId\);/.test(asyncBody('forHeartbeat'))
      && /if \(!this\.autoEnabled\) return;/.test(sched) && /if \(!schedule\.enabled\) return;/.test(sched)
      && /if \(!ep \|\| ineligible\(\{ \.\.\.ep, agentBound: !!node\?\.agentSecretHash \}, now\)\) return;/.test(sched)
      && /if \(authenticated\) \{\s*try \{\s*diagnostics = await this\.diagnostics\.forHeartbeat\(node\.endpointId\);/.test(read('apps/api/src/enrollment/enrollment.service.ts')),
    'scheduleAutomatic called once, from forHeartbeat; forHeartbeat called only under `if (authenticated)`');
  check('a requester-less run skips the requester re-check only for a snapshot key',
    /r\.requestedById === null \? \(isSnapshotKey\(r\.key\) \? null : 'not_a_snapshot'\) : await this\.requesterStillAllowed\(r, entry, ep\)/.test(asyncBody('forHeartbeat'))
      && /if \(!r\.requestedById\) return 'no_requester';/.test(svc),
    "forHeartbeat: requestedById === null ? (isSnapshotKey ? null : 'not_a_snapshot') : requesterStillAllowed");
  const snap = asyncBody('snapshot');
  check('reading a snapshot marks it watched only after visibility and the capability are checked',
    snap.indexOf('this.markWatched(endpointId, key)') > snap.indexOf('await this.assertVisible(actor, endpointId, cap);')
      && snap.indexOf('this.markWatched(endpointId, key)') > snap.indexOf('this.acl.assertCapability(actor, cap);')
      && snap.indexOf('await this.assertVisible(') > 0 && (svc.match(/this\.markWatched\(/g) ?? []).length === 1,
    'snapshot(): assertVisible, assertCapability, then markWatched — and nowhere else');
  check('automatic runs are not audited one by one; a schedule change is, by a Platform Admin',
    /private async auditDone\([^)]*\) \{\s*(\/\/[^\n]*\n\s*)*if \(r\.requestedById === null\) return;/.test(svc)
      && /this\.acl\.assertPlatformAdmin\(actor\);\s*const parsed = parseScheduleUpdate\(body\);/.test(svc)
      && /action: 'SNAPSHOT_SCHEDULE_CHANGED', resource: 'platform_settings', resourceId: 'singleton',\s*meta: \{ before, after \},/.test(svc)
      && /@Controller\('admin\/snapshot-schedule'\)\s*@UseGuards\(PlatformAdminGuard\)/.test(ctl)
      && (ctl.match(/@(Get|Put|Post|Delete|Patch)\(/g) ?? []).length === 7,
    'auditDone returns for requestedById null; updateSchedule: assertPlatformAdmin then audit before/after; controller PlatformAdminGuard; GET + PUT only');
  const prune = asyncBody('pruneAutomatic');
  check('pruning deletes only finished automatic runs, and nothing here touches the audit log',
    /deleteMany\(\{\s*where: \{ endpointId, key, requestedById: null, status: \{ in: \[\.\.\.DONE\] \}/.test(prune)
      && /const DONE = \['COMPLETED', 'FAILED', 'EXPIRED'\] as const;/.test(svc)
      && !/activityLog\.(update|delete|upsert)|"ActivityLog"/.test(svc + sch),
    'pruneAutomatic: requestedById null and a finished status; no ActivityLog write in the diagnostics service or the schedule');
  check('SNAPSHOT_SWEEP=off is exact, and set for run-e2e.sh and the browser suite',
    /export const sweepEnabled = \(env: Record<string, string \| undefined>\) => env\.SNAPSHOT_SWEEP !== 'off';/.test(sch)
      && /\nexport SNAPSHOT_SWEEP=off\n/.test(read('scripts/run-e2e.sh'))
      && /SNAPSHOT_SWEEP: 'off',/.test(read('apps/web/scripts/e2e-ui.mjs')),
    "sweepEnabled: env.SNAPSHOT_SWEEP !== 'off'; run-e2e.sh exports it; e2e-ui's API env sets it");
}

// 51. Agent health (0.36). The agent-silent monitor is never on by default
//     and nothing may create it, or any monitor, but a person. Since 0.36.1
//     (the owner's decision) it is one of RECOMMENDED, which "Add
//     recommended" creates in bulk — so that click is the only bulk path, and
//     it must stay a click: addRecommended goes through createRule, the one
//     place in the API that writes a MonitorRule, and is reached only from
//     its route; nothing in the API reads RECOMMENDED to install it at
//     startup, and no migration or the seed writes a rule. Its floor is the
//     console's own agent-silent window, so an alert never contradicts a
//     header that still says Online. It
//     raises only while RustDesk reaches the computer and clears only when
//     the agent checks in. The ClientSt0r contract names the alert kinds it
//     carries; this one is not among them, so it is never signed or sent
//     (adding it is a contract revision, not a side effect). And the
//     client-update sweep re-resolves queued automatic requests every tick,
//     before queuing, in every business — a computer that left a group must
//     not keep a request its policy no longer governs — writing only the
//     POLICY request it read, and recording the policy that queued each one.
{
  const strip = (x) => x.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
  const eng = strip(read('apps/api/src/monitoring/engine.ts'));
  const adm = strip(read('apps/api/src/monitoring/monitoring-admin.service.ts'));
  const block = (src, start) => { const i = src.indexOf(start); return i < 0 ? '' : src.slice(i, src.indexOf('\n];', i)); };
  const rec = block(eng, 'export const RECOMMENDED');
  const ra = adm.slice(adm.indexOf('async addRecommended('), adm.indexOf('private async ruleFor('));
  const cr = adm.slice(adm.indexOf('async createRule('), adm.indexOf('async addRecommended('));
  const srcFiles = walk('apps/api/src').filter((f) => /\.ts$/.test(f));
  const ruleWrites = srcFiles.flatMap((f) => (strip(read(f)).match(/monitorRule\.(create|createMany|upsert)\b/g) ?? []).map((m) => `${f}: ${m}`));
  const recReaders = srcFiles.filter((f) => /\bRECOMMENDED\b/.test(strip(read(f))));
  const addCallers = srcFiles.filter((f) => /\.addRecommended\(/.test(strip(read(f))));
  const migrations = walk('apps/api/prisma/migrations').filter((f) => /INSERT INTO "MonitorRule"/i.test(read(f)));
  const seed = strip(read('apps/api/prisma/seed.ts'));
  check('the agent-silent monitor is recommended, and only a click creates it',
    /\{ key: 'agent-silent', kind: 'AGENT_SILENT', name: '[^']+', severity: 'WARNING', params: \{ minutes: AGENT_SILENT_BOUNDS\.def \} \},/.test(rec)
      && /for \(const r of RECOMMENDED\) \{/.test(ra) && /added\.push\(await this\.createRule\(a, /.test(ra) && !/prisma\./.test(ra.replace(/this\.prisma\.monitorRule\.findMany\(/, ''))
      && ruleWrites.length === 1 && ruleWrites[0] === 'apps/api/src/monitoring/monitoring-admin.service.ts: monitorRule.create' && /this\.prisma\.monitorRule\.create\(/.test(cr)
      && recReaders.length === 2 && recReaders.includes('apps/api/src/monitoring/engine.ts') && recReaders.includes('apps/api/src/monitoring/monitoring-admin.service.ts')
      && (adm.match(/\bRECOMMENDED\b/g) ?? []).length === 3
      && addCallers.length === 1 && addCallers[0] === 'apps/api/src/monitoring/monitoring.controller.ts'
      && migrations.length === 0 && !/monitorRule|RECOMMENDED/.test(seed),
    `RECOMMENDED holds agent-silent (WARNING, AGENT_SILENT_BOUNDS.def); addRecommended loops RECOMMENDED into createRule and writes nothing itself; the API's only MonitorRule write is createRule's (${ruleWrites.join(', ') || 'none'}); only engine.ts and monitoring-admin read RECOMMENDED (${recReaders.join(', ')}), there for the import, the view and the loop; only the controller calls addRecommended (${addCallers.join(', ') || 'none'}); no migration inserts a MonitorRule and seed.ts writes none`);
  check('its threshold floor is the console’s agent-silent window',
    /export const AGENT_SILENT_BOUNDS = \{ min: HEARTBEAT_STALE_MS \/ 60_000, max: 7 \* 24 \* 60, def: 60 \} as const;/.test(eng)
      && /AGENT_SILENT: z\.object\(\{ minutes: ints\(AGENT_SILENT_BOUNDS\.min, AGENT_SILENT_BOUNDS\.max\)\.default\(AGENT_SILENT_BOUNDS\.def\) \}\)\.strict\(\),/.test(eng)
      && /import \{ HEARTBEAT_STALE_MS \} from '\.\.\/common\/connectivity';/.test(eng),
    'AGENT_SILENT_BOUNDS.min = HEARTBEAT_STALE_MS / 60_000 (imported from common/connectivity), and PARAMS.AGENT_SILENT uses it');
  const ev = eng.slice(eng.indexOf("case 'AGENT_SILENT': {"), eng.indexOf("case 'REBOOT_PENDING': {"));
  const iSkip = ev.indexOf("if (!live.lastSeenAt) return { verdict: 'skip'");
  const iClear = ev.indexOf("if (silentMin < P.minutes) return { verdict: 'ok',");
  const iHold = ev.indexOf("if (!live.isOnline) return { verdict: 'pending', state: st };");
  const iRaise = ev.indexOf("return { verdict: 'breach'");
  check('it raises only while reachable, and clears only when the agent has checked in',
    iSkip > 0 && iClear > iSkip && iHold > iClear && iRaise > iHold && (ev.match(/verdict: 'breach'/g) ?? []).length === 1
      && /const SWEEP_KINDS = new Set\(\['OFFLINE', 'REBOOT_PENDING', 'AGENT_SILENT'\]\);/.test(strip(read('apps/api/src/monitoring/monitoring.service.ts'))),
    "evaluateLive AGENT_SILENT: skip a never-reported agent, clear when silence < threshold, hold (pending) when not isOnline, and only then breach; swept, not heartbeat-driven");
  const ae = strip(read('apps/api/src/monitoring/alert-events.service.ts'));
  const emit = ae.slice(ae.indexOf('async emit('), ae.indexOf('private async patchFor('));
  const contract = read('apps/api/src/integration/contract.ts');
  check('agent-silent alerts are never signed or sent to ClientSt0r (not a contract kind)',
    /const CONTRACT_ALERT_KINDS: ReadonlySet<string> = new Set\(Alert\.shape\.kind\.options\);/.test(ae)
      && emit.indexOf('if (!CONTRACT_ALERT_KINDS.has(a.kind)) return 0;') > 0
      && emit.indexOf('if (!CONTRACT_ALERT_KINDS.has(a.kind)) return 0;') < emit.indexOf('signAlertEvent(')
      && /kind: z\.enum\(\['OFFLINE', 'DISK_FREE', 'CPU_HIGH', 'MEMORY_HIGH', 'SERVICE_STOPPED', 'EVENT_MATCH', 'REBOOT_PENDING', 'SITE_OUTAGE'\]\),/.test(contract),
    'emit() returns before signing for a kind outside Alert.shape.kind; the contract enum is unchanged (adding AGENT_SILENT is a contract revision)');
  const csw = strip(read('apps/api/src/client-updates/client-update-sweep.service.ts'));
  const cus = strip(read('apps/api/src/client-updates/client-updates.service.ts'));
  const pass51 = csw.slice(csw.indexOf('private async pass('), csw.indexOf('private async queue('));
  const rq = cus.slice(cus.indexOf('async reconcileQueued('), cus.indexOf('async holdForHeartbeat('));
  check('every sweep re-resolves queued automatic updates, in every business, before queuing',
    /const r = await this\.svc\.reconcileQueued\(\{ audit: true \}\);/.test(pass51) && pass51.indexOf('reconcileQueued(') < pass51.indexOf('this.queue(now)')
      && !/containment|enabled/.test(pass51)
      && /updateRequestedById: null, updateHoldReason: null, updateHoldAt: null, updatePolicyId: p\.id,/.test(csw)
      && /const eff = effectivePolicy\(policies, customerId, n\.endpoint\.siteId, m\.groupsOf\(n\.endpointId\)\);\s*const d = reconcileQueued\(n\.updatePolicyId \?\? null, eff, policies\);/.test(rq)
      && /const m = await this\.membershipFor\(policies, nodes\.map\(\(n\) => n\.endpointId\)\);/.test(rq),
    'pass(): reconcileQueued({ audit: true }) first, unconditionally, then queue(); queuing records updatePolicyId; reconcile resolves with this tick’s membership');
  check('a re-resolved request is withdrawn whole or moved, and each change is audited with its reason',
    /\? \{ updateRequestedAt: null, updateTargetVersion: null, updateRequestSource: null, updateRequestedById: null, updateHoldReason: null, updateHoldAt: null, updatePolicyId: null \}/.test(rq)
      && /: \{ updatePolicyId: d\.to,/.test(rq)
      && /if \(w\.count !== 1\) continue;/.test(rq)
      && /action: d\.action === 'withdraw' \? 'CLIENT_UPDATE_AUTO_WITHDRAWN' : 'CLIENT_UPDATE_AUTO_REPLANNED',/.test(rq)
      && /reason: d\.reason, text: QUEUED_REASON_TEXT\[d\.reason!\], fromPolicyId: d\.from, toPolicyId: d\.to,/.test(rq),
    'withdraw clears every request field; replan only moves updatePolicyId (and the stale hold); audit only on a write that took, with reason, from and to');
  // 0.36 heartbeat cost: a computer with nothing due skips the scheduler's
  // queries until its next due time. Skipping can only delay a snapshot, never
  // ask for one; it must never outlive what changes the answer.
  const dsvc = strip(read('apps/api/src/diagnostics-catalog/diagnostics-catalog.service.ts'));
  const dsch = strip(read('apps/api/src/diagnostics-catalog/snapshot-schedule.ts'));
  const sa = dsvc.slice(dsvc.indexOf('private async scheduleAutomatic('), dsvc.indexOf('private async pruneAutomatic('));
  check('the snapshot scheduler’s quiet window only skips, is bounded, and is dropped by whatever changes the answer',
    /if \(q > t && !SNAPSHOT_KEYS\.some\(\(k\) => this\.isWatched\(endpointId, k, t\)\)\) return;/.test(sa)
      && sa.indexOf('this.quiet.get(endpointId)') < sa.indexOf('this.prisma.')
      && /if \(!due\.length\) \{\s*const until = quietUntil\(schedule, history, now, QUIET_CAP_MS\);/.test(sa)
      && /export const QUIET_CAP_MS = 60 \* 60_000;/.test(dsch) && /if \(!h \|\| h\.open\) return null;/.test(dsch)
      && /async report\([^)]*\) \{\s*if \(!isCatalogKey\(dto\.key\)\) return [^\n]*\{ accepted: false, reason: 'unknown_key' \};\s*this\.quiet\.delete\(endpointId\);/.test(dsvc)
      && /if \(n\.count\) \{ this\.quiet\.delete\(r\.endpointId\);/.test(dsvc)
      && /this\.scheduleCache = null;\s*this\.quiet\.clear\(\);/.test(dsvc)
      && /if \(this\.quiet\.size >= QUIET_MAX_ENTRIES\) this\.quiet\.clear\(\);/.test(sa),
    'scheduleAutomatic returns early only inside the window with no tab watched; the window is set only when nothing is due, capped at 1 h, never with a run open; report, expiry and a schedule change drop it; the map is bounded');
}

// 52. Signed revocation (0.36). A script hash taken off the signer's allowlist,
//     or a software catalog entry archived, after a plan using it was signed:
//     the plan is genuine and inside its window, so without this the agent
//     runs it. What must hold: the signer signs one statement of every
//     revocation under its own domain prefix, and the agent checks the same
//     prefix against approval/keys.json only; the published set is a union
//     with the ledger, so it never shrinks, and software revocations are
//     write-once with nothing that removes one; the signer refuses a revoked
//     install at admission and again at approval, and a software plan with no
//     entry id at all; the agent refuses a lower seq or a statement leaving
//     out one it holds; the check sits after the signed pause and before
//     Precheck and the "executing" journal, a stale statement is NOT final
//     (fail closed, nothing consumed) and a revoked plan is; the Windows agent
//     actually fetches the statement and caps it; and the portal revokes on
//     the signer before it archives, and drops its cached statement when it
//     revokes or a plan is signed.
{
  const code = (s) => s.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
  const core = code(read('apps/api/src/approval-signer/core.ts'));
  const server = code(read('apps/api/src/approval-signer/server.ts'));
  const store = code(read('apps/api/src/approval-signer/store.ts'));
  const goRev = read('tools/windows-installer/internal/action/revocation.go');
  const goAct = read('tools/windows-installer/internal/action/action.go');
  const goAgent = read('tools/windows-installer/internal/agent/agent.go');
  const goWin = read('tools/windows-installer/action_windows.go');
  const sw = code(read('apps/api/src/software/software.service.ts'));
  const sr = code(read('apps/api/src/script-run/script-run.service.ts'));
  const acts = code(read('apps/api/src/actions/actions.service.ts'));
  const relay = code(read('apps/api/src/actions/revocations.controller.ts'));
  const goFn = (src, name) => { const i = src.indexOf(`func ${name}(`); const j = src.indexOf('\n}\n', i); return i < 0 ? '' : src.slice(i, j); };

  check('the revocation statement is signed under its own prefix, the same on the signer and the agent, and verified only against the approval keys',
    /export const REVOCATION_SIGNING_PREFIX = 'rem0te-revocations-v1\\n';/.test(core)
      && /RevocationPrefix\s+= "rem0te-revocations-v1\\n"/.test(goRev)
      && /edSign\(null, Buffer\.concat\(\[Buffer\.from\(REVOCATION_SIGNING_PREFIX, 'utf8'\), bytes\]\), k\.key\)/.test(core)
      && /for _, k := range keys \{\s*if k\.Kid == env\.Kid \{/.test(goFn(goRev, 'ParseRevocations'))
      && /!ed25519\.Verify\(key, append\(\[\]byte\(RevocationPrefix\), body\.\.\.\), sig\)/.test(goFn(goRev, 'ParseRevocations'))
      && /r\.Seq != len\(r\.Scripts\)\+len\(r\.Software\)/.test(goFn(goRev, 'ParseRevocations'))
      && /export const MAX_REVOCATIONS = 5000;/.test(core) && /MaxRevocations = 5000/.test(goRev),
    'core.ts signs with REVOCATION_SIGNING_PREFIX; revocation.go verifies the same prefix against a key from o.Keys by kid, seq = entry count; MAX_REVOCATIONS = MaxRevocations = 5000');

  check('the published statement never shrinks, and nothing removes a software revocation',
    /const prev = store\.publishedRevocations\(\);\s*const set = mergeRevocations\(prev, \{ scripts: store\.scriptRevocations\(\), software: store\.softwareRevocations\(\) \}\);/.test(server)
      && /\[\.\.\.\(prev\?\.scripts \?\? \[\]\), \.\.\.cur\.scripts\]/.test(core) && /\[\.\.\.\(prev\?\.software \?\? \[\]\), \.\.\.cur\.software\]/.test(core)
      && /revokeSoftware\(entryId: string, rev: Revocation\): boolean \{[\s\S]{0,200}'software-revocations', `\$\{entryId\}\.json`\), JSON\.stringify\(rev, null, 2\), \{ mode: 0o600, flag: 'wx' \}\)/.test(store)
      && (store.match(/unlinkSync\(/g) ?? []).length === 1 && /unlinkSync\(path\.join\(this\.dir, 'device-keys'/.test(store)
      && !/software-revocations/.test(server) && !/\/software\/[^\n]*\/(unrevoke|restore|reinstate)/.test(server),
    "server's revocations(): mergeRevocations(publishedRevocations(), on-disk); merge is a union; revokeSoftware writes flag 'wx'; the store's only unlink is device-keys; no HTTP route un-revokes");

  check('the signer refuses an install from a revoked entry at admission and at approval, and a software plan naming no entry',
    /if \(p\.action\.id === SCRIPT_RUN_ACTION\) assertScriptAllowed\(p, scripts\);\s*assertSoftwareAllowed\(p, softwareRevoked\);\s*return \{ plan: p, digest: planDigest\(p\) \};/.test(core)
      && /if \(!id\) throw new Refused\('software_entry_missing'/.test(core)
      && /if \(p\.action\.id === SOFTWARE_INSTALL_ACTION && softwareRevoked\(id\)\) throw new Refused\('software_revoked'/.test(core)
      && /admitPlan\(b\.plan, store\.policy\(\), now\(\), \(id\) => store\.scriptEntry\(id\), softwareRevoked\)/.test(server)
      && /if \(c\.decision === 'approve'\) assertSoftwareAllowed\(cur\.plan, softwareRevoked\);/.test(server)
      && /const softwareRevoked = \(entryId: string\) => !!store\.softwareRevocation\(entryId\);/.test(server),
    'admitPlan ends with assertSoftwareAllowed; it refuses software_entry_missing and software_revoked; server passes softwareRevoked at admission and re-checks before an approve');

  const cur = goFn(goRev, 'currentRevocations');
  check('the agent keeps the newest statement and refuses rollback: a lower seq, or one that leaves out a revocation it holds',
    /case held != nil && got\.Seq < held\.Seq:\s*return held,/.test(cur)
      && /case held != nil && !got\.covers\(held\):\s*return held,/.test(cur)
      && /case err != nil:\s*return held,/.test(cur)
      && /_ = atomicWrite\(revocationsPath\(o\), json\.RawMessage\(o\.Revocations\)\)\s*\}\s*return got, ""/.test(cur)
      && /held, _ = ParseRevocations\(raw, o\.Keys\)/.test(cur),
    'currentRevocations: an error, a lower seq or a non-superset returns the held one; only a taken statement is written; the held one is re-verified on read');

  const chk = goFn(goRev, 'revocationCheck');
  const iPause = goAct.indexOf('o.Pause.ActionsPaused(');
  const iRev = goAct.indexOf('revocationCheck(plan, o)');
  const iPre = goAct.indexOf('a.Precheck(plan, o)');
  const iExec = goAct.indexOf('State: "executing"');
  check('the agent checks revocations after the signed pause and before Precheck and "executing"; stale is not final, revoked is',
    iPause > 0 && iRev > iPause && iPre > iRev && iExec > iPre
      && /if rr, isFinal := revocationCheck\(plan, o\); rr != nil \{\s*r := \*rr\s*r\.JobID = jobID\s*if !isFinal \{\s*return r, nil\s*\}\s*return final\(o, jobID, planSHA, r\)\s*\}/.test(goAct)
      && /if rv == nil \|\| rv\.asOf\.Before\(signed\) \{[\s\S]{0,700}return refuse\("revocations_stale", d\), false\s*\}/.test(chk)
      && /if \(p\.Script != nil && rv\.scripts\[p\.Script\.ContentSHA256\]\) \|\| rv\.scripts\[sha\] \{\s*return refuse\("revoked", [^\n]*\), true/.test(chk)
      && /if rv\.software\[id\] \{\s*return refuse\("revoked", [^\n]*\), true/.test(chk)
      && /if id == "" \{\s*return refuse\("software_entry_missing", [^\n]*\), true/.test(chk),
    'action.go: pause, then revocationCheck (non-final returns without final()), then Precheck, then the executing journal; revocation.go: no statement or an older one is revocations_stale (false); a revoked hash or entry is revoked (true)');

  check('the Windows agent fetches the statement for every job, from the pinned portal, capped',
    /revs, rerr := agent\.FetchRevocations\(agent\.Options\{PortalHost: pinnedPortal\(\), Paths: paths\}\)/.test(goWin)
      && /Revocations: revs\}/.test(goWin)
      && /io\.LimitReader\(resp\.Body, action\.MaxRevocationBytes\+1\)/.test(goFn(goAgent, 'FetchRevocations'))
      && /if !ValidPortal\(o\.PortalHost\) \{/.test(goFn(goAgent, 'FetchRevocations')),
    'action_windows.go: agent.FetchRevocations(pinnedPortal()) and Revocations: revs; FetchRevocations validates the portal and caps the body at MaxRevocationBytes');

  const arch = sw.slice(sw.indexOf('async archive('), sw.indexOf('async archive(') + 2500);
  const iRevoke = arch.indexOf('this.signer.revokeSoftware(e.id, p.data.reason)');
  const iUpd = arch.indexOf('this.prisma.softwareCatalogEntry.updateMany(');
  check('the portal revokes on the signer before it archives, and drops its cached statement whenever something is revoked or signed',
    iRevoke > 0 && iUpd > iRevoke
      && /if \(rv\.status !== 200 \|\| rv\.body\.status !== 'REVOKED'\) throw new ConflictException\(\{ code: 'APPROVAL_SIGNER_REFUSED'/.test(arch)
      && arch.indexOf('this.relay.invalidate();') > iRevoke && arch.indexOf('this.relay.invalidate();') < iUpd
      && /this\.relay\.invalidate\(\);/.test(sr)
      && /if \(next\.status === 'APPROVED'\) this\.relay\?\.invalidate\(\);/.test(acts)
      && /if \(gen === this\.generation\) this\.cached = \{ at: now, body \};/.test(relay)
      && /invalidate\(\) \{ this\.cached = null; this\.generation\+\+; \}/.test(relay),
    'archive(): signer.revokeSoftware, refuse unless REVOKED, relay.invalidate, then updateMany; script revoke and a newly APPROVED plan invalidate; a fetch that raced an invalidation is not cached');

  check('the relay is a read-only courier: one public GET, four envelope fields passed on, nothing added',
    (relay.match(/@(Get|Post|Put|Patch|Delete)\(/g) ?? []).length === 1 && /@Get\('revocations\.json'\)\s*@Public\(\)/.test(relay)
      && /const body = JSON\.stringify\(\{ schema: r\.body\.schema, kid: r\.body\.kid, statement: r\.body\.statement, sig: r\.body\.sig \}\);/.test(relay),
    "revocations.controller.ts: exactly one route, GET public/approval/revocations.json; the body is the signer's four fields");

  const dispatch = acts.slice(acts.indexOf('private async dispatchBlock('));
  check('an undelivered plan whose script or software entry was revoked is refused by the portal too, first',
    /^private async dispatchBlock\(j: ActionJob, endpointId: string\): Promise<string \| null> \{\s*if \(await this\.revokedSinceSigning\(j\)\) return 'revoked';/.test(dispatch)
      && /return e\?\.status === 'REVOKED';/.test(acts) && /return !e \|\| !!e\.archivedAt;/.test(acts),
    "dispatchBlock's first line: revokedSinceSigning → 'revoked' (script entry REVOKED; software entry archived or gone)");
}

// 53. Automatic agent self-update (0.36). When a computer's agent is older
//     than what this server serves, the heartbeat asks it to re-run its
//     update path by itself. What must hold: it runs only for an authenticated
//     heartbeat outside an updates pause, never replaces a flag another step
//     set and comes before the containment override; it sends only the two
//     flags agents already act on, with no nonce; nothing goes out under a
//     pause, a rollout, another queued install or an open session, an
//     attempt hands the flag out for less than the agent's 30-minute floor,
//     the attempt cap is checked first and the global pace is counted under
//     a lock; Linux and macOS are never asked; attempts are history rows, not
//     audit entries, while the settings change is Platform Admin, fresh and
//     audited, and opting a policy back in needs fresh authentication; the
//     signed heartbeat's periodic check runs only `rem0te-agent.exe update`;
//     and the off switch is exact and set for every other suite.
//     0.46: a computer's own setting (Endpoint.agentAutoUpdate) is consulted
//     in every dispatch decision, its Off always wins (and the platform and
//     process switches still win over its On), changing it needs computers:edit
//     and, for anything but Off, fresh authentication, and every change is
//     conditional and audited; the business page's selector writes only the
//     business policy's agent mode under the policy's own rules.
//     0.49 (§ 62, at the owner's request): every "fresh authentication" here
//     is a step-up that names its catalog key (agent.autoupdate / agent.autoupdate.business / agent.autoupdate.computer); a Platform Admin
//     may turn a key off under Settings → Confirm it is you. Until 0.49 it
//     could not be configured.
{
  const enr = read('apps/api/src/enrollment/enrollment.service.ts');
  const sch = read('apps/api/src/agent-auto-update/schedule.ts');
  const svc = read('apps/api/src/agent-auto-update/agent-auto-update.service.ts');
  const ctl = read('apps/api/src/agent-auto-update/agent-auto-update.controller.ts');
  const cus = read('apps/api/src/client-updates/client-updates.service.ts');
  const up = read('apps/api/src/agent-upgrade/agent-upgrade.service.ts');
  const ws = read('apps/api/src/public/windows-script.ts');
  const hbStep = enr.slice(enr.indexOf('let agentSelfCheck = false;'), enr.indexOf('// v0.28: updates paused everywhere or for this business.'));
  check('the heartbeat step runs only when authenticated and not paused, adds a flag only when none is going out, and precedes the containment override',
    hbStep.length > 200 && /if \(authenticated && !updatesHeld && !isInstallerCheckIn\(dto\)\) \{\s*try \{\s*const auto = await this\.agentAuto\.forHeartbeat\(\{/.test(hbStep)
      && /if \(auto\.flag && !updateRustdesk && !reinstallAgent\) \{/.test(hbStep)
      && /flagGoingOut: !!\(updateRustdesk \|\| reinstallAgent\)/.test(hbStep)
      && enr.indexOf('let agentSelfCheck = false;') > enr.indexOf('const mig = await this.agentMigration.forHeartbeat(')
      && /if \(updatesHeld\) \{\s*updateRustdesk = null;\s*reinstallAgent = null;/.test(enr.slice(enr.indexOf('let agentSelfCheck = false;')))
      && (enr.match(/this\.agentAuto\.forHeartbeat\(/g) ?? []).length === 1,
    'enrollment.service: `if (authenticated && !updatesHeld && !isInstallerCheckIn(dto))`, `if (auto.flag && !updateRustdesk && !reinstallAgent)`, after the migration step, before `if (updatesHeld)`');
  check('it sends only reinstallAgent or updateRustdesk, with this server\'s version and no nonce',
    /if \(auto\.flag === 'updateRustdesk'\) updateRustdesk = \{ targetVersion: this\.platformVersion\(\) \};\s*else reinstallAgent = \{ targetVersion: this\.platformVersion\(\) \};/.test(hbStep)
      && !/nonce/.test(hbStep.replace(/\/\/[^\n]*/g, ''))
      && /return channel === 'standard_pre015' \? 'updateRustdesk' : 'reinstallAgent';/.test(sch),
    'the step\'s two assignments; flagFor returns one of the two flags');
  const dec = sch.slice(sch.indexOf('export function decide('), sch.indexOf('export function selfCheckAllowed('));
  const at = (t) => dec.indexOf(t);
  check('nothing is dispatched under a pause, a rollout, another queued install, a closed window or an open session; the cap is checked before any dispatch',
    at("if (i.paused) return out('queued', 'paused', t);") > 0 && at("if (i.rollout) return out('queued', 'rollout', t);") > 0
      && at("if (i.pendingRequest) return out('queued', 'pending_request', t);") > 0 && at("if (i.sessionOpen) return out('queued', 'session_open', t);") > 0
      && at("if (i.mode === 'WINDOW' && !i.windowOpen) return out('queued', 'outside_window', t);") > 0
      && [ "if (i.paused)", "if (i.rollout)", "if (i.pendingRequest)", "if (i.sessionOpen)", 'if (i.attempts >= i.settings.maxAttempts && !inAttempt)' ].every((x) => at(x) > 0 && at(x) < at("dispatch: 'resend'") && at(x) < at("dispatch: 'new'"))
      && at("if (i.mode === 'OFF') return out('opted_out', i.modeSource === 'computer' ? 'computer_off' : 'policy_off', t);") > 0
      && at("if (i.mode === 'OFF') return out('opted_out', i.modeSource === 'computer' ? 'computer_off' : 'policy_off', t);") < at("dispatch: 'resend'")
      && (dec.match(/dispatch: '(resend|new)'/g) ?? []).length === 2,
    'decide(): every hold and the attempt cap return before the only two dispatching returns');
  check('one attempt hands the flag out for less than the agent\'s 30-minute floor, and attempts back off',
    /export const ATTEMPT_WINDOW_MS = 20 \* MIN;/.test(sch) && /export const BACKOFF_MS = \[0, 2 \* H, 8 \* H, 24 \* H\] as const;/.test(sch)
      && /TotalMinutes -ge 30\)/.test(ws),
    'ATTEMPT_WINDOW_MS = 20 * MIN; BACKOFF_MS [0, 2h, 8h, 24h]; the heartbeat keeps its 30-minute floor');
  const start = svc.slice(svc.indexOf('private async startAttempt('), svc.indexOf('private async complete('));
  check('the global pace is counted under an advisory lock, and the node moves only from the state this heartbeat read',
    /await tx\.\$executeRawUnsafe\(`SELECT pg_advisory_xact_lock\(hashtext\('rem0te\.agent-auto-update\.pace'\)\)`\);\s*const used = await tx\.agentAutoUpdateAttempt\.count\(/.test(start)
      && /if \(used >= settings\.perHour\) return 'pacing' as const;/.test(start)
      && /where: \{ id: node\.id, agentAutoTarget: node\.agentAutoTarget, agentAutoAttempts: node\.agentAutoAttempts, agentAutoLastAt: node\.agentAutoLastAt \},/.test(start)
      && /if \(moved\.count !== 1\) return 'raced' as const;/.test(start)
      && (svc.match(/agentAutoUpdateAttempt\.create\(/g) ?? []).length === 1 && start.includes('agentAutoUpdateAttempt.create('),
    'startAttempt: lock, count vs perHour, conditional updateMany, the only create');
  check('Linux and macOS agents and computers without a device secret are never asked',
    /if \(readOnlyAgentOs\(f\.platform\)\) return \{ none: 'read_only_agent' \};/.test(sch) && /if \(!f\.hasSecret\) return \{ none: 'no_device_secret' \};/.test(sch)
      && /const ch = agentChannel\(facts\);\s*if \(!\('channel' in ch\)\) return \{ flag: null, selfCheck: false \};/.test(svc),
    'agentChannel: read-only OS first, then the device secret; forHeartbeat returns nothing without a channel');
  const put = svc.slice(svc.indexOf('async putSettings('));
  const setc = svc.slice(svc.indexOf('  async setComputer('), svc.indexOf('  private paceUsed('));
  check('attempts are not audit entries; the settings change is Platform Admin, fresh and audited before/after',
    // 0.46: two audit.log calls — putSettings, and setComputer (a person's change of one computer's setting).
    (svc.match(/this\.audit\.log\(/g) ?? []).length === 2 && put.includes('this.audit.log(') && setc.includes('this.audit.log(')
      && /this\.acl\.assertPlatformAdmin\(actor\);[\s\S]{0,300}assertFresh\(freshMethod, \{ action: 'agent\.autoupdate'/.test(put)
      && /action: 'AGENT_AUTO_UPDATE_SETTINGS_CHANGED', resource: 'platform_settings', resourceId: 'singleton',\s*meta: \{ before: shape\(before\), after: shape\(after\) \},/.test(put)
      && /async getSettings\(actor: ActorContext\) \{\s*this\.acl\.assertPlatformAdmin\(actor\);/.test(svc)
      && /@Controller\('admin\/agent-auto-update'\)\s*@UseGuards\(PlatformAdminGuard\)/.test(ctl) && (ctl.match(/@(Get|Put|Post|Delete|Patch)\(/g) ?? []).length === 2
      && !/activityLog\.(create|update|delete|upsert)/.test(svc + sch),
    'two audit.log calls in the service — putSettings (after assertPlatformAdmin and assertFresh) and setComputer; PlatformAdminGuard; GET + PUT only');
  check('opting a policy back in (any agent mode but OFF) needs fresh authentication; opting out does not',
    /if \(input\.agentMode !== undefined && input\.agentMode !== 'OFF' && \(input\.agentMode \?\? null\) !== \(before\?\.agentMode \?\? null\) && !fresh\('agent\.autoupdate\.business'\)\) throw new FreshAuthNeeded\('agent\.autoupdate\.business'\);/.test(cus)
      && cus.indexOf("throw new FreshAuthNeeded('agent.autoupdate.business');\n    const biz") > cus.indexOf("input.agentMode !== 'OFF'") - 400,
    'client-updates.service putPolicy: the agentMode fresh check');

  // 0.46: one computer's own setting (Endpoint.agentAutoUpdate), and the
  // business page's selector (the business policy's agentMode only).
  const modes = svc.slice(svc.indexOf('  async modesFor('), svc.indexOf('  private async rolloutOwns('));
  const rm = sch.slice(sch.indexOf('export function resolveMode<'), sch.indexOf('// ── The decision'));
  check('the per-computer override is consulted in every dispatch decision: modesFor reads it for every computer and hands it to resolveMode',
    /const overrides = new Map\(\(eps\.length \? await this\.prisma\.endpoint\.findMany\(\{ where: \{ id: \{ in: eps\.map\(\(e\) => e\.id\) \} \}, select: \{ id: true, agentAutoUpdate: true \} \}\) : \[\]\)/.test(modes)
      && /const r = resolveMode\(\[\], overrides\.get\(ep\.id\) \?\? null\);/.test(modes)
      && /const override = overrides\.get\(ep\.id\) \?\? null;\s*const \{ mode, policy, source, inherited \} = resolveMode\(ranked, override\);/.test(modes)
      && (svc.match(/resolveMode\(/g) ?? []).length === 2
      && /async modeFor\([^)]*\) \{\s*return \(await this\.modesFor\(\[ep\], now\)\)\.get\(ep\.id\)!;/.test(svc)
      && (svc.match(/const gov = await this\.modeFor\(ep, now\);/g) ?? []).length === 3
      && (svc.match(/mode: gov\.mode, modeSource: gov\.source, windowOpen: gov\.windowOpen,/g) ?? []).length === 2,
    'agent-auto-update.service modesFor: one findMany of agentAutoUpdate, passed to resolveMode on both branches; forHeartbeat, selfCheck and card go through modeFor');
  check('Off always wins: a computer\'s Off is OFF before any policy is looked at, and decide() checks the platform and process switches before the mode',
    rm.indexOf("if (computer === 'off') return { mode: 'OFF', policy: null, source: 'computer', inherited };") > 0
      && rm.indexOf("if (computer === 'off')") < rm.indexOf("if (computer === 'on')")
      // On never yields OFF: its only two answers are the policy's WINDOW or ANY_TIME.
      && /if \(computer === 'on'\) \{\s*return inherited\.mode === 'WINDOW'\s*\? \{ mode: 'WINDOW', policy: inherited\.policy, source: 'computer', inherited \}\s*: \{ mode: 'ANY_TIME', policy: null, source: 'computer', inherited \};\s*\}\s*return \{ mode: inherited\.mode, policy: inherited\.policy, source: inherited\.source, inherited \};\s*\}$/m.test(rm.trimEnd())
      && at("if (!i.settings.enabled) return out('opted_out', 'platform_off', t);") > 0
      && at("if (!i.settings.enabled)") < at("if (i.mode === 'OFF')") && at("if (!i.settings.processOn)") < at("if (i.mode === 'OFF')")
      && /return i\.settings\.enabled && i\.settings\.processOn && i\.mode !== 'OFF'/.test(sch)
      && /export function computerOverride\(v: string \| null \| undefined\): ComputerOverride \| null \{\s*return v === 'on' \|\| v === 'off' \? v : null;/.test(sch)
      && /CHECK \("agentAutoUpdate" IS NULL OR "agentAutoUpdate" IN \('on', 'off'\)\)/.test(read('apps/api/prisma/migrations/0068_agent_auto_update_scope/migration.sql')),
    "schedule.ts resolveMode: `if (computer === 'off')` first; decide(): platform and process switches before the mode; selfCheckAllowed needs both; 0068's CHECK");
  const upCtl = read('apps/api/src/agent-upgrade/agent-upgrade.controller.ts');
  check('changing one computer\'s setting needs computers:edit on it, and anything but Off needs fresh authentication before the write',
    /@Put\(':id\/agent\/auto-update'\)\s*@RequireCapability\(CAP\.COMPUTERS_EDIT\)\s*@RateLimit\(20\)\s*async setAutoUpdate\([\s\S]{0,200}?\) \{\s*return \{ success: true, data: await this\.auto\.setComputer\(actor, id, body, this\.freshMethod\(req\)\) \};/.test(upCtl)
      && /^\s*await this\.acl\.assertEndpointInScope\(actor, endpointId, CAP\.COMPUTERS_EDIT\);\s*this\.acl\.assertCapability\(actor, CAP\.COMPUTERS_EDIT\);/.test(setc.slice(setc.indexOf('{') + 1))
      && /if \(value !== 'off'\) \{\s*assertFresh\(freshMethod, \{/.test(setc)
      && setc.indexOf("if (value !== 'off') {") > 0 && setc.indexOf("if (value !== 'off') {") < setc.indexOf('this.prisma.endpoint.updateMany(')
      && (svc.match(/this\.auto\.setComputer\(|setComputer\(/g) ?? []).length === 1,
    "agent-upgrade.controller: PUT :id/agent/auto-update with COMPUTERS_EDIT; setComputer: assertEndpointInScope(COMPUTERS_EDIT) first, `if (value !== 'off') { assertFresh(` before the updateMany");
  const writers = walk('apps/api/src').filter((f) => /\bagentAutoUpdate\s*:\s*(?!true\b)/.test(read(f)));
  check('every change of a computer\'s setting is conditional and audited with before and after, and only setComputer writes it',
    /const w = await this\.prisma\.endpoint\.updateMany\(\{ where: \{ id: endpointId, agentAutoUpdate: ep\.agentAutoUpdate \}, data: \{ agentAutoUpdate: value \} \}\);\s*if \(w\.count !== 1\) throw new ConflictException\(\{[^\n]*\}\);\s*await this\.audit\.log\(\{\s*tenantId: ep\.tenantId/.test(setc)
      && /action: 'AGENT_AUTO_UPDATE_COMPUTER_SET', resource: 'endpoint', resourceId: endpointId,\s*meta: \{ before: before \?\? 'inherit', after: value \?\? 'inherit',/.test(setc)
      && setc.indexOf('this.audit.log(') > setc.indexOf('this.prisma.endpoint.updateMany(')
      && JSON.stringify(writers) === JSON.stringify(['apps/api/src/agent-auto-update/agent-auto-update.service.ts'])
      && (svc.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '').match(/agentAutoUpdate: value/g) ?? []).length === 1,
    `only agent-auto-update.service names agentAutoUpdate in a write (found: ${writers.join(', ') || 'none'}); updateMany conditional on the value read, then AGENT_AUTO_UPDATE_COMPUTER_SET before/after`);
  const pam = cus.slice(cus.indexOf('  async putAgentMode('), cus.indexOf('  async deleteSiteOverride('));
  check('the business selector writes only the agent mode: same edit rule, fresh for anything but OFF, enabled never turned on, audited',
    pam.length > 500 && /this\.assertEdit\(a, customerId\);/.test(pam) && pam.indexOf('this.assertEdit(a, customerId);') < pam.indexOf('this.prisma.clientUpdatePolicy.updateMany(')
      && /if \(input\.agentMode !== 'OFF' && !fresh\('agent\.autoupdate\.business'\)\) throw new FreshAuthNeeded\('agent\.autoupdate\.business'\);/.test(pam)
      && pam.indexOf("if (input.agentMode !== 'OFF' && !fresh(") < pam.indexOf('this.prisma.clientUpdatePolicy.updateMany(') && pam.indexOf("if (input.agentMode !== 'OFF' && !fresh(") < pam.indexOf('this.prisma.clientUpdatePolicy.create(')
      && /data: \{ agentMode: input\.agentMode, updatedById: a\.userId \}/.test(pam) && /enabled: false, timeZone: 'UTC'/.test(pam) && !/enabled: true|enabled: input/.test(pam)
      && /action: 'CLIENT_UPDATE_POLICY_CHANGED', resource: 'client_update_policy', resourceId: after\.id,/.test(pam)
      && /AgentModeInput = z\.object\(\{\s*businessId: z\.string\(\)\.regex\(ID\),\s*agentMode: z\.enum\(\['ANY_TIME', 'WINDOW', 'OFF'\]\)\.nullable\(\),\s*\}\)\.strict\(\);/.test(read('apps/api/src/client-updates/policy.ts')),
    'client-updates.service putAgentMode: assertEdit, the fresh check before either write, agentMode-only update, enabled: false on create, audited; AgentModeInput strict');
  check('the card\'s automatic-update state is read only after the computer\'s scope check',
    (() => {
      const cardFn = up.slice(up.indexOf('  async card(actor: ActorContext, id: string) {'), up.indexOf('  async updateAgent('));
      const scope = cardFn.indexOf('await this.acl.assertEndpointInScope(actor, id, CAP.COMPUTERS_VIEW);');
      return (up.match(/this\.auto\.card\(/g) ?? []).length === 1 && scope > 0 && cardFn.indexOf('this.auto.card(') > scope;
    })(),
    'agent-upgrade.service card(): assertEndpointInScope before this.auto.card');
  const signedSc = ws.slice(ws.indexOf('selfCheckHook: `try {'), ws.indexOf('} catch {}`,', ws.indexOf('selfCheckHook: `try {')));
  check('the signed periodic self-check runs only `rem0te-agent.exe update`, only when the portal allows it, and the legacy channel has none',
    signedSc.length > 200 && /if \(\$resp\.data\.agentSelfCheck -eq \$true -and \(Test-Path -LiteralPath \$agentExe\)\) \{/.test(signedSc)
      && (signedSc.match(/& \$agentExe/g) ?? []).length === 1 && signedSc.includes("& $agentExe @('update') *>$null")
      && !/iex|Invoke-Expression|Invoke-WebRequest|Invoke-RestMethod|DownloadFile|Start-Process|irm /i.test(signedSc)
      && /selfCheckHook: '# Periodic self-check: signed channel only\.',/.test(ws) && (ws.match(/selfCheckHook: ['`]/g) ?? []).length === 2
      && /agentSelfCheck: true/.test(enr),
    'windows-script.ts: one signed selfCheckHook calling only update; the legacy one is a comment');
  check('AGENT_AUTO_UPDATE=off is exact, and set for run-e2e.sh and the browser suite',
    /processOn: env\.AGENT_AUTO_UPDATE !== 'off',/.test(sch)
      && /\nexport AGENT_AUTO_UPDATE=off\n/.test(read('scripts/run-e2e.sh'))
      && /AGENT_AUTO_UPDATE: 'off',/.test(read('apps/web/scripts/e2e-ui.mjs')),
    "settingsFrom: env.AGENT_AUTO_UPDATE !== 'off'; run-e2e.sh exports it; e2e-ui's API env sets it");
}

// 54. Test stacks and the GeoIP database (0.36). The dashboard map resolves
//     addresses with GeoipService, which falls back to the production path
//     (/opt/reboot-remote/data/geoip/…) when GEOIP_DB_PATH is unset. On the
//     production host that made the browser suite read production's file
//     without saying so. The suite now writes its own database of RFC 5737
//     documentation networks; the writer is test tooling, never server code;
//     and the screens reachable signed out that draw text on the operator's
//     accent choose their ink by luminance rather than hard-coding white.
{
  const ui = read('apps/web/scripts/e2e-ui.mjs');
  const fixture = read('apps/api/scripts/lib/mmdb-fixture.mjs');
  check('the browser suite hands its API a fixture GeoIP database, never the default path',
    /GEOIP_DB_PATH: GEOIP_FILE,/.test(ui)
      && /const GEOIP_FILE = writeCityMmdb\(path\.join\(GEO_DIR, 'fixture-city\.mmdb'\)/.test(ui)
      && /const GEO_DIR = mkdtempSync\(path\.join\(tmpdir\(\), 'rem0te-ui-geo-'\)\);/.test(ui)
      && !/reboot-remote\/data\/geoip|dbip-city-lite/.test(ui),
    'e2e-ui.mjs: GEOIP_DB_PATH: GEOIP_FILE in startApi(), written with writeCityMmdb into a mkdtemp directory; no production GeoIP path');
  const cidrs = [...ui.matchAll(/cidr: '([0-9./]+)'/g)].map((m) => m[1]);
  const docRange = (c) => /^(192\.0\.2|198\.51\.100|203\.0\.113)\.\d+\/(2[4-9]|3[0-2])$/.test(c);
  check('the fixture GeoIP networks are RFC 5737 documentation ranges only',
    cidrs.length >= 3 && cidrs.every(docRange),
    `cidrs in e2e-ui.mjs: ${JSON.stringify(cidrs)}`);
  const srcImports = walk('apps/api/src').filter((f) => /mmdb-fixture/.test(read(f)));
  check('the mmdb writer is test tooling: nothing under apps/api/src imports it, and it writes IPv4 only',
    srcImports.length === 0 && /ip_version: \{ \$uint16: 4 \}/.test(fixture),
    `imported by: ${srcImports.join(', ') || '(none)'}`);
  const login = read('apps/web/app/(auth)/login/page.tsx');
  const quick = read('apps/web/app/quick/page.tsx');
  const onAccent = (src) => [...src.matchAll(/className="[^"]*"\s*style=\{\{ backgroundColor: [^}]*\}\}/g)].map((m) => m[0]);
  check('the login band and Quick Connect draw text on the accent with inkOn(), never a fixed white',
    /import \{ inkOn \} from '@\/lib\/contrast';/.test(login) && /import \{ inkOn \} from '@\/lib\/contrast';/.test(quick)
      && /style=\{\{ backgroundColor: band, color: bandInk \}\}/.test(login) && /const bandInk = inkOn\(band\)!;/.test(login)
      && (quick.match(/style=\{\{ backgroundColor: accent, color: ink \}\}/g) ?? []).length === 2 && /const ink = inkOn\(accent\)!;/.test(quick)
      && ![...onAccent(login), ...onAccent(quick)].some((t) => /text-white/.test(t))
      && !/text-white/.test(login.slice(login.indexOf('data-accent-band'), login.indexOf('data-accent-band') + 800)),
    'login: backgroundColor band, color bandInk = inkOn(band); quick: two accent elements with color ink = inkOn(accent); no text-white on either');
}

// 55. The tray (0.36). A tray icon in every signed-in session on Windows:
//     chat, a support request, self-help tools. Three credentials, none of
//     which is the device secret in a user's hands: the signed tray holds
//     nothing and asks the SYSTEM tray host over the 0.34 pipes; the standard
//     tray holds a tray key that only reaches /tray/* (paired with the device
//     secret by the SYSTEM heartbeat, replaced on every pairing, never an
//     elevated tool); the chat page holds an HttpOnly cookie on /assist. The
//     link the tray opens carries a one-time code: consumed by one
//     conditional update, 60 seconds, answered with a 303 off the URL. The
//     page has its own strict CSP (the console's is not applied there) and
//     writes need x-assist. Self-help is a closed catalog that is the same in
//     the API, the agent and the database; the elevated tools run only in
//     the SYSTEM host, which runs only ipconfig and ping from System32 and
//     the RustDesk restart, under the containment kinds each tool names, and
//     starts only the tray whose sha256 the signed install recorded. Whether
//     chats are recorded needs a fresh sign-in and is audited; an unrecorded
//     chat's messages are deleted once both sides have them and at the end.
//     Screenshots and usage are served only to someone who can see the
//     computer, inert. No message text, request text or Windows account in
//     the audit log.
{
  const pol = read('apps/api/src/tray/tray-policy.ts');
  const asv = read('apps/api/src/tray/assist.service.ts');
  const tsv = read('apps/api/src/tray/tray.service.ts');
  const tctl = read('apps/api/src/tray/tray.controller.ts');
  const page = read('apps/api/src/tray/assist-page.ts');
  const next = read('apps/web/next.config.js');
  const csvc = read('apps/api/src/chat/chat.service.ts');
  const ssvc = read('apps/api/src/support-requests/support-requests.service.ts');
  const sctl = read('apps/api/src/support-requests/support-requests.controller.ts');
  const sql = read('apps/api/prisma/migrations/0062_tray/migration.sql');
  const cat = read('tools/windows-installer/internal/tray/catalog.go');
  const core = read('tools/windows-installer/internal/tray/core.go');
  const tools = read('tools/windows-installer/internal/tray/tools.go');
  const winos = read('tools/windows-installer/internal/tray/os_windows.go');
  const host = read('tools/windows-installer/trayhost_windows.go');
  const trayMain = read('tools/windows-installer/cmd/rem0te-tray/main_windows.go');
  const trayArgs = read('tools/windows-installer/cmd/rem0te-tray/args.go');
  const fnBody = (src, sig) => { const i = src.indexOf(sig); const j = src.indexOf('\n  }\n', i); return i < 0 ? '' : src.slice(i, j); };

  check('a chat code is single-use: one conditional update consumes it, and nothing is read before it',
    /const claimed = await this\.prisma\.assistCode\.updateMany\(\{ where: \{ codeHash: hash, usedAt: null, expiresAt: \{ gt: now \} \}, data: \{ usedAt: now \} \}\);\s*\n\s*if \(claimed\.count !== 1\) return null;/.test(asv)
      && fnBody(asv, 'async exchange(').indexOf('assistCode.find') > fnBody(asv, 'async exchange(').indexOf('assistCode.updateMany')
      && /export const CODE_TTL_MS = 60_000;/.test(pol) && /CHECK \("expiresAt" <= "createdAt" \+ interval '5 minutes'\)/.test(sql)
      && /res\.redirect\(303, 'chat'\);/.test(tctl),
    'exchange(): updateMany on {codeHash, usedAt: null, expiresAt > now} then count !== 1 → null, before any read; CODE_TTL_MS 60 s; AssistCode_short_lived; /assist/open redirects 303');
  check('the /assist cookie is HttpOnly, Secure, SameSite=Strict on Path=/assist, and is the only credential the page accepts',
    /return `\$\{ASSIST_COOKIE\}=\$\{token\}; Path=\$\{ASSIST_COOKIE_PATH\}; Max-Age=\$\{Math\.floor\(maxAgeMs \/ 1000\)\}; HttpOnly; Secure; SameSite=Strict`;/.test(pol)
      && /export const ASSIST_COOKIE_PATH = '\/assist';/.test(pol)
      && /@Controller\('assist'\)\s*\nexport class AssistController/.test(tctl)
      && !/JwtAuthGuard|@Actor\(\)/.test(tctl.slice(tctl.indexOf('export class AssistController'))),
    'assistCookie(): HttpOnly; Secure; SameSite=Strict; Path=/assist; AssistController uses no JwtAuthGuard or @Actor');
  check('the page has its own strict CSP, the console\'s CSP is not applied to /assist, and page writes need x-assist',
    /"default-src 'none'",\s*\n\s*"script-src 'self'",/.test(pol) && /"frame-ancestors 'none'",/.test(pol) && !/unsafe-(inline|eval)/.test(pol.slice(pol.indexOf('export const ASSIST_CSP'), pol.indexOf("].join('; ');", pol.indexOf('export const ASSIST_CSP'))))
      && /res\.setHeader\('Content-Security-Policy', ASSIST_CSP\);/.test(tctl)
      && /source: '\/:path\(\(\?!assist\(\?:\/\|\$\)\)\.\*\)',/.test(next)
      && /if \(req\.headers\['x-assist'\] !== '1'\) throw new ForbiddenException/.test(tctl)
      && (tctl.match(/assertPageWrite\(req\);/g) ?? []).length === 6
      // 0.44: attachments are shown from api/attachments, same origin — no blob:, data: or other source is allowed for images.
      && /"img-src 'self'",/.test(pol) && !/blob:|data:|https:/.test(pol.slice(pol.indexOf('export const ASSIST_CSP'), pol.indexOf("].join('; ');", pol.indexOf('export const ASSIST_CSP')))),
    "ASSIST_CSP default-src 'none', script-src 'self', img-src 'self' only, no unsafe-*; pageHeaders sets it; next.config.js applies the console CSP to /:path((?!assist(?:/|$)).*); assertPageWrite in start, messages, attachments (handler and guard), receipts, end");
  check('no device secret, tray key or code reaches the page, and the tray is handed a code, never a URL',
    !/agentSecret|trayKey|heartbeat\.dat|rem0te_assist/.test(page)
      && /return \{ code, expiresAt: new Date\(now \+ CODE_TTL_MS\), conversationId \};/.test(tsv)
      && /func AssistURL\(portal, code string\) \(string, error\) \{/.test(cat)
      && !/heartbeat\.dat|AgentSecret|agentSecret/.test(trayMain + trayArgs),
    'assist-page.ts has no secret names; chatCode returns { code, expiresAt, conversationId }; the tray builds the URL (AssistURL) and never reads heartbeat.dat');
  check('a tray key never runs or reports an elevated tool, and a standard computer\'s device secret is not a tray credential',
    /if \(t\.elevated && dev\.via !== 'signed'\) \{\s*\n\s*throw new ForbiddenException\(\{ code: 'SELF_HELP_SIGNED_ONLY'/.test(tsv)
      && /if \(t\.elevated && dev\.via !== 'signed'\) throw new ForbiddenException\(\{ code: 'SELF_HELP_SIGNED_ONLY'/.test(tsv)
      && /CHECK \(\s*\n\s*"via" = 'signed' OR "tool" IN \('dns\.check', 'net\.test', 'net\.details'\)\);/.test(sql)
      // 0.51 (§64): "signed" is the sticky rule (runsSignedAgent), not the last heartbeat's channel.
      && /if \(!runsSignedAgent\(ep\)\) \{[\s\S]{0,300}throw new ForbiddenException\(\{ code: 'TRAY_KEY_REQUIRED'/.test(tsv)
      && /runsSignedAgent\(ep\) \|\| ep\.status === 'ARCHIVED'\) \{/.test(tsv)
      && /Run:\s+&tray\.Runner\{OS: tray\.WinOS\{\}, Portal: tf\.Portal, Elevated: false\},/.test(trayMain)
      && /if t\.Elevated && !r\.Elevated \{/.test(tools)
      && /func \(WinOS\) FlushDNS\(\) \(string, error\)\s+\{ return "", ErrNotHere \}/.test(winos)
      && /func \(WinOS\) RenewIP\(\) \(string, error\)\s+\{ return "", ErrNotHere \}/.test(winos)
      && /func \(WinOS\) RestartRustDesk\(\) error\s+\{ return ErrNotHere \}/.test(winos),
    'selfHelpBegin and selfHelpResult refuse elevated tools from a tray key; TraySelfHelpRun_elevated_signed_only; identify() refuses a standard device secret and a tray key on a signed computer; the standard tray\'s Runner is Elevated: false; WinOS elevated methods return ErrNotHere');
  {
    const ts = [...pol.matchAll(/\{ id: '([a-z.]+)', title: '[^']+', elevated: (true|false), perWindow: \d+, windowMs: [^,]+, blockedBy: \[([^\]]*)\] \}/g)].map((m) => `${m[1]}:${m[2]}:${m[3].replace(/[' ]/g, '')}`);
    const go = [...cat.matchAll(/\{ID: "([a-z.]+)", Title: "[^"]+", Elevated: (true|false), PerWindow: \d+, Window: [^,}]+(?:, BlockedBy: \[\]string\{([^}]*)\})?\}/g)].map((m) => `${m[1]}:${m[2]}:${(m[3] ?? '').replace(/[" ]/g, '')}`);
    const db = (sql.match(/"tool" IN \(([^)]*)\)\);/) ?? [])[1]?.replace(/[' ]/g, '').split(',') ?? [];
    check('the self-help catalog is the same closed list in the API, the agent and the database: six tools, the same elevated flags and containment kinds',
      ts.length === 6 && JSON.stringify(ts) === JSON.stringify(go) && JSON.stringify(ts.map((t) => t.split(':')[0])) === JSON.stringify(db)
        && JSON.stringify(ts) === JSON.stringify(['dns.check:false:', 'dns.flush:true:actions', 'ip.renew:true:actions', 'net.test:false:', 'net.details:false:', 'rustdesk.restart:true:actions,remote']),
      `api ${JSON.stringify(ts)}\n      go  ${JSON.stringify(go)}\n      db  ${JSON.stringify(db)}`);
  }
  check('the tray host runs only ipconfig and ping from System32, and nothing else is passed to RunSystem32',
    /var System32Allowed = map\[string\]bool\{"ipconfig\.exe": true, "ping\.exe": true\}/.test(winos)
      && /if !System32Allowed\[exe\] \{/.test(winos)
      && JSON.stringify([...(host + winos).matchAll(/RunSystem32\([^,]+, [^,]+, "([a-z0-9.]+)"((?:, "[^"]*")*)/g)].map((m) => m[1] + m[2])) === JSON.stringify(['ipconfig.exe, "/flushdns"', 'ipconfig.exe, "/renew"', 'ping.exe, "-n", "2", "-w", "1000"'])
      && !/exec\.Command/.test(winos.replace(/func RunSystem32\([\s\S]*?\n\}\n/, '')),
    'System32Allowed = {ipconfig.exe, ping.exe}; RunSystem32 refuses others; the only calls are ipconfig /flushdns, ipconfig /renew and ping -n 2 -w 1000');
  check('every elevated tool is stopped by the containment kinds it names, server and agent, and a refused run is recorded',
    /for \(const kind of t\.blockedBy\) \{\s*\n\s*const p = await this\.containment\.blocking\(kind, dev\.customerId\);\s*\n\s*if \(p\) \{\s*\n\s*const run = await this\.prisma\.traySelfHelpRun\.create\(\{ data: \{ \.\.\.base, status: 'refused'/.test(tsv)
      && fnBody(tsv, 'async selfHelpBegin(').indexOf('t.blockedBy') < fnBody(tsv, 'async selfHelpBegin(').indexOf("status: 'running'")
      && /if t\.Elevated && c\.SignedPause != nil \{/.test(core)
      && /SignedPause: func\(ctx context\.Context, businessID string\) \(string, error\) \{/.test(host),
    "selfHelpBegin: for kind of t.blockedBy → containment.blocking → a 'refused' run, before any 'running' run; the host's core consults the signed pause for elevated tools");
  check('the host starts only the tray whose sha256 the signed install recorded',
    /sum, err := agent\.FileSHA256\(exe\)[\s\S]{0,120}if sum != h\.traySum \{\s*\n\s*return fmt\.Errorf\("refusing to start/.test(host)
      && host.indexOf('if sum != h.traySum {') < host.indexOf('windows.WTSQueryUserToken(', host.indexOf('func (h *trayHost) launchAndServe('))
      && host.indexOf('func (h *trayHost) launchAndServe(') > 0
      && /if json\.Unmarshal\(bytes\.TrimPrefix\(raw, \[\]byte\("\\xef\\xbb\\xbf"\)\), &st\) != nil \|\| len\(st\.TraySHA256\) != 64 \{/.test(host),
    'launchAndServe: FileSHA256 then sum != h.traySum → refuse, before WTSQueryUserToken; installedTraySHA requires a 64-char TraySHA256');
  check('changing whether chats are recorded needs a fresh sign-in, is audited before/after, and is owner or Platform Admin only',
    (tctl.match(/fresh\(this\.stepUp, req\);/g) ?? []).length === 2
      && /assertFresh\(u\?\.sub \? stepUp\.read\(req, u\.sub, u\.iat\)\?\.method \?\? null : null,/.test(tctl)
      && /if \(!actor\.isPlatformAdmin\) throw new ForbiddenException\('Platform Admin access required'\);\s*\n\s*fresh\(this\.stepUp, req\);/.test(tctl)
      && /action: 'CHAT_RECORDING_CHANGED'[\s\S]{0,200}meta: \{ scope: 'business', before: before\.chatRecording, after: recording \},/.test(tsv)
      && /meta: \{ scope: 'platform', before: before\?\.chatRecordingDefault \?\? true, after: recording \},/.test(tsv),
    'both PUTs call fresh() (assertFresh); the platform one checks isPlatformAdmin first; CHAT_RECORDING_CHANGED meta is scope/before/after only');
  check('an unrecorded chat keeps no text: technician messages go once read, replies once a technician\'s panel saw them, everything at the end',
    /const r = await this\.prisma\.chatMessage\.deleteMany\(\{ where: \{ conversationId, sender: 'TECHNICIAN', readAt: \{ not: null \}, attachment: \{ is: null \} \} \}\);/.test(csvc)
      && /const purged = read\.length \? await this\.purgeRead\(conversationId\) : 0;/.test(csvc)
      && /const deleted = c\.recorded \? \{ count: 0 \} : await this\.prisma\.chatMessage\.deleteMany\(\{ where: \{ \.\.\.mine, technicianSeenAt: \{ not: null \}, attachment: \{ is: null \} \} \}\);/.test(csvc)
      // 0.44: a message carrying a file waits for the end, and the end takes it with everything else (FK cascade to the file).
      && /if \(!c\.recorded\) await tx\.chatMessage\.deleteMany\(\{ where: \{ conversationId \} \}\);/.test(csvc)
      && /export function chatRecorded\(business: boolean \| null \| undefined, platformDefault: boolean \| null \| undefined\): boolean \{\s*\n\s*if \(business === true \|\| business === false\) return business;\s*\n\s*return platformDefault !== false;/.test(pol),
    'purgeRead deletes read TECHNICIAN rows; assistReceipts calls it; ack deletes seen END_USER rows; end() deletes all when !recorded; chatRecorded: the business\'s boolean, else the default unless it is false');
  check('tray audit rows hold ids, tools and outcomes — no message text, request text, Windows account or key',
    [...tsv.matchAll(/meta: \{([^}]*)\}/g)].every((m) => !/localUser|description|summary|detail|\btrayKey\b|secret|\btext\b/.test(m[1]))
      && /meta: \{ runId, tool, outcome, offline \},/.test(tsv)
      && /meta: \{ origin: 'AGENT', endpointId: ep\.id, screenshot: !!shot\?\.ok, usage: !!usage \},/.test(ssvc)
      && [...asv.matchAll(/meta: \{([^}]*)\}/g)].every((m) => !/text|localUser|description/.test(m[1]))
      && !/activityLog\.(update|updateMany|delete|deleteMany|upsert)/.test(tsv + asv),
    'tray.service / assist.service meta: no localUser, description, summary, text or key; SUPPORT_REQUEST_SUBMITTED meta is flags only');
  check('screenshots and usage are served only to someone who can see the computer, and served inert',
    /if \(!r\.endpointId \|\| !\(await this\.computerVisible\(actor, r\.endpointId\)\)\) throw new NotFoundException\('Attachment not found'\);/.test(ssvc)
      && /const visible = r\.endpointId \? await this\.computerVisible\(actor, r\.endpointId\) : false;/.test(ssvc)
      && /res\.setHeader\('X-Content-Type-Options', 'nosniff'\);\s*\n\s*res\.setHeader\('Content-Security-Policy', "default-src 'none'; sandbox"\);/.test(sctl)
      && /res\.setHeader\('Content-Type', a\.contentType === 'image\/png' \? 'image\/png' : 'image\/jpeg'\);/.test(sctl)
      && /"contentType" IN \('image\/jpeg', 'image\/png'\) AND "bytes" IS NOT NULL AND "sizeBytes" BETWEEN 1 AND 716800/.test(sql),
    'attachment(): computerVisible or 404; detail() lists them only when visible; nosniff + sandbox CSP; JPEG/PNG ≤ 700 KiB in the database');
  check('TRAY_SWEEP=off is exact, and set for run-e2e.sh and the browser suite',
    /if \(process\.env\.TRAY_SWEEP === 'off'\) return;/.test(tsv)
      && /\nexport TRAY_SWEEP=off\n/.test(read('scripts/run-e2e.sh'))
      && /TRAY_SWEEP: 'off',/.test(read('apps/web/scripts/e2e-ui.mjs')),
    "onModuleInit: TRAY_SWEEP === 'off' → no timer; run-e2e.sh exports it; e2e-ui's API env sets it");

  // 0.51: "Open a support request" only with a PSA, and the request is a ticket.
  const psvc = read('apps/api/src/psa/psa.service.ts');
  const pre = psvc.slice(psvc.indexOf('  async trayPrecheck('), psvc.indexOf('  async trayTicket('));
  const tt = psvc.slice(psvc.indexOf('  async trayTicket('), psvc.indexOf('  /** For the buttons:'));
  const sr = tsv.slice(tsv.indexOf('  async supportRequest('), tsv.indexOf('  // ── POST /tray/self-help/*'));
  check('tray support requests: the server decides — status carries supportRequests from PsaService.trayOffered (an enabled connector for the business, else the platform default)',
    /this\.psa\.trayOffered\(dev\.customerId\),/.test(tsv) && /\n\s*supportRequests,\n/.test(tsv)
      && /async trayOffered\(customerId: string \| null\): Promise<boolean> \{\s*\n\s*return !!customerId && !!\(await this\.effective\(customerId\)\);/.test(psvc)
      && /if \(b\?\.enabled\) return \{ row: b, scope: 'business' \};/.test(psvc) && /return g\?\.enabled \? \{ row: g, scope: 'global' \} : null;/.test(psvc),
    'TrayService.status → trayOffered → effective() (enabled rows only)');
  check('tray support requests: refused before anything is stored without a connector (SUPPORT_REQUEST_NOT_CONFIGURED), under a notifications pause or when not ready; then stored; then the per-computer budget and the send',
    pre.indexOf('this.effective(ep.customerId)') > 0 && pre.indexOf("code: 'SUPPORT_REQUEST_NOT_CONFIGURED'") > pre.indexOf('this.effective(')
      && pre.indexOf("activePause(this.prisma, 'notifications', ep.customerId)") > pre.indexOf("'SUPPORT_REQUEST_NOT_CONFIGURED'")
      && pre.indexOf('.ready(eff.row') > pre.indexOf("'notifications'")
      && /this\.trayBudget\.take\(ep\.id\) \? await drv\.send\(eff\.row, draft, this\.deps\)/.test(tt) && (psvc.match(/drv\.send\(/g) ?? []).length === 3 /* 0.55: alertTicket's, §68 */
      && sr.indexOf('this.psa.trayPrecheck(') > 0 && sr.indexOf('this.support.agentSubmit(') > sr.indexOf('this.psa.trayPrecheck(')
      && sr.indexOf('this.psa.trayTicket(') > sr.indexOf('this.support.agentSubmit(') && (tsv.match(/this\.support\.agentSubmit\(/g) ?? []).length === 1,
    'trayPrecheck: effective → NOT_CONFIGURED → notifications pause → ready; supportRequest: precheck → agentSubmit → trayTicket (budget → send)');
  check('tray tickets: audited with ids, the kind and the reference only — never the text, subject or body — and recorded as a PsaTicket',
    [...tt.matchAll(/meta: \{([^}]*)\}/g)].every((m) => !/subject|body|text|windowsAccount|localUser|loggedOnUser/.test(m[1]))
      && /action: 'PSA_TICKET_CREATED', meta: \{ \.\.\.ids, ticketId: ticket\.id, ref: ticket\.ref, status: r\.status \}/.test(tt)
      && /this\.prisma\.psaTicket\.create\(/.test(tt) && /sourceRef: `support:\$\{t\.requestId\}`/.test(read('apps/api/src/psa/ticket.ts')),
    'PsaService.trayTicket meta; sourceRef support:<request id>');
  const gproto = read('tools/windows-installer/internal/tray/protocol.go'), gmenu = read('tools/windows-installer/cmd/rem0te-tray/main_windows.go');
  check('the tray hides "Open a support request" unless the portal said a PSA is set up, and draws a ticket reference only through its charset',
    /func OffersSupport\(s State, have bool\) bool \{\s*\n\s*return have && s\.HasBusiness && s\.SupportRequests\s*\n\}/.test(gproto)
      && /if tray\.OffersSupport\(s, have\) \{\s*\n\s*appendItem\(menu, mfString, idSupport,/.test(gmenu) && (gmenu.match(/idSupport,/g) ?? []).length === 1
      && /onlyFields\(f, "id", "ok", "reason", "url", "outcome", "summary", "lines", "ticket"\)/.test(gproto) && /f\.Ticket = CleanTicketRef\(f\.Ticket\)/.test(gproto)
      && /onlyFields\(f, "id", "text", "usage", "shot"\)/.test(gproto),
    'OffersSupport; the menu appends idSupport only behind it; reply frames may carry ticket, cleaned; a support frame from the tray may not');

  // 0.53.1: the tray's brand (business, provider, support line, accent) is
  // the portal's records only, and the last-known copy the tray keeps holds
  // those four fields and nothing else.
  const gbrand = read('tools/windows-installer/internal/tray/brand.go');
  const gbfile = read('tools/windows-installer/cmd/rem0te-tray/brandfile.go');
  const brandFn = tsv.slice(tsv.indexOf('  brand(ep: '), tsv.indexOf('  // ── POST /tray/status'));
  const brandStruct = (gbrand.match(/type Brand struct \{([^}]*)\}/) ?? [])[1] ?? '';
  check('the tray brand comes from the portal\'s records and names no one it does not have: the customer\'s and tenant\'s names, the branding\'s phone/e-mail and accent, "" otherwise',
    /from the portal's records, never\s*\n?\s*\*?\s*from a device or a message/.test(tsv)
      && /businessName: deviceName\(ep\.customer\?\.name \?\? ''\) \?\? '',/.test(brandFn)
      && /providerName: deviceName\(ep\.tenant\?\.name \?\? ''\) \?\? '',/.test(brandFn)
      && /supportText: supportLine\(ep\.tenant\?\.branding\),/.test(brandFn) && /accent: accent\(ep\.tenant\?\.branding\?\.accentColor\),/.test(brandFn)
      && !/Your IT provider|body\.|localUser|portalTitle/.test(brandFn.replace(/\/\*\*[\s*\S]*?\*\//, ''))
      && /return parts\.length \? `Support: \$\{parts\.join\(' · '\)\}` : '';/.test(pol),
    "brand(): customer.name / tenant.name through deviceName, else ''; supportLine(branding) is '' without a phone or e-mail; nothing from the request body");
  check('the tray\'s last-known brand file holds exactly business, provider, supportText and accent, is per user, capped, re-cleaned on read, and anything else is no file',
    JSON.stringify([...brandStruct.matchAll(/json:"([a-zA-Z]+)"/g)].map((m) => m[1])) === JSON.stringify(['business', 'provider', 'supportText', 'accent'])
      && (brandStruct.match(/\n\t[A-Z]\w* +string/g) ?? []).length === 4
      && /const MaxBrandFileBytes = 4 << 10/.test(gbrand)
      && /if len\(raw\) > MaxBrandFileBytes \{\s*\n\s*return Brand\{\}, false/.test(gbrand)
      && /d\.DisallowUnknownFields\(\)/.test(gbrand.slice(gbrand.indexOf('func ParseBrand(')))
      && /return b\.Clean\(\), true/.test(gbrand) && /out, _ := json\.Marshal\(b\.Clean\(\)\)/.test(gbrand)
      && /io\.LimitReader\(f, tray\.MaxBrandFileBytes\+1\)/.test(gbfile) && /b, ok := tray\.ParseBrand\(raw\)/.test(gbfile)
      && /tmp\.Write\(tray\.MarshalBrand\(b\)\)/.test(gbfile) && (gbfile.match(/\.Write\(/g) ?? []).length === 1
      && /os\.Getenv\("LOCALAPPDATA"\)/.test(gbfile) && !/ProgramData|trayDir/.test(gbfile)
      && /return b, b != saved/.test(trayArgs) && /if !have \|\| s\.Offline \{\s*\n\s*return tray\.Brand\{\}, false/.test(trayArgs),
    'Brand{business, provider, supportText, accent}; ParseBrand: ≤ 4 KiB, DisallowUnknownFields, Clean(); the tray writes only MarshalBrand(b) to %LOCALAPPDATA%\\Rem0te, and only from an online answer');
}

// 56. Signed releases on one host (0.37). deploy/release/ sets up, builds,
//     signs and publishes the signed update repository on the portal's own
//     host, as a dedicated rem0te-release user the portal (`reboot`) cannot
//     read. The protection is that separation and the git boundary, so each
//     is checked: the API never reaches the key store, the release tool or
//     the published directory's write side; keys are written only into the
//     0700 key directory under umask 077; a build is a `git archive` of HEAD
//     with the owner's root written only into that copy, and the checked-in
//     root stays the `{}` placeholder; the checkout's JavaScript runs as the
//     checkout's owner, never as the key holder; the published repository is
//     group-readable and never group-writable; the RustDesk build needs
//     GitHub's published digest; and nothing in CI runs these scripts.
{
  const rel = (f) => read(`deploy/release/${f}`);
  const lib = rel('lib.sh');
  const setup = rel('rem0te-signed-setup.sh');
  const pub = rel('rem0te-signed-publish');
  const refresh = rel('rem0te-signed-refresh');
  const exportRoot = rel('rem0te-signed-export-root');
  const promote = rel('promote-stage.sh');
  const asset = rel('rustdesk-asset.mjs');
  const unit = rel('systemd/rem0te-timestamp-refresh.service');
  const scripts = ['lib.sh', 'rem0te-signed-setup.sh', 'rem0te-signed-publish', 'rem0te-signed-refresh', 'rem0te-signed-status', 'rem0te-signed-export-root', 'promote-stage.sh']
    .map((f) => [f, rel(f)]);
  const code = (s) => s.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');

  const apiFiles = walk('apps/api/src');
  // The owner-facing command strings (the Full agent page, §57) are text the
  // portal shows, never runs: they may appear only as the three exported
  // constants in agent-migration.ts, each exactly `'sudo …rem0te-signed-…'`.
  const SIGNED_CMD_CONSTS = /^export const (?:SETUP|PUBLISH|STATUS)_COMMAND = 'sudo (?:\.\/deploy\/release\/rem0te-signed-setup\.sh|rem0te-signed-publish|rem0te-signed-status)';$/gm;
  // 0.72: the two Managed Secure Access grant-key commands the console shows a
  // Platform Admin (Managed Secure Access §3.2) are the same kind of text, in
  // grant-key-commands.ts, each exactly as below.
  const GRANT_KEY_CMD_CONSTS = /^export const MSA_GRANT_KEY_(?:ADD|PUBLISH)_COMMAND = 'sudo (?:rem0te-signed-grant-key add|rem0te-signed-publish --republish)';$/gm;
  const apiText = (f) => (f === 'apps/api/src/update-trust/agent-migration.ts' ? read(f).replace(SIGNED_CMD_CONSTS, '')
    : f === 'apps/api/src/msa/grant-key-commands.ts' ? read(f).replace(GRANT_KEY_CMD_CONSTS, '').replace(/\(§56 matches them exactly\)|rem0te-signed-grant-key add|rem0te-signed-publish/g, (m) => (m.startsWith('(') ? m : ''))
    : read(f));
  const reaching = apiFiles.filter((f) => /\/var\/lib\/rem0te-release|rem0te-signed-|\b(?:root[123]|targets|snapshot|timestamp)\.pem\b|KEY_DIR|REM0TE_SIGNED/.test(apiText(f)));
  const spawning = apiFiles.filter((f) => /child_process/.test(read(f)) && /rem0te-release/.test(read(f)));
  check('the API never names the release key store, a key file or the rem0te-signed commands, and never spawns rem0te-release',
    reaching.length === 0 && spawning.length === 0,
    `references: ${reaching.join(', ') || '(none)'}; spawns: ${spawning.join(', ') || '(none)'}`);
  const envReaders = apiFiles.filter((f) => /process\.env\.UPDATE_REPO_DIR/.test(read(f)));
  const svc = read('apps/api/src/update-trust/update-trust.service.ts');
  const writes = /\b(?:writeFile|writeFileSync|appendFile|appendFileSync|rename|renameSync|mkdir|mkdirSync|unlink|unlinkSync|rmSync|rmdir|copyFile|copyFileSync|createWriteStream|symlink|symlinkSync|chmod|chmodSync|truncate)\s*\(/;
  const outsiders = apiFiles.filter((f) => f !== 'apps/api/src/update-trust/update-trust.service.ts' && /\.(?:repoDir|metadataPath|targetPath)\(/.test(read(f)) && writes.test(read(f)));
  check('UPDATE_REPO_DIR is read only by UpdateTrustService, which writes nothing, and no file that resolves repository paths writes files',
    JSON.stringify(envReaders) === JSON.stringify(['apps/api/src/update-trust/update-trust.service.ts']) && !writes.test(svc) && outsiders.length === 0,
    `readers: ${envReaders.join(', ')}; service writes: ${writes.test(svc)}; writers resolving repo paths: ${outsiders.join(', ') || '(none)'}`);

  const keygens = scripts.flatMap(([f, s]) => code(s).split('\n').filter((l) => /\bkeygen\b/.test(l)).map((l) => `${f}: ${l.trim()}`));
  check('keys are generated only into the key directory, by the release user under umask 077',
    keygens.length === 1 && /^rem0te-signed-setup\.sh: tool keygen -out "\$KEY_DIR\/\$k\.pem" \|/.test(keygens[0])
      && /^tool\(\) \{\n  as_release 077 env -i /m.test(lib)
      && /^KEY_DIR=\$STATE_DIR\/keys$/m.test(setup) && /^mk 0700 "\$STATE_DIR"\nmk 0700 "\$KEY_DIR"$/m.test(setup)
      && /\( umask "\$m"; exec "\$@" \)/.test(lib) && /runuser -u "\$RELEASE_USER" -- \/bin\/sh -c 'umask "\$0"; exec "\$@"' "\$m" "\$@"/.test(lib),
    `keygen lines: ${JSON.stringify(keygens)}; tool() must be as_release 077; KEY_DIR=$STATE_DIR/keys created 0700`);
  const pemLines = scripts.flatMap(([f, s]) => code(s).split('\n').filter((l) => /\.pem\b/.test(l) && !/"\$KEY_DIR\/[^"]*\.pem"/.test(l) && !/die "|echo "/.test(l)).map((l) => `${f}: ${l.trim()}`));
  check('every key path the scripts open is under $KEY_DIR, except export-root\'s off-host copy (written 0600 under umask 077)',
    pemLines.length === 2 && pemLines.every((l) => /^rem0te-signed-export-root: {2}?dest=\$\{abs\[.*\]\}\/rem0te-\$k\.pem$/.test(l.replace(/: +/, ':  ')))
      && /\( umask 077; as_release 077 cat "\$KEY_DIR\/\$k\.pem" > "\$dest\.part" \)/.test(exportRoot) && /chmod 0600 "\$dest"/.test(exportRoot),
    `other .pem paths: ${JSON.stringify(pemLines)}`);
  check('export-root refuses a destination inside the checkout, a git tree, the state directory or the published repository, and deletes only after "yes"',
    /for bad in "\$SOURCE_DIR" "\$STATE_DIR" "\$PUB_DIR" "\$BUILD_ROOT"; do/.test(exportRoot) && /git -C "\$a" rev-parse --is-inside-work-tree/.test(exportRoot)
      && /if \[\[ \$ans != yes \]\]; then\n\s+echo "Root keys kept on this host\."\n\s+exit 0/.test(exportRoot)
      && exportRoot.indexOf('cmp -s - "$dest.part"') < exportRoot.indexOf('shred -u'),
    'rem0te-signed-export-root: refusal loop over SOURCE_DIR/STATE_DIR/PUB_DIR/BUILD_ROOT, git work-tree check, cmp before delete, delete only on "yes"');

  check('a build is `git archive` of HEAD unpacked by the release user, never a copy of the working tree',
    /^extract_head\(\) \{\n  as_owner git -C "\$SOURCE_DIR" archive --format=tar HEAD \| as_release 022 tar -x -C "\$1" -f -$/m.test(lib)
      && /^extract_head "\$BUILD\/src"$/m.test(pub) && /^extract_head "\$BUILD\/src"$/m.test(setup)
      && !scripts.some(([, s]) => /(?:cp|rsync|tar)\b[^\n]*"\$SOURCE_DIR(?:\/[^"]*)?"[^\n]*(?:"\$BUILD|\$BUILD)/.test(code(s)) || /(?:^|\s)(?:cp|rsync)\b[^\n]*\$SOURCE_DIR/m.test(code(s))),
    'lib.sh extract_head: as_owner git -C "$SOURCE_DIR" archive --format=tar HEAD | as_release 022 tar -x; publish and setup call it; no cp/rsync of $SOURCE_DIR');
  const rootWrites = scripts.flatMap(([f, s]) => code(s).split('\n').filter((l) => /\$TRUSTROOT|trustroot\/root\.json/.test(l) && (/^\s*(?:as_\w+ \d* ?)?(?:cp|mv|install|tee|dd)\b/.test(l) || /[^2<]>>?\s*"[^"]*(?:\$TRUSTROOT|trustroot\/root\.json)/.test(l)) && !/die "/.test(l)).map((l) => `${f}: ${l.trim()}`));
  check('the owner\'s root is written only into the build copy, and the checkout\'s placeholder is checked before and after',
    JSON.stringify(rootWrites) === JSON.stringify(['rem0te-signed-publish: as_release 022 cp "$WORK_REPO/metadata/1.root.json" "$BUILD/src/$TRUSTROOT"'])
      && /^TRUSTROOT=tools\/windows-installer\/trustroot\/root\.json$/m.test(lib)
      && /\[\[ \$wt == '\{\}' \]\] \|\| die/.test(lib) && /\[\[ \$head == '\{\}' \]\] \|\| die/.test(lib)
      && pub.indexOf('check_trustroot_clean') < pub.indexOf('new_build_dir') && /cp "\$WORK_REPO\/metadata\/1\.root\.json" "\$BUILD\/src\/\$TRUSTROOT"\ncheck_trustroot_clean/.test(pub)
      && /^check_trustroot_clean$/m.test(setup)
      && /"\$BUILD\/out\/rem0te-agent\.exe" "\$WORK_REPO\/metadata\/1\.root\.json" \|\| die "the built agent does not embed/.test(pub),
    `writes naming the trust root: ${JSON.stringify(rootWrites)}`);
  check('the checked-in tools/windows-installer/trustroot/root.json is the {} placeholder',
    read('tools/windows-installer/trustroot/root.json').trim() === '{}',
    `it is ${read('tools/windows-installer/trustroot/root.json').length} bytes: never commit the owner's root (rem0te-signed-publish writes it into the build copy only)`);
  check('the checkout\'s JavaScript runs as the checkout\'s owner, never as the key holder',
    /^as_owner env -i PATH="\$SAFE_PATH" "\$NODE" "\$BUILD\/src\/apps\/api\/scripts\/build-signed-installer\.mjs" \\$/m.test(pub)
      && !scripts.some(([, s]) => code(s).split('\n').some((l) => /\$BUILD\/src\/apps/.test(l) && !/^\s*as_owner /.test(l) && !/^\s*--from-source/.test(l)))
      && /^gobuild\(\) \{[^\n]*\n  as_release 022 env -i [\s\S]{0,300}?CGO_ENABLED=0 /m.test(lib),
    'publish: the install.ps1 step is as_owner; no other line runs anything from $BUILD/src/apps; Go builds use CGO_ENABLED=0');

  const loosened = scripts.filter(([, s]) => /\b(?:0?[267]7[0-7]|0?66[0-7]|0?664|g\+w|chmod -R g\+|a\+w|o\+w)\b/.test(code(s))).map(([f]) => f);
  check('the published repository is group-readable and never group-writable: 2750 directories, 0640 files, umask 027',
    /^mk 2750 "\$PUB_DIR" "\$PUB_GROUP"$/m.test(setup) && /as_release 027 chmod -R u=rwX,g=rX,o= "\$stage"/.test(lib)
      && /^umask 027$/m.test(promote) && /mv -T "\$stage\/metadata\/timestamp\.json" "\$pub\/metadata\/timestamp\.json"\nrm -rf "\$stage"/.test(promote)
      && promote.indexOf('mv -T "$stage/metadata/root.json"') < promote.indexOf('mv -T "$stage/metadata/timestamp.json"')
      && /cmp -s "\$stage\/\$f" "\$pub\/\$f" \|\|/.test(promote) && loosened.length === 0,
    `setup mk 2750; publish_repo chmod u=rwX,g=rX,o=; promote-stage umask 027, timestamp.json moved last; loosened modes in: ${loosened.join(', ') || '(none)'}`);
  check('a staged copy is verified with the agents\' client before anything is moved, and a failed one is removed',
    /if ! tool verify -repo "\$stage" -trusted-root "\$WORK_REPO\/metadata\/1\.root\.json" >> "\$LOG_FILE" 2>&1; then\n\s+as_release 027 rm -rf "\$stage"\n\s+die /.test(lib)
      && lib.indexOf('tool verify -repo "$stage"') < lib.indexOf('"$LIB/promote-stage.sh"')
      && /if \[\[ \$EUID -ne 0 && \$\{REM0TE_SIGNED_TEST_CORRUPT_STAGING:-\} == 1 \]\]; then/.test(lib),
    'publish_repo: verify the stage, rm it and die on failure, then promote-stage.sh; the corruption test hook never runs as root');
  check('publish refuses a downgrade and the same version from another commit',
    /if ver_lt "\$VERSION" "\$pv"; then\n\s+die "refusing to publish \$VERSION: \$pv is already published \(a downgrade\)/.test(pub)
      && /if \[\[ \$VERSION == "\$pv" && \$COMMIT != "\$\{PUBL\[AGENT_COMMIT\]:-\}" \]\]; then\n\s+die /.test(pub)
      && pub.indexOf('ver_lt "$VERSION" "$pv"') < pub.indexOf('gobuild '),
    'rem0te-signed-publish: ver_lt → die before any build; same version + other commit → die');
  // 0.38: --approval-keys. Only a public key list goes in, never key material,
  // and the kept copy changes only after the release carrying it is published.
  check('publish --approval-keys refuses key material and keeps the list only after it is published',
    /if grep -qiE 'PRIVATE\|-----BEGIN' "\$approval_src"; then die /.test(pub)
      && pub.indexOf("grep -qiE 'PRIVATE|-----BEGIN'") < pub.indexOf('new_build_dir')
      && /\[\[ -n \$approval_build \]\] && args\+=\(-add "approval\/keys\.json=\$approval_build"\)/.test(pub)
      && pub.indexOf('as_release 027 mv -f "$APPROVAL_KEYS.new" "$APPROVAL_KEYS"') > pub.indexOf('publish_repo "$WORK_REPO"')
      && /APPROVAL_KEYS=\$STATE_DIR\/approval-keys\.json/.test(pub),
    'rem0te-signed-publish: key-material refusal before any build; -add approval/keys.json; the kept copy (under STATE_DIR) replaced only after publish_repo');
  check('the RustDesk build needs GitHub\'s published SHA-256 and comes only from RustDesk\'s GitHub release (or the loopback test server)',
    /if \(!sha\) fail\(`GitHub publishes no SHA-256 digest/.test(asset)
      && /: url === `https:\/\/github\.com\/rustdesk\/rustdesk\/releases\/download\/\$\{version\}\/\$\{name\}`;/.test(asset)
      && /if \[\[ \$got != "\$\{A\[SHA256\]\}" \]\]; then/.test(pub) && /curl_opts\+=\(--proto '=https' --proto-redir '=https'\)/.test(pub)
      && /\|\| die "RUSTDESK_API must be GitHub's or a loopback test server"/.test(pub),
    'rustdesk-asset.mjs refuses a missing digest and any other download URL; publish compares the download with it; https only against GitHub');
  check('the daily refresh runs as the release user, with no access to the portal\'s configuration',
    /^User=@RELEASE_USER@$/m.test(unit) && /^ExecStart=@BIN_DIR@\/rem0te-signed-refresh --conf @CONF@$/m.test(unit)
      && /^InaccessiblePaths=-\/etc\/reboot-remote -\/opt\/reboot-remote$/m.test(unit) && /^IPAddressDeny=any$/m.test(unit)
      && /^PrivateTmp=false$/m.test(unit) && /^ReadWritePaths=@STATE_DIR@ @PUB_DIR@ @BUILD_ROOT@$/m.test(unit)
      && /\nchmod 0755 "\$\(dirname "\$CONF_PATH"\)" "\$LIB_DIR"\n/.test(read('deploy/release/rem0te-signed-setup.sh'))
      && /^TOOL=\$LIB_DIR\/rem0te-release$/m.test(refresh) && /tool refresh -repo "\$BUILD\/repo" "\$\{K\[@\]\}"/.test(refresh),
    'rem0te-timestamp-refresh.service: User=@RELEASE_USER@, InaccessiblePaths the portal config, no outbound network, no PrivateTmp (BUILD_ROOT is in /var/tmp); setup makes the config and tool directories 0755');
  check('the signed install.ps1 and every approved script reach Windows PowerShell 5.1 with a UTF-8 BOM',
    /const script = Buffer\.concat\(\[Buffer\.from\(\[0xef, 0xbb, 0xbf\]\), Buffer\.from\(buildSignedWindowsScript\(version\), 'utf8'\)\]\);/.test(read('apps/api/scripts/build-signed-installer.mjs'))
      && /if !bytes\.HasPrefix\(content, utf8BOM\) \{\s*\n\s*content = append\(append\(\[\]byte\{\}, utf8BOM\.\.\.\), content\.\.\.\)/.test(read('tools/windows-installer/internal/action/script.go'))
      && /"script\.ps1": content,/.test(read('tools/windows-installer/internal/action/script.go'))
      && /check\('install\.ps1 parses as Windows PowerShell 5\.1 reads it/.test(read('apps/api/scripts/unit-signed-installer.mjs')),
    'build-signed-installer.mjs prefixes EF BB BF; script.go writes script.ps1 with the BOM; unit-signed-installer parses it as 5.1 does (0.37.1: the first real migration exited 1 on a mis-decoded em dash)');
  const gh = [];
  const walkAll = (d) => { for (const n of readdirSync(join(ROOT, d))) { const r = `${d}/${n}`; if (statSync(join(ROOT, r)).isDirectory()) walkAll(r); else gh.push(r); } };
  walkAll('.github');
  const ghRefs = gh.filter((f) => /rem0te-signed-|deploy\/release|rem0te-timestamp-refresh|\/var\/lib\/rem0te-release/.test(read(f)));
  check('nothing under .github references the signed-release scripts (no CI builds, signs or publishes)',
    ghRefs.length === 0, `referenced in: ${ghRefs.join(', ')}`);
  const gi = read('.gitignore');
  check('.gitignore keeps in-tree release artefacts out of git',
    /^\/tools\/windows-installer\/rem0te-release$/m.test(gi) && /^\/tools\/windows-installer\/\*\*\/\*\.pem$/m.test(gi) && /^\/deploy\/\*\*\/\*\.pem$/m.test(gi) && /^rem0te-repo\/$/m.test(gi),
    '.gitignore: /tools/windows-installer/rem0te-release, /tools/windows-installer/**/*.pem, /deploy/**/*.pem, rem0te-repo/');
}

// 57. Automatic migration to the signed agent (0.37). Once a signed agent is
//     published, the portal moves standard Windows agents to it by itself,
//     one canary first. It must stay exactly the 0.34 per-computer migration
//     made by the system: its only effect on a computer is an AgentMigration
//     row written through requestAutomatic, which re-checks migrationBlock
//     (Signed only, an updates pause, a staged rollout…) before writing, so
//     the heartbeat hands it out — and holds it — exactly as a person's; it
//     never writes the update-trust mode and does nothing at all in Signed
//     only; the rest move only after the canary was confirmed on the
//     published build and soaked (state machine, a single conditional write
//     to rolling, a database CHECK), paced by the 0.36 per-hour number;
//     per-computer requests are history rows, not audit entries; widening
//     the setting, resuming and restarting are Platform Admin and fresh,
//     turning it off never needs fresh authentication; the Full agent page
//     counts only visible computers and names the canary only to someone who
//     can see it; and the off switch is exact and set for every other suite.
//     0.49 (§ 62, at the owner's request): every "fresh authentication" here
//     is a step-up that names its catalog key (agent.automigrate); a Platform Admin
//     may turn a key off under Settings → Confirm it is you. Until 0.49 it
//     could not be configured.
{
  const ro = read('apps/api/src/agent-auto-migration/rollout.ts');
  const svc = read('apps/api/src/agent-auto-migration/agent-auto-migration.service.ts');
  const ctl = read('apps/api/src/agent-auto-migration/agent-auto-migration.controller.ts');
  const msvc = read('apps/api/src/update-trust/agent-migration.service.ts');
  const mig = read('apps/api/src/update-trust/agent-migration.ts');
  const sql = read('apps/api/prisma/migrations/0064_auto_migration/migration.sql');
  const fb = (src, sig) => { const i = src.indexOf(sig); const j = src.indexOf('\n  }\n', i); return i < 0 ? '' : src.slice(i, j); };
  check('the automatic migration never writes the update-trust mode or requests a trust change',
    ![svc, ro, ctl].some((t) => /updateTrustMode\s*:|legacyPortalMigration\s*:\s*(true|false|next|data)|\.setMode\(|trust\.request\(|\$execute/.test(t))
      && /const update = \{ agentAutoMigrationMode: next\.mode, agentAutoMigrationSoakMinutes: next\.soakMinutes \};/.test(svc)
      && (svc.match(/platformSettings\.(upsert|update|create|updateMany)\(/g) ?? []).length === 1,
    'agent-auto-migration writes PlatformSettings once, with only its own two columns');
  const ra = fb(msvc, 'async requestAutomatic(');
  check('its only effect on a computer is an AgentMigration row written through requestAutomatic, after migrationBlock',
    /const b = await this\.block\(endpointId\);\s*if \(b\) return \{ refused: b\.code \};/.test(ra)
      && ra.indexOf('this.block(endpointId)') < ra.indexOf('agentMigration.create(')
      && /requestedById: null, automatic: true, rolloutId,/.test(ra) && !/audit\./.test(ra)
      && !/agentMigration\.(create|update|upsert|delete)|reinstallRequestedAt|updateRequestedAt|rustdeskNode\.update|endpointCommand|buildMigrationScript|scriptForNonce|\.forHeartbeat\(/.test(svc)
      && (svc.match(/this\.migration\.requestAutomatic\(/g) ?? []).length === 3,
    'requestAutomatic: block() first, no requester, no audit; the service writes no migration, flag or command itself (3 requestAutomatic calls: canary, rest, resume)');
  check('halting stops only automatic requests, never a person\'s',
    /updateMany\(\{ where: \{ id: migrationId, automatic: true, \.\.\.OPEN \}, data: \{ cancelledAt: new Date\(\) \} \}\)/.test(fb(msvc, 'async cancelAutomatic('))
      && /"AgentMigration_automatic_shape" CHECK \(\s*\("automatic" AND "requestedById" IS NULL AND "rolloutId" IS NOT NULL\) OR \(NOT "automatic" AND "rolloutId" IS NULL\)/.test(sql),
    'cancelAutomatic matches automatic: true; 0064 ties automatic to no requester and a rollout');
  check('Signed only (with or without portal migration): the sweep does nothing',
    /if \(i\.trustMode === 'signed_only'\) return 'signed_only';/.test(ro) && /if \(g\.gate \|\| !g\.agent\) return;/.test(fb(svc, 'async tick('))
      && /if \(i\.settings\.mode === 'off'\) return 'mode_off';/.test(ro) && /if \(!i\.publishedSha256 \|\| !\/\^\[0-9a-f\]\{64\}\$\/\.test\(i\.publishedSha256\)\) return 'no_release';/.test(ro),
    "gate(): mode off, no release and signed_only return a reason; tick() returns on any gate");
  const ns = ro.slice(ro.indexOf('export function nextStep('), ro.indexOf('// ── Picking computers'));
  check('the rest move only after the canary was confirmed on the published build and soaked',
    /if \(onBuild\(canary, r\.targetSha256\)\) return \{ do: 'confirm' \};/.test(ns)
      && /export const onBuild = \(f: Pick<CanaryFacts, 'updateChannel' \| 'agentSha256'>, sha: string\) => f\.updateChannel === 'signed' && f\.agentSha256 === sha;/.test(ro)
      && /if \(t < end\) return \{ do: 'wait'/.test(ns) && /if \(canary\.lastSeenAt && canary\.lastSeenAt\.getTime\(\) >= end\) return \{ do: 'start_rolling' \};/.test(ns)
      && ns.indexOf("if (t < end)") < ns.indexOf("do: 'start_rolling'") && (ns.match(/do: 'start_rolling'/g) ?? []).length === 1
      && (svc.match(/state: 'rolling'/g) ?? []).length === 1 && /where: \{ id: r\.id, state: 'soaking' \}, data: \{ state: 'rolling', rollingAt: now \}/.test(svc)
      && /"AgentAutoMigration_rolling_needs_canary" CHECK \("state" <> 'rolling' OR \("canaryConfirmedAt" IS NOT NULL AND "rollingAt" IS NOT NULL\)\)/.test(sql)
      && /export const CANARY_CONFIRM_MS = 2 \* H;/.test(ro) && /export const SOAK_MIN = 15;/.test(ro) && /export const SOAK_MAX = 1440;/.test(ro)
      && /CHECK \(\s*"agentAutoMigrationMode" IN \('off', 'canary_then_all'\) AND "agentAutoMigrationSoakMinutes" BETWEEN 15 AND 1440/.test(sql),
    'nextStep: confirm only onBuild; start_rolling once, after the soak and a later check-in; one conditional write to rolling; 0064 CHECKs');
  check('rolling is paced by the 0.36 per-hour number, a bounded batch per tick, and only reporting computers',
    /let left = budget\(pace\.perHour, await this\.usedLastHour\(now\)\);/.test(svc)
      && /return this\.prisma\.agentMigration\.count\(\{ where: \{ automatic: true, requestedAt: \{ gt: new Date\(now\.getTime\(\) - 3600_000\) \} \} \}\);/.test(svc)
      && /export const BATCH_PER_TICK = 50;/.test(ro) && /return Math\.max\(0, Math\.min\(BATCH_PER_TICK, perHour - usedLastHour\)\);/.test(ro)
      && /lastSeenAt: \{ gte: heartbeatCutoff\(now\.getTime\(\)\) \},/.test(svc) && /pg_try_advisory_xact_lock\(hashtext\('rem0te\.agent-auto-migration'\)\)/.test(svc),
    'migrateRest: budget(perHour, usedLastHour); candidates inside the heartbeat window; one process at a time');
  const put = fb(svc, 'async putSettings(');
  check('per-computer requests are not audit entries; settings, resume and restart are Platform Admin, fresh where they widen, audited',
    !/AGENT_MIGRATION_REQUESTED/.test(svc + ra)
      && [...svc.matchAll(/resource: '([a-z_]+)'/g)].every((m) => ['agent_auto_migration', 'platform_settings'].includes(m[1]))
      && /this\.acl\.assertPlatformAdmin\(actor\);[\s\S]{0,400}if \(isWidening\(before, next\)\) \{\s*assertFresh\(freshMethod,/.test(put)
      && /if \(after\.mode === 'off'\) return false;\s*if \(before\.mode === 'off'\) return true;\s*return after\.soakMinutes < before\.soakMinutes;/.test(ro)
      && /action: 'AGENT_AUTO_MIGRATION_SETTINGS_CHANGED', resource: 'platform_settings', resourceId: 'singleton',\s*meta: \{ before: shape\(before\), after: shape\(after\) \},/.test(put)
      && ['async resume(', 'async restart('].every((f) => /^async \w+\(actor: ActorContext, freshMethod: string \| null\) \{\s*this\.acl\.assertPlatformAdmin\(actor\);\s*assertFresh\(freshMethod,/.test(fb(svc, f)))
      && /async getSettings\(actor: ActorContext\) \{\s*this\.acl\.assertPlatformAdmin\(actor\);/.test(svc)
      && /@Controller\('admin\/agent-auto-migration'\)\s*@UseGuards\(PlatformAdminGuard\)/.test(ctl)
      && (ctl.slice(ctl.indexOf("@Controller('admin/agent-auto-migration')")).match(/@(Get|Put|Post|Delete|Patch)\(/g) ?? []).length === 4,
    'no per-computer audit; isWidening → assertFresh; off never widens; resume/restart assertPlatformAdmin then assertFresh; PlatformAdminGuard, four routes');
  const ov = fb(svc, 'async overview(');
  check('the Full agent page needs computers:view, counts only visible computers and names the canary only to someone who can see it',
    /@Get\('overview'\)\s*@RequireCapability\(CAP\.COMPUTERS_VIEW\)/.test(ctl) && /@UseGuards\(JwtAuthGuard, CapabilitiesGuard\)/.test(ctl)
      && /const vis = this\.acl\.endpointVisibilityWhere\(actor, businessId\);\s*const eps = await this\.prisma\.endpoint\.findMany\(\{\s*where: \{ AND: \[vis\] \},/.test(ov)
      && /where: \{ endpointId: \{ in: ids \} \}/.test(ov) && (ov.match(/prisma\.endpoint\.(findMany|count|findFirst|groupBy)\(/g) ?? []).length === 2
      && /findFirst\(\{ where: \{ AND: \[\{ id: r\.canaryEndpointId \}, vis\] \}/.test(ov)
      && /const progress = actor\.isPlatformAdmin \? await this\.progress\(r\.id\) : null;/.test(ov),
    'overview(): endpoints from endpointVisibilityWhere; migrations/rollouts by those ids; canary through the same where; progress for Platform Admins only');
  const web = read('apps/web/app/(app)/endpoints/full-agent/page.tsx');
  check('the page shows the interface\'s commands verbatim and never claims the timestamp timer runs',
    /export const SETUP_COMMAND = 'sudo \.\/deploy\/release\/rem0te-signed-setup\.sh';/.test(mig) && /export const PUBLISH_COMMAND = 'sudo rem0te-signed-publish';/.test(mig)
      && /export const STATUS_COMMAND = 'sudo rem0te-signed-status';/.test(mig) && /export const TIMESTAMP_TIMER = 'rem0te-timestamp-refresh\.timer';/.test(mig)
      && !/timerActive|timerRunning|timer is running|timer runs/i.test(svc + web) && /cannot see/i.test(web),
    'agent-migration.ts holds the four strings; neither the service nor the page claims the timer runs, and the page says the portal cannot see it');
  check('AUTO_MIGRATION_SWEEP=off is exact, and set for run-e2e.sh and the browser suite',
    /onModuleInit\(\) \{\s*if \(process\.env\.AUTO_MIGRATION_SWEEP === 'off'\) return;/.test(svc) && /processOn: env\.AUTO_MIGRATION_SWEEP !== 'off',/.test(ro)
      && /\nexport AUTO_MIGRATION_SWEEP=off\n/.test(read('scripts/run-e2e.sh'))
      && /AUTO_MIGRATION_SWEEP: 'off',/.test(read('apps/web/scripts/e2e-ui.mjs')),
    "onModuleInit: AUTO_MIGRATION_SWEEP === 'off' → no timer; settingsFrom; run-e2e.sh exports it; e2e-ui's API env sets it");
  // 0.37.3: the installer's output is teed through a pipe, and a RustDesk
  // process install.ps1 leaves running inherits it. Without a WaitDelay the
  // agent waited for that process forever: the migration hung on real
  // Windows after a successful install and the heartbeat task never ran again.
  const ri = read('tools/windows-installer/internal/agent/runinstaller.go');
  const pw = read('tools/windows-installer/platform_windows.go');
  check('the agent never waits on a descendant of install.ps1 that holds its output pipe',
    /cmd\.WaitDelay = InstallerWaitDelay/.test(ri) && /const InstallerWaitDelay = \d+ \* time\.Second/.test(ri)
      && /errors\.Is\(err, exec\.ErrWaitDelay\) && cmd\.ProcessState != nil \{\s*return cmd\.ProcessState\.ExitCode\(\), nil/.test(ri)
      && /func \(w \*winPlatform\) RunInstaller\([^)]*\) \(int, error\) \{[^}]*return agent\.RunInstallerCmd\(cmd\)\s*\}/.test(pw)
      && /TestRunInstallerCmdDoesNotWaitForDescendants/.test(read('tools/windows-installer/internal/agent/runinstaller_test.go')),
    'RunInstallerCmd sets WaitDelay and keeps the exit code on ErrWaitDelay; winPlatform.RunInstaller goes through it; the Go test exists');
  // 0.37.3: the installer's start-up cleanup removed setup (the agent's
  // staging, setup\\signed) and heartbeat.ps1, so every migration failed at
  // step 1 and the computer went silent.
  const wsrc = read('apps/api/src/public/windows-script.ts');
  const preStart = wsrc.slice(0, wsrc.indexOf('Log "Rem0te installer starting.'));
  check('the installer cleanup keeps the signed agent\'s staging directory and heartbeat.ps1',
    /Get-ChildItem -LiteralPath \$SETUP_DIR -Force -ErrorAction SilentlyContinue \|\s*Where-Object \{ \$_\.Name -ne 'signed' \} \|\s*Remove-Item -Recurse/.test(preStart)
      && !/'heartbeat\.ps1', 'setup'/.test(preStart) && !/Remove-Item[^\n]*heartbeat\.ps1/.test(preStart)
      && /pwsh: the cleanup keeps setup\/signed/.test(read('apps/api/scripts/unit-signed-installer.mjs')),
    "cleanup: setup's children except 'signed'; no removal of heartbeat.ps1 before the run starts; the unit test executes it");
}

// 58. Direct mode (0.40). For a single operator, the approval signer's
//     operator may set a business (or `default`) to sign plans at admission,
//     with no approvers. It gives up the second person and keeps everything
//     else, so: the mode is written only by the signer CLI into its own
//     policy store (no HTTP route on the signer or the portal writes it, and
//     each change is logged); the signer signs at admission only when its
//     own policyFor(...) says direct and the plan says so too, after every
//     other admission check and the pause; patch policies and allowlist
//     entries activate at admission only under the same reading (the
//     allowlist under `default`), and a direct-activated policy stops
//     counting outside direct mode; the agent relaxes its approval checks
//     only on the signed `policy.approval: "direct"`; a portal request in
//     direct mode needs a fresh sign-in, and ClientSt0r cannot make one; and
//     direct mode and customer sign-off never hold together.
{
  const core = read('apps/api/src/approval-signer/core.ts');
  const server = read('apps/api/src/approval-signer/server.ts');
  const main = read('apps/api/src/approval-signer/main.ts');
  const store = read('apps/api/src/approval-signer/store.ts');
  const client = read('apps/api/src/actions/signer.client.ts');
  const cat = read('apps/api/src/actions/catalog.ts');
  const pp = read('apps/api/src/actions/patch-policy.ts');
  const asvc = read('apps/api/src/actions/actions.service.ts');
  const goA = read('tools/windows-installer/internal/action/action.go');
  const goS = read('tools/windows-installer/internal/action/script.go');
  const strip = (s) => s.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
  const fn = (src, head, n = 2400) => { const i = src.indexOf(head); return i < 0 ? '' : src.slice(i, i + n); };

  // 1. Only the CLI writes the policy, and logs every change.
  const savers = walk('apps/api/src').filter((f) => /\bsavePolicy\(/.test(strip(read(f))) && f !== 'apps/api/src/approval-signer/store.ts');
  const pcase = fn(main, "case 'policy': {", 4000);
  check('direct: the policy is written only by the signer CLI, and every change is appended to policy-changes.log',
    JSON.stringify(savers) === JSON.stringify(['apps/api/src/approval-signer/main.ts'])
      && /store\.savePolicy\(p\);\s*store\.appendPolicyChange\(\{ at: new Date\(\)\.toISOString\(\), business: b, before, after: next,/.test(pcase)
      && /appendFileSync\(path\.join\(this\.dir, 'policy-changes\.log'\)[^;]*flag: 'a'/.test(store)
      && /if \(ap !== undefined && ap !== 'direct' && ap !== 'signed'\) die\(/.test(pcase),
    `savePolicy callers: ${savers.join(', ')}`);
  check('direct: no HTTP route writes the policy — the signer\'s policy route is GET only, and the portal only reads it',
    /if \(req\.method === 'GET' && pm\) return send\(res, 200, pm\[1\] === 'default' \?/.test(server) && (strip(server).match(/\/internal\\\/v1\\\/policy\\\//g) ?? []).length === 1
      && !/savePolicy|policy\.json/.test(strip(server))
      && /policy\(businessId: string\) \{ return this\.call<[^>]*>\('GET', `\/internal\/v1\/policy\//.test(client) && !/'(POST|PUT|PATCH|DELETE)', `\/internal\/v1\/policy\//.test(client)
      && !walk('apps/api/src').some((f) => /controller\.ts$/.test(f) && /@(Post|Put|Patch|Delete)\('[^']*(approval-mode|direct)/i.test(read(f))),
    'GET /internal/v1/policy/:id|default only; SignerClient.policy is a GET');

  // 2. The reading: exactly 'direct', and never with customer sign-off.
  check('direct: policyFor reads direct only from the exact value and never with customer sign-off; the CLI refuses the pair',
    /return \{ customerSignoff, approval: p\.approval === DIRECT && !customerSignoff \? DIRECT : 'signed' \};/.test(core)
      && /const customerSignoff = p\.customerSignoff === true;/.test(core)
      && /if \(next\.customerSignoff && next\.approval === 'direct'\) \{\s*die\(/.test(pcase)
      && /if \(p\.policy\.approval === DIRECT\) \{\s*if \(p\.policy\.customerSignoff\) return \{ ok: false, reason: 'direct_with_customer_signoff' \};\s*if \(p\.policy\.approvalsRequired !== 0\) return \{ ok: false, reason: 'policy_mismatch' \};\s*\} else if \(p\.policy\.approvalsRequired < APPROVALS_REQUIRED\[risk\]\)/.test(cat)
      && /approval: z\.literal\(DIRECT\)\.optional\(\)/.test(cat)
      && /policy\(\): Policy \{ return this\.read<Policy>\(path\.join\(this\.dir, 'policy\.json'\)\) \?\? \{ default: \{ customerSignoff: false \}, businesses: \{\} \}; \}/.test(store),
    'policyFor, the CLI, validatePlanAction and the store default');

  // 3. Signing at admission, only under the policy, after every check.
  const adm = fn(core, 'export function admitPlan(', 2400);
  const post = fn(server, "if (req.method === 'POST' && !m[1]) {", 2600);
  const iAdmit = post.indexOf('admitPlan(b.plan, store.policy(), now(), (id) => store.scriptEntry(id), softwareRevoked)');
  const iPause = post.indexOf('store.activePause(plan.targets[0]?.businessId ?? null)');
  const iSign = post.search(/if \(plan\.policy\.approval === 'direct'\) \{\s*signJob\(j, k, now\(\)\);/);
  check('direct: the signer signs at admission only when the plan says direct, which admitPlan allows only when its own policy does — after admission and the pause',
    /const biz = policyFor\(policy, p\.targets\[0\]\.businessId\);/.test(adm)
      && /const direct = biz\.approval === DIRECT;\s*if \(\(p\.policy\.approval === DIRECT\) !== direct\) throw new Refused\('policy_mismatch'/.test(adm)
      && /if \(p\.policy\.approvalsRequired !== \(direct \? 0 : APPROVALS_REQUIRED\[p\.policy\.risk\]\)\) throw new Refused\('policy_mismatch'/.test(adm)
      && /if \(p\.approvers\.length \|\| p\.signedAt\) throw new Refused\('invalid_plan'/.test(adm)
      && adm.indexOf("const v = validatePlanAction(p);") > 0 && adm.indexOf('assertScriptAllowed(p, scripts)') > adm.indexOf('policy_mismatch') && adm.indexOf('assertSoftwareAllowed(p, softwareRevoked)') > 0
      && iAdmit > 0 && iPause > iAdmit && iSign > iPause
      && (strip(server).match(/\bsignJob\(/g) ?? []).length === 2,
    `admitPlan ${iAdmit}, pause ${iPause}, sign ${iSign}; signJob calls ${(strip(server).match(/\bsignJob\(/g) ?? []).length}`);

  // 4. Patch policies and the allowlist.
  const pprop = fn(server, 'async function internalPolicy(', 2600);
  check('direct: a patch policy activates at admission only under policyFor(...) direct, after admission, the pause and the pin check; it counts only while direct',
    /if \(policyFor\(store\.policy\(\), doc\.businessId\)\.approval === 'direct'\) \{\s*r\.direct = true;\s*signPolicy\(r, k, now\(\)\);/.test(pprop)
      && pprop.indexOf("approval === 'direct'") > pprop.indexOf('pinConflicts(doc.rings.flat(), pins)') && pprop.indexOf('pinConflicts(') > pprop.indexOf('assertNotPaused(doc.businessId)')
      && (strip(server).match(/\bsignPolicy\(/g) ?? []).length === 2
      && /export function policyQuorum\(doc: PolicyDoc, approvals: PolicyApproval\[\], customerSignoff: boolean, direct = false\): boolean \{\s*if \(direct\) return !customerSignoff;/.test(pp)
      && /policyQuorum\(doc, s\.approvals, false, opts\.direct === true\)/.test(pp) && /policyQuorum\(doc, s\.approvals, opts\.customerSignoff, opts\.direct === true\)/.test(pp)
      && /\}, req, \{ now, customerSignoff: biz\.customerSignoff, direct: biz\.approval === DIRECT \}\);/.test(core),
    'internalPolicy, policyQuorum, signUnderPolicy');
  check('direct: an allowlist entry activates at admission only under the signer\'s default policy',
    /export function allowlistDirect\(policy: Policy\): boolean \{\s*return policyFor\(\{ default: policy\.default, businesses: \{\} \}, '-'\)\.approval === DIRECT;/.test(core)
      && /export function admitScriptProposal\(raw: unknown, now: Date, direct = false\): ScriptAllowRecord \{/.test(core)
      && /if \(!direct && p\.contributors\.some\(\(c\) => c\.userId === p\.reviewedBy\.userId\)\) throw new Refused\('invalid_script'/.test(core)
      && (strip(server).match(/admitScriptProposal\(/g) ?? []).length === 1 && /const direct = allowlistDirect\(store\.policy\(\)\);\s*const r = admitScriptProposal\(b\.proposal, now\(\), direct\);/.test(server)
      && /const approvalMode = /.test(read('apps/api/src/actions/approval-mode.ts')) === false
      && (strip(read('apps/api/src/actions/approval-mode.ts')).match(/this\.signer\.\w+\(/g) ?? []).join() === 'this.signer.configured(,this.signer.policy('
      && /const r = await this\.signer\.policy\('default'\);\s*return r\.status === 200 && r\.body\.approval === 'direct';/.test(read('apps/api/src/actions/approval-mode.ts')),
    'allowlistDirect, admitScriptProposal and the library\'s one-question probe');

  // 5. The agent relaxes only on the signed field.
  const ver = fn(goA, 'local := a.Risk(pt, len(p.Targets))', 1600);
  const isD = fn(goA, 'func isDirect(p *Plan) (bool, *Result) {', 600);
  check('direct: the agent relaxes the count and the requester rule only on the signed "direct", never with customer sign-off; its own risk check comes first',
    /Approval string `json:"approval,omitempty"`/.test(goA)
      && /switch p\.Policy\.Approval \{\s*case "":\s*return false, nil\s*case "direct":\s*if p\.Policy\.CustomerSignoff \{\s*return false, refuse\("bad_plan"/.test(isD) && /return false, refuse\("bad_plan", "unknown approval mode/.test(isD)
      && ver.indexOf('risk_understated') > 0 && ver.indexOf('isDirect(&p)') > ver.indexOf('risk_understated')
      && /if direct \{\s*need = 0\s*\}/.test(ver) && /if ap\.UserID == p\.RequestedBy\.UserID && !direct \{/.test(ver)
      && (strip(goA).replace(/"[^"\n]*"|`[^`]*`/g, '""').match(/\bdirect\b/g) ?? []).length === 3
      && /if p\.Policy\.Approval != "direct" \{\s*for _, ap := range p\.Approvers \{\s*for _, c := range s\.Contributors \{/.test(goS),
    'action.go verify/isDirect and script.go SAME_PERSON');

  // 6. The portal: a direct request needs a fresh sign-in, and is a person's.
  const cp = fn(asvc, 'async createPlan(actor: ActorContext, r: PlanRequest)', 9000);
  const iDir = cp.search(/const direct = signerPolicy\.body\.approval === DIRECT;\s*if \(direct && !r\.underPolicy\) assertDirectRequest\(origin\.via, r\.freshMethod\);/);
  const adr = fn(asvc, 'function assertDirectRequest(', 900);
  const callers = [
    ['actions', fn(asvc, 'async request(actor: ActorContext, endpointId: string, raw: unknown', 1600)],
    ['patching', fn(read('apps/api/src/patching/patching.service.ts'), 'async requestRing(actor: ActorContext, id: string, ring: number, raw: unknown, under?: UnderPolicy, freshMethod', 4000)],
    ['software', fn(read('apps/api/src/software/software.service.ts'), 'async requestRing(actor: ActorContext, id: string, ring: number, raw: unknown, freshMethod', 4000)],
    ['script-run', fn(read('apps/api/src/script-run/script-run.service.ts'), 'async requestRun(actor: ActorContext, raw: unknown, freshMethod', 4000)],
    ['device-control service', fn(read('apps/api/src/device-control/device-control.service.ts'), 'async controlService(actor: ActorContext, endpointId: string, raw: unknown, freshMethod', 3000)],
    ['device-control process', fn(read('apps/api/src/device-control/device-control.service.ts'), 'async stopProcess(actor: ActorContext, endpointId: string, raw: unknown, freshMethod', 3000)],
  ].map(([n, b]) => [n, /this\.(actions\.)?createPlan\(actor, \{[\s\S]*?freshMethod,?\s*\}\)/.test(b)]);
  const ctls = [
    ['actions', /this\.actions\.request\(actor, id, body, undefined, undefined, this\.freshMethod\(req\)\)/.test(read('apps/api/src/actions/actions.controller.ts'))],
    ['patching install', /this\.patching\.installOnEndpoint\(actor, id, body, this\.freshMethod\(req\)\)/.test(read('apps/api/src/patching/patching.controller.ts'))],
    ['script-run run', /this\.svc\.requestRun\(actor, body, this\.fresh\(req\)\)/.test(read('apps/api/src/script-run/script-run.controller.ts'))],
    ['script-run propose', /this\.svc\.propose\(actor, versionId, this\.fresh\(req\)\)/.test(read('apps/api/src/script-run/script-run.controller.ts'))],
    ['device-control service', /this\.svc\.controlService\(actor, id, body, this\.fresh\(req\)\)/.test(read('apps/api/src/device-control/device-control.controller.ts'))],
    ['device-control process', /this\.svc\.stopProcess\(actor, id, body, this\.fresh\(req\)\)/.test(read('apps/api/src/device-control/device-control.controller.ts'))],
  ];
  const prop = fn(read('apps/api/src/script-run/script-run.service.ts'), 'async propose(actor: ActorContext, versionId: string, freshMethod', 3000);
  check('direct: a portal request in direct mode needs a fresh sign-in before it is submitted, ClientSt0r is refused, and every request path passes the sign-in on',
    iDir > 0 && iDir < cp.indexOf('this.signer.submit(plan)') && iDir < cp.indexOf('const plan: Plan = {')
      && /if \(via === 'clientst0r'\) throw new ForbiddenException\(\{ code: 'DIRECT_MODE_PORTAL_ONLY'/.test(adr) && /assertFresh\(freshMethod \?\? null, \{ action: 'actions\.direct'/.test(adr)
      && /customerSignoff: direct \? false : !!signerPolicy\.body\.customerSignoff, \.\.\.\(direct \? \{ approval: DIRECT \} : \{\}\)/.test(cp)
      && callers.every(([, ok]) => ok) && ctls.every(([, ok]) => ok)
      && /const direct = await this\.allowlistDirect\(\);\s*if \(direct\) assertFresh\(freshMethod \?\? null/.test(prop) && prop.indexOf('assertFresh(') < prop.indexOf('this.signer.proposeScript(')
      && /await this\.actions\.assertDirectFresh\(ep\.customerId!, freshMethod\);\s*const host/.test(read('apps/api/src/patching/patching.service.ts'))
      && /await this\.actions\.assertDirectFresh\(ep\.customerId, freshMethod\);\s*const d = await this\.build/.test(read('apps/api/src/software/software.service.ts')),
    `createPlan ${iDir}; createPlan callers ${callers.map(([n, ok]) => `${n}=${ok}`).join(', ')}; controllers ${ctls.map(([n, ok]) => `${n}=${ok}`).join(', ')}`);
}

// 59. The winget catalog and removing installed programs (0.41). Search reads
//     a copy of the public winget index fetched from one fixed URL, bounded,
//     with no credentials and no redirects, and parsed by fixed read-only
//     queries; nothing a computer sends reaches it. One-click install goes
//     through the same catalog entry, fresh sign-in and createPlan as any
//     install, with a hash from winget-pkgs. windows.software.remove@1 names
//     an uninstall key, its view and the expected DisplayName, never a
//     command: the agent reads the key itself, refuses one that names another
//     program, and runs only System32 msiexec /x {GUID} /qn /norestart or the
//     key's own QuietUninstallString, through one exec site with no shell.
//     0.49 (§ 62, at the owner's request): every "fresh authentication" here
//     is a step-up that names its catalog key (software.catalog (and actions.direct for a direct-mode request)); a Platform Admin
//     may turn a key off under Settings → Confirm it is you. Until 0.49 it
//     could not be configured.
{
  const goRm = read('tools/windows-installer/internal/action/remove.go');
  const goRmWin = read('tools/windows-installer/software_remove_windows.go');
  const goCat = read('tools/windows-installer/internal/action/catalog.go');
  const tsCat = read('apps/api/src/actions/catalog.ts');
  const goRe = (name) => (goRm.match(new RegExp(`${name}\\s*= regexp\\.MustCompile\\(\`([^\`]+)\`\\)`)) ?? [])[1] ?? null;
  const tsRe = (name) => (tsCat.match(new RegExp(`export const ${name} = /(.+)/;`)) ?? [])[1] ?? null;
  const keyRe = goRe('ProgramKeyRE'), nameRe = goRe('ProgramNameRE');
  check('remove: the key and display-name charsets are the same regular expression on the agent and the portal',
    !!keyRe && keyRe === tsRe('PROGRAM_KEY_RE') && !!nameRe && nameRe === tsRe('PROGRAM_NAME_RE'),
    `agent ${keyRe} / ${nameRe}; portal ${tsRe('PROGRAM_KEY_RE')} / ${tsRe('PROGRAM_NAME_RE')}`);
  const HOSTILE_KEYS = ['..', '..\\Run', 'a\\b', 'a/b', 'HKLM:\\x', '-x', ' x', 'a"b', 'a;b', 'a|b', 'a%TEMP%', 'a`b', 'a$b', 'a\nb', 'a'.repeat(129)];
  const letKeys = keyRe ? HOSTILE_KEYS.filter((k) => new RegExp(keyRe).test(k)) : ['(regex not found)'];
  check('remove: a key can never be a path, an option or carry a shell character', letKeys.length === 0, `accepted: ${letKeys.map((x) => JSON.stringify(x)).join(', ')}`);
  check('remove: the parameters are exactly key, view ("64" or "32") and displayName, on both sides',
    /if !exactKeys\(p, "key", "view", "displayName"\) \{/.test(goRm) && /s\.View != "64" && s\.View != "32"/.test(goRm)
      && /func removeParamsOK\(p map\[string\]any\) bool \{\s*_, err := RemoveParams\(p\)\s*return err == nil\s*\}/.test(goRm)
      && /export const RemoveParams = z\.object\(\{\s*key: z\.string\(\)\.regex\(PROGRAM_KEY_RE\),\s*view: z\.enum\(\['64', '32'\]\),\s*displayName: z\.string\(\)\.refine\(programNameOk, [^)]*\),\s*\}\)\.strict\(\);/.test(tsCat),
    'RemoveParams (Go and zod) must stay exactly the three closed keys');
  const rmEntry = goCat.split(/\n\t\{\n/).find((e) => /ID: "windows\.software\.remove"/.test(e)) ?? '';
  const tsRm = (tsCat.match(/export const SOFTWARE_REMOVE: CatalogAction = \{([\s\S]*?)\n\};/) ?? [])[1] ?? '';
  check('remove: high impact on any computer, one computer per plan, never direct, never offered to ClientSt0r',
    /MaxTargets: 1,/.test(rmEntry) && /ParamsOK:\s+removeParamsOK,/.test(rmEntry) && /Risk:\s+func\(int, int\) string \{ return "high" \},/.test(rmEntry) && /Precheck:\s+removePrecheck,/.test(rmEntry)
      && /risk: \(\) => 'high',/.test(tsRm) && /maxTargets: 1,/.test(tsRm) && /direct: false,/.test(tsRm) && /integration: false,/.test(tsRm) && /params: RemoveParams,/.test(tsRm),
    'the agent entry and SOFTWARE_REMOVE must agree');
  const iRead = goRm.indexOf('pr, found, bad := readProgram(o, s, r.Observed)'), iFor = goRm.indexOf('c, refused := removalFor(s.Key, pr, o)'), iJ = goRm.indexOf('journalStep(o, p, "removing")'), iRun = goRm.indexOf('o.Programs.Remove(c, ');
  check('remove: the agent reads the key itself, refuses a key that names another program, and decides the command before running it',
    iRead > 0 && iFor > iRead && iJ > iFor && iRun > iJ
      && /if found && strings\.TrimSpace\(pr\.DisplayName\) != s\.DisplayName \{[\s\S]{0,200}Reason: "program_changed"/.test(goRm)
      && /func removePrecheck\(p \*Plan, o Options\) \*Result \{[\s\S]*?AppManagers\(\)[\s\S]*?readProgram\(o, s, obs\)[\s\S]*?removalFor\(s\.Key, pr, o\)/.test(goRm),
    'removeProgram: readProgram, then removalFor, then the journal step, then Remove; Precheck checks managers, the key and the command first');
  const rf = (goRm.match(/func removalFor\(key string, pr Program, o Options\) \(RemovalCommand, \*Result\) \{([\s\S]*?)\n\}\n/) ?? [])[1] ?? '';
  const ru = (goRm.match(/func RecognizeUninstall\(key string, pr Program, files ProgramRegistry\) \(RemovalCommand, string\) \{([\s\S]*?)\n\}\n/) ?? [])[1] ?? '';
  check('remove: only msiexec /x {GUID} /qn /norestart, the key\'s own QuietUninstallString, or a recognised silent form of its UninstallString; anything else is refused',
    /func MsiArgs\(productCode string\) \[\]string \{\s*return \[\]string\{"\/x", productCode, "\/qn", "\/norestart"\}\s*\}/.test(goRm)
      && /if strings\.TrimSpace\(pr\.QuietUninstallString\) == "" \{[\s\S]{0,600}Reason: "no_silent_uninstall"/.test(rf)
      && /c, err := ParseQuietUninstall\(pr\.QuietUninstallString\)/.test(rf) && /c, why := RecognizeUninstall\(key, pr, o\.Programs\)/.test(rf)
      && /if c\.Kind == "msi" && !strings\.EqualFold\(c\.ProductCode, key\)/.test(rf)
      && /strings\.ContainsAny\(s, "%&\|<>\^`\\n"\)/.test(goRm) && /return RemovalCommand\{\}, errors\.New\("an msiexec command other than \/x of one product code"\)/.test(goRm),
    'removalFor / ParseQuietUninstall must keep the closed forms');
  // 0.42: the recognised forms. Each goes through ParseQuietUninstall first
  // (absolute .exe, no shell characters, no environment variables, nothing
  // on NeverRun), and the agent's arguments are constants.
  const kindsBuilt = [...ru.matchAll(/RemovalCommand\{Kind: "([a-z]+)"/g)].map((x) => x[1]).sort().join();
  check('remove: the UninstallString forms are exactly msi (its own product), inno, nsis and chromium, each parsed as strictly as a QuietUninstallString',
    kindsBuilt === 'chromium,inno,msi,nsis' && ru.indexOf('c, err := ParseQuietUninstall(us)') > 0 && ru.indexOf('c, err := ParseQuietUninstall(us)') < ru.indexOf('Kind: "inno"')
      && /if err != nil \|\| c\.Kind != "quiet" \{\s*return RemovalCommand\{\}, interactiveOnly/.test(ru)
      && /if m := msiInQuietRE\.FindStringSubmatch\(us\); m != nil \{\s*if !strings\.EqualFold\(m\[1\], key\) \{/.test(ru)
      && ru.indexOf('driverKeyRE.MatchString(key)') >= 0 && ru.indexOf('driverKeyRE.MatchString(key)') < ru.indexOf('msiInQuietRE')
      && /\\officeclicktorun\.exe/.test(ru) && !/Kind: "office"|Kind: "driver"/.test(ru),
    `RecognizeUninstall builds ${kindsBuilt || '(nothing found)'}`);
  check('remove: each recognised form gets fixed arguments — Inno /VERYSILENT /SUPPRESSMSGBOXES /NORESTART with none registered, NSIS /S after its header is read, Chromium --force-uninstall on --uninstall --system-level',
    /func InnoArgs\(\) string\s*\{ return "\/VERYSILENT \/SUPPRESSMSGBOXES \/NORESTART" \}/.test(goRm)
      && /func NSISArgs\(registered string\) string\s*\{ return strings\.TrimSpace\(registered \+ " \/S"\) \}/.test(goRm)
      && /func ChromiumArgs\(registered string\) string \{ return registered \+ " --force-uninstall" \}/.test(goRm)
      && /case innoKeyRE\.MatchString\(key\) && innoExeRE\.MatchString\(base\) && args == "":\s*return RemovalCommand\{Kind: "inno", Exe: exe, Args: InnoArgs\(\)\}/.test(ru)
      && /innoKeyRE\s*= regexp\.MustCompile\(`\(\?i\)_is1\$`\)/.test(goRm) && /innoExeRE\s*= regexp\.MustCompile\(`\(\?i\)\^unins\[0-9\]\{3\}\\\.exe\$`\)/.test(goRm)
      && /nsisArgsOK\s*= map\[string\]bool\{"": true, "\/allusers": true, "\/currentuser": true\}/.test(goRm)
      && /head, err := files\.FileHead\(exe, NSISHeadBytes\)\s*if err != nil \|\| !strings\.Contains\(string\(head\), NSISMarker\) \{\s*return RemovalCommand\{\}, interactiveOnly/.test(ru)
      && /NSISMarker\s*= "\\xef\\xbe\\xad\\xdeNullsoftInst"/.test(goRm) && /if files == nil \{\s*return RemovalCommand\{\}, interactiveOnly/.test(ru)
      && /if !chromiumArgRE\.MatchString\(t\) \|\| t == "--force-uninstall" \{/.test(ru) && /if !un \|\| !sys \|\| len\(toks\) > 8 \{/.test(ru)
      && /chromiumArgRE\s*= regexp\.MustCompile\(`\^--\[a-z\]\[a-z0-9-\]\{0,40\}\(\?:=\[A-Za-z0-9\._-\]\{1,40\}\)\?\$`\)/.test(goRm)
      && /case base == "setup\.exe" && strings\.HasSuffix\(dir, `\\installer`\):/.test(ru),
    'InnoArgs / NSISArgs / ChromiumArgs and the RecognizeUninstall cases');
  const goProt = (goRm.match(/const ProtectedProgramPattern = `([^`]+)`/) ?? [])[1] ?? null;
  const tsProt = (tsCat.match(/export const PROTECTED_PROGRAM_RE = \/(.+)\/i;/) ?? [])[1] ?? null;
  const protRe = goProt ? new RegExp(goProt, 'i') : null;
  const PROTECT = ['RustDesk', 'rustdesk 1.4.3', 'RustDesk Service', 'Rem0te Agent', 'rem0te-tray', 'Reboot Remote', 'RebootRemote'];
  const NOT = ['RustDesker', 'TeamViewer', 'Remote Desktop Manager', 'Rem0teX'];
  check('remove: RustDesk and Rem0te are never removed — the same pattern on both sides, checked first on the agent, refused by the portal',
    !!goProt && goProt === tsProt && PROTECT.every((n) => protRe.test(n)) && NOT.every((n) => !protRe.test(n))
      && /var protectedProgramRE = regexp\.MustCompile\(`\(\?i\)` \+ ProtectedProgramPattern\)/.test(goRm)
      && /^\s*if ProtectedProgram\(key, pr\.DisplayName\) \{\s*return RemovalCommand\{\}, &Result\{Outcome: "refused", Reason: "protected_program",/.test(rf)
      && /if \(hint\.code === 'protected'\) throw new ConflictException\(\{ code: 'PROTECTED_PROGRAM'/.test(read('apps/api/src/software/software.service.ts'))
      && /if \(isProtectedProgram\(p\.key, p\.name\)\) return no\('protected'/.test(read('apps/api/src/software/definition.ts')),
    `agent ${goProt}; portal ${tsProt}`);
  const never = ((goRm.match(/var NeverRun = \[\]string\{([\s\S]*?)\}/) ?? [])[1] ?? '').split(',').map((x) => x.trim().replace(/"/g, '')).filter(Boolean);
  const MUST = ['cmd.exe', 'powershell.exe', 'pwsh.exe', 'wscript.exe', 'cscript.exe', 'mshta.exe', 'rundll32.exe', 'regsvr32.exe', 'msiexec.exe', 'bash.exe', 'wsl.exe'];
  check('remove: a QuietUninstallString naming an interpreter, script host or system tool is never run',
    MUST.every((n) => never.includes(n)) && /for _, n := range NeverRun \{\s*if base == n \{/.test(goRm), `NeverRun: ${never.join(', ')}`);
  const winCode = goRmWin.replace(/^\s*\/\/.*$/gm, '');
  check('remove: the Windows side starts one process from one place, msiexec from System32 only, with no shell; the recognised forms take the quiet path and its checks',
    (goRmWin.match(/exec\.Command(?:Context)?\(/g) ?? []).length === 1 && /cmd := exec\.CommandContext\(ctx, path, args\.\.\.\)/.test(goRmWin)
      && /case "quiet", "inno", "nsis", "chromium":\s*\/\/[^\n]*\n[^\n]*\n\s*if _, err := action\.ParseQuietUninstall/.test(goRmWin)
      && /func \(winPrograms\) FileHead\(path string, max int\) \(\[\]byte, error\) \{\s*if _, err := action\.ParseQuietUninstall\(`"` \+ path \+ `"`\); err != nil \{/.test(goRmWin)
      && /path, args = filepath\.Join\(d, "msiexec\.exe"\), action\.MsiArgs\(c\.ProductCode\)/.test(goRmWin) && /d, err := windows\.GetSystemDirectory\(\)/.test(goRmWin)
      && /if _, err := action\.ParseQuietUninstall\(`"` \+ c\.Exe \+ `"`\); err != nil \{/.test(goRmWin)
      && !/cmd\.exe|powershell|pwsh|ShellExecute|\/bin\/sh|"cmd"/i.test(winCode) && !/"os\/exec"|exec\.Command/.test(goRm),
    'software_remove_windows.go: one exec.CommandContext, System32 msiexec with MsiArgs, the quiet program re-checked; remove.go starts nothing');
  check('remove: succeeded only when the key is gone afterwards',
    /case present == "false":\s*r\.Outcome, r\.Detail = "succeeded"/.test(goRm) && (goRm.replace(/^\s*\/\/.*$/gm, "").match(/"succeeded"/g) ?? []).length === 1,
    'the uninstaller\'s exit code alone never makes it a success');

  // The portal: removing, and one-click install.
  const svc = read('apps/api/src/software/software.service.ts');
  const def = read('apps/api/src/software/definition.ts');
  const m = (name) => { const i = svc.indexOf(`  async ${name}(`); return i < 0 ? '' : svc.slice(i, svc.indexOf('\n  }\n', i)); };
  const pm = (name) => { const i = svc.indexOf(`  private async ${name}(`); return i < 0 ? '' : svc.slice(i, svc.indexOf('\n  }\n', i)); };
  const rm = m('removeProgram');
  check('remove: the portal names only a program its inventory of that computer lists, and plans it only through createPlan with the three parameters',
    /const p = RemoveProgramDto\.safeParse\(raw\);/.test(rm) && rm.indexOf('assertEndpointInScope') > 0 && rm.indexOf('assertEndpointInScope') < rm.indexOf('createPlan(')
      && /installedOf\(inv\?\.software\)\.find\(\(x\) => x\.key === d\.key && x\.view === d\.view && x\.name === d\.displayName\)/.test(rm)
      && /params: \{ key: d\.key, view: d\.view, displayName: d\.displayName \}/.test(rm) && /freshMethod,\s*\}\);/.test(rm)
      && /export const RemoveProgramDto = z\.object\(\{[\s\S]{0,600}?\}\)\.strict\(\);/.test(def),
    'removeProgram must scope, match the inventory and go through createPlan');
  const we = pm('wingetEntry'), qi = m('quickInstall'), rw = pm('resolveWinget');
  const iEdit = we.indexOf('if (!this.canEdit(actor, scope))'), iFr = we.indexOf("assertFresh(freshMethod, { action: 'software.catalog' });"), iW = we.search(/this\.prisma\.softwareCatalogEntry\.(create|updateMany)\(/), iAu = we.indexOf("action: 'SOFTWARE_CATALOG_");
  check('one-click: a catalog entry is written only by whoever may change the catalog, after a fresh sign-in, audited, with the hash from winget-pkgs',
    iEdit > 0 && iFr > iEdit && iW > iFr && iAu > iW && /hashSource: 'WINGET_PKGS' as const/.test(rw) && /autoSelectInstaller\(f\.manifest, arch\)/.test(rw) && /deriveDetection\(sel\.installer, v\)/.test(rw)
      && qi.indexOf('this.availability(actor, ep, SOFTWARE_INSTALL)') > 0 && qi.indexOf('assertDirectFresh(') > qi.indexOf('this.availability(') && qi.indexOf('this.wingetEntry(') > qi.indexOf('assertDirectFresh(')
      && /this\.single\(actor, endpointId, w\.entry\.id, 'install',/.test(qi),
    'quickInstall: availability, the direct-mode check, then the entry, then the ordinary one-computer install');
  // The index.
  const ix = read('apps/api/src/software/winget-index.ts');
  const ixs = read('apps/api/src/software/winget-index.service.ts');
  check('index: one fixed URL, a loopback-only test override, one bounded GET with no credentials and no redirects',
    /export const WINGET_INDEX_URL = 'https:\/\/cdn\.winget\.microsoft\.com\/cache\/source2\.msix';/.test(ix)
      && /if \(o && \/\^http:\\\/\\\/127\\\.0\\\.0\\\.1:\[0-9\]\{2,5\}\(\\\/\[A-Za-z0-9\._\/-\]\*\)\?\$\/\.test\(o\)\) return o;\s*return WINGET_INDEX_URL;/.test(ix)
      && (ixs.match(/\bfetch\(/g) ?? []).length === 1 && /fetch\(indexUrl\(\), \{ method: 'GET', redirect: 'error', credentials: 'omit',[^}]*\}, signal: AbortSignal\.timeout\(INDEX_FETCH_TIMEOUT_MS\) \}\)/.test(ixs)
      && /if \(n > INDEX_MAX_MSIX_BYTES\)/.test(ixs) && /export const INDEX_MAX_MSIX_BYTES = 32 \* 1024 \* 1024;/.test(ix) && /inflateRawSync\(raw, \{ maxOutputLength: maxOut \}\)/.test(ix),
    'WingetIndexService.fetchMsix must stay one bounded GET of WINGET_INDEX_URL');
  check('index: read by the sqlite3 tool, read-only, an argument array, only the two fixed queries',
    /execFileAsync\('sqlite3', \['-readonly', '-json', `file:\$\{file\}\?mode=ro`, sql\]/.test(ixs) && !/\bexec\(|spawn\(|shell: true|execSync|spawnSync/.test(ixs)
      && [...ixs.matchAll(/this\.query\(file, ([A-Z_]+)\)/g)].map((x) => x[1]).sort().join() === 'INDEX_ROWS_SQL,INDEX_SCHEMA_SQL' && (ixs.match(/this\.query\(/g) ?? []).length === 2,
    'only INDEX_SCHEMA_SQL and INDEX_ROWS_SQL, through execFile');
  check('index: an id that could not be a plan\'s packageId is never stored',
    /!PACKAGE_ID_RE\.test\(id\)/.test(ix) && /CONSTRAINT "WingetPackage_id_form" CHECK/.test(read('apps/api/prisma/migrations/0066_winget_index/migration.sql')),
    'normalizeIndexRows and 0066\'s CHECK');
  const importers = walk('apps/api/src').filter((f) => /from '\.\/winget-index(\.service)?'|from '\.\.\/software\/winget-index/.test(read(f)));
  check('index: nothing outside the software module imports it, so nothing a computer sends reaches it',
    importers.every((f) => f.startsWith('apps/api/src/software/')) && importers.length >= 2, `importers: ${importers.join(', ')}`);
  check('index: WINGET_INDEX_SWEEP=off is exact and exported by run-e2e.sh',
    /export const indexSweepEnabled = \(env: Record<string, string \| undefined> = process\.env\) => env\.WINGET_INDEX_SWEEP !== 'off';/.test(ix)
      && /^export WINGET_INDEX_SWEEP=off$/m.test(read('scripts/run-e2e.sh')) && /if \(!indexSweepEnabled\(\)\) return;/.test(ixs),
    'a test stack must never fetch the public index');
  check('inventory: an uninstall key is kept only in the charset the remove action accepts, with its view',
    /if \(typeof o\.key === 'string' && PROGRAM_KEY_RE\.test\(o\.key\) && \(o\.view === '64' \|\| o\.view === '32'\)\) \{/.test(read('apps/api/src/monitoring/engine.ts'))
      && /key: typeof p\.key === 'string' && PROGRAM_KEY_RE\.test\(p\.key\) \? p\.key : null/.test(def),
    'sanitizeSoftware and installedOf');
  // 0.42: the collector reports a removal kind; it is a hint, kept only from
  // the closed list, and the collector itself only reads.
  const ws = read('apps/api/src/public/windows-script.ts');
  const kfn = ws.slice(ws.indexOf('function Split-Rem0teUninstall'), ws.indexOf('function Get-Rem0teInventory'));
  check('inventory: the removal kind is a closed hint — kept only from REMOVAL_KINDS, collected by functions that only read',
    /export const REMOVAL_KINDS = \['msi', 'quiet', 'inno', 'nsis', 'chromium', 'office', 'driver', 'none'\] as const;/.test(tsCat)
      && /export const REMOVABLE_KINDS: ReadonlySet<RemovalKind> = new Set\(\['msi', 'quiet', 'inno', 'nsis', 'chromium'\]\);/.test(tsCat)
      && /if \(typeof o\.kind === 'string' && \(REMOVAL_KINDS as readonly string\[\]\)\.includes\(o\.kind\)\) item\.kind/.test(read('apps/api/src/monitoring/engine.ts'))
      && kfn.length > 500 && !/Start-Process|Invoke-Expression|Invoke-Item|Remove-Item|Set-ItemProperty|New-ItemProperty|\.Invoke\(|\biex\b/i.test(kfn)
      && /\[IO\.File\]::OpenRead\(\\\$path\)/.test(kfn) && (kfn.match(/OpenRead|Open\(|WriteAll|Out-File|Set-Content/g) ?? []).length === 1,
    'REMOVAL_KINDS, sanitizeSoftware and the collector functions in windows-script.ts');
}

// 60. Browsing the winget index and building catalogs by selection (0.43).
//     The browse is a read (GET, View computers) whose page size is capped
//     at 100 and whose parameters are checked before Prisma sees them. The
//     bulk add is one Edit-computers route, rate-limited, at most 25
//     packages, needing a fresh sign-in once before any manifest is read or
//     anything written; each package goes through resolveWinget and
//     wingetEntry (the one-click path, audited per entry, via 'bulk'); and
//     another business's catalog looks like a missing one.
//     0.49 (§ 62, at the owner's request): every "fresh authentication" here
//     is a step-up that names its catalog key (software.catalog); a Platform Admin
//     may turn a key off under Settings → Confirm it is you. Until 0.49 it
//     could not be configured.
{
  const svc = read('apps/api/src/software/software.service.ts');
  const ctl = read('apps/api/src/software/software.controller.ts');
  const ix = read('apps/api/src/software/winget-index.ts');
  const def = read('apps/api/src/software/definition.ts');
  const m = (name) => { const i = svc.indexOf(`  async ${name}(`); return i < 0 ? '' : svc.slice(i, svc.indexOf('\n  }\n', i)); };
  const pm = (name) => { const i = svc.indexOf(`  private async ${name}(`); return i < 0 ? '' : svc.slice(i, svc.indexOf('\n  }\n', i)); };
  check('browse: the index page is a read for whoever reads the catalog, at most 100 rows, its parameters checked first',
    /@Get\('software\/winget\/packages'\)\s*@RequireCapability\(CAP\.COMPUTERS_VIEW\)/.test(ctl) && /export const BROWSE_MAX_PAGE_SIZE = 100;/.test(ix)
      && /pageSize: Math\.min\(size, BROWSE_MAX_PAGE_SIZE\)/.test(ix) && /const p = parseBrowse\(raw\);\s*if \(!p\.ok\) throw new BadRequestException/.test(pm('wingetBrowse'))
      && /if \(!actor\.isPlatformAdmin && !this\.acl\.can\(actor, CAP\.COMPUTERS_VIEW\)\) throw new ForbiddenException[^\n]*\n\s*if \(browse && isBrowse\(browse\)\) return this\.wingetBrowse/.test(m('wingetSearch')),
    'wingetSearch checks the capability before it hands a browse on; parseBrowse caps pageSize');
  const bulk = m('addManyFromWinget'), one = pm('bulkOne');
  const iCap = bulk.indexOf('BULK_MAX_PACKAGES'), iEdit = bulk.indexOf('if (!this.canEdit(actor,'), iFr = bulk.indexOf("assertFresh(freshMethod, { action: 'software.catalog' });"), iWork = bulk.indexOf('this.bulkOne(');
  check('bulk: at most 25 packages, Edit computers and rate-limited, a fresh sign-in once before any package is read or written',
    /export const BULK_MAX_PACKAGES = 25;/.test(def) && /packages: z\.array\([\s\S]{0,200}\)\.min\(1\)\.max\(BULK_MAX_PACKAGES\)/.test(def)
      && /@Post\('software\/winget\/catalog\/bulk'\)\s*@HttpCode\(HttpStatus\.OK\)\s*@RequireCapability\(CAP\.COMPUTERS_EDIT\)\s*@RateLimit\(3\)/.test(ctl)
      && iCap > 0 && iEdit > iCap && iFr > iEdit && iWork > iFr && /if \(!actor\.isPlatformAdmin\) throw new ForbiddenException\(\{ code: 'NOT_ALLOWED', message: 'Only a Platform Admin adds to the global catalog\.' \}\);/.test(bulk),
    'addManyFromWinget: the cap, then who may change the catalog, then assertFresh, then the packages');
  check('bulk: each package goes through the one-click path (resolveWinget, then wingetEntry, audited via bulk), and writes nothing itself',
    /const r = await this\.resolveWinget\(pkg\.packageId, pkg\.version, arch\);\s*const w = await this\.wingetEntry\(actor, customerId, r, freshMethod, 'bulk'\);/.test(one)
      && !/this\.prisma\.softwareCatalogEntry\.(create|update|updateMany|upsert|delete)/.test(bulk + one) && !/this\.audit\.log/.test(bulk + one),
    'bulkOne must reuse resolveWinget and wingetEntry');
  check('bulk and browse: another business\'s catalog looks like a missing one',
    /if \(!actor\.isPlatformAdmin && businessId !== actor\.businessId\) throw new NotFoundException\('Business not found'\);/.test(pm('catalogBusiness'))
      && bulk.indexOf('this.catalogBusiness(actor, d.businessId)') > 0 && pm('wingetBrowse').indexOf('this.catalogBusiness(actor, raw.businessId)') > 0,
    'catalogBusiness must 404 a business that is not the caller\'s own');
}

// 61. Service control and ending a process (0.45): windows.service.control@1
//     and windows.process.stop@1. Closed parameters with the same charsets on
//     the agent and the portal; the same protected lists, refused on both
//     sides; the agent reads the service or process itself first (a driver,
//     a changed display name, a reused process id are refused), runs its
//     Precheck after the signed pause and journals before it changes
//     anything; the Windows side uses only the service control manager and
//     OpenProcess / GetProcessTimes / TerminateProcess — no sc.exe, taskkill
//     or PowerShell — and the creation time is checked on the very handle the
//     process is ended through. Editing a service is its startup type only:
//     nothing anywhere carries a binary path, account, password, recovery
//     action or dependency.
{
  const fn = (src, head, n = 2400) => { const i = src.indexOf(head); return i < 0 ? '' : src.slice(i, i + n); };
  const gsc = read('tools/windows-installer/internal/action/svcctl.go');
  const gps = read('tools/windows-installer/internal/action/procstop.go');
  const gmt = read('tools/windows-installer/internal/action/maintenance.go');
  const gwin = read('tools/windows-installer/svcproc_windows.go');
  const goCat = read('tools/windows-installer/internal/action/catalog.go');
  const tsCat = read('apps/api/src/actions/catalog.ts');
  const dsv = read('apps/api/src/device-control/device-control.service.ts');
  const dct = read('apps/api/src/device-control/device-control.controller.ts');
  const dui = read('apps/web/components/endpoints/workspace/device-control.tsx');
  const stripGo = (s) => s.replace(/^\s*\/\/.*$/gm, '').replace(/\/\/[^\n"`]*$/gm, '');
  const goRe = (src, name) => (src.match(new RegExp(`${name}\\s*= regexp\\.MustCompile\\(\`([^\`]+)\`\\)`)) ?? [])[1] ?? null;
  const tsRe = (name) => (tsCat.match(new RegExp(`export const ${name} = /(.+)/;`)) ?? [])[1] ?? null;
  const pairs = [['ServiceNameRE', gmt, 'SERVICE_NAME_RE'], ['ServiceDisplayNameRE', gsc, 'SERVICE_DISPLAY_NAME_RE'], ['ProcessNameRE', gps, 'PROCESS_NAME_RE'], ['ProcessStartedRE', gps, 'PROCESS_STARTED_RE']]
    .map(([g, src, t]) => [g, goRe(src, g), tsRe(t)]);
  check('service/process: the four charsets are the same regular expression on the agent and the portal',
    pairs.every(([, a, b]) => !!a && a === b), pairs.map(([n, a, b]) => `${n}: agent ${a} portal ${b}`).join('; '));
  const hostileSvc = ['..', 'a\\b', 'a/b', '-x', 'a b', 'a"b', 'a;b', 'a|b', 'a%x%', 'a$b', 'a.exe', 'a\nb', 'a'.repeat(65), ''];
  const hostileProc = ['C:\\x', 'a/b', '-x', ' x', 'a"b', 'a;b', 'a|b', 'a&b', 'a%x', 'a`b', 'a$b', 'a\nb', 'a'.repeat(65), ''];
  const svcRe = pairs[0][1] ? new RegExp(pairs[0][1]) : null, procRe = pairs[2][1] ? new RegExp(pairs[2][1]) : null, dispRe = pairs[1][1] ? new RegExp(pairs[1][1]) : null;
  const let1 = svcRe ? hostileSvc.filter((x) => svcRe.test(x)) : ['(regex not found)'];
  const let2 = procRe ? hostileProc.filter((x) => procRe.test(x)) : ['(regex not found)'];
  const let3 = dispRe ? ['a"b', 'a<b', 'a>b', 'a\\b', 'a\nb', 'a\x00b', 'x'.repeat(257)].filter((x) => dispRe.test(x)) : ['(regex not found)'];
  check('service/process: a service or process name can never be a path, an option or carry a shell character; a display name no quote, bracket, backslash or control character',
    let1.length === 0 && let2.length === 0 && let3.length === 0, `accepted: ${[...let1, ...let2, ...let3].map((x) => JSON.stringify(x)).join(', ')}`);

  const goList = (src, name) => ((src.match(new RegExp(`(?:var )?\\b${name}\\s*= \\[\\]string\\{([\\s\\S]*?)\\n?\\}`)) ?? [])[1] ?? '').replace(/\/\/.*$/gm, '').split(',').map((x) => x.trim().replace(/"/g, '')).filter(Boolean);
  const tsList = (name) => ((tsCat.match(new RegExp(`export const ${name} = \\[([\\s\\S]*?)\\] as const;`)) ?? [])[1] ?? '').replace(/\/\/.*$/gm, '').split(',').map((x) => x.trim().replace(/'/g, '')).filter(Boolean);
  check('service: the operations and start types are the same closed lists on both sides',
    goList(gsc, 'ServiceOps').join() === 'start,stop,restart,set_start_type' && tsList('SERVICE_OPS').join() === 'start,stop,restart,set_start_type'
      && goList(gsc, 'ServiceStartTypes').join() === 'automatic,automatic_delayed,manual,disabled' && tsList('SERVICE_START_TYPES').join() === 'automatic,automatic_delayed,manual,disabled',
    `agent ${goList(gsc, 'ServiceOps')} / ${goList(gsc, 'ServiceStartTypes')}; portal ${tsList('SERVICE_OPS')} / ${tsList('SERVICE_START_TYPES')}`);
  check('service/process: the parameters are exactly the closed keys, on both sides',
    /if !exactKeys\(p, "service", "displayName", "op", "startType"\) \{/.test(gsc) && /\} else if !exactKeys\(p, "service", "displayName", "op"\) \{/.test(gsc)
      && /if s\.Service, ok = strField\(p, "service"\); !ok \|\| !ServiceNameRE\.MatchString\(s\.Service\) \{/.test(gsc)
      && /if !exactKeys\(p, "pid", "name", "startedAt"\) && !exactKeys\(p, "pid", "name", "startedAt", "tree"\) \{/.test(gps)
      && /if !ok \|\| n != math\.Trunc\(n\) \|\| n < 1 \|\| n > math\.MaxUint32 \{/.test(gps)
      && /export const ServiceControlParams = z\.union\(\[\s*z\.object\(\{ service: z\.string\(\)\.regex\(SERVICE_NAME_RE\), displayName: z\.string\(\)\.refine\(serviceDisplayNameOk\), op: z\.enum\(\['start', 'stop', 'restart'\]\) \}\)\.strict\(\),\s*z\.object\(\{ service: z\.string\(\)\.regex\(SERVICE_NAME_RE\), displayName: z\.string\(\)\.refine\(serviceDisplayNameOk\), op: z\.literal\('set_start_type'\), startType: z\.enum\(SERVICE_START_TYPES\) \}\)\.strict\(\),\s*\]\);/.test(tsCat)
      && /export const ProcessStopParams = z\.object\(\{\s*pid: z\.number\(\)\.int\(\)\.min\(1\)\.max\(4_294_967_295\),\s*name: z\.string\(\)\.regex\(PROCESS_NAME_RE\)[^\n]*\n\s*startedAt: z\.string\(\)\.regex\(PROCESS_STARTED_RE\)[^\n]*\n\s*tree: z\.boolean\(\)\.optional\(\),\s*\}\)\.strict\(\);/.test(tsCat),
    'ServiceControlParams / ProcessStopParams (Go and zod)');

  const MUST_SVC = ['WinDefend', 'Sense', 'SecurityHealthService', 'wscsvc', 'mpssvc', 'BFE', 'EventLog', 'SamSs', 'KeyIso', 'VaultSvc', 'CryptSvc', 'gpsvc', 'RpcSs', 'RpcEptMapper', 'DcomLaunch', 'LSM', 'PlugPlay', 'Power', 'ProfSvc', 'Winmgmt', 'TrustedInstaller', 'Schedule', 'Dhcp', 'Dnscache'];
  const MUST_PROC = ['System', 'Idle', 'smss', 'csrss', 'wininit', 'winlogon', 'services', 'lsass', 'lsaiso', 'svchost', 'fontdrvhost', 'dwm', 'MsMpEng', 'rem0te-agent', 'rem0te-tray', 'rustdesk'];
  const gS = goList(gsc, 'ProtectedServices'), tS = tsList('PROTECTED_SERVICES'), gP = goList(gps, 'ProtectedProcesses'), tP = tsList('PROTECTED_PROCESSES');
  check('service/process: the protected lists are the same on both sides, and hold the security, core and reachability services and processes',
    gS.length > 0 && gS.join() === tS.join() && MUST_SVC.every((n) => gS.includes(n))
      && goList(gsc, 'KeepRunningServices').join() === 'RustDesk' && tsList('KEEP_RUNNING_SERVICES').join() === 'RustDesk'
      && goList(gsc, 'NoDisableServices').join() === tsList('NO_DISABLE_SERVICES').join() && goList(gsc, 'NoDisableServices').includes('wuauserv')
      && /const OwnServicePrefix = "Rem0te"/.test(gsc) && /export const OWN_SERVICE_PREFIX = 'Rem0te';/.test(tsCat)
      && gP.length > 0 && gP.join() === tP.join() && MUST_PROC.every((n) => gP.includes(n))
      && /const MaxTreeProcesses = 64/.test(gps) && /export const MAX_TREE_PROCESSES = 64;/.test(tsCat),
    `services agent ${gS.length} / portal ${tS.length}; processes agent ${gP.join(', ')} / portal ${tP.join(', ')}`);
  check('service/process: the lists are compared case-insensitively, RustDesk is never stopped or set to Manual/Disabled and the update services never disabled, on both sides',
    /strings\.EqualFold\(x, s\)/.test(fn(gsc, 'func inFold(', 200)) && /const inFold = \(list: readonly string\[\], s: string\) => list\.some\(\(x\) => x\.toLowerCase\(\) === s\.toLowerCase\(\)\);/.test(tsCat)
      && /case inFold\(KeepRunningServices, name\) && \(op == "stop" \|\| \(op == "set_start_type" && startType != "automatic" && startType != "automatic_delayed"\)\):/.test(gsc)
      && /if \(inFold\(KEEP_RUNNING_SERVICES, name\) && \(op === 'stop' \|\| \(op === 'set_start_type' && startType !== 'automatic' && startType !== 'automatic_delayed'\)\)\)/.test(tsCat)
      && /case inFold\(NoDisableServices, name\) && op == "set_start_type" && startType == "disabled":/.test(gsc) && /if \(inFold\(NO_DISABLE_SERVICES, name\) && op === 'set_start_type' && startType === 'disabled'\)/.test(tsCat),
    'ServiceRefusal / serviceRefusal');

  // Both sides refuse: the portal before a plan exists, the agent before anything changes.
  const cs = fn(dsv, 'async controlService(', 3000), sp = fn(dsv, 'async stopProcess(', 3000);
  check('service/process: the portal refuses a protected row and anything its own latest snapshot does not list, before createPlan, and passes the fresh sign-in on',
    cs.indexOf('serviceRefusal(d.service, d.op, d.startType ?? null)') > 0 && cs.indexOf('serviceRefusal(') < cs.indexOf('createPlan(')
      && /rows\.find\(\(r\) => r\?\.name === d\.service && r\?\.displayName === d\.displayName\)/.test(cs) && cs.indexOf("'SERVICE_NOT_IN_SNAPSHOT'") < cs.indexOf('createPlan(')
      && sp.indexOf('processRefusal(d.name, d.pid)') > 0 && sp.indexOf('processRefusal(') < sp.indexOf('createPlan(')
      && /rows\.find\(\(r\) => r\?\.pid === d\.pid && r\?\.name === d\.name && r\?\.startedAt === d\.startedAt\)/.test(sp) && sp.indexOf("'PROCESS_NOT_IN_SNAPSHOT'") < sp.indexOf('createPlan(')
      && (dsv.match(/this\.actions\.createPlan\(actor, \{/g) ?? []).length === 2
      && /action: SERVICE_CONTROL, endpointIds: \[endpointId\], params,[\s\S]{0,200}freshMethod,\s*\}\);/.test(cs) && /action: PROCESS_STOP, endpointIds: \[endpointId\], params,[\s\S]{0,200}freshMethod,\s*\}\);/.test(sp)
      && /const ep = await this\.endpoint\(actor, endpointId\);/.test(cs) && /await this\.acl\.assertEndpointInScope\(actor, endpointId\);/.test(fn(dsv, 'private async endpoint(', 300))
      && (dct.match(/this\.fresh\(req\)/g) ?? []).length === 2 && !/actionJob\.(create|update|upsert)|actionTarget\.(create|update|upsert)|signer\.submit|\/internal\/v1\/plans/.test(dsv),
    'DeviceControlService.controlService / stopProcess');
  const routes = [...dct.matchAll(/@(Get|Post|Put|Patch|Delete)\('([^']*)'\)\s*(?:@HttpCode\([^)]*\)\s*)?@RequireCapability\(CAP\.([A-Z_]+)\)/g)].map((m) => `${m[1]} ${m[2]} ${m[3]}`);
  check('service/process: three routes, each naming its capability; none approves, signs or edits a service beyond its startup type',
    routes.join('|') === 'Get endpoints/:id/device-control COMPUTERS_VIEW|Post endpoints/:id/services/control COMPUTERS_VIEW|Post endpoints/:id/processes/stop COMPUTERS_VIEW'
      && (dct.match(/@(?:Get|Post|Put|Patch|Delete)\(/g) ?? []).length === 3,
    `routes: ${routes.join(', ')}`);
  const rs = fn(gsc, 'func readService(', 3000), mp = fn(gps, 'func matchProcess(', 4000);
  check('service: the agent refuses a protected service (by the plan\'s name and the service manager\'s), a driver, a boot or system start type and a changed display name before anything changes',
    rs.indexOf('ServiceRefusal(s.Service, s.Op, s.StartType)') > 0 && rs.indexOf('ServiceRefusal(s.Service') < rs.indexOf('o.Services.Service(s.Service)')
      && /if info\.Driver \{[\s\S]{0,200}Reason: "not_a_service"/.test(rs) && /if why := ServiceRefusal\(info\.Name, s\.Op, s\.StartType\); why != "" \{/.test(rs)
      && /if strings\.TrimSpace\(info\.DisplayName\) != s\.DisplayName \{[\s\S]{0,120}Reason: "service_changed"/.test(rs) && /if info\.StartType == "boot" \|\| info\.StartType == "system" \{/.test(rs)
      && /driver := c\.ServiceType&\(windows\.SERVICE_KERNEL_DRIVER\|windows\.SERVICE_FILE_SYSTEM_DRIVER/.test(gwin),
    'readService (svcctl.go) and winServices.Service');
  check('process: the agent refuses a protected process (the root and every process of its tree), and a PID whose name or creation time is not the plan\'s',
    mp.indexOf('ProcessRefusal(s.Name, s.PID)') > 0 && mp.indexOf('ProcessRefusal(s.Name, s.PID)') < mp.indexOf('o.Processes.Processes()')
      && /if !strings\.EqualFold\(ImageBase\(root\.Name\), s\.Name\) \|\| !SameCreation\(root\.Created, s\.StartedAt\) \{[\s\S]{0,200}Reason: "process_changed"/.test(mp)
      && /if why := ProcessRefusal\(root\.Name, root\.PID\); why != "" \{/.test(mp) && /if why := ProcessRefusal\(c\.Name, c\.PID\); why != "" \{/.test(mp)
      && /c\.ParentPID != parent\.PID \|\| c\.Created\.IsZero\(\) \|\| c\.Created\.Before\(parent\.Created\)/.test(mp)
      && /func SameCreation\(read, want time\.Time\) bool \{\s*if read\.IsZero\(\) \{\s*return false\s*\}\s*return read\.UTC\(\)\.Truncate\(time\.Millisecond\)\.Equal\(want\.UTC\(\)\)\s*\}/.test(gps),
    'matchProcess / SameCreation (procstop.go)');

  const svcEntry = goCat.split(/\n\t\{\n/).find((e) => /ID: "windows\.service\.control"/.test(e)) ?? '';
  const procEntry = goCat.split(/\n\t\{\n/).find((e) => /ID: "windows\.process\.stop"/.test(e)) ?? '';
  const tsSvc = (tsCat.match(/export const SERVICE_CONTROL: CatalogAction = \{([\s\S]*?)\n\};/) ?? [])[1] ?? '';
  const tsProc = (tsCat.match(/export const PROCESS_STOP: CatalogAction = \{([\s\S]*?)\n\};/) ?? [])[1] ?? '';
  check('service/process: high impact on any computer, one computer per plan, a Precheck, never from the Actions tab, never offered to ClientSt0r, and said to be unproven on real Windows',
    [svcEntry, procEntry].every((e) => /MaxTargets: 1,/.test(e) && /Risk:\s+func\(int, int\) string \{ return "high" \},/.test(e))
      && /Precheck:\s+servicePrecheck,/.test(svcEntry) && /Precheck:\s+processPrecheck,/.test(procEntry)
      && [tsSvc, tsProc].every((e) => /risk: \(\) => 'high',/.test(e) && /maxTargets: 1,/.test(e) && /direct: false,/.test(e) && /integration: false,/.test(e) && /SERVICE_PROCESS_UNPROVEN,/.test(e))
      && /params: ServiceControlParams,/.test(tsSvc) && /params: ProcessStopParams,/.test(tsProc)
      && /export const SERVICE_PROCESS_UNPROVEN = '[^']*not yet run on a real Windows computer\.';/.test(tsCat) && /unproven: SERVICE_PROCESS_UNPROVEN,/.test(dsv) && /data-testid="control-unproven"/.test(dui),
    'catalog.go entries and SERVICE_CONTROL / PROCESS_STOP');
  check('service/process: the Precheck runs the reads (and the RustDesk restart\'s session check); every change is journaled as a step first',
    /if o\.Services == nil \{[\s\S]{0,400}if _, r := readService\(o, s, obs\); r != nil \{\s*return r\s*\}\s*if s\.Op == "restart" && inFold\(KeepRunningServices, s\.Service\) \{\s*return sessionCheck\("the RustDesk restart"\)\(p, o\)/.test(fn(gsc, 'func servicePrecheck(', 800))
      && /if o\.Processes == nil \{[\s\S]{0,400}if _, _, r := matchProcess\(o, s, obs\); r != nil \{/.test(fn(gps, 'func processPrecheck(', 800))
      && (() => { const b = fn(gsc, 'func controlService(', 5000); const calls = [...b.matchAll(/o\.Services\.(Start|Stop|SetStartType)\(/g)].map((m) => m.index); return calls.length === 5 && calls.every((i, k) => b.slice(k ? calls[k - 1] : 0, i).includes('journalStep(o, p, ')); })()
      && (() => { const b = fn(gps, 'func stopProcess(', 4000); const iM = b.indexOf('matchProcess(o, s, r.Observed)'), iJ = b.indexOf('journalStep(o, p, "ending")'), iT = b.indexOf('o.Processes.Terminate('); return iM > 0 && iJ > iM && iT > iJ; })(),
    'servicePrecheck / processPrecheck / controlService / stopProcess');

  // The Windows side: the service control manager and the process API, nothing else.
  const w = stripGo(gwin);
  check('service/process: the Windows side runs no process — no sc.exe, taskkill, PowerShell or shell — and the action package neither',
    !/"os\/exec"|exec\.Command|ShellExecute|CreateProcess|StartProcess|syscall\.Exec/.test(w) && !/sc\.exe|taskkill|powershell|pwsh|cmd\.exe|wmic|net\.exe/i.test(w)
      && !/"os\/exec"|exec\.Command|taskkill|sc\.exe|powershell/i.test(stripGo(gsc) + stripGo(gps)),
    'svcproc_windows.go, svcctl.go, procstop.go');
  const csc = [...w.matchAll(/windows\.ChangeServiceConfig\(([^)]*)\)/g)].map((m) => m[1].split(',').map((x) => x.trim()));
  const csc2 = [...w.matchAll(/windows\.ChangeServiceConfig2\(([^)]*\)*)\)/g)].map((m) => m[1]);
  check('service: the one configuration write changes the startup type only — SERVICE_NO_CHANGE and nil for everything else — and never UpdateConfig, recovery actions, create or delete',
    csc.length === 1 && csc[0].length === 11 && csc[0][1] === 'windows.SERVICE_NO_CHANGE' && csc[0][2] === 't' && csc[0][3] === 'windows.SERVICE_NO_CHANGE' && csc[0].slice(4).every((x) => x === 'nil')
      && csc2.length === 1 && /^s\.Handle, windows\.SERVICE_CONFIG_DELAYED_AUTO_START_INFO, /.test(csc2[0])
      && !/\bUpdateConfig\b|SetRecoveryActions|RecoveryActions|ResetRecovery|CreateService|\.Delete\(\)|SERVICE_CONFIG_FAILURE_ACTIONS|BinaryPathName|ServiceStartName|Password|Dependencies/.test(w)
      && (w.match(/\.Control\(svc\.Stop\)/g) ?? []).length === 1 && !/\.Control\(svc\.(Pause|Continue|Interrogate|Shutdown)/.test(w),
    `ChangeServiceConfig(${(csc[0] ?? []).join(', ')}); ChangeServiceConfig2(${csc2.join(' | ')})`);
  const term = fn(w, 'func (winProcesses) Terminate(', 2000);
  check('process: TerminateProcess is called once, on a handle whose creation time was checked first; nothing else ends a process',
    (w.match(/windows\.TerminateProcess\(/g) ?? []).length === 1 && term.indexOf('creationTime(h)') > 0 && term.indexOf('action.SameCreation(') > term.indexOf('creationTime(h)')
      && term.indexOf('windows.TerminateProcess(h, 1)') > term.indexOf('action.SameCreation(') && /windows\.PROCESS_TERMINATE\|windows\.PROCESS_QUERY_LIMITED_INFORMATION\|windows\.SYNCHRONIZE/.test(term)
      && !/NtTerminateProcess|DebugActiveProcess|GenerateConsoleCtrlEvent|PostMessage|EndTask|TerminateThread|NtSuspendProcess/.test(w + stripGo(gps)),
    'winProcesses.Terminate');
  // Nothing anywhere carries what would make a service run something else.
  const NOEDIT = /binaryPath|BinaryPathName|ServiceStartName|startName|password|recoveryAction|failureAction|dependencies|dependsOn|imagePath|\baccount\s*:/i;
  const tsNoComments = (s) => s.replace(/\/\/.*$|\/\*[\s\S]*?\*\//gm, '');
  const svcSection = tsNoComments(tsCat.slice(tsCat.indexOf('// ── Service control and ending a process (0.45)'), tsCat.indexOf('export const CATALOG: CatalogAction[]')));
  const svcSectionParams = svcSection.replace(/^ {2}(description|warnings|verification|doesNotProve|acknowledge|indirectVia):[\s\S]*?\n(?= {2}[a-zA-Z]+:)/gm, '').replace(/'[^'\n]*'/g, "''");
  const dtoPart = tsNoComments(dsv.slice(dsv.indexOf('export const ServiceControlDto'), dsv.indexOf('type Ep =')));
  const uiSend = (dui.match(/export const serviceControl = [\s\S]*?\n {2}api\.post\([^)]*\);/) ?? [''])[0];
  check('service: no binary path, account, password, recovery action or dependency in any parameter, DTO, request or agent structure',
    !NOEDIT.test(svcSectionParams) && !NOEDIT.test(dtoPart) && !NOEDIT.test(uiSend) && uiSend.length > 0
      && !/BinaryPathName|ServiceStartName|Password|Dependencies|Recovery/.test((gsc.match(/type ServiceInfo struct \{[\s\S]*?\n\}/) ?? [''])[0] + (gsc.match(/type ServiceSpec struct\{[^}]*\}/) ?? [''])[0])
      && !/SetStartType\([^)]*(path|account|password)/i.test(stripGo(gsc)) && /Name: s\.Name, DisplayName: c\.DisplayName, State: svcState\(st\.State\), StartType: startTypeName\(c\), Driver: driver/.test(gwin),
    'the 0.45 catalog section, ServiceControlDto, the web request, ServiceInfo/ServiceSpec');
}

// 62. Confirm it is you, per function (0.49; replaces 0.47's seven everyday
//     actions and 0.20's stepUpActions). Reversed at the owner's request: the
//     owner runs the portal mostly alone and asked for the step-up after
//     sign-in to be optional per function ("authenticator challenge should be
//     optional for features once you login"), as §41 was reversed in 0.48.
//     Before 0.49, about twenty invariants said a step-up was "not
//     configurable" (§16, §17, §34, §42, §43, §53, §57, §59, §60 among them);
//     each now requires its site to name its catalog key instead.
//
//     One catalog, confirm-catalog.ts, plain data. Every step-up site in the
//     API names exactly one key: assertFresh's required `action`,
//     StepUpService.assert's action, and client updates' FreshAuthNeeded.
//     The policy is ConfirmPolicy rows (0071). Only a configurable key whose
//     row is exactly 'off' skips; an unknown key, an always-ask key or a
//     policy not yet read asks. A phishing-resistant check always asks. The
//     always-ask set (own passkeys, a protected-device exception's passkey,
//     turning a confirmation off) is not in the catalog and cannot be set.
//     Changing the policy is a Platform Admin's; relaxing anything confirms
//     first with the always-ask `confirm.relax`, tightening never does, and
//     every change is audited. The web holds no copy of the catalog.
//
//     0.64 reverses 0.49's "every key defaults to ask" at the owner's request
//     ("2fa is still enabled on all features, turn off by default, just on
//     login"), as §41, §62 itself, §67, §75 and §76 were. Every catalog key
//     now defaults to `off`, and a key with no row takes its catalog default
//     (`DEFAULTS`, built from CONFIRM_CATALOG, never a literal). Unchanged and
//     still checked: an unread policy asks, an unknown or always-ask key asks,
//     a phishing-resistant check asks, a row saying anything but exactly
//     'off' asks, the always-ask set is the same three keys. The suites that
//     prove a step-up write an `ask` row per key themselves
//     (apps/api/scripts/lib/confirm-asks.mjs, scratch databases only), and
//     nothing in the API or the seed writes one.
{
  const SRC = 'apps/api/src';
  const cat = read(`${SRC}/security-controls/confirm-catalog.ts`);
  const rev = read(`${SRC}/security-controls/review.ts`);
  const svc = read(`${SRC}/security-controls/confirm-policy.service.ts`);
  const ctl = read(`${SRC}/security-controls/confirm-policy.controller.ts`);
  const sus = read(`${SRC}/auth/step-up.service.ts`);
  const mig = read('apps/api/prisma/migrations/0071_confirm_policy/migration.sql');
  const catBody = (cat.match(/export const CONFIRM_CATALOG = \[([\s\S]*?)\] as const satisfies readonly ConfirmFunction\[\];/) ?? [])[1] ?? '';
  const KEYS = [...catBody.matchAll(/\{ key: '([a-z.]+)', group: '([^']+)'/g)].map((m) => m[1]);
  const alwaysBody = (cat.match(/export const ALWAYS_ASK = \[([\s\S]*?)\] as const;/) ?? [])[1] ?? '';
  const ALWAYS = [...alwaysBody.matchAll(/\{ key: '([a-z.]+)'/g)].map((m) => m[1]);
  const isKey = (k) => KEYS.includes(k) || ALWAYS.includes(k);

  // 0.77 (§87): exactly one key defaults to ask, terminal.open, at the
  // owner's request for the background terminal (a SYSTEM shell). It stays
  // configurable to off through confirm.relax like any other key.
  const ASK_DEFAULTS = [...catBody.matchAll(/\{ key: '([a-z.]+)'[^}]*?default: 'ask'/g)].map((m) => m[1]);
  check('confirm: the catalog is plain data (no imports) with unique keys, each defaulting to off (0.64, the owner\'s "just on login") except terminal.open, ask (0.77)',
    !/^import /m.test(cat) && KEYS.length >= 30 && new Set(KEYS).size === KEYS.length
      && (catBody.match(/default: 'off'/g) ?? []).length === KEYS.length - 1 && (catBody.match(/default: 'ask'/g) ?? []).length === 1
      && JSON.stringify(ASK_DEFAULTS) === JSON.stringify(['terminal.open']),
    `confirm-catalog.ts: ${KEYS.length} keys; ask by default: ${JSON.stringify(ASK_DEFAULTS)}`);
  check('confirm: the always-ask set is exactly passkey.manage, fresh.auth.passkey, confirm.relax, and none is in the catalog',
    JSON.stringify(ALWAYS) === JSON.stringify(['passkey.manage', 'fresh.auth.passkey', 'confirm.relax']) && ALWAYS.every((k) => !KEYS.includes(k)),
    `ALWAYS_ASK is ${JSON.stringify(ALWAYS)}`);

  // Every step-up site names a key.
  const files = walk(SRC).filter((f) => !f.endsWith('security-controls/review.ts'));
  const bad = [];
  let sites = 0;
  for (const f of files) {
    const src = read(f);
    for (const m of src.matchAll(/assertFresh\(/g)) {
      if (/function assertFresh/.test(src.slice(Math.max(0, m.index - 20), m.index))) continue;
      if (/import \{[^}]*$/.test(src.slice(Math.max(0, m.index - 200), m.index))) continue;
      sites++;
      const call = src.slice(m.index, src.indexOf(');', m.index) + 2);
      const lit = call.match(/action: '([a-z.]+)'/);
      if (lit) { if (!isKey(lit[1])) bad.push(`${f}: ${lit[1]}`); continue; }
      if (/\{ action \}|\{ action, /.test(call)) {
        // A variable: the enclosing helper must take a closed union of catalog keys.
        const unions = [...src.matchAll(/action: ((?:'[a-z.]+' \| )*'[a-z.]+')\)/g)].map((u) => [...u[1].matchAll(/'([a-z.]+)'/g)].map((x) => x[1]));
        if (!unions.length || unions.some((u) => u.some((k) => !isKey(k)))) bad.push(`${f}: variable action without a closed union of catalog keys`);
        continue;
      }
      bad.push(`${f}: ${call.slice(0, 120)}`);
    }
    for (const m of src.matchAll(/stepUp\.assert\(req, '([a-z.]+)'\)/g)) { sites++; if (!isKey(m[1])) bad.push(`${f}: stepUp.assert ${m[1]}`); }
    if (/stepUp\.assert\(req, [^']/.test(src)) bad.push(`${f}: stepUp.assert with a non-literal action`);
    for (const m of src.matchAll(/new FreshAuthNeeded\(([^)]*)\)/g)) { sites++; const k = m[1].match(/^'([a-z.]+)'$/); if (!k || !KEYS.includes(k[1])) bad.push(`${f}: FreshAuthNeeded(${m[1]})`); }
    // A STEP_UP_REQUIRED thrown anywhere else must name a key too.
    if (!/auth\/step-up\.service\.ts$|client-updates\.controller\.ts$|global-exception\.filter\.ts$/.test(f) && /code: 'STEP_UP_REQUIRED'/.test(src)) bad.push(`${f}: throws STEP_UP_REQUIRED itself`);
  }
  check('confirm: every step-up site in the API names a catalog key (assertFresh action, StepUpService.assert, FreshAuthNeeded)',
    bad.length === 0 && sites >= 60, `${sites} sites; ${bad.join('; ')}`);
  // Each site names its own key: the exact set of keys per file. Adding a
  // step-up, or moving one to another key, changes this list in the same commit.
  const SITE_KEYS = {
    'actions/actions.service.ts': ['actions.direct'],
    'admin/security.controller.ts': ['login.lockout', 'server.security'],
    'adoption/adoption.service.ts': ['adoption.mappings', 'devices.adopt'],
    'adoption/deployment-keys.service.ts': ['deployment.keys'],
    'agent-auto-migration/agent-auto-migration.service.ts': ['agent.automigrate'],
    'agent-auto-update/agent-auto-update.service.ts': ['agent.autoupdate', 'agent.autoupdate.computer'],
    'agent-upgrade/agent-upgrade.service.ts': ['agent.migrate'],
    'ai/ai.controller.ts': ['ai.settings'],
    'apikeys/apikeys.service.ts': ['apikey.create'],
    'automation/automation.controller.ts': ['automation.policy'],
    'automation/automation.service.ts': ['actions.direct'],
    'restart-windows/restart-windows.service.ts': ['restart.window'],
    'client-updates/client-updates.service.ts': ['agent.autoupdate.business', 'updates.schedule'],
    'containment/containment.controller.ts': ['containment.lift'],
    'email/email.controller.ts': ['email.recipients', 'email.relay'],
    'endpoints/endpoints.controller.ts': ['credential.reveal'],
    'enrollment/enrollment.service.ts': ['enrollment.create'],
    'integration/integration-admin.controller.ts': ['technicians.manage'],
    'monitoring/monitoring.controller.ts': ['monitoring.autoticket', 'monitoring.notify'],
    'monitoring/alert-quality.controller.ts': ['monitoring.qualityrule'],
    'offboarding/offboarding.controller.ts': ['permissions.change'],
    'passkeys/passkeys.controller.ts': ['passkey.manage'],
    'patching/patching.controller.ts': ['patching.policy'],
    'patching/series.service.ts': ['patching.override'],
    'platform/public-url.controller.ts': ['platform.configure'],
    'psa/psa.controller.ts': ['psa.connector'],
    'remote-ops/terminal.service.ts': ['terminal.open'],
    'remote-ops/file-transfer.service.ts': ['files.transfer'],
    'reports/report-schedules.controller.ts': ['reports.schedule'],
    'script-library/script-library.service.ts': ['scripts.review'],
    'script-run/script-run.service.ts': ['scripts.direct'],
    'security-controls/confirm-policy.service.ts': ['confirm.relax'],
    'security-controls/security-controls.controller.ts': ['containment.lift', 'security.controls', 'security.trust', 'temporary.access'],
    'security-controls/temporary-access.service.ts': ['temporary.access'],
    'software/software.service.ts': ['software.catalog'],
    'sso/sso.controller.ts': ['sso.configure'],
    'sso/sso-identity.controller.ts': ['breakglass.manage', 'sso.configure', 'sso.enforce'],
    'technicians/technicians.controller.ts': ['permissions.change', 'technicians.manage'],
    'tray/tray.controller.ts': ['chat.recording'],
    'update-trust/update-trust.controller.ts': ['update.trust'],
    'users/users.controller.ts': ['permissions.change'],
    'warranty/warranty.controller.ts': ['warranty.settings'],
    'backups/backups.controller.ts': ['backup.connection'],
    'mdm/setup/mdm-setup.controller.ts': ['mdm.setup'],
    'mdm/apple/apple.controller.ts': ['mdm.enroll'],
    'msa/msa-grant.controller.ts': ['msa.grant'],
    'msa/msa-managed.controller.ts': ['msa.cutover', 'msa.reveal'],
    'msa/msa-cutover-runs.controller.ts': ['msa.cutover'],
  };
  const named = {};
  for (const f of files) {
    const src = read(f);
    const ks = new Set();
    for (const m of src.matchAll(/assertFresh\([^;]*?action: '([a-z.]+)'/g)) ks.add(m[1]);
    for (const m of src.matchAll(/stepUp\.assert\(req, '([a-z.]+)'\)|FreshAuthNeeded\('([a-z.]+)'\)|requireFresh\(req, '([a-z.]+)'\)|fresh\(this\.stepUp, req, '([a-z.]+)'\)/g)) ks.add(m[1] ?? m[2] ?? m[3] ?? m[4]);
    if (ks.size) named[f.slice(SRC.length + 1)] = [...ks].sort();
  }
  const diff = [...new Set([...Object.keys(named), ...Object.keys(SITE_KEYS)])].filter((f) => JSON.stringify(named[f] ?? []) !== JSON.stringify(SITE_KEYS[f] ?? []));
  check('confirm: each step-up site names its own key (the exact keys per file)', diff.length === 0, diff.map((f) => `${f}: ${JSON.stringify(named[f] ?? [])} vs ${JSON.stringify(SITE_KEYS[f] ?? [])}`).join('; '));
  const used = new Set(Object.values(named).flat());
  check('confirm: every catalog key is named by a site (no toggle that changes nothing)', KEYS.every((k) => used.has(k)), KEYS.filter((k) => !used.has(k)).join(', '));
  check("confirm: assertFresh's action is required and typed as a catalog key",
    /export function assertFresh\(method: string \| null, opts: \{ action: StepUpKey; phishingResistant\?: boolean; message\?: string \}\)/.test(rev)
      && /export type StepUpKey = ConfirmKey \| AlwaysAskKey;/.test(cat),
    'review.ts: opts.action: StepUpKey, not optional');
  check('confirm: StepUpService actions are catalog keys and its gate consults only the policy',
    /\] as const satisfies readonly StepUpKey\[\];/.test(sus) && /async assert\(req: Request, action: StepUpAction\): Promise<void> \{\s*if \(!confirmRequired\(action\)\) return;/.test(sus) && !/stepUpActions/.test(sus),
    'step-up.service.ts');
  const cu = read(`${SRC}/client-updates/client-updates.controller.ts`);
  check("confirm: client updates' gate is per key — the policy or a fresh step-up",
    /return \(key\) => stepped \|\| !confirmRequired\(key\);/.test(cu) && (cu.match(/this\.isFresh\(req\)/g) ?? []).length === 4,
    'client-updates.controller.ts isFresh(req): Fresh');

  // Resolution fails closed.
  const assertBody = rev.slice(rev.indexOf('export function assertFresh('), rev.indexOf('\n}\n', rev.indexOf('export function assertFresh(')));
  check('confirm: assertFresh skips only when the policy says off, never for a phishing-resistant check, and otherwise refuses a missing method',
    /\{\s*if \(!opts\.phishingResistant && !confirmRequired\(opts\.action\)\) return;\s*if \(!method\) \{\s*throw new ForbiddenException\(\{\s*code: 'STEP_UP_REQUIRED', action: opts\.action,/.test(assertBody)
      && (assertBody.match(/return;/g) ?? []).length === 1,
    'review.ts assertFresh');
  check('confirm: an unread policy, an always-ask key and an unknown key ask; a row skips only when exactly "off"; no row takes the catalog default (0.64)',
    /let confirmLoaded = false;/.test(rev) && /if \(!confirmLoaded\) return true;\s*if \(ALWAYS\.has\(key\) \|\| !CONFIGURABLE\.has\(key\)\) return true;\s*return \(confirmPolicy\.get\(key\) \?\? DEFAULTS\.get\(key\) \?\? 'ask'\) !== 'off';/.test(rev)
      && /if \(typeof r\.key === 'string' && CONFIGURABLE\.has\(r\.key\) && !ALWAYS\.has\(r\.key\)\) m\.set\(r\.key, r\.value === 'off' \? 'off' : 'ask'\);/.test(rev)
      && /const DEFAULTS: ReadonlyMap<string, ConfirmValue> = new Map<string, ConfirmValue>\(CONFIRM_CATALOG\.map\(\(f\) => \[f\.key, f\.default\]\)\);/.test(rev)
      && (rev.match(/DEFAULTS/g) ?? []).length === 2,
    'review.ts confirmRequired / setConfirmPolicy / DEFAULTS');
  // 0.64: the suites ask for every function themselves; nothing shipped does.
  const asksLib = read('apps/api/scripts/lib/confirm-asks.mjs');
  const runE2e = read('scripts/run-e2e.sh');
  const seedSrc = read('apps/api/prisma/seed.ts');
  const importers = walk(SRC).filter((f) => /confirm-asks/.test(read(f)));
  check('confirm: the test helper that sets every function to ask refuses a non-scratch database, and only the suites and run-e2e.sh use it',
    /if \(!\/scratch\|test\/\.test\(name\)\) throw/.test(asksLib) && /export async function confirmEverythingAsks\(prisma\) \{\s*refuseUnlessScratch\(\);/.test(asksLib)
      && /node scripts\/lib\/confirm-asks\.mjs/.test(runE2e) && runE2e.indexOf('node scripts/lib/confirm-asks.mjs') > runE2e.indexOf('npx prisma db seed') && runE2e.indexOf('node scripts/lib/confirm-asks.mjs') < runE2e.indexOf('── self-starting suites')
      && importers.length === 0 && !/confirmPolicy/.test(seedSrc) && seedSrc.length > 0,
    `lib/confirm-asks.mjs, run-e2e.sh; imported from apps/api/src: ${importers.join(', ') || 'none'}`);
  check('confirm: the policy is read at start and every 30 s, and set again after a change',
    /async onModuleInit\(\) \{\s*await this\.load\(\);\s*this\.timer = setInterval\(\(\) => \{ void this\.load\(\); \}, 30_000\);/.test(svc) && /const after = await this\.load\(\);/.test(svc),
    'ConfirmPolicyService');
  const readers = walk(SRC).filter((f) => /confirmPolicy\.(findMany|findUnique|findFirst|upsert|update|updateMany|create|createMany|delete|deleteMany)\(/.test(read(f)));
  check('confirm: only ConfirmPolicyService reads or writes the ConfirmPolicy rows', JSON.stringify(readers) === JSON.stringify([`${SRC}/security-controls/confirm-policy.service.ts`]), readers.join(', '));
  check('confirm: nothing is left of 0.47 routine confirmation or 0.20 stepUpActions in the API',
    walk(SRC).every((f) => !/routine:|routineConfirm|ROUTINE_ACTIONS|stepUpActions|security\/routine-confirm/.test(read(f))), 'grep routine / stepUpActions under apps/api/src');

  // Changing it.
  const setFn = svc.slice(svc.indexOf('  async set('), svc.indexOf('\n  }\n', svc.indexOf('  async set(')));
  const iAdm = setFn.indexOf("if (!actor.isPlatformAdmin) throw"), iParse = setFn.indexOf('this.parse(raw)'), iFr = setFn.search(/if \(changed\.some\(\(\[, v\]\) => v === 'off'\)\) \{[\s\S]{0,200}assertFresh\(freshMethod, \{ action: 'confirm\.relax'/),
    iW = setFn.indexOf('confirmPolicy.upsert('), iAu = setFn.indexOf("action: 'CONFIRM_POLICY_CHANGED'");
  check('confirm: changing the policy is a Platform Admin\'s; relaxing confirms first (confirm.relax), then it is written and audited',
    iAdm > 0 && iParse > iAdm && iFr > iParse && iW > iFr && iAu > iW && (setFn.match(/assertFresh\(/g) ?? []).length === 1,
    'ConfirmPolicyService.set order: admin, parse, fresh for any off, write, audit');
  const parseFn = svc.slice(svc.indexOf('  private parse('), svc.indexOf('\n  }\n', svc.indexOf('  private parse(')));
  check('confirm: an always-ask key or a key outside the catalog is refused before anything is written',
    /if \(ALWAYS\.has\(k\)\) throw new BadRequestException\(\{ code: 'CONFIRM_ALWAYS_ASKS'/.test(parseFn) && /if \(!CONFIGURABLE\.has\(k\)\) throw new BadRequestException\(\{ code: 'UNKNOWN_CONFIRM_KEY'/.test(parseFn)
      && /if \(v !== 'ask' && v !== 'off'\) throw/.test(parseFn),
    'ConfirmPolicyService.parse');
  check('confirm: the audit meta is the changed keys before and after, nothing else',
    /meta: \{\s*before: Object\.fromEntries\(changed\.map\(\(\[k\]\) => \[k, before\[k\]\]\)\),\s*after: Object\.fromEntries\(changed\.map\(\(\[k\]\) => \[k, after\[k\]\]\)\),\s*\},/.test(setFn),
    'CONFIRM_POLICY_CHANGED meta');
  check('confirm: the routes are GET and PUT security/confirm-policy behind JwtAuthGuard',
    /@Controller\('security\/confirm-policy'\)\s*\n@UseGuards\(JwtAuthGuard\)/.test(ctl) && (ctl.match(/@(Get|Put|Post|Patch|Delete)\(/g) ?? []).join() === '@Get(,@Put(',
    'confirm-policy.controller.ts');
  check("confirm: 0071 CHECKs the value, maps 0.47's seven only where routineConfirm was off, and drops both old settings",
    /CHECK \("value" IN \('ask', 'off'\)\)/.test(mig) && /"routineConfirm" = 'off'\);/.test(mig) && /DROP COLUMN "routineConfirm"/.test(mig) && /DROP COLUMN "stepUpActions"/.test(mig)
      && !/'(passkey\.manage|confirm\.relax|fresh\.auth\.passkey)', 'off'|unnest\(ARRAY\[[^\]]*'passkey\.manage'/.test(mig),
    'migration 0071');

  // The web holds no copy, and every key it words a prompt by exists.
  const web = walk('apps/web').filter((f) => !/docs-content\.generated\.ts$/.test(f));
  const webKeys = new Set();
  for (const f of web) for (const m of read(f).matchAll(/(?:asks|useAsks|confirmNote|needsConfirm)\(\s*'([a-z.]+)'/g)) webKeys.add(m[1]);
  const unknown = [...webKeys].filter((k) => !isKey(k));
  check('confirm: every key the console words a prompt by is in the catalog', webKeys.size >= 10 && unknown.length === 0, `${webKeys.size} keys; unknown: ${unknown.join(', ')}`);
  const copies = web.filter((f) => (read(f).match(/'(software\.catalog|patching\.policy|actions\.direct|agent\.migrate|apikey\.create|email\.relay|security\.controls|update\.trust)'/g) ?? []).filter((x, i, a) => a.indexOf(x) === i).length >= 5);
  check('confirm: the console has no copy of the catalog (it reads GET /security/confirm-policy)', copies.length === 0 && /\/security\/confirm-policy/.test(read('apps/web/lib/api-client.ts')), copies.join(', '));
}

// 63. Company-wide patch policies and the per-computer Patch policy setting
//     (0.50). A series (company-wide, or assignable) never signs or widens
//     anything: each revision is an ordinary PatchPolicy document — a closed
//     list of named computers — admitted through the one admission path, and
//     the signer is unchanged. A running revision's document and computers are
//     never rewritten; a revision only replaces it. A computer is live in at
//     most one policy (partial unique index; live only while ACTIVE). The
//     setting is written by one service method, needs computers:edit and a
//     fresh sign-in, and is audited before and after. Re-proposal is bounded:
//     never mid-ring, settled first, one claim per business per N minutes.
//
//     0.62 (§75), at the owner's request: a series made from the console
//     installs all at once (no canary, every computer in at most five rings of
//     25 that wait for nothing; planAllAtOnce). A series stored before 0.62
//     has no staging and keeps its canary (seriesStaging).
{
  const pp = read('apps/api/src/actions/patch-policy.ts');
  const pol = read('apps/api/src/patching/policies.service.ts');
  const ser = read('apps/api/src/patching/series.service.ts');
  const asg = read('apps/api/src/patching/assignment.ts');
  const mig = read('apps/api/prisma/migrations/0072_patch_policy_assignment/migration.sql');
  const docBlock = (pp.match(/export const PolicyDoc = z\.object\(\{([\s\S]*?)\}\)\.strict\(\);/) ?? [])[1] ?? '';
  check('assignment: the signed document is still a closed list of named computers (no scope, series or "all computers" field)',
    /rings: z\.array\(z\.array\(PolicyComputer\)/.test(docBlock) && !/scope|series|allComputers|revision/i.test(docBlock)
      && /const allowed = new Map\(doc\.rings\[ring\]\.map\(\(c\) => \[c\.endpointId, c\]\)\);/.test(pp),
    'PolicyDoc must stay strict with rings of PolicyComputer, and the signer must check targets against doc.rings');
  check('assignment: the approval signer has no series code',
    !/PatchPolicySeries|patchPolicyMode|seriesId/.test(read('apps/api/src/approval-signer/server.ts') + read('apps/api/src/approval-signer/core.ts') + read('apps/api/src/approval-signer/store.ts')),
    'approval-signer/*.ts must not know about series');
  const srcAll = walk('apps/api/src').filter((f) => f.endsWith('.ts'));
  const submits = srcAll.filter((f) => /\.submitPolicy\(/.test(read(f)));
  const creates = srcAll.filter((f) => /patchPolicy\.create\(/.test(read(f)));
  check('assignment: revisions go only through PatchPolicyService.admit — the one submitPolicy and the one patchPolicy.create',
    submits.length === 1 && submits[0].endsWith('patching/policies.service.ts') && (pol.match(/\.submitPolicy\(/g) ?? []).length === 1
      && creates.length === 1 && creates[0].endsWith('patching/policies.service.ts')
      && /return this\.admit\(actor, parsed\.data, now, null\);/.test(pol)
      && (ser.match(/this\.policies\.admit\(/g) ?? []).length === 2 && !/submitPolicy|patchPolicy\.create|signer\./.test(ser),
    `submitPolicy in ${submits.join(', ')}; patchPolicy.create in ${creates.join(', ')}`);
  const admitFn = pol.slice(pol.indexOf('  async admit('), pol.indexOf('  async heldElsewhere('));
  check('assignment: admission checks one-policy-per-computer for every computer before the signer sees the document',
    /const held = await this\.heldElsewhere\(id, series\?\.seriesId \?\? null\);\s*if \(held\) throw new ConflictException\(\{ code: 'COMPUTER_IN_POLICY'/.test(admitFn)
      && admitFn.indexOf('heldElsewhere(') < admitFn.indexOf('submitPolicy(') && /validatePolicyDoc\(doc, now\)/.test(admitFn),
    'admit must call heldElsewhere per computer, then validatePolicyDoc, then submitPolicy');
  const docWrites = srcAll.filter((f) => /patchPolicy\.(update|updateMany|upsert)\(\{[^;]*?document:/.test(read(f).replace(/\n/g, ' ')));
  const memberCreates = srcAll.filter((f) => /patchPolicyComputer\.(create|createMany|upsert)\(/.test(read(f)));
  check('assignment: nothing widens a running revision — no document is rewritten, member rows are written only at admission',
    docWrites.length === 0 && memberCreates.length === 1 && memberCreates[0].endsWith('patching/policies.service.ts') && (pol.match(/patchPolicyComputer\.createMany\(/g) ?? []).length === 1
      && /patchPolicyComputer\.createMany\(\{ data: rings\.flatMap\(\(ring, i\) => ring\.map\(\(c\) => \(\{ policyId: doc\.policyId, endpointId: c\.endpointId/.test(admitFn),
    `document rewritten in ${docWrites.join(', ')}; member rows created in ${memberCreates.join(', ')}`);
  check('assignment: a revision is proposed under only while it is its series\' running one, and every planned computer must be live in it',
    /if \(!r \|\| r\.status !== 'ACTIVE' \|\| !\(await this\.isRunning\(r\)\)\) continue;/.test(pol)
      && /if \(!member\?\.live\) return 'another active policy patches it/.test(pol) && /patchPolicyMode === 'exclude'\) return 'its Patch policy is set to Exclude/.test(pol),
    'the sweep must skip non-running revisions and notReady must require the live row and honour Exclude');
  check('assignment: one live policy per computer, in the database',
    /CREATE UNIQUE INDEX "PatchPolicyComputer_one_live" ON "PatchPolicyComputer"\("endpointId"\) WHERE "live";/.test(mig)
      && /a computer is live only in an ACTIVE patch policy/.test(mig) && /CREATE TRIGGER patch_policy_release AFTER UPDATE OF "status" ON "PatchPolicy"/.test(mig)
      && /CREATE UNIQUE INDEX "PatchPolicySeries_one_business" ON "PatchPolicySeries"\("customerId"\) WHERE "scope" = 'business' AND "status" = 'active';/.test(mig),
    'migration 0072 must hold the partial unique index, the ACTIVE-only trigger, the release trigger and one company-wide policy per business');
  check('assignment: the setting is a closed value, of the computer\'s own business, in the database',
    /CHECK \("patchPolicyMode" IN \('inherit', 'exclude', 'policy'\)\s*AND \(\("patchPolicyMode" = 'policy'\) = \("patchPolicySeriesId" IS NOT NULL\)\)\)/.test(mig)
      && /s\."customerId" IS DISTINCT FROM NEW\."customerId" OR s\."scope" <> 'assigned' OR s\."status" <> 'active'/.test(mig),
    'migration 0072 must CHECK the mode and refuse another business\'s or a non-assignable series');
  const modeWrites = srcAll.filter((f) => /data: \{[^}]*patchPolicy(Mode|SeriesId):/.test(read(f)));
  const setFn = ser.slice(ser.indexOf('  async setOverride('));
  const iScope = setFn.indexOf('assertEndpointInScope(actor, endpointId, CAP.COMPUTERS_EDIT)'), iCap = setFn.indexOf('assertCapability(actor, CAP.COMPUTERS_EDIT)'),
    iFresh = setFn.indexOf("assertFresh(freshMethod, { action: 'patching.override'"), iWrite = setFn.indexOf('this.prisma.endpoint.updateMany('), iAudit = setFn.indexOf("action: 'PATCH_POLICY_OVERRIDE_SET'");
  check('assignment: the setting is written only by PatchSeriesService.setOverride — computers:edit, fresh sign-in, a conditional write, then the audit with before and after',
    modeWrites.length === 1 && modeWrites[0].endsWith('patching/series.service.ts') && (ser.match(/data: \{[^}]*patchPolicyMode:/g) ?? []).length === 1
      && iScope > 0 && iCap > iScope && iFresh > iCap && iWrite > iFresh && iAudit > iWrite
      && /where: \{ id: endpointId, patchPolicyMode: before\.mode, patchPolicySeriesId: before\.seriesId \}/.test(setFn) && /meta: \{ before, after, seriesName/.test(setFn),
    `written in ${modeWrites.join(', ')}; order scope ${iScope}, cap ${iCap}, fresh ${iFresh}, write ${iWrite}, audit ${iAudit}`);
  const dec = asg.slice(asg.indexOf('export function revisionDecision('), asg.indexOf('export function revisionReason('));
  const iMid = dec.indexOf("code: 'mid_ring', message: 'A deployment"), iSettle = dec.indexOf("if (trigger === 'membership') {"), iRate = dec.indexOf("code: 'rate_limited'"), iProp = dec.lastIndexOf("act: 'propose'");
  check('assignment: re-proposal is bounded — not mid-ring, settled first, then the per-business bound, before any propose',
    iMid > 0 && iSettle > iMid && iRate > iSettle && iProp > iRate && (dec.match(/act: 'propose'/g) ?? []).length === 1
      && /return Number\.isFinite\(n\) && n > 0 \? Math\.min\(Math\.max\(n, revisionFloorMinutes\(\)\), 24 \* 60\) : 60;/.test(asg)
      && /return process\.env\.NODE_ENV === 'test' \? 0\.05 : 1;/.test(asg),
    'revisionDecision must check mid_ring, settling and rate_limited before its one propose; the bound defaults to 60 and has a floor of 1 minute outside tests');
  check('assignment: the per-business claim is one conditional upsert, taken before any automatic revision',
    /ON CONFLICT \("customerId"\) DO UPDATE SET "at" = EXCLUDED\."at" WHERE "PatchPolicyRevisionClaim"\."at" <= \$\{cutoff\}/.test(ser)
      && /if \(decision\.act === 'propose'\) \{\s*if \(claimed === null\) claimed = await this\.claim\(businessId, now\);\s*if \(!claimed\)/.test(ser)
      && (ser.match(/this\.proposeRevision\(/g) ?? []).length === 1,
    'tickBusiness must claim (conditionally) before proposeRevision, its only caller');
  check('assignment: the series runs only inside the patch-policy sweep (PATCH_POLICY_SWEEP), with no timer of its own',
    !/setInterval|setTimeout/.test(ser) && /this\.policies\.attachSeries\(\{ tick: \(now\) => this\.tick\(now\)/.test(ser)
      && /if \(this\.series\) await this\.series\.tick\(now\)/.test(pol),
    'series.service.ts must not schedule itself');
  const prom = ser.slice(ser.indexOf('  async promote('), ser.indexOf('  private async record('));
  check('assignment: a revision takes over only when ACTIVE and the running one is not mid-ring, in one transaction',
    /r\.status === 'ACTIVE' && r\.id !== s\.currentPolicyId/.test(prom) && /if \(v\.current && v\.current\.status === 'ACTIVE' && v\.midRing\)/.test(prom)
      && /\$transaction\(async \(tx\) =>/.test(prom) && /currentPolicyId: s\.currentPolicyId, status: 'active' \}, data: \{ currentPolicyId: next\.id \}/.test(prom),
    'promote must wait for ACTIVE and no open deployment, and move the live rows and the pointer together');
  check('assignment: revoking a revision by hand, or on the signer, ends its series',
    /if \(u\.seriesId && this\.series\) await this\.series\.onRevoked\(u, 'portal', actor\.userId\);/.test(pol) && /if \(u\.seriesId && this\.series\) await this\.series\.onRevoked\(u, 'approval signer', null\);/.test(pol),
    'revoke() and the signer-revoked mirror must retire the series');
  check('assignment: the suites prove it', / patch-assignment /.test(read('scripts/run-e2e.sh')) && /unit-patch-assignment\.mjs/.test(read('.github/workflows/ci.yml')),
    'run-e2e.sh must run e2e-patch-assignment and CI must run unit-patch-assignment');
}

// 64. Which agent a computer runs is sticky to signed, and a signed computer
//     is handed nothing meant for the standard agent (0.51). Two production
//     computers flipped between 'signed' and 'legacy' within seconds: the
//     signed install script's own check-ins (Register, Test-Registered) carry
//     the device secret but no channel, every authenticated heartbeat
//     overwrote updateChannel, and so a signed computer was handed standard
//     installs, the old migration again, `standard_pre015` auto-updates, and
//     its signed tray host was refused (TRAY_KEY_REQUIRED).
//
//     One rule, common/agent-identity.ts: signed while an authenticated signed
//     heartbeat was seen within SIGNED_STICKY_MS (signedSeenAt), else while it
//     reports signed. The heartbeat reads the computer before it writes, and a
//     report that does not say signed on a signed computer writes no agent
//     field and returns before any update step, with every flag null. Only a
//     signed heartbeat writes signedSeenAt. identify() and the Agent card use
//     the rule. The signed agent removes the standard leftovers by exact name
//     (never the shared Rem0teHeartbeat task) after a successful install, and
//     a 0.51 standard heartbeat hands over only by running the installed
//     signed agent's own update.
{
  const SRC = 'apps/api/src';
  const idn = read(`${SRC}/common/agent-identity.ts`);
  const enr = read(`${SRC}/enrollment/enrollment.service.ts`);
  const hb = enr.slice(enr.indexOf('  async heartbeat('), enr.indexOf('  async authenticateDevice('));
  const tsv = read(`${SRC}/tray/tray.service.ts`);
  const up = read(`${SRC}/agent-upgrade/agent-upgrade.service.ts`);
  const ws = read(`${SRC}/public/windows-script.ts`);
  const ret = read('tools/windows-installer/internal/agent/retire.go');
  const retw = read('tools/windows-installer/retire_windows.go');
  const ag = read('tools/windows-installer/internal/agent/agent.go');
  const mig = read('apps/api/prisma/migrations/0073_signed_sticky/migration.sql');

  check('sticky: one rule — signed while a signed heartbeat is within SIGNED_STICKY_MS, else while it reports signed; only signed and standard heartbeats may act',
    /export const SIGNED_STICKY_MS = 7 \* 24 \* 3600_000;/.test(idn)
      && /if \(f\.signedSeenAt\) return now\.getTime\(\) - f\.signedSeenAt\.getTime\(\) < SIGNED_STICKY_MS;\s*\n\s*return f\.updateChannel === 'signed';/.test(idn)
      && /return kind === 'signed' \|\| kind === 'standard';/.test(idn)
      && /if \(dto\.updateChannel === 'signed'\) return 'signed';\s*\n\s*if \(!runsSignedAgent\(ep, now\)\) return 'standard';/.test(idn),
    'common/agent-identity.ts runsSignedAgent / heartbeatKind / heartbeatMayAct');

  // 0.57: the same read also takes customerId and tenantId (the unassigned pool, §70).
  const iRead = hb.indexOf("select: { updateChannel: true, signedSeenAt: true, legacySeenAt: true"), iNode = hb.indexOf('await this.prisma.rustdeskNode.update({', iRead),
    iEp = hb.indexOf('await this.prisma.endpoint.update({'), iRet = hb.indexOf('if (authenticated && !mayAct) {'), iFlags = hb.indexOf('let updateRustdesk:');
  const early = hb.slice(iRet, hb.indexOf('\n    }\n', iRet));
  check('sticky: the heartbeat reads the computer first, and a legacy report on a signed computer returns before any update step with every flag null',
    iRead > 0 && iNode > iRead && iEp > iNode && iRet > iEp && iFlags > iRet
      && /rotate: null, updateRustdesk: null, reinstallAgent: null,\s*\n\s*commands: \[\], actions: \[\], actionAcks: \[\], patchPostureAck: null, patchScan: false,\s*\n\s*monitor: null, diagnostics: \[\], chat: null, tray: null,/.test(early)
      && !/agentAuto|agentMigration|rollouts|reinstallRequestedAt|updateRequestedAt/.test(early),
    'enrollment.service heartbeat: identity read → node update → endpoint update → `if (authenticated && !mayAct)` return → the update steps');
  check('sticky: no agent field is written by a report that may not act, and only a signed heartbeat writes signedSeenAt',
    /\.\.\.\(authenticated && mayAct && dto\.agentVersion !== undefined && \{ agentVersion: dto\.agentVersion \}\),/.test(hb)
      && /\.\.\.\(authenticated && mayAct && \{\s*\n\s*updateChannel: dto\.updateChannel === 'signed' \? 'signed' : 'legacy',/.test(hb)
      && /\.\.\.\(authenticated && mayAct && plausibleCheck\(dto\.agentUpdateCheckedAt\) && \{/.test(hb)
      && /\.\.\.\(authenticated && mayAct &&\s*\n\s*node\.reinstallRequestedAt &&/.test(hb) && /\.\.\.\(authenticated && mayAct &&\s*\n\s*node\.updateRequestedAt &&/.test(hb)
      && /\.\.\.\(authenticated && kind === 'signed' && \{ signedSeenAt: now \}\),/.test(hb)
      && walk(SRC).filter((f) => /signedSeenAt: (now|new Date)/.test(read(f))).join() === `${SRC}/enrollment/enrollment.service.ts`,
    'agentVersion, updateChannel… and agentUpdateCheckedAt gated on mayAct; signedSeenAt written only in the heartbeat, only for kind signed');
  check('sticky: an installer check-in starts no automatic update; a dual report is audited at most once a day',
    /export function isInstallerCheckIn\(dto: HeartbeatShape & \{ agentVersion\?: string \}\): boolean \{\s*\n\s*return !carriesLiveState\(dto\) && dto\.updateChannel !== 'signed';/.test(idn)
      && /if \(kind === 'legacy_on_signed' && \(!identity\?\.legacySeenAt \|\| now\.getTime\(\) - identity\.legacySeenAt\.getTime\(\) > DUAL_AUDIT_EVERY_MS\)\) \{/.test(hb)
      && /ALTER TYPE "ActivityAction" ADD VALUE 'AGENT_DUAL_REPORT';/.test(mig),
    'isInstallerCheckIn; AGENT_DUAL_REPORT gated by DUAL_AUDIT_EVERY_MS');
  check('sticky: identify() and the Agent card decide "signed" by the rule, not by the last heartbeat',
    (tsv.match(/runsSignedAgent\(ep\)/g) ?? []).length >= 3 && !/ep\.updateChannel (===|!==) 'signed'/.test(tsv.slice(tsv.indexOf('  async identify('), tsv.indexOf('  private async context(')))
      && /if \(runsSignedAgent\(ep\)\) return 'signed';/.test(up),
    'tray.service identify/pair and agent-upgrade kindOf use runsSignedAgent');
  check('retire: the signed agent removes the standard leftovers by exact name, never the shared heartbeat task, and only after a successful install',
    /var StandardTasks = \[\]string\{"Rem0teEnrollment"\}/.test(ret) && /const SharedHeartbeatTask = "Rem0teHeartbeat"/.test(ret)
      && !/Rem0teHeartbeat/.test(retw) && !/[*?]/.test((ret.match(/var StandardFiles = \[\]string\{[^}]*\}/) ?? [''])[0])
      && /if !allowedRetireTask\(name\) \{/.test(retw) && (retw.match(/allowedRetireTask\(name\)/g) ?? []).length === 2
      && /exec\.Command\(filepath\.Join\(dir, "schtasks\.exe"\), args\.\.\.\)/.test(retw) && (retw.match(/exec\.Command/g) ?? []).length === 1
      && /if code == 0 && err == nil \{\s*\n\s*if sr, ok := p\.\(StandardRetirer\); ok \{/.test(ag),
    'internal/agent/retire.go lists; retire_windows.go: System32 schtasks.exe, the allowlist checked in TaskExists and DeleteTask; stage2 retires only on success');
  const legacyRetire = ws.slice(ws.indexOf('    retireHook: `try {'), ws.indexOf("} catch {}`,", ws.indexOf('    retireHook: `try {')));
  check("retire: a standard heartbeat hands over only by running the installed signed agent's own update, and the signed heartbeat has no such hook",
    legacyRetire.length > 100 && /\\\$agentExe = Join-Path \\\$env:ProgramFiles 'Rem0te\\\\rem0te-agent\.exe'/.test(legacyRetire)
      && /try \{ & \\\$agentExe @\('update'\) \*>\\\$null \} catch \{\}/.test(legacyRetire)
      && !/irm|iex|Invoke-WebRequest|Invoke-Expression|\$iu/.test(legacyRetire)
      && /retireHook: '# Handing over to the signed agent: standard channel only\.',/.test(ws),
    'windows-script.ts legacy retireHook');
  check('sticky: the suites prove it', / dual-agent /.test(read('scripts/run-e2e.sh')) && /unit-agent-identity\.mjs/.test(read('.github/workflows/ci.yml')),
    'run-e2e.sh must run e2e-dual-agent and CI must run unit-agent-identity');
}

// 65. Task progress and scheduled installs (0.52). The task views are read
//     only: the tasks module writes nothing itself (it pulls a pending
//     approval through ActionsService.refresh, as every job read does) and
//     has no route but GETs, and
//     every list goes through endpointVisibilityWhere (one computer: through
//     assertEndpointInScope with computers:view). A scheduled install is an
//     ordinary signed plan whose window opens at the scheduled time: the plan
//     the signer signs carries the same notBefore the portal stores, the one
//     dispatch site hands out nothing before it, and the agent refuses a plan
//     whose window has not opened by its own clock without consuming it.
//     Cancelling a scheduled task is the existing cancel, which touches only
//     a plan that reached no computer, and only its PENDING targets.
{
  const act = read('apps/api/src/actions/actions.service.ts');
  const pat = read('apps/api/src/patching/patching.service.ts');
  const tsvc = read('apps/api/src/tasks/tasks.service.ts');
  const tctl = read('apps/api/src/tasks/tasks.controller.ts');
  const life = read('apps/api/src/tasks/lifecycle.ts');
  const agent = read('tools/windows-installer/internal/action/action.go');
  const create = act.slice(act.indexOf('  async createPlan('), act.indexOf('  async view('));
  check('schedule: the signed plan carries the notBefore the portal stores (one variable for both)',
    /const notBefore = r\.window\?\.notBefore \?\? new Date\(now\.getTime\(\) \+ r\.startsInMinutes \* 60_000\);/.test(create)
      && /window: \{ notBefore: notBefore\.toISOString\(\), notAfter: notAfter\.toISOString\(\) \},/.test(create)
      && /notBefore, notAfter, plan: plan as unknown as Prisma\.InputJsonValue/.test(create),
    'createPlan must sign plan.window from the same notBefore/notAfter it stores on ActionJob');
  check('schedule: a schedule becomes the plan window only through scheduledWindow, never beside a policy\'s window',
    /\.\.\.\(!under && dto\.schedule \? \{ window: scheduledWindow\(dto\.schedule, d\.windowHours\) \} : \{\}\),/.test(pat)
      && /if \(dto\.schedule && \(under \|\| dto\.startsInMinutes\)\) this\.bad\(/.test(pat)
      // 0.54: scheduledStart moved to common/schedule.ts, shared with a scheduled restart.
      && /const notBefore = scheduledStart\(s, now\);/.test(pat) && /MAX_SCHEDULE_DAYS = 14;/.test(read('apps/api/src/common/schedule.ts'))
      && /code: 'SCHEDULE_IN_PAST'/.test(read('apps/api/src/common/schedule.ts')) && /code: 'INVALID_TIMEZONE'/.test(read('apps/api/src/common/schedule.ts')),
    'requestRing must build the window with scheduledWindow, refuse it under a policy or with startsInMinutes, and scheduledStart must bound it');
  const hb = act.slice(act.indexOf('  async forHeartbeat('), act.indexOf('  private async scriptFor('));
  const iHold = hb.indexOf('if (now < job.notBefore) continue;'), iWrite = hb.indexOf("data: { status: 'DISPATCHED', dispatchedAt: now");
  const dispatchSites = walk('apps/api/src').filter((f) => /actionTarget\.updateMany\([^\n]*data: \{ status: 'DISPATCHED'/.test(read(f)));
  check('schedule: nothing is handed out before notBefore — the one dispatch write comes after the check',
    iHold > 0 && iWrite > iHold && dispatchSites.length === 1 && dispatchSites[0].endsWith('actions/actions.service.ts') && (act.match(/actionTarget\.updateMany\(\{ where: \{ id: t\.id, status: 'PENDING' \}, data: \{ status: 'DISPATCHED'/g) ?? []).length === 1,
    `notBefore check at ${iHold}, dispatch write at ${iWrite}; dispatch sites: ${dispatchSites.join(', ')}`);
  check('schedule: the agent refuses a plan whose window has not opened (not_yet_valid), and does not consume it',
    /if now\.Before\(nb\) \{\s*return nil, refuse\("not_yet_valid"/.test(agent) && /if r\.Reason == "not_yet_valid" \{\s*return r, nil\s*\}/.test(agent),
    'internal/action/action.go must refuse before notBefore and return without final() for not_yet_valid');
  const cancel = act.slice(act.indexOf('  async cancel('), act.indexOf('  async reconcile('));
  check('schedule: cancel touches only a plan that reached no computer, and only its PENDING targets',
    /where: \{ id, status: \{ in: \['AWAITING_APPROVAL', 'APPROVED'\] \} \}, data: \{ status: 'CANCELED'/.test(cancel)
      && /actionTarget\.updateMany\(\{ where: \{ jobId: id, status: 'PENDING' \}, data: \{ status: 'CANCELED', statusReason: 'plan canceled' \} \}\)/.test(cancel)
      && /if \(!this\.mayManage\(actor, j\)\)/.test(cancel) && /action: 'ACTION_CANCELED'/.test(cancel)
      && !/'DISPATCHED'/.test(cancel),
    'ActionsService.cancel must stay conditional on AWAITING_APPROVAL/APPROVED, cancel PENDING targets only, check who may manage it and audit');
  check('schedule: a task view offers cancel only before delivery',
    (life.match(/v\.cancelJobId = /g) ?? []).length === 2 && /v\.cancelJobId = job\.status === 'APPROVED' \? job\.id : null;/.test(life),
    'lifecycle.ts must set cancelJobId only for AWAITING_APPROVAL and for an APPROVED plan whose target is PENDING');
  const taskFiles = walk('apps/api/src/tasks');
  const writes = taskFiles.filter((f) => /\.(create|createMany|update|updateMany|upsert|delete|deleteMany)\(|\$executeRaw|\$queryRaw/.test(read(f)));
  check('tasks: the module is read only — no write, no raw SQL, GET routes only; it only pulls a pending approval (ActionsService.refresh)',
    taskFiles.length >= 4 && writes.length === 0 && !/this\.actions\.(?!refresh\()/.test(tsvc) && !/@(Post|Put|Patch|Delete)\(/.test(tctl) && (tctl.match(/@Get\(/g) ?? []).length === 3,
    `writes in ${writes.join(', ')}`);
  const rows = tsvc.slice(tsvc.indexOf('  private async rowsFor('), tsvc.indexOf('  private assertView('));
  check('tasks: every read is scoped to computers the reader can see, with computers:view',
    (rows.match(/where: \{ endpoint: where,/g) ?? []).length === 4 && /where: \{ AND: \[\{ endpoint: where \}, recentOrOpenTarget/.test(rows) && /where: \{ AND: \[where, \{ patchScanRequestedAt: \{ not: null \} \}\] \}/.test(rows)
      && /async forEndpoint\([^]*?this\.assertView\(actor\);\s*await this\.acl\.assertEndpointInScope\(actor, endpointId, CAP\.COMPUTERS_VIEW\);\s*const tasks = await this\.build\(await this\.rowsFor\(\{ id: endpointId \}/.test(tsvc)
      && /async list\([^]*?this\.assertView\(actor\);[^]*?const where = this\.acl\.endpointVisibilityWhere\(actor, q\.businessId \?\? null\);/.test(tsvc)
      && /async mine\([^]*?this\.assertView\(actor\);[^]*?const where = this\.acl\.endpointVisibilityWhere\(actor\);[^]*?requestedById: actor\.userId/.test(tsvc)
      && /this\.acl\.assertCapability\(actor, CAP\.COMPUTERS_VIEW\);/.test(tsvc),
    'TasksService.rowsFor must filter every table by the visibility where; forEndpoint, list and mine must check computers:view first');
  check('tasks: a restart scheduled after an install asks only for a scan, and only once it succeeded',
    /const rebootAt = t\.job\.actionId === REBOOT_SCHEDULE\.id && r\.outcome === 'succeeded' \? Date\.parse\(r\.observed\?\.scheduledFor \?\? ''\) : NaN;/.test(act)
      && /data: \{ patchScanRequestedAt: new Date\(rebootAt \+ 2 \* 60_000\) \}/.test(act),
    'recordResults may only set patchScanRequestedAt from a succeeded windows.reboot.schedule result');
  check('tasks: the suites prove it', / task-progress[ ;]/.test(read('scripts/run-e2e.sh')) && /unit-task-progress\.mjs/.test(read('.github/workflows/ci.yml')),
    'run-e2e.sh must run e2e-task-progress and CI must run unit-task-progress');
}

// 66. Monthly patch windows (0.53). A patch policy's window is a closed union
//     of exactly three strict shapes: weekly (0.32's shape, no `kind`, so a
//     weekly document's bytes, digest and signatures are unchanged), and two
//     monthly ones (`kind: 'monthly'`: the nth or last weekday plus 0–14 days,
//     or a day of the month 1–28). The occurrence arithmetic is defined once,
//     in actions/patch-policy.ts, which the approval signer bundles: the
//     portal's sweep and preview and the signer's admission and ring-plan
//     check call the same functions, and the web works out no occurrence of
//     its own. A shape that is none of the three never opens — refused by the
//     schema, and null from every occurrence function. The agent never reads
//     a policy window: it checks only its plan's own notBefore/notAfter.
{
  const pp = read('apps/api/src/actions/patch-policy.ts');
  const body = (name) => (pp.match(new RegExp(`export const ${name} = z\\.object\\(\\{([\\s\\S]*?)\\n\\}\\)\\.strict\\(\\)\\.refine\\(notEmpty, 'the window must not be empty'\\);`)) ?? [])[1] ?? '';
  const keys = (src) => [...src.matchAll(/^\s{2}([a-zA-Z]+):/gm)].map((m) => m[1]).join(',');
  const wk = body('WeeklyWindow'), mw = body('MonthlyWeekdayWindow'), md = body('MonthlyDayWindow');
  check('monthly windows: the window is a closed union of exactly three strict shapes',
    /export const PolicyWindow = z\.union\(\[WeeklyWindow, MonthlyWeekdayWindow, MonthlyDayWindow\]\);/.test(pp)
      && (pp.match(/export const PolicyWindow = /g) ?? []).length === 1
      && keys(wk) === 'days,start,end,timezone' && keys(mw) === 'kind,week,weekday,offsetDays,start,end,timezone' && keys(md) === 'kind,day,start,end,timezone'
      && (mw.match(/kind: z\.literal\('monthly'\),/g) ?? []).length === 1 && (md.match(/kind: z\.literal\('monthly'\),/g) ?? []).length === 1
      && /offsetDays: z\.number\(\)\.int\(\)\.min\(0\)\.max\(MAX_MONTHLY_OFFSET_DAYS\),/.test(mw) && /day: z\.number\(\)\.int\(\)\.min\(1\)\.max\(MAX_MONTH_DAY\),/.test(md)
      && /export const MAX_MONTHLY_OFFSET_DAYS = 14;/.test(pp) && /export const MAX_MONTH_DAY = 28;/.test(pp)
      && /export const MONTH_WEEKS = \['first', 'second', 'third', 'fourth', 'last'\] as const;/.test(pp)
      && /window: PolicyWindow,/.test(pp.slice(pp.indexOf('export const PolicyDoc = z.object('), pp.indexOf('export type PolicyDoc'))),
    'patch-policy.ts: WeeklyWindow (days, start, end, timezone — no kind), MonthlyWeekdayWindow, MonthlyDayWindow, each .strict(), and PolicyDoc.window is their union');
  // Any function taking a policy window (reports/schedule.ts has its own nextOccurrence, for report schedules, which takes none).
  const takesWindow = /function \w+\([^)]*\b(PolicyWindow|MonthlyWindow|WeeklyWindow)\b/;
  const defs = walk('apps/api/src').filter((f) => takesWindow.test(read(f)));
  const webDefs = walk('apps/web').filter((f) => !f.endsWith('.generated.ts') && /function (occurrenceAt|nextOccurrence|nextOccurrences|monthlyDate|opensOn)\(|zonedToUtc/.test(read(f)));
  const ev = pp.slice(pp.indexOf('export function evaluatePolicyPlan('), pp.indexOf('// ── Signed evidence'));
  const val = pp.slice(pp.indexOf('export function validatePolicyDoc('), pp.indexOf('/** What a plan\'s params carry'));
  const pol = read('apps/api/src/patching/policies.service.ts');
  const prev = pol.slice(pol.indexOf('  previewWindow('), pol.indexOf('  async list('));
  check('monthly windows: the signer and the portal share one occurrence function, and the web has none of its own',
    defs.length === 1 && defs[0] === 'apps/api/src/actions/patch-policy.ts' && webDefs.length === 0
      && /const occ = occurrenceAt\(nb, doc\.window\);\s*\n\s*if \(!occ \|\| na > occ\.end\) return no\('outside_window'/.test(ev)
      && /if \(!nextOccurrence\(now, doc\.window, until\)\) return \{ ok: false, reason: 'window_never_opens'/.test(val)
      && /const occ = occurrenceAt\(now, doc\.window\);/.test(pol) && /nextOccurrences\(now, w\.data, 3, until\)/.test(prev) && /PolicyWindow\.safeParse\(parsed\.data\.window\)/.test(prev)
      && !/this\.prisma|this\.audit|\.create\(|\.update\(/.test(prev)
      && /actions\\\/patch-policy\\\.js\$/.test(read('apps/api/scripts/build-approval-signer.mjs'))
      && /patchingApi\.windowPreview\(/.test(read('apps/web/components/patching/window-editor.tsx')),
    `occurrence functions defined in: ${defs.join(', ') || 'none'}; in the web: ${webDefs.join(', ') || 'none'}`);
  const occAt = pp.slice(pp.indexOf('export function occurrenceAt('), pp.indexOf('/** The first occurrence'));
  const nextO = pp.slice(pp.indexOf('export function nextOccurrence('), pp.indexOf('/** 0.53: the next `count`'));
  const opens = pp.slice(pp.indexOf('function opensOn('), pp.indexOf('/** How many local days ahead'));
  const kind = pp.slice(pp.indexOf('export function windowKind('), pp.indexOf('/**', pp.indexOf('export function windowKind(')));
  check('monthly windows: an unknown window kind is refused — never read as weekly or monthly',
    /if \(!\('kind' in o\)\) return Array\.isArray\(o\.days\) \? 'weekly' : null;/.test(kind) && /if \(o\.kind !== 'monthly' \|\| 'days' in o\) return null;/.test(kind)
      && /^\s*if \(!windowKind\(w\)\) return null;/m.test(occAt) && /^\s*if \(!windowKind\(w\)\) return null;/m.test(nextO)
      && /if \(kind !== 'monthly'\) return false;/.test(opens)
      && /const parsed = PolicyDoc\.safeParse\(raw\);\s*\n\s*if \(!parsed\.success\) throw new Refused\('invalid_policy'/.test(read('apps/api/src/approval-signer/core.ts')),
    'windowKind null for any other shape; occurrenceAt/nextOccurrence return null and opensOn false for it; the signer admits only what PolicyDoc parses');
  const unit = read('apps/api/scripts/unit-monthly-window.mjs');
  const agentGo = ['action.go', 'updates.go'].map((f) => { try { return read(`tools/windows-installer/internal/action/${f}`); } catch { return ''; } }).join('\n');
  check('monthly windows: weekly documents are unchanged, the agent reads no policy window, and the suites prove it',
    /P\.policyDigest\(parsed\) === '466423a5bb889e289b536d62ac25ddf66450179770f1161c576003fc3644f99b'/.test(unit)
      && /unit-monthly-window\.mjs/.test(read('.github/workflows/ci.yml'))
      && /section\('A monthly window \(0\.53\)/.test(read('apps/api/scripts/e2e-patch-policies.mjs'))
      && agentGo.length > 0 && !/offsetDays|MonthWeek|"days"|Weekday/.test(agentGo),
    'unit-monthly-window pins the 0.52 weekly digest and runs in CI; e2e-patch-policies has the monthly section; internal/action has no policy-window code');
}

// 67. Restart scheduling and restart windows (0.54). A restart is still the
//     one action windows.reboot.schedule@1. It may carry two closed flags,
//     each present only when exactly true: onlyIfRequired (the agent decides
//     from Windows' own pending-restart state) and ignoreRemoteSession — the
//     owner's exception to § 32/§ 37's "never while a RustDesk session is
//     open", reversed at the owner's request ("there should be an override
//     exception checkbox"). The exception is honoured only from the signed
//     plan, skips only the session check (the warning always shows), is never
//     ticked by default, needs a 0.54 agent (an older one refuses the plan),
//     and under a patch policy only when the approved policy has it. A
//     policy's restart window is signed in its document; the signer signs a
//     restart under it only inside the window, with the fixed warning and the
//     rule's own flags, at most MAX_RESTART_ATTEMPTS per computer per
//     occurrence. A signed-in Windows user never stops a restart, and every
//     restart UI says so.
{
  const maint = read('tools/windows-installer/internal/action/maintenance.go');
  const upd = read('tools/windows-installer/internal/action/updates.go');
  const goCat = read('tools/windows-installer/internal/action/catalog.go');
  const tsCat = read('apps/api/src/actions/catalog.ts');
  const pp = read('apps/api/src/actions/patch-policy.ts');
  const asvc = read('apps/api/src/actions/actions.service.ts');
  const pol = read('apps/api/src/patching/policies.service.ts');
  const bulkR = read('apps/api/src/actions/restart-bulk.ts');
  const strip = (s) => s.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
  const goFiles = [];
  const walkGo = (d) => { for (const n of readdirSync(join(ROOT, d))) { const r = `${d}/${n}`; if (statSync(join(ROOT, r)).isDirectory()) walkGo(r); else if (n.endsWith('.go') && !n.endsWith('_test.go')) goFiles.push(r); } };
  walkGo('tools/windows-installer/internal'); walkGo('tools/windows-installer/cmd/rem0te-tray');
  for (const n of readdirSync(join(ROOT, 'tools/windows-installer'))) if (n.endsWith('.go') && !n.endsWith('_test.go')) goFiles.push(`tools/windows-installer/${n}`);
  const goNaming = goFiles.filter((f) => /"ignoreRemoteSession"/.test(strip(read(f)))).map((f) => f.replace(/^.*tools\/windows-installer\//, ''));
  check('restart flags: the same closed pair on the agent and in the portal, each exactly true',
    /var RestartFlags = \[\]string\{"onlyIfRequired", "ignoreRemoteSession"\}/.test(maint) && /export const RESTART_FLAGS = \['onlyIfRequired', 'ignoreRemoteSession'\] as const;/.test(tsCat)
      && /func SignedTrue\(p map\[string\]any, k string\) bool \{\s*v, ok := p\[k\]\.\(bool\)\s*return ok && v\s*\}/.test(maint)
      && (tsCat.match(/ignoreRemoteSession: z\.literal\(true\)\.optional\(\),/g) ?? []).length === 2,
    'RestartFlags / RESTART_FLAGS, SignedTrue, and z.literal(true) on both catalog entries');
  check('restart exception: the agent honours it only from the signed plan, skipping only the session check',
    goNaming.sort().join(',') === 'internal/action/maintenance.go,internal/action/updates.go'
      && (strip(maint).match(/SignedTrue\(p\.Params, "ignoreRemoteSession"\)/g) ?? []).length === 2
      && (strip(upd).match(/SignedTrue\(p\.Params, "ignoreRemoteSession"\)/g) ?? []).length === 1
      && /if SignedTrue\(p\.Params, "ignoreRemoteSession"\) \{\s*sessionOverride\(o, r\)\s*\} else if pr := sessionCheck\("the restart"\)\(p, o\); pr != nil \{/.test(upd)
      && /if SignedTrue\(p\.Params, "ignoreRemoteSession"\) \{\s*sessionOverride\(o, &r\)\s*\}\s*journalStep\(o, p, "scheduling"\)\s*at, err := scheduleWarnedRestart\(p, o, minutes\)/.test(maint)
      && /func sessionOverride\(o Options, r \*Result\) \{\s*r\.Observed\["sessionOverride"\] = "true"/.test(maint),
    `only maintenance.go and updates.go may name it (found: ${goNaming.join(', ')}); the warning path is unchanged`);
  const pre = maint.slice(maint.indexOf('func rebootPrecheck('), maint.indexOf('\n}\n', maint.indexOf('func rebootPrecheck(')));
  check('only-if-required: the agent decides from Windows itself, and cannot tell means no restart',
    /Precheck:\s+rebootPrecheck,/.test(goCat) && pre.indexOf('o.Maint == nil') > 0 && pre.indexOf('o.Registry == nil') > pre.indexOf('o.Maint == nil')
      && /Reason: "reboot_state_unknown"/.test(pre) && /if len\(patch\.RebootSources\(o\.Registry, false\)\) == 0 \{\s*return &Result\{Outcome: "no_change", Reason: "no_restart_required"/.test(pre)
      && pre.indexOf('"onlyIfRequired"') < pre.indexOf('"ignoreRemoteSession"'),
    'rebootPrecheck: maintenance, then the registry, then pending sources, then (unless excepted) the session');
  check('restart flags need a 0.54 agent: the portal refuses them for an older one before signing',
    /export const RESTART_FLAGS_MIN_AGENT = '0\.54\.0';/.test(tsCat)
      && /if \(flags\.length && \(!ep\.agentVersion \|\| compareVersions\(ep\.agentVersion, RESTART_FLAGS_MIN_AGENT\) < 0\)\) \{\s*throw new ConflictException\(\{ code: 'ENDPOINT_NOT_READY'/.test(asvc)
      && asvc.indexOf('RESTART_FLAGS_MIN_AGENT) < 0') < asvc.indexOf('this.signer.submit(plan)'),
    'createPlan must refuse restart flags on an agent older than RESTART_FLAGS_MIN_AGENT');
  check('restart exception: under a policy only when the approved policy has it, for install and restart plans alike',
    (pp.match(/if \(params\.ignoreRemoteSession !== undefined && !\(params\.ignoreRemoteSession === true && doc\.ignoreRemoteSession === true\)\) return no\('override_not_allowed'/g) ?? []).length === 2
      && /ignoreRemoteSession: z\.literal\(true\)\.optional\(\)/.test(pp)
      && /if \(doc\.ignoreRemoteSession && doc\.reboot !== 'if_required_in_window' && !doc\.restart\) return \{ ok: false, reason: 'override_without_restart'/.test(pp),
    'evaluatePolicyPlan and evaluatePolicyRestartPlan both refuse override_not_allowed; validatePolicyDoc refuses an exception with no restart');
  const rp = pp.slice(pp.indexOf('function evaluatePolicyRestartPlan('), pp.indexOf('\n}\n', pp.indexOf('function evaluatePolicyRestartPlan(')));
  check('restart windows: the signer signs a policy restart only inside its window, with the fixed warning and the rule\'s own flags, a bounded number of times',
    rp.length > 0 && /params\.delayMinutes !== POLICY_RESTART_DELAY_MINUTES\) return no\('restart_params_not_allowed'/.test(rp)
      && /if \(rule === 'if_required' \? params\.onlyIfRequired !== true : params\.onlyIfRequired !== undefined\) return no\('restart_params_not_allowed'/.test(rp)
      && /no\('outside_restart_window'/.test(rp) && /no\('restart_already_signed'/.test(rp) && /if \(mine\.length >= MAX_RESTART_ATTEMPTS\) return no\('restart_retry_limit'/.test(rp)
      && /export const POLICY_RESTART_DELAY_MINUTES = UPDATE_RESTART_WARNING_MINUTES;/.test(pp) && /export const MAX_RESTART_ATTEMPTS = 3;/.test(pp)
      && /ATTEMPT_CHECK\b|CHECK \("attempt" BETWEEN 1 AND 3\)/.test(read('apps/api/prisma/migrations/0075_policy_restarts/migration.sql'))
      && /if \(r\.plan\.action\.id === REBOOT_SCHEDULE\.id && r\.plan\.action\.version === REBOOT_SCHEDULE\.version\) return evaluatePolicyRestartPlan\(/.test(pp),
    'evaluatePolicyRestartPlan must hold the window, the delay, the flags and the attempt cap; 0075 CHECKs the attempt');
  check('restart windows: the sweep asks only through createPlan under the policy, after the containment check',
    /if \(await this\.containment\.blocking\('actions', r\.customerId\)\) return;/.test(pol)
      && pol.indexOf("this.containment.blocking('actions', r.customerId)") < pol.indexOf('this.actions.createPlan(actor, {\n        action: REBOOT_SCHEDULE')
      && /underPolicy: \{ policyId: r\.id, digest: r\.digest, evidence: null \},/.test(pol)
      && !/this\.signer\.|signedPost|signUnderPolicy/.test(pol.slice(pol.indexOf('async proposeRestarts('), pol.indexOf('restartRequired(')))
      && /\.\.\.\(doc\.ignoreRemoteSession \? \{ ignoreRemoteSession: true as const \} : \{\}\),/.test(pol),
    'proposeRestarts: containment first, then ActionsService.createPlan with underPolicy, the exception only from the signed document');
  check('bulk restart: each computer is the Actions tab\'s own request, never a plan written here',
    /await this\.actions\.request\(a, t\.id, \{/.test(bulkR) && !/createPlan|signer|prisma/.test(strip(bulkR))
      && /ignoreRemoteSession: z\.literal\(true\)\.optional\(\),/.test(bulkR) && /onlyIfRequired: z\.literal\(true\)\.optional\(\),/.test(bulkR),
    'RestartBulkService calls ActionsService.request only');
  check('restart exception: the audit says it was used, in the request and in the result',
    /\.\.\.\(\(r\.params as \{ ignoreRemoteSession\?: unknown \}\)\.ignoreRemoteSession === true \? \{ ignoreRemoteSession: true \} : \{\}\),/.test(asvc)
      && /sessionOverride: true/.test(asvc)
      && /export const OVERRIDE_TEXT = 'restarted although a technician was connected through RustDesk'/.test(read('apps/api/src/tasks/lifecycle.ts')),
    'ACTION_REQUESTED carries ignoreRemoteSession, ACTION_RESULT sessionOverride, and Tasks says so');
  const ro = read('apps/web/components/endpoints/restart-options.tsx');
  const pr = read('apps/web/components/patching/policy-restart.tsx');
  const warnMin = (tsCat.match(/export const UPDATE_RESTART_WARNING_MINUTES = (\d+);/) ?? [])[1];
  const NOTE = (tsCat.match(/export const SIGNED_IN_USER_NOTE = `([^`]+)`;/) ?? [])[1]?.replace('${UPDATE_RESTART_WARNING_MINUTES}', warnMin);
  const LABEL = (tsCat.match(/export const IGNORE_REMOTE_SESSION_LABEL = '([^']+)';/) ?? [])[1];
  check('restart UI: the exception is never ticked by default, and the words agree with the catalog',
    !!NOTE && !!LABEL && NOTE.startsWith('A signed-in user does not stop the restart.')
      && ro.includes(`SIGNED_IN_USER_NOTE = '${NOTE}'`) && ro.includes(`IGNORE_REMOTE_SESSION_LABEL = '${LABEL}'`)
      && /onlyIfRequired: false, ignoreRemoteSession: false \}\)/.test(ro) && /ignoreRemoteSession: false \};/.test(pr)
      && !/defaultChecked|checked=\{true\}/.test(ro + pr)
      && /\.\.\.\(v\.ignoreRemoteSession \? \{ ignoreRemoteSession: true \} : \{\}\)/.test(ro),
    'restart-options.tsx and policy-restart.tsx default the box to unticked and send the flag only when ticked');
  const unitR = (() => { try { return read('apps/api/scripts/unit-restart-windows.mjs'); } catch { return ''; } })();
  check('restart windows: the suites run, and pre-0.54 policy documents keep their digest',
    /unit-restart-windows\.mjs/.test(read('.github/workflows/ci.yml')) && / service-process task-progress restart-windows; do/.test(read('scripts/run-e2e.sh'))
      && /P\.policyDigest\(parsed\) === '466423a5bb889e289b536d62ac25ddf66450179770f1161c576003fc3644f99b'/.test(unitR),
    'unit-restart-windows.mjs in CI (pinning the 0.52 digest), e2e-restart-windows.mjs in run-e2e.sh');
}

// ─── §68 (0.55): alert conditions and automatic PSA tickets ──────────────────
//     Four monitor kinds read only what the server already stores (inventory
//     drives, the live sample's boot time, the signed patch scan, deployment
//     results) — no agent change. A drive monitor's alerts are one per drive,
//     the drive letter charset-checked before it reaches a dedup key. An
//     automatic ticket is at most one per alert (a unique index), only for an
//     open alert first seen after its rule was switched on, after the notify
//     hold, outside every maintenance window and site outage, never under a
//     notifications pause, inside a per-business hourly budget, audited before
//     the send with ids only, through the same driver and draft as "Create
//     ticket", and retried a bounded number of times. It runs only inside the
//     monitoring sweep. Changing the rule needs fresh authentication.
{
  const eng = read('apps/api/src/monitoring/engine.ts');
  const msvc = read('apps/api/src/monitoring/monitoring.service.ts');
  const at = read('apps/api/src/monitoring/alert-tickets.service.ts');
  const psvc = read('apps/api/src/psa/psa.service.ts');
  const madm = read('apps/api/src/monitoring/monitoring-admin.service.ts');
  const mctl = read('apps/api/src/monitoring/monitoring.controller.ts');
  const sql = read('apps/api/prisma/migrations/0076_alert_conditions/migration.sql');
  const cat = read('apps/api/src/security-controls/confirm-catalog.ts');
  const ovw = read('apps/api/src/dashboard/overview.service.ts');
  const sliceFrom = (src, sig) => { const i = src.indexOf(sig); const j = src.indexOf('\n  }\n', i); return i < 0 ? '' : src.slice(i, j); };
  const tk = sliceFrom(psvc, '  async alertTicket(');
  const pass = sliceFrom(at, '  async pass(');

  check('alert conditions: a drive letter reaches a dedup key only through the charset (one letter and a colon)',
    /const DRIVE_LETTER = \/\^\[A-Z\]:\$\/;/.test(eng) && /const DRIVE_INPUT = \/\^\[A-Za-z\]:\?\$\/;/.test(eng)
      && /export const driveKeyOf = \(ruleKey: string, endpointId: string, drive: string\) => `\$\{drivePrefixOf\(ruleKey, endpointId\)\}\$\{drive\.slice\(0, 1\)\}`;/.test(eng)
      && /if \(!DRIVE_LETTER\.test\(drive\) \|\| seen\.has\(drive\)\) continue;/.test(eng),
    'engine.ts DRIVE_LETTER / DRIVE_INPUT, driveKeyOf, and evaluateDrives skipping anything else');
  check('alert conditions: the new kinds read stored data only — nothing new is asked of the agent',
    /const AGENT_KINDS: ReadonlySet<string> = new Set\(\['SERVICE_STOPPED', 'EVENT_MATCH'\]\);/.test(msvc)
      && /const INVENTORY_KINDS: ReadonlySet<string> = new Set\(\['DRIVE_FREE', 'UPTIME_LONG', 'UPDATES_MISSING', 'UPDATE_FAILED'\]\);/.test(msvc),
    'AGENT_KINDS is unchanged; the four 0.55 kinds are INVENTORY_KINDS, evaluated by the sweep');
  check('alert conditions: the recommended set is still created only on a click, and uptime is not in it',
    !/UPTIME_LONG/.test((eng.match(/export const RECOMMENDED[\s\S]*?\n\];/) ?? [''])[0])
      && /\{ key: 'drive-free', kind: 'DRIVE_FREE'/.test(eng),
    'RECOMMENDED adds drive-free, updates-missing, update-failed; addRecommended is still the only creator (§17)');

  check('auto tickets: one per alert, in the database',
    /CREATE UNIQUE INDEX "MonitorAlertTicket_alertId_key" ON "MonitorAlertTicket"\("alertId"\);/.test(sql)
      && /CHECK \("attempts" BETWEEN 1 AND 4\)/.test(sql) && /\n  maxAttempts: 4,\n/.test(eng)
      && /CHECK \("status" IN \('sending', 'sent', 'failed', 'gave_up'\)\)/.test(sql)
      && /CHECK \("nextAttemptAt" IS NULL OR "status" = 'failed'\)/.test(sql),
    '0076: unique alertId, attempts 1–4 (AUTO_TICKET.maxAttempts), closed status, a retry time only on failed');
  check('auto tickets: run only inside the monitoring sweep (MONITOR_SWEEP=off stops them)',
    /await this\.notifyPass\(now\);\s*\n(\s*\/\/[^\n]*\n)*\s*await this\.tickets\.pass\(now\);/.test(msvc)
      && (read('apps/api/src/monitoring/monitoring.service.ts').match(/this\.tickets\.pass\(/g) ?? []).length === 1
      && !/setInterval|setTimeout|@Cron|@Interval/.test(at),
    'MonitoringService.sweep calls AlertTicketsService.pass once, after notifyPass; the service has no timer');
  check('auto tickets: rule → notifications pause → budget → alertTicket, in that order',
    pass.indexOf('autoTicketDecision(') > 0
      && pass.indexOf("activePause(this.prisma, 'notifications', a.customerId)") > pass.indexOf('autoTicketDecision(')
      && pass.indexOf('if (n >= this.perHour()) continue;') > pass.indexOf("activePause(")
      && pass.indexOf('this.psa.alertTicket(') > pass.indexOf('this.perHour()')
      && /firstSeenAt: \{ gte: earliest \}/.test(pass) && /kind: \{ not: 'SITE_OUTAGE' \}/.test(pass) && /notifyFrom: \{ lte: now \}/.test(pass),
    'AlertTicketsService.pass: decision, pause, per-business budget, then the PSA');
  check('auto tickets: the decision holds the rule, the backlog, the notify hold, outages and maintenance windows',
    ['no_rule', 'off', 'resolved', 'no_computer', 'before_rule', 'severity', 'kind', 'held', 'in_outage', 'maintenance'].every((r) => eng.includes(`reason: '${r}'`))
      && /if \(a\.notifyFrom > now\) return \{ ok: false, reason: 'held' \};/.test(eng),
    'autoTicketDecision names every reason; notifyFrom in the future is held');
  check('auto tickets: claim → logOrFail → the one send; a failure is recorded and retried with backoff',
    tk.indexOf('this.monitorAlertTicket.create(') < 0 && tk.indexOf('this.prisma.monitorAlertTicket.create(') > 0
      && /if \(\(e as \{ code\?: string \}\)\.code === 'P2002'\) return \{ attempted: false, status: 'claimed' \};/.test(tk)
      && /where: \{ id: prior\.id, status: 'failed', attempts: prior\.attempts \}/.test(tk)
      && tk.indexOf("action: 'PSA_AUTO_TICKET_REQUESTED'") > tk.indexOf('monitorAlertTicket.create(')
      && tk.indexOf('this.audit.logOrFail(') > 0 && tk.indexOf('drv.send(') > tk.indexOf("action: 'PSA_AUTO_TICKET_REQUESTED'")
      && (tk.match(/drv\.send\(/g) ?? []).length === 1 && /const retryAt = autoTicketRetryAt\(attempt, now\);/.test(tk),
    'PsaService.alertTicket: unique claim (or a conditional update from failed), PSA_AUTO_TICKET_REQUESTED with logOrFail, then drv.send');
  check('auto tickets: the draft is a manual alert ticket\'s — no detail, no note, no AI — and audit meta carries ids only',
    /detail: null, firstSeenAt: a\.firstSeenAt\.toISOString\(\) \}/.test(tk) && /requestedBy: AUTO_REQUESTER, ai: null \}/.test(tk)
      && !/note:/.test(tk.slice(tk.indexOf('buildDraft('), tk.indexOf('const base')))
      && !/subject|body|title|draft\.(subject|body)|note|text/.test((tk.match(/const ids = \{[^\n]*\};/) ?? ['x'])[0].replace(/sourceRef: draft\.sourceRef/, ''))
      && /meta: \{ \.\.\.ids, status: r\.status, retryAt:/.test(tk) && /meta: \{ \.\.\.ids, ticketId: ticket\.id, ref: ticket\.ref, status: r\.status \}/.test(tk),
    'buildDraft with detail null, ai null, no note; ids = connector, source, sourceRef, alertId, endpointId, kind, severity, attempt');
  check('auto tickets: changing or removing the rule needs fresh authentication under its own catalog key, and is audited',
    (mctl.match(/assertFresh\([^;]*?action: 'monitoring\.autoticket'/g) ?? []).length === 1
      && /@Put\('ticket-policy'\)\s*\n\s*async putTicketPolicy\([^\n]*\) \{\s*\n\s*this\.freshTicket\(req\);/.test(mctl)
      && /@Delete\('ticket-policy'\)\s*\n\s*async removeTicketPolicy\([^\n]*\) \{\s*\n\s*this\.freshTicket\(req\);/.test(mctl)
      && /key: 'monitoring\.autoticket', group: 'Monitoring & notifications', label: '[^']+', default: 'off'/.test(cat)
      && (madm.match(/action: 'MONITOR_TICKET_POLICY_CHANGED'/g) ?? []).length === 2
      && /this\.assertPolicy\(a, customerId\);/.test(sliceFrom(madm, '  async putTicketPolicy(')),
    'monitoring.controller freshTicket (monitoring.autoticket); putTicketPolicy/removeTicketPolicy: assertPolicy, logOrFail');
  check('auto tickets: switching on starts the clock (no backlog), and 0076 holds it',
    /const enabledAt = d\.data\.enabled \? \(cur\?\.enabled && cur\.enabledAt \? cur\.enabledAt : new Date\(\)\) : null;/.test(madm)
      && /CHECK \(NOT "enabled" OR "enabledAt" IS NOT NULL\)/.test(sql),
    'putTicketPolicy sets enabledAt when turning on; MonitorTicketPolicy_enabledAt CHECK');
  check('dashboard recent alerts: monitoring:alerts AND the device visibility rule',
    /where: \{ AND: \[active, \{ OR: \[\{ endpointId: null \}, \{ endpoint: this\.acl\.endpointVisibilityWhere\(actor, scope\) \}\] \}\] \}/.test(ovw)
      && /recentAlerts: active\s*\n?\s*\?/.test(ovw),
    'overview.service.ts recentAlerts inside `active` (the alerts list where) and endpointVisibilityWhere');
  check('alert conditions: the suites run',
    /unit-alert-conditions\.mjs/.test(read('.github/workflows/ci.yml')) && / alert-tickets[ ;]/.test(read('scripts/run-e2e.sh')),
    'unit-alert-conditions.mjs in CI, e2e-alert-tickets.mjs in run-e2e.sh');
}

// 69. Hardware warranty and support links (0.56). A computer's serial number
//     leaves this server only to a hardware vendor a Platform Admin switched
//     on, and nothing else about the computer goes with it:
//       - the support-link table is one pure module with a byte-identical web
//         copy; links are https to a fixed vendor host list, the serial goes
//         into a URL only for Dell, after its own charset check, through
//         encodeURIComponent, and every vendor link opens with
//         rel="noopener noreferrer";
//       - the vendor APIs are called only from warranty/client.ts, only through
//         safe-https (safeGet / safePost), with a bound and a cap; the test
//         base URL only through testLoopbackAllowed; lookup() takes the
//         serial as a string and nothing else about the computer;
//       - the credential is sealed with its own purpose, never in a response
//         or audit row (last four only), and setting it is a Platform Admin's
//         with assertFresh naming warranty.settings (§ 62);
//       - the sweep is off with WARRANTY_SWEEP=off, bounded per hour and per
//         computer (30 days), skips a business under an integration pause,
//         claims each computer with a conditional write, and never overwrites
//         a manual entry; "Check now" checks the pause too;
//       - a manual entry needs computers:edit on the computer and is audited
//         with before and after; 0077 CHECKs the source, the dates, the
//         coverage charset and the vendor list;
//       - the report is scoped by endpointVisibilityWhere; WARRANTY_EXPIRING
//         is opt-in (never in RECOMMENDED) and the 0.36 SWEEP_KINDS set is
//         unchanged.
{
  const strip = (x) => x.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
  const vApi = read('apps/api/src/warranty/vendors.ts');
  const vWeb = read('apps/web/lib/hardware-support.ts');
  check('warranty: the support-link table has one copy for the API and an identical one for the web, with no imports',
    vApi === vWeb && !/^import /m.test(vApi) && !/\brequire\(/.test(vApi),
    'apps/api/src/warranty/vendors.ts and apps/web/lib/hardware-support.ts must be byte-identical and import nothing');
  const urls = [...vApi.matchAll(/'(https?:\/\/[^'`]+)'/g)].map((m) => m[1]);
  const hosts = (vApi.match(/export const VENDOR_HOSTS = \[([\s\S]*?)\] as const;/) ?? [])[1] ?? '';
  const hostList = [...hosts.matchAll(/'([a-z0-9.-]+)'/g)].map((m) => m[1]);
  const badUrls = urls.filter((u) => { try { const x = new URL(u); return x.protocol !== 'https:' || !hostList.includes(x.hostname); } catch { return true; } });
  check('warranty: every support link is https to a host on VENDOR_HOSTS',
    urls.length >= 12 && hostList.length >= 8 && badUrls.length === 0, `not https or not on VENDOR_HOSTS: ${badUrls.join(', ')}`);
  const dellFn = vApi.slice(vApi.indexOf("if (maker.vendor === 'dell') {"), vApi.indexOf('const f = FIXED[maker.vendor];'));
  const interp = [...strip(vApi).matchAll(/\$\{([^}]+)\}/g)].map((m) => m[1]).filter((x) => /serial|tag/i.test(x));
  check('warranty: only Dell puts the serial in a link, after DELL_TAG_RE, through encodeURIComponent',
    /if \(serial && DELL_TAG_RE\.test\(serial\)\) \{\s*const tag = encodeURIComponent\(serial\);/.test(dellFn)
      && interp.every((x) => x === 'tag') && /export const DELL_TAG_RE = \/\^\[A-Za-z0-9\]\{7\}\$\/;/.test(vApi)
      && /export const SERIAL_RE = \/\^\[A-Za-z0-9-\]\{4,40\}\$\/;/.test(vApi) && /if \(!s \|\| PLACEHOLDER\.test\(s\) \|\| !SERIAL_RE\.test\(s\)\) return null;/.test(vApi),
    `serial interpolations: ${interp.join(', ')}`);
  const anchors = ['apps/web/components/endpoints/warranty-card.tsx', 'apps/web/components/endpoints/list/columns.tsx'].map((f) => [f, read(f)]);
  const badA = anchors.flatMap(([f, src]) => [...src.matchAll(/<a\s[^>]*href=\{(?:k|link)\.url\}[^>]*>/g)].filter((m) => !/target="_blank"/.test(m[0]) || !/rel="noopener noreferrer"/.test(m[0])).map(() => f));
  const count = anchors.reduce((n, [, src]) => n + (src.match(/<a\s[^>]*href=\{(?:k|link)\.url\}/g) ?? []).length, 0);
  check('warranty: every vendor link in the console opens in a new tab with rel="noopener noreferrer"',
    count === 2 && badA.length === 0, `${count} vendor anchors; without target/rel: ${badA.join(', ')}`);

  const files = walk('apps/api/src');
  const cl = read('apps/api/src/warranty/client.ts');
  const hostHits = files.filter((f) => /apigtwb2c\.us\.dell\.com|supportapi\.lenovo\.com|WARRANTY_TEST_BASE_URL/.test(strip(read(f))) && f !== 'apps/api/src/warranty/client.ts');
  check('warranty: vendor API hosts and the test base URL appear only in warranty/client.ts', hostHits.length === 0, hostHits.join(', '));
  const wFiles = files.filter((f) => f.startsWith('apps/api/src/warranty/'));
  const raw = wFiles.filter((f) => /\bfetch\(|\bhttps?\.request\(|axios|got\(|undici/.test(read(f)));
  check('warranty: no fetch or raw request in warranty/ — only safeGet / safePost', raw.length === 0, raw.join(', '));
  const callers = files.filter((f) => /\bsafe(Get|Post)\(/.test(read(f)) && !f.endsWith('common/safe-https.ts'));
  // 0.80: an MDM driver (mdm/drivers/, §90) may also GET; in 0.80 only the loopback stand-in does.
  check('warranty: safeGet is called only by warranty/client.ts (and MDM drivers, §90), with the 20 s bound and the 256 KB cap',
    files.filter((f) => /\bsafeGet\(/.test(read(f)) && !f.endsWith('common/safe-https.ts')).every((f) => f === 'apps/api/src/warranty/client.ts' || f.startsWith('apps/api/src/mdm/drivers/'))
      && /export const WARRANTY_TIMEOUT_MS = 20_000;/.test(cl) && /export const WARRANTY_MAX_RESPONSE = 256 \* 1024;/.test(cl)
      && /const OPTS = \{ timeoutMs: WARRANTY_TIMEOUT_MS, maxBytes: WARRANTY_MAX_RESPONSE \};/.test(cl)
      && (cl.match(/\bsafe(Get|Post)\(/g) ?? []).length === 9 && (cl.match(/safe(Get|Post)\([^;]*OPTS\)/g) ?? []).length === 9 && callers.includes('apps/api/src/warranty/client.ts'),
    'client.ts: nine vendor requests (Dell token + entitlements, Lenovo; 0.61: HP token, job, status, results; Apple token, coverage), each with OPTS');
  const sh = read('apps/api/src/common/safe-https.ts');
  const req = sh.slice(sh.indexOf('async function safeRequest('));
  check('safe-https: safeGet goes through the same checked request as safePost (no second client)',
    /export async function safeGet\([^)]*\): Promise<SafeResponse> \{\s*return safeRequest\('GET', rawUrl, headers, null, opts\);\s*\}/.test(sh)
      && /export async function safePost\([^)]*\): Promise<SafeResponse> \{\s*return safeRequest\('POST', rawUrl, headers, body, opts\);\s*\}/.test(sh)
      && req.indexOf('checkPublicHttpsUrl(rawUrl)') > 0 && /const r = checkResolved\(addrs, 'none'\);/.test(req),
    'safeGet/safePost both return safeRequest(...)');
  check('warranty: WARRANTY_TEST_BASE_URL is honoured only through testLoopbackAllowed',
    /const v = process\.env\.WARRANTY_TEST_BASE_URL;\s*\n\s*return v && testLoopbackAllowed\(v\)/.test(cl) && (cl.match(/WARRANTY_TEST_BASE_URL/g) ?? []).length <= 3,
    'client.ts testBase()');
  check('warranty: lookup takes the serial as a string and nothing else about the computer; each request carries only it',
    /export async function lookup\(vendor: LookupVendor, creds: Credentials, serial: string\): Promise<LookupResult>/.test(cl)
      && /\/PROD\/sbil\/eapi\/v5\/asset-entitlements\?servicetags=\$\{encodeURIComponent\(serial\)\}`/.test(cl)
      && /\/v2\.5\/warranty\?Serial=\$\{encodeURIComponent\(serial\)\}`/.test(cl)
      && /new URLSearchParams\(\{ grant_type: 'client_credentials', client_id: c\.clientId, client_secret: c\.secret \}\)/.test(cl)
      // 0.61: Apple's host and scope name "business"; nothing else may.
      && !/endpoint|hostname|customer|business/i.test(strip(cl).replace(/asset-entitlements|api-business\.apple\.com|'business\.api'/g, '')),
    'client.ts must not take or send anything but the serial (and the vendor credential)');
  const svc = read('apps/api/src/warranty/warranty.service.ts');
  const lookCalls = [...svc.matchAll(/await lookup\(([^)]*)\)/g)].map((m) => m[1]);
  check('warranty: the service asks the vendor in one place, with the serial alone',
    lookCalls.length === 1 && lookCalls[0] === 'vendor, creds, serial' && files.filter((f) => (f.startsWith('apps/api/src/warranty/') && /from '\.\/client'/.test(read(f))) || /from '[./]*warranty\/client'/.test(read(f))).every((f) => f === 'apps/api/src/warranty/warranty.service.ts'),
    `lookup calls: ${lookCalls.join(' | ')}`);
  check('warranty: the credential is sealed with its own purpose; only its last four characters are kept in the clear',
    /secretEnc = sealSecret\(this\.encKey, 'rem0te-warranty-key-v1', given\); secretLast4 = last4\(given\);/.test(svc)
      && /const last4 = \(s: string\) => s\.replace\(\/-----\[A-Z \]\+-----\|\\s\/g, ''\)\.slice\(-4\);/.test(svc)
      && (svc.match(/sealSecret\(/g) ?? []).length === 1
      && /openSecret\(this\.encKey, 'rem0te-warranty-key-v1', v\.secretEnc\)/.test(svc)
      && /'rem0te-warranty-key-v1'/.test(read('apps/api/src/common/secret-box.ts')),
    'warranty.service putVendor()/credentials()');
  const vview = svc.slice(svc.indexOf('  private vendorView('), svc.indexOf('  async settings()'));
  const putV = svc.slice(svc.indexOf('  async putVendor('));
  check('warranty: no response carries the credential or its ciphertext; the audit says only whether it changed',
    vview.length > 100 && !/secretEnc:|secret:|\.\.\.v\b/.test(vview) && /secretSet: !!v\?\.secretEnc, secretLast4: v\?\.secretEnc \? v\.secretLast4 : null/.test(vview)
      && /meta: \{ vendor, before: pub\(cur\), after: pub\(row\), key: keyChange \}/.test(putV)
      && /const pub = \(s: WarrantyVendor \| null\) => s && \{ enabled: s\.enabled, clientIdSet: !!s\.clientId, keyIdSet: !!s\.keyId \};/.test(putV),
    'vendorView() / WARRANTY_SETTINGS_CHANGED meta');
  check('warranty: nothing in warranty/ logs a credential or a serial (the one Logger prints only the sweep error message)',
    wFiles.every((f) => !/console\./.test(read(f))) && (svc.match(/this\.logger\.\w+\(/g) ?? []).length === 1 && /this\.logger\.error\(`warranty sweep: \$\{\(e as Error\)\.message\}`\)/.test(svc),
    'warranty/*.ts');
  const ctl = read('apps/api/src/warranty/warranty.controller.ts');
  check('warranty: settings are a Platform Admin\'s (class guard), with assertFresh first, naming warranty.settings',
    /@Controller\('warranty\/settings'\)\s*\n@UseGuards\(PlatformAdminGuard\)/.test(ctl)
      && /@Put\(':vendor'\)\s*\n\s*@RateLimit\(20\)\s*\n\s*async put\([^\n]*\) \{\s*\n\s*const u = [^\n]*\n\s*assertFresh\([^\n]*\{ action: 'warranty\.settings'/.test(ctl)
      && /key: 'warranty\.settings', group: 'Integrations'/.test(read('apps/api/src/security-controls/confirm-catalog.ts')),
    'WarrantySettingsController');
  check('warranty: a computer\'s warranty is read with computers:view and changed with computers:edit, on that computer',
    /async get\(actor: ActorContext, endpointId: string\) \{\s*await this\.acl\.assertEndpointInScope\(actor, endpointId, CAP\.COMPUTERS_VIEW\);/.test(svc)
      && /async setManual\(actor: ActorContext, endpointId: string, raw: unknown\) \{\s*const ep = await this\.acl\.assertEndpointInScope\(actor, endpointId, CAP\.COMPUTERS_EDIT\);/.test(svc)
      && /async checkNow\(actor: ActorContext, endpointId: string\) \{\s*const ep = await this\.acl\.assertEndpointInScope\(actor, endpointId, CAP\.COMPUTERS_EDIT\);/.test(svc)
      && /@Put\(\)\s*\n\s*@RequireCapability\(CAP\.COMPUTERS_EDIT\)/.test(ctl) && /@Post\('lookup'\)\s*\n\s*@HttpCode\(HttpStatus\.OK\)\s*\n\s*@RequireCapability\(CAP\.COMPUTERS_EDIT\)/.test(ctl),
    'WarrantyController / WarrantyService get/setManual/checkNow');
  const setM = svc.slice(svc.indexOf('  async setManual('), svc.indexOf('  async checkNow('));
  check('warranty: a manual entry is a conditional write audited with before and after (logOrFail)',
    /const w = await this\.prisma\.endpoint\.updateMany\(\{\s*where: \{ id: endpointId, warrantySource: cur\.warrantySource, warrantyEndsAt: cur\.warrantyEndsAt, warrantyStartsAt: cur\.warrantyStartsAt \},/.test(setM)
      && /action: 'WARRANTY_SET'/.test(setM) && /meta: \{ before: pub\(cur\), after: pub\(\{ \.\.\.cur, \.\.\.data \}\), cleared: clear \}/.test(setM) && /await this\.audit\.logOrFail\(/.test(setM),
    'setManual()');
  const tick = svc.slice(svc.indexOf('  private async tick('), svc.indexOf('  // ── Settings'));
  const lands = svc.slice(svc.indexOf('  private async lookupAndStore('), svc.indexOf('  // ── The sweep'));
  const chk = svc.slice(svc.indexOf('  async checkNow('), svc.indexOf('  private async credentials('));
  check('warranty: the sweep is off with WARRANTY_SWEEP=off, bounded per hour and per computer, and claims each computer conditionally',
    /if \(process\.env\.WARRANTY_SWEEP === 'off'\) return;/.test(svc) && /export const LOOKUP_INTERVAL_DAYS = 30;/.test(svc)
      && /let left = budget\(perHour\(\), used\);/.test(tick) && /return Math\.max\(0, Math\.min\(PER_TICK_MAX, limitPerHour - usedLastHour\)\);/.test(svc)
      && /Math\.min\(n, 500\) : 60;/.test(svc)
      && /const claim = await this\.prisma\.endpoint\.updateMany\(\{\s*where: \{ id: e\.id, OR: \[\{ warrantyLookupAt: null \}, \{ warrantyLookupAt: \{ lt: cutoff \} \}\] \},/.test(tick)
      && tick.indexOf('if (!claim.count) continue;') < tick.indexOf('await this.lookupAndStore('),
    'WarrantyService onModuleInit / tick');
  check('warranty: an integration pause stops the lookup (sweep and Check now) before anything is sent',
    tick.indexOf("activePause(this.prisma, 'integration', e.customerId)") > 0 && tick.indexOf("activePause(this.prisma, 'integration', e.customerId)") < tick.indexOf('await this.lookupAndStore(')
      && chk.indexOf("activePause(this.prisma, 'integration', ep.customerId)") > 0 && chk.indexOf("activePause(this.prisma, 'integration', ep.customerId)") < chk.indexOf('await this.lookupAndStore('),
    'tick() and checkNow() must consult activePause(integration) before lookupAndStore');
  check('warranty: a vendor answer never overwrites a manual entry; the sweep never picks one',
    /where: \{ id: e\.id, OR: \[\{ warrantySource: null \}, \{ warrantySource: \{ not: 'manual' \} \}\] \},/.test(lands)
      && /OR: \[\{ warrantySource: null \}, \{ warrantySource: \{ not: 'manual' \} \}\],/.test(tick)
      && /if \(e\.warrantySource === 'manual'\) throw new ConflictException\(\{ code: 'WARRANTY_MANUAL'/.test(chk),
    'lookupAndStore / tick / checkNow');
  const mig = read('apps/api/prisma/migrations/0077_warranty/migration.sql');
  check('0077 CHECKs the source, the dates, the coverage charset and the vendor list',
    /CHECK \("warrantySource" IS NULL OR "warrantySource" IN \('manual', 'dell', 'lenovo'\)\)/.test(mig)
      && /"warrantyStartsAt" <= "warrantyEndsAt"/.test(mig) && /char_length\("warrantyCoverage"\) <= 200/.test(mig)
      && /CHECK \("vendor" IN \('dell', 'lenovo'\)\)/.test(mig) && /CHECK \(NOT "enabled" OR "secretEnc" IS NOT NULL\)/.test(mig),
    'migration 0077 (0082 widens the two vendor lists to exactly LOOKUP_VENDORS: § 74)');
  const rep = read('apps/api/src/reports/reports.service.ts');
  const wr = rep.slice(rep.indexOf('  private async warrantyRows('), rep.indexOf('  async warranty('));
  check('warranty: the report reads only the caller\'s visible computers (devicesWhere → endpointVisibilityWhere)',
    /where: this\.devicesWhere\(actor, q\),/.test(wr) && /this\.acl\.endpointVisibilityWhere\(actor, q\.businessId\)/.test(rep)
      && /@Get\('warranty'\)\s*\n\s*@RequireCapability\(CAP\.COMPUTERS_VIEW\)/.test(read('apps/api/src/reports/reports.controller.ts')),
    'ReportsService.warrantyRows');
  const eng = read('apps/api/src/monitoring/engine.ts');
  const recBlock = eng.slice(eng.indexOf('export const RECOMMENDED'), eng.indexOf('\n];', eng.indexOf('export const RECOMMENDED')));
  check('warranty: WARRANTY_EXPIRING is opt-in (not in RECOMMENDED), and the 0.36 sweep-kind set is unchanged',
    /WARRANTY_EXPIRING: z\.object\(\{ daysBefore: ints\(1, 365\)\.default\(30\) \}\)\.strict\(\),/.test(eng) && !/WARRANTY/.test(recBlock)
      && /const SWEEP_KINDS = new Set\(\['OFFLINE', 'REBOOT_PENDING', 'AGENT_SILENT'\]\);/.test(read('apps/api/src/monitoring/monitoring.service.ts'))
      && /ALTER TYPE "MonitorKind" ADD VALUE 'WARRANTY_EXPIRING';/.test(mig),
    'engine.ts PARAMS / RECOMMENDED; monitoring.service SWEEP_KINDS');
  check('warranty: the suites run — unit in CI, e2e in run-e2e.sh with the sweep off for everything else',
    /unit-warranty\.mjs/.test(read('.github/workflows/ci.yml')) && / warranty[ ;]/.test(read('scripts/run-e2e.sh'))
      && /^export WARRANTY_SWEEP=off$/m.test(read('scripts/run-e2e.sh')),
    'ci.yml / run-e2e.sh');
}

// 70. Device discovery and adoption (0.57). A computer in the unassigned pool
//     (tenant null OR business null) is seen only by a Platform Admin, is
//     handed nothing to do by its heartbeat but the automatic inventory, and
//     is refused by every remote and action path (ENDPOINT_UNASSIGNED) until
//     a Platform Admin adopts it — with a fresh sign-in, conditionally (only
//     from the pool), audited per computer. Deployment keys are stored as a
//     hash, at most 90 days and 10,000 uses, review by default, and a use is
//     one conditional UPDATE. Assignment rules read only four explicit facts
//     — never who is signed in or an e-mail address — and are suggestions;
//     nothing applies one by itself.
{
  const SRC = 'apps/api/src';
  const strip = (s) => s.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
  const una = read(`${SRC}/common/unassigned.ts`);
  const mig = read('apps/api/prisma/migrations/0078_device_adoption/migration.sql');
  const enr = read(`${SRC}/enrollment/enrollment.service.ts`);
  const hb = enr.slice(enr.indexOf('  async heartbeat('), enr.indexOf('  async authenticateDevice('));
  const ad = read(`${SRC}/adoption/adoption.service.ts`);
  const dk = read(`${SRC}/adoption/deployment-keys.service.ts`);
  const key = read(`${SRC}/adoption/deployment-key.ts`);
  const map = read(`${SRC}/adoption/mapping.ts`);
  const ctl = read(`${SRC}/adoption/adoption.controller.ts`);

  check('adoption: the pool is tenant null OR business null, refused as ENDPOINT_UNASSIGNED',
    /export const UNASSIGNED_WHERE: Prisma\.EndpointWhereInput = \{ OR: \[\{ tenantId: null \}, \{ customerId: null \}\] \};/.test(una)
      && /return !ep\.customerId \|\| !ep\.tenantId;/.test(una)
      && /throw new ForbiddenException\(\{ code: ENDPOINT_UNASSIGNED, message: UNASSIGNED_MESSAGE \}\)/.test(una),
    'common/unassigned.ts UNASSIGNED_WHERE / isUnassigned / assertAssigned');

  const chokes = {
    'sessions/sessions.service.ts': /assertAssigned\(endpoint\)/,
    'actions/actions.service.ts': /if \(ep\) assertAssigned\(ep\);/,
    'diagnostics-catalog/diagnostics-catalog.service.ts': /assertAssigned\(/,
    'device-control/device-control.service.ts': /if \(ep\) assertAssigned\(ep\)/,
    'software/software.service.ts': /if \(ep\) assertAssigned\(ep\)/,
    'patching/patching.service.ts': /if \(owner\) assertAssigned\(owner\);/,
    'tray/tray.service.ts': /assertAssigned\(dev\);[\s\S]*assertAssigned\(dev\);[\s\S]*assertAssigned\(ep\);|assertAssigned\(ep\);[\s\S]*assertAssigned\(dev\);[\s\S]*assertAssigned\(dev\);/,
    'endpoints/endpoints.service.ts': /reason: 'endpoint_unassigned'/,
    'quick-connect/quick-connect.service.ts': /async refusePooled\(/,
    'launcher/launcher.service.ts': /this\.quickConnect\.refusePooled\(/,
  };
  const missing = Object.entries(chokes).filter(([f, re]) => !re.test(strip(read(`${SRC}/${f}`)))).map(([f]) => f);
  const sw = strip(read(`${SRC}/software/software.service.ts`));
  check('adoption: every remote and action path refuses a pooled computer',
    !missing.length && (sw.match(/if \(ep\) assertAssigned\(ep\)/g) ?? []).length >= 4
      && /if \(ep && kind === 'WRITE'\) assertAssigned\(ep\);/.test(strip(read(`${SRC}/endpoints/endpoints.service.ts`)))
      && /code: 'USE_ADOPTION'/.test(read(`${SRC}/endpoints/endpoints.service.ts`))
      && /^\s+await this\.refusePooled\(rustdeskId\);/m.test(read(`${SRC}/quick-connect/quick-connect.service.ts`)),
    `missing the refusal: ${missing.join(', ') || '(software ×4, admitWrite WRITE, USE_ADOPTION, Quick Connect connect)'}`);

  const iPooled = hb.indexOf('if (authenticated && pooled) {'), iRotate = hb.indexOf('let rotate:');
  const branch = hb.slice(iPooled, hb.indexOf('\n    }\n', iPooled));
  check('adoption: a pooled heartbeat is handed only the automatic inventory and returns before any other step',
    iPooled > 0 && iPooled < iRotate
      && /const pooled = !!identity && isUnassigned\(identity\);/.test(hb)
      && /rotate: null, updateRustdesk: null, reinstallAgent: null,/.test(branch)
      && /actions: \[\], actionAcks: \[\], patchPostureAck: null, patchScan: false,/.test(branch)
      && /monitor: null, diagnostics: \[\], chat: null, tray: null,/.test(branch)
      && /pending: true/.test(branch)
      && !/prisma\.|assignTray|trayKey|migration|agentUpgrade|monitor\.|actions\./.test(strip(branch).replace(/this\.inventory\.(recordLiveState|collectForHeartbeat)/g, '')),
    'enrollment.service heartbeat: `if (authenticated && pooled)` before rotation, every flag null');

  check('adoption: the pool, the rules and the keys are a Platform Admin\'s, and the three writes need a fresh sign-in',
    (ad.match(/this\.acl\.assertPlatformAdmin\(actor\);/g) ?? []).length >= 6 && (dk.match(/this\.acl\.assertPlatformAdmin\(actor\);/g) ?? []).length >= 3
      && /assertFresh\(freshMethod, \{[^;]*?action: 'devices\.adopt'/.test(ad) && /assertFresh\(freshMethod, \{[^;]*?action: 'adoption\.mappings'/.test(ad)
      && /assertFresh\(freshMethod, \{[^;]*?action: 'deployment\.keys'/.test(dk)
      && /@UseGuards\(JwtAuthGuard\)/.test(ctl),
    'AdoptionService and DeploymentKeysService: assertPlatformAdmin on every method, assertFresh on adopt/forget, rule create, key create');

  const adopt = ad.slice(ad.indexOf('  async adopt('), ad.indexOf('  async forget('));
  check('adoption: adopting and forgetting move a computer only from the pool, and each is audited',
    /tx\.endpoint\.updateMany\(\{\s*where: \{ AND: \[\{ id: endpointId \}, UNASSIGNED_WHERE, \{ status: \{ not: 'ARCHIVED' \} \}\] \},/.test(adopt)
      && /action: 'ENDPOINT_ADOPTED'/.test(adopt) && /approvedBy: actor\.userId/.test(adopt) && /deploymentKeyId/.test(adopt) && /mappingId/.test(adopt) && /before/.test(adopt) && /after/.test(adopt)
      && !/tx\.endpoint\.update\(/.test(adopt)
      && /tx\.endpoint\.deleteMany\(\{ where: \{ AND: \[\{ id: endpointId \}, UNASSIGNED_WHERE\] \} \}\)/.test(ad) && /action: 'ENDPOINT_FORGOTTEN'/.test(ad),
    'adopt: conditional updateMany from UNASSIGNED_WHERE + ENDPOINT_ADOPTED in the same transaction; forget: conditional deleteMany + ENDPOINT_FORGOTTEN');

  const enrolKey = enr.slice(enr.indexOf('  private async enrolWithDeploymentKey('), enr.indexOf('\n  }\n', enr.indexOf('  private async enrolWithDeploymentKey(')));
  check('adoption: a deployment key is a hash, at most 90 days and 10,000 uses, review by default, and a use is one conditional UPDATE',
    /export const KEY_BYTES = 48;/.test(key) && /export const MAX_KEY_DAYS = 90;/.test(key) && /export const MAX_KEY_USES = 10_000;/.test(key)
      && /mode: z\.enum\(KEY_MODES\)\.default\('review'\)/.test(key)
      && /CHECK \("keyHash" ~ '\^\[0-9a-f\]\{64\}\$'\)/.test(mig) && /"expiresAt" <= "createdAt" \+ INTERVAL '90 days'/.test(mig)
      && /CHECK \("maxUses" BETWEEN 1 AND 10000 AND "useCount" >= 0 AND "useCount" <= "maxUses"\)/.test(mig)
      && /CHECK \("mode" IN \('review', 'active'\)\)/.test(mig)
      && /WHERE "id" = \$\{key\.id\} AND "revokedAt" IS NULL AND "expiresAt" > now\(\) AND "useCount" < "maxUses"`/.test(enrolKey)
      && /keyHash: hash, keyHint: hint,/.test(dk) && !/keyHash: true/.test(strip(dk)) && !/\bkey\b/.test(dk.slice(dk.indexOf('const KEY_VIEW = {'), dk.indexOf('} as const;')))
      && /return \{ \.\.\.row, state: keyState\(row, now\), businessName: business\.name, key \};/.test(dk),
    'deployment-key.ts limits, 0078 CHECKs, the conditional use in enrolWithDeploymentKey, only the hash stored and never selected');

  check('adoption: a deployment key never moves an assigned computer to another business, and a node proves its secret',
    /if \(!existing\.agentSecretHash \|\| !this\.secretMatches\(existing\.agentSecretHash, dto\.agentSecret\)\) throw refused\(\);/.test(enrolKey) && /unchanged: true/.test(enrolKey) && /if \(!isUnassigned\(ep\)\) \{\s*if \(ep\.customerId === key\.customerId\) return \{ enrolled: true, unchanged: true \};\s*throw refused\(\);/.test(enrolKey),
    'enrolWithDeploymentKey: an existing node proves its device secret; another business is refused; the same one is a no-op');

  const factsIface = map.slice(map.indexOf('export interface PoolFacts {'), map.indexOf('}', map.indexOf('export interface PoolFacts {')));
  check('adoption: rules read four explicit facts — never who is signed in or an e-mail address — and nothing applies one',
    /export const MAPPING_KINDS = \['deployment_key', 'domain', 'cidr', 'hostname_prefix'\] as const;/.test(map)
      && /CHECK \("kind" IN \('deployment_key', 'domain', 'cidr', 'hostname_prefix'\)\)/.test(mig)
      && JSON.stringify([...factsIface.matchAll(/^\s+(\w+):/gm)].map((m) => m[1])) === '["deploymentKeyId","domain","sourceIp","hostname"]'
      && !/loggedOnUser|lastUser|e-?mail|\bupn\b/i.test(strip(map) + strip(ad) + strip(dk))
      && !/\.(update|updateMany|create)\(/.test(strip(map)),
    'mapping.ts PoolFacts is exactly the four facts; no user or e-mail in the adoption code; mapping.ts writes nothing');

  check('adoption: the database keeps keys and rules inside one business and records how a computer arrived',
    /CREATE TRIGGER deployment_key_same_business/.test(mig) && /CREATE TRIGGER adoption_mapping_same_business/.test(mig)
      && /CHECK \("arrivedVia" IS NULL OR "arrivedVia" IN \('heartbeat', 'install_script', 'deployment_key'\)\)/.test(mig)
      && /CHECK \("customerId" IS NULL OR "tenantId" IS NOT NULL\) NOT VALID/.test(mig)
      && /ADD VALUE 'ENDPOINT_ADOPTED'/.test(mig) && /ADD VALUE 'DEPLOYMENT_KEY_USED'/.test(mig),
    'migration 0078');

  check('adoption: the old one-step assign route is gone, and the suites run',
    !/unassigned-devices\/:id\/assign/.test(strip(read(`${SRC}/admin/admin.controller.ts`))) && !/async assignDevice\(/.test(read(`${SRC}/admin/admin.service.ts`))
      && /unit-adoption\.mjs/.test(read('.github/workflows/ci.yml')) && / adoption[ ;]/.test(read('scripts/run-e2e.sh')),
    'no POST /admin/unassigned-devices/:id/assign; unit-adoption.mjs in CI; e2e-adoption.mjs in run-e2e.sh');
}

// ── §71 (0.58): automation schedules ─────────────────────────────────────────
// A recurring script run or software install is an automation policy: one
// document two passkey approvers approve on the approval signer (or that the
// signer activates in direct mode), under which the signer signs each
// occurrence's plan with its own checks. The portal's sweep only asks, through
// ActionsService.createPlan, after the containment and task checks. Disabled by
// default: nothing creates a policy but a person, and AUTOMATION_SWEEP=off stops it.
{
  console.log('\n§71 automation schedules');
  const ap = read('apps/api/src/actions/automation-policy.ts');
  const core = read('apps/api/src/approval-signer/core.ts');
  const srv = read('apps/api/src/approval-signer/server.ts');
  const store = read('apps/api/src/approval-signer/store.ts');
  const svc = read('apps/api/src/automation/automation.service.ts');
  const ctl = read('apps/api/src/automation/automation.controller.ts');
  const asvc = read('apps/api/src/actions/actions.service.ts');
  const pp = read('apps/api/src/actions/patch-policy.ts');
  const mig = read('apps/api/prisma/migrations/0079_automation_policies/migration.sql');
  const strip71 = (t) => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  const imports = [...ap.matchAll(/^import .* from '([^']+)';$/gm)].map((m) => m[1]);
  check('automation document: pure, loaded by the signer, importing only zod, crypto and the shared action modules',
    imports.every((i) => ['node:crypto', 'zod', '../integration/crypto', './catalog', './script-run', './patch-policy'].includes(i))
      && read('apps/api/scripts/build-approval-signer.mjs').includes('/^actions\\/automation-policy\\.js$/'),
    `imports: ${imports.join(', ')}; build-approval-signer.mjs must ALLOW actions/automation-policy.js`);
  check('automation document: its own digest and signing prefixes, not a patch policy\'s',
    ap.includes("export const AUTOMATION_DIGEST_PREFIX = 'rem0te-automation-policy-v1\\n';") && ap.includes("export const AUTOMATION_SIGNING_PREFIX = 'rem0te-automation-policy-approved-v1\\n';"),
    'AUTOMATION_DIGEST_PREFIX / AUTOMATION_SIGNING_PREFIX');
  check('recurrence: hourly is automation\'s own closed shape; the patch window union is not widened (§66 unchanged)',
    !/hourly/.test(strip71(pp)) && ap.includes('export const HOURLY_EVERY = [1, 2, 3, 4, 6, 8, 12] as const;')
      && ap.includes('export const AutomationRecurrence = z.union([HourlyRecurrence, PolicyWindow]);')
      && ap.includes("export function recurrenceKind(r: unknown): 'hourly' | 'weekly' | 'monthly' | null {") && ap.includes('return windowKind(r);'),
    'patch-policy.ts must not name hourly; recurrenceKind falls back to windowKind and fails closed');
  check('limits: at most 25 computers, 3 plans an occurrence, 24 hours of validity, 90 days',
    ap.includes('export const MAX_AUTOMATION_TARGETS = MAX_RING_TARGETS;') && ap.includes('export const MAX_RUNS_PER_OCCURRENCE = 3;')
      && ap.includes('export const MAX_EXPIRE_HOURS = 24;') && ap.includes('export const MAX_AUTOMATION_DAYS = MAX_POLICY_DAYS;')
      && mig.includes('CHECK ("attempt" BETWEEN 0 AND 3)') && mig.includes('CHECK ("targets" BETWEEN 0 AND 25)'),
    'the constants, and 0079\'s CHECKs');
  const evS = ap.indexOf('export function evaluateAutomationPlan(');
  const ev = evS < 0 ? '' : ap.slice(evS, ap.indexOf('\n}\n', evS));
  const at = (c) => ev.indexOf(`no('${c}'`);
  check('the signer\'s plan check: revoked first, then approval, then the exact task, the computers, the window, the offline rule, no overlap, the per-occurrence limit',
    ev.length > 0 && at('policy_revoked') > 0 && at('policy_revoked') < at('policy_not_active') && at('policy_not_active') < at('policy_not_approved')
      && at('policy_not_approved') < at('action_not_in_policy') && at('params_not_in_policy') > 0 && at('script_not_in_policy') > 0 && at('software_not_in_policy') > 0
      && at('requester_mismatch') > 0 && at('computer_not_in_policy') > 0 && at('too_many_targets') > 0 && at('outside_schedule') > at('computer_not_in_policy')
      && at('offline_rule_unknown') > 0 && at('offline_rule_mismatch') > at('offline_rule_unknown') && at('previous_run_open') > 0
      && at('occurrence_run_limit') > 0 && at('already_ran_this_occurrence') > 0,
    'evaluateAutomationPlan must refuse every code, revocation before anything else');
  const suS = core.indexOf('export function signUnderAutomation(');
  const sua = suS < 0 ? '' : core.slice(suS, core.indexOf('\n}\n', suS));
  check('the signer signs an occurrence only after the ordinary admission (allowlist, software revocation) and the policy check',
    sua.length > 0 && sua.indexOf('admitPlan(raw.plan, business, now, scripts, softwareRevoked)') > 0
      && sua.indexOf('admitPlan(') < sua.indexOf('evaluateAutomationPlan(') && sua.indexOf('if (!decision.ok) throw') < sua.indexOf('signJob(job, k, now)')
      && sua.includes('signatureValid: verifyAutomation(r, createPublicKey(k.key))'),
    'signUnderAutomation: admitPlan, then evaluateAutomationPlan on a verified record, then signJob');
  check('approving a schedule: passkeys on the signer\'s origin; never its author, never a script\'s contributor',
    core.includes("if (m.userId === r.doc.createdBy.userId) throw new Refused('requester_cannot_approve'")
      && core.includes("if (r.doc.task.kind === 'script' && r.doc.task.script.contributors.includes(m.userId)) throw new Refused('contributor_cannot_approve'"),
    'recordAutomationDecision refuses requester_cannot_approve and contributor_cannot_approve');
  const arS = srv.indexOf('function automationRoute(');
  const ar = arS < 0 ? '' : srv.slice(arS, srv.indexOf('\n}\n', arS));
  check('the signer\'s internal automation routes: propose, read, revoke, plans — nothing approves, activates or un-revokes',
    ar.includes("if (rest.length === 2 && (rest[1] === 'revoke' || rest[1] === 'plans')) return [rest[0], rest[1]];")
      && srv.includes("if (sub !== 'plans') return send(res, 404, { error: 'not_found' });")
      && store.includes("writeFileSync(path.join(this.dir, 'automation-revocations', `${id}.json`), JSON.stringify(rev, null, 2), { mode: 0o600, flag: 'wx' })"),
    'automationRoute names revoke and plans only; revocations are write-once (wx)');
  check('direct mode: only the signer\'s own policy activates a schedule at admission',
    srv.includes("if (policyFor(store.policy(), doc.businessId).approval === 'direct') {") && sua.includes('direct: biz.approval === DIRECT')
      && svc.includes("if (direct) assertFresh(freshMethod, { action: 'actions.direct',"),
    'internalAutomation reads policyFor; the portal asks actions.direct before proposing in direct mode');
  const routes = [...ctl.matchAll(/@(Get|Post|Put|Patch|Delete)\('([^']+)'\)/g)].map((m) => `${m[1]} ${m[2]}`);
  const freshIn = (name) => { const i = ctl.indexOf(`async ${name}(`) >= 0 ? ctl.indexOf(`async ${name}(`) : ctl.indexOf(`  ${name}(`); const j = ctl.indexOf('\n  }\n', i); return i >= 0 && ctl.slice(i, j).includes('this.fresh(req);'); };
  check('portal routes: list, create, preview, read, pause, resume, revoke — no approve route; create, resume and revoke ask, pause never does',
    routes.join('|') === 'Get automation/schedules|Post automation/schedules|Post automation/schedules/preview|Get automation/schedules/:id|Post automation/schedules/:id/pause|Post automation/schedules/:id/resume|Post automation/schedules/:id/revoke'
      && freshIn('create') && freshIn('resume') && freshIn('revoke') && !freshIn('pause') && ctl.includes("assertFresh(this.freshMethod(req), { action: 'automation.policy' });"),
    `routes: ${routes.join(', ')}`);
  const prop = svc.slice(svc.indexOf('  async propose('), svc.indexOf('  private actionOf('));
  check('the sweep only asks: one createPlan under the automation policy, after the overlap, containment, author and task checks',
    prop.length > 0 && (prop.match(/this\.actions\.createPlan\(/g) ?? []).length === 1
      && !/this\.signer\./.test(strip71(prop))
      && prop.indexOf("this.containment.blocking('actions', r.customerId)") > prop.indexOf("rec(false, 'previous_run_open'")
      && prop.indexOf('this.actors.contextFor(') > prop.indexOf("this.containment.blocking('actions'")
      && prop.indexOf('automationScriptProblem(') > prop.indexOf('this.actors.contextFor(') && prop.indexOf('automationEntryProblem(') > 0
      && prop.indexOf('this.actions.createPlan(') > prop.indexOf('automationEntryProblem(')
      && prop.includes("underPolicy: { policyId: r.id, digest: r.digest, evidence: null, kind: 'automation' },"),
    'AutomationService.propose');
  check('ActionsService sends an automation plan to the signer\'s automation route, and audits that it came from one',
    /\? r\.underPolicy\.kind === 'automation'\s*\? await this\.signer\.submitUnderAutomation\(r\.underPolicy\.policyId, \{ plan, policyDigest: r\.underPolicy\.digest \}\)/.test(asvc)
      && asvc.includes("...(r.underPolicy?.kind === 'automation' ? { automation: true } : {})"),
    'actions.service.ts submit and ACTION_REQUESTED meta');
  const creators = walk('apps/api/src').filter((f) => /automationPolicy\.create\(/.test(read(f)));
  check('disabled by default: nothing creates a schedule but the create route; AUTOMATION_SWEEP=off stops the sweep',
    creators.join(',') === 'apps/api/src/automation/automation.service.ts' && (svc.match(/automationPolicy\.create\(/g) ?? []).length === 1
      && svc.includes("static sweepEnabled() { return process.env.AUTOMATION_SWEEP !== 'off'; }")
      && /^export AUTOMATION_SWEEP=off$/m.test(read('scripts/run-e2e.sh')) && !mig.includes('INSERT INTO "AutomationPolicy"'),
    `creators: ${creators.join(', ')}`);
  check('pause is immediate and audited, and cancels undelivered plans; resume and revoke are audited; REVOKED is final in the database',
    svc.includes('const stopped = await this.stopPlans(r, `schedule paused by') && svc.includes("action: 'AUTOMATION_POLICY_PAUSED'")
      && svc.includes("action: 'AUTOMATION_POLICY_RESUMED'") && svc.includes("action: 'AUTOMATION_POLICY_REVOKED'") && svc.includes("action: 'AUTOMATION_POLICY_CREATED'")
      && mig.includes('CREATE TRIGGER "AutomationPolicy_revoked_final"'),
    'pause/resume/revoke/create audit rows; 0079 trigger');
  const goAction = readdirSync(join(ROOT, 'tools/windows-installer/internal/action')).join(' ');
  check('the agent is unchanged: an occurrence plan is an ordinary script or software plan',
    !/automation/i.test(goAction),
    'no automation code in the agent');
  check('automation schedules: the suites run',
    read('.github/workflows/ci.yml').includes('unit-automation-schedule.mjs') && read('scripts/run-e2e.sh').includes('scripts/e2e-automation-schedule.mjs'),
    'unit-automation-schedule.mjs in CI, e2e-automation-schedule.mjs in run-e2e.sh');
}

// 72. Agit8or Identity P0 (0.59): the groundwork for trusting a self-hosted
//     Keycloak. Every decision made from a provider's claims is one pure
//     module, sso/identity-policy.ts, with no imports. A Platform Admin signs
//     in through SSO only when the provider allows it, and then only at the
//     passkey level; a level is the acr, lowered until amr corroborates it.
//     An organization binding is a gate, never a grant. The SSO step-up asks
//     max_age=0 with acr_values, checks auth_time against the start of the
//     round trip and the linked account, and issues sso-passkey (phishing-
//     resistant) only from a provider trusted for passkeys. Back-channel
//     logout is verified against the provider's keys before any claim is
//     acted on, refuses a nonce, an unknown alg or a used jti, and revokes the
//     account. Refresh and ID tokens and the private_key_jwt key are sealed;
//     the key's private half is in no view. SSO_SESSION_SWEEP=off is exact.
//     Link suggestions are never acted on automatically and never name a
//     Platform Admin or break-glass account. ssoMode=required refuses a
//     linked account's password and passkey sign-in after the credential
//     verifies; required needs every account linked and sso.enforce; the
//     recovery CLI only lowers. Break-glass: Platform Admins only (0080
//     CHECK), at most two (trigger), TOTP and a passkey, breakglass.manage,
//     and each use is a sealed BREAK_GLASS_LOGIN written before the session.
//     Session, integration and IdP tokens are kept apart.
{
  const pol = read('apps/api/src/sso/identity-policy.ts');
  const svc = read('apps/api/src/sso/sso.service.ts');
  const sess = read('apps/api/src/sso/sso-session.service.ts');
  const idsvc = read('apps/api/src/sso/sso-identity.service.ts');
  const idctl = read('apps/api/src/sso/sso-identity.controller.ts');
  const ctl = read('apps/api/src/sso/sso.controller.ts');
  const auth = read('apps/api/src/auth/auth.service.ts');
  const rev = read('apps/api/src/security-controls/review.ts');
  const cli = read('apps/api/src/cli/auth-recovery.ts');
  const sql = read('apps/api/prisma/migrations/0080_sso_identity/migration.sql');
  const strip = (s) => s.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
  check('identity: every claim decision is one pure module with no imports',
    !/^\s*import\b|require\(/m.test(pol)
      && /export function platformAdminDecision\(/.test(pol) && /export function stepUpDecision\(/.test(pol) && /export function logoutClaimsDecision\(/.test(pol)
      && /platformAdminDecision\(/.test(svc) && /stepUpDecision\(/.test(svc) && /logoutClaimsDecision\(/.test(sess),
    'identity-policy.ts imports nothing; sso.service and sso-session.service decide through it');
  check('identity: a Platform Admin through SSO only when allowed, and then only at the passkey level',
    /if \(!p\.allowPlatformAdmin\) return \{ ok: false, code: 'admin_not_allowed' \};/.test(pol) && /if \(!meets\(level, 'passkey'\)\) return \{ ok: false, code: 'admin_needs_passkey' \};/.test(pol)
      && /"allowPlatformAdmin" BOOLEAN NOT NULL DEFAULT false/.test(sql),
    'platformAdminDecision; 0080 defaults allowPlatformAdmin to false');
  check('identity: sso-passkey only from a provider trusted for passkeys; sso-passkey and passkey are the only phishing-resistant methods',
    /if \(meets\(level, 'passkey'\) && p\.trustIdpPasskey\) return 'sso-passkey';/.test(pol)
      && /export const PHISHING_RESISTANT_METHODS: ReadonlySet<string> = new Set\(\['passkey', 'sso-passkey'\]\);/.test(rev)
      && /if \(opts\.phishingResistant && !PHISHING_RESISTANT_METHODS\.has\(method\)\)/.test(rev),
    'stepUpMethod, review.ts PHISHING_RESISTANT_METHODS');
  check('identity: the SSO step-up asks max_age=0 and the acr, and is judged against the round trip\'s own start and account',
    /max_age: '0'/.test(svc) && /acr_values/.test(svc) && /startedAt: row\.createdAt\.getTime\(\)/.test(svc)
      && /"purpose" <> 'STEP_UP' OR \("userId" IS NOT NULL AND "requiredLevel" IS NOT NULL AND "sessionIat" IS NOT NULL\)/.test(sql),
    'start() for STEP_UP; finishStepUp passes the row\'s createdAt; 0080 CHECKs a step-up row');
  const bc = sess.slice(sess.indexOf('async backchannelLogout('), sess.indexOf('\n  }\n', sess.indexOf('async backchannelLogout(')));
  check('identity: back-channel logout verifies the signature before acting on a claim, and a jti once',
    bc.indexOf('this.signatureOk(') > 0 && bc.indexOf("if (!sigOk) return") > bc.indexOf('this.signatureOk(')
      && bc.indexOf('ssoLogoutReplay.create') > bc.indexOf('if (!sigOk) return') && bc.indexOf('revokeSessions(') > bc.indexOf('ssoLogoutReplay.create')
      && /if \('nonce' in claims\) return \{ ok: false, reason: 'nonce' \};/.test(pol)
      && /export const LOGOUT_ALGS/.test(pol) && !/'none'|HS256/.test((pol.match(/export const LOGOUT_ALGS[^\n]*/) ?? [''])[0])
      && /@Public\(\)\s*@Post\('backchannel-logout'\)\s*@RateLimit\(\d+\)/.test(ctl),
    'signatureOk, then the replay row, then revokeSessions; no nonce; asymmetric algorithms only; rate-limited public route');
  check('identity: tokens and the client key are sealed, and the private key is in no view',
    /refreshTokenEnc: tokens\.refreshToken \? sealSecret\(this\.encKey, 'rem0te-oidc-refresh-v1'/.test(svc)
      && /idTokenEnc: tokens\.idToken \? sealSecret\(this\.encKey, 'rem0te-oidc-id-token-v1'/.test(svc)
      && /clientKeyEnc: sealSecret\(this\.encKey, 'rem0te-oidc-client-key-v1'/.test(svc)
      && /refreshTokenEnc: sealSecret\(this\.encKey, 'rem0te-oidc-refresh-v1', next\)/.test(sess)
      && !/clientKeyEnc: p\.clientKeyEnc|refreshTokenEnc: s\./.test(svc),
    'sealSecret with the three purposes; view() names only hasClientKey');
  check('identity: SSO_SESSION_SWEEP=off is exact, exported by run-e2e.sh and invalid_grant ends the session',
    /if \(process\.env\.SSO_SESSION_SWEEP === 'off'\) return;/.test(sess) && /^export SSO_SESSION_SWEEP=off$/m.test(read('scripts/run-e2e.sh'))
      && /if \(e instanceof oidc\.ResponseBodyError && err\.error === 'invalid_grant'\) \{\s*await this\.end\(s, 'invalid_grant'\);/.test(sess),
    'sso-session.service.ts; scripts/run-e2e.sh');
  const creates = (s) => (strip(s).match(/externalIdentity\.create\(/g) ?? []).length;
  const sug = svc.slice(svc.indexOf('private async suggest('), svc.indexOf('\n  }\n', svc.indexOf('private async suggest(')));
  check('identity: a link suggestion is only ever confirmed by a Platform Admin, never for an admin or break-glass account',
    creates(idsvc) === 1 && /if \(!u \|\| u\.status !== 'ACTIVE' \|\| u\.isPlatformAdmin \|\| u\.breakGlass\) return;/.test(sug) && !/externalIdentity/.test(sug.replace(/externalIdentity\.count/g, ''))
      && /assertFresh\(this\.method\(req\), \{ action: 'sso\.configure' \}\);/.test(idctl),
    'one ExternalIdentity insert in SsoIdentityService (confirm); suggest() writes suggestions only');
  const login = auth.slice(auth.indexOf('async login('), auth.indexOf('\n  }\n', auth.indexOf('async login(')));
  check('identity: required refuses a linked account\'s local sign-in only after the credential verifies; break-glass is exempt',
    login.indexOf('argon2.verify(') > 0 && login.indexOf("assertLocalSignInAllowed(user, 'password', ip)") > login.indexOf('argon2.verify(')
      && /if \(method === 'passkey'\) await this\.assertLocalSignInAllowed\(user, 'passkey', ip\);/.test(auth)
      && /return x\.mode === 'required' && x\.linked && !x\.breakGlass;/.test(pol),
    'login(): argon2.verify then assertLocalSignInAllowed; signInVerifiedUser for passkeys; localSignInRefused');
  check('identity: required needs sso.enforce when tightening and every account linked; the recovery CLI only lowers',
    /action: 'sso\.enforce'/.test(idctl) && /SSO_ENFORCE_UNLINKED/.test(idsvc)
      && /if \(mode !== 'off' && mode !== 'optional'\) throw new UsageError/.test(cli)
      && /CHECK \("ssoMode" IN \('off', 'optional', 'required'\)\)/.test(sql) && /CHECK \("staffSsoMode" IN \('off', 'optional', 'required'\)\)/.test(sql),
    'sso-identity.controller/service; auth-recovery --sso-mode; 0080 CHECKs');
  check('identity: break-glass is Platform Admin only, at most two, both factors, breakglass.manage, and each use is audited before the session',
    /CHECK \(NOT "breakGlass" OR "isPlatformAdmin"\)/.test(sql) && /pg_advisory_xact_lock\(hashtext\('rem0te_break_glass'\)\)/.test(sql) && /"id" <> NEW\."id"\) >= 2 THEN/.test(sql)
      && /export const MAX_BREAK_GLASS = 2;/.test(pol)
      && /m\.type === 'TOTP'/.test(idsvc) && /m\.type === 'WEBAUTHN'/.test(idsvc) && /action: 'breakglass\.manage'/.test(idctl)
      && /await this\.audit\.logOrFail\(\{ action: 'BREAK_GLASS_LOGIN'/.test(auth),
    '0080 CHECK and trigger; planBreakGlass; breakGlassUsed logOrFail');
  check('identity: session, integration and IdP tokens are kept apart',
    /algorithms: \['HS256'\]/.test(read('apps/api/src/auth/strategies/jwt.strategy.ts')) && /foreignSessionPayload\(payload\)/.test(read('apps/api/src/auth/strategies/jwt.strategy.ts'))
      && /if \(req\.headers\.authorization !== undefined\) throw E\.unauthenticated/.test(read('apps/api/src/integration/integration-auth.guard.ts'))
      && /looksLikeIdpToken\(/.test(read('apps/api/src/integration/delegation.service.ts')),
    'JwtStrategy HS256 + foreignSessionPayload; integration guard refuses bearer; delegation refuses IdP tokens');
  check('identity: the suites run',
    /unit-sso-identity\.mjs/.test(read('.github/workflows/ci.yml')) && /^for t in credentials [^\n]* sso-identity[ ;][^\n]*do run/m.test(read('scripts/run-e2e.sh'))
      && /section\('G-R1: a Platform Admin through SSO'\)/.test(read('apps/api/scripts/e2e-sso-identity.mjs')),
    'unit-sso-identity.mjs in CI; e2e-sso-identity.mjs in run-e2e.sh');
}

// ── §73 (0.60): the simple restart window ────────────────────────────────────
// "Restart if Windows needs it, nightly 02:00–04:00" on a business, a device
// group or one computer (which may say "no automatic restarts"), computer >
// group > business. A window is an automation policy whose task is `restart`:
// approved on the approval signer with two passkeys, or active at creation in
// direct mode. Each restart is one signed windows.reboot.schedule plan the
// signer checks against the approved window (evaluateAutomationRestart): the
// business, the window by the shared occurrence function, the fixed 15-minute
// warning, onlyIfRequired under "if required", the RustDesk exception only if
// the window has it, one open plan and at most three per computer per window.
// The portal's sweep only asks, through ActionsService.createPlan, after the
// containment check. The agent is unchanged (0.54 agents honour both flags).
{
  console.log('\n§73 restart windows');
  const ap = read('apps/api/src/actions/automation-policy.ts');
  const svc = read('apps/api/src/restart-windows/restart-windows.service.ts');
  const ctl = read('apps/api/src/restart-windows/restart-windows.controller.ts');
  const res = read('apps/api/src/restart-windows/resolve.ts');
  const auto = read('apps/api/src/automation/automation.service.ts');
  const page = read('apps/api/src/approval-signer/page.ts');
  const srv = read('apps/api/src/approval-signer/server.ts');
  const mig = read('apps/api/prisma/migrations/0081_restart_windows/migration.sql');
  const dgs = read('apps/api/src/device-views/device-groups.service.ts');
  const card = read('apps/web/components/restart-windows/restart-window-card.tsx');
  const strip73 = (t) => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  const fn73 = (src, sig) => { const i = src.indexOf(sig); const j = src.indexOf('\n}\n', i); return i < 0 ? '' : src.slice(i, j); };
  const m73 = (src, sig) => { const i = src.indexOf(sig); const j = src.indexOf('\n  }\n', i); return i < 0 ? '' : src.slice(i, j); };

  check('restart task: closed — a rule of two, the exception only as true, nothing else',
    /export const RestartTask = z\.object\(\{\n  kind: z\.literal\('restart'\),\n  rule: z\.enum\(RESTART_RULES\),\n  ignoreRemoteSession: z\.literal\(true\)\.optional\(\),\n\}\)\.strict\(\);/.test(ap)
      && ap.includes('export const RESTART_WINDOW_DELAY_MINUTES = POLICY_RESTART_DELAY_MINUTES;')
      && /delayMinutes: RESTART_WINDOW_DELAY_MINUTES,\n    \.\.\.\(t\.rule === 'if_required' \? \{ onlyIfRequired: true as const \} : \{\}\),\n    \.\.\.\(t\.ignoreRemoteSession === true \? \{ ignoreRemoteSession: true as const \} : \{\}\),/.test(ap)
      && /if \(t\.kind === 'restart'\) return \{ id: REBOOT_SCHEDULE\.id, version: 1 \};/.test(ap),
    'RestartTask strict; restartParamsFor: the fixed warning, onlyIfRequired for if_required, the exception only when true; taskAction → windows.reboot.schedule');
  check('restart document: whole business or a group\'s members only for a restart; never hourly; run_when_online; at least 30 minutes',
    ['target_restart_only', 'restart_target_kind', 'restart_schedule_kind', 'restart_offline_rule', 'restart_window_too_short'].every((c) => ap.includes(`bad('${c}'`))
      && ap.includes('export const MIN_RESTART_WINDOW_MINUTES = 30;'),
    'validateAutomationDoc must refuse each');
  const ev = fn73(ap, 'export function evaluateAutomationRestart(');
  const order = ['restart_rule_unknown', 'action_not_in_policy', 'override_not_allowed', 'restart_params_not_allowed', 'script_not_in_policy', 'bad_display', 'requester_mismatch', 'computer_not_in_policy', 'outside_restart_window', 'restart_already_signed', 'restart_retry_limit'];
  const idx = order.map((c) => ev.indexOf(`no('${c}'`));
  check('signer: every restart plan is decided by evaluateAutomationRestart, refusals in order',
    /if \(doc\.task\.kind === 'restart'\) return evaluateAutomationRestart\(s, r, now\);/.test(ap)
      && idx.every((x, i) => x > 0 && (i === 0 || x > idx[i - 1]))
      && /const want = restartParamsFor\(/.test(ev) && /if \(canonical\(got\) !== canonical\(want\)\) return no\('restart_params_not_allowed'/.test(ev)
      && /automationOccurrenceAt\(nb, doc\.recurrence\)/.test(ev) && /e\.endpointIds\.includes\(tg\.endpointId\)/.test(ev),
    `order ${order.join(' → ')}; params compared canonically; the shared occurrence function; the ledger per computer`);
  check('signer: says it supports restart windows, and its page says what a window does',
    srv.includes('restartWindows: 1') && /function renderRestartWindowPage\(/.test(page)
      && /esc\(SIGNED_IN_USER_NOTE\)/.test(fn73(page, 'function renderRestartWindowPage(')) && /esc\(REBOOT_UNPROVEN\)/.test(fn73(page, 'function renderRestartWindowPage(')),
    'capabilities restartWindows: 1; renderRestartWindowPage shows the signed-in user note and REBOOT_UNPROVEN');
  const plans = (strip73(svc).match(/this\.actions\.createPlan\(/g) ?? []).length;
  check('portal: one way to ask for a restart — one createPlan, under the window, with restartParamsFor',
    plans === 1 && /action: REBOOT_SCHEDULE, endpointIds: \[ep\.id\], params: restartParamsFor\(task\)/.test(svc)
      && /underPolicy: \{ policyId: p\.id, digest: p\.digest, evidence: null, kind: 'automation' \}/.test(svc)
      && !/automationPolicy\.create\(|actionJob\.create\(|actionTarget\.create\(/.test(strip73(svc))
      && /this\.automation\.createRestart\(/.test(svc) && (auto.match(/this\.prisma\.automationPolicy\.create\(/g) ?? []).length === 1,
    'restart-windows.service.ts: createPlan once; no policy, job or target written directly; createRestart → the one automationPolicy.create');
  const write = m73(svc, '  private async write(');
  const offAt = write.indexOf("if (dto.mode === 'off') {"), freshAt = write.indexOf("assertFresh(freshMethod, { action: 'restart.window'");
  check('portal: anything that can widen asks for a fresh sign-in (restart.window); "no automatic restarts" never does',
    offAt > 0 && freshAt > offAt && !/assertFresh/.test(write.slice(offAt, write.indexOf('return row;', offAt)))
      && /if \(scope !== 'business'\) assertFresh\(freshMethod, \{ action: 'restart\.window'/.test(svc)
      && /if \(dto\.mode === 'inherit'\) assertFresh\(freshMethod, \{ action: 'restart\.window'/.test(svc)
      && (svc.match(/assertFresh\(/g) ?? []).length === 3,
    'write: off returns before the one assertFresh; clear asks except for the business; bulk inherit asks');
  const pf = m73(svc, '  private async proposeFor(');
  check('portal: containment first, then precedence, patch-policy computers left to their policy',
    pf.indexOf("this.containment.blocking('actions', customerId)") > 0 && pf.indexOf("this.containment.blocking('actions', customerId)") < pf.indexOf('this.prisma.endpoint.findMany(')
      && /effectiveSetting\(\{ id: ep\.id, customerId, groupIds: members\.groupsOf\(ep\.id\) \}, settings\)/.test(pf) && /patchGoverned\.has\(ep\.id\)/.test(pf)
      && /if \(task\.rule === 'if_required' && \(await this\.restartRequired\(ep\.id\)\) !== true\) return 'not_required';/.test(svc),
    'proposeFor: containment.blocking before reading computers; effectiveSetting; skip a patch policy\'s computers; if_required only when Windows says so');
  check('precedence: computer > group > business through the 0.35 rule; a window not approved governs nothing',
    /import \{ applies, resolve[^}]*\} from '\.\.\/group-policy\/precedence';/.test(res) && /export function inForce\(s: Pick<SettingLike, 'mode' \| 'policyLive'>\): boolean \{\n  return s\.mode === 'off' \|\| \(s\.mode === 'window' && s\.policyLive\);\n\}/.test(res)
      && !/new Map|this\./.test(strip73(res)) && /policyLive: !!s\.policy && s\.policy\.status === 'ACTIVE' && !s\.policy\.pausedAt && \(s\.policy\.expiresAt === null \|\| s\.policy\.expiresAt > new Date\(\)\),/.test(svc),
    'resolve.ts pure; inForce: off, or an ACTIVE unpaused unexpired policy (0.63: a null expiresAt is a signed "never")');
  check('retry: only after a RustDesk session or "cannot tell", or a plan that never arrived — 0.54\'s rule',
    res.includes("export const RESTART_RETRY_REASONS: readonly string[] = ['remote_session_open', 'session_state_unknown'];")
      && res.includes("export const RESTART_RETRY_JOB_STATES: readonly string[] = ['REJECTED', 'CANCELED', 'EXPIRED'];")
      && /const RESTART_RETRY_MS = 15 \* 60_000;/.test(svc) && /export const RESTART_ATTEMPTS = MAX_RUNS_PER_OCCURRENCE;/.test(svc),
    'resolve.ts retry lists; 15 minutes apart; at most three a window');
  check('routes: read, set and remove per scope, and a bulk off/inherit — no approve, activate or sign route',
    JSON.stringify([...ctl.matchAll(/@(Get|Put|Delete|Post)\('([^']*)'\)/g)].map((m) => `${m[1]} ${m[2]}`)) === JSON.stringify([
      'Get businesses/:businessId', 'Put businesses/:businessId', 'Delete businesses/:businessId',
      'Put businesses/:businessId/groups/:groupId', 'Delete businesses/:businessId/groups/:groupId',
      'Get computers/:endpointId', 'Put computers/:endpointId', 'Delete computers/:endpointId', 'Post computers/bulk']),
    'restart-windows.controller.ts route list');
  check('sweep: RESTART_WINDOW_SWEEP=off stops it, and every test stack sets it',
    /return process\.env\.RESTART_WINDOW_SWEEP !== 'off';/.test(svc) && /^export RESTART_WINDOW_SWEEP=off$/m.test(read('scripts/run-e2e.sh'))
      && /RESTART_WINDOW_SWEEP: 'off'/.test(read('apps/web/scripts/e2e-ui.mjs')),
    'restart-windows.service.ts; run-e2e.sh; e2e-ui.mjs');
  check('0081: restart task kind, the setting\'s CHECKs, three tries, one business per setting',
    mig.includes(`CHECK ("taskKind" IN ('script', 'software', 'restart'))`) && /"RestartWindowSetting_mode_check" CHECK \(/.test(mig)
      && mig.includes('CHECK ("attempt" BETWEEN 1 AND 3)') && /CREATE TRIGGER restart_window_setting_same_business/.test(mig) && /CREATE TRIGGER endpoint_restart_window_leaves/.test(mig)
      && /WHERE "scope" = 'business'/.test(mig),
    'migration 0081');
  check('a device group carrying a restart window cannot be deleted',
    /this\.prisma\.restartWindowSetting\.count\(\{ where: \{ groupId \} \}\)/.test(dgs),
    'device-groups.service.ts policiesOn counts restart window settings');
  check('UI: says "Waiting for approval", and never ticks the RustDesk exception by default',
    card.includes('Waiting for approval') && /const \[ignore, setIgnore\] = useState\(initial\?\.ignoreRemoteSession \?\? false\);/.test(card) && card.includes('IGNORE_REMOTE_SESSION_LABEL') && card.includes('SIGNED_IN_USER_NOTE'),
    'restart-window-card.tsx');
  check('restart windows: the suites run',
    /unit-restart-window-settings\.mjs/.test(read('.github/workflows/ci.yml')) && /run restart-window-settings node scripts\/e2e-restart-window-settings\.mjs/.test(read('scripts/run-e2e.sh')),
    'unit-restart-window-settings.mjs in CI; e2e-restart-window-settings.mjs in run-e2e.sh');
}

// 74. Warranty vendors (0.61): HP Inc. and Apple lookups, and "why is there
//     no date". § 69 still holds for every vendor; this adds:
//       - one lookup list (vendors.ts LOOKUP_VENDORS: dell, lenovo, hp,
//         apple), re-exported by the client, and 0082's CHECKs naming exactly
//         it; the vendors with no lookup (HPE, Microsoft, ASUS, Acer) each
//         carry a stated reason, and no vendor is both;
//       - every https URL in warranty/client.ts is on its LOOKUP_HOSTS, and
//         the new hosts appear nowhere else in the API;
//       - HP is sent the serial alone ([{ sn }] — no product number, no
//         country), its job id is checked before it is put in a URL, and its
//         polling is bounded (HP_MAX_POLLS) with an unfinished job transient;
//       - Apple's private key is checked to be EC P-256 before it is sealed,
//         its client assertion lives five minutes, and a key id moves the
//         credential like a client id does (0082 CHECKs the key id is Apple's);
//       - bearer tokens are kept only in an unexported in-memory map keyed by
//         a hash of the credential;
//       - the report and the dashboard read only the enabled vendors' names,
//         never a credential; the gap reasons come from one pure function;
//       - the console says HP and Apple were tested only against a stand-in.
{
  console.log('\n§74 warranty vendors');
  // Comments out, but never the // of a URL.
  const strip74 = (x) => x.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
  const vApi = read('apps/api/src/warranty/vendors.ts');
  const cl = read('apps/api/src/warranty/client.ts');
  const svc = read('apps/api/src/warranty/warranty.service.ts');
  const mig = read('apps/api/prisma/migrations/0082_warranty_vendors/migration.sql');
  check('warranty vendors: one lookup list — Dell, Lenovo, HP, Apple — re-exported by the client',
    /export const LOOKUP_VENDORS = \['dell', 'lenovo', 'hp', 'apple'\] as const;/.test(vApi)
      && /import \{ cleanCoverage, LOOKUP_VENDORS, type LookupVendor \} from '\.\/vendors';/.test(cl) && /export \{ LOOKUP_VENDORS, type LookupVendor \};/.test(cl)
      && !/const LOOKUP_VENDORS|LOOKUP_VENDORS = \[/.test(cl),
    'vendors.ts LOOKUP_VENDORS; client.ts imports and re-exports it');
  const noLookup = (vApi.match(/export const NO_LOOKUP_REASON: Record<Exclude<VendorKey, LookupVendor>, string> = \{([\s\S]*?)\n\};/) ?? [])[1] ?? '';
  check('warranty vendors: HPE, Microsoft, ASUS and Acer have no lookup, each with a stated reason',
    ['hpe', 'microsoft', 'asus', 'acer'].every((k) => new RegExp(`\\n  ${k}: '[^']{40,}',`).test(noLookup)) && [...noLookup.matchAll(/\n  ([a-z]+): /g)].length === 4,
    'vendors.ts NO_LOOKUP_REASON');
  check('0082: both vendor lists name exactly LOOKUP_VENDORS; the key id is Apple\'s alone; a client id only for Dell, HP and Apple',
    /CHECK \("warrantySource" IS NULL OR "warrantySource" IN \('manual', 'dell', 'lenovo', 'hp', 'apple'\)\)/.test(mig)
      && /CHECK \("vendor" IN \('dell', 'lenovo', 'hp', 'apple'\)\)/.test(mig)
      && /CHECK \("keyId" IS NULL OR \("vendor" = 'apple' AND "keyId" ~ '\^\[A-Za-z0-9\._-\]\{4,100\}\$'\)\)/.test(mig)
      && /CHECK \("clientId" IS NULL OR \("vendor" IN \('dell', 'hp', 'apple'\)/.test(mig),
    'migration 0082');
  const hosts = ((cl.match(/export const LOOKUP_HOSTS = \[([^\]]*)\] as const;/) ?? [])[1] ?? '').match(/'[a-z0-9.-]+'/g)?.map((h) => h.slice(1, -1)) ?? [];
  const urls = [...strip74(cl).matchAll(/'(https?:\/\/[^'`$]+)'/g)].map((m) => m[1]);
  const off = urls.filter((u) => { try { const x = new URL(u); return x.protocol !== 'https:' || !hosts.includes(x.hostname); } catch { return true; } });
  check('warranty vendors: every vendor URL in client.ts is https to a host on LOOKUP_HOSTS (five hosts)',
    hosts.length === 5 && urls.length === 6 && off.length === 0, `hosts ${hosts.join(', ')}; off-list: ${off.join(', ')}`);
  const elsewhere = walk('apps/api/src').filter((f) => f !== 'apps/api/src/warranty/client.ts' && /warranty\.api\.hp\.com|api-business\.apple\.com|account\.apple\.com|HP_BASE|APPLE_(AUTH|API)_BASE/.test(strip74(read(f))));
  check('warranty vendors: the HP and Apple API hosts appear only in warranty/client.ts', elsewhere.length === 0, elsewhere.join(', '));
  const hpFn = cl.slice(cl.indexOf('async function hp('), cl.indexOf('// ── Apple'));
  check('warranty vendors: HP is sent the serial alone — no product number, no country',
    /JSON\.stringify\(\[\{ sn: serial \}\]\)/.test(hpFn) && !/\bpn\b|\bcc\b|countryCode/.test(strip74(hpFn).replace(/r\.sn/g, '')),
    'client.ts hp(): the job body is [{ sn: serial }]');
  check('warranty vendors: HP\'s job id is checked before it is put in a URL, and polling is bounded',
    /if \(!job \|\| typeof job\.jobId !== 'string' \|\| !JOB_ID_RE\.test\(job\.jobId\)\) return INVALID;\s*\n\s*const id = encodeURIComponent\(job\.jobId\);/.test(hpFn)
      && /const JOB_ID_RE = \/\^\[A-Za-z0-9-\]\{8,64\}\$\/;/.test(cl) && /export const HP_MAX_POLLS = 6;/.test(cl)
      && /for \(let i = 0; i < HP_MAX_POLLS && !done; i\+\+\)/.test(hpFn) && /if \(!done\) return \{ ok: false, code: 'VENDOR_PENDING', transient: true \};/.test(hpFn),
    'client.ts hp()');
  check('warranty vendors: Apple\'s key is EC P-256 before it is sealed; the assertion lives five minutes',
    /k\.asymmetricKeyType !== 'ec' \|\| k\.asymmetricKeyDetails\?\.namedCurve !== 'prime256v1'/.test(cl)
      && /exp: now \+ 300, jti: randomUUID\(\)/.test(cl) && /alg: 'ES256', kid: c\.keyId/.test(cl)
      && svc.indexOf("given = vendor === 'apple' ? normaliseApplePrivateKey(given)") > 0
      && svc.indexOf("given = vendor === 'apple' ? normaliseApplePrivateKey(given)") < svc.indexOf("sealSecret(this.encKey, 'rem0te-warranty-key-v1', given)"),
    'client.ts normaliseApplePrivateKey / appleAssertion; warranty.service putVendor');
  check('warranty vendors: a changed client id or key id drops the saved secret',
    /const moved = !!cur && \(\(cur\.clientId \?\? null\) !== clientId \|\| \(cur\.keyId \?\? null\) !== keyId\);/.test(svc)
      && /else if \(cur\?\.secretEnc && moved\) \{ secretEnc = null; secretLast4 = null; keyChange = 'cleared_client_changed'; \}/.test(svc),
    'warranty.service putVendor()');
  check('warranty vendors: bearer tokens live only in an unexported in-memory map keyed by a hash of the credential',
    /^const tokens = new Map<string, \{ token: string; until: number \}>\(\);$/m.test(cl) && !/export const tokens|export \{[^}]*tokens/.test(cl)
      && /createHash\('sha256'\)\.update\(`\$\{c\.clientId \?\? ''\}\\n\$\{c\.keyId \?\? ''\}\\n\$\{c\.secret\}`\)/.test(cl)
      && !/token/i.test((cl.match(/this\.logger|console\./g) ?? []).join('')),
    'client.ts tokens / tokenKey');
  const rep = read('apps/api/src/reports/reports.service.ts');
  const ov = read('apps/api/src/dashboard/overview.service.ts');
  const vendorReads = [rep, ov].flatMap((s) => [...s.matchAll(/this\.prisma\.warrantyVendor\.findMany\(([^;]*)\)/g)].map((m) => m[1]));
  check('warranty vendors: the report and the dashboard read only the enabled vendors\' names, never a credential',
    vendorReads.length === 2 && vendorReads.every((a) => /where: \{ enabled: true, secretEnc: \{ not: null \} \}, select: \{ vendor: true \}/.test(a)),
    vendorReads.join(' | '));
  check('warranty vendors: "why is there no date" is one pure function, used by the device page, the report and the dashboard',
    /export function warrantyGap\(g: GapInput\): WarrantyGap \{/.test(vApi)
      && [svc, rep, ov].every((s) => /warrantyGap\(\{/.test(s)) && read('apps/web/components/endpoints/warranty-card.tsx').includes('data.gap.text'),
    'vendors.ts warrantyGap; warranty.service view(); reports.service warrantyRows; overview.service');
  const page = read('apps/web/app/(app)/settings/warranty/page.tsx');
  check('warranty vendors: the console and the docs say HP and Apple were tested only against a stand-in',
    /hp: \{[\s\S]*?standIn: true,/.test(page) && /apple: \{[\s\S]*?standIn: true,/.test(page) && /tested only against a stand-in/.test(page)
      && /tested only against a stand-in/i.test(read('docs/warranty.md')),
    'settings/warranty/page.tsx HELP.standIn; docs/warranty.md');
  check('warranty vendors: the suites run',
    /unit-warranty-vendors\.mjs/.test(read('.github/workflows/ci.yml')) && / warranty-vendors[ ;]/.test(read('scripts/run-e2e.sh')),
    'unit-warranty-vendors.mjs in CI; e2e-warranty-vendors.mjs in run-e2e.sh');
}

// ── §75 (0.62): the staging field — all at once, or one computer first ─────
//     0.62 reverses §15's and §38's "a canary first, then gated rings" at the
//     owner's request ("remove the goofy canary thing in update policy. way
//     too difficult to setup update policies"), as §41, §62 and §67 were. The
//     reversal is narrow and signed:
//       - one closed list, STAGINGS = ['none', 'canary'], read only through
//         stagingOf: absent is canary (every document before 0.62 keeps its
//         bytes, digest and gate), anything else is null and refused;
//       - PolicyDoc carries it as an optional enum; the portal writes it only
//         for all at once, so a canary document is byte-for-byte 0.61's, and
//         it asks for the signer's patchStaging capability first;
//       - validatePolicyDoc refuses an unknown staging before anything else,
//         and keeps the one-computer canary and the result keys for canary;
//       - evaluatePolicyPlan refuses an unknown staging (staging_unknown)
//         after the standing, filter, window, requester and computer checks;
//         all at once skips only ring order, evidence and the gate (evidence
//         is refused), and keeps ring_already_signed and ring_retry_limit;
//       - the gate's canary checks apply unless the caller says canary: false,
//         which the portal says only for a deployment whose CHECKed column is
//         'none' (0083);
//       - every API create (policy, deployment, series) defaults to canary,
//         so a caller that leaves it out keeps the gate; a stored series
//         without it is canary.
{
  console.log('\n§75 patch staging');
  const pp = read('apps/api/src/actions/patch-policy.ts');
  const pol = read('apps/api/src/patching/policies.service.ts');
  const psvc = read('apps/api/src/patching/patching.service.ts');
  const asg = read('apps/api/src/patching/assignment.ts');
  const srv = read('apps/api/src/approval-signer/server.ts');
  const mig = read('apps/api/prisma/migrations/0083_patch_staging/migration.sql');
  check('staging: one closed list, read through stagingOf; absent is canary, anything else is null',
    /export const STAGINGS = \['none', 'canary'\] as const;/.test(pp)
      && /export function stagingOf\(doc: \{ staging\?: unknown \}\): Staging \| null \{\s*if \(!\('staging' in doc\) \|\| doc\.staging === undefined\) return 'canary';\s*return \(STAGINGS as readonly unknown\[\]\)\.includes\(doc\.staging\) \? doc\.staging as Staging : null;\s*\}/.test(pp),
    'actions/patch-policy.ts STAGINGS / stagingOf');
  const docBlock = (pp.match(/export const PolicyDoc = z\.object\(\{([\s\S]*?)\}\)\.strict\(\);/) ?? [])[1] ?? '';
  check('staging: the signed document carries it as an optional closed enum (strict schema: an older signer refuses it)',
    /\n  staging: z\.enum\(STAGINGS\)\.optional\(\),/.test(docBlock),
    'PolicyDoc.staging');
  const vd = pp.slice(pp.indexOf('export function validatePolicyDoc('), pp.indexOf('export function allowParams('));
  check('staging: admission refuses an unknown staging first, and keeps the one-computer canary for canary',
    vd.indexOf("reason: 'staging_unknown'") > 0 && vd.indexOf("reason: 'staging_unknown'") < vd.indexOf("reason: 'bad_rings'")
      && /if \(staging === 'canary' && doc\.rings\[0\]\.length !== 1\) return \{ ok: false, reason: 'bad_rings'/.test(vd),
    'validatePolicyDoc');
  const ev = pp.slice(pp.indexOf('function evaluateInstallPlan('), pp.indexOf('export function evaluatePolicyRestartPlan('));
  const at = (x) => ev.indexOf(x);
  const noneAt = at("if (staging === 'none') {");
  check('staging: the signer refuses an unknown staging, and all at once comes only after every other check on the plan',
    at("if (!staging) return no('staging_unknown'") > 0
      && [at("no('filter_mismatch'"), at("no('bad_display', 'The plan must name this policy.')"), at("no('requester_mismatch'"), at("no('outside_window'"), at("no('computer_not_in_policy'")].every((i) => i > 0 && i < noneAt)
      && at("if (!staging) return no('staging_unknown'") < noneAt,
    'evaluateInstallPlan: filter, display, requester, window and computers before the staging branch');
  const none = ev.slice(noneAt, ev.indexOf('return { ok: true };', noneAt) + 20);
  check('staging: all at once refuses evidence and keeps the per-ring limits; canary keeps ring order and the gate',
    /if \(r\.evidence\) return no\('bad_evidence'/.test(none) && /no\('ring_already_signed'/.test(none) && /no\('ring_retry_limit'/.test(none)
      && !/verifiedGateTargets|evaluateRingGate/.test(none)
      && /if \(staging === 'canary' && ring === 0 && p\.targets\.length !== 1\) return no\('computer_not_in_policy'/.test(ev)
      && /if \(!prev\) return no\('ring_out_of_order'/.test(ev) && /const verified = verifiedGateTargets\(/.test(ev),
    'evaluateInstallPlan');
  check('staging: the gate\'s canary checks apply unless the caller says canary: false, which the portal says only for a "none" deployment',
    /if \(ring === 0 && g\.canary !== false\) \{/.test(pp)
      && /ring, canary: stagingOfDeployment\(d\) === 'canary', jobStatus:/.test(psvc)
      && /export const stagingOfDeployment = \(d: Pick<PatchDeployment, 'staging'>\): Staging => \(d\.staging === 'none' \? 'none' : 'canary'\);/.test(psvc)
      && /ADD COLUMN "staging" TEXT NOT NULL DEFAULT 'canary';/.test(mig) && /CHECK \("staging" IN \('none', 'canary'\)\)/.test(mig),
    'evaluateRingGate; PatchingService.gate; migration 0083');
  check('staging: the portal writes the field only for all at once, after the signer says it knows it',
    /\.\.\.\(canary \? \{\} : \{ staging: 'none' as const \}\),/.test(pol)
      && /if \(!canary && caps\.body\.patchStaging !== 1\) throw new ConflictException\(\{ code: 'SIGNER_TOO_OLD'/.test(pol)
      && /send\(res, 200, \{ patchPolicies: 1, patchStaging: 1,/.test(srv),
    'PatchPolicyService.admit; approval-signer capabilities');
  check('staging: every API create defaults to canary; a stored series without it is canary',
    /staging: z\.enum\(STAGINGS\)\.default\('canary'\),/.test(pol) && /staging: z\.enum\(STAGINGS\)\.default\('canary'\),/.test(psvc)
      && /staging: z\.enum\(STAGINGS\)\.default\('canary'\),/.test(asg) && /staging: z\.enum\(STAGINGS\)\.optional\(\),/.test(asg)
      && /export const seriesStaging = \(s: Pick<SeriesSettings, 'staging'>\): Staging => \(s\.staging === 'none' \? 'none' : 'canary'\);/.test(asg),
    'CreatePolicyDto, CreateDeploymentDto, CreateSeriesDto, SeriesSettings');
  check('staging: the suites prove it (an ungated policy, an old document still gated, an unknown value refused, a forged field caught)',
    /all at once: ring 1 is signed before ring 0, with no evidence \(not gated\)/.test(read('apps/api/scripts/unit-patch-policy.mjs'))
      && /an old document with no staging still gates/.test(read('apps/api/scripts/unit-patch-policy.mjs'))
      && /admitPolicy refuses staging/.test(read('apps/api/scripts/unit-patch-policy.mjs'))
      && /edited to staging none → policy_digest_mismatch/.test(read('apps/api/scripts/unit-patch-policy.mjs'))
      && /unit-patch-policy\.mjs/.test(read('.github/workflows/ci.yml'))
      && /section\('0\.62: all at once — no canary, every ring signed in the same window, nothing waits'\)/.test(read('apps/api/scripts/e2e-patch-policies.mjs'))
      && /'the signer refuses any gate evidence for an all-at-once plan \(bad_evidence\)'/.test(read('apps/api/scripts/e2e-patch-policies.mjs'))
      && / patch-policies /.test(read('scripts/run-e2e.sh')),
    'unit-patch-policy.mjs in CI; e2e-patch-policies.mjs (its 0.62 sections) in run-e2e.sh');
}

// ── §76 (0.63): approved policies may never expire — a signed field, fail closed ──
//     0.63 reverses "every approved policy expires within 90 days" (§63, §71,
//     §73 and the 0.32 patch policy) at the owner's request ("Does this mean
//     the policy expires? Policies shouldnt expire"), as §41, §62, §67 and §75
//     were. The reversal is narrow and signed:
//       - one value, EXPIRY_NEVER = 'never', in actions/patch-policy.ts; both
//         documents (PolicyDoc, AutomationDoc) carry `expiresAt` optional and
//         `expiry: z.literal('never')` optional, in strict schemas, so an older
//         signer refuses the field;
//       - expiryMsOf is the one reader: Infinity only for exactly "never" with
//         no date, the date for a date alone, null for anything else; every
//         caller treats null as expired, never as "never";
//       - expiryProblem is the one admission rule, in both validators: an
//         unknown value, both fields, or neither is refused, and a date keeps
//         0.32's 90-day cap;
//       - both evaluators refuse a null expiry (expiry_unknown) before
//         policy_expired, and bound the plan's notAfter by the expiry when
//         there is one; the signer's effective statuses read EXPIRED for null;
//       - the portal writes "never" only when no expiresInDays was given, after
//         the signer's neverExpires capability (SIGNER_TOO_OLD); the console
//         sends none; series revisions never carry one;
//       - the portal's sweeps read a null expiresAt (0084) as "never", never as
//         expired, and 0084's CHECKs tie the column to the signed document;
//       - nothing else is relaxed: revocation, pause, window, computers,
//         restart rules, signed pause, ledger and retry limits are unchanged.
{
  console.log('\n§76 policies that never expire');
  const pp = read('apps/api/src/actions/patch-policy.ts');
  const ap = read('apps/api/src/actions/automation-policy.ts');
  const core = read('apps/api/src/approval-signer/core.ts');
  const srv = read('apps/api/src/approval-signer/server.ts');
  const pol = read('apps/api/src/patching/policies.service.ts');
  const asg = read('apps/api/src/patching/assignment.ts');
  const ser = read('apps/api/src/patching/series.service.ts');
  const aut = read('apps/api/src/automation/automation.service.ts');
  const rws = read('apps/api/src/restart-windows/restart-windows.service.ts');
  const mig = read('apps/api/prisma/migrations/0084_policy_never_expires/migration.sql');
  const schema = read('apps/api/prisma/schema.prisma');
  const client = read('apps/web/lib/api-client.ts');
  const docBlock = (src, name) => (src.match(new RegExp(`export const ${name} = z\\.object\\(\\{([\\s\\S]*?)\\}\\)\\.strict\\(\\);`)) ?? [])[1] ?? '';
  check('expiry: one value, "never", carried by both signed documents as an optional literal beside an optional expiresAt (strict schemas)',
    /export const EXPIRY_NEVER = 'never' as const;/.test(pp)
      && [docBlock(pp, 'PolicyDoc'), docBlock(ap, 'AutomationDoc')].every((b) => /\n  expiresAt: Iso\.optional\(\),/.test(b) && /\n  expiry: z\.literal\(EXPIRY_NEVER\)\.optional\(\),/.test(b)),
    'patch-policy.ts EXPIRY_NEVER; PolicyDoc and AutomationDoc');
  check('expiry: expiryMsOf is the one reader — Infinity only for exactly "never" alone, null (expired) for anything else',
    /export function expiryMsOf\(doc: ExpiryFields\): number \| null \{\s*const never = present\(doc, 'expiry'\), at = present\(doc, 'expiresAt'\);\s*if \(never\) return doc\.expiry === EXPIRY_NEVER && !at \? Infinity : null;\s*if \(!at \|\| typeof doc\.expiresAt !== 'string'\) return null;\s*const t = Date\.parse\(doc\.expiresAt\);\s*return Number\.isFinite\(t\) \? t : null;\s*\}/.test(pp),
    'patch-policy.ts expiryMsOf');
  const ep = pp.slice(pp.indexOf('export function expiryProblem('), pp.indexOf('export function expiryInWords('));
  check('expiry: admission refuses an unknown value, both, or neither, and keeps the 90-day cap on a date — in both validators',
    /reason: 'expiry_unknown'/.test(ep) && /reason: 'expiry_conflict'/.test(ep) && /reason: 'expiry_missing'/.test(ep) && /reason: 'expiry_too_far'/.test(ep) && /export const MAX_POLICY_DAYS = 90;/.test(pp)
      && /const ex = expiryProblem\(doc, now, MAX_POLICY_DAYS, 'policy'\);\s*if \(ex\) return \{ ok: false, \.\.\.ex \};/.test(pp)
      && /const ex = expiryProblem\(doc, now, MAX_AUTOMATION_DAYS, 'automation policy'\);\s*if \(ex\) return bad\(ex\.reason, ex\.message\);/.test(ap),
    'expiryProblem; validatePolicyDoc; validateAutomationDoc');
  const standing = pp.slice(pp.indexOf('function policyStanding('), pp.indexOf('function evaluateInstallPlan('));
  const aev = ap.slice(ap.indexOf('export function evaluateAutomationPlan('), ap.indexOf("if (doc.task.kind === 'restart') return evaluateAutomationRestart("));
  const decides = (b) => /const exp = expiryMsOf\(doc\);\s*if \(exp === null\) return no\('expiry_unknown'/.test(b) && b.indexOf("no('expiry_unknown'") < b.indexOf("no('policy_expired'")
    && /if \(now\.getTime\(\) >= exp\) return no\('policy_expired'/.test(b) && /if \(Date\.parse\(p\.window\.notAfter\) > exp\) return no\('policy_expired'/.test(b)
    && b.indexOf("no('policy_revoked'") >= 0 && b.indexOf("no('policy_revoked'") < b.indexOf("no('expiry_unknown'");
  check('expiry: both evaluators refuse an unreadable expiry (expiry_unknown) before policy_expired, after revocation, and bound notAfter by a date',
    decides(standing) && decides(aev),
    'policyStanding; evaluateAutomationPlan');
  const scopes = ['apps/api/src/actions', 'apps/api/src/approval-signer', 'apps/api/src/patching', 'apps/api/src/automation', 'apps/api/src/restart-windows'];
  // expiryMsOf itself is the one place that parses it.
  const rawParse = scopes.flatMap((d) => walk(d)).filter((f) => /Date\.parse\((doc|d|r\.doc|cur\.doc)\.expiresAt\)|new Date\((doc|d|r\.doc)\.expiresAt\)/.test(read(f).replace(/export function expiryMsOf\([\s\S]*?\n\}\n/, '')));
  check('expiry: nothing reads a document\'s expiresAt directly (it would read "never" as NaN, which compares as never expired)',
    rawParse.length === 0, rawParse.length ? `raw reads in: ${rawParse.join(', ')}` : 'only expiryMsOf / expiryUntil');
  check('expiry: the signer\'s effective statuses read an unreadable expiry as EXPIRED, and it advertises neverExpires',
    (core.match(/\{ const exp = expiryMsOf\(r\.doc\); if \(exp === null \|\| now\.getTime\(\) >= exp\) return 'EXPIRED'; \}/g) ?? []).length === 2
      && /restartWindows: 1, neverExpires: 1,/.test(srv),
    'core.ts effectivePolicyStatus / effectiveAutomationStatus; capabilities');
  check('expiry: the portal signs "never" only when no expiry was asked for, after the signer says it knows it',
    /expiresInDays: z\.number\(\)\.int\(\)\.min\(1\)\.max\(MAX_POLICY_DAYS\)\.optional\(\),/.test(pol)
      && /if \(never && caps\.body\.neverExpires !== 1\) throw new ConflictException\(\{ code: 'SIGNER_TOO_OLD'/.test(pol)
      && /\.\.\.\(expiresAt \? \{ expiresAt: expiresAt\.toISOString\(\) \} : \{ expiry: EXPIRY_NEVER \}\),/.test(pol)
      && /expiresInDays: z\.number\(\)\.int\(\)\.min\(1\)\.max\(MAX_AUTOMATION_DAYS\)\.optional\(\),/.test(aut)
      && /if \(never && !\(await this\.readiness\(\)\)\.signerSupportsNeverExpiry\) throw new ConflictException\(\{ code: 'SIGNER_TOO_OLD'/.test(aut)
      && /\.\.\.\(expiresAt \? \{ expiresAt: expiresAt\.toISOString\(\) \} : \{ expiry: EXPIRY_NEVER \}\),/.test(aut)
      && /expiresInDays: z\.number\(\)\.int\(\)\.min\(7\)\.max\(MAX_AUTOMATION_DAYS\)\.optional\(\),/.test(rws),
    'CreatePolicyDto, CreateAutomationDto, SetWindowDto: optional, no default; admit / submit');
  check('expiry: a company-wide series takes no expiry, its revisions carry none, and only an expiring revision is renewed',
    /export const CreateSeriesDto = SeriesSettings\.omit\(\{ expiresInDays: true \}\)\.extend\(\{/.test(asg)
      && (ser.match(/window: settings\.window, reboot: settings\.reboot,\n/g) ?? []).length === 2 && !/reboot: settings\.reboot, expiresInDays/.test(ser)
      && /else if \(live\.expiresAt !== null && live\.expiresAt\.getTime\(\) - now <= renewLeadMs\(i\.expiresInDays\)\) trigger = 'renewal';/.test(asg)
      && /\(i\.current\.expiresAt === null \|\| i\.current\.expiresAt\.getTime\(\) > now\)/.test(asg),
    'assignment.ts CreateSeriesDto, revisionDecision; series.service.ts admits');
  const unguarded = [pol, aut, rws, ser].flatMap((src) => [...src.matchAll(/^.*\.expiresAt (<=|<|>|>=) (now|new Date\(\)).*$/gm)].map((m) => m[0].trim()))
    .filter((l) => !/expiresAt !== null && |expiresAt === null \|\| |r\.expiresAt && r\.expiresAt <= now/.test(l));
  check('expiry: the portal\'s sweeps read a null expiresAt as "never", never as expired',
    unguarded.length === 0 && /OR: \[\{ expiresAt: null \}, \{ expiresAt: \{ gt: now \} \}\]/.test(rws),
    unguarded.length ? `unguarded: ${unguarded.slice(0, 3).join(' | ')}` : 'policies, automation, restart windows, series');
  check('expiry: 0084 makes the two columns nullable and ties null to a signed "never" in the stored document',
    /ALTER TABLE "PatchPolicy" ALTER COLUMN "expiresAt" DROP NOT NULL;/.test(mig) && /ALTER TABLE "AutomationPolicy" ALTER COLUMN "expiresAt" DROP NOT NULL;/.test(mig)
      && (mig.match(/CHECK \(\s*\("expiresAt" IS NULL\) = \(\("document" ->> 'expiry'\) IS NOT DISTINCT FROM 'never' AND NOT \("document" \? 'expiresAt'\)\)\s*\)/g) ?? []).length === 2
      && (schema.match(/\n  expiresAt       DateTime\?\n/g) ?? []).length >= 2,
    'migration 0084; schema.prisma');
  const forms = ['apps/web/components/patching/patch-policies.tsx', 'apps/web/components/patching/company-policies.tsx', 'apps/web/app/(app)/automation/schedules/new/page.tsx', 'apps/web/components/restart-windows/restart-window-card.tsx', 'apps/web/components/patching/window-editor.tsx'];
  const asking = forms.filter((f) => /expiresInDays|Expires after|lasts \(days/.test(read(f)));
  const inputs = client.slice(client.indexOf('export interface PatchSeriesInput'), client.indexOf('// ─── Endpoints'));
  check('expiry: the console sends no expiry and asks for none',
    asking.length === 0 && inputs.length > 0 && !/expiresInDays:/.test(inputs),
    asking.length ? `still asks: ${asking.join(', ')}` : 'the policy, company-wide, schedule and restart window forms');
  const upp = read('apps/api/scripts/unit-patch-policy.mjs');
  check('expiry: the suites prove it (signed after 90+ days, an old document still stops, unknown values refused, a forged field caught)',
    upp.includes('canary is decided "ok" 105 days after approval') && upp.includes('an old document with an expiry still stops → policy_expired')
      && upp.includes('admitPolicy refuses expiry ${JSON.stringify(bad)} (fail closed)') && upp.includes('an expiring document edited to "never" → policy_digest_mismatch')
      && read('apps/api/scripts/unit-automation-schedule.mjs').includes('run is signed 120 days on')
      && read('apps/api/scripts/unit-patch-assignment.mjs').includes('a running revision that never expires is live and up to date')
      && read('apps/api/scripts/unit-approval-signer.mjs').includes('capabilities say the signer signs policies that never expire')
      && ['unit-patch-policy', 'unit-automation-schedule', 'unit-patch-assignment', 'unit-approval-signer', 'unit-restart-window-settings'].every((u) => read('.github/workflows/ci.yml').includes(`${u}.mjs`)),
    'unit-patch-policy, unit-automation-schedule, unit-patch-assignment, unit-approval-signer in CI');
}

// ── §77 (0.65): the Windows Installer package — a spawn on a public route ───
//     GET /public/install/windows.msi builds an .msi per request with wixl and
//     msibuild (apps/api/src/public/windows-msi.ts). It is public, so:
//       - two fixed absolute binaries, one execFile site, an argument array,
//         shell: false, a time limit, an output cap and a minimal environment;
//         the runner is called only with those two constants;
//       - the token is checked against the installers' hex charset first —
//         in the route before any lookup, and again as the first check of the
//         builder and in the query that stamps it — and nothing refused spawns;
//       - every build is in its own mkdtemp directory (0700), removed in a
//         finally; there is no cache and no other file written; the builder's
//         error (whose command line may hold the token) is replaced, and
//         nothing in the module or the route logs;
//       - the route reads the token and never consumes it (no write), and
//         packages only the signed agent target;
//       - the package runs the agent's own `install --token … --portal …`,
//         deferred as SYSTEM, on first install only, with TOKEN hidden;
//       - CI installs msitools and runs the unit suite, which fails (not
//         skips) under CI when wixl is missing.
{
  console.log('\n§77 the Windows Installer package');
  const msi = read('apps/api/src/public/windows-msi.ts');
  const pc = read('apps/api/src/public/public.controller.ts');
  const goMain = read('tools/windows-installer/main.go');
  const goAgent = read('tools/windows-installer/internal/agent/agent.go');
  const ci = read('.github/workflows/ci.yml');
  const unit = read('apps/api/scripts/unit-windows-msi.mjs');
  check('msi: two fixed absolute binaries, one execFile with an argument array, no shell, bounded time and output, a minimal environment',
    /export const WIXL_BIN = '\/usr\/bin\/wixl';/.test(msi) && /export const MSIBUILD_BIN = '\/usr\/bin\/msibuild';/.test(msi)
      && (msi.match(/\bexecFile\(/g) ?? []).length === 1 && /execFile\(bin, args, \{\s*cwd, shell: false, windowsHide: true, timeout: MSI_BUILD_TIMEOUT_MS, killSignal: 'SIGKILL', maxBuffer: 64 \* 1024,\s*env: \{ PATH: '\/usr\/bin:\/bin', LANG: 'C\.UTF-8', HOME: cwd, TMPDIR: cwd \},/.test(msi)
      && !/\b(spawn|spawnSync|execSync|execFileSync|exec)\(/.test(msi.replace(/\bexecFile\(/g, ''))
      && /export type MsiRunner = \(bin: typeof WIXL_BIN \| typeof MSIBUILD_BIN, args: string\[\], cwd: string\) => Promise<void>;/.test(msi)
      && (msi.match(/await run\(/g) ?? []).length === 2 && /await run\(WIXL_BIN, \[/.test(msi) && /await run\(MSIBUILD_BIN, args, dir\);/.test(msi),
    'windows-msi.ts runFixed / buildWindowsMsi');
  const build = msi.slice(msi.indexOf('export async function buildWindowsMsi('));
  const checkFn = msi.slice(msi.indexOf('export function checkMsiInput('), msi.indexOf('export function msiQueries('));
  const queries = msi.slice(msi.indexOf('export function msiQueries('), msi.indexOf('let building = 0;'));
  check('msi: the token is checked first, with the installers\' charset, and again where it is stamped; refusals spawn nothing',
    /export const MSI_TOKEN_RE = \/\^\[A-Fa-f0-9\]\{16,128\}\$\/;/.test(msi) && goAgent.includes('tokenRE   = regexp.MustCompile(`^[A-Fa-f0-9]{16,128}$`)')
      && /^\{\s*const \{ version \} = checkMsiInput\(input\);\s*const queries = msiQueries\(input\.token\);/.test(build.slice(build.indexOf('): Promise<Buffer> ') + 19))
      && checkFn.indexOf('MSI_TOKEN_RE.test(input.token)') > 0 && checkFn.indexOf('MSI_TOKEN_RE.test(input.token)') < checkFn.indexOf('validPortalHost(')
      && /if \(!MSI_TOKEN_RE\.test\(token\)\) throw new MsiError\('MSI_TOKEN_INVALID'/.test(queries)
      && build.indexOf('checkMsiInput(input)') < build.indexOf('msiToolsAvailable(') && build.indexOf('msiToolsAvailable(') < build.indexOf('await run('),
    'checkMsiInput, msiQueries, then the tools, then the spawn');
  check('msi: a private temporary directory per build, removed in a finally; no cache; the builder\'s error replaced; nothing logs',
    /dir = await fs\.promises\.mkdtemp\(path\.join\(os\.tmpdir\(\), 'rem0te-msi-'\)\);\s*await fs\.promises\.chmod\(dir, 0o700\);/.test(build)
      && /\} finally \{\s*building--;\s*if \(dir\) await fs\.promises\.rm\(dir, \{ recursive: true, force: true \}\)/.test(build)
      && (msi.match(/writeFile\(/g) ?? []).length === 1 && /await fs\.promises\.writeFile\(wxs, MSI_WXS, \{ mode: 0o600 \}\);/.test(msi)
      && !/new Map|cache/i.test(msi.replace(/There is no cache/g, '').replace(/no cache/g, ''))
      && /\(err\) => \(err \? reject\(new Error\('builder exited unsuccessfully'\)\) : resolve\(\)\)/.test(msi)
      && /\} catch \{\s*throw new MsiError\('MSI_BUILD_FAILED', 'The \.msi could not be built\.'\);\s*\}/.test(build)
      && !/console\.|Logger|\.log\(|\.warn\(|\.error\(/.test(msi),
    'windows-msi.ts buildWindowsMsi');
  const route = pc.slice(pc.indexOf("@Get('install/windows.msi')"), pc.indexOf("@Get('install/:platform')"));
  check('msi: the route comes before install/:platform, checks the token\'s charset before any lookup, reads it without consuming it, and packages only the signed agent',
    route.length > 0 && /@Public\(\)\s*@RateLimit\(20\)/.test(route)
      && route.indexOf('MSI_TOKEN_RE.test(token)') > 0 && route.indexOf('MSI_TOKEN_RE.test(token)') < route.indexOf('this.usableToken(token)')
      && route.indexOf('this.usableToken(token)') < route.indexOf('this.updateTrust.agentTarget()') && route.indexOf('this.updateTrust.agentTarget()') < route.indexOf('buildWindowsMsi(')
      && /buildWindowsMsi\(\{ agentPath: agentT\.path, portalHost, version: this\.agentVersion\(\), token \}\)/.test(route)
      && !/\.(create|update|upsert|delete|deleteMany|updateMany)\(|logger|console\./.test(route)
      && /res\.setHeader\('Content-Type', MSI_CONTENT_TYPE\);/.test(route) && /export const MSI_CONTENT_TYPE = 'application\/x-msi';/.test(msi)
      && /res\.setHeader\('Cache-Control', 'no-store'\);/.test(route),
    'public.controller.ts windowsMsi');
  check('msi: the package runs the agent\'s own install, deferred as SYSTEM, on first install only, TOKEN hidden and secure, from a constant source',
    /export const MSI_ACTION_TYPE = 3074;/.test(msi) && /export const MSI_ACTION_TARGET = 'install --token \[TOKEN\] --portal \[Rem0tePortal\]';/.test(msi)
      && /export const MSI_ACTION_CONDITION = 'NOT Installed AND NOT REMOVE';/.test(msi)
      && /<Property Id="MsiHiddenProperties" Value="TOKEN"\/>/.test(msi) && /export const MSI_SECURE_PROPERTIES = 'TOKEN;/.test(msi)
      && (msi.slice(msi.indexOf('export const MSI_WXS'), msi.indexOf('export interface MsiInput')).match(/\$\{/g) ?? []).length === 1
      && /Installed OR \(TOKEN AND NOT \(TOKEN &gt;&lt; " "\) AND NOT \(TOKEN &gt;&lt; Rem0teTab\) AND NOT \(TOKEN &gt;&lt; Rem0teQuote\)\)/.test(msi)
      && /token := fs\.String\("token", "", "claim token \(install\)"\)/.test(goMain) && /portal := fs\.String\("portal", "", "portal host\[:port\]"\)/.test(goMain),
    'MSI_ACTION_*, MSI_WXS; main.go subcommand flags');
  check('msi: CI installs msitools and runs the unit suite, which fails under CI without wixl',
    /sudo apt-get install -y wixl msitools/.test(ci) && /node apps\/api\/scripts\/unit-windows-msi\.mjs/.test(ci)
      && unit.includes("process.env.CI === 'true' || process.env.REQUIRE_MSI_TOOLS === '1'") && /check\(false, 'msitools is installed/.test(unit),
    'ci.yml; unit-windows-msi.mjs');
}

// ── §78 (0.66): alert classification — narrow, deterministic, never above the monitor ──
//     The pre-0.66 recommended disk-errors monitor named no level and no
//     provider, so Kernel-General's informational event 11 for a registry hive
//     in a read-only shadow copy was a critical disk alert (DS-HOME1). So:
//       - classify.ts is pure (node:crypto only) and versioned;
//       - every known-benign pattern names log, provider, event id, quiet
//         levels only, an 8-digit status code and a component, and the
//         matcher compares every one of them — never message words;
//       - the classifier never raises an alert above the monitor's severity,
//         never lowers one by level in the Security log or at level 0, and
//         leaves an unknown event at the monitor's severity;
//       - events counted but not sent keep an alert at WARNING at least;
//       - fingerprints keep 8-digit status codes;
//       - the recommended monitor asks for levels, none of them 4 or 5;
//       - the start-up correction is a conditional write on the exact pre-0.66
//         parameters and audited; reclassification is conditional on the
//         version it read, audited, and deletes nothing;
//       - a report is classified, and its events recorded, before anything is
//         raised; similar alerts are read through the caller's alert scope.
{
  console.log('\n§78 alert classification');
  const cls = read('apps/api/src/monitoring/classify.ts');
  const eng = read('apps/api/src/monitoring/engine.ts');
  const aq = read('apps/api/src/monitoring/alert-quality.service.ts');
  const ms = read('apps/api/src/monitoring/monitoring.service.ts');
  const adm = read('apps/api/src/monitoring/monitoring-admin.service.ts');
  const ws = read('apps/api/src/public/windows-script.ts');
  const J = JSON.stringify;
  const imports = [...cls.matchAll(/^import .* from '([^']+)';/gm)].map((m) => m[1]);
  check('classify: pure — it imports node:crypto and nothing else, and is versioned',
    J(imports) === J(['node:crypto']) && /export const CLASSIFIER_VERSION = [1-9]\d*;/.test(cls) && !/process\.env|fetch\(|Date\.now\(|new Date\(/.test(cls),
    `imports: ${imports.join(', ')}`);
  const benignBlock = cls.slice(cls.indexOf('export const KNOWN_BENIGN'), cls.indexOf('export function benignMatch'));
  const entries = benignBlock.split(/\n  \{\n/).slice(1);
  const entryOk = (e) => /\n {4}id: '[a-z0-9-]+',/.test(e) && /\n {4}log: '(System|Application|Setup)',/.test(e) && /\n {4}provider: '[A-Za-z0-9 _.\/-]+',/.test(e)
    && /\n {4}eventId: \d+,/.test(e) && /\n {4}levels: \[[45](, ?[45])?\],/.test(e) && /\n {4}statusCode: '0x[0-9A-F]{8}',/.test(e) && /\n {4}component: '[a-z-]+',/.test(e);
  const matcher = cls.slice(cls.indexOf('export function benignMatch'), cls.indexOf('// ── Catalogued events'));
  check('classify: every known-benign pattern names log, provider, id, quiet levels, status code and component; the matcher checks all six',
    entries.length >= 1 && entries.every(entryOk)
      && ['f.log !== p.log', 'f.providerKey !== p.provider.toLowerCase()', 'f.eventId !== p.eventId', '!p.levels.includes(f.level)', 'f.statusCode !== p.statusCode', 'f.component !== p.component'].every((t) => matcher.includes(t))
      && !/message/.test(matcher.replace(/\/\/.*$/gm, '')),
    `${entries.length} entries; matcher: ${matcher.slice(0, 200)}`);
  check('classify: never above the monitor; never lowered by level in the Security log or at level 0; unknown keeps the monitor; unseen keeps WARNING',
    /export const QUIET_LEVELS: ReadonlySet<number> = new Set\(\[4, 5\]\);/.test(cls)
      && /QUIET_LEVELS\.has\(f\.level\) && log !== 'Security' && !ruleLevels\.includes\(f\.level\)/.test(cls)
      && /d\.class === 'UNKNOWN' \? ruleSeverity : d\.class === 'BENIGN' \? 'INFO' : minSev\(CLASS_SEVERITY\[d\.class\], ruleSeverity\)/.test(cls)
      && /const up = minSev\('CRITICAL', ruleSeverity\);/.test(cls) && /const floor = minSev\('WARNING', ruleSeverity\);/.test(cls)
      && /if \(unseen > 0 && RANK\[sev\] < RANK\.WARNING\)/.test(cls),
    'classify.ts decideSample / sevOf / classifyEvents');
  check('classify: fingerprints keep 8-digit status codes (only 9+ hex digits are taken out)',
    /\.replace\(\/\(\?<!\[0-9a-z\]\)0x\[0-9a-f\]\{9,\}\(\?!\[0-9a-f\]\)\/g, '<hex>'\)/.test(cls) && !/0x\[0-9a-f\]\{8\}\/g/.test(cls.slice(cls.indexOf('export function normaliseMessage'), cls.indexOf('export function fingerprintOf'))),
    'normaliseMessage');
  const dp = /export const DISK_ERRORS_PARAMS = \{ log: 'System', ids: \[([\d, ]+)\], levels: \[([\d, ]+)\],/.exec(eng);
  check('the recommended disk-errors monitor asks for levels, none of them Information or Verbose, and still watches 7, 11, 51 and 153',
    !!dp && dp[2].split(',').map(Number).every((l) => l >= 1 && l <= 3) && [7, 11, 51, 153].every((i) => dp[1].split(',').map(Number).includes(i))
      && /\{ key: 'disk-errors', kind: 'EVENT_MATCH', name: 'Disk errors in the System log', severity: 'CRITICAL', params: DISK_ERRORS_PARAMS \},/.test(eng),
    'engine.ts DISK_ERRORS_PARAMS / RECOMMENDED');
  check('start-up: the correction is conditional on the exact pre-0.66 parameters and audited; reclassification is conditional, audited, and deletes nothing',
    /this\.prisma\.monitorRule\.updateMany\(\{ where: \{ id: r\.id, key: 'disk-errors', kind: 'EVENT_MATCH', params: \{ equals: old \} \}/.test(aq)
      && aq.indexOf("action: 'MONITOR_RULE_CHANGED'") > aq.indexOf('if (!u.count) continue;')
      && /where: \{ id: a\.id, state: \{ not: 'RESOLVED' \}, classifierVersion: a\.classifierVersion \}/.test(aq)
      && /action: 'MONITOR_ALERT_RECLASSIFIED'/.test(aq) && /type: 'reclassified'/.test(aq)
      && !/\.(delete|deleteMany)\(/.test(aq) && !/monitorRule\.(update|upsert)\(/.test(aq),
    'alert-quality.service.ts');
  const ing = ms.slice(ms.indexOf("} else if (r.kind === 'EVENT_MATCH') {"), ms.indexOf('/** After a heartbeat wrote a live sample'));
  check('a report is classified and its events recorded before anything is raised; the threshold sees the classified count',
    ing.indexOf('classifyEvents(') > 0 && ing.indexOf('classifyEvents(') < ing.indexOf('this.recordFingerprints(') && ing.indexOf('this.recordFingerprints(') < ing.indexOf('evaluateEvents(')
      && ing.indexOf('evaluateEvents(') < ing.indexOf('this.apply(') && /cls \? cls\.effectiveCount : 0\)/.test(ing)
      && /const severity = \(decided\.severity \?\? rule\.severity\) as Severity;/.test(ms),
    'monitoring.service.ts ingestReport / raise');
  check('similar alerts are read through the caller\'s alert scope',
    /\{ where: \{ AND: \[\{ fingerprint: r\.fingerprint, id: \{ not: id \} \}, where\] \}/.test(adm) && /const where = this\.alertWhere\(a, businessId\);/.test(adm),
    'monitoring-admin.service.ts getAlert');
  check('the agent sends at most five samples, each at most 300 characters, and only reads',
    /foreach \(\\\$h5 in @\(\\\$hits \| Select-Object -First 5\)\)/.test(ws) && /if \(\\\$m5\.Length -gt 300\) \{ \\\$m5 = \\\$m5\.Substring\(0, 300\) \}/.test(ws)
      && /e\.samples\.slice\(0, Math\.min\(SAMPLES_MAX, count\)\)/.test(eng) && /export const SAMPLES_MAX = 5;/.test(eng),
    'windows-script.ts monitor block; engine.ts sanitizeReport');
  check('alert classification: the suites prove it',
    / alert-quality /.test(read('scripts/run-e2e.sh')) && /unit-alert-classification\.mjs/.test(read('.github/workflows/ci.yml')),
    'e2e-alert-quality.mjs in run-e2e.sh, unit-alert-classification.mjs in CI');
}

// ── §79 (0.67): false positives and alert quality rules ─────────────────────
//     A report of a false positive is a person's opinion about one alert. It
//     never changes a monitor or a rule, however many people make it. A rule
//     that suppresses, downgrades or holds back alerts applies only once it
//     was tested against stored history and approved, and never crosses a
//     business:
//       - quality-rules.ts is pure (node:crypto, zod, ./engine, ./classify);
//         a rule applies only while `active` (and unexpired); a pending rule
//         is counted in the shadow, never applied; every scope stays in its
//         own business, and only a platform/OS-everywhere/global-monitor rule
//         reaches more than one;
//       - the false-positive service writes no monitor and no rule; its audit
//         meta carries no comment;
//       - only QualityRulesService creates or changes a rule's status; the
//         engine writes counters only, by conditional updateMany;
//       - a rule for every business is a Platform Admin's; `allowBroad` is a
//         Platform Admin's; every create and edit runs the narrowness check;
//       - approving needs a current simulation, accepted dangerous matches,
//         a different second approver for a high-risk rule, and
//         assertFresh('monitoring.qualityrule') after those checks and before
//         the first write; reject and rollback never ask;
//       - rules apply on the ingest path after the events are recorded and
//         before the threshold, and before a threshold alert is raised — so
//         before any notification or ticket;
//       - expiry runs only inside the monitoring sweep; admin mail goes only
//         to confirmed recipients and stops under a `notifications` pause;
//       - 0086 holds the one-active-rule index, the approval and
//         second-approver CHECKs and the same-business trigger.
{
  console.log('\n§79 false positives and alert quality rules');
  const qr = read('apps/api/src/monitoring/quality-rules.ts');
  const eng = read('apps/api/src/monitoring/quality-engine.service.ts');
  const svc = read('apps/api/src/monitoring/quality-rules.service.ts');
  const fp = read('apps/api/src/monitoring/false-positive.service.ts');
  const ctl = read('apps/api/src/monitoring/alert-quality.controller.ts');
  const ms = read('apps/api/src/monitoring/monitoring.service.ts');
  const tk = read('apps/api/src/monitoring/alert-tickets.service.ts');
  const mig = read('apps/api/prisma/migrations/0086_alert_quality_rules/migration.sql');
  const J = JSON.stringify;
  const imports = [...qr.matchAll(/^import [\s\S]*? from '([^']+)';/gm)].map((m) => m[1]);
  check('quality-rules.ts: pure — node:crypto, zod, ./engine and ./classify only; no clock, environment or network',
    J(imports) === J(['node:crypto', 'zod', './engine', './classify']) && !/process\.env|fetch\(|Date\.now\(/.test(qr),
    `imports: ${imports.join(', ')}`);
  const covers = qr.slice(qr.indexOf('export function scopeCovers'), qr.indexOf('export function eventMatches'));
  check('a rule applies only while active and unexpired; a pending rule is only counted; no scope crosses a business',
    /export const inForce = \(r: QualityRuleLike, now: Date\) => r\.status === 'active' && /.test(qr)
      && /const live = rules\.filter\(\(r\) => inForce\(r, now\)\);/.test(qr) && /const shadow = rules\.filter\(\(r\) => r\.status === 'pending'\);/.test(qr)
      && /pickRule\(live, c, d\)/.test(qr) && /pickRule\(rules\.filter\(\(r\) => inForce\(r, now\)\), c, null\)/.test(qr)
      && /case 'endpoint': return r\.endpointId === c\.endpointId && r\.customerId === c\.customerId;/.test(covers)
      && /case 'group': return !!r\.groupId && c\.groupIds\.has\(r\.groupId\) && r\.customerId === c\.customerId;/.test(covers)
      && /case 'business': return !!r\.customerId && r\.customerId === c\.customerId;/.test(covers)
      && /case 'platform': return r\.customerId === null;/.test(covers) && /default: return false;/.test(covers),
    'quality-rules.ts inForce / adjustSamples / adjustThreshold / scopeCovers');
  const fpMeta = fp.slice(fp.indexOf("action: 'ALERT_FALSE_POSITIVE_REPORTED'"), fp.indexOf("action: 'ALERT_FALSE_POSITIVE_REPORTED'") + 600);
  check('a false-positive report writes no monitor and no rule, and its audit meta carries no comment',
    !/monitorRule\.(create|update|updateMany|upsert|delete|deleteMany)\(/.test(fp) && !/alertQualityRule\.(create|update|updateMany|upsert|delete|deleteMany)\(/.test(fp)
      && fpMeta.length > 100 && !/comment/.test(fpMeta.slice(fpMeta.indexOf('meta:'), fpMeta.indexOf('});'))),
    'false-positive.service.ts');
  const writers = walk('apps/api/src').filter((f) => /alertQualityRule\.(create|update|upsert|delete|deleteMany)\(/.test(read(f)));
  const engWrites = [...eng.matchAll(/alertQualityRule\.(\w+)\(\{ where: \{ id: h\.ruleId, status: '(\w+)' \}, data: \{ ([^}]*)/g)];
  check('only QualityRulesService creates or changes a rule; the engine writes counters only, conditionally',
    J(writers.map((f) => f.replace(/^.*apps\/api\/src\//, ''))) === J(['monitoring/quality-rules.service.ts'])
      && engWrites.length === 2 && engWrites.every((m) => m[1] === 'updateMany' && !/status|behaviour|match:|scope/.test(m[3]))
      && !/alertQualityRule\.(create|update|upsert|delete)\(/.test(eng),
    `writers: ${writers.join(', ')}; engine writes: ${engWrites.length}`);
  check('a rule for every business, and allowBroad, are a Platform Admin\'s; create and edit run the narrowness and expiry checks',
    /if \(customerId === null\) this\.platformOnly\(a\);\n\s*else this\.admin\.assertConfigure\(a, customerId\);/.test(svc)
      && /if \(!a\.isPlatformAdmin \|\| a\.technician\) throw new ForbiddenException\(\{ code: 'PLATFORM_ADMIN_ONLY'/.test(svc)
      && /if \(d\.allowBroad && \(!a\.isPlatformAdmin \|\| a\.technician\)\)/.test(svc)
      && /const np = narrownessProblem\(/.test(svc) && /const ep = expiryProblem\(d, now\);/.test(svc)
      && (svc.match(/await this\.check\(a, /g) ?? []).length === 2,
    'quality-rules.service.ts resolveScope / check');
  const appr = svc.slice(svc.indexOf('  async approve('), svc.indexOf('  async reject('));
  const at = (s) => appr.indexOf(s);
  check('approve: scope, a current simulation, accepted dangerous matches, a different second approver, then fresh authentication, then the first write',
    at('await this.assertManage(a, r);') > 0 && at("code: 'SIMULATION_REQUIRED'") > at('await this.assertManage(a, r);')
      && at("code: 'DANGEROUS_MATCHES'") > at("code: 'SIMULATION_REQUIRED'") && at("code: 'SECOND_APPROVER_REQUIRED'") > at("code: 'DANGEROUS_MATCHES'")
      && at('fresh();') > at("code: 'SECOND_APPROVER_REQUIRED'") && at('fresh();') < at('updateMany(') && (appr.match(/fresh\(\);/g) ?? []).length === 1
      && /return \(\) => assertFresh\([^;]*\{ action: 'monitoring\.qualityrule' \}\);/.test(ctl)
      && /this\.rules\.approve\(a, id, body, this\.fresh\(req\)\)/.test(ctl) && (ctl.match(/this\.fresh\(req\)/g) ?? []).length === 1
      && !/fresh\(/.test(svc.slice(svc.indexOf('  async reject('), svc.indexOf('  private async applyToOpen('))),
    'quality-rules.service.ts approve; alert-quality.controller.ts');
  const ing = ms.slice(ms.indexOf("} else if (r.kind === 'EVENT_MATCH') {"), ms.indexOf('/** After a heartbeat wrote a live sample'));
  const raise = ms.slice(ms.indexOf('let decided = cls ?? classifyThreshold(rule.severity);'), ms.indexOf('const severity = (decided.severity ?? rule.severity) as Severity;'));
  check('rules apply after the events are recorded and before the threshold; a threshold alert\'s rule before it is raised',
    ing.indexOf('this.recordFingerprints(') > 0 && ing.indexOf('this.quality.forEvents(') > ing.indexOf('this.recordFingerprints(')
      && ing.indexOf('this.quality.forEvents(') < ing.indexOf('evaluateEvents(') && /classifyEvents\(view, \{ count: ev\.count, samples: ev\.samples \}, q\.adjust\)/.test(ing)
      && raise.length > 0 && /const t = await this\.quality\.forThreshold\(/.test(raise) && /if \(t\.severity === null\) return null;/.test(raise),
    'monitoring.service.ts ingestReport / raise');
  check('expiry runs only in the monitoring sweep; nothing in the quality services has its own timer',
    /onModuleInit\(\) \{ this\.mon\.addSweepStep\('quality-rules', \(now\) => this\.expiryPass\(now\)\); \}/.test(svc)
      && ![svc, eng, fp].some((s) => /setInterval|setTimeout|@Cron|@Interval/.test(s)),
    'quality-rules.service.ts onModuleInit');
  const notify = svc.slice(svc.indexOf('  async notifyAdmins('), svc.indexOf('const RANKS'));
  check('rule mail: a notifications pause stops it, only confirmed recipients, never throws',
    notify.indexOf("activePause(this.prisma, 'notifications', r.customerId)") > 0 && /verifiedAt: \{ not: null \}/.test(notify) && /this\.email\.sendToRecipients\(/.test(notify)
      && /\} catch \(e\) \{/.test(notify) && !/sample|message|comment/.test(notify.slice(notify.indexOf('const lines'), notify.indexOf('const admins'))),
    'quality-rules.service.ts notifyAdmins');
  check('tickets: one event signature on one computer gets one ticket a day, linked rather than resent',
    /if \(!prior && a\.fingerprint && a\.kind === 'EVENT_MATCH' && await this\.linkDuplicate\(a, now\)\) continue;/.test(tk)
      && tk.indexOf('this.linkDuplicate(a, now)') < tk.indexOf('this.psa.alertTicket(') && /status: 'gave_up', attempts: 1, lastAttemptAt: now, lastStatus: 'duplicate'/.test(tk),
    'alert-tickets.service.ts');
  check('0086: one active rule per scope and conditions, approvals, a distinct second approver, the same-business trigger',
    /CREATE UNIQUE INDEX "AlertQualityRule_active_key" ON "AlertQualityRule"\("scopeKey", "matchKey"\) WHERE "status" = 'active';/.test(mig)
      && /"secondApprovedById" <> "approvedById"/.test(mig) && /CREATE TRIGGER "AlertQualityRule_business" BEFORE INSERT OR UPDATE/.test(mig)
      && /"simulatedRevision" = "revision"/.test(mig),
    '0086 migration');
  check('alert quality rules: the suites prove it',
    / alert-quality-rules /.test(read('scripts/run-e2e.sh')) && /unit-alert-quality-rules\.mjs/.test(read('.github/workflows/ci.yml')),
    'e2e-alert-quality-rules.mjs in run-e2e.sh, unit-alert-quality-rules.mjs in CI');
}

// ── §80 (0.69): Managed Secure Access readiness — read-only, signed, never managed ──
//     Build step 2 of docs/managed-secure-access.md. The signed agent reads
//     an installed RustDesk and reports; the portal stores the report and
//     shows a readiness state. Nothing changes on any computer:
//       - the agent's preflight builds its argv only through msa.ReadArgs —
//         exactly {"--option", <key on the closed list>}, never a value — and
//         nothing in the preflight names `--password`;
//       - it runs only %ProgramFiles%\RustDesk\rustdesk.exe by its absolute
//         path, through its one exec site (no shell), only when that file is
//         installed and is what the RustDesk service runs; the service is
//         opened with query rights only; no path comes from the heartbeat;
//       - the portal accepts the block only from an authenticated heartbeat
//         on the signed channel that may act (§64), after the not-may-act and
//         pooled returns; only MsaService writes the table; a malformed block
//         is dropped (strict zod), never an error;
//       - msa/readiness.ts is pure and cannot produce managed,
//         managed_verified or enforcement_failure, and never says verified;
//       - the readiness routes are GETs under computers:view, reading
//         computers only through endpointVisibilityWhere.
{
  console.log('\n§80 Managed Secure Access readiness');
  const J = JSON.stringify;
  const goMsa = read('tools/windows-installer/internal/msa/preflight.go');
  const goWin = read('tools/windows-installer/rustdesk_preflight_windows.go');
  const goMain = read('tools/windows-installer/main.go');
  const ws = read('apps/api/src/public/windows-script.ts');
  const pre = read('apps/api/src/msa/preflight.ts');
  const rd = read('apps/api/src/msa/readiness.ts');
  const svc = read('apps/api/src/msa/msa.service.ts');
  const ctl = read('apps/api/src/msa/msa.controller.ts');
  const enr = read('apps/api/src/enrollment/enrollment.service.ts');
  const dto = read('apps/api/src/enrollment/dto/enrollment.dto.ts');
  const mig = read('apps/api/prisma/migrations/0087_rustdesk_preflight/migration.sql');
  const strip = (s) => s.split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');

  const goKeys = [...(/var Keys = \[\]string\{([^}]*)\}/.exec(goMsa)?.[1] ?? '').matchAll(/"([a-z-]+)"/g)].map((m) => m[1]);
  const tsKeys = [...(/export const PREFLIGHT_KEYS = \[([^\]]*)\]/.exec(pre)?.[1] ?? '').matchAll(/'([a-z-]+)'/g)].map((m) => m[1]);
  const readArgs = goMsa.slice(goMsa.indexOf('func ReadArgs('), goMsa.indexOf('}', goMsa.indexOf('return []string{"--option", key}')) + 1);
  check('the preflight reads only: ReadArgs is exactly {"--option", key} for the closed list (the same eleven keys on the agent and the portal), nil otherwise',
    goKeys.length === 11 && J(goKeys) === J(tsKeys)
      && /if !isKey\(key\) \{\n\s*return nil\n\s*\}\n\s*return \[\]string\{"--option", key\}/.test(readArgs)
      && (goMsa.match(/\[\]string\{"--option"/g) ?? []).length === 1,
    `agent keys ${J(goKeys)}; portal keys ${J(tsKeys)}`);
  const goFiles = [];
  (function gw(dir) {
    for (const n of readdirSync(join(ROOT, dir))) {
      const rel = `${dir}/${n}`;
      if (statSync(join(ROOT, rel)).isDirectory()) gw(rel); else if (n.endsWith('.go') && !n.endsWith('_test.go')) goFiles.push(rel);
    }
  })('tools/windows-installer');
  // 0.72 replaced "only the preflight names --option" with the exact list:
  // the preflight's reads (internal/msa, its runner) and enforcement's
  // closed argument builders (internal/msa/enforce/args.go, §82). Nothing
  // in the preflight names --password; only enforce/args.go does.
  const optionSites = goFiles.filter((f) => /"--option"/.test(strip(read(f))));
  const pwInPreflight = ['tools/windows-installer/internal/msa/preflight.go', 'tools/windows-installer/rustdesk_preflight_windows.go']
    .filter((f) => /--password/.test(read(f)));
  const pwSites = goFiles.filter((f) => /"--password"/.test(strip(read(f))));
  check('nothing in the preflight names --password; --option is named only by the preflight and enforce/args.go, --password only by enforce/args.go',
    pwInPreflight.length === 0
      && J(optionSites) === J(['tools/windows-installer/internal/msa/enforce/args.go', 'tools/windows-installer/internal/msa/preflight.go', 'tools/windows-installer/rustdesk_preflight_windows.go'])
      && J(pwSites) === J(['tools/windows-installer/internal/msa/enforce/args.go']),
    `--password in the preflight ${J(pwInPreflight)}; --option in ${J(optionSites)}; "--password" in ${J(pwSites)}`);
  const execs = [...strip(goWin).matchAll(/exec\.\w+\(/g)];
  check('one exec site: the installed rustdesk.exe by absolute path with msa.ReadArgs, an argument array, no shell, no window, output capped',
    execs.length === 1 && /cmd := exec\.CommandContext\(ctx, r\.exe, msa\.ReadArgs\(args\[1\]\)\.\.\.\)/.test(goWin)
      && /if len\(args\) != 2 \|\| args\[0\] != "--option" \|\| msa\.ReadArgs\(args\[1\]\) == nil \{/.test(goWin)
      && /return filepath\.Join\(pf, "RustDesk", "rustdesk\.exe"\)/.test(goWin) && /exe := installedRustdeskExe\(\)\n\s*f, fp := preflightFacts\(exe\)\n\s*return msa\.Run\(ctx, preflightRunner\{exe: exe\}, f, time\.Now\), fp/.test(goWin)
      && /CreationFlags: windows\.CREATE_NO_WINDOW/.test(goWin) && /cmd\.Stdout = out/.test(goWin)
      && !/cmd\.exe|powershell|"\/c"/i.test(strip(goWin)),
    'rustdesk_preflight_windows.go preflightRunner.Read / installedRustdeskExe / runPreflight');
  check('it runs only when that exe is installed (no reparse point) and is what the RustDesk service runs; the service is opened with query rights only',
    /if rep\.Installed && rep\.ExpectedPath \{/.test(goMsa) && /ExpectedPath: f\.Installed && f\.ExpectedPath,/.test(goMsa)
      && /attrs&windows\.FILE_ATTRIBUTE_REPARSE_POINT != 0/.test(goWin)
      && /windows\.OpenService\(scm, windows\.StringToUTF16Ptr\("RustDesk"\), windows\.SERVICE_QUERY_CONFIG\|windows\.SERVICE_QUERY_STATUS\)/.test(goWin)
      && /windows\.OpenSCManager\(nil, nil, windows\.SC_MANAGER_CONNECT\)/.test(goWin)
      && !/mgr\.Connect|ChangeServiceConfig|UpdateConfig|\.Control\(|\.Start\(|SERVICE_ALL_ACCESS/.test(strip(goWin)),
    'internal/msa Run; rustdesk_preflight_windows.go rustdeskService');
  check('no path comes from the heartbeat: the subcommand takes only --force, and the heartbeat starts it with no argument',
    /if args\[0\] == "rustdesk-preflight" \{\n\s*return cmdRustdeskPreflight\(args\[1:\]\)/.test(goMain)
      && /force := len\(args\) == 1 && args\[0\] == "--force"\n\s*if len\(args\) > 0 && !force \{/.test(goWin)
      && /Start-Process -FilePath \$agentExe -ArgumentList @\('rustdesk-preflight'\) -WindowStyle Hidden/.test(ws) && !/'rustdesk-preflight', /.test(ws),
    'main.go subcommand; cmdRustdeskPreflight; windows-script.ts');

  const call = enr.indexOf('this.msa.recordPreflight(');
  const guard = enr.lastIndexOf('if (', call);
  check('the portal accepts the block only from an authenticated signed heartbeat that may act, after the not-may-act and pooled returns',
    (enr.match(/this\.msa\.recordPreflight\(/g) ?? []).length === 1
      && enr.slice(guard, call).startsWith("if (authenticated && mayAct && kind === 'signed' && dto.rustdeskPreflight !== undefined) {")
      && call > enr.indexOf('if (authenticated && !mayAct) {') && call > enr.indexOf('if (authenticated && pooled) {')
      && walk('apps/api/src').filter((f) => /\.recordPreflight\(/.test(read(f))).every((f) => /enrollment\/enrollment\.service\.ts$/.test(f)),
    'enrollment.service.ts heartbeat');
  const writers = walk('apps/api/src').filter((f) => /rustdeskPreflight\.(create|update|updateMany|upsert|delete|deleteMany|createMany)\(/.test(read(f)));
  check('only MsaService writes RustdeskPreflight; a malformed block is dropped, never an error to any agent',
    J(writers.map((f) => f.replace(/^.*apps\/api\/src\//, ''))) === J(['msa/msa.service.ts'])
      && /@Allow\(\) rustdeskPreflight\?: unknown;/.test(dto) && /export const Preflight = z\.strictObject\(\{/.test(pre) && /keys: z\.strictObject\(keyShape\),/.test(pre)
      && /const p = Preflight\.safeParse\(raw\);\n\s*if \(!p\.success\) return null;/.test(pre) && /const p = parsePreflight\(raw, now\.getTime\(\)\);\n\s*if \(!p\) return null;/.test(svc),
    `writers: ${writers.join(', ')}`);
  const rdImports = [...rd.matchAll(/^import [\s\S]*? from '([^']+)';/gm)].map((m) => m[1]);
  const decide = rd.slice(rd.indexOf('export function decideReadiness'));
  const pureDeps = ['apps/api/src/common/connectivity.ts', 'apps/api/src/common/platform.ts'].every((f) => !/^import /m.test(read(f)));
  // 0.72: the managed states come only from the caller's managed fact (the
  // MsaManagedComputer row), inside one branch after rules 1–3, and
  // `verified` is true exactly for managed_verified (§82).
  const branch = decide.slice(decide.indexOf('const m = f.managed;'), decide.indexOf('// 4. An agent that can report.'));
  const outside = decide.replace(branch, '').replace("verified: state === 'managed_verified'", '');
  check('readiness.ts is pure; a preflight alone cannot produce a managed state, and only a recent readback on a verified row says verified',
    J(rdImports) === J(['../common/connectivity', '../common/platform']) && pureDeps && !/process\.env|fetch\(|prisma/i.test(rd)
      && /export const READINESS_STATES = \['unsupported', 'upgrade_available', 'compatible', 'unknown'\] as const/.test(rd)
      && /export const MANAGED_READINESS_STATES = \['managed', 'managed_verified', 'enforcement_failure'\] as const/.test(rd)
      && /state: ProducibleState;/.test(rd) && /state, label: STATE_LABEL\[state\], reasons, verified: state === 'managed_verified',/.test(decide)
      && branch.length > 0 && decide.indexOf('const m = f.managed;') > decide.indexOf('// 3.') && !/'managed'|'managed_verified'|'enforcement_failure'/.test(outside)
      && /if \(!Number\.isFinite\(rb\) \|\| now - rb > REPORT_MAX_AGE_MS\) \{\n\s*return out\('unknown'/.test(branch)
      && (branch.match(/out\('managed_verified'/g) ?? []).length === 1,
    `imports: ${rdImports.join(', ')}`);
  const routes = [...ctl.matchAll(/@(Get|Post|Put|Patch|Delete)\(/g)].map((m) => m[1]);
  check('the readiness routes are GETs under computers:view, reading computers only through endpointVisibilityWhere',
    J(routes) === J(['Get', 'Get']) && (ctl.match(/@RequireCapability\(CAP\.COMPUTERS_VIEW\)/g) ?? []).length === 2
      && /@UseGuards\(JwtAuthGuard, CapabilitiesGuard\)/.test(ctl)
      && /const vis = this\.acl\.endpointVisibilityWhere\(actor, businessId\);\n\s*const rows = await this\.prisma\.endpoint\.findMany\(\{\n\s*where: \{ AND: \[vis, /.test(svc)
      && /await this\.acl\.assertEndpointInScope\(actor, endpointId, 'computers:view'\);\n\s*const r = await this\.prisma\.endpoint\.findFirst\(\{ where: \{ AND: \[\{ id: endpointId \}, this\.acl\.endpointVisibilityWhere\(actor\)\] \}/.test(svc)
      && (svc.match(/this\.prisma\.endpoint\.find/g) ?? []).length === 3
      && /const r = await this\.prisma\.endpoint\.findUnique\(\{ where: \{ id: endpointId \}, select: READ_SELECT \}\);/.test(svc.slice(svc.indexOf('async preflightReadiness(')))
      && !/@\w+\(/.test(svc.slice(svc.indexOf('async preflightReadiness('), svc.indexOf('async pollWanted('))),
    'msa.controller.ts / msa.service.ts (0.72: preflightReadiness reads by id for MsaManagedService, which scope-checked first; it is not a route)');
  check('0087 CHECKs the schema, version, build, service, cli, counts and not_run',
    ['RustdeskPreflight_schema_check', 'RustdeskPreflight_version_check', 'RustdeskPreflight_build_check', 'RustdeskPreflight_service_check',
      'RustdeskPreflight_cli_check', 'RustdeskPreflight_keys_check', 'RustdeskPreflight_keysOk_check', 'RustdeskPreflight_not_run_check'].every((c) => mig.includes(`"${c}" CHECK`))
      && /ON DELETE CASCADE/.test(mig),
    '0087 migration');
  check('MSA readiness: the suites prove it',
    / msa-readiness[ ;]/.test(read('scripts/run-e2e.sh')) && /unit-msa-readiness\.mjs/.test(read('.github/workflows/ci.yml'))
      && /TestLabRustdeskPreflight/.test(read('.github/workflows/lab-windows.yml')),
    'e2e-msa-readiness.mjs in run-e2e.sh, unit-msa-readiness.mjs in CI, TestLabRustdeskPreflight in the Windows lab');
}

// ── §81 (0.71): Managed Secure Access grants and the long-poll — behind MSA_GRANTS, off ──
//     Build step 3 of docs/managed-secure-access.md. The portal can sign a
//     session grant and hand it to a signed agent over a long-poll; nothing on
//     a computer acts on one, and nothing but a Platform Admin's test route
//     issues one:
//       - the switch is exactly MSA_GRANTS === 'on', read in one file, and a
//         middleware on both grant controllers answers 404 MSA_NOT_ENABLED
//         before the throttler, the session guard or the handler; every
//         public service method asserts it again first;
//       - the grant key and the grants are written only by MsaGrantService,
//         the three rem0te-msa-grant-* secret-box purposes are used only
//         there, and no audit meta, log line or answer carries the private
//         key, the password or the envelope;
//       - issuing is a Platform Admin with a fresh confirmation (msa.grant),
//         then scope, the pool, Windows and the signed agent, the `remote`
//         pause, the key, and the audit row (logOrFail) before the grant row;
//         nothing outside the controller calls it and the module exports
//         nothing. 0.73 (§83): exactly three issuers, each with one caller —
//         issueTest (the test route), issueForConnect (MsaSessionService.connect,
//         after authorizeConnect) and issueVerification (a cutover run); the
//         Legacy Connect, sessions and launcher code outside msa/ still
//         reaches none of it;
//       - the poll checks the device secret before reading anything and
//         admits only the signed Windows agent of an assigned computer;
//       - grant.ts is pure, its prefix and reason list are the Go verifier's,
//         the Go verifier is pure and imported by no command;
//       - 0088 CHECKs the closed state set, the five-minute window and the
//         limits, and holds one active key.
{
  console.log('\n§81 Managed Secure Access grants (MSA_GRANTS, off)');
  const J = JSON.stringify;
  const SRC = 'apps/api/src';
  const flag = read(`${SRC}/msa/msa-grants-flag.ts`);
  const svc = read(`${SRC}/msa/msa-grant.service.ts`);
  const ctl = read(`${SRC}/msa/msa-grant.controller.ts`);
  const mod = read(`${SRC}/msa/msa-grants.module.ts`);
  const gts = read(`${SRC}/msa/grant.ts`);
  const ggo = read('tools/windows-installer/internal/msa/grant/grant.go');
  const mig = read('apps/api/prisma/migrations/0088_msa_grants/migration.sql');
  const files = walk(SRC);
  const rel = (f) => f.replace(/^.*apps\/api\/src\//, '');
  const tree = (dir, test) => {
    const out = [];
    (function w(d) {
      for (const n of readdirSync(join(ROOT, d))) {
        const p = `${d}/${n}`;
        if (n === 'node_modules') continue;
        if (statSync(join(ROOT, p)).isDirectory()) w(p); else if (test(n)) out.push(p);
      }
    })(dir);
    return out;
  };

  const flagReaders = files.filter((f) => /process\.env\.MSA_GRANTS\b|env\.MSA_GRANTS\b|\['MSA_GRANTS'\]/.test(read(f)));
  check('the switch is exactly MSA_GRANTS === \'on\', read in one place',
    /export function msaGrantsEnabled\(env: NodeJS\.ProcessEnv = process\.env\): boolean \{\n\s*return env\.MSA_GRANTS === 'on';\n\s*\}/.test(flag)
      && J(flagReaders.map(rel)) === J(['msa/msa-grants-flag.ts'])
      && !files.some((f) => /MSA_GRANTS\s*(\?\?|\|\|)\s*'on'|MSA_GRANTS\s*!==\s*'off'/.test(read(f))),
    `read in: ${flagReaders.map(rel).join(', ')}`);
  const deployOn = tree('deploy', () => true).filter((p) => /MSA_GRANTS\s*=\s*['"]?on/.test(read(p)));
  check('nothing shipped turns it on: no deploy file sets MSA_GRANTS=on, and run-e2e.sh does not export it',
    deployOn.length === 0 && !/MSA_GRANTS/.test(read('scripts/run-e2e.sh')), deployOn.join(', '));
  check('a middleware answers 404 MSA_NOT_ENABLED on every grant route before the throttler, the session guard or the handler',
    /if \(!msaGrantsEnabled\(\)\) throw new NotFoundException\(\{ code: MSA_NOT_ENABLED,/.test(flag)
      && /consumer\.apply\(MsaGrantsGate\)\.forRoutes\(MsaGrantsController, MsaAgentController, MsaManagedController, MsaSessionsController, MsaCutoverRunsController\);/.test(mod)
      && J([...mod.matchAll(/^import \{ ([\w, ]+Controller) \} from/gm)].flatMap((m) => m[1].split(', ')).sort())
        === J(['MsaAgentController', 'MsaCutoverRunsController', 'MsaGrantsController', 'MsaManagedController', 'MsaSessionsController'])
      && J([...ctl.matchAll(/^export class (\w+Controller)/gm)].map((m) => m[1])) === J(['MsaGrantsController', 'MsaAgentController']),
    'msa-grants-flag.ts MsaGrantsGate; msa-grants.module.ts configure');
  const publicMethods = [...svc.matchAll(/^  async (\w+)\(/gm)].map((m) => m[1]);
  // The first statement after the signature (0.73: a signature may span lines).
  const firstLine = (name) => { const ls = svc.slice(svc.indexOf(`  async ${name}(`)).split('\n'); return ls[ls.findIndex((l) => l.endsWith('{')) + 1]?.trim(); };
  check('every public MsaGrantService method asserts the switch first',
    J(publicMethods) === J(['publicKeys', 'ensureKey', 'activePublishedKeyId', 'issueTest', 'listForEndpoint', 'poll', 'reveal', 'issueForConnect', 'issueVerification', 'release', 'revoke', 'checkTimeout']) && publicMethods.every((m) => firstLine(m) === 'this.assertEnabled();')
      && /private assertEnabled\(\) \{\n\s*if \(!msaGrantsEnabled\(\)\) throw new NotFoundException\(\{ code: MSA_NOT_ENABLED,/.test(svc),
    `methods: ${publicMethods.join(', ')}`);

  const writers = files.filter((f) => /msaGrant(Key)?\.(create|update|updateMany|upsert|delete|deleteMany|createMany)\(/.test(read(f)));
  const keyWriters = files.filter((f) => /msaGrantKey\.(create|update|updateMany|upsert|delete|deleteMany|createMany)\(/.test(read(f)));
  const mgd = read(`${SRC}/msa/msa-managed.service.ts`);
  // 0.72: MsaManagedService moves a computer's own grants on the agent's
  // reports and cancels undelivered ones on rollback — conditional
  // updateMany only, never a create, delete or key write (§82).
  check('only MsaGrantService creates grants or writes keys; MsaManagedService only moves grants by conditional updateMany',
    J(writers.map(rel)) === J(['msa/msa-grant.service.ts', 'msa/msa-managed.service.ts']) && J(keyWriters.map(rel)) === J(['msa/msa-grant.service.ts'])
      && !/msaGrant\.(create|update|upsert|delete|deleteMany|createMany)\(/.test(mgd)
      && (mgd.match(/msaGrant\.updateMany\(\{ where: (g\(\[|\{ \.\.\.g\(\[|\{ endpointId: ep\.id, state: 'issued' \})/g) ?? []).length === (mgd.match(/msaGrant\.updateMany\(/g) ?? []).length,
    writers.map(rel).join(', '));
  const purposeUsers = files.filter((f) => /rem0te-msa-grant-(key|pw|envelope)-v1/.test(read(f))).map(rel);
  check('the grant key, password and envelope purposes are used only in MsaGrantService (and declared in secret-box)',
    J(purposeUsers.sort()) === J(['common/secret-box.ts', 'msa/msa-grant.service.ts'])
      && /sealSecret\(this\.encKey, 'rem0te-msa-grant-key-v1', k\.privatePem\)/.test(svc)
      && /sealSecret\(this\.encKey, 'rem0te-msa-grant-pw-v1', grant\.password\)/.test(svc)
      && /sealSecret\(this\.encKey, 'rem0te-msa-grant-envelope-v1', JSON\.stringify\(envelope\)\)/.test(svc),
    purposeUsers.join(', '));
  const auditCalls = [...svc.matchAll(/this\.audit\.(log|logOrFail)\(\{[\s\S]*?\}\);/g)].map((m) => m[0]);
  const logLines = [...svc.matchAll(/this\.logger\.\w+\([^;]*\);/g)].map((m) => m[0]);
  const issueRet = svc.slice(svc.indexOf("this.waiters.get(ep.id)?.wake('grant');"), svc.indexOf('// ── Reading'));
  const listSel = svc.slice(svc.indexOf('  async listForEndpoint('), svc.indexOf('// ── The device long-poll'));
  check('no audit meta, log line or answer carries the private key, the password or the envelope',
    auditCalls.length === 7 && auditCalls.every((c) => !/password|privatePem|privateKeyEnc|envelope|\bsig\b/i.test(c.replace(/'MSA_PASSWORD_(REVEALED|RELEASED)'/, '')))
      && (auditCalls.join('\n').match(/meta: \{ keyId: k\.keyId \}/g) ?? []).length === 2
      && /meta: \{ grantId: grant\.grantId, endpointId: ep\.id, mode: grant\.mode, consent: grant\.consent, keyId: key\.keyId, source: 'test', managed: !!managed \}/.test(auditCalls.join('\n'))
      && /meta: \{ grantId: g\.id, endpointId: ep\.id \}/.test(auditCalls.join('\n'))
      && /meta: \{ grantId: grant\.grantId, endpointId: ep\.id, mode: grant\.mode, consent: grant\.consent, keyId: key\.keyId, source, managed: true, launchMode, permissions: grant\.permissions, maxMinutes: grant\.maxMinutes \}/.test(auditCalls.join('\n'))
      && /meta: \{ grantId: g\.id, endpointId: ep\.id, via: 'connect_script' \}/.test(auditCalls.join('\n'))
      && /meta: \{ endpointId, grantIds: ids, reason: sel\.reason, all: !!sel\.all, revocationId \}/.test(auditCalls.join('\n'))
      && logLines.length >= 1 && logLines.every((l) => !/password|privatePem|envelope\b|envelopeEnc|passwordEnc/i.test(l))
      && !/password/.test(issueRet) && !/envelopeEnc: true|passwordEnc: true/.test(listSel)
      && !/privateKeyEnc/.test(svc.slice(svc.indexOf('  async publicKeys('), svc.indexOf('// ── Issuing'))),
    `${auditCalls.length} audit calls, ${logLines.length} log lines`);

  const iss = svc.slice(svc.indexOf('  async issueTest('), svc.indexOf('// ── Reading'));
  const order = [
    "await this.acl.assertEndpointInScope(actor, endpointId, 'computers:view');",
    'where: { AND: [{ id: endpointId }, this.acl.endpointVisibilityWhere(actor)] },',
    'assertAssigned(ep);',
    'if (!isWindowsPlatform(ep.platform) || !runsSignedAgent(',
    "const pause = await activePause(this.prisma, 'remote', ep.customerId);",
    'const key = await this.activeKey(actor);',
    'await this.audit.logOrFail({',
    'this.prisma.msaGrant.create({',
  ].map((s) => iss.indexOf(s));
  const test = ctl.slice(ctl.indexOf("@Post('test/:endpointId')"), ctl.indexOf("@Get('keys')"));
  check('issuing: Platform Admin and a fresh confirmation (msa.grant), then scope, the pool, the signed Windows agent, the remote pause, the key, the audit row, the grant',
    order.every((i, k) => i > 0 && (k === 0 || i > order[k - 1]))
      && /@UseGuards\(PlatformAdminGuard\)/.test(test) && /assertFresh\(u\?\.sub \? this\.stepUp\.read\(req, u\.sub, u\.iat\)\?\.method \?\? null : null, \{ action: 'msa\.grant',/.test(test)
      && test.indexOf('assertFresh(') < test.indexOf('this.grants.issueTest('),
    `order ${J(order)}`);
  const callers = files.filter((f) => /\.issueTest\(/.test(read(f))).map(rel);
  const importers = files.filter((f) => /from '[^']*msa-grant\.service'|from '[^']*msa-grants\.module'/.test(read(f))).map(rel).sort();
  // 0.73 (§83): three issuers, one caller each. Connect reaches a grant only
  // through MsaSessionService.connect (its own gated route), never through
  // the Legacy Connect, sessions or launcher code outside msa/.
  const callersOf = (fn) => files.filter((f) => new RegExp(`\\.${fn}\\(`).test(read(f))).map(rel);
  check('issuance: three issuers with one caller each (the test route, MsaSessionService.connect, a cutover run), the module exports nothing, nothing outside msa/ imports the service',
    J(callers) === J(['msa/msa-grant.controller.ts']) && !/exports:/.test(mod)
      && J(callersOf('issueForConnect')) === J(['msa/msa-sessions.service.ts']) && (read(`${SRC}/msa/msa-sessions.service.ts`).match(/\.issueForConnect\(/g) ?? []).length === 1
      && J(callersOf('issueVerification')) === J(['msa/msa-cutover-runs.service.ts']) && (read(`${SRC}/msa/msa-cutover-runs.service.ts`).match(/\.issueVerification\(/g) ?? []).length === 1
      && J(importers) === J(['app.module.ts', 'msa/msa-cutover-runs.service.ts', 'msa/msa-grant.controller.ts', 'msa/msa-grants.module.ts', 'msa/msa-managed.controller.ts', 'msa/msa-managed.service.ts', 'msa/msa-sessions.service.ts'])
      && files.filter((f) => !rel(f).startsWith('msa/') && /sessions|launcher|connect/.test(rel(f))).every((f) => !/MsaGrant|msaGrant|msa\/grant|msa-sessions|MsaSession/.test(read(f))),
    `callers ${J(callers)}; importers ${J(importers)}`);

  const pollFn = svc.slice(svc.indexOf('  async poll('), svc.lastIndexOf('\n}'));
  const iAuth = pollFn.indexOf("const dev = await this.enrollment.authenticateDevice(dto.rustdeskId, dto.agentSecret, 'msa_poll_unauthenticated');");
  const iSigned = pollFn.indexOf('if (!isWindowsPlatform(ep.platform) || !runsSignedAgent({ updateChannel: ep.updateChannel, signedSeenAt: ep.signedSeenAt })) {');
  const iPool = pollFn.indexOf('assertAssigned(ep);');
  const iFirstGrant = pollFn.indexOf('this.prisma.msaGrant.');
  const pollCtl = ctl.slice(ctl.indexOf("@Controller('msa/agent')"));
  check('the poll checks the device secret before reading anything, then admits only the signed Windows agent of an assigned computer',
    iAuth > 0 && iSigned > iAuth && iPool > iSigned && iFirstGrant > iPool && pollFn.indexOf('this.prisma.') > iAuth
      && /@Post\('poll'\)\n\s*@Public\(\)\n\s*@RateLimit\(120\)/.test(pollCtl) && (ctl.match(/@Public\(\)/g) ?? []).length === 2
      && /@Post\('report'\)\n\s*@Public\(\)\n\s*@RateLimit\(120\)\n\s*@HttpCode\(HttpStatus\.OK\)\n\s*async report\(@Body\(\) body: unknown\) \{\n\s*return \{ success: true, data: await this\.managed\.report\(body\) \};/.test(pollCtl)
      && /where: \{ id: \{ in: ackIds \}, endpointId: ep\.id, state: 'issued', notAfter: \{ gte: new Date\(now\) \} \},/.test(pollFn)
      && /if \(why === 'superseded'\) return \{ grants: \[\]/.test(pollFn),
    'msa-grant.service.ts poll; msa-grant.controller.ts MsaAgentController');

  const tsImports = [...gts.matchAll(/^import [\s\S]*? from '([^']+)';/gm)].map((m) => m[1]);
  const tsPrefix = /export const GRANT_PREFIX = '([^']*)';/.exec(gts)?.[1];
  const goPrefix = /const Prefix = "([^"]*)"/.exec(ggo)?.[1];
  const tsReasons = [...(/export const REASONS = \[([\s\S]*?)\] as const;/.exec(gts)?.[1] ?? '').matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
  const goConsts = Object.fromEntries([...ggo.matchAll(/^\t(\w+)\s+= "([a-z_]+)"$/gm)].map((m) => [m[1], m[2]]));
  const goReasons = [...(/var Reasons = \[\]string\{([^}]*)\}/.exec(ggo)?.[1] ?? '').matchAll(/\b([A-Z]\w+)\b/g)].map((m) => goConsts[m[1]]);
  check('grant.ts is pure; its signing prefix and reason list are the Go verifier\'s, in the same order',
    J(tsImports) === J(['node:crypto', 'zod']) && !/process\.env|from '@prisma|fetch\(/.test(gts)
      && tsPrefix === 'rem0te-msa-grant-v1\\n' && goPrefix === tsPrefix && tsReasons.length === 14 && J(goReasons) === J(tsReasons),
    `prefix ts ${tsPrefix} go ${goPrefix}; reasons ${J(tsReasons)} vs ${J(goReasons)}`);
  const goImports = [...(/import \(([\s\S]*?)\)/.exec(ggo)?.[1] ?? '').matchAll(/"([^"]+)"/g)].map((m) => m[1]);
  const goImporters = tree('tools/windows-installer', (n) => n.endsWith('.go'))
    .filter((f) => /"github\.com\/agit8or1\/rem0te\/windows-installer\/internal\/msa\/grant"/.test(read(f)));
  // 0.72: imported by the enforcement package (to verify each grant) and by
  // internal/agent (to parse the signed msa/grant-keys.json): nothing else.
  check('the Go verifier is pure (no clock, file, network or process) and imported only by internal/msa/enforce and internal/agent',
    J(goImports) === J(['bytes', 'crypto/ed25519', 'encoding/base64', 'encoding/json', 'io', 'regexp', 'time']) && !/time\.Now\(/.test(ggo)
      && J(goImporters.filter((f) => !f.endsWith('_test.go'))) === J(['tools/windows-installer/internal/agent/agent.go', 'tools/windows-installer/internal/msa/enforce/enforce.go', 'tools/windows-installer/internal/msa/enforce/poller.go']),
    `imports ${J(goImports)}; imported by ${goImporters.join(', ')}`);
  const mig89 = read('apps/api/prisma/migrations/0089_msa_managed/migration.sql');
  check('0088: the closed state set (0089 adds applied, failed, ended), the five-minute window, the limits, sealed columns and one active key',
    /CHECK \("state" IN \('issued', 'delivered', 'expired', 'cancelled'\)\)/.test(mig)
      && /CHECK \("state" IN \('issued', 'delivered', 'expired', 'cancelled', 'applied', 'failed', 'ended'\)\)/.test(mig89)
      && /CHECK \("notAfter" > "notBefore" AND "notAfter" - "notBefore" <= interval '5 minutes'\)/.test(mig)
      && /CHECK \("maxMinutes" BETWEEN 1 AND 480\)/.test(mig) && /CHECK \("idleMinutes" BETWEEN 1 AND 120 AND "idleMinutes" <= "maxMinutes"\)/.test(mig)
      && /CREATE UNIQUE INDEX "MsaGrantKey_one_active" ON "MsaGrantKey" \(\(true\)\) WHERE "retiredAt" IS NULL;/.test(mig)
      && (mig.match(/\^\[0-9a-f\]\{24\}:\[0-9a-f\]\{32\}:\[0-9a-f\]\+\$/g) ?? []).length === 3,
    '0088 migration');
  check('MSA grants: the suites prove it',
    / msa-grants[ ;]/.test(read('scripts/run-e2e.sh')) && /unit-msa-grants\.mjs/.test(read('.github/workflows/ci.yml'))
      && JSON.parse(read('tools/windows-installer/internal/msa/testdata/msa-grants.json')).cases.length >= 60,
    'e2e-msa-grants.mjs in run-e2e.sh, unit-msa-grants.mjs in CI, the shared fixture');
}

// ── §82 (0.72): Managed Secure Access enforcement, the managed test session, cutover and rollback ──
//     Build step 4 of docs/managed-secure-access.md, behind MSA_GRANTS (off).
//     A computer changes only when a Platform Admin moves that ONE computer:
//       - the heartbeat says msaPoll only to an authenticated signed agent
//         that may act, only with the switch on and a managed row, and the
//         signed heartbeat starts `msa-poller` (no argument) only on that;
//       - only MsaManagedService writes MsaManagedComputer; every public
//         method asserts the switch first; cutover and confirm are a Platform
//         Admin's with msa.cutover, the reveal with msa.reveal, rollback never
//         asks; no route takes a group or a business;
//       - cutover: scope, the pool, not already managed, every blocker
//         (Compatible readiness, an enforcing agent, no `remote` pause, a
//         published grant key), the audit row, then the row;
//       - a report is parsed strictly, then the device secret, before any read;
//       - the ceiling is view-only on both sides, compiled into the agent
//         (control with clipboard, files and audio from 0.73);
//       - (0.78.1, F1) no argument list or desired map carries access-mode
//         full (control is custom); every RustDesk permission option is
//         governed, and the six no grant names are N on every grant and
//         read back; RustDesk's own rule over the desired values grants
//         nothing the grant and the ceiling do not;
//       - the agent: one enforcement exec site that runs only what
//         enforce.Valid accepts, the installed rustdesk.exe, no shell; grant
//         keys only from the signed msa/grant-keys.json; the replay set
//         written before anything changes; no password in a log or report;
//       - a verified computer's legacy password is neither revealed,
//         launched, rotated nor set, and a staged rotation waits;
//       - the release host publishes the grant keys; the portal only shows
//         the two commands (§56).
{
  console.log('\n§82 Managed Secure Access enforcement (MSA_GRANTS, off)');
  const J = JSON.stringify;
  const SRC = 'apps/api/src';
  const files = walk(SRC);
  const rel = (f) => f.replace(/^.*apps\/api\/src\//, '');
  const enr = read(`${SRC}/enrollment/enrollment.service.ts`);
  const msvc = read(`${SRC}/msa/msa.service.ts`);
  const mgd = read(`${SRC}/msa/msa-managed.service.ts`);
  const mctl = read(`${SRC}/msa/msa-managed.controller.ts`);
  const gsvc = read(`${SRC}/msa/msa-grant.service.ts`);
  const gctl = read(`${SRC}/msa/msa-grant.controller.ts`);
  const managedTs = read(`${SRC}/msa/managed.ts`);
  const eps = read(`${SRC}/endpoints/endpoints.service.ts`);
  const ws = read(`${SRC}/public/windows-script.ts`);
  const cat = read(`${SRC}/security-controls/confirm-catalog.ts`);
  const goDir = 'tools/windows-installer';
  const args = read(`${goDir}/internal/msa/enforce/args.go`);
  const enf = read(`${goDir}/internal/msa/enforce/enforce.go`);
  const pol = read(`${goDir}/internal/msa/enforce/poller.go`);
  const win = read(`${goDir}/msa_poller_windows.go`);
  const agentGo = read(`${goDir}/internal/agent/agent.go`);
  const mainGo = read(`${goDir}/main.go`);
  const stripGo = (s) => s.split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');
  const body = (src, sig) => { const i = src.indexOf(sig); if (i < 0) return ''; const j = src.indexOf('\n  }\n', i); return src.slice(i, j); };

  // The heartbeat.
  const iPoll = enr.indexOf('msaPoll = await this.msa.pollWanted(node.endpointId);');
  const guard = enr.lastIndexOf('if (', iPoll);
  check('msaPoll: only from an authenticated signed heartbeat that may act, after the not-may-act and pooled returns, only with the switch on and a managed row',
    (enr.match(/this\.msa\.pollWanted\(/g) ?? []).length === 1 && enr.slice(guard, iPoll).startsWith("if (authenticated && mayAct && kind === 'signed') {")
      && iPoll > enr.indexOf('if (authenticated && !mayAct) {') && iPoll > enr.indexOf('if (authenticated && pooled) {')
      && /\.\.\.\(msaPoll \? \{ msaPoll: true \} : \{\}\),/.test(enr)
      && /async pollWanted\(endpointId: string\): Promise<boolean> \{\n\s*if \(!msaGrantsEnabled\(\)\) return false;\n\s*return !!\(await this\.prisma\.msaManagedComputer\.findUnique\(/.test(msvc)
      && files.filter((f) => /\bmsaPoll\b/.test(read(f))).map(rel).every((f) => ['enrollment/enrollment.service.ts', 'public/windows-script.ts'].includes(f)),
    'enrollment.service.ts heartbeat; MsaService.pollWanted');
  check('the signed heartbeat starts msa-poller (no argument) only when told msaPoll, and the subcommand takes no argument',
    /if \(\$resp\.data\.msaPoll -eq \$true -and \(Test-Path -LiteralPath \$agentExe\)\) \{\n\s*Start-Process -FilePath \$agentExe -ArgumentList @\('msa-poller'\) -WindowStyle Hidden/.test(ws)
      && (ws.match(/'msa-poller'/g) ?? []).length === 1
      && /if args\[0\] == "msa-poller" \{\n\s*return cmdMsaPoller\(args\[1:\]\)/.test(mainGo)
      && /if len\(args\) > 0 \{\n\s*fmt\.Fprintln\(logf, "  msa-poller: takes no arguments"\)\n\s*return 2/.test(win),
    'windows-script.ts actionHook; main.go; msa_poller_windows.go cmdMsaPoller');
  check('a staged legacy rotation waits while managed/rotationHeld says so (verified, failing, rolling back, or a grant in flight)',
    /if \(refreshed\?\.pendingPassword && !\(await this\.msa\.rotationHeld\(node\.endpointId\)\)\) \{/.test(enr)
      && /export function rotationHeld\(row: \{ state: ManagedState \} \| null, grantInFlight: boolean\): boolean \{\n\s*if \(!row\) return false;\n\s*return row\.state !== 'pending' \|\| grantInFlight;/.test(managedTs),
    'enrollment.service.ts; managed.ts rotationHeld');

  // Who writes, who may.
  const rowWriters = files.filter((f) => /msaManagedComputer\.(create|update|updateMany|upsert|delete|deleteMany|createMany)\(/.test(read(f))).map(rel);
  const pub = [...mgd.matchAll(/^  async (\w+)\(/gm)].map((m) => m[1]);
  const first = (name) => mgd.slice(mgd.indexOf(`  async ${name}(`)).split('\n')[1]?.trim();
  // 0.73: the one exception is the poll recording lastPollAt (Connect's
  // "is the agent polling"), a single unconditional field write that moves
  // no state.
  const gsvcRowWrites = [...gsvc.matchAll(/msaManagedComputer\.(create|update|updateMany|upsert|delete|deleteMany|createMany)\([^;]*;/g)].map((m) => m[0]);
  check('only MsaManagedService writes MsaManagedComputer (but the poll\'s lastPollAt), and every public method asserts the switch first',
    J(rowWriters) === J(['msa/msa-grant.service.ts', 'msa/msa-managed.service.ts'])
      && J(gsvcRowWrites) === J(['msaManagedComputer.updateMany({ where: { endpointId: ep.id }, data: { lastPollAt: new Date(now) } });'])
      && J(pub) === J(['view', 'cutover', 'confirm', 'confirmFromRun', 'rollback', 'report'])
      && pub.every((m) => first(m) === 'this.assertEnabled();')
      && /private assertEnabled\(\) \{\n\s*if \(!msaGrantsEnabled\(\)\) throw new NotFoundException\(\{ code: MSA_NOT_ENABLED,/.test(mgd),
    `writers ${J(rowWriters)}; methods ${J(pub)}`);
  const route = (sig) => mctl.slice(mctl.indexOf(sig), mctl.indexOf('\n  }\n', mctl.indexOf(sig)));
  const cut = route("@Post(':endpointId/cutover')"), conf = route("@Post(':endpointId/confirm')"), rb = route("@Post(':endpointId/rollback')"), rv = route("@Post('grants/:grantId/reveal')");
  const routes = [...mctl.matchAll(/@(Get|Post|Put|Patch|Delete)\('([^']*)'\)/g)].map((m) => `${m[1]} ${m[2]}`);
  check('cutover and confirm: Platform Admin + msa.cutover; the reveal: Platform Admin + msa.reveal; rollback: Platform Admin and never asks; no group or business route',
    J(routes) === J(['Get :endpointId', 'Post :endpointId/cutover', 'Post :endpointId/confirm', 'Post :endpointId/rollback', 'Post grants/:grantId/reveal'])
      && [cut, conf, rv, rb].every((r) => /@UseGuards\(PlatformAdminGuard\)/.test(r))
      && /assertFresh\(this\.method\(req\), \{ action: 'msa\.cutover',/.test(cut) && /assertFresh\(this\.method\(req\), \{ action: 'msa\.cutover',/.test(conf)
      && /assertFresh\(this\.method\(req\), \{ action: 'msa\.reveal',/.test(rv) && !/assertFresh|stepUp/.test(rb)
      && cut.indexOf('assertFresh(') < cut.indexOf('this.managed.cutover(') && conf.indexOf('assertFresh(') < conf.indexOf('this.managed.confirm(')
      && rv.indexOf('assertFresh(') < rv.indexOf('this.grants.reveal(')
      && !/businessId|groupId|customerId/.test(mctl) && /@Controller\('msa\/managed'\)/.test(mctl),
    `routes ${J(routes)}`);
  check('the catalog names msa.cutover and msa.reveal (default off, §62); the always-ask set is unchanged',
    /\{ key: 'msa\.cutover', group: 'Devices & enrolment', label: 'Managed Secure Access cutover', default: 'off',/.test(cat)
      && /\{ key: 'msa\.reveal', group: 'Devices & enrolment', label: 'Managed test session password', default: 'off',/.test(cat),
    'confirm-catalog.ts');

  // Cutover order.
  const cb = body(mgd, '  async cutover(');
  const order = [
    'this.assertEnabled();',
    'const ep = await this.computer(actor, endpointId);',
    'assertAssigned(ep);',
    'if (await this.row(ep.id)) throw new ConflictException({ code: \'MSA_ALREADY_MANAGED\'',
    'const blockers = await this.cutoverBlockers(ep);',
    "action: 'MSA_CUTOVER'",
    "await this.prisma.msaManagedComputer.create({ data: { endpointId: ep.id, state: 'pending', requestedById: actor.userId, runId } });",
  ].map((x) => cb.indexOf(x));
  const blk = body(mgd, '  private async cutoverBlockers(');
  check('cutover: scope, the pool, not already managed, every blocker, the audit row (logOrFail), then the row',
    order.every((i, k) => i >= 0 && (k === 0 || i > order[k - 1])) && /await this\.audit\.logOrFail\(\{\n\s*action: 'MSA_CUTOVER'/.test(cb)
      && /await this\.acl\.assertEndpointInScope\(actor, endpointId, 'computers:view'\);\n\s*const ep = await this\.prisma\.endpoint\.findFirst\(\{\n\s*where: \{ AND: \[\{ id: endpointId \}, this\.acl\.endpointVisibilityWhere\(actor\)\] \},/.test(mgd)
      && ["'ENDPOINT_UNASSIGNED'", "'MSA_SIGNED_AGENT_REQUIRED'", "pr.readiness.state !== 'compatible'", 'compareVersion(pr?.agentVersion ?? null, MIN_ENFORCING_AGENT)',
        "activePause(this.prisma, 'remote', ep.customerId)", 'this.grants.activePublishedKeyId()'].every((x) => blk.includes(x))
      && /export const MIN_ENFORCING_AGENT = '0\.72\.0';/.test(read(`${SRC}/msa/readiness.ts`)),
    `order ${J(order)}`);
  const confirmB = body(mgd, '  async confirm(');
  check('confirm needs a test session since cutover that read back and connected; verified is a conditional move from pending',
    /if \(!row\.readbackOkAt \|\| !\(await this\.testSessionConnected\(ep\.id, row\.requestedAt\)\)\) \{/.test(confirmB)
      && /where: \{ endpointId: ep\.id, state: 'pending' \}, data: \{ state: 'verified', verifiedAt: new Date\(\), verifiedById: actor\.userId \}/.test(confirmB)
      && confirmB.indexOf("action: 'MSA_VERIFIED'") < confirmB.indexOf('msaManagedComputer.updateMany('),
    'MsaManagedService.confirm');
  const rbB = body(mgd, '  async rollback(');
  check('rollback stages a fresh permanent password through the existing rotation path and forces only a computer already rolling back',
    /await this\.endpoints\.stageRotationForMsa\(ep\.id, actor\.userId, 'msa_rollback'\);/.test(rbB)
      && /if \(row\.state === 'rollback_pending'\) \{\n\s*if \(!force\) throw/.test(rbB)
      && /deleteMany\(\{ where: \{ endpointId: ep\.id, state: 'rollback_pending' \} \}\)/.test(rbB)
      && (eps.match(/this\.stagePendingPassword\(/g) ?? []).length === 2,
    'MsaManagedService.rollback; EndpointsService.stageRotationForMsa and rotateCredential share stagePendingPassword');

  // Reports.
  const rep = body(mgd, '  async report(');
  const iParse = rep.indexOf('const p = ReportBody.safeParse(raw);');
  const iAuthR = rep.indexOf("const dev = await this.enrollment.authenticateDevice(r.rustdeskId, r.agentSecret, 'msa_report_unauthenticated');");
  check('a report: strict parse, then the device secret, before any read; only the signed Windows agent of an assigned computer; no password field',
    iParse > 0 && iAuthR > iParse && rep.indexOf('this.prisma.') > iAuthR && rep.indexOf('assertAssigned(ep);') > rep.indexOf('runsSignedAgent(')
      && /export const ReportBody = z\.strictObject\(\{/.test(managedTs) && !/password\s*:/.test(managedTs.slice(managedTs.indexOf('export const ReportBody'), managedTs.indexOf('export type Report ')))
      && /keys: z\.array\(z\.enum\(REPORT_KEYS\)\)/.test(managedTs) && /outcome: z\.string\(\)\.regex\(\/\^\[a-z_\]\{1,40\}\$\/\)/.test(managedTs),
    'MsaManagedService.report; managed.ts ReportBody');
  const auditM = [...mgd.matchAll(/this\.audit\.(log|logOrFail)\(\{[\s\S]*?\}\);/g)].map((m) => m[0]);
  check('no managed audit row, log line or answer carries a password',
    auditM.length >= 8 && auditM.every((c) => !/password|passwordEnc|envelope/i.test(c))
      && [...mgd.matchAll(/this\.logger\.\w+\([^;]*\);/g)].every((m) => !/password/i.test(m[0])) && !/passwordEnc|envelopeEnc/.test(mgd),
    `${auditM.length} audit calls`);
  const revB = body(gsvc, '  async reveal(');
  check('the one-time password: shown once, only for an applied grant on a visible computer, audited first, claimed by a conditional write before it is opened',
    revB.indexOf("if (g.state !== 'applied')") > 0 && revB.indexOf('await this.audit.logOrFail({') > revB.indexOf("if (g.state !== 'applied')")
      && revB.indexOf("where: { id: g.id, state: 'applied', revealedAt: null }") > revB.indexOf('await this.audit.logOrFail({')
      && revB.indexOf("openSecret(this.encKey, 'rem0te-msa-grant-pw-v1'") > revB.indexOf("where: { id: g.id, state: 'applied', revealedAt: null }")
      && /this\.acl\.endpointVisibilityWhere\(actor\)/.test(revB),
    'MsaGrantService.reveal');

  // The ceiling.
  // 0.73 (§83) widened it to control with clipboard, file transfer and
  // audio; a tunnel and a remote restart stay above it on both sides.
  check('the ceiling is control with clipboard, files and audio, never a tunnel or a restart, compiled into the agent; the portal refuses a managed grant above it first',
    /var Ceiling = grant\.Ceiling\{Mode: "control", Permissions: grant\.Permissions\{Clipboard: true, Files: true, Audio: true\}\}/.test(enf) && /Ceiling: Ceiling,/.test(pol)
      && !/Tunnel: true|Restart: true/.test(stripGo(enf))
      && /mode: 'control',\n\s*permissions: \{ clipboard: true, files: true, audio: true, tunnel: false, restart: false \},/.test(managedTs)
      && /if \(!withinCeiling\(b\.mode \?\? 'view', perms\)\) throw new ConflictException\(\{ code: 'MSA_ABOVE_CEILING'/.test(gsvc)
      && !/Ceiling\s*=|Ceiling:\s*(ans|a|p\.state|g)\./.test(pol.replace('Ceiling: Ceiling,', '')),
    'enforce.Ceiling; managed.ts MANAGED_CEILING; MsaGrantService.issueTest');

  // 0.78.1 (F1): RustDesk's Flutter builds read access-mode `full` as every
  // permission on before they look at any enable-* key. So no argument list,
  // desired map or allowed value carries full; control is `custom`; every
  // RustDesk permission option is governed; the six a grant cannot name are
  // N on every grant and read back; and RustDesk's own rule over the desired
  // values (Effective) grants nothing the grant and the Ceiling do not.
  {
    const LOCKED = ['enable-terminal', 'enable-camera', 'enable-remote-printer', 'enable-block-input', 'enable-privacy-mode', 'enable-record-session'];
    const PERMS = ['enable-keyboard', 'enable-clipboard', 'enable-file-transfer', 'enable-audio', 'enable-tunnel', 'enable-remote-restart', ...LOCKED];
    const goList = (src, name) => [...(new RegExp(`var ${name} = (?:append\\()?\\[\\]string\\{([^}]*)\\}`).exec(src)?.[1] ?? '').matchAll(/"([a-z-]+)"/g)].map((m) => m[1]);
    const goLocked = goList(args, 'Locked');
    const goPerms = [...goList(args, 'Permissions'), ...(/var Permissions = append\(\[\]string\{[^}]*\}, Locked\.\.\.\)/.test(args) ? goLocked : [])];
    const allowedBlock = args.slice(args.indexOf('var allowed = map[string]map[string]bool{'), args.indexOf('\n}\n', args.indexOf('var allowed = map[string]map[string]bool{')));
    const desired = body(enf.replace(/\n}\n/g, '\n  }\n'), 'func Desired(');
    const orderList = [...(/var order = \[\]string\{([^}]*)\}/.exec(enf)?.[1] ?? '').matchAll(/"([a-z-]+)"/g)].map((m) => m[1]);
    check('F1: no argument list, desired map or allowed value carries access-mode full; control is custom',
      /"access-mode":\s+\{"view": true, "custom": true\},/.test(allowedBlock) && !/"full"/.test(stripGo(allowedBlock))
        && /func refused\(key, value string\) bool \{\n\s*return key == "access-mode" && value == "full"\n\s*\}/.test(args)
        && /if !isKey\(key\) \|\| refused\(key, value\) \{/.test(args) && /if !isKey\(key\) \|\| refused\(key, saved\) \|\| !restoreRE\.MatchString\(saved\) \{/.test(args)
        && /access := "view"\n\s*if g\.Mode == "control" \{\n\s*access = "custom"\n\s*\}/.test(desired) && !/"full"/.test(stripGo(desired))
        && (stripGo(enf + args).match(/"full"/g) ?? []).length === 2
        && J([...managedTs.matchAll(/export const MANAGED_ACCESS_MODES = \[([^\]]*)\]/g)].map((m) => m[1])) === J(["'view', 'custom'"]),
      'enforce/args.go allowed, refused, SetArgs, RestoreArgs; enforce.go Desired; managed.ts MANAGED_ACCESS_MODES');
    check('F1: every RustDesk permission option is governed, set and read back; the six a grant cannot name are N on every grant',
      J(goLocked) === J(LOCKED) && J(goPerms) === J(PERMS)
        && LOCKED.every((k) => new RegExp(`"${k}":\\s+\\{"N": true\\},`).test(allowedBlock))
        && /for _, k := range Locked \{\n\s*d\[k\] = "N"\n\s*\}\n\s*return d/.test(desired)
        && PERMS.every((k) => orderList.includes(k)) && /var Keys = append\(append\(\[\]string\(nil\), msa\.Keys\.\.\.\), Locked\.\.\.\)/.test(args)
        && /export const MANAGED_KEYS = \[\.\.\.PREFLIGHT_KEYS, \.\.\.LOCKED_KEYS\] as const;/.test(managedTs)
        && J([...(/export const LOCKED_KEYS = \[([^\]]*)\]/.exec(managedTs)?.[1] ?? '').matchAll(/'([a-z-]+)'/g)].map((m) => m[1])) === J(LOCKED),
      `Locked ${J(goLocked)}; Permissions ${J(goPerms)}`);
    check('F1: Apply refuses a grant RustDesk would widen (Beyond) before it writes, and Effective is RustDesk\'s rule (full every permission, view none, else each key unless N)',
      /if over := Beyond\(g, Desired\(g\)\); len\(over\) > 0 \{\n\s*_ = e\.EndSession\(ctx\)\n\s*return Outcome\{Code: ReadbackMismatch, Keys: over\}/.test(enf)
        && enf.indexOf('Beyond(g, Desired(g))') < enf.indexOf('e.Set(ctx, Desired(g))')
        && /case "full":\n\s*out\[k\] = true\n\s*case "view":\n\s*out\[k\] = false\n\s*default:\n\s*out\[k\] = values\[k\] != "N"/.test(args)
        && /out\["enable-clipboard"\] = control && g\.Permissions\.Clipboard && Ceiling\.Permissions\.Clipboard/.test(enf)
        && /out\["enable-file-transfer"\] = control && g\.Permissions\.Files && Ceiling\.Permissions\.Files/.test(enf)
        && /out\["enable-audio"\] = control && g\.Permissions\.Audio && Ceiling\.Permissions\.Audio/.test(enf)
        && !/out\["enable-(tunnel|remote-restart|terminal|camera|remote-printer|block-input|privacy-mode|record-session)"\] =/.test(enf),
      'enforce.go Apply, Allowed; args.go Effective');
    check('F1: the Go tests and the Windows lab hold it',
      ['TestNoDesiredMapHoldsFull', 'TestEveryPermissionIsNamed', 'TestEffectiveIsExactlyWhatTheGrantAndCeilingAllow', 'TestNoCallCarriesFull', 'TestLockedReadbackMismatchRefused']
        .every((t) => new RegExp(`func ${t}\\(`).test(read(`${goDir}/internal/msa/enforce/f1_test.go`)))
        && /func labEffective\(/.test(read(`${goDir}/lab_enforce_windows_test.go`))
        && (read(`${goDir}/lab_enforce_windows_test.go`).match(/labEffective\(ctx, e, &(g|cg)\)/g) ?? []).length === 2
        && /"access-mode": "custom"/.test(read(`${goDir}/lab_enforce_windows_test.go`)),
      'internal/msa/enforce/f1_test.go; lab_enforce_windows_test.go');
  }

  // The agent.
  const execs = [...stripGo(win).matchAll(/exec\.\w+\(/g)];
  const run = win.slice(win.indexOf('func (r enforceRunner) Run('), win.indexOf('// ── the portal'));
  check('one enforcement exec site: enforce.Valid first, the installed rustdesk.exe the RustDesk service runs, an argument array, no shell, no window, capped, never logged',
    execs.length === 1 && run.indexOf('if !enforce.Valid(args) {') > 0 && run.indexOf('if !enforce.Valid(args) {') < run.indexOf('exec.CommandContext(')
      && /cmd := exec\.CommandContext\(ctx, r\.exe, args\.\.\.\)/.test(run) && /CreationFlags: windows\.CREATE_NO_WINDOW/.test(run)
      && /if _, expected := rustdeskService\(r\.exe\); !expected \{/.test(run) && /E: &enforce\.Enforcer\{R: enforceRunner\{exe: installedRustdeskExe\(\)\}\},/.test(win)
      && !/cmd\.exe|powershell|"\/c"/i.test(stripGo(win)) && !/Fprint\w*\([^)]*\bargs\b/.test(win.replace('fmt.Fprintln(logf, "  msa-poller: takes no arguments")', '')),
    'msa_poller_windows.go enforceRunner.Run');
  const pwArgs = args.slice(args.indexOf('func PasswordArgs('), args.indexOf('}\n', args.indexOf('return []string{"--password", pw}')) + 2);
  check('the argument lists are closed: SetArgs a closed value per key, RestoreArgs the preflight charset, PasswordArgs 24 alphanumerics, StopServiceArgs Y or N',
    /if !passwordRE\.MatchString\(pw\) \{\n\s*return nil\n\s*\}\n\s*return \[\]string\{"--password", pw\}/.test(pwArgs)
      && /"verification-method":\s+\{"use-permanent-password": true\},/.test(args) && /"allow-auto-disconnect": \{"Y": true\},/.test(args)
      && /restoreRE = regexp\.MustCompile\(`\^\[A-Za-z0-9_\.:-\]\{0,64\}\$`\)/.test(args)
      && (stripGo(args).match(/\[\]string\{"--option"/g) ?? []).length === 5 && (stripGo(args).match(/\[\]string\{"--password"/g) ?? []).length === 1
      && /var Keys = append\(append\(\[\]string\(nil\), msa\.Keys\.\.\.\), Locked\.\.\.\)/.test(args),
    'internal/msa/enforce/args.go');
  const handle = pol.slice(pol.indexOf('func (p *Poller) handle('), pol.indexOf('func (p *Poller) pruneSeen('));
  check('each grant: keys from the signed chain only, verified, the signed pause, the replay set written, the settings saved, before anything changes',
    /keys, paused, err := p\.H\.Trust\(ctx\)\n\s*if err != nil \|\| len\(keys\) == 0 \{\n\s*refuse\(NoKeys, nil\)/.test(handle)
      && handle.indexOf('grant.Verify(') < handle.indexOf('paused(g.BusinessID, rid)')
      && handle.indexOf('if err := p.S.SaveSeen(p.seen); err != nil {') < handle.indexOf('p.E.Apply(ctx, g)')
      && handle.indexOf('p.S.SaveSaved(') < handle.indexOf('p.E.Apply(ctx, g)')
      && /if s, err := p\.S\.LoadSaved\(\); err != nil \|\| s == nil \{/.test(handle)
      && /if _, err := c\.Fetch\(grant\.KeysTarget, dst\); err != nil \{/.test(agentGo) && /keys, err := grant\.ParseKeys\(raw\)/.test(agentGo)
      && /keys, pz, err := agent\.MsaTrust\(/.test(win),
    'enforce/poller.go handle; agent.MsaTrust');
  check('apply refuses on any readback disagreement and ends the session; nothing weaker is substituted; the password is never reported or logged',
    /if bad := e\.Set\(ctx, Desired\(g\)\); len\(bad\) > 0 \{\n\s*_ = e\.EndSession\(ctx\)\n\s*return Outcome\{Code: ReadbackMismatch, Keys: bad\}/.test(enf)
      && /return r\.ok\(\) && bytes\.Contains\(r\.Stdout, \[\]byte\("Done"\)\)/.test(enf)
      && !/Password/.test([...pol.matchAll(/Report\{[^}]*\}/g)].map((m) => m[0]).join(' ')) && !/logf\([^)]*[Pp]assword/.test(pol)
      && !/Password/.test(pol.slice(pol.indexOf('type Report struct'), pol.indexOf('// Portal is'))),
    'enforce.go Apply/SetPassword; poller.go reports');

  // Legacy refused once verified.
  check('a verified computer: legacy Reveal, Connect, rotate and set are refused (409 MSA_MANAGED / msa_managed)',
    /async assertPasswordAccess\(actor: ActorContext, id: string\) \{[\s\S]{0,300}await this\.refuseMsaManaged\(id\);/.test(eps)
      && /async setPassword\(actor: ActorContext, id: string, password: string \| null\): Promise<void> \{[\s\S]{0,300}await this\.refuseMsaManaged\(id\);/.test(eps)
      && /if \(await this\.msaLegacyRefused\(endpoint\.id\)\) return \{ ok: false, reason: 'msa_managed'/.test(eps)
      && /code: 'MSA_MANAGED', message: 'This computer is in Managed Secure Access: its password is set by the agent/.test(eps),
    'endpoints.service.ts');

  // The release host.
  const gk = read('deploy/release/rem0te-signed-grant-key');
  const pubSh = read('deploy/release/rem0te-signed-publish');
  check('the grant keys reach agents only through the signed release: rem0te-signed-grant-key records public keys only, and publish signs them in',
    /if \[\[ \$public_key == \*PRIVATE\* \|\| \$public_key == \*-----BEGIN\* \]\]; then/.test(gk) && /idOf\(pub\) !== keyId/.test(gk) && /doc\.keys\.length >= 8/.test(gk)
      && /\[\[ -n \$msa_build \]\] && args\+=\(-add "msa\/grant-keys\.json=\$msa_build"\)/.test(pubSh)
      && /if grep -qiE 'PRIVATE\|-----BEGIN' "\$msa_build"; then die/.test(pubSh)
      && /export const MSA_GRANT_KEYS_TARGET = 'msa\/grant-keys\.json';/.test(read(`${SRC}/msa/grant-key-commands.ts`)),
    'deploy/release/rem0te-signed-grant-key, rem0te-signed-publish');

  check('0089: the managed states, the verified/failure/rollback CHECKs, closed codes and keys, and a pooled computer refused',
    (() => {
      const m = read('apps/api/prisma/migrations/0089_msa_managed/migration.sql');
      return /CHECK \("state" IN \('pending', 'verified', 'enforcement_failure', 'rollback_pending'\)\)/.test(m)
        && /"MsaManagedComputer_verified_check"/.test(m) && /"MsaManagedComputer_rollback_check"/.test(m) && /"MsaManagedComputer_failReason_check"/.test(m)
        && /"MsaGrant_revealed_check"/.test(m) && /"MsaGrant_outcome_check"/.test(m)
        && /CREATE TRIGGER "MsaManagedComputer_assigned" BEFORE INSERT ON "MsaManagedComputer"/.test(m);
    })(),
    '0089 migration');
  check('MSA enforcement: the suites prove it',
    / msa-managed[ ;]/.test(read('scripts/run-e2e.sh')) && /unit-msa-managed\.mjs/.test(read('.github/workflows/ci.yml'))
      && /TestLabRustdeskEnforce/.test(read('.github/workflows/lab-windows.yml'))
      && /func TestReadbackMismatchFailsClosed\(/.test(read(`${goDir}/internal/msa/enforce/enforce_test.go`))
      && /func TestRollbackRestores\(/.test(read(`${goDir}/internal/msa/enforce/enforce_test.go`)),
    'e2e-msa-managed.mjs in run-e2e.sh, unit-msa-managed.mjs in CI, TestLabRustdeskEnforce in the Windows lab, the enforce Go tests');
}

// ── §83 (0.73): Managed Secure Access sessions — Connect through grants, revocation, evidence, cutover runs ──
//     Build step 5 of docs/managed-secure-access.md, behind MSA_GRANTS (off).
//       - Connect reaches a grant only through POST /msa/sessions/connect,
//         MsaSessionService.connect: verified managed, an agent of at least
//         0.73.0 that is polling, nobody else's live session, then
//         authorizeConnect({ managed: true }) — the ordinary launch policy —
//         then managedGrantTerms from the policy's own facts, the audit row,
//         then issueForConnect. The body carries only `mode`. Only on that
//         path does view-only and consent become enforceable (access-policy:
//         `ctx.managed === true`), and only there is the Legacy credential
//         gate skipped; a Legacy computer's Connect is unchanged.
//       - The one-time password is released once, to the grant's own
//         technician, for an applied Connect grant: audited, claimed by a
//         conditional write, then opened. A grant not applied in 60 s is
//         revoked (timeout): nothing is handed over.
//       - The ceiling (§82) is control with clipboard, files and audio; a
//         tunnel and a remote restart never. Terms never exceed it.
//       - Revocation is signed under the grant key with its own prefix
//         (rem0te-msa-revoke-v1), stored only by MsaGrantService.revoke,
//         which only moves live grants to `revoked` and creates no key; a
//         `remote` pause revokes every delivered or applied grant. Who may
//         revoke: the grant's technician, a Platform Admin, or the business's
//         own non-technician member with computers:edit. Revoking never asks
//         for a fresh confirmation. The Go agent verifies before it acts and
//         only ever ends a session.
//       - The timeline is pure; Launched is never Connected.
//       - Cutover runs are a Platform Admin's; start, advance and confirm
//         name msa.cutover, halt and rollback never ask. Every computer goes
//         through MsaManagedService.cutover (its own blockers and audit row);
//         advance refuses until the canary is verified; batches of at most
//         25; nothing runs on a timer.
//       - 0090 CHECKs the states, sources, reasons, shapes and windows.
{
  console.log('\n§83 Managed Secure Access sessions (MSA_GRANTS, off)');
  const J = JSON.stringify;
  const SRC = 'apps/api/src';
  const files = walk(SRC);
  const rel = (f) => f.replace(/^.*apps\/api\/src\//, '');
  const ssvc = read(`${SRC}/msa/msa-sessions.service.ts`);
  const sctl = read(`${SRC}/msa/msa-sessions.controller.ts`);
  const rsvc = read(`${SRC}/msa/msa-cutover-runs.service.ts`);
  const rctl = read(`${SRC}/msa/msa-cutover-runs.controller.ts`);
  const gsvc = read(`${SRC}/msa/msa-grant.service.ts`);
  const terms = read(`${SRC}/msa/connect-terms.ts`);
  const revTs = read(`${SRC}/msa/revocation.ts`);
  const tl = read(`${SRC}/msa/session-timeline.ts`);
  const managedTs = read(`${SRC}/msa/managed.ts`);
  const eps = read(`${SRC}/endpoints/endpoints.service.ts`);
  const pol = read(`${SRC}/security-controls/access-policy.service.ts`);
  const goDir = 'tools/windows-installer';
  const revGo = read(`${goDir}/internal/msa/grant/revocation.go`);
  const poller = read(`${goDir}/internal/msa/enforce/poller.go`);
  const mig = read('apps/api/prisma/migrations/0090_msa_sessions/migration.sql');
  const body = (src, sig) => { const i = src.indexOf(sig); if (i < 0) return ''; const j = src.indexOf('\n  }\n', i); return src.slice(i, j); };

  // Connect.
  const con = body(ssvc, '  async connect(');
  const order = [
    'this.assertEnabled();',
    'const ep = await this.visible(actor, endpointId);',
    "if (row.state !== 'verified') throw new ConflictException({ code: 'MSA_NOT_VERIFIED'",
    'compareVersion(pr?.agentVersion ?? null, MIN_SESSION_AGENT)',
    "code: 'MSA_AGENT_NOT_POLLING'",
    "code: 'MSA_SESSION_ACTIVE'",
    "const authz = await this.endpoints.canConnect(actor, ep.id, { mode, admit: 'ui', stage: 'connect', managed: true });",
    'const facts = await this.policy.managedTermsFacts(actor, ep);',
    'const terms = managedGrantTerms({ mode, path, maxSessionMinutes: authz.maxSessionMinutes, ...facts });',
    "action: 'MSA_SESSION_REQUESTED'",
    'const g = await this.grants.issueForConnect(actor, ep.id, mode, terms, now);',
  ].map((x) => con.indexOf(x));
  check('Connect: verified managed, a 0.73 agent that is polling, nobody else\'s session, the launch policy (managed), the policy\'s terms, the audit row, then the grant',
    order.every((i, k) => i >= 0 && (k === 0 || i > order[k - 1]))
      && /await this\.audit\.logOrFail\(\{\n\s*action: 'MSA_SESSION_REQUESTED'/.test(con)
      && /export const MIN_SESSION_AGENT = '0\.73\.0';/.test(managedTs)
      && /async connect\(@Actor\(\) a: ActorContext, @Param\('endpointId'\) endpointId: string, @Body\(\) body: \{ mode\?: unknown \} \| undefined\) \{\n\s*return \{ success: true, data: await this\.sessions\.connect\(a, endpointId, body\?\.mode\) \};/.test(sctl),
    `order ${J(order)}`);
  const strip = (t) => t.split('\n').filter((l) => !/^\s*(\*|\/\/)/.test(l)).join('\n');
  const managedCallers = files.filter((f) => /managed: true \}\)|managed: true as const/.test(strip(read(f))) && /canConnect\(|evaluateLaunch\(/.test(read(f))).map(rel);
  check('view-only and consent are enforceable only on the managed path; the Legacy credential gate is skipped only there; Legacy Connect keeps refusing a verified computer',
    /const enforce: SessionEnforcement = ctx\.managed === true\n\s*\? \{ viewOnly: true, attendedConsent: true \}\n\s*: \(ep\.sessionEnforcement \?\? \{\}\) as SessionEnforcement;/.test(pol)
      && /if \(opts\.credentialGate && decision\.revealCredential && opts\.managed !== true\) \{/.test(eps)
      && /if \(await this\.msaLegacyRefused\(endpoint\.id\)\) return \{ ok: false, reason: 'msa_managed', status: 'denied', message: LEGACY_REFUSED_MESSAGE \};/.test(eps)
      && /return \{ ok: false, reason: 'msa_not_managed',/.test(eps)
      && J(managedCallers.sort()) === J(['endpoints/endpoints.service.ts', 'msa/msa-sessions.service.ts'])
      && (ssvc.match(/managed: true \}\)/g) ?? []).length === 2,
    `managed callers ${J(managedCallers)}`);
  check('the terms are the policy\'s, never above the ceiling: view has nothing beyond, tunnel and restart are never set, consent only for a preset that requires it, 1–480 minutes',
    /const mode: GrantMode = i\.mode === 'view_only' \? 'view' : 'control';/.test(terms)
      && /tunnel: false,\n\s*restart: false,/.test(terms)
      && /const consent: GrantConsent = preset && i\.controls\.attendedConsent === 'required' \? 'required' : 'not_required';/.test(terms)
      && /const maxMinutes = Math\.max\(1, Math\.min\(480, Math\.floor\(limit\)\)\);/.test(terms)
      && /if \(!withinCeiling\(mode, permissions\)\) throw/.test(terms)
      && /if \(!withinCeiling\(terms\.mode, terms\.permissions\)\) throw new ConflictException\(\{ code: 'MSA_ABOVE_CEILING'/.test(gsvc)
      && J([...terms.matchAll(/^import [\s\S]*? from '([^']+)';/gm)].map((m) => m[1])) === J(['./grant', './managed']),
    'connect-terms.ts managedGrantTerms; MsaGrantService.signAndStore');
  const rel_ = body(gsvc, '  async release(');
  check('the one-time password: once, to the grant\'s own technician, for an applied Connect grant; audited, claimed by a conditional write, then opened',
    /if \(!g \|\| g\.source !== 'connect' \|\| g\.technicianId !== actor\.userId\) throw new NotFoundException/.test(rel_)
      && rel_.indexOf("if (g.state !== 'applied')") > 0
      && rel_.indexOf('await this.audit.logOrFail({') > rel_.indexOf("if (g.state !== 'applied')")
      && rel_.indexOf("where: { id: g.id, state: 'applied', revealedAt: null }") > rel_.indexOf('await this.audit.logOrFail({')
      && rel_.indexOf("openSecret(this.encKey, 'rem0te-msa-grant-pw-v1'") > rel_.indexOf("where: { id: g.id, state: 'applied', revealedAt: null }")
      && /this\.acl\.endpointVisibilityWhere\(actor\)/.test(rel_)
      && J(files.filter((f) => /\.release\(actor, grantId\)/.test(read(f))).map(rel)) === J(['msa/msa-sessions.service.ts']),
    'MsaGrantService.release');
  check('a Connect grant not applied within 60 s is revoked (timeout) and never handed over',
    /export const CONNECT_APPLY_TIMEOUT_MS = 60_000;/.test(managedTs)
      && /where: \{ endpointId, source: 'connect', state: \{ in: \['issued', 'delivered'\] \}, createdAt: \{ lt: new Date\(now - CONNECT_APPLY_TIMEOUT_MS\) \} \},/.test(gsvc)
      && /if \(due\.length\) await this\.revoke\(null, endpointId, \{ grantIds: due\.map\(\(g\) => g\.id\), reason: 'timeout' \}, now\);/.test(gsvc),
    'MsaGrantService.timeoutDue');

  // Revocation.
  const rv = body(gsvc, '  async revoke(');
  const revWriters = files.filter((f) => /msaRevocation\.(create|update|updateMany|upsert|delete|deleteMany|createMany)\(/.test(read(f))).map(rel);
  check('revocation: its own prefix, the same on the Go side; revocation.ts pure; the Go verifier pure',
    /export const REVOCATION_PREFIX = 'rem0te-msa-revoke-v1\\n';/.test(revTs) && /const RevocationPrefix = "rem0te-msa-revoke-v1\\n"/.test(revGo)
      && J([...revTs.matchAll(/^import [\s\S]*? from '([^']+)';/gm)].map((m) => m[1])) === J(['node:crypto', 'zod', './grant'])
      && !/process\.env|from '@prisma|fetch\(/.test(revTs)
      && J([...(/import \(([\s\S]*?)\)/.exec(revGo)?.[1] ?? '').matchAll(/"([^"]+)"/g)].map((m) => m[1])) === J(['bytes', 'crypto/ed25519', 'encoding/json', 'io', 'time'])
      && !/time\.Now\(/.test(revGo),
    'revocation.ts; internal/msa/grant/revocation.go');
  check('only MsaGrantService.revoke stores a revocation; it only moves live grants to revoked, creates no key, and is audited',
    J(revWriters) === J(['msa/msa-grant.service.ts'])
      && (gsvc.match(/msaRevocation\.create\(/g) ?? []).length === 1 && rv.includes('this.prisma.msaRevocation.create(')
      && /where: \{ id: \{ in: ids \}, endpointId, state: \{ in: \[\.\.\.LIVE_GRANT_STATES\] \} \},\n\s*data: \{ state: 'revoked', revokedAt: at, revokedById: actor\?\.userId \?\? null, revokeReason: sel\.reason \},/.test(rv)
      && !/msaGrantKey\.(create|update|upsert)|ensureKey|activeKey\(/.test(rv)
      && /export const LIVE_GRANT_STATES = \['issued', 'delivered', 'applied'\] as const;/.test(managedTs)
      && rv.indexOf("action: 'MSA_SESSION_REVOKED'") > rv.indexOf('msaRevocation.create('),
    `writers ${J(revWriters)}`);
  check('a `remote` pause revokes every grant that reached the computer, signed, on the next poll',
    /await this\.revoke\(null, ep\.id, \{ all: true, reason: 'pause', states: \['delivered', 'applied'\] \}, t\);/.test(gsvc),
    'MsaGrantService.answer');
  const revCallers = files.filter((f) => /grants\.revoke\(|this\.revoke\(null/.test(read(f))).map(rel).sort();
  check('who may revoke: the grant\'s technician, a Platform Admin, or the business\'s own non-technician member with computers:edit; revoking never asks',
    /private mayRevokeAny\(actor: ActorContext, businessId: string \| null\): boolean \{\n\s*if \(actor\.isPlatformAdmin\) return true;\n\s*return !actor\.technician && !!businessId && actor\.businessId === businessId && this\.acl\.can\(actor, CAP\.COMPUTERS_EDIT\);/.test(ssvc)
      && /private mayRevoke\(actor: ActorContext, g: \{ technicianId: string; businessId: string \}\): boolean \{\n\s*return g\.technicianId === actor\.userId \|\| this\.mayRevokeAny\(actor, g\.businessId\);/.test(ssvc)
      && !/assertFresh|stepUp/.test(sctl) && !/assertFresh|stepUp/.test(ssvc)
      && J(revCallers) === J(['msa/msa-grant.service.ts', 'msa/msa-sessions.service.ts']),
    `revoke callers ${J(revCallers)}`);
  const goRevoke = poller.slice(poller.indexOf('func (p *Poller) revoke('), poller.indexOf('func (p *Poller) endActive('));
  check('the agent verifies a revocation under the signed keys before acting, and it only ends a session',
    goRevoke.indexOf('p.H.Trust(ctx)') < goRevoke.indexOf('grant.VerifyRevocation(')
      && goRevoke.indexOf('grant.VerifyRevocation(') < goRevoke.indexOf('p.endSession(ctx, Revoked)')
      && !/p\.E\.(Apply|Set|SetPassword|Restore)\(/.test(goRevoke),
    'enforce/poller.go revoke');

  // Evidence.
  check('the timeline is pure and never shows Launched as Connected',
    !/^import /m.test(tl)
      && /push\('launched', r\.launchedAt \?\? r\.revealedAt, 'The one-time password was handed over\. This is not a connection\.'\);/.test(tl)
      && /push\('connected', r\.connectedAt,/.test(tl) && (tl.match(/push\('connected'/g) ?? []).length === 1
      && /export const CANNOT_SEE = \[/.test(tl),
    'session-timeline.ts');

  // Cutover runs.
  const rroutes = [...rctl.matchAll(/@(Get|Post)\(([^)]*)\)/g)].map((m) => `${m[1]} ${m[2]}`);
  const rr = (sig) => rctl.slice(rctl.indexOf(sig), rctl.indexOf('\n  }\n', rctl.indexOf(sig)));
  check('cutover runs: a Platform Admin\'s; start, advance and confirm name msa.cutover first; halt and rollback never ask',
    /@Controller\('msa\/cutover-runs'\)\n@UseGuards\(JwtAuthGuard, CapabilitiesGuard, PlatformAdminGuard\)/.test(rctl)
      && J(rroutes) === J(['Get ', "Get ':runId'", 'Post ', "Post ':runId/advance'", "Post ':runId/confirm'", "Post ':runId/halt'", "Post ':runId/rollback'"])
      && [['@Post()\n', 'this.runs.start('], ["@Post(':runId/advance')", 'this.runs.advance('], ["@Post(':runId/confirm')", 'this.runs.confirm(']].every(([sig, call]) => {
        const r = rr(sig); return /assertFresh\(this\.method\(req\), \{ action: 'msa\.cutover',/.test(r) && r.indexOf('assertFresh(') < r.indexOf(call);
      })
      && !/assertFresh/.test(rr("@Post(':runId/halt')")) && !/assertFresh/.test(rr("@Post(':runId/rollback')")),
    `routes ${J(rroutes)}`);
  const adv = body(rsvc, '  async advance(');
  const runWriters = files.filter((f) => /msaCutover(Run|Member)\.(create|update|updateMany|upsert|delete|deleteMany|createMany)\(/.test(read(f))).map(rel);
  check('cutover runs: canary first, each computer through the one-computer cutover, batches of at most 25, no timer, the only writer',
    J(runWriters) === J(['msa/msa-cutover-runs.service.ts'])
      && adv.indexOf("!run.canaryVerifiedAt ? 'MSA_CANARY_NOT_VERIFIED'") > 0
      && adv.indexOf("action: 'MSA_CUTOVER_RUN_ADVANCED'") < adv.indexOf('await this.managed.cutover(actor, id, run.id);')
      && !/msaManagedComputer\.(create|update|updateMany|upsert|delete|deleteMany)\(/.test(rsvc)
      && !/setInterval|setTimeout|@Cron|@Interval|onModuleInit/.test(rsvc)
      && /export const RUN_BATCH_MAX = 25;/.test(managedTs) && /export const RUN_MEMBERS_MAX = 500;/.test(managedTs)
      && /"MsaCutoverRun_one_open"/.test(mig) && /"batchSize" BETWEEN 1 AND 25/.test(mig),
    `writers ${J(runWriters)}`);

  check('0090: revoked and the sources, reasons, shapes and windows are CHECKed; one open run per business; a run stays in one business',
    /'revoked'/.test(mig) && /"source" IN \('test', 'connect', 'verify'\)/.test(mig)
      && /"reason" IN \('session', 'technician', 'business', 'computer', 'pause', 'timeout'\)/.test(mig)
      && /interval '9 hours'/.test(mig) && /cardinality\("grantIds"\) <= 20/.test(mig)
      && /CREATE TRIGGER "MsaCutoverMember_same_business"/.test(mig),
    '0090 migration');
  check('MSA sessions: the suites prove it',
    / msa-sessions[ ;]/.test(read('scripts/run-e2e.sh')) && /unit-msa-sessions\.mjs/.test(read('.github/workflows/ci.yml'))
      && /func TestRevocationEndsTheNamedSession\(/.test(read(`${goDir}/internal/msa/enforce/session_test.go`))
      && JSON.parse(read(`${goDir}/internal/msa/testdata/msa-revocations.json`)).cases.length >= 30
      && read('apps/web/scripts/e2e-ui.mjs').includes('msa\\/(managed|grants|sessions|cutover-runs)'),
    'e2e-msa-sessions.mjs in run-e2e.sh, unit-msa-sessions.mjs in CI, the Go session tests, the shared revocation fixture, the browser suite\'s gated-route check');
}

// ─── §84 (0.74): Admin → Security runs a closed list of host commands ────────
//     The pre-0.74 page ran ESLint and semgrep on a hard-coded home directory,
//     `npm audit fix` inside production's node_modules, fail2ban changes with
//     no audit row and no step-up, and showed failures as healthy. Now:
//       - one exec site, host-security/host-runner.ts: spawn with shell:false,
//         argv only from argvFor's closed switch; nothing else in the security
//         module imports child_process;
//       - every sudo command is a NOPASSWD line deploy/scripts/install.sh grants,
//         word for word; fail2ban changes go only through the root-owned
//         rem0te-f2b wrapper; the runner never names fail2ban-client;
//       - every mutating route is Platform Admin, then assertFresh naming
//         server.security (the lockout: login.lockout, only when it weakens);
//       - every host change is recorded as HOST_SECURITY_CHANGED with its
//         outcome, every lockout change as LOGIN_POLICY_CHANGED;
//       - a fixture is read only under NODE_ENV=test, and a test process with
//         none changes nothing;
//       - no npm audit fix, no eslint/semgrep, no Caddy /load renew;
//       - the posture's OFF_SWITCHES name every *_SWEEP / *_SEALER the API reads;
//       - the security module names no release-host path or command (§56).
//     0.75.1 (accepted risks):
//       - accepting a finding is Platform Admin, then assertFresh naming
//         server.security (it hides a warning), then the service; re-opening
//         is Platform Admin and never asks (it only shows a warning again);
//       - only a closed list of finding ids can be accepted, the same list in
//         acceptance.ts and migration 0093's CHECK, disjoint from the
//         never-acceptable list (a Platform Admin without MFA, break-glass
//         without both factors, the audit chain, empty SSH passwords,
//         NODE_ENV, test switches, TLS);
//       - an acceptance is recorded with logOrFail (SECURITY_FINDING_ACCEPTED)
//         and every end of one, by a person or on its own, is audited
//         (SECURITY_FINDING_UNACCEPTED); only SecurityService writes the table;
//       - an acceptance holds only while the finding's fingerprint is the one
//         stored and the expiry has not passed, and the basis behind the
//         fingerprint never leaves the API;
//       - ss runs as the service user (`ss -Htlnup`, no sudo): the owner of a
//         socket is shown only when that user may see it.
{
  console.log('\n§84 Admin → Security: closed host commands, audited and confirmed changes');
  const SRC = 'apps/api/src';
  const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const runner = read(`${SRC}/admin/host-security/host-runner.ts`);
  const svc = read(`${SRC}/admin/security.service.ts`);
  const ctl = read(`${SRC}/admin/security.controller.ts`);
  const posture = read(`${SRC}/admin/host-security/posture.ts`);
  const parsers = read(`${SRC}/admin/host-security/parsers.ts`);
  const acceptance = read(`${SRC}/admin/host-security/acceptance.ts`);
  const mod = [svc, ctl, posture, parsers, acceptance];
  check('server security: one exec site (host-runner.ts), shell:false, nothing else in the module imports child_process',
    (strip(runner).match(/\bspawn\(/g) ?? []).length === 1 && /shell: false/.test(runner) && !/shell: true|execSync|execFile/.test(runner)
      && mod.every((s) => !/child_process/.test(s)));
  const install = read('deploy/scripts/install.sh');
  const granted = [...install.matchAll(/^reboot ALL=\(root\) NOPASSWD: (\/\S+(?: [^\n!]+)?)$/gm)].map((m) => m[1].replace(/\\:/g, ':').replace(/\\=/g, '='));
  const sudoLines = [...runner.matchAll(/\['sudo', '-n', ([^\]]+)\]/g)].map((m) => m[1].split(', ').map((t) => {
    if (t === 'APT_GET') return '/usr/bin/apt-get';
    if (t === 'SYSTEMCTL') return '/usr/bin/systemctl';
    if (t === 'F2B_WRAPPER') return '/usr/local/sbin/rem0te-f2b';
    if (t.startsWith('...')) return '*';
    return t.replace(/^'|'$/g, '');
  }).join(' '));
  const notGranted = sudoLines.filter((l) => (l.endsWith(' *') ? !granted.some((g) => g.startsWith(l.slice(0, -2))) : !granted.includes(l)));
  check('server security: every sudo command the runner builds is a NOPASSWD line the installer grants, word for word',
    sudoLines.length === 7 && notGranted.length === 0 && !/'sudo', (?!'-n')/.test(runner) && !/fail2ban-client/.test(strip(runner)),
    `${sudoLines.length} sudo commands; not granted: ${JSON.stringify(notGranted)}`);
  check('server security: argvFor is a closed switch and fail2ban changes pass f2bArgsOk',
    /export function argvFor\(/.test(runner) && /switch \(c\.id\)/.test(runner) && /f2bArgsOk\(/.test(runner)
      && /CHANGE_IDS: ReadonlySet<string> = new Set\(\['f2b\.change', 'f2b\.install', 'f2b\.enable', 'f2b\.start', 'apt\.update', 'apt\.upgrade'\]\)/.test(runner));
  // Every mutating route: assertPlatformAdmin, then assertFresh naming its key, before (or, for the lockout, inside) the service call.
  const routes = [...ctl.matchAll(/@(Post|Patch|Delete)\('([^']+)'\)[\s\S]*?\n  async (\w+)\(.*\) \{([\s\S]*?)\n  \}/g)];
  // 0.75.1: re-opening an accepted finding only shows a warning again, so it is the one mutating route that never asks.
  const isUnaccept = ([, m, p]) => m === 'Delete' && p === 'findings/:id/accept';
  const unaccept = routes.find(isUnaccept);
  check('server security: re-opening an accepted finding is Platform Admin and never asks for a fresh confirmation',
    !!unaccept && /^\s*this\.acl\.assertPlatformAdmin\(a\);/.test(unaccept[4]) && !/assertFresh/.test(unaccept[4]) && /this\.security\.unacceptFinding\(a, id\)/.test(unaccept[4]),
    unaccept ? unaccept[4].trim().slice(0, 200) : 'no DELETE findings/:id/accept route');
  const badRoutes = routes.filter((r) => !isUnaccept(r)).filter(([, , p, , body]) => {
    const admin = body.indexOf('assertPlatformAdmin');
    const fresh = body.indexOf(`assertFresh(this.fresh(req), { action: '${p === 'config' ? 'login.lockout' : 'server.security'}' })`);
    const call = body.indexOf('this.security.');
    return admin < 0 || fresh < 0 || call < 0 || admin > call || (p !== 'config' && fresh > call);
  }).map((m) => m[2]);
  check('server security: every mutating route is Platform Admin, then assertFresh (server.security; login.lockout when weakening)',
    routes.length === 10 && routes.some(([, m, p, , body]) => m === 'Post' && p === 'findings/:id/accept' && /this\.security\.acceptFinding\(a, id, dto\)/.test(body)) && badRoutes.length === 0 && (ctl.match(/assertPlatformAdmin\(a\)/g) ?? []).length === (ctl.match(/@(Get|Post|Patch|Delete)\(/g) ?? []).length
      && /static weakens\(/.test(svc),
    `${routes.length} routes; bad: ${badRoutes.join(', ')}`);
  const methods = svc.split(/\n  (?=(?:private )?(?:static )?async \w+\()/);
  const unaudited = methods.filter((m) => /this\.host\.change\(/.test(m) && !/this\.record\(actor, 'HOST_SECURITY_CHANGED'/.test(m)).map((m) => m.trim().slice(0, 60));
  check('server security: every host change records HOST_SECURITY_CHANGED with its outcome, every lockout change LOGIN_POLICY_CHANGED',
    unaudited.length === 0 && /this\.record\(actor, 'LOGIN_POLICY_CHANGED'/.test(svc) && /ok: false/.test(svc)
      && /'HOST_SECURITY_CHANGED'/.test(read('apps/api/prisma/migrations/0091_server_security_audit/migration.sql')),
    unaudited.join(' | '));
  check('server security: a fixture only under NODE_ENV=test, and a test process without one changes nothing',
    /process\.env\.NODE_ENV === 'test' && f\)/.test(runner) && /HOST_CHANGES_OFF_IN_TEST/.test(svc + runner)
      && walk(SRC).filter((f) => /SECURITY_HOST_FIXTURE/.test(read(f)) && !f.endsWith('host-runner.ts')).length === 0);
  check('server security: no npm audit fix, no eslint or semgrep, no Caddy reload in the module',
    mod.concat(runner).every((s) => !/'audit', 'fix'|audit fix'|eslint|semgrep|localhost:2019/.test(strip(s)))
      && !/@Post\('audit\/fix'\)|@Post\('tls\/renew'\)/.test(ctl));
  const readSwitches = new Set();
  for (const f of walk(SRC)) for (const m of read(f).matchAll(/process\.env\.([A-Z_]+_(?:SWEEP|SEALER))\b/g)) readSwitches.add(m[1]);
  const named = new Set([...posture.matchAll(/name: '([A-Z_]+)'/g)].map((m) => m[1]));
  const missingSw = [...readSwitches].filter((s) => !named.has(s));
  check('server security: the posture flags every *_SWEEP / *_SEALER off switch the API reads',
    readSwitches.size >= 10 && missingSw.length === 0, `not in OFF_SWITCHES: ${missingSw.join(', ')}`);
  check('server security: the module names no release-host path or command (§56); the web shows the status command instead',
    mod.concat(runner).every((s) => !/\/var\/lib\/rem0te-|rem0te-signed-/.test(s))
      && /sudo rem0te-signed-status/.test(read('apps/web/app/(app)/admin/security/page.tsx')));
  // ── 0.75.1: accepted risks ──
  const ids = (re, src) => [...(re.exec(src)?.[1] ?? '').matchAll(/'([^']+)'/g)].map((m) => m[1]);
  const acceptableTs = ids(/export const ACCEPTABLE_FINDINGS = \[([\s\S]*?)\] as const;/, acceptance);
  const mig0093 = read('apps/api/prisma/migrations/0093_security_risk_acceptance/migration.sql');
  const acceptableSql = ids(/"findingId" IN \(([\s\S]*?)\)\);/, mig0093);
  const neverIds = [...acceptance.matchAll(/^\s*\{ id: '([^']+)'(, prefix: true)?, why: /gm)].map((m) => [m[1], !!m[2]]);
  const neverHit = (id) => neverIds.some(([n, pre]) => (pre ? id.startsWith(n) : id === n));
  const MUST_NEVER = ['portal.mfa.admins', 'portal.admins', 'portal.audit_chain', 'host.ssh.empty_passwords', 'process.node_env', 'process.switch.', 'web.tls'];
  check('accepted risks: one closed list of finding ids, the same in acceptance.ts and 0093\'s CHECK, with no value-carrying id',
    acceptableTs.length >= 20 && JSON.stringify(acceptableTs) === JSON.stringify(acceptableSql) && acceptableTs.every((id) => /^[a-z0-9_]+(\.[a-z0-9_]+)+$/.test(id)),
    `acceptance.ts ${acceptableTs.length}, 0093 ${acceptableSql.length}`);
  check('accepted risks: a Platform Admin without MFA, break-glass, the chain, empty SSH passwords, NODE_ENV, test switches and TLS are never acceptable, and the lists are disjoint',
    MUST_NEVER.every((id) => neverIds.some(([n]) => n === id)) && acceptableTs.every((id) => !neverHit(id))
      && /export function isAcceptable\(id: string\): id is AcceptableFinding \{\s*return \(ACCEPTABLE_FINDINGS as readonly string\[\]\)\.includes\(id\) && neverAcceptable\(id\) === null;/.test(acceptance),
    JSON.stringify(neverIds));
  check('accepted risks: acceptance.ts is pure (node:crypto and posture types only)',
    JSON.stringify([...acceptance.matchAll(/^import .* from '([^']+)';$/gm)].map((m) => m[1]).sort()) === JSON.stringify(['./posture', 'node:crypto'])
      && /^import type \{ Finding \} from '\.\/posture';$/m.test(acceptance));
  const acceptFn = /async acceptFinding\([\s\S]*?\n  \}\n/.exec(svc)?.[0] ?? '';
  check('accepted risks: accepting checks the closed list, the reason, the expiry and the live finding first, and is recorded with logOrFail',
    acceptFn.indexOf('neverAcceptable(findingId)') >= 0 && acceptFn.indexOf('isAcceptable(findingId)') > acceptFn.indexOf('neverAcceptable(findingId)')
      && acceptFn.indexOf('cleanReason(') > 0 && acceptFn.indexOf('expiryFor(') > 0 && /EVIDENCE_CHANGED/.test(acceptFn) && /FINDING_NOT_OPEN/.test(acceptFn)
      && acceptFn.indexOf('securityFindingAcceptance.create(') > acceptFn.indexOf('this.getPosture()')
      && /this\.audit\.logOrFail\(\{[\s\S]*?action: 'SECURITY_FINDING_ACCEPTED'/.test(acceptFn),
    'SecurityService.acceptFinding');
  const closeFn = /private async closeAcceptance\([\s\S]*?\n  \}\n/.exec(svc)?.[0] ?? '';
  check('accepted risks: every end of an acceptance is a conditional write audited as SECURITY_FINDING_UNACCEPTED with its cause',
    /updateMany\(\{\s*where: \{ id: row\.id, reopenedAt: null \}/.test(closeFn) && /if \(r\.count !== 1\) return false;/.test(closeFn) && /action: 'SECURITY_FINDING_UNACCEPTED'/.test(closeFn) && /cause/.test(closeFn)
      && /acceptanceStanding\(row, /.test(svc) && /else await this\.closeAcceptance\(row, standing, null, now\)/.test(svc) && /this\.closeAcceptance\(row, 'unaccepted', actor/.test(svc)
      && /'SECURITY_FINDING_ACCEPTED'/.test(mig0093) && /'SECURITY_FINDING_UNACCEPTED'/.test(mig0093));
  const writers = walk(SRC).filter((f) => /securityFindingAcceptance\.(create|update|updateMany|upsert|delete|deleteMany|createMany)\(/.test(read(f))).map((f) => f.replace(`${SRC}/`, ''));
  check('accepted risks: only SecurityService writes SecurityFindingAcceptance', JSON.stringify(writers) === JSON.stringify(['admin/security.service.ts']), writers.join(', '));
  check('accepted risks: an acceptance holds only on the same fingerprint before its expiry; the basis never leaves the API',
    /if \(row\.expiresAt && row\.expiresAt\.getTime\(\) <= now\.getTime\(\)\) return 'expired';/.test(acceptance)
      && /if \(finding\.fingerprint !== row\.fingerprint\) return 'evidence_changed';/.test(acceptance)
      && /const \{ basis: _basis, \.\.\.out \} = f;/.test(svc)
      && /"SecurityFindingAcceptance_open_key" ON "SecurityFindingAcceptance"\("findingId"\) WHERE "reopenedAt" IS NULL/.test(mig0093)
      && /char_length\(btrim\("reason"\)\) BETWEEN 3 AND 300/.test(mig0093) && /INTERVAL '365 days'/.test(mig0093));
  check('server security: ss runs as the service user (ss -Htlnup, no sudo); the ephemeral range is a fixed /proc file',
    /case 'ss\.listening': return \['ss', '-Htlnup'\];/.test(runner) && /portRange: '\/proc\/sys\/net\/ipv4\/ip_local_port_range',/.test(runner)
      && /l\.proto === 'udp' && l\.state === 'UNCONN'/.test(parsers));
  check('server security: unit and behavioural proof are wired (unit in CI, e2e in run-e2e.sh)',
    /unit-host-security\.mjs/.test(read('.github/workflows/ci.yml')) && /\bhost-security\b/.test(read('scripts/run-e2e.sh'))
      && /HOSTSEC_API_PORT \?\? 3991/.test(read('apps/api/scripts/e2e-host-security.mjs')));
}

// ── §85 (0.75): the device page's Tools panel only decides what it shows ─────
//     Tools lists what can be done to a computer and opens the flow that
//     already does it. It must stay a menu, never a second way in:
//       - lib/device-tools.ts is pure: no import, no fetch, no clock of its own.
//       - The panel (tools-panel.tsx) only reads, and only the reads the tabs
//         already make: the action catalog, the diagnostics catalog and the
//         containment banner. No useMutation, no post / put / patch / delete,
//         and no Managed Secure Access route (§81–§83: gated, off).
//       - Every action a tool names is one of the approved catalog's
//         (actions/catalog.ts), by id; every diagnostic is a listed catalog
//         key; the one link it builds is the existing diagnostics report.
//       - It adds no route: no controller under apps/api/src names "tools".
//       - Its rules are unit-tested in CI (unit-device-tools.mjs) and driven in
//         the browser suite.
{
  console.log('\n§85 Device Tools panel (decides what it shows; opens existing flows)');
  const lib = read('apps/web/lib/device-tools.ts');
  const panel = read('apps/web/components/endpoints/workspace/tools-panel.tsx');
  const code = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  check('Tools: lib/device-tools.ts is pure — no import, no fetch, no Date.now()',
    !/^\s*import\s/m.test(lib) && !/\brequire\(/.test(lib) && !/\bfetch\(|\baxios\b|\bapi\./.test(code(lib)) && !/Date\.now\(\)/.test(code(lib)),
    'apps/web/lib/device-tools.ts');
  const pc = code(panel);
  const calls = [...pc.matchAll(/\b(actionsApi|api|containmentApi|endpointsApi|msaApi|patchingApi)\.(\w+)\(/g)].map((m) => `${m[1]}.${m[2]}`);
  check('Tools: the panel only reads the action catalog, the diagnostics catalog and the containment banner',
    JSON.stringify([...new Set(calls)].sort()) === JSON.stringify(['actionsApi.catalog', 'api.get', 'containmentApi.banner'])
      && /api\.get\(`\/endpoints\/\$\{endpointId\}\/diagnostics\/catalog`\)/.test(pc)
      && !/useMutation|\.(post|put|patch|delete)\(/.test(pc) && !/\/msa\b|msaApi/.test(pc + code(lib)),
    `calls ${JSON.stringify([...new Set(calls)])}`);
  const apiCatalog = read('apps/api/src/actions/catalog.ts');
  const ids = new Set([...apiCatalog.matchAll(/^\s*id: '([a-z.]+)'/gm)].map((m) => m[1]));
  const named = [...lib.matchAll(/action: '([a-z.]+)'/g)].map((m) => m[1]);
  const diag = read('apps/api/src/diagnostics-catalog/catalog.ts');
  const keys = [...lib.matchAll(/kind: 'diagnostic', key: '([a-z_]+)'/g)].map((m) => m[1]);
  check('Tools: every action is an approved catalog action, every check a listed diagnostics key',
    named.length >= 11 && named.every((a) => ids.has(a)) && keys.length >= 8 && keys.every((k) => new RegExp(`key: '${k}'[^\\n]*`).test(diag) && !new RegExp(`key: '${k}'[^\\n]*tab: '`).test(diag)),
    `actions ${JSON.stringify(named.filter((a) => !ids.has(a)))} keys ${JSON.stringify(keys)}`);
  const links = [...lib.matchAll(/href: `([^`]+)`/g)].map((m) => m[1]);
  check('Tools: the only link it builds is the existing diagnostics report route',
    JSON.stringify(links) === JSON.stringify(['/api/v1/endpoints/${e}/diagnostics/report'])
      && /@Get\(':id\/diagnostics\/report'\)|'endpoints\/:id\/diagnostics\/report'|diagnostics\/report/.test(read('apps/api/src/diagnostics/diagnostics.controller.ts')),
    JSON.stringify(links));
  const ctrls = walk('apps/api/src').filter((f) => f.endsWith('.controller.ts')).filter((f) => /@(Get|Post|Put|Patch|Delete|Controller)\(['`][^'`]*\btools\b/.test(read(f)));
  check('Tools: no API route was added for it (no controller path names "tools")', ctrls.length === 0, ctrls.join(', '));
  check('Tools: the suites prove it',
    /unit-device-tools\.mjs/.test(read('.github/workflows/ci.yml')) && /async function toolsPanel\(/.test(read('apps/web/scripts/e2e-ui.mjs')),
    'unit-device-tools.mjs in CI; toolsPanel() in e2e-ui.mjs');
}

// ── §86 (0.76): the read-only diagnostics palette ───────────────────────────
//     Thirteen more catalog keys (security posture, networking, maintenance),
//     through §20's path unchanged: same delivery, auth, scope, capability,
//     containment, audit and retention. No new action, nothing signed, and
//     nothing that changes the computer:
//       - The agent's palette block passes assertPaletteBlockSafe, which every
//         served script goes through: Get-* and a short read-only list only,
//         no Set-/Enable-/Disable-/Remove-/Start-/Stop-/Restart-, no
//         Invoke-Expression, no download, no script block, a fixed list of
//         .NET calls, and the call operator once — System32 w32tm.exe with
//         /query /status. Checked here again, independently of that guard.
//       - It reads no BitLocker recovery password or protector id, no product
//         key, and no scheduled task's actions.
//       - Typed parameters exist only for dns_lookup and tcp_port, a closed
//         schema in parseDiagnosticParams; the same host-name rule character
//         for character in the portal, the agent and 0092's CHECK; the agent
//         checks the exact fields again. Both keys need computers:connect.
//       - Every palette key has a sanitizer; interpret.ts imports nothing.
{
  console.log('\n§86 Diagnostics palette (read-only checks, typed DNS / TCP parameters)');
  const ws = read('apps/api/src/public/windows-script.ts');
  const cat = read('apps/api/src/diagnostics-catalog/catalog.ts');
  const ipt = read('apps/api/src/diagnostics-catalog/interpret.ts');
  const mig = read('apps/api/prisma/migrations/0092_diagnostics_palette/migration.sql');
  const PAL = ['defender_status', 'firewall_status', 'bitlocker_status', 'secure_boot_tpm', 'local_admins', 'dns_lookup', 'tcp_port', 'route_table', 'time_sync', 'windows_activation', 'unexpected_shutdowns', 'scheduled_tasks', 'signed_in_sessions'];
  const keys = [...(/export const DIAGNOSTIC_KEYS = \[([\s\S]*?)\] as const;/.exec(cat)?.[1] ?? '').matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
  check('palette: the thirteen keys are catalog keys, after the twelve, in order', JSON.stringify(keys.slice(12)) === JSON.stringify(PAL) && keys.length === 25, keys.join(','));
  check('palette: every served script goes through assertPaletteBlockSafe',
    /function template\(v: Variant, host: string \| null\): string \{\s*return assertPaletteBlockSafe\(templateText\(v, host\)\);\s*\}/.test(ws)
      && /const PALETTE_ALLOWED_COMMANDS = \/\^\(Get-\[A-Za-z0-9\]\+\|Test-Path\|Join-Path\|Select-Object\|Sort-Object\|Confirm-SecureBootUEFI\|New-Object\|Test-Rem0tePal\[A-Za-z\]\+\)\$\/;/.test(ws)
      && /const PALETTE_FORBIDDEN = \/Invoke-\|\\biex\\b\|/.test(ws) && /\(Set\|Enable\|Disable\|Remove\|Start\|Stop\|Restart\|/.test(ws)
      && ['DownloadString', 'RecoveryPassword', 'KeyProtectorId', 'PartialProductKey', '\\.Actions\\b', '\\$env:'].every((t) => ws.slice(ws.indexOf('const PALETTE_FORBIDDEN'), ws.indexOf('const PALETTE_STATIC_CALLS')).includes(t)),
    'template() must return assertPaletteBlockSafe(templateText(...)) and the guard keep its lists');
  // Independently of the guard: the block as it sits in the source.
  const a = ws.indexOf('\n# ---- Read-only palette (0.76)');
  const pal = ws.slice(a, ws.indexOf('\n# ---- Snapshots (0.33)', a)).split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');
  const bare = pal.replace(/'[^'\n]*'/g, "''").replace(/"[^"\n]*"/g, '""');
  const cmds = [...new Set([...bare.matchAll(/\b[A-Z][a-z]+-[A-Z][A-Za-z0-9]+\b/g)].map((m) => m[0]))];
  const okCmd = (c) => /^Get-/.test(c) || ['Test-Path', 'Join-Path', 'Select-Object', 'Sort-Object', 'Confirm-SecureBootUEFI', 'New-Object'].includes(c) || /^Test-Rem0tePal[A-Za-z]+$/.test(c);
  check('palette: the block uses only Get-* and the read-only list, and no verb that changes anything',
    a > 0 && pal.length > 15000 && cmds.every(okCmd) && !/\b(Set|Enable|Disable|Remove|Start|Stop|Restart|Register|Unregister|Clear|Update|Install|Uninstall|Invoke|Out|Export|Write|Add)-[A-Z]/.test(bare),
    `commands: ${cmds.filter((c) => !okCmd(c)).join(', ') || cmds.join(', ')}`);
  check('palette: no expression, download, script block or environment read; no recovery password, protector id, product key or task action',
    !/Invoke-Expression|\biex\b|DownloadString|DownloadFile|WebClient|Invoke-WebRequest|Invoke-RestMethod|Start-Process|\[scriptblock\]|Add-Type|\\\$env:|RecoveryPassword|KeyProtectorId|\.(PartialProductKey|ProductKey|OA3xOriginalProductKey)\b|\.Actions\b|CommandLine/i.test(pal),
    'the palette reads; Send-Rem0teDiag, outside it, is the one post');
  const calls = [...bare.matchAll(/&\s*[\\$'"({]/g)];
  check('palette: the call operator appears once, running System32 w32tm.exe /query /status',
    calls.length === 1 && pal.includes("\\$lines = @(& \\$w32tm '/query' '/status' | Select-Object -First 40)")
      && pal.includes("\\$w32tm = Join-Path ([Environment]::SystemDirectory) 'w32tm.exe'") && (bare.match(/New-Object/g) ?? []).length === 1 && /New-Object System\.Net\.Sockets\.TcpClient\n/.test(pal),
    `${calls.length} call operator(s)`);
  // One host-name rule in three places (TS source literals unescaped once).
  const tsRe = /export const HOSTNAME_RE_SOURCE = '([^']+)';/.exec(cat)?.[1]?.replace(/\\\\/g, '\\');
  const psRaw = /export const PALETTE_HOSTNAME_RE = '([^']+)';/.exec(ws)?.[1];
  const psRe = psRaw?.replace(/\\\\/g, '\\');
  const sqlRe = [...mig.matchAll(/~ '(\^\[A-Za-z0-9\][^']*)'/g)].map((m) => m[1]);
  check('palette: the host-name rule is the same in the portal, the agent and both of 0092\'s CHECK clauses',
    !!tsRe && tsRe === psRe && sqlRe.length === 2 && sqlRe.every((r) => r === tsRe)
      && pal.includes(`return (\\$v -cmatch '${psRaw?.replace(/\$/g, '\\$')}')`) && /if \(\\\$v -match '\[\\\\r\\\\n\]'\) \{ return \\\$false \}/.test(pal),
    JSON.stringify({ tsRe, psRe, sqlRe }));
  check('palette: parameters are a closed schema for dns_lookup and tcp_port only, checked again by the agent and the database',
    /export const PARAM_FIELDS = \{ dns_lookup: \['name'\], tcp_port: \['host', 'port', 'timeoutSeconds'\] \} as const;/.test(cat)
      && /export const TCP_TIMEOUTS = \[1, 2, 3, 5, 10\] as const;/.test(cat)
      && (cat.match(/\bparams: '(dns_lookup|tcp_port)',/g) ?? []).length === 2 && !/\bparams: '(?!dns_lookup'|tcp_port')/.test(cat)
      && /Test-Rem0tePalKeys \\\$p @\('name'\)/.test(pal) && /Test-Rem0tePalKeys \\\$p @\('host', 'port', 'timeoutSeconds'\)/.test(pal) && /@\(1, 2, 3, 5, 10\) -contains/.test(pal)
      && /ELSE "params" IS NULL/.test(mig) && /\("params" - 'host' - 'port' - 'timeoutSeconds'\) = '\{\}'::jsonb/.test(mig)
      && (ws.match(/\\\$dr\.params/g) ?? []).length === 2,
    'PARAM_FIELDS, the agent\'s Test-Rem0tePalKeys, 0092 CHECK; $dr.params handed only to Get-Rem0tePalDns / Get-Rem0tePalTcp');
  const entryOf = (k) => cat.slice(cat.indexOf(`key: '${k}'`), cat.indexOf('},', cat.indexOf(`key: '${k}'`)));
  check('palette: dns_lookup and tcp_port need computers:connect; every palette key is read-only, agent 0.76.0, lab-evidence only',
    ['dns_lookup', 'tcp_port'].every((k) => /capability: 'computers:connect'/.test(entryOf(k)))
      && PAL.every((k) => /\.\.\.RO, \.\.\.PAL\b/.test(entryOf(k)))
      && /const RO = \{ risk: 'read_only', expectedImpact: 'none', approvals: 'none \(read-only\)', supportedOs: W \} as const;/.test(cat)
      && /const PAL = \{ minAgent: PALETTE_MIN_AGENT, evidence: 'lab_windows_server' \} as const;/.test(cat) && /export const PALETTE_MIN_AGENT = '0\.76\.0';/.test(cat),
    'catalog entries');
  const san = cat.slice(cat.indexOf('export function sanitizeResult('));
  check('palette: every key has its own sanitizer case; interpret.ts imports nothing',
    PAL.every((k) => san.includes(`case '${k}':`)) && !/^\s*import\s/m.test(ipt) && !/\brequire\(/.test(ipt),
    'sanitizeResult cases; interpret.ts pure');
  check('palette: the suites prove it',
    /unit-diagnostics-palette\.mjs/.test(read('.github/workflows/ci.yml')) && /diagnostics-lab\.mjs/.test(read('.github/workflows/lab-windows.yml')),
    'unit-diagnostics-palette.mjs in CI; the Windows lab job runs diagnostics-lab.mjs');
}

// ── §87 (0.77): the background terminal — a reversal, contained ──────────────
//     At the owner's request, the background terminal reverses three rules
//     for this feature only: §14's closed action catalog (a terminal is not a
//     catalog action and runs what the technician types), "the agent runs no
//     process" (the remote worker starts cmd.exe or powershell.exe), and §39's
//     constant command line (the shell's stdin is the technician's input).
//     Everything else holds, and this section proves the containment:
//       - Platform Admin only: computers:terminal is in PLATFORM_CAP, not CAP,
//         so no business, owner, user, technician, preset or SSO mapping holds
//         or grants it (the sanitisers keep only ALL_BUSINESS_CAPABILITIES).
//       - Every console route names its capability; opening checks scope,
//         the shell and the reason, then assertFresh('terminal.open') — the one
//         catalog key that defaults to ask (§62) — then openRefusal (pool,
//         Windows + signed agent, device secret, agent version, a `remote`
//         pause, connectivity, one live per technician, three per computer),
//         then logOrFail before the row exists.
//       - The agent channel is @Public with the device secret checked first
//         (authenticateDevice), then Windows + runsSignedAgent, then
//         assertAssigned. It does not depend on MSA_GRANTS. The heartbeat
//         says remotePoll only to an authenticated signed agent that may act.
//       - One exec site on the agent: internal/remote's SystemSpawner, the
//         installed System32 cmd.exe /D or powershell.exe -NoProfile ... by
//         absolute path, argument constants, CREATE_SUSPENDED, a Job Object
//         with KILL_ON_JOB_CLOSE assigned before it runs. Nothing from the
//         portal reaches a path or an argument: Start takes only the shell's
//         name. The worker listens on nothing.
//       - Limits agree across TS, Go and SQL (15 min idle, 60 min total,
//         frame and session caps), and the agent enforces them itself.
//       - Nothing typed or printed reaches a log or an audit row; frames are
//         deleted when delivered and with the session; transcripts only for a
//         business that turned them on (a Platform Admin's setting).
//       - Only TerminalService writes the terminal tables; only
//         RemoteOpsSettingsService writes the setting.
//       - TERMINAL_SWEEP=off is exact, exported by run-e2e.sh, set by
//         e2e-ui.mjs and listed in §84's OFF_SWITCHES.
{
  console.log('\n§87 Background terminal (a reversal of §14 / §39 for this feature, contained)');
  const SRC = 'apps/api/src';
  const code = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const caps = read(`${SRC}/rbac/capabilities.ts`);
  const capBody = (caps.match(/export const CAP = \{([\s\S]*?)\} as const;/) ?? [])[1] ?? '';
  const platBody = (caps.match(/export const PLATFORM_CAP = \{([\s\S]*?)\} as const;/) ?? [])[1] ?? '';
  check('terminal: computers:terminal is platform-only (PLATFORM_CAP, never CAP), held by a Platform Admin and dropped from every stored grant',
    /COMPUTERS_TERMINAL: 'computers:terminal'/.test(platBody) && !/computers:terminal/.test(capBody)
      && /export const ALL_BUSINESS_CAPABILITIES: Capability\[\] = Object\.values\(CAP\);/.test(caps)
      && /const allowed = new Set<string>\(ALL_BUSINESS_CAPABILITIES\);/.test(caps)
      && /if \(actor\.isPlatformAdmin\) return \[\.\.\.ALL_BUSINESS_CAPABILITIES, \.\.\.PLATFORM_ONLY_CAPABILITIES\];/.test(caps)
      && (code(caps).match(/PLATFORM_ONLY_CAPABILITIES/g) ?? []).length === 2,
    'rbac/capabilities.ts');

  const ctl = read(`${SRC}/remote-ops/terminal.controller.ts`);
  const routeCaps = [...code(ctl).matchAll(/@(Get|Post|Put)\(\s*(?:'([^']*)')?\s*\)\s*\n\s*@RequireCapability\(([A-Z_.]+)\)/g)].map((m) => `${m[1].toUpperCase()} ${m[2] ?? ''} ${m[3]}`);
  check('terminal: every console route names its capability — open, read, type, keep alive and transcript computers:terminal; list and end computers:view',
    JSON.stringify(routeCaps) === JSON.stringify([
      'GET  CAP.COMPUTERS_VIEW', 'POST  PLATFORM_CAP.COMPUTERS_TERMINAL', 'GET sessions/:sid PLATFORM_CAP.COMPUTERS_TERMINAL',
      'POST sessions/:sid/input PLATFORM_CAP.COMPUTERS_TERMINAL', 'POST sessions/:sid/keepalive PLATFORM_CAP.COMPUTERS_TERMINAL',
      'POST sessions/:sid/end CAP.COMPUTERS_VIEW', 'GET sessions/:sid/transcript PLATFORM_CAP.COMPUTERS_TERMINAL',
    ]) && /@Controller\('endpoints\/:id\/terminal'\)\s*\n@UseGuards\(JwtAuthGuard, CapabilitiesGuard\)/.test(ctl)
      && /@Controller\('remote-ops\/settings'\)\s*\n@UseGuards\(JwtAuthGuard, PlatformAdminGuard\)/.test(ctl),
    JSON.stringify(routeCaps));
  const agentCtl = code(ctl).slice(code(ctl).indexOf("@Controller('remote/agent')"));
  const agentRoutes = [...agentCtl.matchAll(/@Post\('([^']+)'\)\s*\n\s*@Public\(\)/g)].map((m) => m[1]);
  // 0.78 (§88) adds the four file routes; nothing else.
  check('terminal: the agent channel is exactly poll, output and the four file routes, @Public, under remote/agent',
    /@Controller\('remote\/agent'\)/.test(ctl) && JSON.stringify(agentRoutes) === JSON.stringify(['poll', 'terminal/output', 'files/pull', 'files/begin', 'files/push', 'files/finish'])
      && (agentCtl.match(/@(Get|Post|Put|Patch|Delete)\(/g) ?? []).length === 6 && (code(ctl).match(/@Public\(\)/g) ?? []).length === 6,
    JSON.stringify(agentRoutes));

  const svc = read(`${SRC}/remote-ops/terminal.service.ts`);
  const openBody = svc.slice(svc.indexOf('  async open('), svc.indexOf('\n  }\n', svc.indexOf('  async open(')));
  const order = ['this.visible(actor, endpointId, PLATFORM_CAP.COMPUTERS_TERMINAL)', 'isShell(body?.shell)', 'cleanReason(body?.reason)',
    "assertFresh(freshMethod, { action: 'terminal.open'", 'this.settle(s, ep.customerId, now)', 'openRefusal({', "action: 'TERMINAL_OPENED'", 'this.prisma.terminalSession.create('];
  const at = order.map((o) => openBody.indexOf(o));
  check('terminal: opening is scope, shell, reason, the fresh confirmation (terminal.open), settle, openRefusal, the audit row (logOrFail), then the row',
    at.every((i, n) => i >= 0 && (n === 0 || i > at[n - 1])) && /await this\.audit\.logOrFail\(\{\s*action: 'TERMINAL_OPENED'/.test(openBody),
    JSON.stringify(Object.fromEntries(order.map((o, n) => [o.slice(0, 40), at[n]]))));
  const pol = read(`${SRC}/remote-ops/policy.ts`);
  const refusalOrder = ['ENDPOINT_UNASSIGNED', 'TERMINAL_SIGNED_AGENT_REQUIRED', 'TERMINAL_NO_DEVICE_SECRET', 'TERMINAL_AGENT_TOO_OLD', "'CONTAINED'", 'TERMINAL_OFFLINE', 'TERMINAL_ALREADY_OPEN', 'TERMINAL_TOO_MANY'];
  const rAt = refusalOrder.map((c) => pol.indexOf(c));
  check('terminal: openRefusal refuses, in order, the pool, anything but the signed Windows agent, no device secret, an old agent, a remote pause, offline, a second own, a fourth',
    rAt.every((i, n) => i >= 0 && (n === 0 || i > rAt[n - 1])) && !/^\s*import\s[^;]*from '(?!\.\/limits')/m.test(pol), JSON.stringify(rAt));
  check('terminal: every read, write and agent call settles first — a limit or a `remote` pause ends the session — and only input and Keep alive move the idle clock',
    /const due = expiry\(s, now\);[\s\S]*?activePause\(this\.prisma, 'remote', customerId\)[\s\S]*?this\.end\(s, 'paused'\)/.test(svc)
      && (code(svc).match(/\btouch\(/g) ?? []).length === 2
      && /lastActivityAt: touch\(s, now\)/.test(svc.slice(svc.indexOf('  async input('), svc.indexOf('  async keepAlive(')))
      && /lastActivityAt: touch\(s, now\)/.test(svc.slice(svc.indexOf('  async keepAlive('), svc.indexOf('  async endBy('))),
    'remote-ops/terminal.service.ts');
  check('terminal: a session is bound to its technician — reading output, typing and Keep alive are the technician\'s own; anyone else is told nothing exists',
    /if \(s0\.technicianId !== actor\.userId\) throw new NotFoundException/.test(svc) && /const mine = s\.technicianId === actor\.userId;\s*let frames[^\n]*\n\s*if \(mine\) \{/.test(svc),
    'terminal.service.ts mine()/read()');
  const endMeta = (svc.match(/action: endAction\(reason\)[\s\S]*?meta: \{([\s\S]*?)\n      \},/) ?? [])[1] ?? '';
  const openMeta = (openBody.match(/meta: \{([^}]*)\}/) ?? [])[1] ?? '';
  check('terminal: audit rows carry ids, the shell, the reason, durations and byte counts — never input or output',
    endMeta.length > 0 && !/\bdata\b|frames|input/.test(endMeta) && /bytesIn/.test(endMeta) && /durationMs/.test(endMeta)
      && /reason/.test(openMeta) && !/\bdata\b|frames/.test(openMeta),
    `end meta: ${endMeta.replace(/\s+/g, ' ').slice(0, 200)}`);
  const remoteFiles = walk(`${SRC}/remote-ops`);
  const logs = remoteFiles.flatMap((f) => [...code(read(f)).matchAll(/\b(?:this\.)?logger\.(log|warn|error|debug|verbose)\(([^;]*)\);|console\.\w+\(/g)].map((m) => `${f}: ${m[0].slice(0, 80)}`));
  // 0.78: the file service's sweep has the same failed-sweep warning.
  check('terminal: the remote-ops module logs nothing but three fixed warnings (the switch, a failed sweep in each service)',
    logs.length === 3 && logs.every((l) => /TERMINAL_SWEEP=off|sweep: \$\{String\(e\)\}/.test(l)), logs.join(' | '));
  const writers = walk(SRC).filter((f) => f !== `${SRC}/remote-ops/terminal.service.ts`)
    .filter((f) => /\.(terminalSession|terminalFrame|terminalTranscriptChunk)\.(create|createMany|update|updateMany|upsert|delete|deleteMany)\(/.test(read(f)));
  const settingWriters = walk(SRC).filter((f) => f !== `${SRC}/remote-ops/remote-ops-settings.service.ts`)
    .filter((f) => /\.remoteOpsSetting\.(create|createMany|update|updateMany|upsert|delete|deleteMany)\(/.test(read(f)));
  check('terminal: only TerminalService writes the terminal tables, only RemoteOpsSettingsService the setting',
    writers.length === 0 && settingWriters.length === 0, [...writers, ...settingWriters].join(', '));

  const ras = read(`${SRC}/remote-ops/remote-agent.service.ts`);
  const dev = ras.slice(ras.indexOf('  private async device('), ras.indexOf('  async poll('));
  check('terminal: the agent channel checks the device secret first, then Windows and the signed agent, then the pool; strict bodies; no MSA_GRANTS',
    /^\s*const dev = await this\.enrollment\.authenticateDevice\(rustdeskId, agentSecret, reason\);/m.test(dev)
      && dev.indexOf('authenticateDevice') < dev.indexOf('this.prisma') && /runsSignedAgent\(/.test(dev) && /isWindowsPlatform\(/.test(dev) && /assertAssigned\(ep\)/.test(dev)
      && (ras.match(/z\.strictObject\(/g) ?? []).length >= 4 && !remoteFiles.some((f) => /msaGrantsEnabled|MSA_GRANTS/.test(code(read(f)))),
    'remote-ops/remote-agent.service.ts');
  const enr = read(`${SRC}/enrollment/enrollment.service.ts`);
  const ws = read(`${SRC}/public/windows-script.ts`);
  check('terminal: the heartbeat says remotePoll only to an authenticated signed agent that may act, and the signed heartbeat starts only `remote-worker`, with no argument from the portal',
    /let remotePoll = false;\s*if \(authenticated && mayAct && kind === 'signed'\) \{\s*try \{\s*remotePoll = await remoteWorkWanted\(this\.prisma, node\.endpointId\);/.test(enr)
      && /\.\.\.\(remotePoll \? \{ remotePoll: true \} : \{\}\)/.test(enr)
      && /if \(\$resp\.data\.remotePoll -eq \$true -and \(Test-Path -LiteralPath \$agentExe\)\) \{\s*Start-Process -FilePath \$agentExe -ArgumentList @\('remote-worker'\) -WindowStyle Hidden\s*\}/.test(ws)
      && (ws.match(/remote-worker/g) ?? []).length === 1,
    'enrollment.service.ts / windows-script.ts');

  // The agent.
  const GO = 'tools/windows-installer';
  // walk() lists TypeScript only; the Go package is one flat directory.
  const goFiles = readdirSync(join(ROOT, `${GO}/internal/remote`)).filter((f) => f.endsWith('.go') && !f.endsWith('_test.go')).map((f) => `${GO}/internal/remote/${f}`);
  const execs = goFiles.flatMap((f) => [...read(f).matchAll(/exec\.Command(?:Context)?\(([^)]*)\)/g)].map((m) => `${f.slice(GO.length + 1)}: ${m[1]}`));
  check('terminal: internal/remote has two exec sites, one per platform, each an argument array (path, args / the simulator\'s argv) — never a shell string',
    goFiles.length >= 6 && JSON.stringify(execs.sort()) === JSON.stringify(['internal/remote/spawn_unix.go: argv[0], argv[1:]...', 'internal/remote/spawn_windows.go: path, args...']), execs.join('; ') || `${goFiles.length} files`);
  const sw = read(`${GO}/internal/remote/spawn_windows.go`);
  check('terminal: on Windows the shell is System32\'s, by absolute path, from ShellCommand, created suspended in a Job Object (KILL_ON_JOB_CLOSE) and resumed only after it is assigned',
    /sys, err := windows\.GetSystemDirectory\(\)/.test(sw) && /path, args, ok := ShellCommand\(sys, shell\)/.test(sw) && /os\.Lstat\(path\)/.test(sw)
      && /CREATE_SUSPENDED/.test(sw) && /JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE/.test(sw)
      && sw.indexOf('AssignProcessToJobObject(job, ph)') > 0 && sw.indexOf('return resumeThreads(') > sw.indexOf('AssignProcessToJobObject(job, ph)')
      && /TerminateJobObject\(p\.job, 1\)/.test(sw) && !/"\/c"|"\/C"|-EncodedCommand|ExecutionPolicy/.test(sw),
    'internal/remote/spawn_windows.go');
  const sh = read(`${GO}/internal/remote/shell.go`);
  check('terminal: ShellCommand names exactly cmd.exe /D and powershell.exe -NoLogo -NoProfile -NonInteractive -Command - (stdin), and refuses UNC, device and relative paths and ".."',
    /case "cmd":\s*return joinWin\(system32, "cmd\.exe"\), \[\]string\{"\/D"\}, true/.test(sh)
      && /case "powershell":\s*return joinWin\(system32, `WindowsPowerShell\\v1\.0\\powershell\.exe`\), \[\]string\{"-NoLogo", "-NoProfile", "-NonInteractive", "-Command", "-"\}, true/.test(sh)
      && /strings\.HasPrefix\(system32, `\\\\`\) \|\| strings\.HasPrefix\(system32, "\/\/"\) \|\| strings\.Contains\(system32, "\.\."\)/.test(sh),
    'internal/remote/shell.go');
  const wk = read(`${GO}/internal/remote/worker.go`);
  check('terminal: the worker starts a shell from its name only (Spawner.Start(shell)), and logs no input, output or secret',
    /Start\(shell string\) \(Proc, error\)/.test(read(`${GO}/internal/remote/protocol.go`)) && /proc, err := w\.S\.Start\(in\.Shell\)/.test(wk)
      && [...wk.matchAll(/w\.logf\(([^\n]*)\)/g)].every((m) => !/\bb\b|\.data|Input|Frames|frames|Secret|pending/.test(m[1].replace(/"[^"]*"/g, ''))),
    'internal/remote/worker.go');
  const listen = [...goFiles, `${GO}/remote_worker_windows.go`, `${GO}/cmd/rem0te-remote-sim/main.go`].filter((f) => /net\.Listen|ListenAndServe|http\.Serve\(|ListenPacket/.test(read(f)));
  check('terminal: the worker listens on nothing (outbound polls only)', goFiles.length >= 6 && listen.length === 0, listen.join(', '));
  const goL = read(`${GO}/internal/remote/limits.go`);
  const tsL = read(`${SRC}/remote-ops/limits.ts`);
  const mig = read('apps/api/prisma/migrations/0094_terminal_sessions/migration.sql');
  check('terminal: the limits agree — 15 minutes idle, 60 in all, 4,096 / 16,384-byte frames — in TS, Go and 0094',
    /TERMINAL_IDLE_MS = 15 \* 60_000/.test(tsL) && /TERMINAL_MAX_MS = 60 \* 60_000/.test(tsL) && /IdleTimeout = 15 \* time\.Minute/.test(goL) && /MaxSession = 60 \* time\.Minute/.test(goL)
      && /TERMINAL_INPUT_FRAME_MAX = 4096/.test(tsL) && /InputFrameMax = 4096/.test(goL) && /TERMINAL_OUTPUT_FRAME_MAX = 16384/.test(tsL) && /OutputFrameMax = 16384/.test(goL)
      && /"notAfter" <= "createdAt" \+ interval '60 minutes'/.test(mig) && /CREATE UNIQUE INDEX "TerminalSession_one_live_key"/.test(mig),
    'limits.ts / limits.go / 0094');
  check('terminal: the worker enforces the hard limit from its own start, whatever the portal says (the portal may only shorten it)',
    /notAfter: now\.Add\(w\.d\(w\.MaxSession, MaxSession\)\)/.test(wk) && /t\.Before\(s\.notAfter\)/.test(wk) && /w\.stop\(s, "expired"\)/.test(wk) && /w\.stopAll\("disconnected"\)/.test(wk),
    'internal/remote/worker.go');

  // Switches, the console, the proof.
  check('terminal: TERMINAL_SWEEP=off is exact, exported by run-e2e.sh, set by e2e-ui.mjs and listed in OFF_SWITCHES',
    /process\.env\.TERMINAL_SWEEP === 'off'/.test(svc) && /^export TERMINAL_SWEEP=off$/m.test(read('scripts/run-e2e.sh'))
      && /TERMINAL_SWEEP: 'off'/.test(read('apps/web/scripts/e2e-ui.mjs')) && /name: 'TERMINAL_SWEEP'/.test(read(`${SRC}/admin/host-security/posture.ts`)),
    'TERMINAL_SWEEP');
  const tab = read('apps/web/components/endpoints/workspace/terminal-tab.tsx');
  check('terminal: the console says "SYSTEM — full control of this computer" and renders output as text',
    /SYSTEM — full control of this computer/.test(tab) && !/dangerouslySetInnerHTML|innerHTML/.test(tab), 'terminal-tab.tsx');
  check('terminal: the suites prove it (unit in CI, e2e with the agent\'s worker, the browser, the Windows lab)',
    /unit-terminal\.mjs/.test(read('.github/workflows/ci.yml')) && /rem0te-remote-sim/.test(read('.github/workflows/ci.yml'))
      && /run terminal node scripts\/e2e-terminal\.mjs/.test(read('scripts/run-e2e.sh')) && /async function terminalPanel\(/.test(read('apps/web/scripts/e2e-ui.mjs'))
      && /\.\/internal\/remote\//.test(read('.github/workflows/lab-windows.yml')),
    'ci.yml / run-e2e.sh / e2e-ui.mjs / lab-windows.yml');
}

// ── §88 (0.78): background file transfer — the same reversal, contained ─────
//     File transfer extends §87's reversal (the agent acting on what a
//     technician sends) to files. The agent writes and reads, as SYSTEM, a
//     path a Platform Admin typed. It is contained the same way:
//       - Upload and download are two platform-only capabilities
//         (PLATFORM_CAP), separately; no business role, preset, technician
//         or SSO mapping holds or grants them.
//       - request() checks scope with the direction's capability, then the
//         path rule, the reason, the size against the business's limit (100
//         MB default, 2 GB ceiling) and the SHA-256, then
//         assertFresh('files.transfer') (default off), then fileRefusal, then
//         logOrFail before the row exists.
//       - Only the technician who asked moves bytes (mine()). A Platform
//         Admin, or the business's own member with Edit computers, may cancel.
//       - The path rule is one shared fixture (testdata/file-paths.json),
//         asserted by Go's CheckPath and the portal's checkPath. 0095 also
//         refuses ".." and "/". The agent re-checks every folder on the
//         path for a reparse point, writes to an O_EXCL temporary file,
//         verifies the whole SHA-256 before anything is put in place, checks
//         the final path through the handle, and replaces an existing file
//         only when the transfer says overwrite.
//       - No exec in the file code; the worker still listens on nothing.
//       - Bytes are temporary: chunks go as they are acknowledged, with the
//         transfer's end and by the sweep. Audit rows carry the path, size
//         and SHA-256, never content.
{
  console.log('\n§88 Background file transfer (§87\'s reversal, extended to files, contained)');
  const SRC = 'apps/api/src';
  const GO = 'tools/windows-installer';
  const code = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const caps = read(`${SRC}/rbac/capabilities.ts`);
  const capBody = (caps.match(/export const CAP = \{([\s\S]*?)\} as const;/) ?? [])[1] ?? '';
  const platBody = (caps.match(/export const PLATFORM_CAP = \{([\s\S]*?)\} as const;/) ?? [])[1] ?? '';
  check('files: computers:files_upload and computers:files_download are platform-only (PLATFORM_CAP, never CAP)',
    /COMPUTERS_FILES_UPLOAD: 'computers:files_upload'/.test(platBody) && /COMPUTERS_FILES_DOWNLOAD: 'computers:files_download'/.test(platBody) && !/computers:files/.test(capBody),
    'rbac/capabilities.ts');

  const ctl = read(`${SRC}/remote-ops/file-transfer.controller.ts`);
  const routeCaps = [...code(ctl).matchAll(/@(Get|Post|Put)\(\s*(?:'([^']*)')?\s*\)\s*\n\s*@RequireCapability\(([A-Z_.]+)\)/g)].map((m) => `${m[1].toUpperCase()} ${m[2] ?? ''} ${m[3]}`);
  check('files: every console route names its capability — upload and its chunks files_upload, download and its chunks files_download, list, read and cancel computers:view',
    JSON.stringify(routeCaps) === JSON.stringify([
      'GET  CAP.COMPUTERS_VIEW', 'POST uploads PLATFORM_CAP.COMPUTERS_FILES_UPLOAD', 'POST downloads PLATFORM_CAP.COMPUTERS_FILES_DOWNLOAD',
      'GET :tid CAP.COMPUTERS_VIEW', 'POST :tid/chunks PLATFORM_CAP.COMPUTERS_FILES_UPLOAD', 'GET :tid/chunks/:seq PLATFORM_CAP.COMPUTERS_FILES_DOWNLOAD',
      'POST :tid/received PLATFORM_CAP.COMPUTERS_FILES_DOWNLOAD', 'POST :tid/cancel CAP.COMPUTERS_VIEW',
    ]) && /@Controller\('endpoints\/:id\/files'\)\s*\n@UseGuards\(JwtAuthGuard, CapabilitiesGuard\)/.test(ctl) && !/@Public\(\)/.test(ctl),
    JSON.stringify(routeCaps));

  const svc = read(`${SRC}/remote-ops/file-transfer.service.ts`);
  const reqBody = svc.slice(svc.indexOf('  async request('), svc.indexOf('  async get('));
  const at = (s) => reqBody.indexOf(s);
  const order = ['const ep = await this.visible(actor, endpointId, cap);', 'checkPath(body?.path)', 'cleanReason(body?.reason)', "'FILES_TOO_LARGE'", "'FILES_SHA256_INVALID'",
    "assertFresh(freshMethod, { action: 'files.transfer'", 'const refusal = fileRefusal({', "action: 'FILE_TRANSFER_REQUESTED'", 'this.prisma.fileTransfer.create('];
  check('files: request() runs scope (the direction\'s capability), path, reason, size, SHA-256, assertFresh(files.transfer), fileRefusal, then logOrFail before the row',
    order.every((s) => at(s) >= 0) && order.every((s, i) => i === 0 || at(order[i - 1]) < at(s))
      && /PLATFORM_CAP\.COMPUTERS_FILES_UPLOAD : PLATFORM_CAP\.COMPUTERS_FILES_DOWNLOAD/.test(reqBody) && /await this\.audit\.logOrFail\(\{\s*action: 'FILE_TRANSFER_REQUESTED'/.test(reqBody),
    order.map((s) => at(s)).join(','));
  const pol = read(`${SRC}/remote-ops/file-policy.ts`);
  const codes = [...(pol.slice(pol.indexOf('export function fileRefusal'))).matchAll(/code: '([A-Z_]+)'/g)].map((m) => m[1]);
  check('files: fileRefusal is pool, Windows + signed agent, device secret, agent version, a `remote` pause, connectivity, two live per computer — in that order',
    JSON.stringify(codes) === JSON.stringify(['ENDPOINT_UNASSIGNED', 'FILES_SIGNED_AGENT_REQUIRED', 'FILES_NO_DEVICE_SECRET', 'FILES_AGENT_TOO_OLD', 'CONTAINED', 'FILES_OFFLINE', 'FILES_TOO_MANY'])
      && !/from '(?!node:crypto'|\.\/limits'|\.\/policy')/.test(pol),
    JSON.stringify(codes));
  check('files: only the technician who asked moves bytes (mine(): their own transfer in that direction), for chunks in, chunks out and received',
    /if \(t0\.technicianId !== actor\.userId \|\| t0\.direction !== direction\) throw new NotFoundException/.test(svc)
      && ['putChunk', 'getChunk', 'received'].every((m) => new RegExp(`async ${m}\\([^)]*\\)[^{]*\\{\\s*const \\{ (?:ep, )?t \\} = await this\\.mine\\(actor, endpointId, tid, '(to|from)_computer', now\\);`).test(svc)),
    'file-transfer.service.ts mine()');
  check('files: cancel never asks for a fresh confirmation and goes through endAs (technician, Platform Admin, the business\'s own Edit computers)',
    /const as = endAs\(this\.enderFacts\(actor\), t\);\s*if \(!as\) throw new NotFoundException/.test(svc) && !/assertFresh/.test(svc.slice(svc.indexOf('  async cancel('), svc.indexOf('  async forAgent('))),
    'cancel()');
  const endMeta = (svc.match(/action: fileEndAction\(reason\)[\s\S]*?meta: \{([\s\S]*?)\n      \},/) ?? [])[1] ?? '';
  check('files: audit rows carry the path, size and SHA-256 — never content; chunks go with the end of a transfer and by the sweep',
    /sha256/.test(endMeta) && /size/.test(endMeta) && /path/.test(endMeta) && !/\bdata\b|chunk/i.test(endMeta)
      && /await this\.prisma\.fileTransferChunk\.deleteMany\(\{ where: \{ transferId: t\.id \} \}\);/.test(svc)
      && /transfer: \{ state: \{ in: \['failed', 'cancelled'\] \} \}/.test(svc) && /FILE_CHUNK_KEEP_MS/.test(svc),
    `end meta: ${endMeta.replace(/\s+/g, ' ').slice(0, 200)}`);
  const writers = walk(SRC).filter((f) => f !== `${SRC}/remote-ops/file-transfer.service.ts`)
    .filter((f) => /\.(fileTransfer|fileTransferChunk)\.(create|createMany|update|updateMany|upsert|delete|deleteMany)\(/.test(read(f)));
  check('files: only FileTransferService writes the file tables', writers.length === 0, writers.join(', '));

  const goFiles = readdirSync(join(ROOT, `${GO}/internal/remote`)).filter((f) => /^(files|filepath|fs_unix|fs_windows)\.go$/.test(f)).map((f) => `${GO}/internal/remote/${f}`);
  const fgo = read(`${GO}/internal/remote/files.go`);
  const fwin = read(`${GO}/internal/remote/fs_windows.go`);
  check('files: the agent\'s file code runs no process and opens no socket',
    goFiles.length === 4 && goFiles.every((f) => !/os\/exec|exec\.Command|net\.Listen|net\.Dial/.test(read(f))), goFiles.join(', '));
  check('files: the agent refuses a reparse point on every folder and the target, writes an O_EXCL temporary file, checks the final path by handle and the whole SHA-256 before placing it',
    (fgo.match(/isReparse\(/g) ?? []).length >= 4 && /os\.OpenFile\(tmp, os\.O_WRONLY\|os\.O_CREATE\|os\.O_EXCL, 0o600\)/.test(fgo)
      && (fgo.match(/finalPath\(/g) ?? []).length >= 3 && fgo.indexOf('if sum != j.SHA256 {') > 0 && fgo.indexOf('if sum != j.SHA256 {') < fgo.indexOf('place(tmp, local,'),
    'internal/remote/files.go');
  check('files: an existing file is replaced only when the transfer says overwrite (MoveFileEx REPLACE_EXISTING only then)',
    /if err := place\(tmp, local, exists && j\.Overwrite\); err != nil/.test(fgo) && /if replace \{\s*flags \|= windows\.MOVEFILE_REPLACE_EXISTING\s*\}/.test(fwin)
      && (fwin.match(/MOVEFILE_REPLACE_EXISTING/g) ?? []).length === 2,
    'files.go / fs_windows.go');
  check('files: the worker logs only a transfer\'s id, direction and code — never a path, content or secret',
    [...fgo.matchAll(/w\.logf\(([^\n]*)\)/g)].length >= 4 && [...fgo.matchAll(/w\.logf\(([^\n]*)\)/g)].every((m) => !/Path|path|local|data|Data|Secret|buf/.test(m[1].replace(/"[^"]*"/g, ''))),
    'internal/remote/files.go');
  const fx = read(`${GO}/internal/remote/testdata/file-paths.json`);
  check('files: one path fixture, asserted by both Go\'s CheckPath and the portal\'s checkPath',
    JSON.parse(fx).cases.length >= 40 && /testdata\/file-paths\.json/.test(read(`${GO}/internal/remote/filepath_test.go`)) && /testdata\/file-paths\.json/.test(read('apps/api/scripts/unit-files.mjs')),
    'testdata/file-paths.json');
  const goL = read(`${GO}/internal/remote/limits.go`);
  const tsL = read(`${SRC}/remote-ops/limits.ts`);
  const mig = read('apps/api/prisma/migrations/0095_file_transfers/migration.sql');
  check('files: the limits agree — 512 KiB chunks, eight in flight, 2 GiB, 60 minutes, 100 MB default — in TS, Go and 0095',
    /FILE_CHUNK_BYTES = 512 \* 1024/.test(tsL) && /FileChunkBytes = 512 \* 1024/.test(goL) && /FILE_WINDOW_CHUNKS = 8/.test(tsL) && /FILE_MAX_MB_MAX = 2048/.test(tsL)
      && /FileMaxBytes = 2048 \* 1024 \* 1024/.test(goL) && /FileTransferMax = 60 \* time\.Minute/.test(goL) && /FILE_TRANSFER_MAX_MS = 60 \* 60_000/.test(tsL)
      && /octet_length\("data"\) BETWEEN 1 AND 524288/.test(mig) && /"inSeq" - "ackSeq" <= 8/.test(mig) && /"fileMaxMb" BETWEEN 1 AND 2048/.test(mig)
      && /"notAfter" <= "createdAt" \+ interval '60 minutes'/.test(mig) && /position\('\.\.' in "path"\) = 0/.test(mig),
    'limits.ts / limits.go / 0095');
  const cat = read(`${SRC}/security-controls/confirm-catalog.ts`);
  check('files: files.transfer is a catalog key defaulting to off',
    /key: 'files\.transfer'[\s\S]{0,600}?default: 'off'/.test(cat), 'confirm-catalog.ts');
  const tab = read('apps/web/components/endpoints/workspace/files-tab.tsx');
  check('files: the console says "SYSTEM — full control of this computer", hashes in the browser and renders nothing as HTML',
    /SYSTEM — full control of this computer/.test(tab) && /from '@\/lib\/sha256'/.test(tab) && !/dangerouslySetInnerHTML|innerHTML/.test(tab), 'files-tab.tsx');
  check('files: the suites prove it (unit in CI, e2e with the agent\'s worker, the browser, the Windows lab)',
    /unit-files\.mjs/.test(read('.github/workflows/ci.yml')) && /run files node scripts\/e2e-files\.mjs/.test(read('scripts/run-e2e.sh'))
      && /async function filesPanel\(/.test(read('apps/web/scripts/e2e-ui.mjs')) && /TestLabFilesAsAdministrator/.test(read(`${GO}/internal/remote/lab_files_windows_test.go`)),
    'ci.yml / run-e2e.sh / e2e-ui.mjs / lab_files_windows_test.go');
}

// ── §89 (0.79): every catalog action declares rollback and repeatability ──────
//     Roadmap 2.1. Each of §14's twelve actions says how it is undone (a
//     closed kind: none, inverse with the action that undoes it, or
//     read_only) and whether a second run with the same parameters is
//     harmless. Both are data in the closed catalog on both sides, and the
//     two copies must agree action by action, in §14's order:
//       - Go: Action.Rollback (Rollback{Kind, Via}) and Action.Repeatable in
//         internal/action/catalog.go, and RollbackKinds;
//       - TS: CatalogAction.rollback ({ kind, via?, how }) and .repeat
//         ({ safe, why }) in actions/catalog.ts, and ROLLBACK_KINDS.
//     An inverse names a catalog action; read-only is always safe to repeat.
//     In 0.79 it is data only: nothing on the agent reads either field (no
//     plan, envelope, heartbeat or result changes), and on the portal they
//     are only served (the catalog route and the job view), never decided
//     on. Roadmap 2.2's bounded retry is the release that may read
//     `repeat.safe`; it changes the last two checks in the same commit.
{
  console.log('\n§89 Rollback and repeatability per catalog action (the same on the agent and the portal)');
  const CATALOG_IDS = ['windows.service.start', 'windows.update.install', 'windows.service.restart', 'windows.reboot.schedule', 'windows.reboot.cancel', 'windows.logs.collect', 'windows.script.run', 'windows.software.install', 'windows.software.uninstall', 'windows.software.remove', 'windows.service.control', 'windows.process.stop'];
  const goCat = read('tools/windows-installer/internal/action/catalog.go');
  const goKindName = { RollbackNone: 'none', RollbackInverse: 'inverse', RollbackReadOnly: 'read_only' };
  const goEntries = goCat.slice(goCat.indexOf('var catalog = []Action{')).split(/\n\t\{\n/).slice(1).map((e) => {
    const id = (e.match(/ID: "([^"]+)"/) ?? [])[1];
    const rb = e.match(/\n\t\tRollback:\s+Rollback\{Kind: (Rollback(?:None|Inverse|ReadOnly))(?:, Via: "([a-z.]+)")?\},\n/);
    const rp = e.match(/\n\t\tRepeatable:\s+(true|false),\n/);
    return { id, kind: rb ? goKindName[rb[1]] : null, via: rb?.[2] ?? '', safe: rp ? rp[1] === 'true' : null };
  });
  const goKinds = ((goCat.match(/var RollbackKinds = \[\]string\{([^}]*)\}/) ?? [])[1] ?? '').split(',').map((x) => goKindName[x.trim()]);
  check('§89: the agent declares a closed rollback kind and Repeatable on every catalog entry, in §14\'s order',
    JSON.stringify(goEntries.map((e) => e.id)) === JSON.stringify(CATALOG_IDS) && goEntries.every((e) => e.kind && typeof e.safe === 'boolean')
      && /const \(\s*RollbackNone\s+= "none"\s*RollbackInverse\s+= "inverse"\s*RollbackReadOnly = "read_only"\s*\)/.test(goCat)
      && /\n\tRollback\s+Rollback\n\tRepeatable bool\n\}/.test(goCat),
    `missing: ${goEntries.filter((e) => !e.kind || typeof e.safe !== 'boolean').map((e) => e.id).join(', ')}`);
  const tsCat = read('apps/api/src/actions/catalog.ts');
  const tsKinds = [...((tsCat.match(/export const ROLLBACK_KINDS = \[([^\]]*)\] as const;/) ?? [])[1] ?? '').matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
  const tsEntries = [...tsCat.matchAll(/^export const [A-Z_]+: CatalogAction = \{\s*id: '([^']+)'[\s\S]*?\n\};$/gm)].map((m) => {
    const rb = m[0].match(/\n {2}rollback: \{ kind: '(none|inverse|read_only)'(?:, via: '([a-z.]+)')?, how: '(?:[^'\\]|\\.){20,300}' \},\n/);
    const rp = m[0].match(/\n {2}repeat: \{ safe: (true|false), why: '(?:[^'\\]|\\.){20,300}' \},\n/);
    return { id: m[1], kind: rb?.[1] ?? null, via: rb?.[2] ?? '', safe: rp ? rp[1] === 'true' : null };
  });
  check('§89: the portal declares rollback (kind, how) and repeat (safe, why) on every catalog action, in §14\'s order',
    JSON.stringify(tsEntries.map((e) => e.id)) === JSON.stringify(CATALOG_IDS) && tsEntries.every((e) => e.kind && typeof e.safe === 'boolean')
      && /\n {2}rollback: Rollback;\n[\s\S]{0,200}\n {2}repeat: Repeat;\n\}/.test(tsCat),
    `missing: ${tsEntries.filter((e) => !e.kind || typeof e.safe !== 'boolean').map((e) => e.id).join(', ')}`);
  check('§89: the rollback kinds are the same closed list, in the same order, on both sides',
    JSON.stringify(goKinds) === JSON.stringify(['none', 'inverse', 'read_only']) && JSON.stringify(tsKinds) === JSON.stringify(goKinds),
    `agent ${JSON.stringify(goKinds)}, portal ${JSON.stringify(tsKinds)}`);
  const differ = CATALOG_IDS.filter((id, i) => JSON.stringify(goEntries[i]) !== JSON.stringify(tsEntries[i]));
  check('§89: the agent and the portal agree on every action\'s rollback kind, the action that undoes it, and whether it is safe to repeat',
    differ.length === 0, differ.map((id) => `${id}: agent ${JSON.stringify(goEntries.find((e) => e.id === id))}, portal ${JSON.stringify(tsEntries.find((e) => e.id === id))}`).join('; '));
  check('§89: an inverse names a catalog action and nothing else names one; read-only is always safe to repeat',
    tsEntries.every((e) => (e.kind === 'inverse' ? CATALOG_IDS.includes(e.via) : e.via === '') && (e.kind !== 'read_only' || e.safe === true)));
  const fx = JSON.parse(read('tools/windows-installer/internal/action/testdata/rollback-repeat.json'));
  check('§89: the shared fixture (Go test and unit test) says the same as both catalogs',
    JSON.stringify(fx.rollbackKinds) === JSON.stringify(tsKinds)
      && JSON.stringify(fx.actions.map((a) => ({ id: a.id, kind: a.rollback, via: a.via, safe: a.repeatable }))) === JSON.stringify(tsEntries),
    'testdata/rollback-repeat.json');
  // Data only in 0.79: nothing on the agent reads the fields outside catalog.go and its tests.
  const goFiles = [];
  const goWalk = (d) => { for (const n of readdirSync(join(ROOT, d))) { const r = `${d}/${n}`; if (statSync(join(ROOT, r)).isDirectory()) goWalk(r); else if (n.endsWith('.go')) goFiles.push(r); } };
  goWalk('tools/windows-installer');
  const goReaders = goFiles.filter((f) => !f.endsWith('_test.go') && f !== 'tools/windows-installer/internal/action/catalog.go')
    .filter((f) => /\.Rollback\.(?:Kind|Via)\b|\.Repeatable\b|\bRollback(?:Kinds|None|Inverse|ReadOnly)\b/.test(read(f)));
  check('§89: the agent reads neither field (data only; no plan, envelope or heartbeat change)', goFiles.length > 50 && goReaders.length === 0, goReaders.join(', ') || `${goFiles.length} Go files`);
  // Every file that loads the catalog, and any .rollback / .repeat it reads (a call, e.g. String#repeat, is not a read).
  const tsReaders = walk('apps/api/src').filter((f) => f.endsWith('.ts') && !f.endsWith('actions/catalog.ts'))
    .filter((f) => /from '(?:\.\/|(?:\.\.\/)+actions\/)catalog'/.test(read(f)) && /\.(rollback|repeat)\b(?!\s*\()/.test(read(f)));
  check('§89: on the portal they are only served (the catalog route and the job view), never decided on',
    JSON.stringify(tsReaders.map((f) => f.slice(f.indexOf('apps/api/src')))) === JSON.stringify(['apps/api/src/actions/actions.service.ts'])
      && (read('apps/api/src/actions/actions.service.ts').match(/\.(rollback|repeat)\b(?!\()/g) ?? []).length === 4,
    tsReaders.join(', '));
  check('§89: the docs table, the console and the suites carry it',
    /## Rollback and repeating an action \(0\.79\)/.test(read('docs/approved-actions.md'))
      && /data-help="rollback-repeat"/.test(read('apps/web/app/(app)/help/page.tsx'))
      && /testId="action-note"/.test(read('apps/web/components/endpoints/endpoint-actions.tsx')) && /testId="job-note"/.test(read('apps/web/components/endpoints/endpoint-actions.tsx'))
      && /data-testid="tool-note"/.test(read('apps/web/components/endpoints/workspace/tools-panel.tsx'))
      && /unit-action-rollback\.mjs/.test(read('.github/workflows/ci.yml')) && existsSync(join(ROOT, 'tools/windows-installer/internal/action/rollback_test.go'))
      && /action-note/.test(read('apps/web/scripts/e2e-ui.mjs')) && /tool-note/.test(read('apps/web/scripts/e2e-ui.mjs')),
    'docs/approved-actions.md, /help, Actions tab, Tools panel, unit-action-rollback.mjs in CI, rollback_test.go, e2e-ui.mjs');
}

// ── §90 (0.80): mobile devices through an MDM provider — read-only ──────────
//     The model, a provider-neutral driver interface, a bounded sync and four
//     read-only routes, proven against a loopback stand-in. No real provider
//     exists, so the checks are about what must stay true when one is added:
//       - no MDM provider host anywhere in the API, and no https URL in the
//         module; the pure files import nothing they should not;
//       - the driver interface reads only; a provider's HTTP goes through
//         safe-https;
//       - the stand-in is test-only and loopback-only (testLoopbackAllowed),
//         its base URL read in one place;
//       - MDM_SWEEP=off is exact and set wherever the rules demand;
//       - the closed lists in model.ts and 0096's CHECKs agree, in order;
//       - provider acceptance and device completion stay separate;
//       - every route is a GET needing mobile:view, and scope() runs first;
//       - mobile:view is never a default; only the sync writes the tables;
//         nothing creates a connector; no IMEI, and no BYOD serial.
{
  console.log('\n§90 Mobile devices (MDM): read-only, stand-in only, scoped');
  const SRC = 'apps/api/src';
  const DIR = `${SRC}/mdm`;
  const code = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const mdmFiles = walk(DIR);
  const HOSTS = /graph\.microsoft\.com|manage\.microsoft\.com|intune\.microsoft|androidmanagement\.googleapis|play\.google\.com\/work|mdmenrollment\.apple\.com|push\.apple\.com|deviceenrollment\.apple|identity\.apple\.com|business\.apple\.com\/.*mdm|workspaceone|jamfcloud|kandji\.io|meraki\.com\/.*sm/i;
  // 0.84 (§93): the exact list of allowed hosts — Apple's push host, once, as a constant in mdm/apple/apns.ts.
  const ALLOWED_HOSTS = { [`${DIR}/apple/apns.ts`]: ["export const APNS_ORIGIN = 'https://api.push.apple.com';"] };
  const stripAllowed = (f) => (ALLOWED_HOSTS[f] ?? []).reduce((t, line) => t.split(line).join(''), read(f));
  const hostHits = walk(SRC).filter((f) => HOSTS.test(stripAllowed(f)) || (ALLOWED_HOSTS[f] ?? []).some((line) => read(f).split(line).length !== 2));
  check('mdm: no MDM provider host appears anywhere in apps/api/src, except the allowed list (api.push.apple.com once, as APNS_ORIGIN in mdm/apple/apns.ts)', hostHits.length === 0, hostHits.join(', '));
  // 0.83: the plist DTD identifier a PushCertRequest names (never fetched), in setup/pki.ts only (§92).
  const DTD = 'http://www.apple.com/DTDs/PropertyList-1.0.dtd';
  // 0.84: and in apple/plist.ts (the same DTD line), and APNS_ORIGIN (above).
  const urlHits = mdmFiles.filter((f) => /https?:\/\/(?!127\.0\.0\.1)/.test(stripAllowed(f).split(f === `${DIR}/setup/pki.ts` || f === `${DIR}/apple/plist.ts` ? DTD : '\u0000').join('')));
  check('mdm: the module holds no URL but the allowed ones (the stand-in\'s base comes from MDM_TEST_BASE_URL only)', urlHits.length === 0, urlHits.join(', '));
  const imports = (f) => [...read(f).matchAll(/^import [^;]*? from '([^']+)';/gm)].map((m) => m[1]);
  check('mdm: model.ts imports nothing; command-state.ts only ./model; schemas.ts only zod, ./model and common/text',
    imports(`${DIR}/model.ts`).length === 0 && JSON.stringify(imports(`${DIR}/command-state.ts`)) === JSON.stringify(['./model'])
      && JSON.stringify(imports(`${DIR}/schemas.ts`).sort()) === JSON.stringify(['../common/text', './model', 'zod']),
    JSON.stringify({ cs: imports(`${DIR}/command-state.ts`), sc: imports(`${DIR}/schemas.ts`) }));

  const drv = code(read(`${DIR}/driver.ts`));
  const iface = (drv.match(/export interface MdmDriver \{([\s\S]*?)\n\}/) ?? [])[1] ?? '';
  const members = [...iface.matchAll(/^\s*([a-zA-Z]+)[(:]/gm)].map((m) => m[1]);
  check('mdm: MdmDriver reads only — provider, label, ready, listDevices, listCommands; no send, cancel or wipe',
    JSON.stringify(members) === JSON.stringify(['provider', 'label', 'ready', 'listDevices', 'listCommands']), JSON.stringify(members));
  const outbound = walk(SRC).filter((f) => !f.startsWith(DIR) ? false : /from 'https?'|from 'node:https?'|from '(node:)?http2'|require\('https?'\)|\bfetch\(|axios|undici/.test(read(f)));
  check('mdm: no HTTP client in the module except common/safe-https (and, for APNs only, common/safe-h2: §93)', outbound.length === 0 && mdmFiles.filter((f) => /safeGet|safePost/.test(read(f))).every((f) => /from '\.\.\/\.\.\/common\/safe-https'/.test(read(f))), outbound.join(', '));

  const si = read(`${DIR}/drivers/standin.ts`);
  const envReaders = walk(SRC).filter((f) => /MDM_TEST_BASE_URL/.test(code(read(f))));
  check('mdm: the stand-in is test-only and loopback-only — MDM_TEST_BASE_URL is read once, in standinBase(), through testLoopbackAllowed',
    JSON.stringify(envReaders) === JSON.stringify([`${DIR}/drivers/standin.ts`]) && (code(si).match(/process\.env\.MDM_TEST_BASE_URL/g) ?? []).length === 1
      && /return raw && testLoopbackAllowed\(raw\) \? raw : null;/.test(si) && /if \(!base\) throw new MdmDriverError\('not_ready'/.test(si)
      && /if \(!standinBase\(\)\) return \{ ok: false/.test(si),
    envReaders.join(', '));
  const idx = read(`${DIR}/drivers/index.ts`);
  const model = read(`${DIR}/model.ts`);
  // 0.84 (§93): two drivers — the stand-in and `apple`, which reads Rem0te's own Apple tables through the reader the sync hands it, and calls nothing.
  const apd = read(`${DIR}/drivers/apple.ts`);
  check('mdm: the drivers are exactly the stand-in and `apple`; the apple driver makes no call (no HTTP, no safe-https, no Prisma of its own)',
    /export const PROVIDERS = \['standin', 'apple'\] as const;/.test(model) && /standin: standinDriver,\n\s*apple: appleDriver\(deps\.apple\),\n\s*\};/.test(idx)
      && readdirSync(join(ROOT, `${DIR}/drivers`)).sort().join() === 'apple.ts,index.ts,standin.ts'
      && !/safe-https|safe-h2|fetch\(|PrismaService|prisma\./.test(code(apd)) && /ready: \(\) => \(\{ ok: true \}\)/.test(apd),
    'model.ts PROVIDERS / drivers/');

  const sync = read(`${DIR}/mdm-sync.service.ts`);
  const offReaders = walk(SRC).filter((f) => /process\.env\.MDM_SWEEP\b(?!_)/.test(code(read(f))));
  check('mdm: MDM_SWEEP=off is exact; run-e2e.sh exports it (and passes it to the scratch APIs), e2e-ui.mjs sets it, §84 names it',
    /if \(process\.env\.MDM_SWEEP === 'off'\) return;/.test(sync) && offReaders.every((f) => f.startsWith(DIR)) && /^export MDM_SWEEP=off$/m.test(read('scripts/run-e2e.sh'))
      && /TERMINAL_SWEEP=off MDM_SWEEP=off \\/.test(read('scripts/run-e2e.sh')) && /MDM_SWEEP: 'off'/.test(read('apps/web/scripts/e2e-ui.mjs'))
      && /\{ name: 'MDM_SWEEP', severity: /.test(read(`${SRC}/admin/host-security/posture.ts`)),
    offReaders.join(', '));
  check('mdm: the sync is bounded and careful — 20 connectors, 20 device and 10 command pages, an integration pause skipped, a conditional claim, not_reported only after a complete listing',
    /CONNECTORS_PER_PASS = 20;/.test(sync) && /DEVICE_PAGES = 20;/.test(sync) && /COMMAND_PAGES = 10;/.test(sync) && /PAGE_MAX = 100;/.test(read(`${DIR}/schemas.ts`))
      && /take: CONNECTORS_PER_PASS/.test(sync) && /activePause\(this\.prisma, 'integration', row\.customerId\)/.test(sync)
      && /const claimed = await this\.prisma\.mdmConnector\.updateMany\(\{/.test(sync) && /if \(claimed\.count !== 1\) return null;/.test(sync)
      && /if \(complete\) \{\s*const gone = await this\.prisma\.mobileDevice\.updateMany/.test(sync)
      && sync.indexOf("if (!drv.ready(row).ok) return 'not_ready';") < sync.indexOf('await drv.listDevices('),
    'mdm-sync.service.ts');

  const sql = read('apps/api/prisma/migrations/0096_mobile_devices/migration.sql');
  const listOf = (name) => { const m = model.match(new RegExp(`export const ${name} = \\[([^\\]]*)\\] as const;`)); return m ? [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]) : null; };
  const sql101 = read('apps/api/prisma/migrations/0101_mdm_apple/migration.sql');
  // 0.84: the provider CHECKs are re-made by 0101 with `apple`; the others are still 0096's.
  const checkOf = (c, col) => { const src = /_provider_check$/.test(c) ? sql101 : sql; const m = src.match(new RegExp(`CONSTRAINT "${c}" CHECK \\("${col}" (?:IS NULL OR "${col}" )?IN \\(([^)]*)\\)`)); return m ? [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]) : null; };
  const pairs = [
    ['PROVIDERS', 'MdmConnector_provider_check', 'provider'], ['PROVIDERS', 'MobileDevice_provider_check', 'provider'],
    ['PLATFORMS', 'MobileDevice_platform_check', 'platform'], ['OWNERSHIPS', 'MobileDevice_ownership_check', 'ownership'],
    ['MANAGEMENT_SCOPES', 'MobileDevice_managementScope_check', 'managementScope'], ['ENROLLMENT_STATES', 'MobileDevice_enrollmentState_check', 'enrollmentState'],
    ['COMPLIANCE_STATES', 'MobileDevice_complianceState_check', 'complianceState'], ['COMMAND_KINDS', 'MdmCommand_kind_check', 'kind'],
    ['COMMAND_ORIGINS', 'MdmCommand_origin_check', 'origin'], ['COMMAND_STATES', 'MdmCommand_state_check', 'state'],
    ['SYNC_RESULTS', 'MdmConnector_lastSyncResult_check', 'lastSyncResult'],
  ];
  const bad = pairs.filter(([l, c, col]) => { const a = listOf(l), b = checkOf(c, col); return !a || !b || JSON.stringify(a) !== JSON.stringify(b); });
  check('mdm: every closed list in model.ts is 0096\'s CHECK, word for word and in order (eleven constraints)', bad.length === 0, bad.map((b) => b[1]).join(', '));

  const cs = code(read(`${DIR}/command-state.ts`));
  check('mdm: provider acceptance and device completion stay separate — only provider_accepted stamps one, only device_completed the other, and never from sent',
    (cs.match(/providerAcceptedAt: e\.at/g) ?? []).length === 1 && (cs.match(/deviceCompletedAt: e\.at/g) ?? []).length === 1
      && /if \(f\.state === 'queued' \|\| f\.state === 'sent'\) return \{ ok: false, reason: 'not_accepted' \};\s*return move\(f, 'completed', \{ deviceCompletedAt: e\.at \}\);/.test(cs)
      && /completed: \[\],\s*failed: \[\],\s*expired: \[\],/.test(cs)
      && /\("deviceCompletedAt" IS NULL OR \("providerAcceptedAt" IS NOT NULL AND "state" = 'completed'\)\)/.test(sql)
      && /CREATE TRIGGER "MdmCommand_final_trg" BEFORE UPDATE ON "MdmCommand"/.test(sql),
    'command-state.ts / 0096');

  const ctl = code(read(`${DIR}/mdm.controller.ts`));
  const routes = [...ctl.matchAll(/@(Get|Post|Put|Patch|Delete)\(\s*(?:'([^']*)')?\s*\)\s*\n\s*@RequireCapability\(([A-Z_.]+)\)/g)].map((m) => `${m[1].toUpperCase()} ${m[2] ?? ''} ${m[3]}`);
  check('mdm: four GETs under mobile-devices, each @RequireCapability(CAP.MOBILE_VIEW), behind JwtAuthGuard and CapabilitiesGuard; no write route',
    JSON.stringify(routes) === JSON.stringify(['GET setup CAP.MOBILE_VIEW', 'GET  CAP.MOBILE_VIEW', 'GET :id CAP.MOBILE_VIEW', 'GET :id/commands CAP.MOBILE_VIEW'])
      && /@Controller\('mobile-devices'\)\s*\n@UseGuards\(JwtAuthGuard, CapabilitiesGuard\)/.test(ctl) && !/@(Post|Put|Patch|Delete)\(|@Public\(\)/.test(ctl),
    JSON.stringify(routes));
  const svc = code(read(`${DIR}/mdm.service.ts`));
  const readers = ['async setup(', 'async list(', 'private async visible('];
  check('mdm: scope() is the first statement of every read; a technician needs mobile:view on a whole-business grant; everyone else is pinned by requireScope; a device outside it is a 404',
    readers.every((r) => new RegExp(`${r.replace(/[()]/g, '\\$&')}[^)]*\\)[^{]*\\{\\s*const (?:where|scope) = this\\.scope\\(actor, q\\.businessId\\);`).test(svc))
      && /async get\([^)]*\) \{\s*const d = await this\.visible\(/.test(svc) && /async commands\([^)]*\) \{\s*const d = await this\.visible\(/.test(svc)
      && /s\.endpointIds === null && \(s\.capabilities as string\[\]\)\.includes\(CAP\.MOBILE_VIEW\)/.test(svc)
      && /const business = this\.acl\.requireScope\(actor, requested\);/.test(svc) && /if \(!this\.acl\.can\(actor, CAP\.MOBILE_VIEW\)\)/.test(svc)
      && /findFirst\(\{ where: \{ AND: \[\{ id \}, scope\] \}/.test(svc) && /if \(!d\) throw new NotFoundException/.test(svc),
    'mdm.service.ts');
  const caps = read(`${SRC}/rbac/capabilities.ts`);
  const capBody = (caps.match(/export const CAP = \{([\s\S]*?)\} as const;/) ?? [])[1] ?? '';
  const defBody = (caps.match(/DEFAULT_BUSINESS_USER_CAPABILITIES: Capability\[\] = \[([\s\S]*?)\];/) ?? [])[1] ?? '';
  const legacy = (caps.match(/LEGACY_ROLE_CAPABILITIES[^=]*= \{([\s\S]*?)\};/) ?? [])[1] ?? '';
  check('mdm: mobile:view is a business capability, never a Business User default, a legacy role\'s or a preset\'s',
    /MOBILE_VIEW: 'mobile:view'/.test(capBody) && !/MOBILE_VIEW/.test(defBody) && !/MOBILE_VIEW/.test(legacy)
      && !/MOBILE_VIEW|mobile:view/.test(read(`${SRC}/security-controls/presets.ts`)) && /MOBILE_VIEW: 'mobile:view'/.test(read('apps/web/lib/auth.ts')),
    'capabilities.ts / presets.ts');
  const writers = walk(SRC).filter((f) => f !== `${DIR}/mdm-sync.service.ts`)
    .filter((f) => /\.(mdmConnector|mobileDevice|mdmCommand)\.(create|createMany|update|updateMany|upsert|delete|deleteMany)\(/.test(read(f)));
  // 0.84 (§93): the sync creates connectors in one place, ensureAppleConnectors, and only `apple` ones.
  const ensure = (sync.match(/async ensureAppleConnectors\([\s\S]*?\n  \}\n/) ?? [''])[0];
  check('mdm: only MdmSyncService writes the MDM tables; the only connector it creates is an enabled `apple` one, in ensureAppleConnectors',
    writers.length === 0 && (sync.match(/mdmConnector\.(create|createMany|upsert)\(/g) ?? []).length === 1 && /this\.prisma\.mdmConnector\.createMany\(\{/.test(ensure)
      && /provider: 'apple', externalTenantId: 'rem0te', enabled: true/.test(ensure) && /skipDuplicates: true/.test(ensure), writers.join(', '));
  check('mdm: 0096 keeps connector, device and command in one business and tenant (three triggers)',
    ['MdmConnector_business_trg', 'MobileDevice_business_trg', 'MdmCommand_business_trg'].every((n) => new RegExp(`CREATE TRIGGER "${n}" BEFORE INSERT OR UPDATE`).test(sql)),
    '0096');
  const sc = code(read(`${DIR}/schemas.ts`));
  const rawDevice = (sc.match(/const RawDevice = z\.object\(\{([\s\S]*?)\n\}\)/) ?? [])[1] ?? '';
  check('mdm: no IMEI, MEID, phone number, MAC or user in the device schema; a BYOD serial is dropped and 0096 refuses one',
    rawDevice.length > 100 && !/imei|meid|phone|mac|wifi|bluetooth|user|email/i.test(rawDevice) && /d\.ownership === 'corporate' && d\.serialNumber/.test(sc)
      && /"serialNumber" IS NULL OR \("ownership" = 'corporate'/.test(sql),
    'schemas.ts / 0096');
  check('mdm: the suites prove it (unit in CI, e2e against the stand-in, the browser)',
    /unit-mdm\.mjs/.test(read('.github/workflows/ci.yml')) && /host-security mdm\b/.test(read('scripts/run-e2e.sh'))
      && /async function mobileDevicesUi\(/.test(read('apps/web/scripts/e2e-ui.mjs')),
    'ci.yml / run-e2e.sh / e2e-ui.mjs');
}

// ─── §18 addendum (0.59): no behavioural suite defaults to production's API ──
//     A dozen suites fell back to http://127.0.0.1:3001 when API_BASE was
//     unset. Run by hand with only DATABASE_URL set, one wrote its fixtures to
//     the scratch database and then tried to sign in against the live API.
//     There is now no default: lib/test-api-base.mjs requires API_BASE and
//     refuses https, a non-loopback host and the production ports.
{
  const dir = 'apps/api/scripts';
  const guard = read(`${dir}/lib/test-api-base.mjs`);
  const suites = readdirSync(join(ROOT, dir)).filter((f) => f.endsWith('.mjs'));
  const defaulting = suites.filter((f) => /process\.env\.API_BASE\s*(\|\||\?\?)\s*['"`]https?:\/\/(127\.0\.0\.1|localhost):(3000|3001|3201|3202|443|4000|4001)\b/.test(read(`${dir}/${f}`)));
  check('test suites: none falls back to a production API address when API_BASE is unset',
    defaulting.length === 0
      && /const REFUSED_PORTS = new Set\(\['3000', '3001', '3201', '3202', '443', '4000', '4001'\]\);/.test(guard)
      && /if \(!raw\) \{/.test(guard) && /u\.protocol !== 'http:'/.test(guard),
    defaulting.length ? `default to production: ${defaulting.join(', ')}` : 'lib/test-api-base.mjs: no default, loopback http only, production ports refused');
}

// ─── §18 addendum (0.73.1): the wire replay and its capture stay off production ──
//     compat-wire.mjs starts an API and writes computers, claim tokens,
//     commands and diagnostic runs; capture-wire.mjs runs released agent
//     scripts. Both are scratch-only by construction, and the fixtures they
//     share carry placeholders where a secret would be.
{
  const wire = read('scripts/compat-wire.mjs');
  const sh = read('scripts/compat-wire.sh');
  const cap = read('scripts/compat/capture-wire.mjs');
  check('wire replay: scratch database only, its own loopback API on 3981–3988, production ports and GeoIP file refused',
    /const PRODUCTION_PORTS = \[3000, 3001, 3201, 3202, 443, 4000, 4001\];/.test(wire)
      && /if \(PRODUCTION_PORTS\.includes\(PORT\) \|\| !\(PORT >= 3981 && PORT <= 3988\)\)/.test(wire)
      && /if \(!\/scratch\|test\/\.test\(dbName\)\)/.test(wire)
      && /const API = `http:\/\/127\.0\.0\.1:\$\{PORT\}\/api\/v1`;/.test(wire)
      && /GEOIP_DB_PATH: path\.join\(OUT, 'no-geoip\.mmdb'\)/.test(wire)
      && /! "\$name" =~ \(scratch\|test\)/.test(sh),
    'scripts/compat-wire.mjs, scripts/compat-wire.sh');
  check('wire capture: release scripts from git archive, a loopback capture server on 3981–3989, nothing sent anywhere else',
    /'archive', tag, 'apps\/api\/src\/public'/.test(cap) && !/readFileSync\(path\.join\(ROOT, 'apps', 'api', 'src'/.test(cap)
      && /if \(CAPTURE_PORT < 3981 \|\| CAPTURE_PORT > 3989\)/.test(cap) && /srv\.listen\(CAPTURE_PORT, '127\.0\.0\.1'/.test(cap)
      && /function Invoke-RestMethod \{/.test(read('scripts/compat/capture/windows-prelude.ps1')),
    'scripts/compat/capture-wire.mjs, capture/windows-prelude.ps1');
  const wireDir = join(ROOT, 'scripts', 'compat', 'wire');
  const leaks = [];
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) { walk(p); continue; }
      if (!e.name.endsWith('.json') || e.name === 'agents.json' || e.name === 'manifest.json') continue;
      const fx = JSON.parse(readFileSync(p, 'utf8'));
      const seen = (v) => {
        if (Array.isArray(v)) return v.forEach(seen);
        if (!v || typeof v !== 'object') return;
        for (const [k, x] of Object.entries(v)) {
          if (['agentSecret', 'password', 'token', 'sha256', 'rustdeskId', 'trayKey'].includes(k) && !(typeof x === 'string' && /^\{\{[A-Za-z0-9:_]+\}\}$/.test(x))) leaks.push(`${p.slice(ROOT.length + 1)}: ${k}`);
          seen(x);
        }
      };
      seen(fx.request?.body);
      if (/"(agentSecret|password|token|sha256|rustdeskId)":"(?!\{\{)/.test(fx.raw ?? '')) leaks.push(`${p.slice(ROOT.length + 1)}: raw`);
    }
  };
  if (existsSync(wireDir)) walk(wireDir);
  check('wire fixtures: every secret, identifier and token is a {{placeholder}} filled at replay',
    existsSync(wireDir) && leaks.length === 0, leaks.slice(0, 5).join('; ') || 'scripts/compat/wire');
}

// ── §91 (0.81 Vault): backups — provider facts, read-only ─────────────────────
//   - No provider is reached from outside backups/drivers/; there is no
//     fetch or raw request in backups/, safePost only in the drivers, and
//     the stand-in reads BACKUP_TEST_BASE_URL only through testLoopbackAllowed.
//   - Only BackupIngestService writes asset, job, point and drill rows; the
//     feed has no business, no restoreTest and no "verified": completion,
//     integrity and a verified restore are never collapsed, and 0097's CHECK
//     and trigger hold it in the database too.
//   - The push: @Public, rate-limited, the token's SHA-256 compared in
//     constant time, the business taken from the connection only.
//   - Reads go through assetWhere; connections are Platform Admin with
//     assertFresh('backup.connection').
//   - The four monitor kinds are opt-in (never in RECOMMENDED), swept from
//     stored rows; the 4.2 templates are SERVICE_STOPPED with alertIfMissing
//     false, from cited vendor sources, added only through createRule.
//   - BACKUP_SYNC_SWEEP=off is exact and exported by run-e2e.sh.
//   0.82 (Wharf, Settings → Backups and the St0r push contract):
//   - the dry run (?dryRun=1) passes the same token check and schema, then
//     only reads (preview) and writes one audit row, never a provider row or
//     the connection's result, and names no computer;
//   - rotate is the class guard plus assertFresh('backup.connection'),
//     logOrFail before a write conditional on the hash read (no overlap);
//   - linking an asset by hand: assetWhere, mayConfigure, a visible computer
//     of the asset's own business, audited; setLink writes only the link
//     columns; a person's choice outlives reports;
//   - contract v1: a drill names its recovery point; a fact never moves
//     backwards; the document and its generated schema are checked in CI.
{
  console.log('\n§91 Backups (provider facts, read-only; completion, integrity and restore kept apart)');
  const SRC = 'apps/api/src';
  const B = `${SRC}/backups`;
  const code = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const all = walk(SRC);
  const bk = all.filter((f) => f.startsWith(`${B}/`));
  const src = (f) => code(read(f));

  const net = bk.filter((f) => /(?<![.\w]|async |\n  )fetch\(|\bhttps?\.request\(|\bhttps?\.get\(|axios|undici|\bgot\(/.test(src(f)));
  check('backups: no fetch or raw request anywhere in backups/', net.length === 0, net.join(', '));
  const posts = all.filter((f) => /\bsafe(Post|Get)\(/.test(src(f)) && f.startsWith(`${B}/`) && !f.startsWith(`${B}/drivers/`));
  check('backups: safe-https only in backups/drivers/', posts.length === 0, posts.join(', '));
  const testUrl = all.filter((f) => /process\.env\.BACKUP_TEST_BASE_URL|env\[['"]BACKUP_TEST_BASE_URL/.test(src(f)));
  const standin = src(`${B}/drivers/standin.ts`);
  check('backups: BACKUP_TEST_BASE_URL is read only by the stand-in, and only through testLoopbackAllowed',
    testUrl.length === 1 && testUrl[0] === `${B}/drivers/standin.ts` && /const v = process\.env\.BACKUP_TEST_BASE_URL;\s*return v && testLoopbackAllowed\(v\)/.test(standin), testUrl.join(', '));
  const drivers = src(`${B}/drivers/index.ts`);
  check('backups: the only driver in this release is the stand-in', /DRIVERS: Partial<Record<ConnectionKind, BackupDriver>> = \{\s*standin: standinDriver,?\s*\}/.test(drivers), 'drivers/index.ts');
  const imp = all.filter((f) => !f.startsWith(`${B}/`) && /from '[./]*backups\/(drivers|backup-ingest|push-token)/.test(read(f)));
  check('backups: nothing outside backups/ imports a driver, the ingest service or the push token', imp.length === 0, imp.join(', '));

  const writes = all.filter((f) => /\.(backupProtectedAsset|backupJob|backupRecoveryPoint|restoreDrill)\.(create|createMany|update|updateMany|upsert|delete|deleteMany)\(/.test(src(f)));
  check('backups: only BackupIngestService writes asset, job, recovery point and drill rows', writes.length === 1 && writes[0] === `${B}/backup-ingest.service.ts`, writes.join(', '));
  const model = src(`${B}/model.ts`);
  const feedSchemas = ['FeedJob', 'FeedPoint', 'FeedDrill', 'FeedAsset', 'Feed'].map((n) => (model.match(new RegExp(`export const ${n} = z\\.object\\(\\{[\\s\\S]*?\\}\\)\\.strict\\(\\)`)) ?? [''])[0]);
  check('backups: every feed schema is strict', feedSchemas.every(Boolean), feedSchemas.map((s, i) => (s ? '' : i)).join(','));
  check('backups: the feed names no business, tenant, restoreTest or "verified" — the provider cannot say a job was verified',
    feedSchemas.every((s) => !/\b(businessId|customerId|tenantId|restoreTest|verified)\s*:/.test(s)), 'model.ts');
  check('backups: a drill must say whether it was simulated, and a pass must have validated something',
    /simulated: z\.boolean\(\),/.test(model) && /result !== 'passed' \|\| d\.validation !== 'none'/.test(model), 'model.ts FeedDrill');
  check('backups: a job is verified only by a passed, non-simulated drill of its own recovery point (deriveRestoreTests)',
    /!d\.simulated/.test(model) && /recoveryPointId/.test(model) && /'verified'/.test(model), 'model.ts deriveRestoreTests');
  const mig = read('apps/api/prisma/migrations/0097_backups/migration.sql');
  check('0097: the job keeps completion, integrity and restoreTest as three columns, restoreTest tied to a drill by CHECK and trigger',
    /"completion" TEXT NOT NULL/.test(mig) && /"integrity" TEXT NOT NULL DEFAULT 'not_checked'/.test(mig) && /"restoreTest" TEXT NOT NULL DEFAULT 'not_tested'/.test(mig)
      && /\("restoreTest" = 'not_tested'\) = \("restoreDrillId" IS NULL\)/.test(mig) && /CREATE FUNCTION backup_job_restore_test\(\)/.test(mig) && /AND NOT d\."simulated"/.test(mig),
    '0097');
  check('0097: a same-business trigger on every backup table, and the four monitor kinds in the ticket-rule CHECK',
    ['BackupProtectedAsset', 'BackupJob', 'BackupRecoveryPoint', 'RestoreDrill', 'BackupObjective'].every((t) => new RegExp(`ON "${t}"\\s+FOR EACH ROW EXECUTE FUNCTION backup_same_business\\(\\)`).test(mig))
      && ['BACKUP_STALE', 'BACKUP_FAILED', 'DRILL_FAILED', 'RPO_EXCEEDED'].every((k) => mig.includes(`ALTER TYPE "MonitorKind" ADD VALUE '${k}'`) && new RegExp(`"MonitorTicketPolicy_kinds"[\\s\\S]*'${k}'`).test(mig)), '0097');

  const ctl = src(`${B}/backups.controller.ts`);
  const push = (ctl.match(/export class BackupPushController[\s\S]*$/) ?? [''])[0];
  const setupSrc = src(`${B}/setup.ts`);
  check('push: @Public, @RateLimit, token parsed from the Authorization header, the same 401 for every refusal',
    /@Post\(\)\s*@Public\(\)\s*@RateLimit\((\d+|PUSH_PER_MINUTE)\)/.test(push) && /export const PUSH_PER_MINUTE = \d+;/.test(setupSrc) && /parsePushAuth\(auth\)/.test(push)
      && /if \(!secretMatches\(t\.secret, live \? conn!\.pushTokenHash : null\) \|\| !live\) throw refuse\(\);/.test(push), 'BackupPushController');
  // 0.82: the dry run's audit row names the connection's business (conn!.customerId) — the only business the push code names.
  check('push: the body never chooses a business — the ingest gets the token\'s connection',
    !/businessId|customerId/.test(push.replace(/customerId: conn!\.customerId/g, '')) && /this\.ingest\.ingest\(conn!, f\.feed\)/.test(push) && /parseFeed\(body\)/.test(push), 'BackupPushController');
  const tok = src(`${B}/push-token.ts`);
  check('push token: stored only as SHA-256, compared with timingSafeEqual', /createHash\('sha256'\)/.test(tok) && /timingSafeEqual/.test(tok) && !/sealSecret/.test(tok), 'push-token.ts');
  const ingest = src(`${B}/backup-ingest.service.ts`);
  check('ingest: every row is written with the connection\'s business; computers are linked only inside it',
    /const customerId = conn\.customerId;/.test(ingest) && /where: \{ id: c\.rem0teId, customerId, status: 'ACTIVE' \}/.test(ingest) && /where: \{ customerId, status: 'ACTIVE', hostname:/.test(ingest), 'backup-ingest.service.ts');

  const svc = src(`${B}/backups.service.ts`);
  check('reads: overview and asset go through assetWhere; backups:view is required off the owner path',
    /const where = this\.assetWhere\(a, businessId\);/.test(svc) && /AND: \[\{ id \}, this\.assetWhere\(a, businessId\)\]/.test(svc) && /CAP\.BACKUPS_VIEW/.test(svc) && /endpointVisibilityWhere\(a, scope\)/.test(svc), 'backups.service.ts');
  const conns = (ctl.match(/export class BackupConnectionsController[\s\S]*?\n\}/) ?? [''])[0];
  check('connections: Platform Admin (class guard); create names backup.connection before the service call; revoke never asks',
    /@UseGuards\(PlatformAdminGuard\)\s*export class BackupConnectionsController/.test(ctl) && /assertFresh\([^;]*action: 'backup\.connection'[^;]*\);\s*return \{ success: true, data: await this\.svc\.createConnection/.test(conns)
      && !/assertFresh/.test((conns.match(/async revoke[\s\S]*$/) ?? [''])[0]), 'BackupConnectionsController');
  check('connections: logOrFail before the row; no token, hash or credential in a view', /logOrFail\(\{\s*action: 'BACKUP_CONNECTION_CREATED'/.test(svc)
    && !/(pushTokenHash|credentialEnc)\s*[:,]/.test((svc.match(/private connectionView[\s\S]*?\n  \}/) ?? [''])[0]), 'backups.service.ts');
  check('backups: no route starts a backup, a restore, a drill or a failover', !/@(Post|Put)\('[^']*(restore|drill|failover|run|start)[^']*'\)/.test(ctl), 'backups.controller.ts');

  // ── 0.82 (Wharf): the dry run, rotation, linking by hand, the contract ──
  const dryBlock = (push.match(/if \(dryRun\) \{[\s\S]*?\n    \}\n/) ?? [''])[0];
  check('dry run: after the same token check and parse, it calls only preview and one audit row, and returns before any write',
    !!dryBlock && push.indexOf('if (dryRun) {') > push.indexOf('throw refuse();\n    const f = parseFeed(body);') && /this\.ingest\.preview\(conn!, f\.feed\)/.test(dryBlock) && /action: 'BACKUP_PUSH_DRY_RUN'/.test(dryBlock)
      && /return \{/.test(dryBlock) && !/ingest\.(ingest|failed|setLink)|prisma\.\w+\.(create|update|upsert|delete)/.test(dryBlock), 'BackupPushController dry run');
  const preview = (ingest.match(/async preview\([\s\S]*?\n  \}\n/) ?? [''])[0];
  check('dry run: BackupIngestService.preview only reads, and never returns a computer id',
    !!preview && !/\.(create|createMany|update|updateMany|upsert|delete|deleteMany)\(/.test(preview) && !/endpointId: [a-z]/.test(preview.replace(/select: \{[^}]*\}/g, '')), 'preview');
  const rot = (conns.match(/async rotate[\s\S]*?\n  \}/) ?? [''])[0];
  check('rotate: Platform Admin (class guard), assertFresh naming backup.connection before the service call',
    /assertFresh\([^;]*action: 'backup\.connection'[^;]*\);\s*return \{ success: true, data: await this\.svc\.rotateConnection/.test(rot), 'BackupConnectionsController.rotate');
  const rotSvc = (svc.match(/async rotateConnection[\s\S]*?\n  \}/) ?? [''])[0];
  check('rotate: logOrFail before a write conditional on the hash read (no overlap: the old hash is replaced), the token returned once',
    /logOrFail\(\{\s*action: 'BACKUP_CONNECTION_ROTATED'/.test(rotSvc) && rotSvc.indexOf('logOrFail') < rotSvc.indexOf('updateMany')
      && /where: \{ id: c\.id, revokedAt: null, enabled: true, pushTokenHash: c\.pushTokenHash \}/.test(rotSvc) && /data: \{ pushTokenHash: tok\.hash, pushTokenLast4: tok\.last4/.test(rotSvc)
      && !/(beforeLast4|afterLast4): tok\.(token|hash)/.test(rotSvc), 'rotateConnection');
  const linkSvc = (svc.match(/async linkAsset[\s\S]*?\n  \}/) ?? [''])[0];
  check('link: the asset through assetWhere, mayConfigure for its business, a computer of THAT business the caller can see, audited',
    /AND: \[\{ id: assetId \}, this\.assetWhere\(a\)\]/.test(linkSvc) && /this\.mayConfigure\(a, x\.customerId\)/.test(linkSvc)
      && /AND: \[\{ id: d\.data\.endpointId, customerId: x\.customerId, status: 'ACTIVE' \}, this\.acl\.endpointVisibilityWhere\(a, x\.customerId\)\]/.test(linkSvc)
      && /action: 'BACKUP_ASSET_LINKED'/.test(linkSvc) && /before: \{[^}]*\}, after: \{/.test(linkSvc), 'linkAsset');
  const setLink = (ingest.match(/async setLink[\s\S]*?\n  \}/) ?? [''])[0];
  const setKeys = [...(setLink.match(/data: [\s\S]*$/) ?? [''])[0].matchAll(/\b(\w+): /g)].map((m) => m[1]).filter((k) => !['data', 'endpointId'].includes(k));
  check('link: setLink changes only endpointId and the link columns, within the asset\'s business',
    !!setLink && /where: \{ id: assetId, customerId \}/.test(setLink) && setKeys.every((k) => ['linkSource', 'linkedById', 'linkedAt'].includes(k)), setKeys.join(','));
  check('link: a person\'s link outlives every report (ingest skips endpointId for manual and none)',
    /const personal = !!held && \(held\.linkSource === 'none' \|\| \(held\.linkSource === 'manual' && !!held\.endpointId\)\);/.test(ingest) && /\.\.\.\(personal \? \{\} : \{ endpointId/.test(ingest), 'backup-ingest.service.ts');
  check('contract v1: a drill must name its recovery point; re-sending never moves a fact backwards',
    /recoveryPointExternalId: z\.string\(\)\.regex\(EXTERNAL_ID\),/.test(model) && /export function mergeJob/.test(model) && /export function drillRegresses/.test(model)
      && /mergeJob\(storedJobs\.get/.test(ingest) && /if \(drillRegresses\(/.test(ingest), 'model.ts / ingest');
  const order = read('apps/web/scripts/gen-docs-bundle.mjs');
  check('contract: docs/st0r-push-contract.md and its generated JSON Schema exist, the page is in the docs bundle, and CI checks both',
    existsSync(join(ROOT, 'docs/st0r-push-contract.md')) && existsSync(join(ROOT, 'docs/st0r-push-contract.schema.json')) && /\['st0r-push-contract\.md',/.test(order)
      && /unit-backup-setup\.mjs/.test(read('.github/workflows/ci.yml')), 'docs / ci.yml');
  const m99 = read('apps/api/prisma/migrations/0099_backup_setup/migration.sql');
  check('0099: the link source is CHECKed, "none" links nothing, and a computer that moves business drops a person\'s link',
    /"linkSource" IN \('auto', 'manual', 'none'\)/.test(m99) && /"linkSource" <> 'none' OR "endpointId" IS NULL/.test(m99)
      && /SET "endpointId" = NULL, "linkSource" = 'auto'/.test(m99) && /"lastError" ~ '\^\[\\x20-\\x7e\]\+\$'/.test(m99), '0099');

  const eng = src(`${SRC}/monitoring/engine.ts`);
  const rec = (eng.match(/export const RECOMMENDED[\s\S]*?\n\];/) ?? [''])[0];
  check('monitor kinds: BACKUP_STALE, BACKUP_FAILED, DRILL_FAILED and RPO_EXCEEDED, opt-in — none in RECOMMENDED',
    /export const BACKUP_KINDS: ReadonlySet<MonitorKind> = new Set\(\['BACKUP_STALE', 'BACKUP_FAILED', 'DRILL_FAILED', 'RPO_EXCEEDED'\]\);/.test(eng) && rec && !/BACKUP_|DRILL_FAILED|RPO_EXCEEDED/.test(rec), 'engine.ts');
  const mon = src(`${SRC}/monitoring/monitoring.service.ts`);
  const ev = (mon.match(/private async evaluateBackupRules[\s\S]*?\n  \}\n/) ?? [''])[0];
  check('monitor kinds: evaluated by the sweep from stored rows only — the backup tables are read, never written, by monitoring',
    !!ev && /this\.prisma\.backupProtectedAsset\.findMany/.test(ev) && !/backup\w*\.(create|update|upsert|delete)/i.test(mon) && /evaluateBackupRules\(backupWork, open, now\)/.test(mon), 'monitoring.service.ts');
  const tpl = src(`${SRC}/monitoring/backup-agent-templates.ts`);
  const kinds = [...tpl.matchAll(/kind: '([A-Z_]+)'/g)].map((m) => m[1]);
  check('templates: SERVICE_STOPPED only, alertIfMissing false, each citing a vendor source',
    kinds.length >= 1 && kinds.every((k) => k === 'SERVICE_STOPPED') && (tpl.match(/alertIfMissing: false/g) ?? []).length === kinds.length && (tpl.match(/source: 'https:\/\//g) ?? []).length === (tpl.match(/^\s{4}id: '/gm) ?? []).length, 'backup-agent-templates.ts');
  const adm = src(`${SRC}/monitoring/monitoring-admin.service.ts`);
  const addT = (adm.match(/async addTemplate[\s\S]*?\n  \}/) ?? [''])[0];
  check('templates: added only on request, each rule through createRule', /this\.createRule\(a, /.test(addT) && !/monitorRule\.(create|upsert)/.test(addT), 'addTemplate');

  const sync = src(`${B}/backup-sync.service.ts`);
  check('BACKUP_SYNC_SWEEP=off is exact, and the pull skips a business under an integration pause',
    /if \(process\.env\.BACKUP_SYNC_SWEEP === 'off'\) return;/.test(sync) && /activePause\(this\.prisma, 'integration', c\.customerId\)/.test(sync) && /^export BACKUP_SYNC_SWEEP=off$/m.test(read('scripts/run-e2e.sh')), 'backup-sync.service.ts / run-e2e.sh');
}

// ── §92 (0.83 Beacon): Settings → Mobile devices — the own MDM's setup ──────
//     docs/own-mdm.md M1. The wizard prepares Apple's and Google's credentials
//     and calls neither. What must stay true:
//       - the four secrets are sealed under their own purposes, each used only
//         in mdm-setup.service.ts, and none reaches a view, audit meta or log;
//       - the private keys are never returned; the CSR only by its download;
//       - no Apple or Google host, and no HTTP client, in mdm/setup/;
//       - the certificate work (pki.ts) and the decisions (setup-model.ts)
//         are pure, tested in CI, and 0100's CHECKs are their lists;
//       - Platform Admin (class guard); every write but a delete asserts
//         fresh authentication naming mdm.setup first; deletes never ask;
//       - credentials are audited with logOrFail before a write that is
//         conditional on the revision read; one row, never deleted;
//       - the topic is permanent except through the replace action;
//       - reminders run inside the MDM sweep, held by a notifications pause.
{
  console.log('\n§92 Mobile device setup (Apple push certificate, Google key; sealed, offline, Platform Admin)');
  const SRC = 'apps/api/src';
  const D = `${SRC}/mdm/setup`;
  const code = (x) => x.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const svc = read(`${D}/mdm-setup.service.ts`);
  const ctl = read(`${D}/mdm-setup.controller.ts`);
  const pki = read(`${D}/pki.ts`);
  const model = read(`${D}/setup-model.ts`);
  // 0.84 (§93): and the profile-signing key, the fifth.
  const PURPOSES = ['rem0te-apns-push-key-v1', 'rem0te-mdm-vendor-key-v1', 'rem0te-apns-push-cert-v1', 'rem0te-amapi-sa-key-v1', 'rem0te-mdm-profile-sign-v1'];
  const box = read(`${SRC}/common/secret-box.ts`);
  const users = walk(SRC).filter((f) => f !== `${SRC}/common/secret-box.ts` && PURPOSES.some((pp) => read(f).includes(`'${pp}'`)));
  check('sealed: five purposes in SecretPurpose, each used only in mdm/setup/mdm-setup.service.ts',
    PURPOSES.every((pp) => box.includes(`'${pp}'`) && svc.includes(`'${pp}'`)) && JSON.stringify(users) === JSON.stringify([`${D}/mdm-setup.service.ts`]), users.join(', '));
  const viewFn = code((svc.match(/async view\([\s\S]*?\n  \}\n/) ?? [''])[0]);
  // A sealed column may be named only as a presence test: !!r.xEnc, r.xEnc ? …, r.xEnc && ….
  const presence = (t) => t.replace(/!!r\.\w+Enc\b/g, '').replace(/\br\.\w+Enc (\?|&&) /g, '');
  check('sealed: the view reads a sealed column only to say whether it is there, and names no PEM, CSR or private key',
    !!viewFn && !/\w+Enc\b/.test(presence(viewFn)) && !/pushCsrPem|keyPem|privateKey|openSecret/.test(viewFn), 'view()');
  const metas = [...code(svc).matchAll(/(?:\.log|\.logOrFail)\(\{[\s\S]*?\}\);/g)].map((m) => m[0]);
  check('sealed: no audit row carries a key, a certificate body, a sealed value or a CSR',
    metas.length >= 11 && metas.every((m) => !/sealed\b|keyPem|\.pem\b|csrPem|pushCsrPem|privateKey|certificate:|sealedJson|\w+Enc\b|req\.file|\.request\b/.test(presence(m))), `${metas.length} audit calls`);
  check('sealed: mdm/setup logs nothing but one fixed warning (the reminder pass\'s error name)',
    (code(svc).match(/this\.logger\.\w+\(/g) ?? []).length === 1 && /this\.logger\.warn\(`push certificate reminder: \$\{\(e as Error\)\.name\}`\)/.test(svc)
      && !/logger|console\./.test(code(pki) + code(model) + code(ctl)), 'mdm-setup.service.ts');
  // 0.84: the two in-memory openers (openPushIdentity, openProfileSigner) return keys by design; §93 holds their callers.
  const OPENERS = /async (openPushIdentity|openProfileSigner)\([\s\S]*?\n  \}\n/g;
  const returns = [...code(svc).replace(OPENERS, '').matchAll(/return \{[^;]*\};/g)].map((m) => m[0]);
  check('keys never returned: no return names a private key or a sealed value; the CSR only from pushCsr(), the signed request only from signPushRequest()',
    returns.every((x) => !/keyPem|privateKey|\w+Enc\b|sealed\b/.test(presence(x))) && /return \{ filename: 'rem0te-push\.csr', csr: r\.pushCsrPem/.test(svc)
      && (code(svc).match(/csr: r\.pushCsrPem/g) ?? []).length === 1 && (code(svc).match(/request: req\.file/g) ?? []).length === 1, 'returns');
  const files = walk(D);
  const DTD_LINE = `'<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">'`;
  const HOSTS = /apple\.com|icloud\.com|googleapis\.com|google\.com|gstatic\.com|mdmcert\.download/i;
  const net = files.filter((f) => HOSTS.test(code(read(f)).split(DTD_LINE).join(''))
    || /from '(node:)?(https?|http2|net|tls|dgram)'|\bfetch\(|axios|undici|safe-https|safeGet|safePost/.test(read(f)));
  check('offline: no Apple or Google host and no HTTP client anywhere in mdm/setup/ (the plist DTD identifier excepted)', net.length === 0 && files.length === 4, net.join(', ') || files.join(', '));
  const imp = (t) => [...t.matchAll(/^import [^;]*? from '([^']+)';/gm)].map((m) => m[1]);
  check('pure: pki.ts imports only node:crypto; setup-model.ts imports nothing; neither reads a clock',
    JSON.stringify(imp(pki)) === JSON.stringify(['node:crypto']) && imp(model).length === 0 && !/Date\.now\(\)|new Date\(\)/.test(code(pki) + code(model)), JSON.stringify(imp(pki)));
  check('pure: tested in CI (unit-mdm-setup.mjs), with stand-in certificates made at run time; no key or certificate file committed under apps/api/scripts',
    /unit-mdm-setup\.mjs/.test(read('.github/workflows/ci.yml')) && /TEST ONLY/.test(read('apps/api/scripts/lib/test-pki.mjs'))
      && !readdirSync(join(ROOT, 'apps/api/scripts')).some((f) => /\.(pem|cer|crt|p12|key|der)$/.test(f)), 'ci.yml / scripts');
  const writeRoutes = [...ctl.matchAll(/@(Put|Post)\([^)]*\)[^{]*?\{\n\s*(.*)\n/g)].map((m) => m[2].trim());
  const deleteBodies = [...ctl.matchAll(/@Delete\([^)]*\)[\s\S]*?\{([^}]*)\}/g)].map((m) => m[1]);
  // 0.84: step 6 adds two writes (the device CA, the profile signer) and their two deletes.
  check('controller: Platform Admin by class guard; no @Public; all ten writes call this.fresh() first; the six deletes never ask',
    /@Controller\('mdm\/setup'\)\s*\n@UseGuards\(PlatformAdminGuard\)/.test(ctl) && !/@Public\(\)/.test(ctl)
      && writeRoutes.length === 10 && writeRoutes.every((l) => /^this\.fresh\(req, /.test(l))
      && deleteBodies.length === 6 && deleteBodies.every((b) => !/fresh/.test(b)) && /action: 'mdm\.setup'/.test(ctl), JSON.stringify(writeRoutes));
  const cat = read(`${SRC}/security-controls/confirm-catalog.ts`);
  check('confirm: mdm.setup is a catalog key, default off like the others', /\{ key: 'mdm\.setup', group: 'Integrations', label: '[^']+', default: 'off',/.test(cat), 'confirm-catalog.ts');
  const writers = walk(SRC).filter((f) => /mdmPlatformSetup\.(create|createMany|update|updateMany|upsert|delete|deleteMany)\(/.test(read(f)));
  check('writes: only MdmSetupService writes MdmPlatformSetup, never creates or deletes it; a person\'s write is conditional on the revision read',
    JSON.stringify(writers) === JSON.stringify([`${D}/mdm-setup.service.ts`]) && !/mdmPlatformSetup\.(create|upsert|delete)/.test(svc)
      && /where: \{ id: ID, revision: r\.revision \}/.test(svc) && (svc.match(/mdmPlatformSetup\.updateMany\(/g) ?? []).length === 2, writers.join(', '));
  const credFns = ['generatePushKey', 'setVendor', 'installPushCert', 'setAndroidKey', 'deletePushKey', 'deleteVendor', 'deletePushCert', 'deleteAndroidKey', 'signPushRequest',
    'setDeviceCa', 'deleteDeviceCa', 'setProfileSigner', 'deleteProfileSigner'];
  const bad = credFns.filter((fn) => { const b = (svc.match(new RegExp(`async ${fn}\\([\\s\\S]*?\\n  \\}\\n`)) ?? [''])[0]; return !b || !/this\.audit\.logOrFail\(/.test(b) || (b.includes('this.write(') && b.indexOf('logOrFail') > b.indexOf('this.write(')); });
  check('audit: every credential change (and the signing) is logOrFail before its write', bad.length === 0, bad.join(', '));
  const inst = (svc.match(/async installPushCert[\s\S]*?\n  \}\n/) ?? [''])[0];
  check('topic: checked against the sealed key, then the topic rule (a different topic only through replace), before the audit and the write; no new key under a certificate',
    /checkPushCertificate\(d\.certificate, key\.key, now\)/.test(inst) && /topicDecision\(r\.apnsTopic, c\.topic, replace \?/.test(inst)
      && inst.indexOf('topicDecision(') < inst.indexOf('logOrFail') && /currentTopic: z\.string\(\)\.max\(80\), acknowledgeReenroll: z\.literal\(true\)/.test(inst)
      && /if \(r\.pushCertEnc\) throw new ConflictException\(\{ code: 'APNS_CERT_INSTALLED'/.test(svc), 'installPushCert');
  const rem = (svc.match(/async reminderPass[\s\S]*?\n  \}\n/) ?? [''])[0];
  check('reminders: only from the MDM sweep, held by a global notifications pause, claimed by a conditional write before the alert; 30, 14 and 3 days',
    /await this\.setup\.reminderPass\(now\);/.test(read(`${SRC}/mdm/mdm-sync.service.ts`)) && walk(SRC).filter((f) => /\.reminderPass\(/.test(read(f))).length === 1
      && /activePause\(this\.prisma, 'notifications', null\)/.test(rem) && rem.indexOf("'notifications'") < rem.indexOf('updateMany') && rem.indexOf('updateMany') < rem.indexOf('alerts.raise')
      && /export const REMINDER_DAYS = \[30, 14, 3\] as const;/.test(model), 'reminderPass');
  const sql = read('apps/api/prisma/migrations/0100_mdm_setup/migration.sql');
  const list = (name) => { const mm = model.match(new RegExp(`export const ${name} = \\[([^\\]]*)\\] as const;`)); return mm ? [...mm[1].matchAll(/'([^']+)'/g)].map((x) => x[1]) : null; };
  const arr = (col) => [...((sql.match(new RegExp(`"${col}" <@ ARRAY\\[([^\\]]*)\\]`)) ?? [])[1] ?? '').matchAll(/'([^']+)'/g)].map((m) => m[1]);
  const sealedCols = ['pushKeyEnc', 'vendorKeyEnc', 'pushCertEnc', 'androidKeyEnc'];
  check('0100: one row, never deleted; the checklists, routes and reminders are the model\'s; sealed columns are sealed-shaped; a certificate needs its key and topic',
    /CHECK \("id" = 'platform'\)/.test(sql) && /BEFORE DELETE ON "MdmPlatformSetup"/.test(sql)
      && JSON.stringify(arr('appleChecklist')) === JSON.stringify(list('APPLE_CHECKLIST')) && JSON.stringify(arr('androidChecklist')) === JSON.stringify(list('ANDROID_CHECKLIST'))
      && /"signingRoute" IN \('own_vendor', 'mdmcert', 'other_vendor'\)/.test(sql) && JSON.stringify(list('SIGNING_ROUTES')) === '["own_vendor","mdmcert","other_vendor"]'
      && /"pushRemindedDays" IN \(30, 14, 3, 0\)/.test(sql) && sealedCols.every((c) => sql.includes(`"${c}" IS NULL OR "${c}" ~ '^[0-9a-f]{24}:[0-9a-f]{32}:[0-9a-f]+$'`))
      && /"pushCertEnc" IS NULL OR \("pushKeyEnc" IS NOT NULL AND "apnsTopic" IS NOT NULL\)/.test(sql), '0100');
  check('suites: e2e-mdm-setup in run-e2e.sh; the wizard in e2e-ui.mjs; the Mobile devices page links to it',
    /\bmdm-setup\b/.test((read('scripts/run-e2e.sh').match(/for t in credentials[^\n]*/) ?? [''])[0]) && /async function mdmSettingsUi\(/.test(read('apps/web/scripts/e2e-ui.mjs'))
      && /href="\/settings\/mobile-devices"/.test(read('apps/web/app/(app)/mobile-devices/page.tsx')), 'run-e2e.sh / e2e-ui.mjs');
}

// ── §93 (0.84 Harbor): Rem0te's own Apple MDM server — enrollment, check-in, inventory ──
//     docs/own-mdm.md M2, from its "Invariant sketch". Nothing has run on a
//     real iPhone or iPad, and no real APNs call has been made: the proof is
//     mdmb, step-ca on loopback and an HTTP/2 stub. What must stay true:
//       - Apple's push host only as APNS_ORIGIN in apns.ts (§90 amended);
//         apns.ts the only caller of safe-h2, safe-h2 the only module that
//         presents a client certificate; the push body exactly {"mdm": magic};
//       - the push key and the profile signer are opened in memory by one
//         caller each; the device CA's key is never the portal's;
//       - the request types and states are closed lists, the same in
//         protocol.ts and 0101; AccessRights one constant (erase granted, never sendable); no
//         lost-device or destructive request type;
//       - Mdm-Signature is verified before any parse; a refusal has no body;
//       - links: Platform Admin, assertFresh naming mdm.enroll, a 256-bit
//         token stored as SHA-256, claimed and consumed conditionally;
//       - no PKCS#12 identity anywhere; a SCEP identity only under NODE_ENV=test;
//       - one writer per Apple table; MobileDevice still only the sync's;
//         nothing about a device kept that 0096 forbids, and no UnlockToken;
//       - no new sweep: everything runs inside MDM_SWEEP.
{
  console.log('\n§93 Own Apple MDM (signed check-ins, inventory only, one push site; nothing real yet)');
  const SRC = 'apps/api/src';
  const D = `${SRC}/mdm/apple`;
  const code = (x) => x.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const all = walk(SRC);
  const apns = read(`${D}/apns.ts`), h2 = read(`${SRC}/common/safe-h2.ts`), proto = read(`${D}/protocol.ts`), prof = read(`${D}/profile.ts`);
  const mdm = read(`${D}/apple-mdm.service.ts`), enr = read(`${D}/apple-enrollment.service.ts`), ctl = read(`${D}/apple.controller.ts`);
  const mw = read(`${D}/apple-raw-body.middleware.ts`), mod = read(`${SRC}/mdm/mdm.module.ts`), sync = read(`${SRC}/mdm/mdm-sync.service.ts`);
  const setup = read(`${SRC}/mdm/setup/mdm-setup.service.ts`);
  const sql = read('apps/api/prisma/migrations/0101_mdm_apple/migration.sql');

  // 1–2. Hosts and the one push site.
  const appleHost = all.filter((f) => /api\.push\.apple\.com|api\.sandbox\.push\.apple\.com/.test(read(f)));
  check('hosts: api.push.apple.com appears only in mdm/apple/apns.ts, once, as APNS_ORIGIN; the sandbox host nowhere',
    JSON.stringify(appleHost) === JSON.stringify([`${D}/apns.ts`]) && (apns.match(/api\.push\.apple\.com/g) ?? []).length === 1
      && /export const APNS_ORIGIN = 'https:\/\/api\.push\.apple\.com';/.test(apns), appleHost.join(', '));
  const h2Users = all.filter((f) => f !== `${SRC}/common/safe-h2.ts` && /common\/safe-h2'/.test(read(f)));
  const clientCert = all.filter((f) => /\b(tls|http2)\.connect\(/.test(code(read(f))) && /\bcert: /.test(code(read(f))));
  const openers = all.filter((f) => /\bopenSafeH2\(/.test(code(read(f))) && f !== `${SRC}/common/safe-h2.ts`);
  check('one push site: apns.ts is the only importer and caller of safe-h2; safe-h2 the only module that presents a client certificate',
    JSON.stringify(h2Users) === JSON.stringify([`${D}/apns.ts`]) && JSON.stringify(openers) === JSON.stringify([`${D}/apns.ts`])
      && JSON.stringify(clientCert) === JSON.stringify([`${SRC}/common/safe-h2.ts`]), JSON.stringify({ h2Users, openers, clientCert }));
  check('one push site: the body is exactly {"mdm": PushMagic}, POST /3/device/<token>, apns-push-type mdm and the push topic; TLS 1.2+, verified, h2 only',
    /export const pushBody = \(pushMagic: string\) => JSON\.stringify\(\{ mdm: pushMagic \}\);/.test(apns)
      && /this\.h2\.request\('POST', `\/3\/device\/\$\{token\}`, \{\s*'apns-topic': this\.topic, 'apns-push-type': 'mdm', 'apns-priority': '10', 'content-type': 'application\/json',\s*\}, Buffer\.from\(pushBody\(pushMagic\), 'utf8'\)\);/.test(apns)
      && (code(apns).match(/this\.h2\.request\(/g) ?? []).length === 1
      && /rejectUnauthorized: true, minVersion: 'TLSv1\.2', ALPNProtocols: \['h2'\]/.test(h2) && /const r = checkResolved\(addrs, 'none'\);/.test(h2)
      && /REDIRECT_REFUSED/.test(h2), 'apns.ts / safe-h2.ts');
  check('one push site: the loopback stub only under NODE_ENV=test — APNS_TEST_BASE_URL read only in apns.ts, through testLoopbackH2Allowed',
    JSON.stringify(all.filter((f) => /APNS_TEST_BASE_URL|APNS_TEST_CA_FILE/.test(code(read(f))))) === JSON.stringify([`${D}/apns.ts`])
      && /if \(test && testLoopbackH2Allowed\(test\)\)/.test(apns) && /return process\.env\.NODE_ENV === 'test' && TEST_H2\.test\(raw\);/.test(h2)
      && /const TEST_H2 = \/\^https:\\\/\\\/127\\\.0\\\.0\\\.1:\[0-9\]\{2,5\}\$\/;/.test(h2), 'apns.ts / safe-h2.ts');

  // 3. Sealed material opened in memory by one caller each.
  const callers = (fn) => all.filter((f) => new RegExp(`\\.${fn}\\(`).test(code(read(f))));
  check('sealed: the push identity is opened only by AppleMdmService.pushPass, the profile signer only by AppleEnrollmentService.claim; nothing they return is stored or logged',
    JSON.stringify(callers('openPushIdentity')) === JSON.stringify([`${D}/apple-mdm.service.ts`]) && JSON.stringify(callers('openProfileSigner')) === JSON.stringify([`${D}/apple-enrollment.service.ts`])
      && /const identity = await this\.setup\.openPushIdentity\(now\);\s*\n\s*if \(!identity\) return 0;/.test(mdm) && /try \{ client = await ApnsClient\.open\(identity\); \}/.test(mdm)
      && /const signer = await this\.setup\.openProfileSigner\(\);/.test(enr) && /signProfile\(plist, signer, now\)/.test(enr)
      && !/this\.logger\.\w+\([^)]*(identity|signer|key)/.test(code(mdm) + code(enr)),
    'openers');
  check('sealed: the profile-signing key is sealed before anything is written, and logOrFail precedes the write',
    /const sealed = sealSecret\(this\.encKey, 'rem0te-mdm-profile-sign-v1', s\.keyPem\);/.test(setup)
      && (() => { const b = (setup.match(/async setProfileSigner[\s\S]*?\n  \}\n/) ?? [''])[0]; return b.indexOf('sealSecret') < b.indexOf('logOrFail') && b.indexOf('logOrFail') < b.indexOf('this.write('); })(), 'setProfileSigner');

  // 4. The CA is not the portal's.
  const caNames = all.filter((f) => /rem0te-mdm-ca\b(?!-setup)|\/etc\/rem0te-mdm-ca|\/var\/lib\/rem0te-mdm-ca|intermediate_ca_key|root_ca_key|step-ca\b/.test(code(read(f)).replace("'Device identity CA (step-ca)'", '')));
  const spawns = walk(`${SRC}/mdm`).filter((f) => /child_process|\bspawn\(|\bexecFile/.test(read(f)));
  check('the CA is not the portal\'s: no code in apps/api/src names its directories, its keys or step-ca, and nothing in mdm/ spawns a process; the portal never calls the CA',
    caNames.length === 0 && spawns.length === 0 && !/acme\/rem0te-mdm\/(new-|order|authz|finalize)/.test(code(enr)), [...caNames, ...spawns].join(', '));
  const caSh = read('deploy/mdm-ca/rem0te-mdm-ca-setup.sh');
  check('the CA\'s install script: a pinned step-ca SHA-256, its own user, loopback only, ACME device-attest-01 with Apple attestation, SCEP refused without --prefix, keys never overwritten',
    /^STEP_CA_SHA256=[0-9a-f]{64}$/m.test(caSh) && /sha_ok "\$tmp\/\$STEP_CA_TARBALL" "\$STEP_CA_SHA256" \|\| die/.test(caSh) && /USER_NAME=rem0te-mdm-ca/.test(caSh)
      && /"address": "127\.0\.0\.1:\$\{port\}"/.test(caSh) && /"challenges": \["device-attest-01"\], "attestationFormats": \["apple"\]/.test(caSh)
      && /\[\[ -n \$prefix \]\] \|\| die "the SCEP provisioner is for the test suite only/.test(caSh) && /holds some keys but not all: refusing to guess/.test(caSh)
      && /if \[\[ \$have -eq 0 \]\]; then/.test(caSh), 'rem0te-mdm-ca-setup.sh');
  const caddy = read('deploy/caddy/Caddyfile');
  const acmeRoutes = caddy.match(/^\s*#?\s*handle \/acme[^\n]*/gm) ?? [];
  check('Caddy: exactly one step-ca route, /acme/rem0te-mdm/*, to https://127.0.0.1:9451 with the original Host (0.84.1) verified against the device CA root; nothing else of step-ca',
    acmeRoutes.length === 1 && /#?handle \/acme\/rem0te-mdm\/\* \{/.test(acmeRoutes[0]) && /reverse_proxy https:\/\/127\.0\.0\.1:9451 \{/.test(caddy)
      && /tls_trust_pool file \/etc\/caddy\/rem0te-mdm-ca-root\.crt/.test(caddy) && /reverse_proxy https:\/\/127\.0\.0\.1:9451 \{\s*(#[^\n]*\s*)*#?\s*header_up Host \{host\}/.test(caddy) && !/9451[\s\S]*9451/.test(caddy.replace(/reverse_proxy https:\/\/127\.0\.0\.1:9451/, '')),
    acmeRoutes.join(' | '));

  // 5. Closed commands.
  const tsList = (name) => { const mm = proto.match(new RegExp(`export const ${name} = \\[([^\\]]*)\\] as const;`)); return mm ? [...mm[1].matchAll(/'([^']+)'/g)].map((x) => x[1]) : null; };
  const sqlList = (c, col) => { const mm = sql.match(new RegExp(`CONSTRAINT "${c}" CHECK \\("${col}" IN \\(([^)]*)\\)`)); return mm ? [...mm[1].matchAll(/'([^']+)'/g)].map((x) => x[1]) : null; };
  const lp = [['REQUEST_TYPES', 'AppleCommand_requestType_check', 'requestType'], ['APPLE_COMMAND_STATES', 'AppleCommand_state_check', 'state'],
    ['APPLE_DEVICE_STATES', 'AppleDevice_state_check', 'state'], ['LINK_STATES', 'AppleEnrollmentLink_state_check', 'state']];
  const lbad = lp.filter(([a, c, col]) => { const x = tsList(a), y = sqlList(c, col); return !x || !y || JSON.stringify(x) !== JSON.stringify(y); });
  check('closed: the request types and the command, device and link states are 0101\'s CHECKs, word for word and in order', lbad.length === 0, lbad.map((b) => b[1]).join(', '));
  check('closed: the request types are the five inventory commands, in order; no lost-device or destructive type exists anywhere in mdm/apple',
    JSON.stringify(tsList('REQUEST_TYPES')) === JSON.stringify(['DeviceInformation', 'SecurityInfo', 'InstalledApplicationList', 'ProfileList', 'CertificateList'])
      && !walk(D).some((f) => /EraseDevice|DeviceLock|EnableLostMode|DisableLostMode|ClearPasscode|RemoveProfile|InstallProfile|InstallApplication|RestartDevice|ShutDownDevice|DeviceConfigured|Settings'/.test(code(read(f)))),
    JSON.stringify(tsList('REQUEST_TYPES')));
  // Decision 25 (2026-11-23): erase (8) is granted at enrollment so M5 needs no re-enrollment; it stays unsendable (the check above).
  check('closed: AccessRights is one constant, 1+4+8+16+256+1024 (erase granted, no profile or app install), named only by the profile',
    /export const ACCESS_RIGHTS = 1 \+ 4 \+ 8 \+ 16 \+ 256 \+ 1024;/.test(proto) && JSON.stringify(all.filter((f) => /\bACCESS_RIGHTS\b/.test(code(read(f)))).sort()) === JSON.stringify([`${D}/profile.ts`, `${D}/protocol.ts`])
      && /AccessRights: ACCESS_RIGHTS,/.test(prof), 'protocol.ts / profile.ts');
  check('closed: every command body is built from its type alone (commandFor); the queue creates only REQUEST_TYPES',
    /export function commandFor\(type: RequestType\): PlistDict \{\s*switch \(type\) \{/.test(proto) && /data: REQUEST_TYPES\.map\(\(t: RequestType\) => \(\{/.test(mdm)
      && (code(mdm).match(/appleCommand\.(create|createMany)\(/g) ?? []).length === 1, 'protocol.ts / apple-mdm.service.ts');

  // 6. Device messages verified first.
  const fn = (src, name) => (src.match(new RegExp(`async ${name}\\([\\s\\S]*?\\n  \\}\\n`)) ?? [''])[0];
  const ci = fn(mdm, 'checkin'), sv = fn(mdm, 'server'), vf = (mdm.match(/private async verified\([\s\S]*?\n  \}\n/) ?? [''])[0];
  check('verified first: checkin and server call verified() first and refuse (401, no body) before parsing; verified() checks the CMS before anything reads the body',
    [ci, sv].every((b) => /const signer = await this\.verified\(raw, signature, now\);\s*\n\s*if \(!signer\) return refuse\(\);\s*\n\s*const d = this\.parse\(raw as Buffer\);/.test(b))
      && /const v = verifyDetachedCms\(Buffer\.from\(compact, 'base64'\), raw, trust, now\);/.test(vf) && !/parsePlist|readCheckin|readReport/.test(vf)
      && /const refuse = \(status = 401\): DeviceAnswer => \(\{ status, body: null \}\);/.test(mdm)
      && /if \(!a\.body\) \{ res\.status\(a\.status\)\.end\(\); return; \}/.test(ctl), 'apple-mdm.service.ts');
  check('verified first: the signer is the enrolled certificate — every message after Authenticate is matched by UDID AND certificate SHA-256',
    /findFirst\(\{ where: \{ udid: m\.udid, certSha256: signer\.sha256, state: \{ not: 'checked_out' \} \} \}\)/.test(ci)
      && /findFirst\(\{ where: \{ udid: r\.udid, certSha256: signer\.sha256, state: 'enrolled' \} \}\)/.test(sv)
      && /certSha256: signer\.sha256/.test(ci) && /if \(!ready\.ready \|\| m\.topic !== ready\.topic\) return refuse\(\);/.test(ci), 'checkin / server');
  check('verified first: device routes are @Public with a rate limit; the raw body is bounded (64 KB check-in, 2 MB server) and applied only to AppleDeviceController',
    (ctl.match(/@Public\(\)\s*\n\s*@(Put|Get)\('(checkin|server|enroll\/:token)'\)\s*\n\s*@RateLimit\(\d+\)/g) ?? []).length === 3
      && /@Controller\('mdm\/apple'\)\s*\n@UseGuards\(PlatformAdminGuard\)\s*\nexport class AppleAdminController/.test(ctl)
      && /export const CHECKIN_MAX_BYTES = 64 \* 1024;/.test(mw) && /export const SERVER_MAX_BYTES = 2 \* 1024 \* 1024;/.test(mw)
      && /consumer\.apply\(AppleRawBodyMiddleware\)\.forRoutes\(AppleDeviceController\);/.test(mod) && (code(ctl).match(/@Public\(\)/g) ?? []).length === 3,
    'apple.controller.ts / middleware');
  check('verified first: Authenticate needs iOS/iPadOS 16 or later, and consumes a claimed link inside its transaction',
    /if \(!platform \|\| !Number\.isInteger\(major\) \|\| major < MIN_OS_MAJOR\) return refuse\(403\);/.test(ci) && /export const MIN_OS_MAJOR = 16;/.test(mdm)
      && /const link = await this\.enrollment\.consume\(tx, enroll, now\);\s*\n\s*if \(!link\) return null;/.test(ci), 'checkin');

  // Links.
  const lw = all.filter((f) => /appleEnrollmentLink\.(create|createMany|update|updateMany|upsert|delete|deleteMany)\(/.test(read(f)));
  check('links: a Platform Admin\'s, assertFresh naming mdm.enroll before the service; revoking never asks',
    /assertFresh\([^;]*\{ action: 'mdm\.enroll', message: [^}]*\}\);\s*\n\s*return \{ success: true, data: await this\.enrollment\.create\(a, body\) \};/.test(ctl)
      && !/fresh|assertFresh/.test((ctl.match(/async revoke\([^{]*\{[^}]*\}/) ?? [''])[0])
      && /\{ key: 'mdm\.enroll', group: 'Integrations', label: '[^']+', default: 'off',/.test(read(`${SRC}/security-controls/confirm-catalog.ts`)), 'apple.controller.ts');
  check('links: 32 random bytes shown once, only the SHA-256 stored; the claim and the consume are single conditional updates; only AppleEnrollmentService writes them',
    JSON.stringify(lw) === JSON.stringify([`${D}/apple-enrollment.service.ts`]) && /const token = randomBytes\(32\)\.toString\('base64url'\);/.test(enr)
      && /tokenSha256: tokenHash\(token\)/.test(enr) && !/\btoken\b[^\n]*(create|data):/.test(code(enr).replace(/tokenSha256: tokenHash\(token\)/, ''))
      && /updateMany\(\{ where: \{ tokenSha256: hash, state: 'open', expiresAt: \{ gt: now \} \}, data: \{ state: 'claimed', claimedAt: now \} \}\);\s*\n\s*if \(claimed\.count !== 1\) return null;/.test(enr)
      && /where: \{ id: linkId, state: 'claimed', claimedAt: \{ gt: new Date\(now\.getTime\(\) - AUTHENTICATE_WINDOW_MS\) \} \},\s*\n\s*data: \{ state: 'used', usedAt: now \},/.test(enr)
      && /"expiresAt" <= "createdAt" \+ interval '24 hours'/.test(sql) && /CREATE TRIGGER "AppleEnrollmentLink_final_trg"/.test(sql), lw.join(', '));

  // 9. No key in a profile.
  check('profile: no PKCS#12 payload anywhere; a SCEP identity only through scepTestIdentity, which refuses outside NODE_ENV=test and off 127.0.0.1; production is ACME, hardware-bound and attested',
    !all.some((f) => /com\.apple\.security\.pkcs12/.test(read(f))) && /if \(process\.env\.NODE_ENV !== 'test'\) throw new Error/.test(prof)
      && /export function scepTestIdentity\(url: string, challenge: string\): Identity \{\s*\n\s*if \(process\.env\.NODE_ENV !== 'test'\)/.test(prof)
      && JSON.stringify(all.filter((f) => /MDM_TEST_SCEP_URL/.test(code(read(f))))) === JSON.stringify([`${D}/apple-enrollment.service.ts`])
      && /if \(process\.env\.NODE_ENV === 'test' && process\.env\.MDM_TEST_SCEP_URL\) \{/.test(enr)
      && /HardwareBound: true, Attest: true,/.test(prof) && /SignMessage: true,/.test(prof) && /UseDevelopmentAPNS: false,/.test(prof), 'profile.ts');

  // 10. Writers and what is kept.
  const dw = all.filter((f) => /\.(appleDevice|appleCommand)\.(create|createMany|update|updateMany|upsert|delete|deleteMany)\(/.test(read(f)));
  check('writers: only AppleMdmService writes AppleDevice and AppleCommand; the Apple code writes no MobileDevice, MdmCommand or connector',
    JSON.stringify(dw) === JSON.stringify([`${D}/apple-mdm.service.ts`]) && !walk(D).some((f) => /\.(mobileDevice|mdmCommand|mdmConnector)\.(create|update|upsert|delete)/.test(read(f))), dw.join(', '));
  const devTable = (sql.match(/CREATE TABLE "AppleDevice" \(([\s\S]*?)\n\);/) ?? ['', ''])[1];
  check('kept: no IMEI, MEID, phone number, MAC, user or UnlockToken column; the check-in never reads them; a link is corporate only',
    devTable.length > 500 && !/imei|meid|phone|mac\b|wifi|bluetooth|"user|email|unlock/i.test(devTable)
      && !/UnlockToken|IMEI|MEID|PhoneNumber|WiFiMAC|BluetoothMAC|UserID|UserShortName/.test(code(proto).replace("if (d.EnrollmentID !== undefined || d.UserID !== undefined) return { type: 'invalid', why: 'user_channel' };", '')) && /CHECK \("ownership" IN \('corporate'\)\)/.test(sql), 'protocol.ts / 0101');
  // Decision 28: SHA-1 accepted for now; every device's digest is recorded, from verified() only, against a closed list.
  const dgSql = (sql.match(/CONSTRAINT "AppleDevice_signatureDigest_check" CHECK \("signatureDigest" IN \(([^)]*)\)\)/) ?? ['', ''])[1];
  check('digest: every verified message records its digest (signer.digest, from verifyDetachedCms); SIGNATURE_DIGESTS is 0101\'s CHECK',
    JSON.stringify([...dgSql.matchAll(/'([^']+)'/g)].map((x) => x[1])) === JSON.stringify(tsList('SIGNATURE_DIGESTS'))
      && /digest: v\.digest \};/.test(vf) && (code(mdm).match(/signatureDigest: signer\.digest/g) ?? []).length === 4, 'apple-mdm.service.ts / 0101');
  check('kept: no push token or magic in an audit row, a log line or the admin view',
    ![...code(mdm).matchAll(/this\.audit\.log(?:OrFail)?\(\{[\s\S]*?\}\);/g)].some((m) => /pushToken|pushMagic|PushMagic/.test(m[0]))
      && !/this\.logger\.\w+\([^)]*push(Token|Magic)/.test(code(mdm)) && !/pushToken|pushMagic/.test((mdm.match(/async adminList[\s\S]*?\n  \}\n/) ?? [''])[0]), 'apple-mdm.service.ts');

  // 8, 12. Containment and the sweep.
  check('sweep: no new timer — AppleMdmService.pass runs only from MdmSyncService.sweep, so MDM_SWEEP=off stops pushes, re-queues and expiry',
    JSON.stringify(all.filter((f) => /this\.apple\.pass\(/.test(code(read(f))))) === JSON.stringify([`${SRC}/mdm/mdm-sync.service.ts`]) && /await this\.apple\.pass\(now\);/.test(sync)
      && !walk(D).some((f) => /setInterval|setTimeout\(|OnModuleInit|process\.env\.\w*SWEEP/.test(code(read(f)))), 'mdm/apple');
  check('containment: check-ins are always answered and inventory is not gated (the design\'s table); no mdm/apple code consults a pause, so no destructive kind can hide behind one',
    !walk(D).some((f) => /activePause|ContainmentService/.test(read(f))), 'mdm/apple');

  // Suites.
  check('suites: unit-mdm-apple.mjs in CI; e2e-mdm-apple in run-e2e.sh; CI builds mdmb at a pinned commit and step-ca at a pinned SHA-256',
    /unit-mdm-apple\.mjs/.test(read('.github/workflows/ci.yml')) && /\bmdm-apple\b/.test(read('scripts/run-e2e.sh'))
      && /jessepeterson\/mdmb\/cmd\/mdmb@[0-9a-f]{40}/.test(read('.github/workflows/ci.yml')) && /1726ee7b6a24c67abb8c9e96ad671623b29b3d34f6a712f7087495f31331e54b/.test(read('.github/workflows/ci.yml')),
    'ci.yml / run-e2e.sh');
}

if (failures.length > 0) {
  console.error(`\n✗ ${failures.length} security invariant(s) broken:\n`);
  for (const f of failures) console.error(`   ✗ ${f}\n`);
  process.exit(1);
}
console.log('\n✓ All security invariants hold');
