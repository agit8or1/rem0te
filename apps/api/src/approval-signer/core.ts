/**
 * The approval signer's decision logic (v0.26). Pure: no HTTP, no clock but
 * the one passed in, no database — the portal's database is exactly what this
 * process must not trust.
 *
 * What it holds that the portal does not:
 *   - the job-approval signing key (Ed25519), readable only by this process's
 *     Unix user;
 *   - the roster: who may approve, for which businesses, identified by their
 *     passkey's public key — enrolled by an operator ceremony, never read
 *     from the portal at decision time;
 *   - the policy: which businesses require customer sign-off.
 *
 * So a compromised portal or database can propose a plan, but cannot make it
 * signed: every signature needs fresh, user-verified passkey assertions from
 * roster members over the exact plan this process rendered, from distinct
 * people who are not the requester, in the number the catalog and this
 * process's own policy require.
 */
import { createHash, createPrivateKey, createPublicKey, sign as edSign, type KeyObject } from 'node:crypto';
import { canonicalJson } from '../integration/crypto';
import {
  APPROVALS_REQUIRED, ENVELOPE_SCHEMA, PLAN_SIGNING_PREFIX, Plan, planDigest, validatePlanAction, type Envelope,
} from '../actions/catalog';

export type Role = 'approver' | 'customer';
export interface RosterMember {
  userId: string;
  name: string;
  /** base64url credential id, as WebAuthn reports it. */
  credentialId: string;
  /** base64url COSE public key. */
  publicKey: string;
  counter: number;
  /** Business ids, or '*' for every business. */
  approve: string[];
  /** Business ids this person may sign off for as the customer. Never '*'. */
  customer: string[];
  addedAt: string;
  disabled?: boolean;
}
export interface Roster { members: RosterMember[] }
export interface Policy { default: { customerSignoff: boolean }; businesses: Record<string, { customerSignoff: boolean }> }

export type JobStatus = 'AWAITING_APPROVAL' | 'SIGNED' | 'REJECTED' | 'CANCELED' | 'EXPIRED';
export interface Decision { userId: string; name: string; role: Role; decision: 'approve' | 'reject'; credentialSha256: string; at: string }
export interface JobRecord {
  jobId: string;
  status: JobStatus;
  plan: Plan;
  digest: string;
  decisions: Decision[];
  envelope: Envelope | null;
  createdAt: string;
  updatedAt: string;
}
export interface Challenge { id: string; jobId: string; digest: string; decision: 'approve' | 'reject'; role: Role; expiresAt: string; used: boolean }

export class Refused extends Error { constructor(public code: string, msg?: string) { super(msg ?? code); } }

export const credentialSha256 = (m: Pick<RosterMember, 'credentialId' | 'publicKey'>) =>
  createHash('sha256').update(`${m.credentialId}:${m.publicKey}`).digest('hex');
/** What the approver reads aloud at enrolment: the first 16 hex of the credential hash, in groups. */
export const fingerprint = (m: Pick<RosterMember, 'credentialId' | 'publicKey'>) => credentialSha256(m).slice(0, 16).replace(/(.{4})(?!$)/g, '$1-');


export { planDigest };

/**
 * The WebAuthn challenge for one decision: a hash over the challenge id, the
 * plan digest, the decision and the role. So the passkey's signature itself
 * covers the exact plan the approver was shown — not only this process's
 * record of which plan a random challenge belonged to.
 */
export function webauthnChallenge(c: Pick<Challenge, 'id' | 'digest' | 'decision' | 'role'>): string {
  return createHash('sha256').update(`rem0te-approval-v1\n${c.id}\n${c.digest}\n${c.decision}\n${c.role}`).digest('base64url');
}

export function policyFor(policy: Policy, businessId: string) {
  return policy.businesses[businessId] ?? policy.default;
}

