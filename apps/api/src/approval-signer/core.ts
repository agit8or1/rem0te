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
import { createHash, createPrivateKey, createPublicKey, sign as edSign, verify as edVerify, type KeyObject } from 'node:crypto';
import { canonicalJson } from '../integration/crypto';
import {
  APPROVALS_REQUIRED, ENVELOPE_SCHEMA, PLAN_SIGNING_PREFIX, Plan, planDigest, validatePlanAction, type Envelope,
} from '../actions/catalog';
import {
  POLICY_PROPOSAL_DAYS, PolicyDoc, RingEvidence as RingEvidenceSchema, evaluatePolicyPlan, policyDigest, policyQuorum, policySigningBytes, validatePolicyDoc,
  type LedgerEntry, type PolicyApproval, type PolicyComputer, type PolicyDecision, type PolicyPlanRequest, type PolicyStatus,
} from '../actions/patch-policy';
import { resultKeyFingerprint } from '../actions/device-result';
import {
  SCRIPT_ALLOWLIST_APPROVALS, SCRIPT_RUN_ACTION, ScriptProposal, argumentsProblem, canonical, contentProblem, scriptBlockOf, sha256Hex,
} from '../actions/script-run';

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
/**
 * One single-use WebAuthn challenge. `kind: 'policy'` (0.32) is a policy
 * decision and `kind: 'script'` (0.34) an allowlist decision; `jobId` is then
 * the policy's or the entry's id.
 */
export interface Challenge { id: string; kind?: 'policy' | 'script'; jobId: string; digest: string; decision: 'approve' | 'reject'; role: Role; expiresAt: string; used: boolean }

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

/**
 * Accept a plan from the portal. Everything the portal claims about policy is
 * re-derived here. A script run (0.34) must name an ACTIVE entry of this
 * process's own allowlist, carry exactly that entry's block, and pass its
 * arguments against the entry's declared parameters — this process's copy,
 * not the portal's.
 */
export function admitPlan(raw: unknown, policy: Policy, now: Date, scripts?: (id: string) => ScriptAllowRecord | null): { plan: Plan; digest: string } {
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
  if (p.action.id === SCRIPT_RUN_ACTION) assertScriptAllowed(p, scripts);
  return { plan: p, digest: planDigest(p) };
}

