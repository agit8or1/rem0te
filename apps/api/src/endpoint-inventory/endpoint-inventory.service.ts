import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import { Prisma, EndpointCommandType } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

/**
 * What a managed computer knows about itself, and the queue that asks it.
 *
 * Two rules shape everything in this file.
 *
 * **Nothing an endpoint sends is trusted as-is.** The heartbeat is a public
 * route called by a machine, so every field arriving from it goes through the
 * sanitisers below before it reaches a column: strings are clamped, numbers are
 * range-checked, arrays are truncated, and anything unrecognised is dropped
 * rather than stored. A managed computer that has been taken over must not be
 * able to fill a shared database with a 50 MB "hostname", or park megabytes of
 * log text in a JSONB column.
 *
 * **A command is a fixed collection, never a shell.** `EndpointCommandType` has
 * three values and each one maps to a specific read-only query on the agent
 * side. There is deliberately no "run this script" type: the whole point of
 * staging work for a SYSTEM-level agent through the database is that a
 * compromise of the console cannot become arbitrary execution across a fleet.
 * Adding such a type would undo every other protection in this repo.
 */

/** Windows event logs a technician may read. Anything else is rejected. */
export const ALLOWED_EVENT_LOGS = [
  'Application',
  'System',
  'Security',
  'Setup',
  'Windows PowerShell',
] as const;
export type AllowedEventLog = (typeof ALLOWED_EVENT_LOGS)[number];

/**
 * Windows event levels, by their `Get-WinEvent` numeric value.
 *
 * Level 0 is not a mistake and not a gap. It is `LogAlways`, and it is what
 * almost every entry in the **Security** log is: Event Viewer displays those
 * as Information, but they are not level 4. A filter of Critical/Error/Warning
 * — the obvious default for troubleshooting — returns literally nothing from
 * the Security log, which reads as a broken feature rather than a filter that
 * excluded everything.
 */
export const EVENT_LEVELS: Record<number, string> = {
  0: 'Information',
  1: 'Critical',
  2: 'Error',
  3: 'Warning',
  4: 'Information',
  5: 'Verbose',
};

const MAX_EVENTS = 200;
const MAX_SINCE_HOURS = 24 * 14;
// Event messages are truncated on the agent and again here. 200 events at
// 2000 characters is ~400 KB of JSON, which is what sets the API's 1 MB body
// limit in main.ts — raise one without the other and a full Security-log page
// comes back as a 413 that looks like the endpoint went offline.
const MAX_MESSAGE_CHARS = 2000;

/** How long a staged command is worth handing out before it is written off. */
const COMMAND_TTL_MINUTES = 30;

/**
 * How many heartbeats may be handed the same command. An agent that keeps
 * collecting a command and never reports back cannot run it — retrying forever
 * would mean a queue that never drains and an endpoint that spends every
 * heartbeat on work that fails.
 */
const MAX_DISPATCHES = 4;

/**
 * Commands handed out per heartbeat. Two, so an operator's event-log request is
 * not stuck behind an automatic inventory pass for another three minutes.
 */
const COMMANDS_PER_HEARTBEAT = 2;

/**
 * Automatic re-collection cadence. Inventory is a handful of CIM queries; an
 * update scan spins up the Windows Update agent and hits the network, so it
 * runs far less often.
 */
const INVENTORY_STALE_HOURS = 6;
const UPDATE_SCAN_STALE_HOURS = 12;

// Control characters have no legitimate use in any of these fields, and a
// stray carriage return in a hostname is the kind of thing that corrupts a log
// line somewhere far away from here. Stripping them is the point, so the lint
// rule against matching them is exactly backwards in this one place.
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\x00-\x1f\x7f]/g;

// --- Sanitisers -------------------------------------------------------------

function str(v: unknown, max: number): string | undefined {
  if (typeof v !== 'string') return undefined;
  const clean = v.replace(CONTROL_CHARS, ' ').trim();
  if (!clean) return undefined;
  return clean.slice(0, max);
}

function int(v: unknown, min: number, max: number): number | undefined {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN;
  if (!Number.isFinite(n)) return undefined;
  const r = Math.round(n);
  if (r < min || r > max) return undefined;
  return r;
}

function bool(v: unknown): boolean | undefined {
  if (typeof v === 'boolean') return v;
  if (v === 'true') return true;
  if (v === 'false') return false;
  return undefined;
}

