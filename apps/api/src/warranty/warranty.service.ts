import { BadRequestException, ConflictException, ForbiddenException, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { WarrantyVendor } from '@prisma/client';
import { z } from 'zod';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { AccessControlService, type ActorContext } from '../rbac/access-control.service';
import { CAP } from '../rbac/capabilities';
import { activePause, pauseMessage } from '../containment/pause';
import { openSecret, sealSecret } from '../common/secret-box';
import { LOOKUP_VENDORS, lookup, type LookupResult, type LookupVendor } from './client';
import { cleanSerial, COVERAGE_RE, daysLeft, identifyMaker, supportInfo, VENDOR_LABEL, WARRANTY_SOURCE_LABEL, warrantyState, type VendorKey } from './vendors';

/**
 * Hardware warranty (0.56).
 *
 *   manual    a person with computers:edit on the computer sets or clears
 *             its dates on the device page; audited with before and after.
 *             The sweep never overwrites a manual entry.
 *   vendor    Settings → Warranty: a Platform Admin enables a vendor whose
 *             lookup is implemented (warranty/client.ts: Dell, Lenovo) and
 *             gives its credential, sealed with its own purpose. Off by
 *             default. Saving needs fresh authentication (catalog key
 *             warranty.settings, §62).
 *   sweep     every WARRANTY_SWEEP_SECONDS (default 10 min) at most
 *             WARRANTY_LOOKUPS_PER_HOUR computers (default 60, at most 500)
 *             are asked about, each at most once per LOOKUP_INTERVAL_DAYS
 *             (30; a failure that may pass — a timeout, a 5xx — is asked
 *             again after a day). A computer of a business under an
 *             `integration` containment pause (or a global one) is not asked
 *             about: the lookup sends its serial to a third party.
 *             WARRANTY_SWEEP=off stops it.
 *
 * Only the serial leaves (client.ts). Lookups are not audited one by one —
 * the computer's warrantyLookupAt / warrantyLookupResult record each — but a
 * person's "Check now" is.
 */

export const LOOKUP_INTERVAL_DAYS = 30;
const DAY_MS = 86_400_000;
/** After a failure that may pass, ask again in a day rather than in thirty. */
const RETRY_AFTER_MS = DAY_MS;
const PER_TICK_MAX = 25;
const CANDIDATES_PER_TICK = 500;

export function perHour(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number(env.WARRANTY_LOOKUPS_PER_HOUR);
  return Number.isInteger(n) && n >= 1 ? Math.min(n, 500) : 60;
}

/** What the sweep may still do this hour. Pure: unit-tested. */
export function budget(limitPerHour: number, usedLastHour: number): number {
  return Math.max(0, Math.min(PER_TICK_MAX, limitPerHour - usedLastHour));
}

const DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'a date, YYYY-MM-DD');
export const ManualInput = z.object({
  startsAt: DATE.nullable().optional(),
  endsAt: DATE.nullable(),
  coverage: z.string().trim().max(200).regex(COVERAGE_RE, 'letters, digits, spaces and . , : ; ( ) / & + \' # - only').nullable().optional(),
}).strict();

export const VendorInput = z.object({
  enabled: z.boolean(),
  /** Dell only: the TechDirect client id. */
  clientId: z.string().trim().min(4).max(200).regex(/^[\x21-\x7e]+$/, 'printable characters, no spaces').nullable().optional(),
  /** Absent = keep; null = clear. Dell: the client secret. Lenovo: the ClientID token. */
  secret: z.string().min(8).max(512).regex(/^[\x21-\x7e]+$/, 'printable characters, no spaces').nullable().optional(),
}).strict();

