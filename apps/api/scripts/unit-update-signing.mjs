#!/usr/bin/env node
/**
 * The panel updater's release-tag check (0.30.1), against real gpg and git.
 *
 * Two keys go into one verification keyring — the release key and another —
 * because that is the case the check exists for: `git tag --verify` accepts a
 * tag signed by any key in the keyring. The pinned check must accept only the
 * release key's tag.
 *
 * Needs gpg and git on PATH and a built dist (`npx nest build`). No network,
 * no database; everything lives in a temporary directory.
 *
 *   node scripts/unit-update-signing.mjs
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const { checkTagSignature, normalizeFingerprint } = require(join(here, '..', 'dist', 'admin', 'tag-signature.js'));

let pass = 0, fail = 0;
const check = (c, m, d = '') => { if (c) { pass++; console.log(`  \x1b[32m✓\x1b[0m ${m}`); } else { fail++; console.log(`  \x1b[31m✗\x1b[0m ${m}${d ? `\n      ${d}` : ''}`); } };

// ── Synthetic status lines ──────────────────────────────────────────────────
const A = 'AAAA1111BBBB2222CCCC3333DDDD4444EEEE5555';
const B = '9999888877776666555544443333222211110000';
const ok = (fpr, primary = fpr) => `[GNUPG:] NEWSIG\n[GNUPG:] GOODSIG ${fpr.slice(-16)} Release <r@example.com>\n[GNUPG:] VALIDSIG ${fpr} 2026-11-10 1794000000 0 4 0 22 10 00 ${primary}\n[GNUPG:] TRUST_UNDEFINED 0 pgp\n`;
console.log('status parsing');
check(checkTagSignature(ok(A), A).ok === true, 'a good signature by the pinned key is accepted');
check(checkTagSignature(ok(A), A.toLowerCase().replace(/(.{4})/g, '$1 ')).ok === true, 'the pinned fingerprint may be written in lower case with spaces');
check(checkTagSignature(ok('1234567890ABCDEF1234567890ABCDEF12345678', A), A).ok === true, 'a signing subkey of the pinned primary key is accepted');
check(checkTagSignature(ok(B), A).ok === false, 'a good signature by another key is refused');
check(checkTagSignature(ok(A).replace('GOODSIG', 'EXPKEYSIG'), A).ok === false, 'an expired key is refused');
check(checkTagSignature(ok(A) + '[GNUPG:] REVKEYSIG x\n', A).ok === false, 'a revoked key is refused');
check(checkTagSignature('[GNUPG:] NEWSIG\n[GNUPG:] BADSIG x y\n', A).ok === false, 'a bad signature is refused');
check(checkTagSignature(ok(A) + ok(B), A).ok === false, 'two signatures are refused, even with the pinned one among them');
check(checkTagSignature('', A).ok === false, 'no status output is refused');
check(checkTagSignature(ok(A), 'ABCD').ok === false, 'a short (non-fingerprint) pin is refused');
check(normalizeFingerprint('ABCD1234') === null && normalizeFingerprint(undefined) === null, 'normalizeFingerprint rejects short ids and nothing');

// ── Real gpg and git ────────────────────────────────────────────────────────
const have = (c) => spawnSync(c, ['--version'], { stdio: 'ignore' }).status === 0;
if (!have('gpg') || !have('git')) {
  console.log('\n  (gpg or git not on PATH: real-signature checks skipped)');
} else {
  console.log('real gpg and git');
  const root = mkdtempSync(join(tmpdir(), 'rem0te-tagsig-'));
  try {
    const home = (n) => { const d = join(root, n); mkdirSync(d, { mode: 0o700 }); return d; };
    const gpg = (h, args, input) => execFileSync('gpg', ['--homedir', h, '--batch', '--yes', ...args], { input, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
    const genKey = (h, name) => {
      gpg(h, ['--passphrase', '', '--quick-gen-key', `${name} <${name}@example.com>`, 'ed25519', 'sign', 'never']);
      return gpg(h, ['--with-colons', '--list-keys']).split('\n').find((l) => l.startsWith('fpr:')).split(':')[9];
    };
    const relHome = home('release'), otherHome = home('other'), verifyHome = home('verify');
    const relFpr = genKey(relHome, 'release'), otherFpr = genKey(otherHome, 'other');
    // The verification keyring holds both public keys: "any key in the keyring".
    for (const h of [relHome, otherHome]) gpg(verifyHome, ['--import'], gpg(h, ['--armor', '--export']));

    const repo = join(root, 'repo');
    mkdirSync(repo);
    const git = (args, env = {}) => spawnSync('git', ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', '-c', 'tag.gpgsign=false', ...args], { encoding: 'utf8', env: { ...process.env, ...env } });
    git(['init', '-q']);
    writeFileSync(join(repo, 'f'), 'x');
    git(['add', 'f']); git(['commit', '-q', '-m', 'c']);
    git(['-c', 'gpg.program=gpg', 'tag', '-s', '-m', 'r', '-u', relFpr, 'v1.0.0'], { GNUPGHOME: relHome });
    git(['-c', 'gpg.program=gpg', 'tag', '-s', '-m', 'o', '-u', otherFpr, 'v1.0.1'], { GNUPGHOME: otherHome });
    git(['tag', '-a', '-m', 'u', 'v1.0.2']);

    // Exactly what UpdateService runs.
    const verify = (tag) => {
      const r = git(['-c', 'gpg.program=gpg', '-c', 'gpg.format=openpgp', 'verify-tag', '--raw', tag], { GNUPGHOME: verifyHome });
      return r.status === 0 ? checkTagSignature(r.stderr, relFpr) : { ok: false, reason: `exit ${r.status}` };
    };
    const legacy = git(['tag', '--verify', 'v1.0.1'], { GNUPGHOME: verifyHome });
    check(legacy.status === 0, 'the old check (`git tag --verify`) accepts the tag signed by the OTHER key — the case being fixed', `exit ${legacy.status}`);
    const r0 = verify('v1.0.0');
    check(r0.ok === true && r0.signer === relFpr, 'the release key\'s tag is accepted, and the signer reported is the pinned key', JSON.stringify(r0));
    const r1 = verify('v1.0.1');
    check(r1.ok === false && /not the pinned release key/.test(r1.reason), 'the other key\'s tag is refused', JSON.stringify(r1));
    check(verify('v1.0.2').ok === false, 'an unsigned annotated tag is refused');
    check(verify('v9.9.9').ok === false, 'a tag that does not exist is refused');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