/**
 * A date the endpoint reported.
 *
 * Bounded on both sides. An endpoint with a wrong clock — a machine whose CMOS
 * battery is dead reports 1980, one with a bad NTP peer reports 2107 — would
 * otherwise put a timestamp in the database that every "how old is this?"
 * calculation downstream reads as absurd. Out of range is stored as nothing,
 * which the UI already renders as unknown.
 */
function date(v: unknown): Date | undefined {
  const s = typeof v === 'string' ? v : undefined;
  if (!s) return undefined;
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return undefined;
  const year = d.getUTCFullYear();
  if (year < 1990 || year > 2100) return undefined;
  return d;
}

function arr(v: unknown, max: number): unknown[] {
  return Array.isArray(v) ? v.slice(0, max) : [];
}

@Injectable()
export class EndpointInventoryService {
  private readonly logger = new Logger(EndpointInventoryService.name);

  constructor(private readonly prisma: PrismaService) {}

  // --- Ingest ---------------------------------------------------------------

  /**
   * The cheap fields, written on every heartbeat.
   *
   * Who is logged on and how long the machine has been up are the two things a
   * technician looks at before connecting, and both cost a single CIM query on
   * the agent — no reason to make them wait for an inventory pass.
   */
  async recordLiveState(
    endpointId: string,
    report: { loggedOnUser?: unknown; uptimeSeconds?: unknown; lastBootAt?: unknown },
  ): Promise<void> {
    // An empty string is meaningful: it is how the agent says "nobody is
    // logged on", and it has to clear a previous user rather than leave a name
    // on screen that signed out an hour ago. `str()` maps '' to undefined, so
    // that case is handled before it gets there.
    const signedOut =
      typeof report.loggedOnUser === 'string' && report.loggedOnUser.trim() === '';

    const data: Record<string, unknown> = {
      loggedOnUser: signedOut ? null : str(report.loggedOnUser, 128),
      uptimeSeconds: int(report.uptimeSeconds, 0, 60 * 60 * 24 * 3650),
      lastBootAt: date(report.lastBootAt),
    };
    if (Object.values(data).every((v) => v === undefined)) return;

    await this.upsert(endpointId, data);
  }

  /** A full inventory pass, from an INVENTORY_REFRESH command result. */
  async recordInventory(endpointId: string, raw: unknown): Promise<void> {
    if (!raw || typeof raw !== 'object') return;
    const r = raw as Record<string, unknown>;

    await this.upsert(endpointId, {
      manufacturer: str(r.manufacturer, 128),
      model: str(r.model, 128),
      serialNumber: str(r.serialNumber, 128),
      chassisType: str(r.chassisType, 64),
      biosVersion: str(r.biosVersion, 128),
      biosDate: date(r.biosDate),

      osCaption: str(r.osCaption, 128),
      osBuild: str(r.osBuild, 64),
      osArch: str(r.osArch, 32),
      osInstalledAt: date(r.osInstalledAt),
      domain: str(r.domain, 128),
      timezone: str(r.timezone, 64),

      cpuModel: str(r.cpuModel, 128),
      cpuCores: int(r.cpuCores, 1, 1024),
      cpuThreads: int(r.cpuThreads, 1, 4096),
      cpuMhz: int(r.cpuMhz, 1, 100_000),

      memoryTotalMb: int(r.memoryTotalMb, 0, 64 * 1024 * 1024),
      memoryFreeMb: int(r.memoryFreeMb, 0, 64 * 1024 * 1024),

      disks: this.sanitizeDisks(r.disks),
      gpus: this.sanitizeGpus(r.gpus),
      networks: this.sanitizeNetworks(r.networks),

      collectedAt: new Date(),
    });
  }

  /** The result of an UPDATE_SCAN command. */
  async recordUpdateScan(endpointId: string, raw: unknown): Promise<void> {
    if (!raw || typeof raw !== 'object') return;
    const r = raw as Record<string, unknown>;

    const pending = arr(r.pending, 100)
      .map((u) => {
        const o = (u ?? {}) as Record<string, unknown>;
        const title = str(o.title, 300);
        if (!title) return null;
        return {
          title,
          kb: str(o.kb, 32) ?? null,
          severity: str(o.severity, 32) ?? null,
          sizeBytes: int(o.sizeBytes, 0, Number.MAX_SAFE_INTEGER) ?? null,
        };
      })
      .filter((u): u is NonNullable<typeof u> => u !== null);

    await this.upsert(endpointId, {
      pendingUpdates: pending,
      // Counted from what survived sanitising, not from a number the endpoint
      // sent alongside the list. Those two disagreeing is how a badge ends up
      // reading "12 updates" over a list of three.
      pendingUpdateCount: pending.length,
      rebootRequired: bool(r.rebootRequired),
      updatesCheckedAt: new Date(),
    });
  }

