import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AccessControlService, type ActorContext } from '../rbac/access-control.service';
import { CAP } from '../rbac/capabilities';
import { EndpointListService, type RuleGroup } from '../endpoints/endpoint-list.service';
import { ruleFilters, ruleNeedsAlerts } from '../device-views/group-rule';

/**
 * Device-group membership for POLICY decisions (0.35): which of a set of
 * groups each computer is in, right now.
 *
 * Nothing here is stored. A static group's members are its
 * EndpointGroupMember rows; a rule group's are computed at each call by
 * EndpointListService.evaluateRuleGroups — the device list's own evaluator —
 * as the group's business AND its rule AND endpointVisibilityWhere for the
 * business as a whole (what its Business Owner sees: every computer of the
 * business that is not archived). So a computer that stops matching a rule
 * loses that group's policies at the next evaluation, with nothing to go
 * stale and no sweep to fall behind.
 *
 * Two kinds of rule group match nothing for a policy:
 *   - a rule that no longer parses (ruleFilters → null), as on the list;
 *   - a rule that reads alert state. Monitors raise alerts, so a monitor
 *     scoped to "computers with critical alerts" would decide its own scope.
 *     The policy routes refuse such a group, and if a group's rule is later
 *     edited to read alerts its policies stop applying and the pages say so.
 *
 * A snapshot is built per call — once per sweep tick, or for one computer —
 * and never kept between calls.
 */

export type GroupUse = 'ok' | 'unreadable' | 'reads_alerts';
export interface PolicyGroup { id: string; name: string; customerId: string; kind: 'static' | 'rule'; use: GroupUse }

export class Membership {
  constructor(private readonly byEndpoint: Map<string, Set<string>>, readonly groups: Map<string, PolicyGroup>) {}
  private static readonly NONE: ReadonlySet<string> = new Set();
  /** The groups (of those asked about) this computer is in. */
  groupsOf(endpointId: string): ReadonlySet<string> { return this.byEndpoint.get(endpointId) ?? Membership.NONE; }
  /** How many computers are in a group. */
  count(groupId: string): number {
    let n = 0;
    for (const s of this.byEndpoint.values()) if (s.has(groupId)) n++;
    return n;
  }
}

/**
 * The business as a whole, for evaluating a rule group's membership on a
 * policy's behalf: visibility = every computer of that business. Used only
 * here, never for a request, and never handed to anything that writes.
 */
function businessWide(customerId: string): ActorContext {
  return Object.freeze({
    userId: 'policy-evaluation', email: '', tenantId: null, businessId: customerId, isPlatformAdmin: false,
    roleType: 'BUSINESS_OWNER', capabilities: [CAP.COMPUTERS_VIEW, CAP.ALERTS_VIEW], technician: null,
  }) as ActorContext;
}

@Injectable()
export class GroupMembershipService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly acl: AccessControlService,
    private readonly list: EndpointListService,
  ) {}

  /**
   * The group a policy of `customerId` names. Another business's group, a
   * pre-0.33 group with no business, and a made-up id are all the same 404.
   * A group whose rule cannot be read or reads alerts is refused (above).
   */
  async groupForPolicy(customerId: string, groupId: unknown): Promise<PolicyGroup> {
    if (typeof groupId !== 'string' || !/^[A-Za-z0-9_-]{8,64}$/.test(groupId)) throw new NotFoundException('Group not found');
    const g = await this.prisma.endpointGroup.findFirst({ where: { id: groupId, customerId }, select: { id: true, name: true, customerId: true, kind: true, rule: true } });
    if (!g?.customerId) throw new NotFoundException('Group not found');
    const pg = this.describe(g as { id: string; name: string; customerId: string; kind: 'STATIC' | 'RULE'; rule: unknown });
    if (pg.use === 'reads_alerts') throw new BadRequestException({ code: 'GROUP_READS_ALERTS', message: `"${g.name}" picks computers by their alerts. A policy cannot use it: monitors raise alerts, so the group would decide its own monitors.` });
    if (pg.use === 'unreadable') throw new BadRequestException({ code: 'GROUP_RULE_UNREADABLE', message: `"${g.name}" has a rule this server cannot read, so it matches no computer. Fix the rule first.` });
    return pg;
  }

  private describe(g: { id: string; name: string; customerId: string; kind: 'STATIC' | 'RULE'; rule: unknown }): PolicyGroup {
    if (g.kind !== 'RULE') return { id: g.id, name: g.name, customerId: g.customerId, kind: 'static', use: 'ok' };
    const f = ruleFilters(g.rule);
    return { id: g.id, name: g.name, customerId: g.customerId, kind: 'rule', use: f === null ? 'unreadable' : ruleNeedsAlerts(f) ? 'reads_alerts' : 'ok' };
  }

  /**
   * Membership of `groupIds` (the groups that carry the policies being
   * decided — never every group), optionally only for the computers in
   * `within`. Groups without a business are ignored.
   */
  async snapshot(groupIds: Iterable<string>, within?: string[]): Promise<Membership> {
    const ids = [...new Set(groupIds)];
    const byEndpoint = new Map<string, Set<string>>();
    const groups = new Map<string, PolicyGroup>();
    if (!ids.length || (within && !within.length)) return new Membership(byEndpoint, groups);
    const rows = await this.prisma.endpointGroup.findMany({
      where: { id: { in: ids }, customerId: { not: null } },
      select: { id: true, name: true, customerId: true, kind: true, rule: true },
    });
    for (const g of rows) groups.set(g.id, this.describe(g as { id: string; name: string; customerId: string; kind: 'STATIC' | 'RULE'; rule: unknown }));
    const add = (ep: string, g: string) => { const s = byEndpoint.get(ep) ?? new Set<string>(); s.add(g); byEndpoint.set(ep, s); };

    const byBusiness = new Map<string, PolicyGroup[]>();
    for (const g of groups.values()) { const l = byBusiness.get(g.customerId) ?? []; l.push(g); byBusiness.set(g.customerId, l); }
    for (const [customerId, list] of byBusiness) {
      const actor = businessWide(customerId);
      const visible = { AND: [this.acl.endpointVisibilityWhere(actor), { status: { not: 'ARCHIVED' as const } }, ...(within ? [{ id: { in: within } }] : [])] };
      const statics = list.filter((g) => g.kind === 'static').map((g) => g.id);
      if (statics.length) {
        const m = await this.prisma.endpointGroupMember.findMany({
          where: { endpointGroupId: { in: statics }, endpoint: visible },
          select: { endpointId: true, endpointGroupId: true },
        });
        for (const r of m) add(r.endpointId, r.endpointGroupId);
      }
      const ruled: RuleGroup[] = [];
      for (const g of list) {
        if (g.kind !== 'rule' || g.use !== 'ok') continue;
        const row = rows.find((r) => r.id === g.id)!;
        ruled.push({ id: g.id, name: g.name, customerId, rule: ruleFilters(row.rule) });
      }
      if (ruled.length) {
        const res = await this.list.evaluateRuleGroups(actor, ruled, { status: 'current', ...(within ? { within } : {}) });
        for (const [gid, eps] of res) for (const ep of eps ?? []) add(ep, gid);
      }
    }
    return new Membership(byEndpoint, groups);
  }
}
