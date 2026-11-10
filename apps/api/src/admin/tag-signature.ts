/**
 * Deciding whether a release tag was signed by THE release key.
 *
 * `git tag --verify` against the service account's own keyring accepts a
 * signature from any key in it, and says nothing about which one. The updater
 * instead verifies with a dedicated GNUPGHOME and checks gpg's machine-readable
 * status output (`git verify-tag --raw`) for the pinned fingerprint.
 *
 * Pure, so it can be tested against real gpg output without a running API.
 */

/** A full v4 (40 hex) or v5 (64 hex) OpenPGP fingerprint, or null. */
export function normalizeFingerprint(v: string | undefined | null): string | null {
  const f = (v ?? '').replace(/\s+/g, '').toUpperCase();
  return /^([0-9A-F]{40}|[0-9A-F]{64})$/.test(f) ? f : null;
}

export type TagVerdict = { ok: true; signer: string } | { ok: false; reason: string };

/**
 * `status` is gpg's `[GNUPG:]` status lines. Accepted only when there is a
 * good, valid signature whose signing key or primary key is `pinned`, and
 * nothing in the output marks a bad, expired or revoked signature or key.
 */
export function checkTagSignature(status: string, pinned: string): TagVerdict {
  const want = normalizeFingerprint(pinned);
  if (!want) return { ok: false, reason: 'no valid release key fingerprint is pinned' };
  const lines = status.split(/\r?\n/).filter((l) => l.startsWith('[GNUPG:] ')).map((l) => l.slice(9).trim().split(/\s+/));
  const refused = ['BADSIG', 'ERRSIG', 'EXPSIG', 'EXPKEYSIG', 'REVKEYSIG', 'NO_PUBKEY', 'KEYREVOKED', 'KEYEXPIRED', 'FAILURE'];
  const bad = lines.find((l) => refused.includes(l[0]));
  if (bad) return { ok: false, reason: `gpg reported ${bad[0]}` };
  const good = lines.filter((l) => l[0] === 'GOODSIG');
  const valid = lines.filter((l) => l[0] === 'VALIDSIG');
  // One signature, exactly: a second (good) one from another key is not
  // something a release tag has a reason to carry.
  if (good.length !== 1 || valid.length !== 1) return { ok: false, reason: good.length || valid.length ? 'more than one signature' : 'no good signature' };
  const v = valid[0];
  // VALIDSIG <signing fpr> <date> <ts> <expire> <ver> <rsv> <pk-algo> <hash-algo> <class> <primary fpr>
  const signing = normalizeFingerprint(v[1]);
  const primary = normalizeFingerprint(v[v.length - 1]);
  if (signing !== want && primary !== want) return { ok: false, reason: `signed by ${primary ?? signing ?? 'an unknown key'}, not the pinned release key` };
  return { ok: true, signer: primary ?? signing! };
}
