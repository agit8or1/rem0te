import { Injectable, NotFoundException, type NestMiddleware } from '@nestjs/common';

/**
 * Managed Secure Access grants (0.71) are behind a process switch, off by
 * default: on only when MSA_GRANTS is exactly 'on'. Deliberately not a
 * console setting — nobody can switch it on from the UI before the agent
 * enforces a grant (build steps 4 and 5). Never set it in production until
 * step 4 ships (CLAUDE.md, §81).
 */
export const MSA_NOT_ENABLED = 'MSA_NOT_ENABLED';

export function msaGrantsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.MSA_GRANTS === 'on';
}

/**
 * Applied to every grant route (MsaGrantsModule.configure). Middleware runs
 * before the throttler, the session guard and the handler, so with the
 * switch off a route answers 404 MSA_NOT_ENABLED before anything is read —
 * no session, no device secret, no row.
 */
@Injectable()
export class MsaGrantsGate implements NestMiddleware {
  use(_req: unknown, _res: unknown, next: () => void) {
    if (!msaGrantsEnabled()) throw new NotFoundException({ code: MSA_NOT_ENABLED, message: 'Managed Secure Access grants are not enabled on this server.' });
    next();
  }
}
