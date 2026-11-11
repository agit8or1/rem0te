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
  const ALLOWED_IMPORT = /^(node:|crypto$|\.\/|@simplewebauthn\/server$|zod$|\.\.\/actions\/catalog$|\.\.\/actions\/patch-policy$|\.\.\/actions\/script-run$|\.\.\/integration\/crypto$)/;
  const importsOf = (src) => [...src.matchAll(/(?:from|require\()\s*['"]([^'"]+)['"]/g)].map((m) => m[1]);
  const bad = [];
  // 0.32: the patch-policy evaluator (and the posture module it judges with)
  // run inside the signer, so they are held to the same rule; 0.34 the
  // script-run rules (argument schema, plan block, allowlist proposal).
  for (const f of [...signerFiles, 'apps/api/src/actions/catalog.ts', 'apps/api/src/integration/crypto.ts', 'apps/api/src/actions/patch-policy.ts', 'apps/api/src/patching/posture.ts', 'apps/api/src/actions/script-run.ts']) {
    const own = f.startsWith(signerDir) ? ALLOWED_IMPORT : /^(node:|crypto$|zod$|\.\/crypto$|\.\/catalog$|\.\/script-run$|\.\.\/actions\/catalog$|\.\.\/patching\/posture$|\.\.\/integration\/crypto$)/;
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
  // actions; 0.34 windows.script.run (§ 33). The list is exact and ordered:
  // anything further is a review.
  const CATALOG_IDS = ['windows.service.start', 'windows.update.install', 'windows.service.restart', 'windows.reboot.schedule', 'windows.reboot.cancel', 'windows.logs.collect', 'windows.script.run'];
  check('agent catalog is exactly the Spooler start, update install, service restart, restart schedule/cancel, log collection and approved-script run',
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
  // hash, typed arguments and a timeout from a fixed list (§ 33 holds that
  // form to its rules).
  const entries = goCat.slice(goCat.indexOf('var catalog = []Action{')).split(/\n\t\{\n/).slice(1);
  const CLOSED = [/ParamsOK: func\(p map\[string\]any\) bool \{\s*if len\(p\) != 1 \{\s*return false\s*\}\s*s, ok := p\["service"\]\.\(string\)\s*return ok && s == ServiceName/,
    /ParamsOK:\s+updateParamsOK,/, /ParamsOK:\s+func\(p map\[string\]any\) bool \{ return RestartService\(p\) != "" \},/,
    /ParamsOK:\s+func\(p map\[string\]any\) bool \{ return RestartDelay\(p\) != 0 \},/, /ParamsOK:\s+func\(p map\[string\]any\) bool \{ return len\(p\) == 0 \},/, /ParamsOK:\s+scriptParamsOK,/];
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
    !/"os\/exec"|exec\.Command/.test(maint + read('tools/windows-installer/internal/action/action.go') + goCat)
      && [...read('tools/windows-installer/action_windows.go').matchAll(/runSystem32\([^,]+, "([^"]+)"/g)].map((m) => m[1]).every((x) => x === 'shutdown.exe' || x === 'wevtutil.exe')
      && (read('tools/windows-installer/action_windows.go').match(/exec\.Command(?:Context)?\(/g) ?? []).length === 2,
    'maintenance must not grow a way to run something else');
  check('the maintenance actions and the script run are not offered to ClientSt0r', (tsCat.match(/integration: false,/g) ?? []).length === 5 && /export const SCRIPT_RUN: CatalogAction = \{[\s\S]{0,2000}?\bintegration: false,/.test(tsCat) && /proposable\(\): string\[\] \{[^}]{0,200}CATALOG\.filter\(\(a\) => a\.integration\)\.map/.test(read('apps/api/src/integration/action-proposals.service.ts'))
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
    iPre > iPz && iPz > 0 && iExec > iPre && /if pr := a\.Precheck\(plan, o\); pr != nil \{[\s\S]{0,200}writeJournal\(o, journal\{JobID: jobID, State: "done"[\s\S]{0,120}return report\(o, r\)/.test(act),
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
  check('agent update params are closed: exactly updates + reboot "never" (+ optional allow), each {updateId, revision}',
    /want := 2\s*if hasAllow \{\s*want = 3\s*\}\s*if len\(p\) != want \|\| p\["reboot"\] != "never"/.test(upd) && /!ok \|\| len\(m\) != 2/.test(upd)
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
    routes.length === 8 && routes.every((r) => /^\s*'[^']+'\)\s*@RequireCapability\(CAP\.(COMPUTERS_VIEW|ALERTS_VIEW)\)/.test(r)) && routes.filter((r) => /export\.csv/.test(r.slice(0, 60))).every((r) => /@RateLimit\(10\)/.test(r.slice(0, 200)))
      && routes.filter((r) => /^'(alert-frequency|offline-time)/.test(r)).every((r) => /CAP\.ALERTS_VIEW/.test(r.slice(0, 120))),
    'eight routes, each @RequireCapability; alert reports need ALERTS_VIEW; exports @RateLimit');
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
  // module's, and its routes are exactly these (§ 33 checks what they do).
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
  check('a policy can never restart a computer in this release', /reboot: z\.literal\('never'\)/.test(ev) && /reboot: z\.literal\('never'\)/.test(pol),
    'a reboot rule is a §15 change to the agent\'s closed params');
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
//     the ability, so minting a key that carries enrollment:write needs the
//     same fresh re-authentication. Every caller must say which proof it
//     has; nothing else writes a DeviceClaimToken. Registering by RustDesk ID
//     mints no credential and so is not gated.
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
  check('a key that can mint enrolment tokens needs a fresh re-authentication to create',
    /if \(validScopes\.includes\('enrollment:write'\)\) \{\s*assertFresh\(freshMethod, \{/.test(keyFn)
      && keyFn.indexOf("validScopes.includes('enrollment:write')") < keyFn.indexOf('apiKey.create(')
      && /this\.stepUp\.read\(req, u\.sub, u\.iat\)\?\.method \?\? null : null;\s*return \{ success: true, data: await this\.svc\.create\(actor, dto, freshMethod\) \};/.test(keysCtl),
    'ApiKeysService.create must assertFresh on enrollment:write (the filtered scopes) before writing; the controller passes the step-up');
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
      && /where: this\.scopedWhere\(actor, \{ status: q\.status \}\)/.test(read('apps/api/src/endpoints/endpoint-list.service.ts')),
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
        && /const c = \{ contains: likeEscape\(q\.search\), mode: 'insensitive' as const \};/.test(lst) && !/contains: q\.search/.test(lst)
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

  check('bulk: exactly four repeatable actions, and nothing that connects, archives, deletes or runs an action',
    /export const BULK_ACTIONS = \['group\.add', 'group\.remove', 'inventory\.refresh', 'client\.update'\] as const;/.test(rules)
      && !/\b(authorizeConnect|connect\(|archive|restore\(|\.delete\(|deleteMany|ActionsService|actionJob|createPlan|SignerClient|scriptVersion)\b/i.test(code(bulkSvc).replace(/endpointGroup\.findUnique/g, '')),
    'BULK_ACTIONS must stay the four, and the bulk service must not reach connect/archive/delete/approved actions');
  check('bulk: at most 200 per request, counted before de-duplication, for the export too',
    /export const BULK_MAX = 200;/.test(rules)
      && /if \(ids\.length > BULK_MAX\) throw bad\('BULK_TOO_LARGE'/.test(rules) && rules.indexOf('ids.length > BULK_MAX') < rules.indexOf('[...new Set(ids as string[])]')
      && /const endpointIds = parseSelection\(body\.endpointIds\);/.test(rules) && /const ids = parseSelection\(body\.endpointIds\);/.test(bulkSvc),
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
    /async create\(a: ActorContext, raw: unknown\) \{[\s\S]{0,400}const why = manageRefusal\(a, customerId\);\s*if \(why\) throw new ForbiddenException/.test(groupSvc)
      && /const g = await this\.findManageable\(a, id\);/.test(groupSvc.slice(groupSvc.indexOf('async update('))) && /const g = await this\.findManageable\(a, id\);/.test(groupSvc.slice(groupSvc.indexOf('async remove(')))
      && /const why = manageRefusal\(a, g\.customerId\);/.test(bulkSvc) && /if \(t\.customerId !== g\.customerId\) \{/.test(bulkSvc)
      && /updateMany\(\{ where: \{ id: t\.id, customerId: g\.customerId, endpointGroupId: null \}, data: \{ endpointGroupId: g\.id \} \}\)/.test(bulkSvc),
    'create/update/remove and bulk membership must check manageRefusal; additions are conditional on the business');
  check('groups: another business’s group is a 404',
    /if \(!g\.customerId \|\| g\.customerId !== a\.businessId\) throw new NotFoundException\('Group not found'\);/.test(groupSvc), 'findVisible must compare the business');
  const eps = read('apps/api/src/endpoints/endpoints.service.ts');
  const enr = read('apps/api/src/enrollment/enrollment.service.ts');
  check('a computer gets only its own business’s group: creation, enrolment tokens, claims, and moving business',
    /if \(dto\.endpointGroupId\) await this\.assertGroupFor\(dto\.endpointGroupId, businessId, business\.tenantId\);/.test(eps)
      && /where: \{ id: groupId, OR: \[\{ customerId: businessId \}, \{ customerId: null, tenantId \}\] \}/.test(eps)
      && /\.\.\.\(leavesGroup \? \{ endpointGroupId: null \} : \{\}\)/.test(eps)
      && /where: \{ id: dto\.endpointGroupId, OR: \[\{ customerId: businessId \}, \{ customerId: null, tenantId: business\.tenantId \}\] \}/.test(enr)
      && /endpointGroupId: groupId,/.test(enr) && !/endpointGroupId: record\.endpointGroupId/.test(enr),
    'create, update, token minting and claim must all tie the group to the business');
  const views = [...ctl.matchAll(/@(Get|Post|Put|Patch|Delete)\(\s*(?:'([^']*)')?\s*\)/g)].map((m) => `${m[1].toUpperCase()} ${m[2] ?? ''}`);
  const handlers = ctl.split(/\n  @(?:Get|Post|Put|Patch|Delete)\(/).slice(1);
  check('views and groups: every route names its capability, no route runs a view, bulk has two routes',
    JSON.stringify(views) === JSON.stringify(['GET ', 'GET :id', 'POST ', 'PATCH :id', 'DELETE :id', 'GET ', 'POST ', 'PATCH :id', 'DELETE :id', 'POST ', 'POST export.csv'])
      && handlers.length === 11 && handlers.every((h) => /^[^\n]*\)\s*\n\s*@RequireCapability\(CAP\.(COMPUTERS_VIEW|COMPUTERS_EDIT)\)/.test(h))
      && /@Controller\('device-views'\)/.test(ctl) && /@Controller\('device-groups'\)/.test(ctl) && /@Controller\('endpoints\/bulk'\)/.test(ctl),
    `routes: ${views.join(', ')}`);
  check('views store list parameters only, parsed by the list’s own parser; nothing in the view service reads computers',
    /const unknown = Object\.keys\(raw\)\.filter\(\(k\) => !\(LIST_FILTER_KEYS as readonly string\[\]\)\.includes\(k\)\);\s*if \(unknown\.length\) throw bad/.test(rules)
      && /const q = parseListQuery\(asQuery\);/.test(rules)
      && /export const ViewUpdate = z\.object\(viewFields\)\.partial\(\)\.strict\(\);/.test(rules) && !/shared|businessId/.test(rules.slice(rules.indexOf('const viewFields = {'), rules.indexOf('export const ViewInput')))
      && !/this\.prisma\.endpoint\./.test(viewSvc) && /if \(f\.businessId && f\.businessId !== customerId\) \{/.test(viewSvc),
    'normalizeViewFilters must refuse unknown keys and use parseListQuery; updates cannot change who a view is for; shared filters stay in the business');
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
      && /await this\.auditBulk\(a, input\.action, targets, ordered, group\);/.test(bulkSvc),
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

// 33. Running approved scripts (0.34): windows.script.run@1. A script runs as
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
      && !/this\.write\([^)]*'script-revocations'/.test(store) && !/unlinkSync|rmSync|\bunlink\(|\brm\(/.test(store)
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

if (failures.length > 0) {
  console.error(`\n✗ ${failures.length} security invariant(s) broken:\n`);
  for (const f of failures) console.error(`   ✗ ${f}\n`);
  process.exit(1);
}
console.log('\n✓ All security invariants hold');
