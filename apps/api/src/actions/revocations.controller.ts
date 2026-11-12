import { Controller, Get, Injectable, Res, ServiceUnavailableException } from '@nestjs/common';
import type { Response } from 'express';
import { Public } from '../common/decorators/public.decorator';
import { SignerClient } from './signer.client';

/** How long one signed statement is handed out before the signer is asked again. */
export const REVOCATION_RELAY_SECONDS = 5;
const ENVELOPE_SCHEMA = 'rem0te-revocations-envelope/1';

/**
 * The approval signer's revocation statement (v0.36), as the portal relays
 * it. Asked for at most every few seconds (each one is a signature on the
 * signer), and asked again at once after the portal itself revokes
 * something — so a revocation made here reaches the next agent that asks —
 * or stores a newly signed plan, so that plan's first delivery is never
 * held back by a cached statement older than its signature.
 * One the signer's operator makes from its CLI arrives within
 * REVOCATION_RELAY_SECONDS.
 */
@Injectable()
export class RevocationRelay {
  private cached: { at: number; body: string } | null = null;
  private generation = 0;
  constructor(private readonly signer: SignerClient) {}

  /** Forget the cached statement: something was just revoked, or a plan just signed. */
  invalidate() { this.cached = null; this.generation++; }

  async current(): Promise<string> {
    const now = Date.now();
    if (this.cached && now - this.cached.at < REVOCATION_RELAY_SECONDS * 1000) return this.cached.body;
    const gen = this.generation;
    if (!this.signer.configured()) throw new ServiceUnavailableException({ code: 'APPROVAL_SIGNER_NOT_CONFIGURED', message: 'There is no approval signer, so there is no revocation statement.' });
    const r = await this.signer.revocations();
    if (r.status !== 200 || r.body.schema !== ENVELOPE_SCHEMA || typeof r.body.statement !== 'string' || typeof r.body.sig !== 'string' || typeof r.body.kid !== 'string') {
      throw new ServiceUnavailableException({ code: 'APPROVAL_SIGNER_UNREACHABLE', message: 'The approval signer did not give a revocation statement.' });
    }
    const body = JSON.stringify({ schema: r.body.schema, kid: r.body.kid, statement: r.body.statement, sig: r.body.sig });
    // Asked for before an invalidation landed: hand it to this caller, keep none.
    if (gen === this.generation) this.cached = { at: now, body };
    return body;
  }
}

/**
 * GET /public/approval/revocations.json — the statement, for agents.
 *
 * Public, like the signed update mirror beside it: the agent fetching it
 * holds no session, and what it carries — revoked script content hashes and
 * archived software catalog entry ids, the same for every business — tells
 * nobody anything they could act on. It is signed by the signer's
 * job-approval key and verified by the agent against approval/keys.json from
 * the offline-rooted update chain, so this route can withhold or delay it
 * but not forge, edit or shrink it. The four envelope fields are passed on
 * as the signer gave them; the signed bytes are inside, base64.
 *
 * Withholding is not free either: the agent runs a plan only with a
 * statement at least as new as the plan's signature, so a portal that stops
 * relaying gets nothing new run (docs/script-library.md, "Revocation").
 */
@Controller('public/approval')
export class RevocationRelayController {
  constructor(private readonly relay: RevocationRelay) {}

  @Get('revocations.json')
  @Public()
  async revocations(@Res() res: Response) {
    const body = await this.relay.current();
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.send(body);
  }
}