  private sanitizeDisks(v: unknown) {
    return arr(v, 32)
      .map((d) => {
        const o = (d ?? {}) as Record<string, unknown>;
        const drive = str(o.drive, 16);
        if (!drive) return null;
        return {
          drive,
          label: str(o.label, 64) ?? null,
          fsType: str(o.fsType, 32) ?? null,
          totalBytes: int(o.totalBytes, 0, Number.MAX_SAFE_INTEGER) ?? null,
          freeBytes: int(o.freeBytes, 0, Number.MAX_SAFE_INTEGER) ?? null,
        };
      })
      .filter((d): d is NonNullable<typeof d> => d !== null);
  }

  private sanitizeGpus(v: unknown) {
    return arr(v, 8)
      .map((g) => {
        const o = (g ?? {}) as Record<string, unknown>;
        const name = str(o.name, 128);
        if (!name) return null;
        return {
          name,
          driverVersion: str(o.driverVersion, 64) ?? null,
          resolution: str(o.resolution, 32) ?? null,
        };
      })
      .filter((g): g is NonNullable<typeof g> => g !== null);
  }

  private sanitizeNetworks(v: unknown) {
    return arr(v, 16)
      .map((n) => {
        const o = (n ?? {}) as Record<string, unknown>;
        const name = str(o.name, 128);
        if (!name) return null;
        return {
          name,
          mac: str(o.mac, 32) ?? null,
          ipv4: str(o.ipv4, 64) ?? null,
          gateway: str(o.gateway, 64) ?? null,
          dhcp: bool(o.dhcp) ?? null,
        };
      })
      .filter((n): n is NonNullable<typeof n> => n !== null);
  }

  private async upsert(endpointId: string, data: Record<string, unknown>) {
    // Undefined keys are dropped, so a partial report updates only the fields
    // it actually carried. Nulls are kept — they are how a field is cleared.
    const clean = Object.fromEntries(
      Object.entries(data).filter(([, v]) => v !== undefined),
    );

    await this.prisma.endpointInventory.upsert({
      where: { endpointId },
      create: { endpointId, ...clean } as Prisma.EndpointInventoryUncheckedCreateInput,
      update: clean as Prisma.EndpointInventoryUncheckedUpdateInput,
    });
  }

  // --- Read -----------------------------------------------------------------

  async get(endpointId: string) {
    return this.prisma.endpointInventory.findUnique({ where: { endpointId } });
  }

  // --- Command queue --------------------------------------------------------

  /**
   * Validate the parameters for a command type and return the stored form.
   *
   * Every bound is enforced here rather than trusted from the request, because
   * this is what the agent is later told to do: an unbounded `maxEvents` is a
   * request for an endpoint to serialise its entire Security log into one HTTP
   * POST, and an arbitrary `logName` is a request for a log nobody authorised.
   */
  validateParams(type: EndpointCommandType, params: Record<string, unknown> | undefined) {
    if (type !== 'EVENT_LOG_QUERY') return undefined;

    const p = params ?? {};
    const logName = typeof p.logName === 'string' ? p.logName : '';
    if (!(ALLOWED_EVENT_LOGS as readonly string[]).includes(logName)) {
      throw new BadRequestException(
        `logName must be one of: ${ALLOWED_EVENT_LOGS.join(', ')}`,
      );
    }

    const levels = arr(p.levels, 8)
      .map((l) => int(l, 0, 5))
      .filter((l): l is number => l !== undefined);

    return {
      logName,
      // Empty means every level, which is what the agent does with an empty
      // filter — no need for a separate "all" sentinel.
      levels,
      maxEvents: int(p.maxEvents, 1, MAX_EVENTS) ?? 50,
      sinceHours: int(p.sinceHours, 1, MAX_SINCE_HOURS) ?? 24,
      providerName: str(p.providerName, 128) ?? null,
    };
  }