const bad = (e: z.ZodError) => new BadRequestException({ code: 'INVALID_REQUEST', message: e.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; ') });
const parseDay = (s: string | null | undefined): Date | null => {
  if (!s) return null;
  const d = new Date(`${s}T00:00:00.000Z`);
  if (!Number.isFinite(d.getTime()) || d.toISOString().slice(0, 10) !== s) throw new BadRequestException({ code: 'INVALID_DATE', message: `${s} is not a date.` });
  const y = d.getUTCFullYear();
  if (y < 1990 || y > 2099) throw new BadRequestException({ code: 'INVALID_DATE', message: 'Warranty dates must fall between 1990 and 2099.' });
  return d;
};
const last4 = (s: string) => s.slice(-4);
const isLookupVendor = (v: unknown): v is LookupVendor => (LOOKUP_VENDORS as readonly string[]).includes(v as string);

type Ep = {
  id: string; customerId: string | null; serialNumber: string | null;
  warrantyStartsAt: Date | null; warrantyEndsAt: Date | null; warrantySource: string | null; warrantyCheckedAt: Date | null; warrantyCoverage: string | null;
  warrantyLookupAt: Date | null; warrantyLookupResult: string | null;
  inventory: { manufacturer: string | null; model: string | null; serialNumber: string | null } | null;
};
const EP_SELECT = {
  id: true, customerId: true, serialNumber: true,
  warrantyStartsAt: true, warrantyEndsAt: true, warrantySource: true, warrantyCheckedAt: true, warrantyCoverage: true,
  warrantyLookupAt: true, warrantyLookupResult: true,
  inventory: { select: { manufacturer: true, model: true, serialNumber: true } },
} as const;

@Injectable()
export class WarrantyService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger('Warranty');
  private readonly encKey: string | undefined;
  private timer: ReturnType<typeof setInterval> | null = null;
  private first: ReturnType<typeof setTimeout> | null = null;
  private busy = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly acl: AccessControlService,
    config: ConfigService,
  ) {
    this.encKey = config.get<string>('ENCRYPTION_KEY');
  }

  onModuleInit() {
    if (process.env.WARRANTY_SWEEP === 'off') return;
    const every = Math.max(2, Number(process.env.WARRANTY_SWEEP_SECONDS) || 600) * 1000;
    this.first = setTimeout(() => { void this.sweep(); }, Math.min(60_000, every));
    this.timer = setInterval(() => { void this.sweep(); }, every);
  }
  onModuleDestroy() { if (this.timer) clearInterval(this.timer); if (this.first) clearTimeout(this.first); }

  // ── One computer ──────────────────────────────────────────────────────────

  private serialOf(e: Ep): string | null { return cleanSerial(e.inventory?.serialNumber ?? e.serialNumber); }
  private vendorOf(e: Ep): VendorKey | null {
    const m = identifyMaker(e.inventory?.manufacturer, e.inventory?.model);
    return m.kind === 'vendor' ? m.vendor : null;
  }

  private view(e: Ep, vendors: Map<string, WarrantyVendor>, now = new Date()) {
    const vendor = this.vendorOf(e);
    const row = vendor ? vendors.get(vendor) : undefined;
    return {
      warranty: {
        startsAt: e.warrantyStartsAt, endsAt: e.warrantyEndsAt, coverage: e.warrantyCoverage,
        source: e.warrantySource, sourceLabel: e.warrantySource ? WARRANTY_SOURCE_LABEL[e.warrantySource] ?? e.warrantySource : null,
        checkedAt: e.warrantyCheckedAt, state: warrantyState(e.warrantyEndsAt, now), daysLeft: daysLeft(e.warrantyEndsAt, now),
      },
      support: supportInfo(e.inventory?.manufacturer, e.inventory?.model, e.inventory?.serialNumber ?? e.serialNumber),
      lookup: {
        vendor: vendor && isLookupVendor(vendor) ? vendor : null,
        vendorLabel: vendor ? VENDOR_LABEL[vendor] : null,
        implemented: !!vendor && isLookupVendor(vendor),
        enabled: !!row?.enabled && !!row.secretEnc,
        lastAttemptAt: e.warrantyLookupAt, lastResult: e.warrantyLookupResult,
        intervalDays: LOOKUP_INTERVAL_DAYS,
      },
    };
  }

  async get(actor: ActorContext, endpointId: string) {
    await this.acl.assertEndpointInScope(actor, endpointId, CAP.COMPUTERS_VIEW);
    const e = await this.prisma.endpoint.findUniqueOrThrow({ where: { id: endpointId }, select: EP_SELECT });
    const vendors = new Map((await this.prisma.warrantyVendor.findMany()).map((v) => [v.vendor, v]));
    return this.view(e, vendors);
  }

  /** Set (or, with every field null, clear) a computer's warranty by hand. */
  async setManual(actor: ActorContext, endpointId: string, raw: unknown) {
    const ep = await this.acl.assertEndpointInScope(actor, endpointId, CAP.COMPUTERS_EDIT);
    const d = ManualInput.safeParse(raw ?? {});
    if (!d.success) throw bad(d.error);
    const startsAt = parseDay(d.data.startsAt), endsAt = parseDay(d.data.endsAt);
    const coverage = d.data.coverage ? d.data.coverage : null;
    const clear = !endsAt && !startsAt && !coverage;
    if (!clear && !endsAt) throw new BadRequestException({ code: 'END_DATE_REQUIRED', message: 'Enter the date the warranty ends.' });
    if (startsAt && endsAt && startsAt > endsAt) throw new BadRequestException({ code: 'INVALID_DATE', message: 'The start date is after the end date.' });
    const cur = await this.prisma.endpoint.findUniqueOrThrow({ where: { id: endpointId }, select: EP_SELECT });
    const now = new Date();
    const data = clear
      ? { warrantySource: null, warrantyStartsAt: null, warrantyEndsAt: null, warrantyCoverage: null, warrantyCheckedAt: null }
      : { warrantySource: 'manual', warrantyStartsAt: startsAt, warrantyEndsAt: endsAt, warrantyCoverage: coverage, warrantyCheckedAt: now };
    // Conditional on what was read: two people editing at once do not both "win".
    const w = await this.prisma.endpoint.updateMany({
      where: { id: endpointId, warrantySource: cur.warrantySource, warrantyEndsAt: cur.warrantyEndsAt, warrantyStartsAt: cur.warrantyStartsAt },
      data,
    });
    if (!w.count) throw new ConflictException({ code: 'WARRANTY_CHANGED', message: 'The warranty changed while you were editing it. Reload and try again.' });
    const pub = (x: { warrantySource: string | null; warrantyStartsAt: Date | null; warrantyEndsAt: Date | null; warrantyCoverage: string | null }) =>
      ({ source: x.warrantySource, startsAt: x.warrantyStartsAt?.toISOString().slice(0, 10) ?? null, endsAt: x.warrantyEndsAt?.toISOString().slice(0, 10) ?? null, coverage: x.warrantyCoverage });
    await this.audit.logOrFail({
      action: 'WARRANTY_SET', actorId: actor.userId, actorIp: actor.ip, tenantId: actor.tenantId ?? undefined, customerId: ep.customerId ?? undefined,
      resource: 'endpoint', resourceId: endpointId,
      meta: { before: pub(cur), after: pub({ ...cur, ...data }), cleared: clear },
    });
    return this.get(actor, endpointId);
  }

  /** "Check now": one lookup for one computer, by a person who may edit it. */
  async checkNow(actor: ActorContext, endpointId: string) {
    const ep = await this.acl.assertEndpointInScope(actor, endpointId, CAP.COMPUTERS_EDIT);
    const e = await this.prisma.endpoint.findUniqueOrThrow({ where: { id: endpointId }, select: EP_SELECT });
    if (e.warrantySource === 'manual') throw new ConflictException({ code: 'WARRANTY_MANUAL', message: 'This warranty was entered by hand. Clear it first to look it up from the vendor.' });
    const vendor = this.vendorOf(e);
    if (!vendor || !isLookupVendor(vendor)) throw new ConflictException({ code: 'WARRANTY_LOOKUP_UNSUPPORTED', message: vendor ? `There is no warranty lookup for ${VENDOR_LABEL[vendor]}. Enter the dates by hand.` : 'The manufacturer is not one with a warranty lookup. Enter the dates by hand.' });
    const creds = await this.credentials(vendor);
    if (!creds) throw new ConflictException({ code: 'WARRANTY_LOOKUP_OFF', message: `The ${VENDOR_LABEL[vendor]} warranty lookup is not switched on (Settings → Warranty).` });
    const serial = this.serialOf(e);
    if (!serial) throw new ConflictException({ code: 'NO_SERIAL', message: 'This computer has not reported a usable serial number.' });
    const pause = await activePause(this.prisma, 'integration', ep.customerId);
    if (pause) throw new ForbiddenException({ code: 'CONTAINED', message: pauseMessage(pause, 'integration'), pauseId: pause.id, scope: pause.scope.toLowerCase() });
    await this.audit.logOrFail({
      action: 'WARRANTY_LOOKUP_REQUESTED', actorId: actor.userId, actorIp: actor.ip, tenantId: actor.tenantId ?? undefined, customerId: ep.customerId ?? undefined,
      resource: 'endpoint', resourceId: endpointId, meta: { vendor },
    });
    const r = await this.lookupAndStore(e, vendor, creds, serial, new Date());
    return { result: r.ok ? 'OK' : r.code, ...(await this.get(actor, endpointId)) };
  }

  private async credentials(vendor: LookupVendor) {
    const v = await this.prisma.warrantyVendor.findUnique({ where: { vendor } });
    if (!v?.enabled || !v.secretEnc) return null;
    try { return { clientId: v.clientId, secret: openSecret(this.encKey, 'rem0te-warranty-key-v1', v.secretEnc) }; } catch { return null; }
  }

  /** Ask the vendor and write what it said. The serial is the only thing about the computer passed on. */
  private async lookupAndStore(e: Ep, vendor: LookupVendor, creds: { clientId: string | null; secret: string }, serial: string, now: Date): Promise<LookupResult> {
    const r = await lookup(vendor, creds, serial);
    const code = r.ok ? 'OK' : r.code;
    if (r.ok) {
      // Never over a manual entry made while the request was out.
      await this.prisma.endpoint.updateMany({
        where: { id: e.id, OR: [{ warrantySource: null }, { warrantySource: { not: 'manual' } }] },
        data: {
          warrantySource: vendor, warrantyStartsAt: r.found.startsAt && r.found.startsAt <= r.found.endsAt ? r.found.startsAt : null,
          warrantyEndsAt: r.found.endsAt, warrantyCoverage: r.found.coverage, warrantyCheckedAt: now, warrantyLookupAt: now, warrantyLookupResult: code,
        },
      });
    } else {
      await this.prisma.endpoint.update({
        where: { id: e.id },
        data: { warrantyLookupAt: r.transient ? new Date(now.getTime() - (LOOKUP_INTERVAL_DAYS * DAY_MS - RETRY_AFTER_MS)) : now, warrantyLookupResult: code },
      });
    }
    await this.prisma.warrantyVendor.update({ where: { vendor }, data: { lastResultAt: now, lastResult: code } }).catch(() => undefined);
    return r;
  }

  // ── The sweep ─────────────────────────────────────────────────────────────

  async sweep(now = new Date()) {
    if (this.busy) return;
    this.busy = true;
    try { await this.tick(now); }
    catch (e) { this.logger.error(`warranty sweep: ${(e as Error).message}`); }
    finally { this.busy = false; }
  }

  private async tick(now: Date) {
    const rows = await this.prisma.warrantyVendor.findMany({ where: { enabled: true, secretEnc: { not: null } } });
    const enabled = new Set(rows.map((r) => r.vendor).filter(isLookupVendor));
    if (!enabled.size) return;
    const hourAgo = new Date(now.getTime() - 3_600_000);
    const used = await this.prisma.endpoint.count({ where: { warrantyLookupAt: { gte: hourAgo } } });
    let left = budget(perHour(), used);
    if (!left) return;
    const cutoff = new Date(now.getTime() - LOOKUP_INTERVAL_DAYS * DAY_MS);
    const candidates = await this.prisma.endpoint.findMany({
      where: {
        status: 'ACTIVE',
        OR: [{ warrantySource: null }, { warrantySource: { not: 'manual' } }],
        AND: [{ OR: [{ warrantyLookupAt: null }, { warrantyLookupAt: { lt: cutoff } }] }],
        inventory: { isNot: null },
      },
      select: EP_SELECT, orderBy: [{ warrantyLookupAt: { sort: 'asc', nulls: 'first' } }, { id: 'asc' }], take: CANDIDATES_PER_TICK,
    });
    const creds = new Map<LookupVendor, { clientId: string | null; secret: string }>();
    for (const e of candidates) {
      if (left <= 0) break;
      const vendor = this.vendorOf(e);
      if (!vendor || !isLookupVendor(vendor) || !enabled.has(vendor)) continue;
      const serial = this.serialOf(e);
      if (!serial) continue;
      if (await activePause(this.prisma, 'integration', e.customerId)) continue;
      if (!creds.has(vendor)) { const c = await this.credentials(vendor); if (!c) { enabled.delete(vendor); continue; } creds.set(vendor, c); }
      // Claim it: one instance, one ask.
      const claim = await this.prisma.endpoint.updateMany({
        where: { id: e.id, OR: [{ warrantyLookupAt: null }, { warrantyLookupAt: { lt: cutoff } }] },
        data: { warrantyLookupAt: now },
      });
      if (!claim.count) continue;
      left--;
      await this.lookupAndStore(e, vendor, creds.get(vendor)!, serial, now);
    }
  }

  // ── Settings ──────────────────────────────────────────────────────────────

  private vendorView(vendor: LookupVendor, v: WarrantyVendor | null) {
    return {
      vendor, label: VENDOR_LABEL[vendor], enabled: !!v?.enabled,
      clientId: vendor === 'dell' ? v?.clientId ?? null : null,
      secretSet: !!v?.secretEnc, secretLast4: v?.secretEnc ? v.secretLast4 : null,
      updatedAt: v?.updatedAt ?? null, lastResultAt: v?.lastResultAt ?? null, lastResult: v?.lastResult ?? null,
    };
  }

  async settings() {
    const rows = new Map((await this.prisma.warrantyVendor.findMany()).map((v) => [v.vendor, v]));
    return {
      vendors: LOOKUP_VENDORS.map((k) => this.vendorView(k, rows.get(k) ?? null)),
      manualOnly: ['hp', 'hpe', 'microsoft', 'apple', 'asus', 'acer'].map((k) => ({ vendor: k, label: VENDOR_LABEL[k as VendorKey] })),
      sweep: { enabled: process.env.WARRANTY_SWEEP !== 'off', perHour: perHour(), intervalDays: LOOKUP_INTERVAL_DAYS },
    };
  }

  async putVendor(a: ActorContext, vendor: string, raw: unknown) {
    if (!isLookupVendor(vendor)) throw new BadRequestException({ code: 'UNKNOWN_VENDOR', message: `There is no warranty lookup for "${String(vendor).slice(0, 20)}".` });
    const d = VendorInput.safeParse(raw ?? {});
    if (!d.success) throw bad(d.error);
    if (vendor !== 'dell' && d.data.clientId) throw new BadRequestException({ code: 'INVALID_REQUEST', message: 'Only Dell takes a client id.' });
    const cur = await this.prisma.warrantyVendor.findUnique({ where: { vendor } });
    const clientId = vendor === 'dell' ? (d.data.clientId === undefined ? cur?.clientId ?? null : d.data.clientId) : null;
    // A different Dell client id is a different credential: the old secret is not kept for it.
    const moved = vendor === 'dell' && !!cur && (cur.clientId ?? null) !== clientId;
    let secretEnc: string | null; let secretLast4: string | null;
    let keyChange: 'set' | 'kept' | 'cleared' | 'cleared_client_changed' | 'none';
    if (typeof d.data.secret === 'string') { secretEnc = sealSecret(this.encKey, 'rem0te-warranty-key-v1', d.data.secret); secretLast4 = last4(d.data.secret); keyChange = 'set'; }
    else if (d.data.secret === null) { secretEnc = null; secretLast4 = null; keyChange = cur?.secretEnc ? 'cleared' : 'none'; }
    else if (cur?.secretEnc && moved) { secretEnc = null; secretLast4 = null; keyChange = 'cleared_client_changed'; }
    else { secretEnc = cur?.secretEnc ?? null; secretLast4 = cur?.secretLast4 ?? null; keyChange = secretEnc ? 'kept' : 'none'; }
    if (d.data.enabled && !secretEnc) throw new BadRequestException({ code: 'KEY_REQUIRED', message: vendor === 'dell' ? 'Enter the TechDirect client secret to switch the Dell lookup on.' : 'Enter the Lenovo ClientID to switch the Lenovo lookup on.' });
    if (d.data.enabled && vendor === 'dell' && !clientId) throw new BadRequestException({ code: 'CLIENT_ID_REQUIRED', message: 'Enter the TechDirect client id.' });
    const data = { enabled: d.data.enabled, clientId, secretEnc, secretLast4, updatedById: a.userId };
    const row = await this.prisma.warrantyVendor.upsert({ where: { vendor }, create: { vendor, ...data }, update: data });
    const pub = (s: WarrantyVendor | null) => s && { enabled: s.enabled, clientIdSet: !!s.clientId };
    // The secret is never in the audit row: only whether it changed.
    await this.audit.logOrFail({
      action: 'WARRANTY_SETTINGS_CHANGED', actorId: a.userId, actorIp: a.ip, tenantId: a.tenantId ?? undefined, resource: 'warranty_vendor', resourceId: vendor,
      meta: { vendor, before: pub(cur), after: pub(row), key: keyChange },
    });
    return { ...this.vendorView(vendor, row), keyChange };
  }
}
