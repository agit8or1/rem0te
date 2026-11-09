/**
 * The approval signer's two listeners (v0.26).
 *
 *   internal  (127.0.0.1 only; the portal):  POST /internal/v1/plans,
 *             GET /internal/v1/plans/:id, POST /internal/v1/plans/:id/cancel,
 *             GET /internal/v1/policy/:businessId, GET /internal/v1/keys
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
  type Challenge, type JobRecord, type Role,
} from './core';
import { SignerStore } from './store';
import { renderApprovalPage } from './page';

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

function send(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  res.writeHead(status, {
    'content-type': typeof body === 'string' ? 'text/html; charset=utf-8' : 'application/json',
    'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer',
    ...headers,
  });
  res.end(text);
}
async function body(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []; let n = 0;
  for await (const c of req) { n += (c as Buffer).length; if (n > MAX_BODY) throw new Refused('too_large'); chunks.push(c as Buffer); }
  try { return chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}; } catch { throw new Refused('bad_json'); }
}
const fail = (res: ServerResponse, e: unknown) => {
  if (e instanceof Refused) return send(res, e.code === 'not_found' ? 404 : e.code === 'not_authorized' || e.code === 'requester_cannot_approve' ? 403 : 409, { error: e.code, message: e.message });
  console.error('[approval-signer]', e);
  return send(res, 500, { error: 'internal' });
};

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

  // ── internal ──────────────────────────────────────────────────────────────
  const internal = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://internal');
      const m = planRoute(url.pathname);
      if (req.method === 'GET' && url.pathname === '/internal/v1/keys') return send(res, 200, keysDocument([k]));
      const pm = url.pathname.match(/^\/internal\/v1\/policy\/([A-Za-z0-9_-]{8,64})$/);
      if (req.method === 'GET' && pm) return send(res, 200, policyFor(store.policy(), pm[1]));
      if (!m) return send(res, 404, { error: 'not_found' });
      if (req.method === 'POST' && !m[1]) {
        const b = await body(req) as { plan?: unknown };
        const out = await store.exclusive(() => {
          const { plan, digest } = admitPlan(b.plan, store.policy(), now());
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
        if (!c || c.jobId !== j.jobId) throw new Refused('bad_challenge');
        if (c.used) throw new Refused('challenge_used', 'this approval prompt was already used');
        if (Date.parse(c.expiresAt) <= now().getTime()) throw new Refused('challenge_expired');
        c.used = true; store.saveChallenge(c); // consumed before verification: a failed attempt cannot be retried with it
        const cur = expireIfDue(store.job(j.jobId)!);
        if (cur.digest !== c.digest) throw new Refused('plan_changed');
        const member = store.roster().members.find((x) => x.credentialId === b.assertion?.id);
        if (!member || !b.assertion) throw new Refused('not_authorized', 'this passkey is not on the approval roster');
        let v: Awaited<ReturnType<typeof verifyAuthenticationResponse>>;
        try {
          v = await verifyAuthenticationResponse({
            response: b.assertion, expectedChallenge: webauthnChallenge(c), expectedOrigin: cfg.origin, expectedRPID: cfg.rpId, requireUserVerification: true,
            credential: { id: member.credentialId, publicKey: new Uint8Array(Buffer.from(member.publicKey, 'base64url')), counter: Math.max(member.counter, store.counter(credentialSha256(member))) },
          });
        } catch (e) { throw new Refused('not_authorized', `passkey verification failed: ${(e as Error).message.slice(0, 120)}`); }
        if (!v.verified) throw new Refused('not_authorized', 'passkey verification failed');
        store.saveCounter(credentialSha256(member), v.authenticationInfo.newCounter);
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