/** A script-run plan against this signer's allowlist. Throws unless it may be signed. */
export function assertScriptAllowed(p: Plan, scripts?: (id: string) => ScriptAllowRecord | null) {
  const s = p.script;
  const entry = s && scripts ? scripts(s.allowlistId) : null;
  if (!s || !entry) throw new Refused('script_not_allowlisted', 'this script version is not on the approval signer\'s allowlist');
  const st = effectiveScriptStatus(entry);
  if (st === 'REVOKED') throw new Refused('script_revoked', `this script was removed from the allowlist${entry.revokeReason ? `: ${entry.revokeReason}` : ''}`);
  if (st !== 'ACTIVE') throw new Refused('script_not_allowlisted', `this script's allowlist entry is ${st.toLowerCase().replace(/_/g, ' ')}`);
  if (canonical(s) !== canonical(scriptBlockOf(entry.proposal))) throw new Refused('script_mismatch', 'the plan does not describe the allowlisted script exactly');
  const why = argumentsProblem(entry.proposal.parameters, (p.params as { parameters?: unknown }).parameters);
  if (why) throw new Refused('arguments_not_allowed', why);
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
  // SAME_PERSON (0.34): whoever wrote a script's content approves neither
  // its review in the library nor a run of it here. The agent checks again.
  if (job.plan.script?.contributors.includes(m.userId)) throw new Refused('contributor_cannot_approve', 'you wrote or edited this script, so someone else must approve running it');
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

// ── Patch policies (v0.32) ──────────────────────────────────────────────────
// A policy is approved here, by the same roster and passkeys as a plan, and
// then lets this process sign ring plans on its own — only plans that
// actions/patch-policy.ts finds inside it. Revocation is an act on this
// process, never a question it asks the portal: a compromised portal would
// simply answer "still active".

export interface PolicyRecord {
  policyId: string;
  status: PolicyStatus;
  doc: PolicyDoc;
  digest: string;
  decisions: Decision[];
  /** base64 Ed25519 over policySigningBytes(doc, approvals), set when the quorum is met. */
  signature: string | null;
  kid: string | null;
  revokedAt: string | null;
  revokedBy: 'portal' | 'operator' | null;
  revokeReason: string | null;
  /** Every plan signed under it: the ring order is decided from this, not from the portal. */
  ledger: LedgerEntry[];
  /** The last refusals, for the operator. */
  refusals: { at: string; jobId: string; code: string; message: string }[];
  createdAt: string;
  updatedAt: string;
}

/** Accept a proposed policy from the portal. */
export function admitPolicy(raw: unknown, now: Date): { doc: PolicyDoc; digest: string } {
  const parsed = PolicyDoc.safeParse(raw);
  if (!parsed.success) throw new Refused('invalid_policy', parsed.error.issues.slice(0, 3).map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
  const v = validatePolicyDoc(parsed.data, now);
  if (!v.ok) throw new Refused(v.reason, v.message);
  return { doc: parsed.data, digest: policyDigest(parsed.data) };
}

export function policyRolesFor(m: RosterMember, doc: PolicyDoc): Role[] {
  if (m.disabled) return [];
  const out: Role[] = [];
  if (m.approve.includes('*') || m.approve.includes(doc.businessId)) out.push('approver');
  if (m.customer.includes(doc.businessId)) out.push('customer');
  return out;
}

export const approvalsOf = (r: Pick<PolicyRecord, 'decisions'>): PolicyApproval[] =>
  r.decisions.filter((d) => d.decision === 'approve').map((d) => ({ userId: d.userId, name: d.name, role: d.role, credentialSha256: d.credentialSha256, at: d.at }));

/** What the record's status is now: revocation and expiry are facts of this process's clock and disk. */
export function effectivePolicyStatus(r: PolicyRecord, now: Date): PolicyStatus {
  if (r.revokedAt) return 'REVOKED';
  if (r.status === 'REJECTED') return 'REJECTED';
  if (now.getTime() >= Date.parse(r.doc.expiresAt)) return 'EXPIRED';
  if (r.status === 'AWAITING_APPROVAL' && now.getTime() >= Date.parse(r.createdAt) + POLICY_PROPOSAL_DAYS * 86_400_000) return 'EXPIRED';
  return r.status;
}

/** Record one verified decision on a policy. Throws on anything that does not count. */
export function recordPolicyDecision(r: PolicyRecord, m: RosterMember, role: Role, decision: 'approve' | 'reject', now: Date, customerSignoff: boolean): PolicyStatus {
  const st = effectivePolicyStatus(r, now);
  if (st !== 'AWAITING_APPROVAL') throw new Refused('not_awaiting', `this policy is ${st.toLowerCase().replace(/_/g, ' ')}`);
  if (!policyRolesFor(m, r.doc).includes(role)) throw new Refused('not_authorized', `this passkey is not on the roster as ${role} for this business`);
  if (m.userId === r.doc.createdBy.userId) throw new Refused('requester_cannot_approve', 'the person who proposed the policy cannot approve it');
  if (r.decisions.some((d) => d.userId === m.userId)) throw new Refused('already_decided', 'each person decides once; a second approval must come from someone else');
  r.decisions.push({ userId: m.userId, name: m.name, role, decision, credentialSha256: credentialSha256(m), at: now.toISOString() });
  r.updatedAt = now.toISOString();
  if (decision === 'reject') { r.status = 'REJECTED'; return r.status; }
  return policyQuorum(r.doc, approvalsOf(r), customerSignoff) ? 'ACTIVE' : 'AWAITING_APPROVAL';
}

/** Sign the policy with the approvals that made the quorum; it is then active. */
export function signPolicy(r: PolicyRecord, k: { key: KeyObject; kid: string }, now: Date) {
  r.signature = edSign(null, policySigningBytes(r.doc, approvalsOf(r)), k.key).toString('base64');
  r.kid = k.kid; r.status = 'ACTIVE'; r.updatedAt = now.toISOString();
}

export function verifyPolicy(r: PolicyRecord, publicKey: KeyObject): boolean {
  if (!r.signature) return false;
  try { return edVerify(null, policySigningBytes(r.doc, approvalsOf(r)), publicKey, Buffer.from(r.signature, 'base64')); } catch { return false; }
}

/**
 * Decide a plan the portal proposes under a policy. On success the plan is
 * signed with the policy's approvers as its approvers — the agent then
 * checks them as it checks any plan's: two, distinct, not the requester —
 * and the ledger records it. Everything the portal says about the policy,
 * the risk and the approvals is re-derived here.
 */
export function signUnderPolicy(
  r: PolicyRecord, raw: { plan?: unknown; policyDigest?: unknown; evidence?: unknown }, k: { key: KeyObject; kid: string },
  business: Policy, now: Date, pins: DevicePins = () => null,
): { job: JobRecord; entry: LedgerEntry } {
  const { plan, digest } = admitPlan(raw.plan, business, now);
  // v0.34: a computer's result key is whatever this signer pinned for it
  // first. A policy naming another key for the same computer signs nothing.
  const changed = pinConflicts(r.doc.rings.flat(), pins);
  if (changed.length) throw new Refused('device_key_changed', deviceKeyChangedMessage(changed));
  const ev = raw.evidence == null ? null : RingEvidenceSchema.safeParse(raw.evidence);
  if (ev && !ev.success) throw new Refused('bad_evidence', ev.error.issues.slice(0, 2).map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
  const req: PolicyPlanRequest = { plan, policyDigest: typeof raw.policyDigest === 'string' ? raw.policyDigest : '', evidence: ev ? ev.data! : null };
  const decision: PolicyDecision = evaluatePolicyPlan({
    doc: r.doc, digest: r.digest, status: effectivePolicyStatus(r, now), approvals: approvalsOf(r),
    signatureValid: verifyPolicy(r, createPublicKey(k.key)), revokedAt: r.revokedAt, ledger: r.ledger,
  }, req, { now, customerSignoff: policyFor(business, r.doc.businessId).customerSignoff });
  if (!decision.ok) throw new Refused(decision.code, decision.message);
  const job: JobRecord = {
    jobId: plan.jobId, status: 'AWAITING_APPROVAL', plan, digest,
    decisions: r.decisions.filter((d) => d.decision === 'approve'), envelope: null, createdAt: now.toISOString(), updatedAt: now.toISOString(),
  };
  signJob(job, k, now);
  const p = plan.params as { updates: { updateId: string; revision: number }[] };
  const entry: LedgerEntry = {
    jobId: plan.jobId, deploymentId: plan.display!.deployment!.id, ring: plan.display!.deployment!.ring, signedAt: now.toISOString(),
    notBefore: plan.window.notBefore, notAfter: plan.window.notAfter, endpointIds: plan.targets.map((t) => t.endpointId), updates: p.updates.map((u) => `${u.updateId}@${u.revision}`),
    // Each computer's signed result must name exactly these bytes (v0.34).
    planSha256: createHash('sha256').update(Buffer.from(job.envelope!.plan, 'base64')).digest('hex'),
  };
  r.ledger.push(entry); r.updatedAt = now.toISOString();
  return { job, entry };
}

// ── Device result keys (v0.34) ──────────────────────────────────────────────
// A patch policy binds each computer to the key it signs its results with.
// The key reaches the portal from the computer's own signed scans, and the
// portal puts it in the policy; two approvers approving the policy is what
// makes this process trust it. From then on it is pinned here, write-once,
// to that computer's enrolled identity (endpoint, RustDesk ID, device-secret
// hash): a later policy naming another key for the same computer is refused
// (`device_key_changed`) until the operator forgets the pin. So a portal
// compromised after a computer's first approved policy cannot substitute a
// key of its choosing. Before that first approval it could, which is the
// trust-on-first-use window docs/staged-patching.md describes: comparing the
// fingerprint on the approval page with `rem0te-agent.exe status` on the
// computer closes it.

export { resultKeyFingerprint };

export interface DevicePin { identity: string; endpointId: string; hostname: string; resultKey: string; policyId: string; pinnedAt: string }
/** The pinned key for an identity, or null. */
export type DevicePins = (identity: string) => DevicePin | null;

export const deviceIdentity = (c: Pick<PolicyComputer, 'endpointId' | 'rustdeskId' | 'deviceSecretSha256'>) =>
  createHash('sha256').update(`rem0te-device-identity-v1\n${c.endpointId}\n${c.rustdeskId}\n${c.deviceSecretSha256}`).digest('hex');

/** Computers in a policy whose key is not the one pinned for them. */
export function pinConflicts(computers: PolicyComputer[], pins: DevicePins): { computer: PolicyComputer; pin: DevicePin }[] {
  const out: { computer: PolicyComputer; pin: DevicePin }[] = [];
  for (const c of computers) {
    if (!c.resultKey) continue;
    const pin = pins(deviceIdentity(c));
    if (pin && pin.resultKey !== c.resultKey) out.push({ computer: c, pin });
  }
  return out;
}

export function deviceKeyChangedMessage(changed: { computer: PolicyComputer; pin: DevicePin }[]): string {
  const c = changed[0];
  return `${c.computer.hostname}: this policy names a result key other than the one pinned for this computer on ${c.pin.pinnedAt} (policy ${c.pin.policyId}). If the computer really has a new key, the signer's operator removes the pin (device-key forget) and a new policy is approved.${changed.length > 1 ? ` ${changed.length - 1} more computer(s) likewise.` : ''}`;
}

/** The pins an approved policy makes: every computer with a key and no pin yet. */
export function newPins(r: PolicyRecord, pins: DevicePins, now: Date): DevicePin[] {
  return r.doc.rings.flat()
    .filter((c) => c.resultKey && !pins(deviceIdentity(c)))
    .map((c) => ({ identity: deviceIdentity(c), endpointId: c.endpointId, hostname: c.hostname, resultKey: c.resultKey!, policyId: r.policyId, pinnedAt: now.toISOString() }));
}

// ── The script allowlist (v0.34) ────────────────────────────────────────────
// The signer's own list of script hashes it will sign a run of, on its own
// disk. The portal proposes an entry (the content and what the library says
// about it); this process hashes the content itself, and two roster
// approvers who did not write it read it on this process's origin and add
// it. Nothing over HTTP edits an entry, and revocation is one-way: a revoked
// content hash can never be proposed again.

export type ScriptStatus = 'AWAITING_APPROVAL' | 'ACTIVE' | 'REJECTED' | 'REVOKED';
export interface ScriptAllowRecord {
  id: string;
  status: Exclude<ScriptStatus, 'REVOKED'>;
  proposal: ScriptProposal;
  /** Computed here from the content, never taken from the portal. */
  contentSha256: string;
  definitionSha256: string;
  decisions: Decision[];
  revokedAt: string | null;
  revokedBy: 'portal' | 'operator' | null;
  revokeReason: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Accept a proposed allowlist entry. The content is hashed here and must match what the portal claims. */
export function admitScriptProposal(raw: unknown, now: Date): ScriptAllowRecord {
  const parsed = ScriptProposal.safeParse(raw);
  if (!parsed.success) throw new Refused('invalid_script', parsed.error.issues.slice(0, 3).map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
  const p = parsed.data;
  const bad = contentProblem(p.content);
  if (bad) throw new Refused('invalid_script', bad);
  const sha = sha256Hex(p.content);
  if (sha !== p.contentSha256) throw new Refused('hash_mismatch', `the content hashes to ${sha}, not the ${p.contentSha256} the portal named`);
  if (p.contributors.some((c) => c.userId === p.reviewedBy.userId)) throw new Refused('invalid_script', 'the library reviewer is listed as a contributor');
  const block = scriptBlockOf(p);
  return {
    id: p.allowlistId, status: 'AWAITING_APPROVAL', proposal: p, contentSha256: block.contentSha256, definitionSha256: block.definitionSha256,
    decisions: [], revokedAt: null, revokedBy: null, revokeReason: null, createdAt: now.toISOString(), updatedAt: now.toISOString(),
  };
}

export const effectiveScriptStatus = (r: ScriptAllowRecord): ScriptStatus => (r.revokedAt ? 'REVOKED' : r.status);

/** Who may decide an entry: an approver for the script's business, or for every business ('*') for a global script. */
export function scriptRolesFor(m: RosterMember, r: ScriptAllowRecord): Role[] {
  if (m.disabled) return [];
  const biz = r.proposal.businessId;
  return m.approve.includes('*') || (biz !== null && m.approve.includes(biz)) ? ['approver'] : [];
}

/** Record one verified decision on an entry. Throws on anything that does not count. */
export function recordScriptDecision(r: ScriptAllowRecord, m: RosterMember, decision: 'approve' | 'reject', now: Date): ScriptStatus {
  const st = effectiveScriptStatus(r);
  if (st !== 'AWAITING_APPROVAL') throw new Refused('not_awaiting', `this script is ${st.toLowerCase().replace(/_/g, ' ')}`);
  if (!scriptRolesFor(m, r).length) throw new Refused('not_authorized', r.proposal.businessId ? 'this passkey is not on the roster as an approver for this business' : 'a global script is added by approvers for every business');
  if (m.userId === r.proposal.proposedBy.userId) throw new Refused('requester_cannot_approve', 'the person who proposed it cannot approve it');
  if (r.proposal.contributors.some((c) => c.userId === m.userId)) throw new Refused('contributor_cannot_approve', 'you wrote or edited this script, so someone else must approve it');
  if (r.decisions.some((d) => d.userId === m.userId)) throw new Refused('already_decided', 'each person decides once; a second approval must come from someone else');
  r.decisions.push({ userId: m.userId, name: m.name, role: 'approver', decision, credentialSha256: credentialSha256(m), at: now.toISOString() });
  r.updatedAt = now.toISOString();
  if (decision === 'reject') { r.status = 'REJECTED'; return r.status; }
  if (new Set(r.decisions.filter((d) => d.decision === 'approve').map((d) => d.userId)).size >= SCRIPT_ALLOWLIST_APPROVALS) r.status = 'ACTIVE';
  return r.status;
}
