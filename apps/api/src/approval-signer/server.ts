/**
 * The approval signer's two listeners (v0.26).
 *
 *   internal  (127.0.0.1 only; the portal):  POST /internal/v1/plans,
 *             GET /internal/v1/plans/:id, POST /internal/v1/plans/:id/cancel,
 *             GET /internal/v1/policy/:businessId, GET /internal/v1/keys,
 *             GET/POST /internal/v1/pauses (v0.28: the portal may ADD a
 *             pause; nothing over HTTP clears one — that is the operator CLI)
 *   public    (behind the reverse proxy, on its OWN origin — not the
 *             portal's, so no script the portal serves can reach into it):
 *             GET /approve/:id, GET /approve/:id/state,
 *             POST /approve/:id/challenge, POST /approve/:id/decide
 *
 * The portal can propose and poll. It cannot decide: a decision is a passkey
 * assertion that this process verifies against its own roster.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { randomBytes } from 'node:crypto';
import { verifyAuthenticationResponse, type AuthenticationResponseJSON } from '@simplewebauthn/server';
import { catalogEntry } from '../actions/catalog';
import {
  admitPlan, credentialSha256, webauthnChallenge, loadSigningKey, policyFor, recordDecision, Refused, rolesFor, signJob, keysDocument,
  admitPolicy, approvalsOf, effectivePolicyStatus, policyRolesFor, recordPolicyDecision, signPolicy, signUnderPolicy,
  type Challenge, type JobRecord, type PolicyRecord, type Role,
} from './core';
import { SignerStore } from './store';
import { renderApprovalPage, renderPolicyApprovalPage } from './page';

export interface SignerConfig {
  dir: string;
  /** e.g. https://approve.example.com — the origin approvers' browsers load. */
  origin: string;
  rpId: string;
  publicPort: number;
  internalPort: number;
  host?: string;
  now?: () => Date;
}

const CHALLENGE_TTL_MS = 5 * 60_000;
const MAX_BODY = 64 * 1024;
/** A ring plan under a policy carries the previous ring's evidence: up to 25 computers. */
const MAX_POLICY_PLAN_BODY = 512 * 1024;

function send(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  res.writeHead(status, {
    'content-type': typeof body === 'string' ? 'text/html; charset=utf-8' : 'application/json',
    'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer',
    ...headers,
  });
  res.end(text);
}
async function body(req: IncomingMessage, max = MAX_BODY): Promise<unknown> {
  const chunks: Buffer[] = []; let n = 0;
  for await (const c of req) { n += (c as Buffer).length; if (n > max) throw new Refused('too_large'); chunks.push(c as Buffer); }
  try { return chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}; } catch { throw new Refused('bad_json'); }
}
const fail = (res: ServerResponse, e: unknown) => {
  if (e instanceof Refused) return send(res, e.code === 'not_found' ? 404 : e.code === 'not_authorized' || e.code === 'requester_cannot_approve' ? 403 : 409, { error: e.code, message: e.message });
  console.error('[approval-signer]', e);
  return send(res, 500, { error: 'internal' });
};

/** Public view of a policy: what an approver needs, nothing about the roster. */
function policyView(r: PolicyRecord, now: Date) {
  return {
    policyId: r.policyId, status: effectivePolicyStatus(r, now), digest: r.digest, doc: r.doc,
    decisions: r.decisions.map((d) => ({ name: d.name, role: d.role, decision: d.decision, at: d.at })),
    revokedAt: r.revokedAt, revokeReason: r.revokeReason, signedPlans: r.ledger.length,
  };
}

/** Public view of a job: what an approver needs, nothing about the roster. */
function view(j: JobRecord) {
  const a = catalogEntry(j.plan.action.id, j.plan.action.version)!;
  return {
    jobId: j.jobId, status: j.status, digest: j.digest, plan: j.plan,
    action: { title: a.title, description: a.description, warnings: a.warnings, verification: a.verification, doesNotProve: a.doesNotProve },
    decisions: j.decisions.map((d) => ({ name: d.name, role: d.role, decision: d.decision, at: d.at })),
  };
}

