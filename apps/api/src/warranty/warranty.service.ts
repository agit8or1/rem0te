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
import { LOOKUP_VENDORS, lookup, normaliseApplePrivateKey, type Credentials, type LookupResult, type LookupVendor } from './client';
import {
  cleanSerial, COVERAGE_RE, daysLeft, identifyMaker, isLookupVendor, NO_LOOKUP_REASON, supportInfo, VENDOR_KEYS, VENDOR_LABEL, WARRANTY_SOURCE_LABEL, warrantyGap, warrantyState, type VendorKey,
} from './vendors';

/**
 * Hardware warranty (0.56).
 *
 *   manual    a person with computers:edit on the computer sets or clears
 *             its dates on the device page; audited with before and after.
 *             The sweep never overwrites a manual entry.
 *   vendor    Administration → Warranty: a Platform Admin enables a vendor whose
 *             lookup is implemented (warranty/client.ts: Dell, Lenovo, and
 *             from 0.61 HP and Apple) and
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
/** How far one tick reads past computers it cannot look up (0.61). */
const CANDIDATES_SCAN_MAX = 50_000;

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
  /** Dell: the TechDirect client id. HP: the app's API key. Apple: the API account's client id. */
  clientId: z.string().trim().min(4).max(200).regex(/^[\x21-\x7e]+$/, 'printable characters, no spaces').nullable().optional(),
  /** Apple only: the API account's key id. */
  keyId: z.string().trim().min(4).max(100).regex(/^[A-Za-z0-9._-]+$/, 'letters, digits, dot, underscore and hyphen').nullable().optional(),
  /**
   * Absent = keep; null = clear. Dell: the client secret. Lenovo: the ClientID
   * token. HP: the app's API secret. Apple: the private key as PEM (checked to
   * be an EC P-256 private key, stored as PKCS#8). The shape is checked per
   * vendor in putVendor.
   */
  secret: z.string().min(8).max(4096).nullable().optional(),
}).strict();
/** Which vendors take a client id, and which a key id. */
const TAKES_CLIENT_ID: readonly LookupVendor[] = ['dell', 'hp', 'apple'];
const TAKES_KEY_ID: readonly LookupVendor[] = ['apple'];
const PRINTABLE_SECRET = /^[\x21-\x7e]{8,512}$/;
const KEY_REQUIRED: Record<LookupVendor, string> = {
  dell: 'Enter the TechDirect client secret to switch the Dell lookup on.',
  lenovo: 'Enter the Lenovo ClientID to switch the Lenovo lookup on.',
  hp: 'Enter the HP API secret to switch the HP lookup on.',
  apple: 'Paste the Apple Business Manager private key to switch the Apple lookup on.',
};
const CLIENT_ID_REQUIRED: Record<LookupVendor, string> = {
  dell: 'Enter the TechDirect client id.', lenovo: '', hp: 'Enter the HP API key.', apple: 'Enter the Apple Business Manager client id.',
};

