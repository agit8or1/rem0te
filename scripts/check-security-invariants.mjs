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

if (failures.length > 0) {
  console.error(`\n✗ ${failures.length} security invariant(s) broken:\n`);
  for (const f of failures) console.error(`   ✗ ${f}\n`);
  process.exit(1);
}
console.log('\n✓ All security invariants hold');