export function startSigner(cfg: SignerConfig): { internal: Server; pub: Server; close: () => Promise<void> } {
  const store = new SignerStore(cfg.dir);
  const k = loadSigningKey(store.keyPem());
  const now = () => (cfg.now ? cfg.now() : new Date());
  const host = cfg.host ?? '127.0.0.1';

  const expireIfDue = (j: JobRecord) => {
    if (j.status === 'AWAITING_APPROVAL' && Date.parse(j.plan.window.notAfter) <= now().getTime()) { j.status = 'EXPIRED'; store.saveJob(j); }
    return j;
  };

  const assertNotPaused = (businessId: string) => {
    const p = store.activePause(businessId);
    if (p) throw new Refused('paused', `the approval signer is paused${p.scope === 'business' ? ' for this business' : ''}: ${p.reason}`);
  };
  const remember = (r: PolicyRecord, jobId: string, e: Refused) => {
    r.refusals = [...r.refusals, { at: now().toISOString(), jobId, code: e.code, message: e.message.slice(0, 300) }].slice(-50);
    store.savePatchPolicy(r);
    console.log(`[approval-signer] refused a plan under policy ${r.policyId}: ${e.code} — ${e.message}`);
  };

  /** The roster member whose passkey made this assertion over this challenge, or a refusal. Records the counter. */
  async function verifiedMember(c: Challenge, assertion: AuthenticationResponseJSON | undefined) {
    const member = store.roster().members.find((x) => x.credentialId === assertion?.id);
    if (!member || !assertion) throw new Refused('not_authorized', 'this passkey is not on the approval roster');
    let v: Awaited<ReturnType<typeof verifyAuthenticationResponse>>;
    try {
      v = await verifyAuthenticationResponse({
        response: assertion, expectedChallenge: webauthnChallenge(c), expectedOrigin: cfg.origin, expectedRPID: cfg.rpId, requireUserVerification: true,
        credential: { id: member.credentialId, publicKey: new Uint8Array(Buffer.from(member.publicKey, 'base64url')), counter: Math.max(member.counter, store.counter(credentialSha256(member))) },
      });
    } catch (e) { throw new Refused('not_authorized', `passkey verification failed: ${(e as Error).message.slice(0, 120)}`); }
    if (!v.verified) throw new Refused('not_authorized', 'passkey verification failed');
    store.saveCounter(credentialSha256(member), v.authenticationInfo.newCounter);
    return member;
  }

  const pageHeaders = (nonce: string) => ({
    'content-security-policy': `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self'; img-src 'none'; frame-ancestors 'none'; form-action 'none'; base-uri 'none'`,
    'x-frame-options': 'DENY',
  });

  /** The public approval pages for a policy: the same passkeys, roster and origin rules as a plan's. */
  async function publicPolicy(req: IncomingMessage, res: ServerResponse, id: string, sub: string | undefined) {
    const r = store.patchPolicy(id);
    if (!r) return send(res, 404, { error: 'not_found' });
    if (req.method === 'GET' && !sub) {
      const nonce = randomBytes(16).toString('base64');
      return send(res, 200, renderPolicyApprovalPage(policyView(r, now()), nonce), pageHeaders(nonce));
    }
    if (req.method === 'GET' && sub === '/state') return send(res, 200, policyView(r, now()));
    if (req.method !== 'POST') return send(res, 405, { error: 'method_not_allowed' });
    if (req.headers.origin !== cfg.origin) throw new Refused('not_authorized', 'cross-origin request refused');
    const b = await body(req) as { decision?: string; role?: string; challengeId?: string; assertion?: AuthenticationResponseJSON };
    const p = store.activePause(r.doc.businessId);
    if (p) throw new Refused('paused', `approvals are paused${p.scope === 'business' ? ' for this business' : ''}: ${p.reason}`);
    if (sub === '/challenge') {
      const decision = b.decision === 'reject' ? 'reject' : b.decision === 'approve' ? 'approve' : null;
      const role = b.role === 'customer' ? 'customer' : b.role === 'approver' ? 'approver' : null;
      if (!decision || !role) throw new Refused('bad_request', 'decision and role are required');
      const st = effectivePolicyStatus(r, now());
      if (st !== 'AWAITING_APPROVAL') throw new Refused('not_awaiting', `this policy is ${st.toLowerCase().replace(/_/g, ' ')}`);
      const c: Challenge = { id: randomBytes(32).toString('base64url'), kind: 'policy', jobId: r.policyId, digest: r.digest, decision, role, expiresAt: new Date(now().getTime() + CHALLENGE_TTL_MS).toISOString(), used: false };
      store.saveChallenge(c);
      return send(res, 200, { challengeId: c.id, options: { challenge: webauthnChallenge(c), rpId: cfg.rpId, timeout: CHALLENGE_TTL_MS, userVerification: 'required', allowCredentials: [] } });
    }
    // /decide
    const out = await store.exclusive(async () => {
      const c = b.challengeId ? store.challenge(b.challengeId) : null;
      if (!c || c.kind !== 'policy' || c.jobId !== r.policyId) throw new Refused('bad_challenge');
      if (c.used) throw new Refused('challenge_used', 'this approval prompt was already used');
      if (Date.parse(c.expiresAt) <= now().getTime()) throw new Refused('challenge_expired');
      c.used = true; store.saveChallenge(c);
      const cur = store.patchPolicy(r.policyId)!;
      if (cur.digest !== c.digest) throw new Refused('plan_changed');
      const member = await verifiedMember(c, b.assertion);
      if (store.activePause(cur.doc.businessId)) throw new Refused('paused', 'approvals were paused while you decided');
      const status = recordPolicyDecision(cur, member, c.role as Role, c.decision, now(), policyFor(store.policy(), cur.doc.businessId).customerSignoff);
      if (status === 'ACTIVE') signPolicy(cur, k, now());
      store.savePatchPolicy(cur);
      if (status === 'ACTIVE') console.log(`[approval-signer] policy ${cur.policyId} approved; plans inside it are now signed without further approval until ${cur.doc.expiresAt}`);
      return { cur, member };
    });
    return send(res, 200, { ...policyView(out.cur, now()), you: { name: out.member.name, credential: credentialSha256(out.member).slice(0, 16), roles: policyRolesFor(out.member, out.cur.doc) } });
  }

  // ── internal: patch policies (v0.32) ──────────────────────────────────────
  //   POST /internal/v1/policies               propose (awaits two approvals here)
  //   GET  /internal/v1/policies/:id           status, for the portal to mirror
  //   POST /internal/v1/policies/:id/revoke    one-way: nothing un-revokes
  //   POST /internal/v1/policies/:id/plans     sign a ring plan, if it is inside the policy
  async function internalPolicy(req: IncomingMessage, res: ServerResponse, [id, sub]: [string | undefined, string | undefined]) {
    if (!id) {
      if (req.method !== 'POST') return send(res, 405, { error: 'method_not_allowed' });
      const b = await body(req) as { policy?: unknown };
      const out = await store.exclusive(() => {
        const { doc, digest } = admitPolicy(b.policy, now());
        assertNotPaused(doc.businessId);
        const existing = store.patchPolicy(doc.policyId);
        if (existing) {
          if (existing.digest !== digest) throw new Refused('policy_id_reused', 'a different policy already has this id');
          return existing;
        }
        const r: PolicyRecord = {
          policyId: doc.policyId, status: 'AWAITING_APPROVAL', doc, digest, decisions: [], signature: null, kid: null,
          revokedAt: null, revokedBy: null, revokeReason: null, ledger: [], refusals: [], createdAt: now().toISOString(), updatedAt: now().toISOString(),
        };
        store.savePatchPolicy(r);
        return r;
      });
      return send(res, 201, { policyId: out.policyId, digest: out.digest, status: effectivePolicyStatus(out, now()), approvalUrl: `${cfg.origin}/approve/policy/${out.policyId}` });
    }
    const r0 = store.patchPolicy(id);
    if (!r0) return send(res, 404, { error: 'not_found' });
    if (req.method === 'GET' && !sub) {
      const v = policyView(r0, now());
      return send(res, 200, { ...v, approvals: approvalsOf(r0).map((a) => ({ name: a.name, role: a.role, at: a.at })), refusals: r0.refusals.slice(-10) });
    }
    if (req.method !== 'POST') return send(res, 405, { error: 'method_not_allowed' });
    if (sub === 'revoke') {
      const b = await body(req) as { reason?: unknown };
      if (typeof b.reason !== 'string' || b.reason.trim().length < 3) throw new Refused('bad_request', 'a reason is required');
      const out = await store.exclusive(() => {
        const reason = [...b.reason as string].slice(0, 300).map((c) => (c < ' ' ? ' ' : c)).join('');
        if (store.revokePatchPolicy(id, { at: now().toISOString(), by: 'portal', reason })) console.log(`[approval-signer] policy ${id} revoked at the portal's request: ${reason}`);
        return store.patchPolicy(id)!;
      });
      return send(res, 200, { policyId: out.policyId, status: 'REVOKED', revokedAt: out.revokedAt });
    }
    // sub === 'plans'
    const b = await body(req, MAX_POLICY_PLAN_BODY) as { plan?: { jobId?: unknown }; policyDigest?: unknown; evidence?: unknown };
    const out = await store.exclusive(() => {
      const r = store.patchPolicy(id)!;
      const jobId = typeof b.plan?.jobId === 'string' && /^[a-f0-9]{32}$/.test(b.plan.jobId) ? b.plan.jobId : '-';
      try {
        assertNotPaused(r.doc.businessId);
        const existing = jobId !== '-' ? store.job(jobId) : null;
        if (existing) {
          // The same plan again (a retried request): the same answer. Anything else under this id is refused.
          const again = admitPlan(b.plan, store.policy(), now());
          if (existing.digest !== again.digest || !r.ledger.some((e) => e.jobId === jobId)) throw new Refused('job_id_reused', 'a different plan already has this job id');
          return existing;
        }
        const { job } = signUnderPolicy(r, b, k, store.policy(), now());
        store.saveJob(job);
        store.savePatchPolicy(r);
        console.log(`[approval-signer] signed ${job.jobId} under policy ${r.policyId} (ring ${job.plan.display?.deployment?.ring}, ${job.plan.targets.length} computer(s))`);
        return job;
      } catch (e) {
        if (e instanceof Refused) remember(r, jobId, e);
        throw e;
      }
    });
    return send(res, 201, { jobId: out.jobId, digest: out.digest, status: out.status, approvalUrl: `${cfg.origin}/approve/${out.jobId}` });
  }

  // ── internal ──────────────────────────────────────────────────────────────
  const internal = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://internal');
      const m = planRoute(url.pathname);
      if (req.method === 'GET' && url.pathname === '/internal/v1/keys') return send(res, 200, keysDocument([k]));
      const pm = url.pathname.match(/^\/internal\/v1\/policy\/([A-Za-z0-9_-]{8,64})$/);
      if (req.method === 'GET' && pm) return send(res, 200, policyFor(store.policy(), pm[1]));
      if (url.pathname === '/internal/v1/pauses') {
        if (req.method === 'GET') return send(res, 200, { pauses: store.pauses().filter((p) => !p.clearedAt) });
        if (req.method !== 'POST') return send(res, 405, { error: 'method_not_allowed' });
        const b = await body(req) as { scope?: string; businessId?: string; reason?: string; ref?: string };
        const scope = b.scope === 'global' ? 'global' : b.scope === 'business' ? 'business' : null;
        if (!scope || (scope === 'business' && !/^[A-Za-z0-9_-]{8,64}$/.test(b.businessId ?? '')) || typeof b.reason !== 'string' || b.reason.length < 3) throw new Refused('bad_request', 'scope, businessId (for a business) and reason are required');
        const p = await store.exclusive(() => store.addPause({
          scope, ...(scope === 'business' ? { businessId: b.businessId } : {}), reason: [...(b.reason ?? '').slice(0, 200)].map((c) => (c < ' ' ? ' ' : c)).join(''),
          setBy: 'portal', ...(typeof b.ref === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(b.ref) ? { ref: b.ref } : {}), at: now().toISOString(),
        }));
        console.log(`[approval-signer] paused (${p.scope}${p.businessId ? ` ${p.businessId}` : ''}) at the portal's request: ${p.reason}`);
        return send(res, 201, { id: p.id });
      }
      // v0.32: what this signer supports, and how many people could approve —
      // a count only, for the portal's pre-flight check. Who they are stays here.
      if (req.method === 'GET' && url.pathname === '/internal/v1/capabilities') {
        const people = new Set(store.roster().members.filter((x) => !x.disabled && x.approve.length).map((x) => x.userId));
        return send(res, 200, { patchPolicies: 1, kid: k.kid, roster: { approvers: people.size } });
      }
      const pol = policyRoute(url.pathname);
      if (pol) return await internalPolicy(req, res, pol);
      if (!m) return send(res, 404, { error: 'not_found' });
      if (req.method === 'POST' && !m[1]) {
        const b = await body(req) as { plan?: unknown };
        const out = await store.exclusive(() => {
          const { plan, digest } = admitPlan(b.plan, store.policy(), now());
          const held = store.activePause(plan.targets[0]?.businessId ?? null);
          if (held) throw new Refused('paused', `the approval signer is paused${held.scope === 'business' ? ' for this business' : ''}: ${held.reason}`);
          const existing = store.job(plan.jobId);
          if (existing) {
            if (existing.digest !== digest) throw new Refused('job_id_reused', 'a different plan already has this job id');
            return existing;
          }
          const j: JobRecord = { jobId: plan.jobId, status: 'AWAITING_APPROVAL', plan, digest, decisions: [], envelope: null, createdAt: now().toISOString(), updatedAt: now().toISOString() };
          store.saveJob(j);
          return j;
        });
        return send(res, 201, { jobId: out.jobId, digest: out.digest, status: out.status, approvalUrl: `${cfg.origin}/approve/${out.jobId}` });
      }
      const j = m[1] ? store.job(m[1]) : null;
      if (!j) return send(res, 404, { error: 'not_found' });
      if (req.method === 'GET' && !m[2]) {
        expireIfDue(j);
        return send(res, 200, { jobId: j.jobId, status: j.status, digest: j.digest, decisions: view(j).decisions, envelope: j.envelope });
      }
      if (req.method === 'POST' && m[2]) {
        const out = await store.exclusive(() => {
          const cur = store.job(j.jobId)!;
          if (cur.status === 'AWAITING_APPROVAL') { cur.status = 'CANCELED'; cur.updatedAt = now().toISOString(); store.saveJob(cur); }
          return cur;
        });
        return send(res, 200, { jobId: out.jobId, status: out.status });
      }
      return send(res, 405, { error: 'method_not_allowed' });
    } catch (e) { return fail(res, e); }
  });

  // ── public ────────────────────────────────────────────────────────────────
  const pub = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', cfg.origin);
      const pm = url.pathname.match(/^\/approve\/policy\/([a-f0-9]{32})(\/state|\/challenge|\/decide)?$/);
      if (pm) return await publicPolicy(req, res, pm[1], pm[2]);
      const m = url.pathname.match(/^\/approve\/([a-f0-9]{32})(\/state|\/challenge|\/decide)?$/);
      if (!m) return send(res, 404, { error: 'not_found' });
      const j = store.job(m[1]);
      if (!j) return send(res, 404, { error: 'not_found' });
      expireIfDue(j);
      if (req.method === 'GET' && !m[2]) {
        const nonce = randomBytes(16).toString('base64');
        return send(res, 200, renderApprovalPage(view(j), nonce), {
          'content-security-policy': `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self'; img-src 'none'; frame-ancestors 'none'; form-action 'none'; base-uri 'none'`,
          'x-frame-options': 'DENY',
        });
      }
      if (req.method === 'GET' && m[2] === '/state') return send(res, 200, view(j));
      if (req.method !== 'POST') return send(res, 405, { error: 'method_not_allowed' });
      // A state-changing call must come from the approval origin itself.
      if (req.headers.origin !== cfg.origin) throw new Refused('not_authorized', 'cross-origin request refused');
      const b = await body(req) as { decision?: string; role?: string; challengeId?: string; assertion?: AuthenticationResponseJSON };

      // v0.28: while paused, nobody can decide, so nothing is signed.
      const held = store.activePause(j.plan.targets[0]?.businessId ?? null);
      if (held) throw new Refused('paused', `approvals are paused${held.scope === 'business' ? ' for this business' : ''}: ${held.reason}`);

      if (m[2] === '/challenge') {
        const decision = b.decision === 'reject' ? 'reject' : b.decision === 'approve' ? 'approve' : null;
        const role = b.role === 'customer' ? 'customer' : b.role === 'approver' ? 'approver' : null;
        if (!decision || !role) throw new Refused('bad_request', 'decision and role are required');
        if (j.status !== 'AWAITING_APPROVAL') throw new Refused('not_awaiting', `this plan is ${j.status.toLowerCase()}`);
        const c: Challenge = { id: randomBytes(32).toString('base64url'), jobId: j.jobId, digest: j.digest, decision, role, expiresAt: new Date(now().getTime() + CHALLENGE_TTL_MS).toISOString(), used: false };
        store.saveChallenge(c);
        return send(res, 200, { challengeId: c.id, options: { challenge: webauthnChallenge(c), rpId: cfg.rpId, timeout: CHALLENGE_TTL_MS, userVerification: 'required', allowCredentials: [] } });
      }

      // /decide
      const out = await store.exclusive(async () => {
        const c = b.challengeId ? store.challenge(b.challengeId) : null;
        // A policy's challenge is never a plan's (and the reverse): `kind` and the id both have to match.
        if (!c || c.jobId !== j.jobId || c.kind) throw new Refused('bad_challenge');
        if (c.used) throw new Refused('challenge_used', 'this approval prompt was already used');
        if (Date.parse(c.expiresAt) <= now().getTime()) throw new Refused('challenge_expired');
        c.used = true; store.saveChallenge(c); // consumed before verification: a failed attempt cannot be retried with it
        const cur = expireIfDue(store.job(j.jobId)!);
        if (cur.digest !== c.digest) throw new Refused('plan_changed');
        const member = await verifiedMember(c, b.assertion);
        if (store.activePause(cur.plan.targets[0]?.businessId ?? null)) throw new Refused('paused', 'approvals were paused while you decided');
        const status = recordDecision(cur, member, c.role as Role, c.decision, now());
        if (status === 'SIGNED') signJob(cur, k, now());
        store.saveJob(cur);
        return { cur, member };
      });
      return send(res, 200, { ...view(out.cur), you: { name: out.member.name, credential: credentialSha256(out.member).slice(0, 16), roles: rolesFor(out.member, out.cur.plan) } });
    } catch (e) { return fail(res, e); }
  });

  internal.listen(cfg.internalPort, '127.0.0.1');
  pub.listen(cfg.publicPort, host);
  return {
    internal, pub,
    close: () => Promise.all([new Promise<void>((r) => internal.close(() => r())), new Promise<void>((r) => pub.close(() => r()))]).then(() => undefined),
  };
}

