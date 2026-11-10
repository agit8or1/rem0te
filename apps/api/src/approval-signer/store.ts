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
 *   <dir>/pauses/<id>.json      pauses (v0.28): created by the operator CLI or at the
 *                               portal's request; cleared only by the operator CLI
 *
 * The serving process never writes roster.json or policy.json: those belong
 * to the operator CLI. Counters live apart so that saving one can never
 * overwrite a `roster disable` that landed a moment earlier.
 *
 * Writes are write-temp-then-rename, so a crash leaves the old file or the
 * new one, never half of either. One process; a promise chain serialises
 * every mutation so two approvals cannot race past the quorum check.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import * as path from 'node:path';
import type { Challenge, JobRecord, Policy, Roster } from './core';

const ID = /^[a-f0-9]{32}$/;

export class SignerStore {
  private chain: Promise<unknown> = Promise.resolve();
  constructor(readonly dir: string) {
    for (const d of ['jobs', 'challenges', 'counters', 'pauses']) mkdirSync(path.join(dir, d), { recursive: true, mode: 0o700 });
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
