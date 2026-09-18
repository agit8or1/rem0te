import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AccessControlService, type ActorContext } from '../rbac/access-control.service';

/**
 * Matching a Tactical RMM agent to a Rem0te computer.
 *
 * Tactical RMM has no way to consume a REST API directly — its extension point
 * for third-party tools is a **URL Action**: right-click an agent, and TRMM
 * opens a URL built from `{{agent.hostname}}`, `{{agent.agent_id}}`,
 * `{{client.name}}` and `{{site.name}}`. Everything here exists to turn that
 * handful of strings into one computer, or to admit honestly that it could not.
 *
 * ## Why the TRMM agent id is the answer, eventually
 *
 * Hostnames collide. Two customers each with a `SERVER01` is not an edge case,
 * it is Tuesday — and connecting a technician to the wrong customer's machine
 * because two names matched is the worst thing this code could do. So the
 * hostname is only ever a *candidate* generator, and the TRMM agent id, once
 * recorded, is the thing that makes a match exact.
 *
 * That id is stored as an `EndpointAlias` (`trmm:<agent_id>`) rather than as a
 * new column. Aliases already exist, already carry a uniqueness constraint per
 * endpoint, and are already how this system says "this machine is also known
 * as". A column would have been a second mechanism for the same idea.
 *
 * ## Scope
 *
 * Every query below runs through `endpointVisibilityWhere`, so a technician who
 * cannot see a computer in Rem0te cannot reach it from TRMM either. TRMM's own
 * permissions are irrelevant here: the request arrives as an ordinary
 * authenticated browser request from whoever clicked it.
 */

/** Prefix for the alias that records a TRMM agent id. */
export const TRMM_ALIAS_PREFIX = 'trmm:';

export type MatchKind =
  /** Matched on a previously-recorded TRMM agent id. Exact. */
  | 'agent-id'
  /** Hostname, narrowed to one computer by the TRMM client name. */
  | 'hostname+client'
  /** Hostname alone, and only one computer had it. */
  | 'hostname'
  /** More than one candidate; the operator has to choose. */
  | 'ambiguous'
  /** Nothing matched. */
  | 'none';

export interface ResolveQuery {
  hostname?: string;
  clientName?: string;
  siteName?: string;
  agentId?: string;
}

@Injectable()
export class TrmmResolverService {
  private readonly logger = new Logger(TrmmResolverService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly acl: AccessControlService,
  ) {}

  /**
   * Whatever TRMM sent, turned into a computer or a shortlist.
   *
   * Tried in order of how much the match can be trusted, and it stops at the
   * first exact one. An ambiguous result is never resolved by guessing — no
   * "closest match", no first-alphabetically — because a wrong guess here
   * opens a remote session on a stranger's machine.
   */
  async resolve(actor: ActorContext, q: ResolveQuery) {
    const visible = this.acl.endpointVisibilityWhere(actor);
    const select = {
      id: true, name: true, hostname: true, platform: true,
      isOnline: true, lastSeenAt: true,
      customer: { select: { id: true, name: true } },
      site: { select: { id: true, name: true } },
    };

    const hostname = norm(q.hostname);
    const clientName = norm(q.clientName);
    const agentId = norm(q.agentId);

    // 1. A recorded TRMM agent id. The only match that cannot be wrong.
    if (agentId) {
      const byAlias = await this.prisma.endpoint.findFirst({
        where: {
          ...visible,
          aliases: { some: { alias: TRMM_ALIAS_PREFIX + agentId } },
        },
        select,
      });
      if (byAlias) return { kind: 'agent-id' as MatchKind, endpoint: byAlias, candidates: [] };
    }

    if (!hostname) {
      return { kind: 'none' as MatchKind, endpoint: null, candidates: [] };
    }

    // 2. Hostname. Case-insensitive, and matched against the endpoint's name
    //    as well as its hostname — a machine renamed in Rem0te for a human's
    //    benefit still answers to the name Windows knows it by.
    const candidates = await this.prisma.endpoint.findMany({
      where: {
        ...visible,
        status: { not: 'ARCHIVED' },
        OR: [
          { hostname: { equals: hostname, mode: 'insensitive' } },
          { name: { equals: hostname, mode: 'insensitive' } },
          { aliases: { some: { alias: { equals: hostname, mode: 'insensitive' } } } },
        ],
      },
      select,
      take: 25,
    });

    if (candidates.length === 1) {
      return { kind: 'hostname' as MatchKind, endpoint: candidates[0], candidates };
    }

    // 3. Several machines share the hostname — the collision this exists for.
    //    TRMM's client name is the tiebreaker, compared loosely because
    //    "Harbor Logistics" in TRMM is "Harbor Logistics Ltd" in Rem0te often
    //    enough to matter, and an exact compare would give up too easily.
    if (candidates.length > 1 && clientName) {
      const narrowed = candidates.filter((c) => businessesLookAlike(c.customer?.name, clientName));
      if (narrowed.length === 1) {
        return { kind: 'hostname+client' as MatchKind, endpoint: narrowed[0], candidates };
      }
      if (narrowed.length > 1) {
        return { kind: 'ambiguous' as MatchKind, endpoint: null, candidates: narrowed };
      }
    }

    if (candidates.length > 1) {
      return { kind: 'ambiguous' as MatchKind, endpoint: null, candidates };
    }

    return { kind: 'none' as MatchKind, endpoint: null, candidates: [] };
  }

  /**
   * Record which computer a TRMM agent is, so the next launch is exact.
   *
   * Called when someone picks from the shortlist. Idempotent, and it moves the
   * alias rather than duplicating it: an agent id belongs to exactly one
   * machine, and a stale mapping left behind after a rebuild would resolve
   * confidently to the wrong one — which is the failure this whole file is
   * arranged to avoid.
   */
  async remember(actor: ActorContext, endpointId: string, agentId: string) {
    const endpoint = await this.acl.assertEndpointInScope(actor, endpointId);
    const alias = TRMM_ALIAS_PREFIX + norm(agentId);
    if (alias === TRMM_ALIAS_PREFIX) return { linked: false };

    // Scoped to what this actor can see: clearing a mapping on a computer they
    // cannot reach would let them quietly break someone else's integration.
    const visible = this.acl.endpointVisibilityWhere(actor);
    await this.prisma.endpointAlias.deleteMany({
      where: { alias, endpoint: { is: visible }, NOT: { endpointId } },
    });

    await this.prisma.endpointAlias.upsert({
      where: { endpointId_alias: { endpointId, alias } },
      create: { endpointId, alias },
      update: {},
    });

    this.logger.log(`Linked TRMM agent ${agentId} to endpoint ${endpoint.id}`);
    return { linked: true, endpointId, alias };
  }
}

function norm(v: string | undefined | null): string {
  return (v ?? '').trim();
}

/**
 * Do two business names plausibly refer to the same company?
 *
 * Deliberately loose in one direction only: punctuation, case and the common
 * company suffixes are ignored, and one name containing the other counts. It
 * is used solely to *narrow* an existing hostname collision, never to widen a
 * search, so a false positive here can only pick between machines that already
 * shared a hostname — and the caller still refuses to choose when more than
 * one survives.
 */
function businessesLookAlike(a: string | null | undefined, b: string): boolean {
  const clean = (s: string) =>
    s.toLowerCase()
      .replace(/[.,'"()-]/g, ' ')
      .replace(/\b(ltd|limited|llc|inc|incorporated|corp|corporation|plc|gmbh|pty|co)\b/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  const x = clean(a ?? '');
  const y = clean(b);
  if (!x || !y) return false;
  return x === y || x.includes(y) || y.includes(x);
}
