import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import type { MdmConnector } from '@prisma/client';
import { activePause } from '../containment/pause';
import { PrismaService } from '../prisma/prisma.service';
import { MdmSetupService } from './setup/mdm-setup.service';
import { expireIfDue, observedCommand, reconcile, type CommandFacts } from './command-state';
import { MdmDriverError } from './driver';
import { AppleMdmService } from './apple/apple-mdm.service';
import type { MdmDriver } from './driver';
import { makeDrivers } from './drivers';
import { isOneOf, PROVIDERS, type CommandState, type Provider, type SyncResult } from './model';
import { parseCommand, parseDevice, type CommandRecord } from './schemas';

/**
 * The MDM sync (0.80 Tablet): pulls inventory, enrollment, ownership,
 * compliance and provider-reported commands from each enabled connector.
 * Read-only towards the provider: every driver call is a listing.
 *
 *   MDM_SWEEP=off            stops it (exact; run-e2e.sh and e2e-ui.mjs set
 *                            it, and Admin → Security names it, §84).
 *   MDM_SWEEP_SECONDS        how often the sweep looks (default 300).
 *   MDM_SYNC_MINUTES         how often one connector is read (default 60;
 *                            a 15-minute floor outside NODE_ENV=test).
 *
 * Bounded everywhere: at most CONNECTORS_PER_PASS connectors a pass, each
 * read at most every MDM_SYNC_MINUTES; DEVICE_PAGES × PAGE_MAX devices and
 * COMMAND_PAGES × PAGE_MAX commands per connector per pass. A listing cut
 * off by the bound is `partial`, and only a COMPLETE device listing marks a
 * device the provider stopped returning as `not_reported`.
 *
 * A connector is claimed with a conditional write before it is read, so two
 * API processes never read the same one at once. A business under an
 * `integration` containment pause is skipped (`paused`), as the warranty
 * sweep does. A connector whose driver is not ready (the stand-in outside the
 * test suites) records `not_ready` and is never called.
 *
 * Commands go through the state machine (command-state.ts): a provider
 * report can move a command forward and never back, and a completion the
 * provider never accepted is refused and counted.
 *
 * This is the only writer of MdmConnector (its sync fields), MobileDevice
 * and MdmCommand (§90). 0.84: it is also the only creator of a connector,
 * and only of an `apple` one, for a business that has an Apple enrollment
 * (ensureAppleConnectors, §93). The sweep also runs the own Apple server's
 * pass (AppleMdmService.pass: link and command expiry, the daily inventory
 * re-queue, the APNs push), so MDM_SWEEP=off stops that too.
 */
export const CONNECTORS_PER_PASS = 20;
export const DEVICE_PAGES = 20;
export const COMMAND_PAGES = 10;
export const CLAIM_STALE_MS = 15 * 60_000;
/** A provider command with no expiry of its own expires after this long without finishing. */
export const DEFAULT_COMMAND_TTL_MS = 7 * 24 * 3_600_000;

export function syncMinutes(env: Record<string, string | undefined> = process.env): number {
  const n = Number(env.MDM_SYNC_MINUTES);
  const v = Number.isFinite(n) && n > 0 ? n : 60;
  return env.NODE_ENV === 'test' ? v : Math.max(15, v);
}

export interface SyncOutcome {
  result: SyncResult;
  devices: number;
  skippedDevices: number;
  commands: number;
  skippedCommands: number;
  refusedTransitions: number;
  markedNotReported: number;
}