/** /internal/v1/policies, /policies/<id>, /policies/<id>/(revoke|plans) → [id?, sub?]; else null. */
function policyRoute(p: string): [string | undefined, string | undefined] | null {
  const base = '/internal/v1/policies';
  if (p === base) return [undefined, undefined];
  if (!p.startsWith(`${base}/`)) return null;
  const rest = p.slice(base.length + 1).split('/');
  if (!/^[a-f0-9]{32}$/.test(rest[0])) return null;
  if (rest.length === 1) return [rest[0], undefined];
  if (rest.length === 2 && (rest[1] === 'revoke' || rest[1] === 'plans')) return [rest[0], rest[1]];
  return null;
}

/** /internal/v1/plans, /plans/<job>, /plans/<job>/cancel → [path, job?, '/cancel'?]; else null. */
function planRoute(p: string): [string, string | undefined, string | undefined] | null {
  const base = '/internal/v1/plans';
  if (p === base) return [p, undefined, undefined];
  if (!p.startsWith(`${base}/`)) return null;
  const rest = p.slice(base.length + 1).split('/');
  if (!/^[a-f0-9]{32}$/.test(rest[0])) return null;
  if (rest.length === 1) return [p, rest[0], undefined];
  if (rest.length === 2 && rest[1] === 'cancel') return [p, rest[0], '/cancel'];
  return null;
}