const bad = (e: z.ZodError) => new BadRequestException({ code: 'INVALID_REQUEST', message: e.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; ') });
const parseDay = (s: string | null | undefined): Date | null => {
  if (!s) return null;
  const d = new Date(`${s}T00:00:00.000Z`);
  if (!Number.isFinite(d.getTime()) || d.toISOString().slice(0, 10) !== s) throw new BadRequestException({ code: 'INVALID_DATE', message: `${s} is not a date.` });
  const y = d.getUTCFullYear();
  if (y < 1990 || y > 2099) throw new BadRequestException({ code: 'INVALID_DATE', message: 'Warranty dates must fall between 1990 and 2099.' });
  return d;
};
/** The last four characters kept in the clear. For a PEM key, of its base64 body: the end of the public key it carries. */
const last4 = (s: string) => s.replace(/-----[A-Z ]+-----|\s/g, '').slice(-4);

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
    const enabled = [...vendors.values()].filter((v) => v.enabled && v.secretEnc).map((v) => v.vendor);
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
      // 0.61: why there is no date, in words, and whether the fix is in Administration → Warranty.
      gap: e.warrantyEndsAt ? null : warrantyGap({
        hasInventory: !!e.inventory, manufacturer: e.inventory?.manufacturer, model: e.inventory?.model,
        serial: e.inventory?.serialNumber ?? e.serialNumber, enabled, lookupResult: e.warrantyLookupResult, lookupAt: e.warrantyLookupAt,
      }),
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
    if (!vendor || !isLookupVendor(vendor)) throw new ConflictException({ code: 'WARRANTY_LOOKUP_UNSUPPORTED', message: vendor ? `There is no warranty lookup for ${VENDOR_LABEL[vendor]}. ${NO_LOOKUP_REASON[vendor as Exclude<VendorKey, LookupVendor>]} Enter the dates by hand.` : 'The manufacturer is not one with a warranty lookup. Enter the dates by hand.' });
    const creds = await this.credentials(vendor);
    if (!creds) throw new ConflictException({ code: 'WARRANTY_LOOKUP_OFF', message: `The ${VENDOR_LABEL[vendor]} warranty lookup is not switched on (Administration → Warranty).` });
    const serial = this.serialOf(e);
    if (!serial) throw new ConflictException({ code: 'NO_SERIAL', message: 'This device has not reported a usable serial number.' });
    const pause = await activePause(this.prisma, 'integration', ep.customerId);
    if (pause) throw new ForbiddenException({ code: 'CONTAINED', message: pauseMessage(pause, 'integration'), pauseId: pause.id, scope: pause.scope.toLowerCase() });
    await this.audit.logOrFail({
      action: 'WARRANTY_LOOKUP_REQUESTED', actorId: actor.userId, actorIp: actor.ip, tenantId: actor.tenantId ?? undefined, customerId: ep.customerId ?? undefined,
      resource: 'endpoint', resourceId: endpointId, meta: { vendor },
    });
    const r = await this.lookupAndStore(e, vendor, creds, serial, new Date());
    return { result: r.ok ? 'OK' : r.code, ...(await this.get(actor, endpointId)) };
  }

  private async credentials(vendor: LookupVendor): Promise<Credentials | null> {
    const v = await this.prisma.warrantyVendor.findUnique({ where: { vendor } });
    if (!v?.enabled || !v.secretEnc) return null;
    try { return { clientId: v.clientId, keyId: v.keyId, secret: openSecret(this.encKey, 'rem0te-warranty-key-v1', v.secretEnc) }; } catch { return null; }
  }

  /** Ask the vendor and write what it said. The serial is the only thing about the computer passed on. */
  private async lookupAndStore(e: Ep, vendor: LookupVendor, creds: Credentials, serial: string, now: Date): Promise<LookupResult> {
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
    const page = (skip: number) => this.prisma.endpoint.findMany({
      where: {
        status: 'ACTIVE',
        OR: [{ warrantySource: null }, { warrantySource: { not: 'manual' } }],
        AND: [{ OR: [{ warrantyLookupAt: null }, { warrantyLookupAt: { lt: cutoff } }] }],
        inventory: { isNot: null },
      },
      select: EP_SELECT, orderBy: [{ warrantyLookupAt: { sort: 'asc', nulls: 'first' } }, { id: 'asc' }], take: CANDIDATES_PER_TICK, skip,
    });
    const creds = new Map<LookupVendor, Credentials>();
    // Page through candidates until the budget is spent. A computer whose
    // vendor has no lookup (or is switched off) is skipped without being
    // marked, so it stays first in the order; reading only the first page
    // let 500 of them hide every HP or Dell behind them for ever.
    for (let skip = 0; left > 0 && skip < CANDIDATES_SCAN_MAX; skip += CANDIDATES_PER_TICK) {
      const candidates = await page(skip);
      if (!candidates.length) break;
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
  }

  // ── Settings ──────────────────────────────────────────────────────────────

  private vendorView(vendor: LookupVendor, v: WarrantyVendor | null) {
    return {
      vendor, label: VENDOR_LABEL[vendor], enabled: !!v?.enabled,
      clientId: TAKES_CLIENT_ID.includes(vendor) ? v?.clientId ?? null : null,
      keyId: TAKES_KEY_ID.includes(vendor) ? v?.keyId ?? null : null,
      secretSet: !!v?.secretEnc, secretLast4: v?.secretEnc ? v.secretLast4 : null,
      updatedAt: v?.updatedAt ?? null, lastResultAt: v?.lastResultAt ?? null, lastResult: v?.lastResult ?? null,
    };
  }

  async settings() {
    const rows = new Map((await this.prisma.warrantyVendor.findMany()).map((v) => [v.vendor, v]));
    return {
      vendors: LOOKUP_VENDORS.map((k) => this.vendorView(k, rows.get(k) ?? null)),
      manualOnly: VENDOR_KEYS.filter((k): k is Exclude<VendorKey, LookupVendor> => !isLookupVendor(k)).map((k) => ({ vendor: k, label: VENDOR_LABEL[k], reason: NO_LOOKUP_REASON[k] })),
      sweep: { enabled: process.env.WARRANTY_SWEEP !== 'off', perHour: perHour(), intervalDays: LOOKUP_INTERVAL_DAYS },
    };
  }

  async putVendor(a: ActorContext, vendor: string, raw: unknown) {
    if (!isLookupVendor(vendor)) throw new BadRequestException({ code: 'UNKNOWN_VENDOR', message: `There is no warranty lookup for "${String(vendor).slice(0, 20)}".` });
    const d = VendorInput.safeParse(raw ?? {});
    if (!d.success) throw bad(d.error);
    if (!TAKES_CLIENT_ID.includes(vendor) && d.data.clientId) throw new BadRequestException({ code: 'INVALID_REQUEST', message: 'Only Dell, HP and Apple take a client id.' });
    if (!TAKES_KEY_ID.includes(vendor) && d.data.keyId) throw new BadRequestException({ code: 'INVALID_REQUEST', message: 'Only Apple takes a key id.' });
    // The secret's own shape: a PEM private key for Apple, printable characters with no spaces for the rest.
    let given: string | null | undefined = d.data.secret;
    if (typeof given === 'string') {
      given = vendor === 'apple' ? normaliseApplePrivateKey(given) : PRINTABLE_SECRET.test(given) ? given : null;
      if (!given) throw new BadRequestException({ code: 'INVALID_KEY', message: vendor === 'apple' ? 'Paste the private key Apple Business Manager gave you: a PEM EC P-256 private key.' : 'The secret is 8 to 512 printable characters with no spaces.' });
    }
    const cur = await this.prisma.warrantyVendor.findUnique({ where: { vendor } });
    const clientId = TAKES_CLIENT_ID.includes(vendor) ? (d.data.clientId === undefined ? cur?.clientId ?? null : d.data.clientId) : null;
    const keyId = TAKES_KEY_ID.includes(vendor) ? (d.data.keyId === undefined ? cur?.keyId ?? null : d.data.keyId) : null;
    // A different client id (or Apple key id) is a different credential: the old secret is not kept for it.
    const moved = !!cur && ((cur.clientId ?? null) !== clientId || (cur.keyId ?? null) !== keyId);
    let secretEnc: string | null; let secretLast4: string | null;
    let keyChange: 'set' | 'kept' | 'cleared' | 'cleared_client_changed' | 'none';
    if (typeof given === 'string') { secretEnc = sealSecret(this.encKey, 'rem0te-warranty-key-v1', given); secretLast4 = last4(given); keyChange = 'set'; }
    else if (given === null) { secretEnc = null; secretLast4 = null; keyChange = cur?.secretEnc ? 'cleared' : 'none'; }
    else if (cur?.secretEnc && moved) { secretEnc = null; secretLast4 = null; keyChange = 'cleared_client_changed'; }
    else { secretEnc = cur?.secretEnc ?? null; secretLast4 = cur?.secretLast4 ?? null; keyChange = secretEnc ? 'kept' : 'none'; }
    if (d.data.enabled && !secretEnc) throw new BadRequestException({ code: 'KEY_REQUIRED', message: KEY_REQUIRED[vendor] });
    if (d.data.enabled && TAKES_CLIENT_ID.includes(vendor) && !clientId) throw new BadRequestException({ code: 'CLIENT_ID_REQUIRED', message: CLIENT_ID_REQUIRED[vendor] });
    if (d.data.enabled && TAKES_KEY_ID.includes(vendor) && !keyId) throw new BadRequestException({ code: 'KEY_ID_REQUIRED', message: 'Enter the Apple Business Manager key id.' });
    const data = { enabled: d.data.enabled, clientId, keyId, secretEnc, secretLast4, updatedById: a.userId };
    const row = await this.prisma.warrantyVendor.upsert({ where: { vendor }, create: { vendor, ...data }, update: data });
    const pub = (s: WarrantyVendor | null) => s && { enabled: s.enabled, clientIdSet: !!s.clientId, keyIdSet: !!s.keyId };
    // The secret is never in the audit row: only whether it changed.
    await this.audit.logOrFail({
      action: 'WARRANTY_SETTINGS_CHANGED', actorId: a.userId, actorIp: a.ip, tenantId: a.tenantId ?? undefined, resource: 'warranty_vendor', resourceId: vendor,
      meta: { vendor, before: pub(cur), after: pub(row), key: keyChange },
    });
    return { ...this.vendorView(vendor, row), keyChange };
  }
}
