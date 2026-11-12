/**
 * The signer's own state, on its own disk, owned by its own Unix user.
 * Deliberately not the portal's Postgres: the portal's database is the thing
 * this process must not have to trust.
 *
 *   <dir>/signer.key        Ed25519 PKCS#8 PEM, 0600
 *   <dir>/roster.json       approvers and their passkeys (operator ceremony)
 *   <dir>/policy.json       per-business customer sign-off
 *   <dir>/jobs/<id>.json    one per plan; decisions and the envelope
 *   <dir>/challenges/<id>.json  single-use WebAuthn challenges
 *   <dir>/counters/<sha>.json   each passkey's signature counter
 *   <dir>/policies/<id>.json    patch policies (v0.32): the document, its decisions,
 *                               the signer's signature and the ledger
 *   <dir>/revocations/<id>.json patch policy revocations: write-once, never removed
 *   <dir>/pauses/<id>.json      pauses (v0.28): created by the operator CLI or at the
 *                               portal's request; cleared only by the operator CLI
 *   <dir>/device-keys/<sha>.json  device result keys (v0.34), pinned when a policy naming
 *                               the computer is first approved: write-once, removed only
 *                               by the operator CLI (device-key forget)
 *   <dir>/scripts/<id>.json     the script allowlist (v0.34): each entry's proposal,
 *                               the content, the hashes this process computed, decisions
 *   <dir>/script-revocations/<sha256>.json  revoked script CONTENT hashes: write-once,
 *                               never removed, and never proposable again
 *
 * The serving process never writes roster.json or policy.json: those belong
 * to the operator CLI. Counters live apart so that saving one can never
 * overwrite a `roster disable` that landed a moment earlier.
 *
 * Writes are write-temp-then-rename, so a crash leaves the old file or the
 * new one, never half of either. One process; a promise chain serialises
 * every mutation so two approvals cannot race past the quorum check.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import * as path from 'node:path';
import type { Challenge, DevicePin, JobRecord, Policy, PolicyRecord, Roster, ScriptAllowRecord } from './core';

const ID = /^[a-f0-9]{32}$/;

export class SignerStore {
  private chain: Promise<unknown> = Promise.resolve();
  constructor(readonly dir: string) {
    for (const d of ['jobs', 'challenges', 'counters', 'pauses', 'policies', 'revocations', 'device-keys', 'scripts', 'script-revocations']) mkdirSync(path.join(dir, d), { recursive: true, mode: 0o700 });
  }

  /** Run fn with every other mutation waiting. */
  exclusive<T>(fn: () => T | Promise<T>): Promise<T> {
    const next = this.chain.then(fn, fn);
    this.chain = next.catch(() => undefined);
    return next;
  }

  private write(file: string, value: unknown) {
    const tmp = `${file}.${randomBytes(6).toString('hex')}.tmp`;
    writeFileSync(tmp, JSON.stringify(value, null, 2), { mode: 0o600 });
    renameSync(tmp, file);
  }
  private read<T>(file: string): T | null {
    if (!existsSync(file)) return null;
    return JSON.parse(readFileSync(file, 'utf8')) as T;
  }

  keyPem(): string { return readFileSync(path.join(this.dir, 'signer.key'), 'utf8'); }
  roster(): Roster { return this.read<Roster>(path.join(this.dir, 'roster.json')) ?? { members: [] }; }
  saveRoster(r: Roster) { this.write(path.join(this.dir, 'roster.json'), r); }
  policy(): Policy { return this.read<Policy>(path.join(this.dir, 'policy.json')) ?? { default: { customerSignoff: false }, businesses: {} }; }
  savePolicy(p: Policy) { this.write(path.join(this.dir, 'policy.json'), p); }

  job(id: string): JobRecord | null { return ID.test(id) ? this.read<JobRecord>(path.join(this.dir, 'jobs', `${id}.json`)) : null; }
  saveJob(j: JobRecord) { if (!ID.test(j.jobId)) throw new Error('bad job id'); this.write(path.join(this.dir, 'jobs', `${j.jobId}.json`), j); }
  jobs(): string[] { return readdirSync(path.join(this.dir, 'jobs')).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5)); }

  challenge(id: string): Challenge | null { return /^[A-Za-z0-9_-]{20,64}$/.test(id) ? this.read<Challenge>(path.join(this.dir, 'challenges', `${id}.json`)) : null; }
  counter(credentialSha256: string): number {
    if (!/^[a-f0-9]{64}$/.test(credentialSha256)) return 0;
    return this.read<{ counter: number }>(path.join(this.dir, 'counters', `${credentialSha256}.json`))?.counter ?? 0;
  }
  saveCounter(credentialSha256: string, counter: number) {
    if (!/^[a-f0-9]{64}$/.test(credentialSha256)) throw new Error('bad credential hash');
    this.write(path.join(this.dir, 'counters', `${credentialSha256}.json`), { counter });
  }
  saveChallenge(c: Challenge) { this.write(path.join(this.dir, 'challenges', `${c.id}.json`), c); }

  // ── Patch policies (v0.32) ────────────────────────────────────────────────
  // One file each. The serving process creates, records decisions on, signs,
  // revokes and appends to a policy's ledger; nothing it does reactivates a
  // revoked one, and nothing over HTTP can.
  /**
   * A policy, with any revocation applied. Revocation is its own write-once
   * file (revocations/<id>.json), so neither the serving process nor the CLI
   * can lose one by rewriting the policy file, and nothing removes it.
   */
  patchPolicy(id: string): PolicyRecord | null {
    if (!ID.test(id)) return null;
    const r = this.read<PolicyRecord>(path.join(this.dir, 'policies', `${id}.json`));
    if (!r) return null;
    const rev = this.read<Revocation>(path.join(this.dir, 'revocations', `${id}.json`));
    if (rev) Object.assign(r, { status: 'REVOKED', revokedAt: rev.at, revokedBy: rev.by, revokeReason: rev.reason });
    return r;
  }
  /** Revoke a policy. Returns false if it already was; the first revocation stands. */
  revokePatchPolicy(id: string, rev: Revocation): boolean {
    if (!ID.test(id)) throw new Error('bad policy id');
    try { writeFileSync(path.join(this.dir, 'revocations', `${id}.json`), JSON.stringify(rev, null, 2), { mode: 0o600, flag: 'wx' }); return true; } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'EEXIST') return false;
      throw e;
    }
  }
  savePatchPolicy(r: PolicyRecord) { if (!ID.test(r.policyId)) throw new Error('bad policy id'); this.write(path.join(this.dir, 'policies', `${r.policyId}.json`), r); }
  patchPolicies(): string[] { return readdirSync(path.join(this.dir, 'policies')).filter((f) => /^[a-f0-9]{32}\.json$/.test(f)).map((f) => f.slice(0, -5)); }

  // ── Device result keys (v0.34) ────────────────────────────────────────────
  // One file per enrolled identity, created with 'wx': the serving process
  // can add a pin and never change one. Only the operator CLI removes one.
  devicePin(identity: string): DevicePin | null {
    return /^[a-f0-9]{64}$/.test(identity) ? this.read<DevicePin>(path.join(this.dir, 'device-keys', `${identity}.json`)) : null;
  }
  /** Pin a key. Returns false if the identity already has one; the first pin stands. */
  pinDeviceKey(p: DevicePin): boolean {
    if (!/^[a-f0-9]{64}$/.test(p.identity)) throw new Error('bad device identity');
    try { writeFileSync(path.join(this.dir, 'device-keys', `${p.identity}.json`), JSON.stringify(p, null, 2), { mode: 0o600, flag: 'wx' }); return true; } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'EEXIST') return false;
      throw e;
    }
  }
  devicePins(): DevicePin[] {
    return readdirSync(path.join(this.dir, 'device-keys')).filter((f) => /^[a-f0-9]{64}\.json$/.test(f))
      .map((f) => this.read<DevicePin>(path.join(this.dir, 'device-keys', f))).filter((p): p is DevicePin => !!p);
  }
  /** Operator CLI only. */
  forgetDevicePin(identity: string): boolean {
    if (!/^[a-f0-9]{64}$/.test(identity)) return false;
    try { unlinkSync(path.join(this.dir, 'device-keys', `${identity}.json`)); return true; } catch { return false; }
  }

  // ── The script allowlist (v0.34) ──────────────────────────────────────────
  // One file per entry. Revocation is by CONTENT hash, in its own write-once
  // file: rewriting an entry cannot lose one, and a revoked script cannot be
  // put back under a new entry id.
  scriptEntry(id: string): ScriptAllowRecord | null {
    if (!ID.test(id)) return null;
    const r = this.read<ScriptAllowRecord>(path.join(this.dir, 'scripts', `${id}.json`));
    if (!r) return null;
    const rev = this.scriptRevocation(r.contentSha256);
    if (rev) Object.assign(r, { revokedAt: rev.at, revokedBy: rev.by, revokeReason: rev.reason });
    return r;
  }
  scriptRevocation(contentSha256: string): Revocation | null {
    return /^[a-f0-9]{64}$/.test(contentSha256) ? this.read<Revocation>(path.join(this.dir, 'script-revocations', `${contentSha256}.json`)) : null;
  }
  saveScriptEntry(r: ScriptAllowRecord) { if (!ID.test(r.id)) throw new Error('bad script entry id'); this.write(path.join(this.dir, 'scripts', `${r.id}.json`), r); }
  scriptEntries(): string[] { return readdirSync(path.join(this.dir, 'scripts')).filter((f) => /^[a-f0-9]{32}\.json$/.test(f)).map((f) => f.slice(0, -5)); }
  /** Revoke a script's content hash. Returns false if it already was; the first revocation stands. */
  revokeScript(contentSha256: string, rev: Revocation): boolean {
    if (!/^[a-f0-9]{64}$/.test(contentSha256)) throw new Error('bad content hash');
    try { writeFileSync(path.join(this.dir, 'script-revocations', `${contentSha256}.json`), JSON.stringify(rev, null, 2), { mode: 0o600, flag: 'wx' }); return true; } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'EEXIST') return false;
      throw e;
    }
  }

  // ── Pauses (v0.28) ────────────────────────────────────────────────────────
  // One file each, so the serving process (which only ever creates one) and
  // the operator CLI (which clears) never overwrite each other's write.
  pauses(): Pause[] {
    return readdirSync(path.join(this.dir, 'pauses')).filter((f) => /^[a-f0-9]{16}\.json$/.test(f))
      .map((f) => this.read<Pause>(path.join(this.dir, 'pauses', f))).filter((p): p is Pause => !!p);
  }
  activePause(businessId: string | null): Pause | null {
    return this.pauses().filter((p) => !p.clearedAt && (p.scope === 'global' || (businessId && p.businessId === businessId))).sort((a, b) => (a.scope === b.scope ? 0 : a.scope === 'global' ? -1 : 1))[0] ?? null;
  }
  addPause(p: Omit<Pause, 'id'>): Pause {
    const full: Pause = { id: randomBytes(8).toString('hex'), ...p };
    writeFileSync(path.join(this.dir, 'pauses', `${full.id}.json`), JSON.stringify(full, null, 2), { mode: 0o600, flag: 'wx' });
    return full;
  }
  savePause(p: Pause) { if (!/^[a-f0-9]{16}$/.test(p.id)) throw new Error('bad pause id'); this.write(path.join(this.dir, 'pauses', `${p.id}.json`), p); }
}

export interface Pause {
  id: string; scope: 'global' | 'business'; businessId?: string; reason: string;
  setBy: 'operator' | 'portal'; ref?: string; at: string; clearedAt?: string; clearReason?: string;
}

export interface Revocation { at: string; by: 'portal' | 'operator'; reason: string }
