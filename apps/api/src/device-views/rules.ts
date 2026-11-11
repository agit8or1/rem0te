import { BadRequestException } from '@nestjs/common';
import { z } from 'zod';
import { isOwnerRole, CAP } from '../rbac/capabilities';
import type { ActorContext } from '../rbac/access-control.service';
import { LIST_FILTER_KEYS, parseListQuery, SORT_KEYS } from '../endpoints/list-query';
import { PLATFORM_PERM } from '../rbac/platform-permissions';

/**
 * Device groups, saved views and bulk actions (0.33): the pure decisions,
 * kept apart from Prisma and Nest so they are unit-tested without a database
 * (scripts/unit-device-views.mjs) and the services cannot each grow their own
 * idea of them.
 */

export const ID = /^[A-Za-z0-9_-]{8,64}$/;
export const VIEW_RESOURCE = 'devices';
/** Largest selection one bulk request (or bulk export) may name. */
export const BULK_MAX = 200;
export const MAX_PERSONAL_VIEWS = 50;
export const MAX_SHARED_VIEWS = 100;
export const MAX_GROUPS_PER_BUSINESS = 500;

const bad = (code: string, message: string) => new BadRequestException({ code, message });

// ── Who may manage a business's groups and shared views ─────────────────────

/** The MSP: a Platform Admin, or a technicians:manage holder not acting through an assignment. */
export function isMsp(a: ActorContext): boolean {
  return a.isPlatformAdmin || (!a.technician && (a.platformPermissions ?? []).includes(PLATFORM_PERM.TECHNICIANS_MANAGE));
}

/**
 * May this person edit `customerId`'s device groups and shared views? The
 * refusal, or null. Modelled on the client-update policy rule (0.32), for
 * the same reason: a group or a shared view is about the whole business.
 *   - the MSP: yes;
 *   - a technician: only with ONE assignment granting computers:edit with no
 *     computer list (the whole business), in that business;
 *   - a Business Owner: their own business;
 *   - a Business User: no, whatever they hold — computers:edit is granted per
 *     business, but a Business User may see only some of its computers.
 */
export function manageRefusal(a: ActorContext, customerId: string): string | null {
  if (isMsp(a)) return null;
  if (a.technician) {
    if (a.technician.businessId !== customerId) return 'You are not assigned to this business.';
    const whole = a.technician.sources.some((s) => (s.capabilities as string[]).includes(CAP.COMPUTERS_EDIT) && s.endpointIds === null);
    return whole ? null : 'Device groups and shared views need an assignment that grants computers:edit over the whole business.';
  }
  if (a.businessId !== customerId) return 'You do not have access to that business.';
  if (isOwnerRole(a.roleType)) return null;
  return 'Device groups and shared views are managed by a Business Owner, a technician with computers:edit over the whole business, or the MSP.';
}

// ── Saved views ─────────────────────────────────────────────────────────────

const COLUMN = /^[a-zA-Z][a-zA-Z0-9]{0,31}$/;

const viewFields = {
  name: z.string().trim().min(1).max(60),
  filters: z.record(z.string(), z.unknown()),
  columns: z.array(z.string().regex(COLUMN)).max(30),
  sort: z.enum(SORT_KEYS),
  dir: z.enum(['asc', 'desc']),
  density: z.enum(['comfortable', 'compact']),
};

export const ViewInput = z.object({
  name: viewFields.name,
  filters: viewFields.filters.default({}),
  columns: viewFields.columns.default([]),
  sort: viewFields.sort.default('online'),
  dir: viewFields.dir.default('asc'),
  density: viewFields.density.default('comfortable'),
  shared: z.boolean().default(false),
  /** The business a shared view belongs to. Required for a Platform Admin; anyone else is pinned to their own. */
  businessId: z.string().regex(ID).optional(),
}).strict();
export type ViewInput = z.infer<typeof ViewInput>;

