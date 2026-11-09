import { Controller, Get, HttpCode, Param, Post, Query, Req, Res, UseFilters, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import { readFileSync } from 'fs';
import * as path from 'path';
import { Public } from '../common/decorators/public.decorator';
import { Throttle } from '@nestjs/throttler';
import { THROTTLER_BURST, THROTTLER_MAIN } from '../common/throttling';
import { CONTRACT, MAX_DELEGATION_TTL_S, MAX_JOB_TTL_S, MAX_REQUEST_BYTES } from './contract';
import { IntegrationExceptionFilter } from './errors';
import { IntegrationAuthGuard, type IntegrationRequest } from './integration-auth.guard';
import { IntegrationJobsService } from './jobs.service';
import { loadTrust } from './peers';

export const DELEGATION_HEADER = 'rem0te-delegation';

function version(): string {
  try {
    const f = process.env.VERSION_FILE ?? path.join(__dirname, '..', '..', '..', '..', '..', 'version.json');
    return (JSON.parse(readFileSync(f, 'utf8')) as { version?: string }).version ?? 'unknown';
  } catch { return 'unknown'; }
}

/**
 * Contract ticket-rmm-v1, rem0te side. Mounted at /api/integration/v1 (the
 * global /api/v1 prefix is excluded for it in main.ts).
 *
 * @Public() only takes the browser-session JwtAuthGuard out of the way;
 * IntegrationAuthGuard is the gate and refuses everything unsigned. An
 * `rk_` inventory API key is not a signature and gets 401 here — it cannot
 * submit, read, approve, launch or execute anything through this surface.
 */
@Controller('api/integration/v1')
@Public()
@UseGuards(IntegrationAuthGuard)
@UseFilters(IntegrationExceptionFilter)
// One ClientSt0r serves every organization from one address, so the per-IP
// defaults (20/s, 300/min) would throttle a whole MSP. Bounded, not lifted:
// every request still costs a signature check and a nonce insert.
@Throttle({ [THROTTLER_BURST]: { limit: 100, ttl: 1000 }, [THROTTLER_MAIN]: { limit: 3000, ttl: 60_000 } })
export class IntegrationController {
  constructor(private readonly jobs: IntegrationJobsService) {}

  @Get('capabilities')
  capabilities(@Req() req: IntegrationRequest) {
    const peer = req.integrationPeer!;
    const self = loadTrust()!.self;
    return {
      contract: CONTRACT,
      rem0te_version: version(),
      audience: peer.audience,
      peer_id: peer.id,
      features: {
        ticket_analysis: true,
        model_comparison: true,
        endpoint_evidence: ['inventory', 'heartbeat'],
        // Nothing executable in this release. Approved catalog actions arrive
        // with their own signing root, separate from this surface.
        actions: [],
      },
      model_profiles: peer.modelProfiles,
      limits: {
        max_model_profiles: 3,
        max_job_ttl_seconds: MAX_JOB_TTL_S,
        max_delegation_ttl_seconds: MAX_DELEGATION_TTL_S,
        max_request_bytes: MAX_REQUEST_BYTES,
      },
      signing_keys: [
        { kid: self.keyId, alg: 'Ed25519', public_key_pem: self.publicKeyPem },
        ...self.previousKeys.map((k) => ({ kid: k.kid, alg: 'Ed25519' as const, public_key_pem: k.publicKeyPem })),
      ],
    };
  }

  @Post('jobs')
  @HttpCode(202)
  async submit(@Req() req: IntegrationRequest, @Res({ passthrough: true }) res: Response) {
    const out = await this.jobs.submit(req.integrationPeer!, req.body, header(req, DELEGATION_HEADER));
    if (out.replayed) { res.status(200); res.setHeader('idempotent-replayed', 'true'); }
    return out.job;
  }

  @Get('jobs/:job_id')
  async get(@Req() req: IntegrationRequest, @Param('job_id') jobId: string) {
    return this.jobs.get(req.integrationPeer!, jobId, header(req, DELEGATION_HEADER));
  }

  @Get('jobs/:job_id/events')
  async events(@Req() req: IntegrationRequest, @Param('job_id') jobId: string, @Query('after') after?: string) {
    const n = after && /^\d{1,9}$/.test(after) ? Number(after) : 0;
    return this.jobs.events(req.integrationPeer!, jobId, n, header(req, DELEGATION_HEADER));
  }
}

function header(req: IntegrationRequest, name: string): string | undefined {
  const v = req.headers[name];
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}