  /**
   * Stage a command for an endpoint.
   *
   * `requestedById` null means the server asked on its own — a stale-inventory
   * refresh, not a person. The UI distinguishes the two so an operator is not
   * shown a queue full of housekeeping they did not ask for.
   */
  async stage(args: {
    endpointId: string;
    tenantId?: string | null;
    customerId?: string | null;
    type: EndpointCommandType;
    params?: Record<string, unknown>;
    requestedById?: string | null;
  }) {
    const params = this.validateParams(args.type, args.params);

    // One outstanding automatic command of each type at a time. Without this
    // the stale-inventory check stages another row every three minutes for as
    // long as the endpoint is offline, and the machine comes back to a queue of
    // hundreds of identical refreshes.
    if (!args.requestedById) {
      const existing = await this.prisma.endpointCommand.findFirst({
        where: {
          endpointId: args.endpointId,
          type: args.type,
          status: { in: ['PENDING', 'DISPATCHED'] },
        },
        select: { id: true },
      });
      if (existing) return null;
    }

    return this.prisma.endpointCommand.create({
      data: {
        endpointId: args.endpointId,
        tenantId: args.tenantId ?? null,
        customerId: args.customerId ?? null,
        type: args.type,
        params: params as Prisma.InputJsonValue | undefined,
        requestedById: args.requestedById ?? null,
        expiresAt: new Date(Date.now() + COMMAND_TTL_MINUTES * 60_000),
      },
    });
  }

  /**
   * What this endpoint should do, decided at heartbeat time.
   *
   * Called only for a heartbeat that authenticated with the device secret. An
   * anonymous caller gets an empty list: handing work to something that cannot
   * prove it is the machine would let anyone who knows a RustDesk ID decide
   * what a customer's computer collects and when.
   */
  async collectForHeartbeat(endpointId: string) {
    await this.stageAutomaticCollections(endpointId);
    await this.expireStale(endpointId);

    const due = await this.prisma.endpointCommand.findMany({
      where: { endpointId, status: { in: ['PENDING', 'DISPATCHED'] } },
      // An operator waiting at a screen comes before housekeeping; oldest
      // first within each group, so nothing starves.
      //
      // `nulls: 'last'` is doing real work. Postgres orders DESC as NULLS
      // FIRST, and `requestedById` is null exactly for the automatic
      // collections — so the plain `desc` this started as put housekeeping
      // ahead of the person waiting, which is the opposite of the intent and
      // would be invisible until someone's event-log request sat behind two
      // inventory passes.
      orderBy: [
        { requestedById: { sort: 'desc', nulls: 'last' } },
        { createdAt: 'asc' },
      ],
      take: COMMANDS_PER_HEARTBEAT,
    });

    const handOut: { id: string; type: EndpointCommandType; params: unknown }[] = [];
    for (const cmd of due) {
      if (cmd.dispatchCount >= MAX_DISPATCHES) {
        await this.prisma.endpointCommand.update({
          where: { id: cmd.id },
          data: {
            status: 'FAILED',
            error:
              `Handed to this computer ${cmd.dispatchCount} times without a result. ` +
              `Its agent cannot run this — re-run the installer on it.`,
            completedAt: new Date(),
          },
        });
        continue;
      }
      await this.prisma.endpointCommand.update({
        where: { id: cmd.id },
        data: {
          status: 'DISPATCHED',
          dispatchedAt: new Date(),
          dispatchCount: { increment: 1 },
        },
      });
      handOut.push({ id: cmd.id, type: cmd.type, params: cmd.params });
    }
    return handOut;
  }

  /** Queue an inventory pass or an update scan if the stored one has aged out. */
  private async stageAutomaticCollections(endpointId: string) {
    const inv = await this.prisma.endpointInventory.findUnique({
      where: { endpointId },
      select: { collectedAt: true, updatesCheckedAt: true },
    });

    const stale = (at: Date | null | undefined, hours: number) =>
      !at || Date.now() - at.getTime() > hours * 3_600_000;

    const invStale = stale(inv?.collectedAt, INVENTORY_STALE_HOURS);
    const updStale = stale(inv?.updatesCheckedAt, UPDATE_SCAN_STALE_HOURS);
    if (!invStale && !updStale) return;

    const ep = await this.prisma.endpoint.findUnique({
      where: { id: endpointId },
      select: { tenantId: true, customerId: true },
    });

    if (invStale) {
      await this.stage({
        endpointId, tenantId: ep?.tenantId, customerId: ep?.customerId,
        type: 'INVENTORY_REFRESH',
      });
    }
    if (updStale) {
      await this.stage({
        endpointId, tenantId: ep?.tenantId, customerId: ep?.customerId,
        type: 'UPDATE_SCAN',
      });
    }
  }

  private async expireStale(endpointId: string) {
    await this.prisma.endpointCommand.updateMany({
      where: {
        endpointId,
        status: { in: ['PENDING', 'DISPATCHED'] },
        expiresAt: { lt: new Date() },
      },
      data: { status: 'EXPIRED', completedAt: new Date() },
    });
  }

