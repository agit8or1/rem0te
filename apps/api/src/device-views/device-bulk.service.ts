import { BadRequestException, ForbiddenException, Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { AccessControlService, type ActorContext } from '../rbac/access-control.service';
import { CAP } from '../rbac/capabilities';
import { EndpointsService } from '../endpoints/endpoints.service';
import { EndpointListService, parseListQuery } from '../endpoints/endpoint-list.service';
import { UpdateService } from '../admin/update.service';
import { ContainmentService } from '../containment/containment.service';
import { pauseMessage } from '../containment/pause';
import { ControlsStore } from '../security-controls/controls.store';
import { AccessPolicyService } from '../security-controls/access-policy.service';
import { latestRustdeskVersion } from '../common/rustdesk-release';
import { BLOCKER, blocker, ROLLOUT_OPEN } from '../client-updates/policy';
import { DeviceGroupsService } from './device-groups.service';
import { AgentUpgradeService } from '../agent-upgrade/agent-upgrade.service';
import { ruleFilters } from './group-rule';
import { BULK_MAX, FleetBudget, manageRefusal, membershipStep, parseBulk, parseSelection, refusalOf, type BulkAction, type BulkResult } from './rules';

type Target = {
  id: string; name: string; customerId: string | null; tenantId: string | null; status: string; isOnline: boolean;
  platform: string | null;
};

/**
 * Bulk actions on the device list's selected rows (0.33).
 *
 * Only actions that already exist for one computer and are safe to repeat:
 * add to / remove from a device group, refresh inventory (which also asks
 * for an update scan), queue a RustDesk client update, and export the
 * selection through the device list's own audited CSV export. No connect,
 * archive, delete or approved action: those keep their own flows.
 *
 * At most BULK_MAX computers per request. Every computer is decided on its
 * own, server side, with the single action's checks — the same service call
 * where there is one — and the response lists each computer's result:
 *
 *   - a computer the caller cannot see (another business's, an ungranted
 *     one, a made-up id) is NOT_FOUND, exactly what the single route says,
 *     and nothing about it is returned;
 *   - group membership needs manageRefusal() over the GROUP's business, and
 *     the computer must be in that business (OTHER_BUSINESS otherwise). A
 *     computer may be in any number of groups (0.34), so adding one never
 *     takes it out of another;
 *   - refresh goes through EndpointsService.requestInventoryRefresh, so the
 *     technician grant, capability and fleet-abuse admission are the single
 *     route's; the bulk path stops short of the fleet limit (FleetBudget)
 *     instead of tripping it, and stops entirely once the person is paused;
 *   - client update keeps the one-click rules (Platform Admin, pin over
 *     latest, never archived or Linux, skip what is current) and refuses
 *     what could never apply — no device secret, no reported version, a
 *     rollout in progress — and anything under an "updates" containment
 *     pause, which the heartbeat would withhold anyway.
 *
 * Each request is audited (DEVICE_BULK_ACTION, one entry per business it
 * touched), on top of the per-computer entries the single actions write.
 */
@Injectable()
export class DeviceBulkService {
  private readonly logger = new Logger('DeviceBulk');

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly acl: AccessControlService,
    private readonly endpoints: EndpointsService,
    private readonly list: EndpointListService,
    private readonly updates: UpdateService,
    private readonly containment: ContainmentService,
    private readonly controls: ControlsStore,
    private readonly policy: AccessPolicyService,
    private readonly groups: DeviceGroupsService,
    private readonly agentUpgrade: AgentUpgradeService,
  ) {}

  /** The selected computers this caller can see. Everything else is NOT_FOUND. */
  private async visible(a: ActorContext, ids: string[]): Promise<Map<string, Target>> {
    this.acl.assertCapability(a, CAP.COMPUTERS_VIEW);
    const rows = await this.prisma.endpoint.findMany({
      where: { AND: [this.acl.endpointVisibilityWhere(a), { id: { in: ids } }] },
      select: { id: true, name: true, customerId: true, tenantId: true, status: true, isOnline: true, platform: true },
    });
    return new Map(rows.map((r) => [r.id, r]));
  }

  /**
   * A group's members as the caller sees them, resolved now (0.34): a static
   * group's member rows, or a rule group's rule evaluated through the device
   * list (scopedWhere AND the business AND the rule). Archived computers are
   * left out, as on the list. More than BULK_MAX is refused, never cut.
   */
  private async resolveTarget(a: ActorContext, groupId: string): Promise<{ ids: string[]; group: { id: string; name: string; kind: 'static' | 'rule' } }> {
    const g = await this.groups.findVisible(a, groupId);
    let ids: string[];
    if (g.kind === 'RULE') {
      if (!g.customerId) throw new BadRequestException({ code: 'LEGACY_GROUP', message: 'This group belongs to no business.' });
      const m = await this.list.evaluateRuleGroups(a, [{ id: g.id, name: g.name, customerId: g.customerId, rule: ruleFilters(g.rule) }], { status: 'current' });
      const got = m.get(g.id);
      if (got === null || got === undefined) throw new ForbiddenException({ code: 'NOT_ALLOWED', message: 'This rule group selects computers by their alerts, which needs the monitoring:alerts permission.' });
      ids = got;
    } else {
      ids = (await this.prisma.endpointGroupMember.findMany({
        where: { endpointGroupId: g.id, endpoint: { AND: [this.acl.endpointVisibilityWhere(a), { status: { not: 'ARCHIVED' } }] } },
        select: { endpointId: true }, orderBy: { endpointId: 'asc' },
      })).map((r) => r.endpointId);
    }
    if (ids.length > BULK_MAX) {
      throw new BadRequestException({ code: 'BULK_TOO_LARGE', message: `At most ${BULK_MAX} devices per request; this group has ${ids.length} you can see right now. Narrow it, or act on a selection.` });
    }
    if (!ids.length) throw new BadRequestException({ code: 'GROUP_EMPTY', message: 'No computer you can see is in this group right now; nothing was done.' });
    return { ids, group: { id: g.id, name: g.name, kind: g.kind === 'RULE' ? 'rule' : 'static' } };
  }

  async run(a: ActorContext, raw: unknown, freshMethod: string | null = null) {
    const parsed = parseBulk(raw);
    const target = parsed.targetGroupId ? await this.resolveTarget(a, parsed.targetGroupId) : null;
    const input = { ...parsed, endpointIds: target ? target.ids : parsed.endpointIds! };
    const seen = await this.visible(a, input.endpointIds);
    const results = new Map<string, BulkResult>();
    for (const id of input.endpointIds) {
      if (!seen.has(id)) results.set(id, { endpointId: id, ok: false, code: 'NOT_FOUND', reason: 'Computer not found' });
    }
    const targets = input.endpointIds.map((id) => seen.get(id)).filter((t): t is Target => !!t);
    let group: { id: string; name: string; customerId: string } | null = null;

    if (input.action === 'group.add' || input.action === 'group.remove') {
      group = await this.groupAction(a, input.action, input.groupId!, targets, results);
    } else if (input.action === 'inventory.refresh') {
      await this.refresh(a, targets, results);
    } else if (input.action === 'agent.update' || input.action === 'agent.migrate') {
      // 0.34: through the Agent card's own methods (AgentUpgradeService.bulk).
      await this.agentUpgrade.bulk(a, input.action, targets, results, { reason: input.reason, freshMethod });
    } else {
      await this.clientUpdate(a, targets, results);
    }

    const ordered = input.endpointIds.map((id) => results.get(id)!);
    const summary = {
      action: input.action, requested: ordered.length,
      succeeded: ordered.filter((r) => r.ok).length, refused: ordered.filter((r) => !r.ok).length,
    };
    await this.auditBulk(a, input.action, targets, ordered, group, target);
    return {
      ...summary,
      ...(group ? { group: { id: group.id, name: group.name } } : {}),
      ...(target ? { target: { ...target.group, resolved: target.ids.length } } : {}),
      results: ordered,
    };
  }

  // ── Groups ────────────────────────────────────────────────────────────────

  private async groupAction(a: ActorContext, action: 'group.add' | 'group.remove', groupId: string, targets: Target[], results: Map<string, BulkResult>) {
    // 404 for a group the caller cannot address: the whole request names it.
    const g = await this.groups.findVisible(a, groupId);
    // A rule group's members follow its rule; nobody adds or removes them by
    // hand (the 0053 trigger refuses the row too). Refused for the whole request.
    if (g.kind === 'RULE') {
      throw new BadRequestException({ code: 'RULE_GROUP', message: 'This is a rule group: its members are the computers its rule matches, so they cannot be added or removed by hand. Edit the rule instead.' });
    }
    if (!g.customerId) {
      for (const t of targets) results.set(t.id, { endpointId: t.id, name: t.name, ok: false, code: 'LEGACY_GROUP', reason: 'This group predates 0.33 and belongs to no business, so its members are not changed here.' });
      return null;
    }
    const group = { id: g.id, name: g.name, customerId: g.customerId };
    const why = manageRefusal(a, g.customerId);
    // Current membership of THIS group only: other groups never matter.
    const members = new Set(targets.length ? (await this.prisma.endpointGroupMember.findMany({
      where: { endpointGroupId: g.id, endpointId: { in: targets.map((t) => t.id) } }, select: { endpointId: true },
    })).map((m) => m.endpointId) : []);
    const changed: string[] = [];
    for (const t of targets) {
      const base = { endpointId: t.id, name: t.name };
      const step = membershipStep(action, t, group, members.has(t.id), why);
      if (step.kind === 'refuse') { results.set(t.id, { ...base, ok: false, code: step.code, reason: step.reason }); continue; }
      if (step.kind === 'unchanged') { results.set(t.id, { ...base, ok: true, unchanged: true }); continue; }
      if (action === 'group.add') {
        // The insert trigger (migration 0049) refuses a computer that is no
        // longer in the group's business; a concurrent add is a duplicate key.
        try {
          await this.prisma.endpointGroupMember.create({ data: { endpointGroupId: g.id, endpointId: t.id, addedById: a.userId } });
          changed.push(t.id); results.set(t.id, { ...base, ok: true });
        } catch (e) {
          if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') { results.set(t.id, { ...base, ok: true, unchanged: true }); continue; }
          this.logger.warn(`bulk group.add ${t.id}: ${String(e)}`);
          results.set(t.id, { ...base, ok: false, code: 'CONFLICT', reason: 'This computer changed while the request ran; nothing was changed for it.' });
        }
      } else {
        const w = await this.prisma.endpointGroupMember.deleteMany({ where: { endpointGroupId: g.id, endpointId: t.id } });
        if (w.count === 1) changed.push(t.id);
        results.set(t.id, { ...base, ok: true, ...(w.count === 1 ? {} : { unchanged: true }) });
      }
    }
    if (changed.length) {
      await this.audit.log({
        action: 'DEVICE_GROUP_MEMBERS_CHANGED', actorId: a.userId, actorIp: a.ip, tenantId: g.tenantId, customerId: g.customerId,
        resource: 'endpoint_group', resourceId: g.id,
        meta: { group: g.name, op: action === 'group.add' ? 'add' : 'remove', endpointIds: changed, ...(a.technician ? { viaTechnicianAssignment: true } : {}) },
      });
    }
    return group;
  }

  // ── Refresh inventory / update scan ──────────────────────────────────────

  private async refresh(a: ActorContext, targets: Target[], results: Map<string, BulkResult>) {
    const identity = `user:${a.userId}`;
    const controls = await this.controls.platform();
    const since = new Date(Date.now() - controls.windowMinutes * 60_000);
    const now = new Date();
    const [recent, exceptions] = await Promise.all([
      this.prisma.privilegedActivity.findMany({ where: { identity, at: { gte: since } }, select: { endpointId: true, customerId: true } }),
      this.prisma.maintenanceException.findMany({
        where: { identity, status: 'APPROVED', kinds: { has: 'EVIDENCE' }, startsAt: { lte: now }, expiresAt: { gt: now } },
        select: { endpointIds: true },
      }),
    ]);
    const budget = new FleetBudget(
      recent.map((r) => r.endpointId).filter((x): x is string => !!x),
      recent.map((r) => r.customerId).filter((x): x is string => !!x),
      new Set(exceptions.flatMap((e) => e.endpointIds)),
    );
    let stopped: { code: string; reason: string } | null = null;
    for (const t of targets) {
      const base = { endpointId: t.id, name: t.name };
      if (stopped) { results.set(t.id, { ...base, ok: false, ...stopped }); continue; }
      if (t.status === 'ARCHIVED') { results.set(t.id, { ...base, ok: false, code: 'ARCHIVED', reason: 'Archived — nothing is sent to an archived computer.' }); continue; }
      const limit = budget.wouldExceed(t.id, t.customerId, controls.thresholds[this.policy.tierFor(a, t.id)]);
      if (limit) {
        results.set(t.id, { ...base, ok: false, code: 'FLEET_LIMIT', reason: `Not sent: it would pass your limit on distinct computers in ${controls.windowMinutes} minutes (${limit}). Try the rest later, or ask for a maintenance exception.` });
        continue;
      }
      try {
        await this.endpoints.requestInventoryRefresh(a, t.id);
        budget.admitted(t.id, t.customerId);
        results.set(t.id, { ...base, ok: true });
      } catch (e) {
        const r = refusalOf(e);
        if (r.code === 'ERROR') this.logger.warn(`bulk refresh ${t.id}: ${String(e)}`);
        results.set(t.id, { ...base, ok: false, ...r });
        // The guard paused this person: nothing after this would be admitted.
        if (r.code === 'IDENTITY_PAUSED' || r.code === 'THRESHOLD_TRIPPED') stopped = { code: 'IDENTITY_PAUSED', reason: 'Not attempted: privileged work for you is paused until an administrator clears it.' };
      }
    }
  }

  // ── RustDesk client update ───────────────────────────────────────────────

  private async clientUpdate(a: ActorContext, targets: Target[], results: Map<string, BulkResult>) {
    if (!a.isPlatformAdmin) {
      // The one-click update is a Platform Admin action (UpdateController).
      for (const t of targets) results.set(t.id, { endpointId: t.id, name: t.name, ok: false, code: 'NOT_ALLOWED', reason: 'Queueing a RustDesk client update by hand needs a Platform Admin. A business can turn on scheduled client updates instead.' });
      return;
    }
    if (!targets.length) return;
    const pin = (await this.prisma.platformSettings.findUnique({ where: { id: 'singleton' }, select: { rustdeskPinnedVersion: true } }))?.rustdeskPinnedVersion ?? null;
    const target = pin ?? await latestRustdeskVersion();
    const ids = targets.map((t) => t.id);
    const [nodes, open] = await Promise.all([
      this.prisma.rustdeskNode.findMany({ where: { endpointId: { in: ids } }, select: { endpointId: true, agentSecretHash: true, version: true, updateRequestedAt: true, updateRequestSource: true } }),
      this.prisma.updateJob.findMany({ where: { endpointId: { in: ids }, status: { in: [...ROLLOUT_OPEN] } }, select: { endpointId: true } }),
    ]);
    const node = new Map(nodes.map((n) => [n.endpointId, n]));
    const inRollout = new Set(open.map((j) => j.endpointId));
    const pauses = new Map<string, Awaited<ReturnType<ContainmentService['blocking']>>>();
    const stage: Target[] = [];
    for (const t of targets) {
      const base = { endpointId: t.id, name: t.name };
      if (!target) { results.set(t.id, { ...base, ok: false, code: 'NO_TARGET', reason: 'The latest RustDesk version is unknown right now (GitHub unreachable and no pin), so nothing is queued.' }); continue; }
      const key = t.customerId ?? '';
      if (!pauses.has(key)) pauses.set(key, await this.containment.blocking('updates', t.customerId));
      const pause = pauses.get(key);
      if (pause) { results.set(t.id, { ...base, ok: false, code: 'CONTAINED', reason: pauseMessage(pause, 'updates') }); continue; }
      const n = node.get(t.id) ?? null;
      // The one-click rules, plus what could never apply. Offline is fine (a
      // manual update goes on the next heartbeat) and "already queued" is
      // handled below, so neither is asked of blocker().
      const b = blocker({ status: t.status, isOnline: true, platform: t.platform, node: n ? { agentSecretHash: n.agentSecretHash, version: n.version, updateRequestedAt: null } : null, inRollout: inRollout.has(t.id) }, target);
      if (b === 'up_to_date') { results.set(t.id, { ...base, ok: true, unchanged: true, reason: BLOCKER[b].text }); continue; }
      if (b) { results.set(t.id, { ...base, ok: false, code: b.toUpperCase(), reason: BLOCKER[b].text }); continue; }
      if (n?.updateRequestedAt && n.updateRequestSource !== 'POLICY') { results.set(t.id, { ...base, ok: true, unchanged: true, reason: 'Already queued; it goes on the next heartbeat.' }); continue; }
      stage.push(t);
    }
    if (!stage.length) return;
    try {
      // The one-click path itself: it re-applies its own rules, writes the
      // MANUAL request and audits each computer (ENDPOINT_UPDATED).
      await this.updates.requestRustdeskUpdate(stage.map((t) => t.id), { userId: a.userId, ip: a.ip });
    } catch (e) {
      const r = refusalOf(e);
      for (const t of stage) results.set(t.id, { endpointId: t.id, name: t.name, ok: false, ...r });
      return;
    }
    // Report what was actually written, not what was meant to be.
    const after = new Map((await this.prisma.rustdeskNode.findMany({
      where: { endpointId: { in: stage.map((t) => t.id) } }, select: { endpointId: true, updateRequestedAt: true, updateRequestSource: true, updateRequestedById: true },
    })).map((n) => [n.endpointId, n]));
    for (const t of stage) {
      const n = after.get(t.id);
      const ok = !!n?.updateRequestedAt && n.updateRequestSource === 'MANUAL' && n.updateRequestedById === a.userId;
      results.set(t.id, ok ? { endpointId: t.id, name: t.name, ok: true } : { endpointId: t.id, name: t.name, ok: false, code: 'NOT_QUEUED', reason: 'The update path skipped this computer.' });
    }
  }

  // ── Export ────────────────────────────────────────────────────────────────

  /**
   * The selection as CSV, through EndpointListService.exportCsv: the same
   * scoping, columns, CSV-injection guard and logOrFail audit as the list's
   * own export, with the selection AND-ed on. Computers the caller cannot see
   * are simply not in the file; `notExported` says how many.
   */
  async exportSelection(a: ActorContext, raw: unknown) {
    const body = (raw ?? {}) as Record<string, unknown>;
    const ids = parseSelection(body.endpointIds);
    const q = { ...parseListQuery({ sort: body.sort, dir: body.dir, status: 'all' }), ids };
    const out = await this.list.exportCsv(a, q);
    return { ...out, requested: ids.length, notExported: ids.length - out.rows };
  }

  // ── Audit ─────────────────────────────────────────────────────────────────

  private async auditBulk(
    a: ActorContext, action: BulkAction, targets: Target[], results: BulkResult[], group: { id: string; customerId: string } | null,
    target: { ids: string[]; group: { id: string; kind: 'static' | 'rule' } } | null,
  ) {
    const byBusiness = new Map<string | null, Target[]>();
    for (const t of targets) byBusiness.set(t.customerId, [...(byBusiness.get(t.customerId) ?? []), t]);
    if (!byBusiness.size) byBusiness.set(group?.customerId ?? a.businessId ?? null, []);
    const notFound = results.filter((r) => r.code === 'NOT_FOUND').length;
    const res = new Map(results.map((r) => [r.endpointId, r]));
    for (const [customerId, ts] of byBusiness) {
      const mine = ts.map((t) => res.get(t.id)!);
      const codes: Record<string, number> = {};
      for (const r of mine) if (!r.ok) codes[r.code ?? 'REFUSED'] = (codes[r.code ?? 'REFUSED'] ?? 0) + 1;
      await this.audit.log({
        action: 'DEVICE_BULK_ACTION', actorId: a.userId, actorIp: a.ip,
        tenantId: ts[0]?.tenantId ?? a.tenantId ?? undefined, customerId: customerId ?? undefined,
        resource: 'endpoint', meta: {
          action, ...(group ? { groupId: group.id } : {}),
          // 0.34: the group acted on, and how many it resolved to at request time.
          ...(target ? { targetGroup: { id: target.group.id, kind: target.group.kind, resolved: target.ids.length } } : {}),
          requested: results.length, inThisBusiness: ts.length, notFound,
          succeeded: mine.filter((r) => r.ok).map((r) => r.endpointId),
          refused: codes,
          ...(a.technician ? { viaTechnicianAssignment: true } : {}),
        },
      });
    }
  }
}