/** An update changes what the view shows, never who it is for: `shared` and `businessId` are fixed at creation. */
export const ViewUpdate = z.object(viewFields).partial().strict();
export type ViewUpdate = z.infer<typeof ViewUpdate>;

export type StoredFilters = Partial<Record<(typeof LIST_FILTER_KEYS)[number], string | boolean>>;

/**
 * A view's filters, validated by the device list's own parser and reduced to
 * the parameters it accepts. Unknown keys are refused, not dropped: a view
 * that silently lost a filter would show more than its author meant.
 */
export function normalizeViewFilters(raw: Record<string, unknown>): StoredFilters {
  const unknown = Object.keys(raw).filter((k) => !(LIST_FILTER_KEYS as readonly string[]).includes(k));
  if (unknown.length) throw bad('INVALID_VIEW', `A view stores only device-list filters; not: ${unknown.join(', ')}`);
  const asQuery: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (v === null || v === undefined || v === '' || v === false) continue;
    if (typeof v === 'boolean') asQuery[k] = String(v);
    else if (typeof v === 'string') asQuery[k] = v;
    else throw bad('INVALID_VIEW', `${k} must be a string`);
  }
  const q = parseListQuery(asQuery);
  const out: StoredFilters = {};
  if (q.search) out.search = q.search;
  if (q.businessId) out.businessId = q.businessId;
  if (q.siteId) out.siteId = q.siteId;
  if (q.online) out.online = q.online;
  if (q.alerts) out.alerts = q.alerts;
  if (q.restartPending) out.restartPending = true;
  if (q.agent) out.agent = q.agent;
  if (q.status && q.status !== 'current') out.status = q.status;
  if (q.groupId) out.groupId = q.groupId;
  for (const k of ['businessId', 'siteId', 'groupId'] as const) {
    if (out[k] !== undefined && !ID.test(String(out[k]))) throw bad('INVALID_VIEW', `${k} is not an id`);
  }
  return out;
}

// ── Bulk actions ────────────────────────────────────────────────────────────

/**
 * What a bulk request may do. Each one already exists for one computer and is
 * safe to repeat. There is deliberately no connect, archive, delete or
 * approved action here: those keep their own flows.
 */
// agent.update / agent.migrate (0.34): the Agent card's two buttons, per computer.
export const BULK_ACTIONS = ['group.add', 'group.remove', 'inventory.refresh', 'client.update', 'agent.update', 'agent.migrate'] as const;
export type BulkAction = (typeof BULK_ACTIONS)[number];

const BulkBody = z.object({
  action: z.enum(BULK_ACTIONS),
  endpointIds: z.array(z.string().regex(ID)).min(1),
  groupId: z.string().regex(ID).optional(),
  // agent.migrate only: recorded in the audit log, like the single route's.
  reason: z.string().trim().min(3).max(400).optional(),
}).strict();
export type BulkInput = { action: BulkAction; endpointIds: string[]; groupId?: string; reason?: string };

/** The selection, de-duplicated (order kept) and capped. Over the cap is a 400 naming it, never a silent truncation. */
export function parseSelection(ids: unknown): string[] {
  if (!Array.isArray(ids) || ids.length === 0) throw bad('INVALID_REQUEST', 'endpointIds must be a non-empty list');
  if (ids.length > BULK_MAX) throw bad('BULK_TOO_LARGE', `At most ${BULK_MAX} devices per request; this one names ${ids.length}.`);
  if (!ids.every((x) => typeof x === 'string' && ID.test(x))) throw bad('INVALID_REQUEST', 'endpointIds must be ids');
  return [...new Set(ids as string[])];
}