  /**
   * An endpoint reporting back on a command.
   *
   * Scoped by `endpointId` as well as command id, so a machine cannot close
   * out — or write a result into — a command staged for a different one.
   */
  async completeCommand(
    endpointId: string,
    commandId: string,
    payload: {
      ok?: unknown; error?: unknown;
      inventory?: unknown; updates?: unknown; events?: unknown;
    },
  ) {
    const cmd = await this.prisma.endpointCommand.findFirst({
      where: { id: commandId, endpointId },
    });
    if (!cmd) return { accepted: false, reason: 'unknown_command' };
    if (cmd.status === 'SUCCEEDED' || cmd.status === 'FAILED') {
      return { accepted: false, reason: 'already_complete' };
    }

    if (!(bool(payload.ok) ?? false)) {
      await this.prisma.endpointCommand.update({
        where: { id: cmd.id },
        data: {
          status: 'FAILED',
          error: str(payload.error, 1000) ?? 'The agent reported a failure with no detail.',
          completedAt: new Date(),
        },
      });
      return { accepted: true };
    }

    let result: Prisma.InputJsonValue;
    switch (cmd.type) {
      case 'INVENTORY_REFRESH':
        await this.recordInventory(endpointId, payload.inventory);
        result = { collected: true };
        break;
      case 'UPDATE_SCAN':
        await this.recordUpdateScan(endpointId, payload.updates);
        result = { collected: true };
        break;
      case 'EVENT_LOG_QUERY':
        result = { events: this.sanitizeEvents(payload.events) };
        break;
    }

    await this.prisma.endpointCommand.update({
      where: { id: cmd.id },
      data: { status: 'SUCCEEDED', result, error: null, completedAt: new Date() },
    });
    return { accepted: true };
  }

  /**
   * Event records, clamped hard.
   *
   * These are stored in a shared database and rendered in a browser, and every
   * field in one is attacker-influenced on a compromised machine: an event
   * message is whatever the process that logged it wrote. The length limits
   * here are why a single request cannot park megabytes of log text in a JSONB
   * column, and the console renders these as text, never as markup.
   */
  private sanitizeEvents(v: unknown) {
    return arr(v, MAX_EVENTS)
      .map((e) => {
        const o = (e ?? {}) as Record<string, unknown>;
        const timeCreated = date(o.timeCreated);
        const level = int(o.level, 0, 5) ?? null;
        return {
          timeCreated: timeCreated ? timeCreated.toISOString() : null,
          eventId: int(o.eventId, 0, 4_294_967_295) ?? null,
          level,
          // Named here rather than trusting the agent's label, so the table
          // cannot be made to show "Information" over a Critical event.
          levelName: level !== null ? (EVENT_LEVELS[level] ?? null) : null,
          provider: str(o.provider, 128) ?? null,
          message: str(o.message, MAX_MESSAGE_CHARS) ?? null,
        };
      })
      .filter((e) => e.eventId !== null || e.message !== null);
  }

  /**
   * Recent commands for one endpoint, newest first — status only.
   *
   * `result` and `params` are deliberately NOT selected. An EVENT_LOG_QUERY
   * row carries the log contents in `result`, and this list is served with the
   * inventory payload behind `computers:view` — returning the whole row would
   * hand anyone who can see a computer the event logs that
   * `computers:event_logs` exists to gate. Results are read one at a time
   * through `getCommand`, which re-checks the capability against the command's
   * own type.
   */
  async listCommands(endpointId: string, limit = 20) {
    await this.expireStale(endpointId);
    return this.prisma.endpointCommand.findMany({
      where: { endpointId },
      orderBy: { createdAt: 'desc' },
      take: Math.min(limit, 100),
      select: {
        id: true, type: true, status: true, error: true,
        requestedById: true, createdAt: true, completedAt: true,
      },
    });
  }

  /**
   * The most recent event-log query for an endpoint, results included.
   *
   * Without this the Event Log tab could only ever show a result fetched in
   * the current browser session: the command id lived in component state, so
   * navigating away and back presented an empty form as though nothing had
   * ever been asked, and the page gave no way to see a colleague's query from
   * an hour ago either. Returned only through a route that checks
   * `computers:event_logs`, because this carries log contents.
   */
  async latestEventLog(endpointId: string) {
    await this.expireStale(endpointId);
    return this.prisma.endpointCommand.findFirst({
      where: { endpointId, type: 'EVENT_LOG_QUERY' },
      orderBy: { createdAt: 'desc' },
    });
  }

  async getCommand(endpointId: string, commandId: string) {
    await this.expireStale(endpointId);
    return this.prisma.endpointCommand.findFirst({ where: { id: commandId, endpointId } });
  }
}
