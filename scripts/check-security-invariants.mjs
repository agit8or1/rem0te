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
  const ALLOWED_IMPORT = /^(node:|crypto$|\.\/|@simplewebauthn\/server$|zod$|\.\.\/actions\/catalog$|\.\.\/actions\/patch-policy$|\.\.\/actions\/device-result$|\.\.\/actions\/script-run$|\.\.\/integration\/crypto$)/;
  const importsOf = (src) => [...src.matchAll(/(?:from|require\()\s*['"]([^'"]+)['"]/g)].map((m) => m[1]);
  const bad = [];
  // 0.32: the patch-policy evaluator (and the posture module it judges with)
  // run inside the signer, so they are held to the same rule; so (0.34) is
  // the device-result verifier, and the script-run rules (argument schema,
  // plan block, allowlist proposal).
  for (const f of [...signerFiles, 'apps/api/src/actions/catalog.ts', 'apps/api/src/integration/crypto.ts', 'apps/api/src/actions/patch-policy.ts', 'apps/api/src/patching/posture.ts', 'apps/api/src/actions/device-result.ts', 'apps/api/src/actions/script-run.ts']) {
    const own = f.startsWith(signerDir) ? ALLOWED_IMPORT : /^(node:|crypto$|zod$|\.\/crypto$|\.\/catalog$|\.\/device-result$|\.\/script-run$|\.\.\/actions\/catalog$|\.\.\/actions\/device-result$|\.\.\/patching\/posture$|\.\.\/integration\/crypto$)/;
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
  // 0.27 added windows.update.install (§ 15); 0.32 the four maintenance
  // actions; 0.34 windows.script.run (§ 39), then software install and
  // uninstall (§ 40). The list is exact and ordered: anything further is a
  // review.
  const CATALOG_IDS = ['windows.service.start', 'windows.update.install', 'windows.service.restart', 'windows.reboot.schedule', 'windows.reboot.cancel', 'windows.logs.collect', 'windows.script.run', 'windows.software.install', 'windows.software.uninstall'];
  check('agent catalog is exactly the Spooler start, update install, service restart, restart schedule/cancel, log collection, approved-script run and software install/uninstall',
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
    /ParamsOK:\s+softwareParamsOK,/];
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
    /const \(\s*MinRestartDelayMinutes = 5\s*MaxRestartDelayMinutes = 24 \* 60\s*\)/.test(maint) && /if len\(p\) != 1 \{\s*return 0\s*\}\s*d, ok := p\["delayMinutes"\]\.\(float64\)\s*if !ok \|\| d != math\.Trunc\(d\) \|\| d < MinRestartDelayMinutes \|\| d > MaxRestartDelayMinutes \{/.test(maint)
      && /delayMinutes: z\.number\(\)\.int\(\)\.min\(MIN_RESTART_DELAY_MINUTES\)\.max\(MAX_RESTART_DELAY_MINUTES\) \}\)\.strict\(\)/.test(tsCat) && /MIN_RESTART_DELAY_MINUTES = 5;/.test(tsCat),
    'RestartDelay and REBOOT_SCHEDULE.params must keep the 5-minute floor');
  const maintEntries = entries.filter((e) => /ID: "windows\.(service\.restart|reboot\.|logs\.)/.test(e));
  check('every maintenance action is high impact on any computer, and the RustDesk restart and the restart wait for no open session',
    maintEntries.length === 4 && maintEntries.every((e) => /Risk:\s+func\(int, int\) string \{ return "high" \},/.test(e))
      && /Precheck:\s+sessionCheck\("the restart"\),/.test(goCat) && /if RestartService\(p\.Params\) == "RustDesk" \{\s*return sessionCheck\(/.test(maint)
      && /if err != nil \{\s*return &Result\{Outcome: "not_executed", Reason: "session_state_unknown"/.test(maint),
    'maintenance risk must be "high" and "cannot tell" must count as a session');
  check('the agent\'s action package runs no process; the Windows side runs only shutdown.exe and wevtutil.exe from System32',
    !/"os\/exec"|exec\.Command/.test(maint + read('tools/windows-installer/internal/action/action.go') + goCat + read('tools/windows-installer/internal/action/software.go'))
      && [...read('tools/windows-installer/action_windows.go').matchAll(/runSystem32\([^,]+, "([^"]+)"/g)].map((m) => m[1]).every((x) => x === 'shutdown.exe' || x === 'wevtutil.exe')
      && (read('tools/windows-installer/action_windows.go').match(/exec\.Command(?:Context)?\(/g) ?? []).length === 2,
    'maintenance must not grow a way to run something else');
  // Four maintenance actions (0.32), the script run and the two software actions (0.34).
  check('the maintenance actions, the script run and the software actions are not offered to ClientSt0r', (tsCat.match(/integration: false,/g) ?? []).length === 7 && /export const SCRIPT_RUN: CatalogAction = \{[\s\S]{0,2000}?\bintegration: false,/.test(tsCat) && /proposable\(\): string\[\] \{[^}]{0,200}CATALOG\.filter\(\(a\) => a\.integration\)\.map/.test(read('apps/api/src/integration/action-proposals.service.ts'))
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
{
  const upd = read('tools/windows-installer/internal/action/updates.go');
  // 0.32 adds an optional "allow" filter (a patch policy's classes, severities
  // and excluded KBs). It can only narrow: closed keys, fixed values.
  // 0.34: reboot is one of two fixed strings (§ 37 has the restart's rules).
  check('agent update params are closed: exactly updates + reboot "never" | "if_required_in_window" (+ optional allow), each {updateId, revision}',
    /want := 2\s*if hasAllow \{\s*want = 3\s*\}\s*if len\(p\) != want \|\| UpdateReboot\(p\) == ""/.test(upd) && /!ok \|\| len\(m\) != 2/.test(upd)
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
  check('the agent installs only security, critical, rollup and ordinary updates',
    /var Installable = map\[string\]string\{[\s\S]{0,600}\}/.test(elig) && !/ebfc1fc5-71a4-4f7b-9aca-3b9a503104a0[^\n]*Installable|Installable[^}]*ebfc1fc5/.test(elig),
    'drivers (and other classifications) must not be in the allowlist');
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
  for (const f of ['apps/web/scripts/screenshots.mjs', 'apps/web/scripts/capture-media.mjs', 'apps/web/scripts/capture-video.mjs', 'apps/web/scripts/e2e-navigation.mjs', 'apps/web/scripts/e2e-search-palette.mjs']) {
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
  // 0042 (0.33) redefines the key list; the newest definition is the one in force.
  const migKeys = read('apps/api/prisma/migrations/0042_system_inventory/migration.sql');
  const dbKeys = [...(/"DiagnosticRun_key_catalog" CHECK \("key" IN \(([\s\S]*?)\)\)/.exec(migKeys)?.[1] ?? '').matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
  check('the database refuses a key outside the catalog', JSON.stringify(dbKeys) === JSON.stringify(keys), `CHECK lists: ${dbKeys.join(',')}`);
  check('a request carries a key and nothing else',
    /export class RequestDiagnosticDto \{\s*@IsString\(\)\s*@Length\(1, 64\)\s*@Matches\([^\n]*\)\s*key!: string;\s*\}/.test(read('apps/api/src/diagnostics-catalog/diagnostics-catalog.controller.ts'))
      && /out\.push\(\{ id: r\.id, key: r\.key \}\)/.test(dsvc) && !/params/.test(dsvc.slice(dsvc.indexOf('async forHeartbeat('), dsvc.indexOf('private async requesterStillAllowed('))),
    'no parameters from the console, none to the agent');
  check('stored diagnostic results are size-capped',
    /const capped = capResult\(shaped, resultCapFor\(run\.key\)\);[\s\S]{0,300}result: capped\.result/.test(repFn) && /export const MAX_RESULT_BYTES = 32_768;/.test(cat)
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
    /this\.monitoring\.alertWhere\(actor, q\.businessId\)/.test(aw) && /\{ OR: \[\{ endpointId: null \}, \{ endpoint: this\.acl\.endpointVisibilityWhere\(actor, q\.businessId\) \}\] \}/.test(aw) && /return \{ AND: and \};/.test(aw),
    'alertsWhere must call alertWhere and AND the visibility rule');
  const epQueries = [...rsvc.matchAll(/this\.prisma\.endpoint\.(findMany|groupBy|count|aggregate)\(\{[\s\S]{0,160}/g)].map((m) => m[0]);
  const alQueries = [...rsvc.matchAll(/this\.prisma\.monitorAlert\.(findMany|groupBy|count|aggregate)\(\{[\s\S]{0,160}/g)].map((m) => m[0]);
  check('reports: every endpoint query is scoped by devicesWhere and every alert query by alertsWhere',
    epQueries.length >= 4 && epQueries.every((q) => /this\.devicesWhere\(actor, /.test(q)) && alQueries.length >= 4 && alQueries.every((q) => /this\.alertsWhere\(actor, |\[base, /.test(q))
      && /const base = this\.alertsWhere\(actor, q\);/.test(rsvc),
    `endpoint queries ${epQueries.length}, alert queries ${alQueries.length}`);
  check('reports: the visibility rule is never spread into another object', !/\.\.\.\s*this\.acl\.endpointVisibilityWhere/.test(rsvc), 'spread found');
  const routes = rctl.split('@Get(').slice(1);
  check('reports: every route names its capability; every export is throttled',
    routes.length === 10 && routes.every((r) => /^\s*'[^']+'\)\s*@RequireCapability\(CAP\.(COMPUTERS_VIEW|ALERTS_VIEW)\)/.test(r)) && routes.filter((r) => /export\.csv/.test(r.slice(0, 60))).every((r) => /@RateLimit\(10\)/.test(r.slice(0, 200)))
      && routes.filter((r) => /^'(alert-frequency|offline-time)/.test(r)).every((r) => /CAP\.ALERTS_VIEW/.test(r.slice(0, 120))),
    'ten routes (0.34 added software compliance and its export), each @RequireCapability; alert reports need ALERTS_VIEW; exports @RateLimit');
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
  const ALLOWED = /^(node:crypto|zod|express|@nestjs\/common|@prisma\/client|\.\/(definition|static-checks|script-library\.(service|controller))|\.\.\/(prisma\/prisma\.service|audit\/audit\.(service|module)|rbac\/(access-control\.service|capabilities|platform-permissions)|security-controls\/review|common\/guards\/jwt-auth\.guard|common\/decorators\/actor\.decorator|common\/throttling|auth\/step-up\.service|actions\/script-run))$/;
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
    .filter((f) => /@(?:Get|Post|Put|Patch|Delete)\('[^']*scripts?\b|@Controller\(\s*\[?\s*'[^']*scripts?\b/i.test(read(f)))
    .filter((f) => !(f === RUN_CTL && /@Controller\('script-runs'\)/.test(read(f)) && JSON.stringify(runRoutes) === JSON.stringify(RUN_EXPECT)));
  check('the script library has no run route, here or anywhere else',
    /@Controller\('scripts'\)/.test(ctl) && JSON.stringify(routes) === JSON.stringify(EXPECT) && !routes.some((r) => /run|exec|dispatch|deploy|send|schedule|push|approve/i.test(r)) && elsewhere.length === 0,
    `routes: ${routes.join(', ')}${elsewhere.length ? `; other controllers with script routes: ${elsewhere.join(', ')}` : ''}`);

  const svc = code(src[`${dir}/script-library.service.ts`] ?? '');
  const rev = svc.slice(svc.indexOf('async review('));
  const iSame = rev.search(/if \(v\.authorId === actor\.userId \|\| v\.contributorIds\.includes\(actor\.userId\)\) \{\s*await refuse\('same_person'\);\s*throw new ForbiddenException\(\{ code: 'SAME_PERSON'/);
  const iHash = rev.search(/if \(d\.expectedSha256 !== v\.contentSha256\) \{/);
  const iFresh = rev.search(/if \(d\.decision === 'approve'\) assertFresh\(freshMethod\);/);
  const iWrite = rev.search(/tx\.scriptVersion\.updateMany\(\{\s*where: \{ id: v\.id, status: 'IN_REVIEW', contentSha256: d\.expectedSha256 \}/);
  const mig = read('apps/api/prisma/migrations/0035_script_library/migration.sql');
  check('approval refuses SAME_PERSON (author and contributors), binds the hash seen, and needs fresh authentication — before it writes',
    iSame >= 0 && iHash > iSame && iFresh > iHash && iWrite > iFresh
      && /const contributorIds = contributorsOf\(actor\.userId, base\);/.test(svc)
      && /if \(base && base\.status !== 'APPROVED'\) for \(const c of base\.contributorIds\) out\.add\(c\);/.test(read(`${dir}/definition.ts`))
      && /"decidedById" <> "authorId"\s*AND NOT \("decidedById" = ANY \("contributorIds"\)\)\s*AND "approvedSha256" IS NOT NULL\s*AND "approvedSha256" = "contentSha256"/.test(mig),
    'review() must check SAME_PERSON, then the hash, then assertFresh, then write; new versions inherit unapproved contributors; 0035 keeps the CHECK');

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
  const ins = at(psvc, 'async installOnEndpoint(', 1800);
  check('a manual install is a one-computer deployment whose canary still awaits two approvals',
    /rings: \[\[endpointId\]\]/.test(ins) && /'MANUAL', null\)/.test(ins) && /this\.requestRing\(actor, d\.id, 0, \{ reason: dto\.reason, startsInMinutes: dto\.startsInMinutes \}\);/.test(ins) && !/underPolicy|UnderPolicy/.test(ins),
    'installOnEndpoint must not pass a policy (which would sign without approvals)');
  check('only the sweep requests a ring under a policy, and a person cannot request one beside it',
    /if \(!under && d\.origin === 'POLICY'\) throw new ConflictException/.test(psvc) && (pctl.match(/requestRing\(/g) ?? []).length === 2
      && /this\.patching\.requestRing\(actor, id, Number\(ring\), body\) \}/.test(pctl),
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
//     one: a person needs a fresh re-authentication, whatever their role and
//     whatever step-up actions are configured (assertFresh, never the
//     configurable StepUpService.assert). An API key cannot step up and keeps
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
  check('assertFresh refuses a missing method unconditionally',
    /export function assertFresh\(method: string \| null,[^)]*\) \{\s*if \(!method\) \{\s*throw new ForbiddenException\(\{\s*code: 'STEP_UP_REQUIRED'/.test(rev),
    'review.ts: assertFresh must throw STEP_UP_REQUIRED whenever method is null, with no option that skips it');
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
  check('bulk: exactly six repeatable actions, and nothing that connects, archives, deletes or runs an action',
    /export const BULK_ACTIONS = \['group\.add', 'group\.remove', 'inventory\.refresh', 'client\.update', 'agent\.update', 'agent\.migrate'\] as const;/.test(rules)
      && !/\b(authorizeConnect|connect\(|archive|restore\(|\.delete\(|deleteMany|ActionsService|actionJob|createPlan|SignerClient|scriptVersion)\b/i.test(code(bulkSvc).replace(/this\.prisma\.endpointGroupMember\.deleteMany\(\{ where: \{ endpointGroupId: g\.id, endpointId: t\.id \} \}\)/g, '')),
    'BULK_ACTIONS must stay the six, and the bulk service must not reach connect/archive/delete/approved actions');
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
//     device-list visibility rule, and the workspace tabs offer no action.
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
  check('the Processes, Services and Network tabs offer no action: their only write is a Refresh (a catalog key)',
    posts.length === 1 && /api\.post\(`\/endpoints\/\$\{endpointId\}\/diagnostics\/runs`, \{ key: snapKey \}\)/.test(posts[0])
      && !/>\s*(End task|End process|Kill|Stop|Start|Restart|Disable|Enable)\b/i.test(tabs) && !/dangerouslySetInnerHTML/.test(tabs),
    `writes: ${posts.join(' | ')}`);
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
//     (assertFresh, unconditional — 0.33 asked only for enrollment:write),
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
    /'apikey\.create':/.test(dlg) && /cfg\._stepUpRetried = true;\s*return api\.request\(cfg\);/.test(read('apps/web/lib/api-client.ts')),
    'StepUpDialog must label apikey.create; the interceptor must retry the original request');

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
    JSON.stringify(memberWriters) === JSON.stringify(['apps/api/src/device-views/device-bulk.service.ts', 'apps/api/src/endpoints/endpoints.service.ts', 'apps/api/src/enrollment/enrollment.service.ts'])
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
    /export const UPDATE_REBOOT_RULES = \['never', 'if_required_in_window'\] as const;/.test(tsCat) && /reboot: UpdateReboot,\s*\/\/ 0\.32/.test(tsCat)
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
      && (read('apps/api/src/approval-signer/page.ts').match(/esc\(REBOOT_UNPROVEN\)/g) ?? []).length === 2 && doc.includes(`**Not proven on Windows.** ${UNPROVEN}`),
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
  check('a policy whose results would open a ring must name a result key for each such computer (fail closed)',
    /const unsigned = doc\.rings\.slice\(0, -1\)\.flat\(\)\.filter\(\(c\) => !c\.resultKey\);/.test(pp) && /reason: 'result_key_missing'/.test(pp)
      && /code: 'RESULT_KEY_MISSING'/.test(read('apps/api/src/patching/policies.service.ts')),
    'validatePolicyDoc (signer and portal) and PatchPolicyService.create must refuse it');
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
      && /admitPlan\(b\.plan, store\.policy\(\), now\(\), \(id\) => store\.scriptEntry\(id\)\)/.test(server)
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
      && /const r = admitScriptProposal\(b\.proposal, now\(\)\);/.test(internal) && /if \(store\.scriptRevocation\(r\.contentSha256\)\) throw new Refused\('script_revoked'/.test(internal)
      && /throw new Refused\('script_id_reused'/.test(internal)
      && /id: p\.allowlistId, status: 'AWAITING_APPROVAL'/.test(core) && /if \(sha !== p\.contentSha256\) throw new Refused\('hash_mismatch'/.test(core)
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
  const swEntries = read('tools/windows-installer/internal/action/catalog.go').split(/\n\t\{\n/).filter((e) => /ID: "windows\.software\./.test(e));
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
    (svc.match(/this\.actions\.createPlan\(/g) ?? []).length === 1 && !/actionJob\.(create|update|upsert)|actionTarget\.(create|update|upsert)|signer\.submit|\/internal\/v1\/plans/.test(swDir),
    'requestRing must go through createPlan, which re-checks access, readiness and containment and submits to the signer');
  const routeList = [...ctl.matchAll(/@(Get|Post|Put|Patch|Delete)\('([^']*)'\)\s*(?:@HttpCode\([^)]*\)\s*)?@RequireCapability\(CAP\.([A-Z_]+)\)/g)].map((m) => [m[1], m[2], m[3]]);
  const allRoutes = [...ctl.matchAll(/@(?:Get|Post|Put|Patch|Delete)\('([^']*)'\)/g)].map((m) => m[1]);
  check('software: every route names its capability; there is no approve, sign or upload route',
    allRoutes.length === 15 && routeList.length === allRoutes.length && !allRoutes.some((r) => /approv|sign|upload|installer|file|blob|binary/i.test(r))
      && routeList.filter(([m, r]) => m === 'Post' && /^software\/(catalog|manifest-preview)/.test(r)).every(([, , c]) => c === 'COMPUTERS_EDIT'),
    `routes: ${allRoutes.join(', ')}`);
  check('software: nothing in the software module accepts a file',
    !/FileInterceptor|FilesInterceptor|UploadedFile|multer|multipart|@Req\(\) req: Request\)[^{]*\{[^}]*req\.pipe|express\.raw/.test(swDir),
    'the portal never receives an installer: each computer downloads it with winget and checks the pinned hash');
  const method = (name) => svc.slice(svc.indexOf(`  async ${name}(`), svc.indexOf('\n  }\n', svc.indexOf(`  async ${name}(`)));
  const fresh = ['create', 'update', 'archive'].map((n) => { const b = method(n); const a = b.indexOf("assertFresh(freshMethod, { action: 'software.catalog' });"); const w = b.search(/this\.prisma\.softwareCatalogEntry\.(create|updateMany)\(/); const au = b.indexOf("action: 'SOFTWARE_CATALOG_"); return [n, a > 0 && w > a && au > w]; });
  check('software: adding, changing or archiving a catalog entry needs a fresh sign-in before the write, and is audited after it',
    fresh.every(([, ok]) => ok) && (ctl.match(/this\.fresh\(req\)/g) ?? []).length === 3 && /this\.stepUp\.read\(req, u\.sub, u\.iat\)/.test(ctl),
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

// 41. AI without a provider key (0.34). The device page's AI summary used to
//     call a model provider directly with a key in rem0te's environment,
//     sending the computer's name, hostname, business and every note
//     verbatim. "Provider keys stay in ClientSt0r" is now true everywhere:
//     no provider SDK or key variable anywhere in the API, the summary goes
//     only through the integration client to the peer's gateway, and what it
//     carries is fixed here.
{
  const files = walk('apps/api/src');
  const PROVIDER = /@anthropic-ai\/|\bopenai\b|@google\/generative-ai|@google-cloud\/vertexai|@mistralai\/|cohere-ai|groq-sdk|\b(ANTHROPIC|OPENAI|AZURE_OPENAI|GEMINI|GOOGLE_AI|MISTRAL|COHERE|GROQ)_[A-Z_]*KEY\b|api\.anthropic\.com|api\.openai\.com|generativelanguage\.googleapis\.com/i;
  const hits = files.filter((f) => PROVIDER.test(read(f)));
  check('no model-provider SDK, endpoint or key variable is referenced in apps/api/src', hits.length === 0, hits.join(', '));
  const pkg = JSON.parse(read('apps/api/package.json'));
  const deps = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies });
  const sdk = deps.filter((d) => /^(@anthropic-ai\/|openai$|@google\/generative-ai|@mistralai\/|cohere-ai$|groq-sdk$|@ai-sdk\/|ai$)/.test(d));
  check('apps/api/package.json depends on no model-provider SDK', sdk.length === 0, sdk.join(', '));

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
{
  const ctl = read('apps/api/src/email/email.controller.ts');
  const svc = read('apps/api/src/email/email.service.ts');
  const host = read('apps/api/src/email/smtp-host.ts');
  const smtpCtl = ctl.slice(ctl.indexOf("@Controller('email/settings')"), ctl.indexOf("@Controller('email')"));
  check('the SMTP relay settings are Platform Admin only and saving them needs fresh authentication',
    /@UseGuards\(PlatformAdminGuard\)\s*export class SmtpSettingsController/.test(smtpCtl) && /@Put\(\)[\s\S]{0,200}fresh\(this\.stepUp, req\)/.test(smtpCtl) && /assertFresh\(/.test(ctl),
    'SmtpSettingsController must carry PlatformAdminGuard, and PUT must call fresh()');
  const rcpCtl = ctl.slice(ctl.indexOf("@Controller('email')"));
  check('adding, re-sending to and removing an email recipient need fresh authentication',
    /@Post\('recipients'\)[\s\S]{0,200}fresh\(this\.stepUp, req\)/.test(rcpCtl) && /@Post\('recipients\/:id\/resend'\)[\s\S]{0,250}fresh\(this\.stepUp, req\)/.test(rcpCtl) && /@Delete\('recipients\/:id'\)[\s\S]{0,200}fresh\(this\.stepUp, req\)/.test(rcpCtl),
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

if (failures.length > 0) {
  console.error(`\n✗ ${failures.length} security invariant(s) broken:\n`);
  for (const f of failures) console.error(`   ✗ ${f}\n`);
  process.exit(1);
}
console.log('\n✓ All security invariants hold');
