import { Throttle } from '@nestjs/throttler';

/**
 * Names of the globally-configured throttlers, in one place because a route
 * override is matched to a throttler *by name*.
 *
 * This bit them: `ThrottlerModule.forRoot()` declared throttlers named `short`
 * and `long`, while every route wrote `@Throttle({ default: … })`. The guard
 * looks up metadata keyed by each configured throttler's name, finds nothing
 * under `long` for that route, and applies the global limit. Every per-route
 * limit in the API — login, MFA verify, recovery codes, enrollment, grant
 * redemption — was silently inert, leaving login at the global 300/minute.
 *
 * Use `RateLimit()` rather than `@Throttle()` directly so the name can never
 * drift from the configuration again.
 */
export const THROTTLER_BURST = 'burst';   // very short window, absorbs floods
export const THROTTLER_MAIN = 'main';     // per-minute budget, what routes override

/** Per-route request budget. `ttlMs` defaults to one minute. */
export const RateLimit = (limit: number, ttlMs = 60_000) =>
  Throttle({ [THROTTLER_MAIN]: { limit, ttl: ttlMs } });
