import { Controller, Get, Header, Query, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { Actor } from '../common/decorators/actor.decorator';
import { RateLimit } from '../common/throttling';
import type { ActorContext } from '../rbac/access-control.service';
import { SearchService } from './search.service';
import { parseSearchQuery } from './query';

/** Per client address per minute. A debounced palette sends a few per word. */
export const SEARCH_RATE_LIMIT = 120;

/**
 * GET /search?q= (0.33) — the command palette's one route.
 *
 * No route-level @RequireCapability: the route spans five lists with
 * different gates, and refusing the whole search for want of one of them
 * would hide the rest. Each group is gated by its own list's capability
 * instead — GROUP_CAPABILITY names them, SearchService enforces them — and a
 * group the caller may not use comes back as null.
 *
 * Not audited and not logged: a keystroke is not an event, and the query is
 * what someone was looking for. `no-store` keeps it out of shared caches.
 */
@Controller('search')
@UseGuards(JwtAuthGuard)
export class SearchController {
  constructor(private readonly svc: SearchService) {}

  @Get()
  @RateLimit(SEARCH_RATE_LIMIT)
  @Header('Cache-Control', 'no-store')
  async search(@Actor() actor: ActorContext, @Query('q') q: unknown) {
    const data = await this.svc.search(actor, parseSearchQuery(q));
    return { success: true, data };
  }
}
