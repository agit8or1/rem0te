import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, type ActionJob, type ActionTarget, type SoftwareCatalogEntry, type SoftwareDeployment } from '@prisma/client';
import { z } from 'zod';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { AccessControlService, type ActorContext } from '../rbac/access-control.service';
import { CAP } from '../rbac/capabilities';
import { AccessPolicyService } from '../security-controls/access-policy.service';
import { assertFresh } from '../security-controls/review';
import { ActionsService } from '../actions/actions.service';
import { SignerClient } from '../actions/signer.client';
import { SOFTWARE_INSTALL, SOFTWARE_UNINSTALL, SoftwareParams, type CatalogAction } from '../actions/catalog';
import { Posture, MANAGER_LABEL } from '../patching/posture';
import { readOnlyAgentRefusal } from '../common/platform';
import {
  ArchiveEntryDto, CreateDeploymentDto, CreateEntryDto, ManifestPreviewDto, ReasonDto, RequestRingDto, SingleDto, UpdateEntryDto,
  complianceOf, detectFromInventory, evaluateSoftwareGate, evidenceFor, nextRing, paramsOf, programsOf, selectInstaller,
  type SwGate, type SwGateTarget,
} from './definition';
import { fetchInstallerManifest } from './manifest';

/**
 * Software deployment (0.34): a catalog of allowlisted winget packages, each
 * pinned to one version and one installer SHA-256, and deployments of one
 * entry to one computer or ring by ring.
 *
 *   Catalog entry ─(fresh sign-in, audited)─▶ deployment ─ring 0 (canary)─▶ two approvals on the signer ─▶ agent
 *                                                       └─ring n: only once ring n−1 passed its gate
 *
 * Nothing here can approve, sign or upload. Installing goes through
 * ActionsService.createPlan as windows.software.install@1 /
 * windows.software.uninstall@1 — always high risk, two approvers on the
 * approval signer — and the computer re-checks the parameters, downloads
 * with winget, hashes the installer itself and refuses a mismatch.
 *
 * Who may do what:
 *   read the catalog   computers:view in the business (Platform Admin: any)
 *   change an entry    a business's own entries: its Business Owner (not
 *                      through a technician assignment) or a Platform Admin;
 *                      global entries: a Platform Admin. Always with a fresh
 *                      sign-in, always audited.
 *   deploy             whoever may request a high-risk action on every
 *                      computer named (AccessPolicyService.evaluateAction).
 */

const ACTIONS: Record<'install' | 'uninstall', CatalogAction> = { install: SOFTWARE_INSTALL, uninstall: SOFTWARE_UNINSTALL };
export const SOFTWARE_ACTION_IDS = [SOFTWARE_INSTALL.id, SOFTWARE_UNINSTALL.id];
const key = (a: CatalogAction) => `${a.id}@${a.version}`;
const Id = z.string().regex(/^[A-Za-z0-9_-]{8,64}$/);

type Ring = { endpointIds: string[] };
type Job = ActionJob & { targets: ActionTarget[] };
type Ep = NonNullable<Awaited<ReturnType<ActionsService['endpointFor']>>>;
export interface Availability { possible: boolean; reason: string | null; fix: string | null; warning: string | null }