@Injectable()
export class MdmSyncService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger('MdmSync');
  private timer: ReturnType<typeof setInterval> | null = null;
  private first: ReturnType<typeof setTimeout> | null = null;
  private busy = false;

  private readonly drivers: Record<Provider, MdmDriver>;

  constructor(private readonly prisma: PrismaService, private readonly setup: MdmSetupService, private readonly apple: AppleMdmService) {
    this.drivers = makeDrivers({ apple });
  }

  onModuleInit() {
    if (process.env.MDM_SWEEP === 'off') return;
    const every = Math.max(2, Number(process.env.MDM_SWEEP_SECONDS) || 300) * 1000;
    this.first = setTimeout(() => { void this.sweep(); }, Math.min(60_000, every));
    this.timer = setInterval(() => { void this.sweep(); }, every);
  }
  onModuleDestroy() { if (this.timer) clearInterval(this.timer); if (this.first) clearTimeout(this.first); }

  /** One pass. Never throws. */
  async sweep(now = new Date()): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      // 0.84: the own Apple server first, so a device just enrolled is pushed and then read.
      await this.apple.pass(now);
      await this.ensureAppleConnectors();
      const due = new Date(now.getTime() - syncMinutes() * 60_000);
      const rows = await this.prisma.mdmConnector.findMany({
        where: { enabled: true, OR: [{ lastSyncAt: null }, { lastSyncAt: { lt: due } }] },
        orderBy: [{ lastSyncAt: { sort: 'asc', nulls: 'first' } }, { id: 'asc' }],
        take: CONNECTORS_PER_PASS,
      });
      for (const row of rows) {
        try { await this.syncOne(row, now); }
        catch (e) { this.logger.warn(`connector ${row.id}: ${(e as Error).name}`); }
      }
      await this.expirePass(now);
      // 0.83: the push certificate's renewal reminders (MdmSetupService; never throws).
      await this.setup.reminderPass(now);
    } catch (e) {
      this.logger.warn(`sweep: ${(e as Error).name}`);
    } finally {
      this.busy = false;
    }
  }

  /** Claim, read and record one connector. Returns null when another process holds it. */
  async syncOne(row: MdmConnector, now = new Date()): Promise<SyncOutcome | null> {
    const claimed = await this.prisma.mdmConnector.updateMany({
      where: { id: row.id, enabled: true, OR: [{ syncStartedAt: null }, { syncStartedAt: { lt: new Date(now.getTime() - CLAIM_STALE_MS) } }] },
      data: { syncStartedAt: now },
    });
    if (claimed.count !== 1) return null;
    const out: SyncOutcome = { result: 'ok', devices: 0, skippedDevices: 0, commands: 0, skippedCommands: 0, refusedTransitions: 0, markedNotReported: 0 };
    try {
      out.result = await this.read(row, now, out);
    } catch (e) {
      out.result = e instanceof MdmDriverError ? e.code : 'unreachable';
    }
    await this.prisma.mdmConnector.update({
      where: { id: row.id },
      data: { syncStartedAt: null, lastSyncAt: now, lastSyncResult: out.result, lastSyncDevices: out.devices },
    });
    return out;
  }

  private async read(row: MdmConnector, now: Date, out: SyncOutcome): Promise<SyncResult> {
    if (!isOneOf(PROVIDERS, row.provider)) return 'refused';
    const drv = this.drivers[row.provider];
    if (!drv.ready(row).ok) return 'not_ready';
    if (await activePause(this.prisma, 'integration', row.customerId)) return 'paused';

    // Devices.
    const seen = new Set<string>();
    let cursor: string | null = null, complete = false;
    for (let page = 0; page < DEVICE_PAGES; page++) {
      const p = await drv.listDevices(row, cursor);
      for (const raw of p.records) {
        const d = parseDevice(raw);
        if (!d.ok) { out.skippedDevices++; continue; }
        const v = d.value;
        if (seen.has(v.providerDeviceId)) continue;
        seen.add(v.providerDeviceId);
        const data = {
          name: v.name, platform: v.platform, ownership: v.ownership, managementScope: v.managementScope,
          enrollmentState: v.enrollmentState, enrolledAt: v.enrolledAt, complianceState: v.complianceState, complianceReason: v.complianceReason,
          model: v.model, manufacturer: v.manufacturer, osVersion: v.osVersion, serialNumber: v.serialNumber,
          storageTotalBytes: v.storageTotalBytes, storageFreeBytes: v.storageFreeBytes, lastCheckInAt: v.lastCheckInAt,
          lastSyncedAt: now, notReportedSince: null,
        };
        await this.prisma.mobileDevice.upsert({
          where: { connectorId_providerDeviceId: { connectorId: row.id, providerDeviceId: v.providerDeviceId } },
          create: { tenantId: row.tenantId, customerId: row.customerId, connectorId: row.id, provider: row.provider, providerDeviceId: v.providerDeviceId, firstSeenAt: now, ...data },
          update: data,
        });
        out.devices++;
      }
      cursor = p.next;
      if (!cursor) { complete = true; break; }
    }
    if (complete) {
      const gone = await this.prisma.mobileDevice.updateMany({
        where: { connectorId: row.id, enrollmentState: { not: 'not_reported' }, providerDeviceId: { notIn: [...seen] } },
        data: { enrollmentState: 'not_reported', notReportedSince: now },
      });
      out.markedNotReported = gone.count;
    }

    // Commands the provider reports.
    const ids = new Map((await this.prisma.mobileDevice.findMany({ where: { connectorId: row.id }, select: { id: true, providerDeviceId: true } }))
      .map((d) => [d.providerDeviceId, d.id]));
    let commandsComplete = false;
    cursor = null;
    for (let page = 0; page < COMMAND_PAGES; page++) {
      const p = await drv.listCommands(row, cursor);
      for (const raw of p.records) {
        const c = parseCommand(raw);
        const deviceId = c.ok ? ids.get(c.value.providerDeviceId) : undefined;
        if (!c.ok || !deviceId) { out.skippedCommands++; continue; }
        const r = await this.recordCommand(row, deviceId, c.value, now);
        if (r === 'refused') out.refusedTransitions++;
        else out.commands++;
      }
      cursor = p.next;
      if (!cursor) { commandsComplete = true; break; }
    }
    return complete && commandsComplete ? 'ok' : 'partial';
  }

  /** Insert or move one provider-reported command through the state machine. */
  private async recordCommand(row: MdmConnector, deviceId: string, c: CommandRecord, now: Date): Promise<'ok' | 'refused'> {
    const existing = await this.prisma.mdmCommand.findUnique({ where: { connectorId_providerCommandId: { connectorId: row.id, providerCommandId: c.providerCommandId } } });
    const start: CommandFacts = existing ? toFacts(existing) : observedCommand(c.requestedAt, c.expiresAt ?? new Date(c.requestedAt.getTime() + DEFAULT_COMMAND_TTL_MS));
    const rec = reconcile(start, { acceptedAt: c.acceptedAt, rejected: c.rejected, completedAt: c.completedAt, failed: c.failed });
    const exp = expireIfDue(rec.next, now);
    const next = exp.next;
    const fields = {
      state: next.state, sentAt: next.sentAt, providerAcceptedAt: next.providerAcceptedAt, deviceCompletedAt: next.deviceCompletedAt,
      failedAt: next.failedAt, failureCode: next.failureCode, expiresAt: next.expiresAt, expiredAt: next.expiredAt,
    };
    if (!existing) {
      await this.prisma.mdmCommand.create({
        data: {
          tenantId: row.tenantId, customerId: row.customerId, mobileDeviceId: deviceId, connectorId: row.id, providerCommandId: c.providerCommandId,
          kind: c.kind, origin: 'provider', requestedById: null, requestedAt: c.requestedAt, ...fields,
        },
      });
    } else if (rec.changed || exp.changed) {
      // Conditional on the state read: a concurrent writer's move is never overwritten.
      await this.prisma.mdmCommand.updateMany({ where: { id: existing.id, state: existing.state }, data: fields });
    }
    return rec.refused ? 'refused' : 'ok';
  }

  /**
   * One enabled `apple` connector for every business with an Apple
   * enrollment (0.84, §93). The only place a connector is created; a unique
   * (business, provider) makes a race a no-op.
   */
  async ensureAppleConnectors(): Promise<number> {
    const need = await this.apple.businessesNeedingConnector();
    if (!need.length) return 0;
    const r = await this.prisma.mdmConnector.createMany({
      data: need.map((b) => ({ tenantId: b.tenantId, customerId: b.customerId, provider: 'apple', externalTenantId: 'rem0te', enabled: true })),
      skipDuplicates: true,
    });
    return r.count;
  }

  /** Expire unfinished commands whose deadline passed (bounded). */
  private async expirePass(now: Date) {
    const rows = await this.prisma.mdmCommand.findMany({
      where: { state: { in: ['queued', 'sent', 'acknowledged'] }, expiresAt: { lt: now } }, take: 500, orderBy: { expiresAt: 'asc' },
    });
    for (const c of rows) {
      const e = expireIfDue(toFacts(c), now);
      if (e.changed) await this.prisma.mdmCommand.updateMany({ where: { id: c.id, state: c.state }, data: { state: e.next.state, expiredAt: e.next.expiredAt } });
    }
  }
}

function toFacts(c: { state: string; sentAt: Date | null; providerAcceptedAt: Date | null; deviceCompletedAt: Date | null; failedAt: Date | null; failureCode: string | null; expiresAt: Date | null; expiredAt: Date | null }): CommandFacts {
  return {
    state: c.state as CommandState, sentAt: c.sentAt, providerAcceptedAt: c.providerAcceptedAt, deviceCompletedAt: c.deviceCompletedAt,
    failedAt: c.failedAt, failureCode: c.failureCode, expiresAt: c.expiresAt, expiredAt: c.expiredAt,
  };
}
