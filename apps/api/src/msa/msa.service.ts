import { Injectable, Logger } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AccessControlService, type ActorContext } from '../rbac/access-control.service';
import { runsSignedAgent } from '../common/agent-identity';
import { parsePreflight, PREFLIGHT_KEYS } from './preflight';
import {
  decideReadiness, LAB_TESTED_MAX, LAB_TESTED_MIN, LAB_TESTED_RUSTDESK, MIN_REPORTING_AGENT, PRODUCIBLE_STATES,
  READINESS_FLEET_NOTE, READINESS_NOTE, STATE_LABEL, type ProducibleState, type Readiness,
} from './readiness';

/** The fleet view's ceiling: the same as the Full agent page's. */
export const FLEET_MAX = 5000;
const AGENT_VERSION_RE = /^[0-9]{1,4}\.[0-9]{1,4}\.[0-9]{1,4}$/;

const READ_SELECT = {
  id: true, name: true, hostname: true, platform: true, agentVersion: true, updateChannel: true, signedSeenAt: true,
  isOnline: true, lastSeenAt: true, customer: { select: { id: true, name: true } },
  rustdeskPreflight: { select: { checkedAt: true, installed: true, expectedPath: true, version: true, build: true, service: true, cli: true, keysOk: true, keys: true } },
} satisfies Prisma.EndpointSelect;
type ReadRow = Prisma.EndpointGetPayload<{ select: typeof READ_SELECT }>;

/**
 * Managed Secure Access readiness (0.69): stores the signed agent's
 * read-only RustDesk preflight and answers, per computer and for the fleet,
 * what msa/readiness.ts decides from it. It writes one table,
 * RustdeskPreflight, and only from recordPreflight — which only the
 * heartbeat calls, only for an authenticated signed heartbeat that may act
 * (EnrollmentService, §80). Nothing here changes anything on a computer.
 */
@Injectable()
export class MsaService {
  private readonly logger = new Logger(MsaService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly acl: AccessControlService,
  ) {}

  /**
   * Record a heartbeat's block. Returns the `checkedAt` to acknowledge (so the
   * agent stops sending it), or null when the block was not believed — which
   * never fails the heartbeat. The caller has already decided the heartbeat
   * is authenticated, signed and may act.
   */
  async recordPreflight(endpointId: string, raw: unknown, agentVersion: string | undefined, now = new Date()): Promise<string | null> {
    const p = parsePreflight(raw, now.getTime());
    if (!p) return null;
    const keys = Object.fromEntries(PREFLIGHT_KEYS.filter((k) => p.keys[k]).map((k) => [k, p.keys[k]]));
    const data = {
      checkedAt: p.checkedAtDate, receivedAt: now, schema: p.schema, installed: p.installed, expectedPath: p.expectedPath,
      version: p.version, build: p.build, service: p.service, cli: p.cli, keys, keysOk: p.keysOk, durationMs: p.durationMs,
      agentVersion: agentVersion && AGENT_VERSION_RE.test(agentVersion) ? agentVersion : null,
    };
    // Newest wins: an older report arriving late (a retry) never replaces a newer one.
    const updated = await this.prisma.rustdeskPreflight.updateMany({ where: { endpointId, checkedAt: { lt: p.checkedAtDate } }, data });
    if (updated.count === 0) {
      const exists = await this.prisma.rustdeskPreflight.findUnique({ where: { endpointId }, select: { checkedAt: true } });
      if (!exists) {
        try {
          await this.prisma.rustdeskPreflight.create({ data: { endpointId, ...data } });
        } catch (e) {
          // A concurrent heartbeat created it first; the next report updates it.
          this.logger.debug(`Preflight create raced for ${endpointId}: ${String(e)}`);
        }
      }
    }
    return p.checkedAt;
  }

  private decide(r: ReadRow, now: number): Readiness {
    return decideReadiness({
      platform: r.platform,
      signedAgent: runsSignedAgent({ updateChannel: r.updateChannel, signedSeenAt: r.signedSeenAt }, new Date(now)),
      agentVersion: r.agentVersion,
      isOnline: r.isOnline,
      lastSeenAt: r.lastSeenAt,
      preflight: r.rustdeskPreflight,
    }, now);
  }

  /** One computer, already scope-checked by the caller (computers:view). */
  async forEndpoint(actor: ActorContext, endpointId: string, now = Date.now()) {
    await this.acl.assertEndpointInScope(actor, endpointId, 'computers:view');
    const r = await this.prisma.endpoint.findFirst({ where: { AND: [{ id: endpointId }, this.acl.endpointVisibilityWhere(actor)] }, select: READ_SELECT });
    if (!r) return null;
    const pf = r.rustdeskPreflight;
    return {
      endpointId: r.id,
      readiness: this.decide(r, now),
      preflight: pf ? {
        checkedAt: pf.checkedAt.toISOString(), installed: pf.installed, expectedPath: pf.expectedPath, version: pf.version,
        build: pf.build, service: pf.service, cli: pf.cli, keysOk: pf.keysOk, keysTotal: PREFLIGHT_KEYS.length,
      } : null,
      note: READINESS_NOTE,
      labTested: { versions: [...LAB_TESTED_RUSTDESK], min: LAB_TESTED_MIN, max: LAB_TESTED_MAX },
      minAgent: MIN_REPORTING_AGENT,
    };
  }

  /**
   * The fleet: every computer this person can see (endpointVisibilityWhere,
   * optionally one business), with counts per state. Read-only.
   */
  async fleet(actor: ActorContext, businessId: string | null, state: ProducibleState | null, now = Date.now()) {
    const vis = this.acl.endpointVisibilityWhere(actor, businessId);
    const rows = await this.prisma.endpoint.findMany({
      where: { AND: [vis, { status: { not: 'ARCHIVED' } }] },
      select: READ_SELECT,
      orderBy: [{ name: 'asc' }, { id: 'asc' }],
      take: FLEET_MAX + 1,
    });
    const truncated = rows.length > FLEET_MAX;
    const counts = Object.fromEntries(PRODUCIBLE_STATES.map((s) => [s, 0])) as Record<ProducibleState, number>;
    const computers = rows.slice(0, FLEET_MAX).map((r) => {
      const d = this.decide(r, now);
      counts[d.state]++;
      return {
        id: r.id, name: r.name, hostname: r.hostname, platform: r.platform, agentVersion: r.agentVersion,
        business: r.customer ? { id: r.customer.id, name: r.customer.name } : null,
        state: d.state, label: d.label, reasons: d.reasons, rustdeskVersion: d.rustdeskVersion, checkedAt: d.checkedAt, labTested: d.labTested,
      };
    });
    return {
      note: READINESS_FLEET_NOTE,
      generatedAt: new Date(now).toISOString(),
      states: PRODUCIBLE_STATES.map((s) => ({ state: s, label: STATE_LABEL[s] })),
      counts,
      total: computers.length,
      truncated,
      computers: state ? computers.filter((c) => c.state === state) : computers,
      labTested: { versions: [...LAB_TESTED_RUSTDESK], min: LAB_TESTED_MIN, max: LAB_TESTED_MAX },
      minAgent: MIN_REPORTING_AGENT,
    };
  }
}