export function parseBulk(raw: unknown): BulkInput {
  const body = (raw ?? {}) as Record<string, unknown>;
  // The cap is checked before the schema so its refusal says what it is.
  const endpointIds = parseSelection(body.endpointIds);
  const p = BulkBody.safeParse({ ...body, endpointIds });
  if (!p.success) throw bad('INVALID_REQUEST', p.error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; '));
  const groupAction = p.data.action === 'group.add' || p.data.action === 'group.remove';
  if (groupAction && !p.data.groupId) throw bad('INVALID_REQUEST', 'groupId is required for a group action');
  if (!groupAction && p.data.groupId) throw bad('INVALID_REQUEST', 'groupId applies only to group actions');
  if (p.data.action === 'agent.migrate' && !p.data.reason) throw bad('REASON_REQUIRED', 'Give a reason of 3 to 400 characters; it is recorded in the audit log.');
  if (p.data.action !== 'agent.migrate' && p.data.reason) throw bad('INVALID_REQUEST', 'reason applies only to agent.migrate');
  return p.data;
}

export interface BulkResult {
  endpointId: string;
  /** Only for a computer the caller can see. */
  name?: string;
  ok: boolean;
  /** For ok: false. Stable, for the UI. */
  code?: string;
  reason?: string;
  /** For ok: true when nothing needed doing (already in the group, already queued). */
  unchanged?: boolean;
}

/**
 * The fleet-abuse guard's device and business limits, applied BEFORE a bulk
 * refresh asks it about each computer (0.33). The guard trips — pausing the
 * person and alerting an administrator — the moment a request would exceed
 * them, which is right for someone fanning out single requests and wrong for
 * a person who ticked 200 boxes. So the bulk path stops short of the limit
 * and refuses the rest with FLEET_LIMIT. It never admits anything: every
 * computer it lets through is still admitted by the guard itself.
 *
 * `seenDevices` / `seenBusinesses` are what the guard has recorded for this
 * person inside its window; `exempt` the computers an approved maintenance
 * exception lets past the cap.
 */
export class FleetBudget {
  private readonly devices: Set<string>;
  private readonly businesses: Set<string>;
  constructor(seenDevices: Iterable<string>, seenBusinesses: Iterable<string>, private readonly exempt: Set<string> = new Set()) {
    this.devices = new Set(seenDevices);
    this.businesses = new Set(seenBusinesses);
  }
  /** Would admitting this computer exceed `limits`? The limit text, or null. Does not record anything. */
  wouldExceed(endpointId: string, customerId: string | null, limits: { devices: number; businesses: number }): string | null {
    if (this.exempt.has(endpointId)) return null;
    if (!this.devices.has(endpointId) && this.devices.size + 1 > limits.devices) return `devices ${this.devices.size + 1} > ${limits.devices}`;
    if (customerId && !this.businesses.has(customerId) && this.businesses.size + 1 > limits.businesses) return `businesses ${this.businesses.size + 1} > ${limits.businesses}`;
    return null;
  }
  /** Record a computer the guard admitted. */
  admitted(endpointId: string, customerId: string | null) {
    this.devices.add(endpointId);
    if (customerId) this.businesses.add(customerId);
  }
}

/** Turn a refusal thrown by a single-computer path into a per-computer result. */
export function refusalOf(e: unknown): { code: string; reason: string } {
  const err = e as { getStatus?: () => number; getResponse?: () => unknown; message?: string };
  const status = typeof err?.getStatus === 'function' ? err.getStatus() : 500;
  const body = typeof err?.getResponse === 'function' ? err.getResponse() : null;
  const b = (body && typeof body === 'object' ? body : {}) as { code?: unknown; message?: unknown };
  const msg = typeof b.message === 'string' ? b.message : Array.isArray(b.message) ? b.message.join('; ') : typeof body === 'string' ? body : err?.message ?? 'Refused';
  if (status === 404) return { code: 'NOT_FOUND', reason: 'Computer not found' };
  if (typeof b.code === 'string') return { code: b.code, reason: msg };
  if (status === 403) return { code: 'NOT_ALLOWED', reason: msg };
  if (status === 400) return { code: 'INVALID_REQUEST', reason: msg };
  if (status === 409) return { code: 'CONFLICT', reason: msg };
  return { code: 'ERROR', reason: 'This computer could not be processed; nothing was changed for it.' };
}