/** Accept a plan from the portal. Everything the portal claims about policy is re-derived here. */
export function admitPlan(raw: unknown, policy: Policy, now: Date): { plan: Plan; digest: string } {
  const parsed = Plan.safeParse(raw);
  if (!parsed.success) throw new Refused('invalid_plan', parsed.error.issues.slice(0, 3).map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
  const p = parsed.data;
  if (p.approvers.length || p.signedAt) throw new Refused('invalid_plan', 'a proposed plan carries no approvals');
  const v = validatePlanAction(p);
  if (!v.ok) throw new Refused(v.reason);
  const businesses = new Set(p.targets.map((t) => t.businessId));
  if (businesses.size !== 1) throw new Refused('one_business_per_plan');
  const requireCustomer = policyFor(policy, p.targets[0].businessId).customerSignoff;
  if (p.policy.customerSignoff !== requireCustomer) throw new Refused('policy_mismatch', `customer sign-off is ${requireCustomer ? 'required' : 'not required'} for this business`);
  if (p.policy.approvalsRequired !== APPROVALS_REQUIRED[p.policy.risk]) throw new Refused('policy_mismatch', 'approvals required does not match the catalog risk');
  if (Date.parse(p.window.notAfter) <= now.getTime()) throw new Refused('window_closed');
  return { plan: p, digest: planDigest(p) };
}

/** Who this member may act as for this plan, if anything. */
export function rolesFor(m: RosterMember, plan: Plan): Role[] {
  if (m.disabled) return [];
  const biz = plan.targets[0].businessId;
  const out: Role[] = [];
  if (m.approve.includes('*') || m.approve.includes(biz)) out.push('approver');
  if (m.customer.includes(biz)) out.push('customer');
  return out;
}

/** Record one verified decision; returns the new status. Throws on anything that does not count. */
export function recordDecision(job: JobRecord, m: RosterMember, role: Role, decision: 'approve' | 'reject', now: Date): JobStatus {
  if (job.status !== 'AWAITING_APPROVAL') throw new Refused('not_awaiting', `this plan is ${job.status.toLowerCase()}`);
  if (Date.parse(job.plan.window.notAfter) <= now.getTime()) { job.status = 'EXPIRED'; throw new Refused('window_closed'); }
  if (!rolesFor(m, job.plan).includes(role)) throw new Refused('not_authorized', `this passkey is not on the roster as ${role} for this business`);
  if (m.userId === job.plan.requestedBy.userId) throw new Refused('requester_cannot_approve', 'the person who asked cannot approve it');
  if (job.decisions.some((d) => d.userId === m.userId)) throw new Refused('already_decided', 'each person decides once; a second approval must come from someone else');
  job.decisions.push({ userId: m.userId, name: m.name, role, decision, credentialSha256: credentialSha256(m), at: now.toISOString() });
  job.updatedAt = now.toISOString();
  if (decision === 'reject') { job.status = 'REJECTED'; return job.status; }
  return quorumMet(job) ? 'SIGNED' : 'AWAITING_APPROVAL';
}

export function quorumMet(job: JobRecord): boolean {
  const approve = job.decisions.filter((d) => d.decision === 'approve');
  const approvers = new Set(approve.filter((d) => d.role === 'approver').map((d) => d.userId));
  const customers = new Set(approve.filter((d) => d.role === 'customer').map((d) => d.userId));
  if (approvers.size < job.plan.policy.approvalsRequired) return false;
  if (job.plan.policy.customerSignoff && ![...customers].some((c) => !approvers.has(c))) return false;
  return true;
}

export function loadSigningKey(pem: string): { key: KeyObject; kid: string; publicRaw: Buffer } {
  const key = createPrivateKey(pem);
  if (key.asymmetricKeyType !== 'ed25519') throw new Error('approval signing key must be Ed25519');
  const der = createPublicKey(key).export({ type: 'spki', format: 'der' });
  const publicRaw = Buffer.from(der.subarray(der.length - 32));
  return { key, kid: createHash('sha256').update(publicRaw).digest('hex').slice(0, 16), publicRaw };
}

/** Sign the plan with the decisions that made the quorum. */
export function signJob(job: JobRecord, k: { key: KeyObject; kid: string }, now: Date): Envelope {
  const approvers = job.decisions.filter((d) => d.decision === 'approve').map((d) => ({ userId: d.userId, name: d.name, role: d.role, credentialSha256: d.credentialSha256, at: d.at }));
  const plan: Plan = { ...job.plan, approvers, signedAt: now.toISOString() };
  const bytes = Buffer.from(canonicalJson(plan), 'utf8');
  const sig = edSign(null, Buffer.concat([Buffer.from(PLAN_SIGNING_PREFIX, 'utf8'), bytes]), k.key);
  const env: Envelope = { schema: ENVELOPE_SCHEMA, kid: k.kid, plan: bytes.toString('base64'), sig: sig.toString('base64') };
  job.envelope = env; job.status = 'SIGNED'; job.updatedAt = now.toISOString();
  return env;
}

/** The TUF target agents fetch to learn which keys may sign plans (approval/keys.json). */
export function keysDocument(keys: { kid: string; publicRaw: Buffer }[]) {
  return { schema: 'rem0te-approval-keys/1', keys: keys.map((k) => ({ kid: k.kid, ed25519: k.publicRaw.toString('base64') })) };
}
