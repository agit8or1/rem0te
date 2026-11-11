import { Injectable, ServiceUnavailableException } from '@nestjs/common';

/**
 * The portal's view of the approval signer (v0.26): its internal listener on
 * loopback. The portal can propose, poll and cancel. Nothing here can decide
 * or sign — that needs passkeys on the signer's own roster.
 */
@Injectable()
export class SignerClient {
  base(): string | null {
    const u = process.env.APPROVAL_SIGNER_INTERNAL_URL;
    if (!u) return null;
    try {
      const url = new URL(u);
      // Loopback only: the internal listener is never exposed.
      if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) return null;
      return url.origin;
    } catch { return null; }
  }
  configured() { return !!this.base(); }

  private async call<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<{ status: number; body: T }> {
    const b = this.base();
    if (!b) throw new ServiceUnavailableException({ code: 'APPROVAL_SIGNER_NOT_CONFIGURED', message: 'Approved actions need the approval signer (APPROVAL_SIGNER_INTERNAL_URL).' });
    let r: Response;
    try {
      r = await fetch(`${b}${path}`, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined, redirect: 'error', signal: AbortSignal.timeout(10_000) });
    } catch {
      throw new ServiceUnavailableException({ code: 'APPROVAL_SIGNER_UNREACHABLE', message: 'The approval signer is not answering.' });
    }
    return { status: r.status, body: (await r.json().catch(() => ({}))) as T };
  }

  policy(businessId: string) { return this.call<{ customerSignoff: boolean }>('GET', `/internal/v1/policy/${encodeURIComponent(businessId)}`); }
  submit(plan: unknown) { return this.call<{ jobId?: string; digest?: string; status?: string; approvalUrl?: string; error?: string; message?: string }>('POST', '/internal/v1/plans', { plan }); }
  status(jobId: string) {
    return this.call<{ status?: string; digest?: string; decisions?: { name: string; role: string; decision: string; at: string }[]; envelope?: { schema: string; kid: string; plan: string; sig: string } | null; error?: string }>('GET', `/internal/v1/plans/${jobId}`);
  }
  cancel(jobId: string) { return this.call<{ status?: string }>('POST', `/internal/v1/plans/${jobId}/cancel`); }
  // ── Patch policies (v0.32) ────────────────────────────────────────────────
  // The portal proposes a policy and may revoke one. It cannot approve one
  // (that is passkeys on the signer's own page), cannot un-revoke one, and
  // cannot make the signer sign a plan the policy does not cover.
  capabilities() { return this.call<{ patchPolicies?: number; kid?: string; roster?: { approvers: number } }>('GET', '/internal/v1/capabilities'); }
  keys() { return this.call<{ keys?: { kid: string }[] }>('GET', '/internal/v1/keys'); }
  submitPolicy(policy: unknown) { return this.call<{ policyId?: string; digest?: string; status?: string; approvalUrl?: string; error?: string; message?: string }>('POST', '/internal/v1/policies', { policy }); }
  policyStatus(id: string) {
    return this.call<{ status?: string; digest?: string; approvals?: { name: string; role: string; at: string }[]; revokedAt?: string | null; signedPlans?: number; refusals?: { at: string; jobId: string; code: string; message: string }[]; error?: string }>('GET', `/internal/v1/policies/${id}`);
  }
  revokePolicy(id: string, reason: string) { return this.call<{ status?: string; revokedAt?: string; error?: string }>('POST', `/internal/v1/policies/${id}/revoke`, { reason }); }
  /** Ask the signer to sign a ring plan under a policy. It decides; a refusal comes back as 409 with the code. */
  submitUnderPolicy(id: string, body: { plan: unknown; policyDigest: string; evidence: unknown }) {
    return this.call<{ jobId?: string; digest?: string; status?: string; approvalUrl?: string; error?: string; message?: string }>('POST', `/internal/v1/policies/${id}/plans`, body);
  }

  /** v0.28: ask the signer to hold a pause. It cannot be asked to lift one; its operator does that. */
  pause(p: { scope: 'global' | 'business'; businessId?: string; reason: string; ref: string }) { return this.call<{ id?: string; error?: string }>('POST', '/internal/v1/pauses', p); }
  pauses() { return this.call<{ pauses?: { id: string; scope: string; businessId?: string; reason: string; setBy: string; at: string; ref?: string }[] }>('GET', '/internal/v1/pauses'); }
}