function bad(e: z.ZodError): never {
  throw new BadRequestException({ code: 'INVALID_REQUEST', message: e.issues.slice(0, 4).map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; ') });
}

@Injectable()
export class SoftwareService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly acl: AccessControlService,
    private readonly policy: AccessPolicyService,
    private readonly actions: ActionsService,
    private readonly signer: SignerClient,
  ) {}

  // ── Who may see and change an entry ───────────────────────────────────────

  private canRead(actor: ActorContext, e: Pick<SoftwareCatalogEntry, 'scope' | 'customerId'>): boolean {
    if (actor.isPlatformAdmin) return true;
    if (!actor.businessId || !this.acl.can(actor, CAP.COMPUTERS_VIEW)) return false;
    return e.scope === 'GLOBAL' || e.customerId === actor.businessId;
  }

  private canEdit(actor: ActorContext, e: Pick<SoftwareCatalogEntry, 'scope' | 'customerId'>): boolean {
    if (actor.isPlatformAdmin) return true;
    if (e.scope === 'GLOBAL') return false;
    // The business's own policy decision: its owner, in person.
    return !actor.technician && actor.businessId === e.customerId && this.acl.isBusinessOwner(actor);
  }

  private async entry(actor: ActorContext, id: string): Promise<SoftwareCatalogEntry & { customer: { name: string } | null }> {
    const e = Id.safeParse(id).success ? await this.prisma.softwareCatalogEntry.findUnique({ where: { id }, include: { customer: { select: { name: true } } } }) : null;
    // Another business's entry looks like a missing one.
    if (!e || !this.canRead(actor, e)) throw new NotFoundException('Catalog entry not found');
    return e;
  }

  private view(actor: ActorContext, e: SoftwareCatalogEntry & { customer?: { name: string } | null }) {
    return {
      id: e.id, scope: e.scope.toLowerCase(), businessId: e.customerId, businessName: e.customer?.name ?? null,
      packageId: e.packageId, name: e.name, publisher: e.publisher, version: e.version, installerSha256: e.installerSha256,
      hashSource: e.hashSource === 'WINGET_PKGS' ? 'winget_pkgs' : 'admin_pasted', manifestUrl: e.manifestUrl, manifestSha256: e.manifestSha256,
      installerUrl: e.installerUrl, architecture: e.architecture, detection: e.detection, notes: e.notes, revision: e.revision,
      archivedAt: e.archivedAt, createdAt: e.createdAt, updatedAt: e.updatedAt, createdById: e.createdById, updatedById: e.updatedById,
      canEdit: this.canEdit(actor, e),
    };
  }

  // ── The catalog ───────────────────────────────────────────────────────────

  async list(actor: ActorContext, businessId?: string, includeArchived = false) {
    if (!actor.isPlatformAdmin && !this.acl.can(actor, CAP.COMPUTERS_VIEW)) throw new ForbiddenException({ code: 'NOT_ALLOWED', message: 'The software catalog needs the View computers permission.' });
    const scope = this.acl.resolveScope(actor, businessId);
    const where: Prisma.SoftwareCatalogEntryWhereInput = {
      AND: [scope ? { OR: [{ scope: 'GLOBAL' }, { customerId: scope }] } : {}, includeArchived ? {} : { archivedAt: null }],
    };
    const rows = await this.prisma.softwareCatalogEntry.findMany({ where, orderBy: [{ scope: 'asc' }, { name: 'asc' }, { id: 'asc' }], take: 500, include: { customer: { select: { name: true } } } });
    return {
      entries: rows.filter((e) => this.canRead(actor, e)).map((e) => this.view(actor, e)),
      you: {
        businessId: scope,
        canCreateBusiness: !!scope && (actor.isPlatformAdmin || (!actor.technician && this.acl.isBusinessOwner(actor))),
        canCreateGlobal: actor.isPlatformAdmin,
      },
      signerConfigured: this.signer.configured(),
    };
  }

  async get(actor: ActorContext, id: string) {
    const e = await this.entry(actor, id);
    const deployments = await this.prisma.softwareDeployment.findMany({ where: { entryId: e.id, ...(actor.isPlatformAdmin ? {} : { customerId: actor.businessId ?? '' }) }, orderBy: { createdAt: 'desc' }, take: 20, select: { id: true } });
    const out = [];
    for (const d of deployments) { try { out.push(await this.summary(actor, d.id)); } catch { /* a computer in it is not visible */ } }
    return { ...this.view(actor, e), deployments: out };
  }

  /** Read the winget-pkgs manifest for a package and version: what an entry's hash would be pinned to. */
  async previewManifest(actor: ActorContext, raw: unknown) {
    if (!actor.isPlatformAdmin && (actor.technician || !this.acl.isBusinessOwner(actor))) throw new ForbiddenException({ code: 'NOT_ALLOWED', message: 'Only a Business Owner or a Platform Admin changes the software catalog.' });
    const p = ManifestPreviewDto.safeParse(raw);
    if (!p.success) bad(p.error);
    const f = await fetchInstallerManifest(p.data.packageId, p.data.version);
    return { url: f.url, manifestSha256: f.sha256, packageIdentifier: f.manifest.packageIdentifier, packageVersion: f.manifest.packageVersion, installers: f.manifest.installers };
  }

  /** Resolve the pinned hash: from the manifest (recorded with its URL and digest), or as pasted. */
  private async pin(packageId: string, version: string, h: z.infer<typeof CreateEntryDto>['hash']) {
    if (h.source === 'admin_pasted') return { installerSha256: h.installerSha256, hashSource: 'ADMIN_PASTED' as const, manifestUrl: null, manifestSha256: null, installerUrl: null, architecture: null };
    const f = await fetchInstallerManifest(packageId, version);
    const sel = selectInstaller(f.manifest, h.architecture, h.installerSha256);
    if (!sel.ok) throw new ConflictException({ code: sel.code, message: sel.message, candidates: sel.candidates });
    return {
      installerSha256: sel.installer.installerSha256!, hashSource: 'WINGET_PKGS' as const, manifestUrl: f.url.slice(0, 500), manifestSha256: f.sha256,
      installerUrl: sel.installer.installerUrl?.slice(0, 500) ?? null, architecture: sel.installer.architecture,
    };
  }

  async create(actor: ActorContext, raw: unknown, freshMethod: string | null) {
    const p = CreateEntryDto.safeParse(raw);
    if (!p.success) bad(p.error);
    const d = p.data;
    let customerId: string | null = null;
    if (d.scope === 'global') {
      if (!actor.isPlatformAdmin) throw new ForbiddenException({ code: 'NOT_ALLOWED', message: 'Only a Platform Admin adds to the global catalog.' });
    } else {
      customerId = this.acl.requireScope(actor, d.businessId);
      if (!this.canEdit(actor, { scope: 'BUSINESS', customerId })) throw new ForbiddenException({ code: 'NOT_ALLOWED', message: 'Only this business\'s Business Owner or a Platform Admin changes its software catalog.' });
      const biz = await this.prisma.customer.findUnique({ where: { id: customerId }, select: { id: true, isArchived: true } });
      if (!biz || biz.isArchived) throw new NotFoundException('Business not found');
    }
    // What a computer will be told to install is decided here: fresh, every time.
    assertFresh(freshMethod, { action: 'software.catalog' });
    const pinned = await this.pin(d.packageId, d.version, d.hash);
    paramsOf({ packageId: d.packageId, version: d.version, installerSha256: pinned.installerSha256, detection: d.detection });
    let e: SoftwareCatalogEntry;
    try {
      e = await this.prisma.softwareCatalogEntry.create({
        data: {
          scope: d.scope === 'global' ? 'GLOBAL' : 'BUSINESS', customerId, tenantId: actor.tenantId ?? null, packageId: d.packageId, name: d.name, publisher: d.publisher ?? null,
          version: d.version, ...pinned, detection: d.detection as Prisma.InputJsonValue, notes: d.notes ?? null, createdById: actor.userId, updatedById: actor.userId,
        },
      });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') throw new ConflictException({ code: 'ENTRY_EXISTS', message: `${d.packageId} is already in this catalog. Change that entry instead.` });
      throw err;
    }
    await this.audit.log({
      tenantId: actor.tenantId ?? undefined, customerId: customerId ?? undefined, actorId: actor.userId, actorIp: actor.ip, actorAgent: actor.userAgent,
      action: 'SOFTWARE_CATALOG_CREATED', resource: 'software_catalog_entry', resourceId: e.id,
      meta: { scope: d.scope, packageId: e.packageId, version: e.version, installerSha256: e.installerSha256, hashSource: e.hashSource, manifestUrl: e.manifestUrl, manifestSha256: e.manifestSha256, detection: d.detection, revision: e.revision },
    });
    return this.view(actor, e);
  }

  async update(actor: ActorContext, id: string, raw: unknown, freshMethod: string | null) {
    const e = await this.entry(actor, id);
    if (!this.canEdit(actor, e)) throw new ForbiddenException({ code: 'NOT_ALLOWED', message: e.scope === 'GLOBAL' ? 'Only a Platform Admin changes the global catalog.' : 'Only this business\'s Business Owner or a Platform Admin changes its software catalog.' });
    if (e.archivedAt) throw new ConflictException({ code: 'ENTRY_ARCHIVED', message: 'This entry is archived.' });
    const p = UpdateEntryDto.safeParse(raw);
    if (!p.success) bad(p.error);
    const d = p.data;
    assertFresh(freshMethod, { action: 'software.catalog' });
    const pinned = await this.pin(e.packageId, d.version, d.hash);
    paramsOf({ packageId: e.packageId, version: d.version, installerSha256: pinned.installerSha256, detection: d.detection });
    const r = await this.prisma.softwareCatalogEntry.updateMany({
      where: { id: e.id, revision: d.expectedRevision, archivedAt: null },
      data: { name: d.name, publisher: d.publisher ?? null, version: d.version, ...pinned, detection: d.detection as Prisma.InputJsonValue, notes: d.notes ?? null, updatedById: actor.userId, revision: { increment: 1 } },
    });
    if (!r.count) throw new ConflictException({ code: 'ENTRY_CHANGED', message: 'Someone changed this entry since you opened it. Reload it and make your change again.' });
    const after = (await this.prisma.softwareCatalogEntry.findUnique({ where: { id: e.id }, include: { customer: { select: { name: true } } } }))!;
    await this.audit.log({
      tenantId: e.tenantId ?? actor.tenantId ?? undefined, customerId: e.customerId ?? undefined, actorId: actor.userId, actorIp: actor.ip, actorAgent: actor.userAgent,
      action: 'SOFTWARE_CATALOG_UPDATED', resource: 'software_catalog_entry', resourceId: e.id,
      meta: {
        packageId: e.packageId, revision: after.revision,
        before: { version: e.version, installerSha256: e.installerSha256, hashSource: e.hashSource, manifestSha256: e.manifestSha256, detection: e.detection },
        after: { version: after.version, installerSha256: after.installerSha256, hashSource: after.hashSource, manifestSha256: after.manifestSha256, detection: after.detection },
      },
    });
    return this.view(actor, after);
  }

  async archive(actor: ActorContext, id: string, raw: unknown, freshMethod: string | null) {
    const e = await this.entry(actor, id);
    if (!this.canEdit(actor, e)) throw new ForbiddenException({ code: 'NOT_ALLOWED', message: 'Only whoever may change this catalog can archive its entries.' });
    const p = ArchiveEntryDto.safeParse(raw);
    if (!p.success) bad(p.error);
    assertFresh(freshMethod, { action: 'software.catalog' });
    const r = await this.prisma.softwareCatalogEntry.updateMany({ where: { id: e.id, revision: p.data.expectedRevision, archivedAt: null }, data: { archivedAt: new Date(), updatedById: actor.userId, revision: { increment: 1 } } });
    if (!r.count) throw new ConflictException({ code: 'ENTRY_CHANGED', message: 'This entry changed or was archived since you opened it.' });
    await this.audit.log({
      tenantId: e.tenantId ?? actor.tenantId ?? undefined, customerId: e.customerId ?? undefined, actorId: actor.userId, actorIp: actor.ip, actorAgent: actor.userAgent,
      action: 'SOFTWARE_CATALOG_ARCHIVED', resource: 'software_catalog_entry', resourceId: e.id, meta: { packageId: e.packageId, version: e.version, reason: p.data.reason },
    });
    return this.view(actor, (await this.prisma.softwareCatalogEntry.findUnique({ where: { id: e.id } }))!);
  }

  // ── Whether a computer can take a software plan ───────────────────────────

  /** Posture managers that also manage software (ConfigMgr); Intune app management is seen only by the agent. */
  private async managersOf(endpointId: string): Promise<string[]> {
    const inv = await this.prisma.endpointInventory.findUnique({ where: { endpointId }, select: { patchPosture: true } });
    const p = Posture.safeParse(inv?.patchPosture);
    return p.success ? p.data.managers.filter((m) => m === 'configmgr') : [];
  }

  /** The newest software result on this computer that refused because something else manages its software. */
  private async lastAgentSays(endpointId: string) {
    const t = await this.prisma.actionTarget.findFirst({
      where: { endpointId, job: { actionId: { in: SOFTWARE_ACTION_IDS } }, resultAt: { not: null } },
      orderBy: { resultAt: 'desc' }, select: { outcome: true, statusReason: true, resultAt: true, result: true },
    });
    return t;
  }

  /**
   * Why this person cannot put this computer in a software plan now, or null.
   * The same checks as a request; asked again when the request arrives and
   * once more by createPlan.
   */
  async availability(actor: ActorContext, ep: Ep, action: CatalogAction, opts: { online?: boolean } = {}): Promise<Availability> {
    const no = (reason: string, fix: string | null = null): Availability => ({ possible: false, reason, fix, warning: null });
    const full = await this.prisma.endpoint.findUnique({ where: { id: ep.id }, select: { platform: true, isOnline: true } });
    const ro = readOnlyAgentRefusal(full?.platform, 'install software');
    if (ro) return no(ro.message);
    const notReady = this.actions.readiness(ep, key(action));
    if (notReady) return no(notReady, /legacy agent/i.test(notReady) ? 'Switch this computer to the signed channel (Patching setup, step 2).' : /no signed agent build/i.test(notReady) ? 'Publish a signed release (Patching setup, step 1).' : /does not report support/i.test(notReady) ? 'Update it to a signed agent build from 0.34.' : 'Let it update to the published signed build.');
    const managers = await this.managersOf(ep.id);
    const last = await this.lastAgentSays(ep.id);
    if (managers.length || last?.statusReason === 'managed_elsewhere') {
      const who = managers.length ? managers.map((m) => MANAGER_LABEL[m as keyof typeof MANAGER_LABEL] ?? m).join(', ') : ((last?.result as { observed?: { managers?: string } } | null)?.observed?.managers ?? 'another management tool');
      return no(`Software on this computer is managed by ${who}; its agent refuses software plans.`, 'Deploy it from there.');
    }
    if (opts.online !== false && !full?.isOnline) return no('The computer is offline. A plan is only delivered while it checks in.', 'Wait until it is online.');
    if (!this.signer.configured()) return no('The approval signer is not set up on this server, so nothing can be approved.', 'Install the approval signer and set APPROVAL_SIGNER_INTERNAL_URL (Patching setup, steps 3–5).');
    const d = await this.policy.evaluateAction(actor, ep, 'high');
    if (!d.ok) return no(d.message, d.reason === 'action_not_granted' ? 'Ask someone whose access includes higher-risk requests.' : null);
    const blocking = await this.actions.blocking(ep.id, action.id);
    if (blocking) return no(blocking.status === 'UNKNOWN' ? 'An earlier run on this computer has an uncertain outcome.' : `A ${action.id === SOFTWARE_INSTALL.id ? 'software install' : 'software uninstall'} on this computer is already ${blocking.status.toLowerCase().replace(/_/g, ' ')}.`, blocking.status === 'UNKNOWN' ? 'Reconcile it on its deployment page first.' : 'Wait for it to finish, or cancel it.');
    const warning = last && (last.statusReason === 'winget_unavailable' || last.statusReason === 'winget_too_old')
      ? `When it last ran a software plan (${last.resultAt!.toISOString().slice(0, 10)}), this computer reported winget ${last.statusReason === 'winget_too_old' ? 'too old (App Installer before 1.7)' : 'not available'}. Update App Installer first, or the plan will not run.`
      : null;
    return { possible: true, reason: null, fix: null, warning };
  }

  // ── One computer's Software tab ───────────────────────────────────────────

  async endpointSoftware(actor: ActorContext, endpointId: string) {
    await this.acl.assertEndpointInScope(actor, endpointId);
    const ep = await this.actions.endpointFor(endpointId);
    if (!ep || !ep.customerId) throw new NotFoundException('Computer not found');
    const now = new Date();
    const [entries, inv, targets] = await Promise.all([
      this.prisma.softwareCatalogEntry.findMany({ where: { archivedAt: null, OR: [{ scope: 'GLOBAL' }, { customerId: ep.customerId }] }, orderBy: [{ name: 'asc' }, { id: 'asc' }], take: 500 }),
      this.prisma.endpointInventory.findUnique({ where: { endpointId }, select: { software: true, collectedAt: true } }),
      this.prisma.actionTarget.findMany({
        where: { endpointId, job: { actionId: { in: SOFTWARE_ACTION_IDS } } }, orderBy: { createdAt: 'desc' }, take: 100,
        select: { status: true, statusReason: true, outcome: true, result: true, resultAt: true, createdAt: true, jobId: true, job: { select: { actionId: true, params: true, status: true, softwareDeploymentId: true } } },
      }),
    ]);
    const programs = programsOf(inv?.software);
    const avail = { install: await this.availability(actor, ep, SOFTWARE_INSTALL), uninstall: await this.availability(actor, ep, SOFTWARE_UNINSTALL) };
    return {
      inventoryAt: inv?.collectedAt ?? null,
      install: avail.install, uninstall: avail.uninstall,
      entries: entries.filter((e) => this.canRead(actor, e)).map((e) => {
        const mine = targets.filter((t) => (t.job.params as { packageId?: string } | null)?.packageId === e.packageId);
        const c = complianceOf(evidenceFor(e, inv?.collectedAt ?? null, programs, mine), now);
        const last = mine[0];
        return {
          id: e.id, name: e.name, publisher: e.publisher, packageId: e.packageId, version: e.version, scope: e.scope.toLowerCase(), detection: e.detection,
          compliance: c.state, stale: c.stale, evidence: c.evidence ? { source: c.evidence.source, at: c.evidence.at, state: c.evidence.state, version: c.evidence.version } : null,
          last: last ? { jobId: last.jobId, operation: last.job.actionId === SOFTWARE_INSTALL.id ? 'install' : 'uninstall', status: last.status, outcome: last.outcome, reason: last.statusReason, at: last.resultAt ?? last.createdAt, deploymentId: last.job.softwareDeploymentId } : null,
        };
      }),
    };
  }

  /** "Install" / "Uninstall" on one computer: a one-computer deployment, one ring, the usual two approvals. */
  async single(actor: ActorContext, endpointId: string, entryId: string, operation: string, raw: unknown) {
    if (operation !== 'install' && operation !== 'uninstall') throw new NotFoundException();
    const p = SingleDto.safeParse(raw);
    if (!p.success) bad(p.error);
    await this.acl.assertEndpointInScope(actor, endpointId);
    const ep = await this.actions.endpointFor(endpointId);
    if (!ep?.customerId) throw new NotFoundException('Computer not found');
    const st = await this.availability(actor, ep, ACTIONS[operation]);
    if (!st.possible) throw new ConflictException({ code: 'SOFTWARE_NOT_POSSIBLE', message: st.reason, fix: st.fix });
    const e = await this.entry(actor, entryId);
    const d = await this.build(actor, { entryId: e.id, operation, rings: [[endpointId]], soakHours: 0, failureThreshold: 0, windowHours: p.data.windowHours, name: `${operation === 'install' ? 'Install' : 'Uninstall'} ${e.name} on ${(ep.hostname ?? ep.name).slice(0, 60)}`.slice(0, 120) }, true);
    return this.requestRing(actor, d.id, 0, { reason: p.data.reason, startsInMinutes: p.data.startsInMinutes });
  }

  // ── Deployments ───────────────────────────────────────────────────────────

  async createDeployment(actor: ActorContext, raw: unknown) {
    const p = CreateDeploymentDto.safeParse(raw);
    if (!p.success) bad(p.error);
    const d = await this.build(actor, p.data, false);
    return this.detail(actor, d.id);
  }

  /**
   * Check and store a deployment. Every computer is checked as if requested
   * alone: scope, business, live access to high-risk requests, readiness,
   * not managed elsewhere, Windows.
   */
  private async build(actor: ActorContext, dto: z.infer<typeof CreateDeploymentDto>, single: boolean): Promise<SoftwareDeployment> {
    const all = dto.rings.flat();
    if (new Set(all).size !== all.length) throw new BadRequestException({ code: 'BAD_RINGS', message: 'A computer can be in one ring only.' });
    if (dto.rings[0].length !== 1) throw new BadRequestException({ code: 'BAD_RINGS', message: 'Ring 0 is the canary: exactly one computer.' });
    const e = await this.entry(actor, dto.entryId);
    if (e.archivedAt) throw new ConflictException({ code: 'ENTRY_ARCHIVED', message: 'This catalog entry is archived; it cannot be deployed.' });
    const action = ACTIONS[dto.operation];
    let business: string | null = null;
    for (const id of all) {
      await this.acl.assertEndpointInScope(actor, id);
      const ep = await this.actions.endpointFor(id);
      if (!ep || !ep.customerId || ep.status === 'ARCHIVED' || !(await this.acl.canReachEndpoint(actor, ep))) throw new NotFoundException('Computer not found');
      if (business && ep.customerId !== business) throw new BadRequestException({ code: 'BAD_TARGETS', message: 'A deployment names computers of one business only.' });
      business = ep.customerId;
      if (e.scope === 'BUSINESS' && e.customerId !== ep.customerId) throw new NotFoundException('Catalog entry not found');
      // A later ring's computer only has to be ready when that ring is requested;
      // offline now is not a reason to refuse the deployment.
      const st = await this.availability(actor, ep, action, { online: single || id === dto.rings[0][0] ? undefined : false });
      if (!st.possible) throw new ConflictException({ code: 'SOFTWARE_NOT_POSSIBLE', message: `${ep.hostname ?? ep.name}: ${st.reason}`, fix: st.fix, endpointId: id });
    }
    const params = paramsOf(e);
    const display = {
      name: e.name.slice(0, 120), publisher: e.publisher?.slice(0, 120) ?? null, hashSource: e.hashSource === 'WINGET_PKGS' ? 'winget_pkgs' : 'admin_pasted',
      manifestSha256: e.manifestSha256, entryId: e.id, entryRevision: e.revision,
    };
    const first = (await this.actions.endpointFor(all[0]))!;
    const name = dto.name ?? `${dto.operation === 'install' ? 'Install' : 'Uninstall'} ${e.name} ${e.version}`.slice(0, 120);
    const d = await this.prisma.softwareDeployment.create({
      data: {
        tenantId: first.tenantId, customerId: business!, entryId: e.id, entryRevision: e.revision, operation: dto.operation,
        params: params as unknown as Prisma.InputJsonValue, display: display as Prisma.InputJsonValue, name,
        rings: dto.rings.map((r) => ({ endpointIds: r })) as unknown as Prisma.InputJsonValue,
        soakHours: dto.soakHours, failureThreshold: dto.failureThreshold, windowHours: dto.windowHours, single, createdById: actor.userId,
      },
    });
    await this.audit.log({
      tenantId: first.tenantId ?? undefined, customerId: business!, actorId: actor.userId, actorIp: actor.ip, action: 'SOFTWARE_DEPLOYMENT_CREATED', resource: 'software_deployment', resourceId: d.id,
      meta: { name, operation: dto.operation, entryId: e.id, entryRevision: e.revision, packageId: e.packageId, version: e.version, installerSha256: e.installerSha256, rings: dto.rings.map((r) => r.length), single, soakHours: dto.soakHours, failureThreshold: dto.failureThreshold },
    });
    return d;
  }

  private async scoped(actor: ActorContext, id: string): Promise<SoftwareDeployment> {
    const d = Id.safeParse(id).success ? await this.prisma.softwareDeployment.findUnique({ where: { id } }) : null;
    if (!d) throw new NotFoundException('Deployment not found');
    // Every computer in it must be visible: a deployment is not readable through one of its computers.
    for (const r of d.rings as unknown as Ring[]) for (const e of r.endpointIds) await this.acl.assertEndpointInScope(actor, e).catch(() => { throw new NotFoundException('Deployment not found'); });
    return d;
  }

  async listDeployments(actor: ActorContext, businessId?: string) {
    const scope = this.acl.resolveScope(actor, businessId);
    const rows = await this.prisma.softwareDeployment.findMany({ where: scope ? { customerId: scope } : {}, orderBy: { createdAt: 'desc' }, take: 50, select: { id: true } });
    const out = [];
    for (const r of rows) { try { out.push(await this.summary(actor, r.id)); } catch { /* not every computer is visible */ } }
    return out;
  }

  private async summary(actor: ActorContext, id: string) {
    const d = await this.scoped(actor, id);
    const jobs = await this.prisma.actionJob.findMany({ where: { softwareDeploymentId: d.id }, select: { ring: true, status: true }, orderBy: { createdAt: 'desc' } });
    return {
      id: d.id, name: d.name, operation: d.operation, status: d.status, pausedReason: d.pausedReason, single: d.single, businessId: d.customerId,
      entryId: d.entryId, display: d.display, rings: (d.rings as unknown as Ring[]).map((r) => r.endpointIds.length),
      lastRing: jobs[0]?.ring ?? null, lastRingStatus: jobs[0]?.status ?? null, createdAt: d.createdAt,
    };
  }

  private async ringJobs(d: SoftwareDeployment): Promise<Map<number, Job>> {
    const rows = await this.prisma.actionJob.findMany({ where: { softwareDeploymentId: d.id }, orderBy: { createdAt: 'asc' }, select: { id: true } });
    const out = new Map<number, Job>();
    for (const r of rows) { const j = await this.actions.load(r.id); out.set(j.ring!, j); }
    return out;
  }

  private async gateTargets(d: SoftwareDeployment, j: Job | undefined): Promise<SwGateTarget[]> {
    if (!j) return [];
    const rule = (d.params as unknown as SoftwareParams).detection;
    const invs = await this.prisma.endpointInventory.findMany({ where: { endpointId: { in: j.targets.map((t) => t.endpointId) } }, select: { endpointId: true, software: true, collectedAt: true } });
    const byId = new Map(invs.map((i) => [i.endpointId, i]));
    return j.targets.map((t) => {
      const inv = byId.get(t.endpointId);
      const later = inv?.collectedAt && t.resultAt && inv.collectedAt > t.resultAt ? detectFromInventory(rule, programsOf(inv.software)) : null;
      return { endpointId: t.endpointId, status: t.status, reconciled: !!t.reconciledAt, resultAt: t.resultAt, result: t.result as SwGateTarget['result'], laterInventory: later };
    });
  }

  async detail(actor: ActorContext, id: string, now = new Date()) {
    let d = await this.scoped(actor, id);
    const rings = d.rings as unknown as Ring[];
    const jobs = await this.ringJobs(d);
    const all = rings.flatMap((r) => r.endpointIds);
    const names = new Map((await this.prisma.endpoint.findMany({ where: { id: { in: all } }, select: { id: true, name: true, hostname: true } })).map((e) => [e.id, e.hostname ?? e.name]));
    const op = d.operation as 'install' | 'uninstall';
    const targets = new Map<number, SwGateTarget[]>();
    for (let i = 0; i < rings.length; i++) targets.set(i, await this.gateTargets(d, jobs.get(i)));
    const gates: SwGate[] = rings.map((_, i) => evaluateSoftwareGate({ ring: i, jobStatus: jobs.get(i)?.status ?? null, targets: targets.get(i)!, operation: op, failureThreshold: d.failureThreshold, soakHours: d.soakHours }, now));
    // A one-computer deployment is over once its plan has a final answer,
    // whatever it was: there is no later ring to hold back, and the plan's own
    // result says what happened. Not while it is unanswered or uncertain.
    const FINAL = ['passed', 'soaking', 'too_many_failures', 'canary_proved_nothing', 'canary_not_effective'];
    if (d.status === 'ACTIVE' && d.single && FINAL.includes(gates[0].reason)) {
      d = await this.prisma.softwareDeployment.update({ where: { id }, data: { status: 'COMPLETED' } });
      await this.audit.log({ tenantId: d.tenantId ?? undefined, customerId: d.customerId, action: 'SOFTWARE_DEPLOYMENT_UPDATED', resource: 'software_deployment', resourceId: id, meta: { status: 'COMPLETED', ring0: gates[0].reason } });
    } else if (d.status === 'ACTIVE') {
      const tripped = gates.findIndex((g, i) => g.reason === 'too_many_failures' && jobs.get(i)?.id !== d.resumedOverJobId);
      if (tripped >= 0) {
        d = await this.prisma.softwareDeployment.update({ where: { id }, data: { status: 'PAUSED', pausedReason: gates[tripped].detail } });
        await this.audit.log({ tenantId: d.tenantId ?? undefined, customerId: d.customerId, action: 'SOFTWARE_DEPLOYMENT_UPDATED', resource: 'software_deployment', resourceId: id, meta: { status: 'PAUSED', reason: gates[tripped].detail } });
      } else if (gates[rings.length - 1].ok || gates[rings.length - 1].reason === 'soaking') {
        d = await this.prisma.softwareDeployment.update({ where: { id }, data: { status: 'COMPLETED' } });
        await this.audit.log({ tenantId: d.tenantId ?? undefined, customerId: d.customerId, action: 'SOFTWARE_DEPLOYMENT_UPDATED', resource: 'software_deployment', resourceId: id, meta: { status: 'COMPLETED' } });
      }
    }
    const next = nextRing(d.status, d.pausedReason, jobs, gates, rings.length);
    const entry = d.entryId ? await this.prisma.softwareCatalogEntry.findUnique({ where: { id: d.entryId }, select: { revision: true, archivedAt: true } }) : null;
    return {
      id: d.id, name: d.name, operation: d.operation, businessId: d.customerId, status: d.status, pausedReason: d.pausedReason, single: d.single,
      soakHours: d.soakHours, failureThreshold: d.failureThreshold, windowHours: d.windowHours, createdById: d.createdById, createdAt: d.createdAt,
      params: d.params, display: d.display, entryId: d.entryId, entryRevision: d.entryRevision,
      entryState: !entry ? 'deleted' : entry.archivedAt ? 'archived' : entry.revision !== d.entryRevision ? 'changed' : 'current',
      next,
      rings: rings.map((r, i) => {
        const j = jobs.get(i);
        return {
          ring: i, canary: i === 0, gate: gates[i],
          job: j ? { id: j.id, status: j.status, statusReason: j.statusReason, approvalUrl: j.approvalUrl, outcome: j.outcome, window: { notBefore: j.notBefore, notAfter: j.notAfter }, digest: j.digest } : null,
          computers: r.endpointIds.map((e) => {
            const t = j?.targets.find((x) => x.endpointId === e);
            const res = (t?.result ?? null) as { reason?: string; detail?: string; observed?: Record<string, string> } | null;
            return {
              endpointId: e, hostname: names.get(e) ?? null, inPlan: !!t, status: t?.status ?? null, statusReason: t?.statusReason ?? null, outcome: t?.outcome ?? null,
              detail: res?.detail ?? null, observed: res?.observed ?? null, reconciled: t?.reconciledAt ? t.reconcileNote : null,
            };
          }),
        };
      }),
    };
  }

  /**
   * Request one ring as one signed plan. The params are the deployment's,
   * as they were when it was made; if the catalog entry has since changed or
   * been archived, no further ring is requested.
   */
  async requestRing(actor: ActorContext, id: string, ring: number, raw: unknown) {
    const p = RequestRingDto.safeParse(raw);
    if (!p.success) bad(p.error);
    const dto = p.data;
    const d = await this.scoped(actor, id);
    const entry = d.entryId ? await this.prisma.softwareCatalogEntry.findUnique({ where: { id: d.entryId } }) : null;
    if (!entry || entry.archivedAt) throw new ConflictException({ code: 'ENTRY_ARCHIVED', message: 'Its catalog entry has been archived (or removed); no further ring is requested.' });
    if (entry.revision !== d.entryRevision) throw new ConflictException({ code: 'ENTRY_CHANGED', message: 'Its catalog entry has changed since this deployment was made. Make a new deployment from the current entry.' });
    const params = SoftwareParams.safeParse(d.params);
    if (!params.success) throw new ConflictException({ code: 'PARAMS_NOT_ALLOWED', message: 'This deployment\'s parameters are no longer valid.' });
    const detail = await this.detail(actor, id);
    if (detail.next.ring !== ring || !detail.next.canRequest) {
      throw new ConflictException({ code: 'RING_GATE', message: detail.next.ring === ring ? detail.next.why : `Ring ${ring} cannot be requested now. ${detail.next.why}` });
    }
    const members = (d.rings as unknown as Ring[])[ring].endpointIds;
    const excluded = new Map(dto.exclude.map((x) => [x.endpointId, x.why]));
    for (const e of excluded.keys()) if (!members.includes(e)) throw new BadRequestException({ code: 'INVALID_REQUEST', message: 'Only computers of this ring can be left out.' });
    if (ring === 0 && excluded.size) throw new BadRequestException({ code: 'INVALID_REQUEST', message: 'The canary cannot be left out; make a new deployment with another canary.' });
    const endpointIds = members.filter((e) => !excluded.has(e));
    if (!endpointIds.length) throw new BadRequestException({ code: 'INVALID_REQUEST', message: 'Every computer of this ring is left out.' });
    const action = ACTIONS[d.operation as 'install' | 'uninstall'];
    for (const e of endpointIds) {
      const ep = (await this.actions.endpointFor(e))!;
      const st = await this.availability(actor, ep, action);
      if (!st.possible) throw new ConflictException({ code: 'SOFTWARE_NOT_POSSIBLE', message: `${ep.hostname ?? ep.name}: ${st.reason}`, fix: st.fix, endpointId: e });
    }
    const job = await this.actions.createPlan(actor, {
      action, endpointIds, params: params.data,
      reason: `${d.name} — ${ring === 0 ? (d.single ? 'one computer' : 'canary') : `ring ${ring}`}: ${dto.reason}`.slice(0, 500),
      startsInMinutes: dto.startsInMinutes, windowHours: d.windowHours,
      display: {
        updates: [], deployment: { id: d.id, name: d.name.slice(0, 120), ring, rings: (d.rings as unknown as Ring[]).length },
        software: d.display as unknown as NonNullable<NonNullable<Parameters<ActionsService['createPlan']>[1]['display']>['software']>,
      },
      softwareDeployment: { id: d.id, ring },
    });
    await this.audit.log({ tenantId: d.tenantId ?? undefined, customerId: d.customerId, actorId: actor.userId, actorIp: actor.ip, action: 'SOFTWARE_RING_REQUESTED', resource: 'software_deployment', resourceId: d.id, meta: { ring, jobId: job.id, computers: endpointIds.length, excluded: Object.fromEntries(excluded), operation: d.operation, packageId: params.data.packageId, version: params.data.version } });
    return { job: await this.actions.view(job, actor), deployment: await this.detail(actor, id) };
  }

  private mayManage(actor: ActorContext, d: SoftwareDeployment) {
    return actor.isPlatformAdmin || d.createdById === actor.userId || (!actor.technician && actor.businessId === d.customerId && this.acl.isBusinessOwner(actor));
  }

  async setStatus(actor: ActorContext, id: string, to: 'pause' | 'resume' | 'cancel', raw: unknown) {
    const dto = ReasonDto.safeParse(raw ?? {});
    if (!dto.success) throw new BadRequestException({ code: 'INVALID_REQUEST', message: 'A reason of at least 3 characters is required.' });
    const d = await this.scoped(actor, id);
    if (!this.mayManage(actor, d)) throw new ForbiddenException({ code: 'NOT_ALLOWED', message: 'Only whoever created the deployment, a Business Owner of this business or a Platform Admin can change it.' });
    const from = { pause: ['ACTIVE'], resume: ['PAUSED'], cancel: ['ACTIVE', 'PAUSED'] }[to];
    if (!from.includes(d.status)) throw new ConflictException({ code: 'NOT_ALLOWED_NOW', message: `The deployment is ${d.status.toLowerCase()}.` });
    let resumedOverJobId = d.resumedOverJobId;
    if (to === 'resume') {
      const latest = await this.prisma.actionJob.findFirst({ where: { softwareDeploymentId: id }, orderBy: { createdAt: 'desc' }, select: { id: true } });
      resumedOverJobId = latest?.id ?? null;
    }
    if (to === 'cancel') {
      // What has not reached a computer is stopped; anything delivered runs to its own result.
      for (const j of await this.prisma.actionJob.findMany({ where: { softwareDeploymentId: id, status: { in: ['AWAITING_APPROVAL', 'APPROVED'] } }, select: { id: true } })) {
        await this.actions.cancel(actor, j.id).catch(() => undefined);
      }
    }
    const status = { pause: 'PAUSED', resume: 'ACTIVE', cancel: 'CANCELED' }[to] as SoftwareDeployment['status'];
    await this.prisma.softwareDeployment.update({ where: { id }, data: { status, resumedOverJobId, pausedReason: to === 'pause' ? dto.data.reason : to === 'resume' ? null : d.pausedReason } });
    await this.audit.log({ tenantId: d.tenantId ?? undefined, customerId: d.customerId, actorId: actor.userId, actorIp: actor.ip, action: 'SOFTWARE_DEPLOYMENT_UPDATED', resource: 'software_deployment', resourceId: id, meta: { status, reason: dto.data.reason } });
    return this.detail(actor, id);
  }
}
