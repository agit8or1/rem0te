import {
  BadRequestException, ConflictException, HttpException, Injectable, Logger, NotFoundException, OnModuleDestroy, OnModuleInit,
} from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { AccessControlService, type ActorContext } from '../rbac/access-control.service';
import { CAP, PLATFORM_CAP } from '../rbac/capabilities';
import { activePause } from '../containment/pause';
import { runsSignedAgent } from '../common/agent-identity';
import { isWindowsPlatform } from '../common/platform';
import { connectivityOf } from '../common/connectivity';
import { isUnassigned } from '../common/unassigned';
import { assertFresh } from '../security-controls/review';
import {
  ENDPOINT_ID_RE, SESSION_ID_RE, TERMINAL_IDLE_MS, TERMINAL_INPUT_FRAMES_PER_POLL, TERMINAL_MIN_AGENT, TERMINAL_READ_FRAMES,
  TERMINAL_SESSION_INPUT_MAX, TERMINAL_SESSION_OUTPUT_MAX, TRANSCRIPT_DAYS_DEFAULT, AGENT_REFUSALS, type EndReason,
} from './limits';
import {
  cleanReason, endAction, endAs, expiry, hardLimit, inputBytes, isShell, openRefusal, outputFrames, remaining, touch,
} from './policy';
import { RemoteWakeService } from './remote-wake.service';

const LIVE = ['pending', 'open'];
const SWEEP_MS_DEFAULT = 30_000;
const LIST_RECENT = 20;

const SESSION_SELECT = {
  id: true, endpointId: true, businessId: true, technicianId: true, shell: true, reason: true, state: true, retained: true,
  createdAt: true, notAfter: true, lastActivityAt: true, startedAt: true, endedAt: true, endReason: true, endedById: true,
  inSeq: true, inAcked: true, outSeq: true, bytesIn: true, bytesOut: true, exitCode: true,
} as const;
type Row = Prisma.TerminalSessionGetPayload<{ select: typeof SESSION_SELECT }>;

/** What a held agent poll is told about one terminal. */
export type AgentTerminal =
  | { id: string; op: 'start'; shell: string; notAfter: string; idleAt: string }
  | { id: string; op: 'open'; notAfter: string; idleAt: string; input: { seq: number; data: string }[] }
  | { id: string; op: 'end'; reason: string };

/**
 * The background terminal (0.77 Conduit, docs/remote-terminal.md). The only
 * writer of TerminalSession, TerminalFrame and TerminalTranscriptChunk.
 *
 * Console side: open (Platform Admin by capability, scope, the fresh
 * confirmation `terminal.open`, then openRefusal), read, input, keep alive,
 * end, the opt-in transcript. Agent side (through RemoteAgentService, after
 * the device secret): what a poll is told, and the output it posts. Both
 * sides end a session that is past a limit or under a `remote` pause before
 * doing anything else with it, and the sweep (TERMINAL_SWEEP) does the same
 * for sessions nobody is reading.
 *
 * Nothing typed or printed is logged. An audit row carries ids, the shell,
 * the reason, durations and byte counts; a frame is bytes in a row that is
 * deleted once taken; only a business that turned transcripts on keeps them.
 */
@Injectable()
export class TerminalService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger('Terminal');
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly acl: AccessControlService,
    private readonly wake: RemoteWakeService,
  ) {}

  onModuleInit() {
    if (process.env.TERMINAL_SWEEP === 'off') {
      this.logger.warn('TERMINAL_SWEEP=off: expired terminals are ended only when someone reads them, and transcripts are never pruned.');
      return;
    }
    const n = Number(process.env.TERMINAL_SWEEP_MS);
    const every = Number.isInteger(n) && n >= 1_000 && n <= 600_000 ? n : SWEEP_MS_DEFAULT;
    this.timer = setInterval(() => { void this.sweep().catch((e) => this.logger.warn(`sweep: ${String(e)}`)); }, every);
    this.timer.unref?.();
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  // ── Ending ────────────────────────────────────────────────────────────────

  /**
   * End a live session exactly once: a conditional write, then its frames go
   * and it is audited. Returns false when it had already ended.
   */
  async end(s: Pick<Row, 'id' | 'endpointId' | 'businessId' | 'technicianId' | 'shell' | 'createdAt' | 'startedAt'>, reason: EndReason, by: { userId?: string | null; ip?: string } = {}, extra: { exitCode?: number | null; refusal?: string } = {}) {
    const now = new Date();
    const r = await this.prisma.terminalSession.updateMany({
      where: { id: s.id, state: { in: LIVE } },
      data: { state: 'ended', endedAt: now, endReason: reason, endedById: by.userId ?? null, ...(extra.exitCode !== undefined ? { exitCode: extra.exitCode } : {}) },
    });
    if (r.count === 0) return false;
    await this.prisma.terminalFrame.deleteMany({ where: { sessionId: s.id } });
    const done = await this.prisma.terminalSession.findUnique({ where: { id: s.id }, select: { bytesIn: true, bytesOut: true } });
    await this.audit.log({
      action: endAction(reason), actorId: by.userId ?? undefined, actorIp: by.ip, customerId: s.businessId,
      resource: 'terminal_session', resourceId: s.id,
      meta: {
        sessionId: s.id, endpointId: s.endpointId, technicianId: s.technicianId, shell: s.shell, endReason: reason,
        durationMs: now.getTime() - s.createdAt.getTime(),
        shellMs: s.startedAt ? now.getTime() - s.startedAt.getTime() : 0,
        bytesIn: done?.bytesIn ?? 0, bytesOut: done?.bytesOut ?? 0,
        ...(extra.exitCode !== undefined && extra.exitCode !== null ? { exitCode: extra.exitCode } : {}),
        ...(extra.refusal ? { refusal: extra.refusal } : {}),
      },
    });
    this.wake.wake(s.endpointId);
    return true;
  }

  /**
   * Past a limit, or under a `remote` pause: end it now. Every read, write
   * and agent call passes through this first, so a limit holds even with the
   * sweep off. Returns the session as it now stands.
   */
  private async settle(s: Row, customerId: string | null, now = Date.now()): Promise<Row> {
    if (s.state === 'ended') return s;
    const due = expiry(s, now);
    if (due) {
      await this.end(s, due);
    } else if (await activePause(this.prisma, 'remote', customerId)) {
      await this.end(s, 'paused');
    } else {
      return s;
    }
    return (await this.prisma.terminalSession.findUnique({ where: { id: s.id }, select: SESSION_SELECT })) ?? s;
  }

  /** The sweep: ends what is due or paused, deletes stray frames, prunes transcripts past each business's days. */
  async sweep(now = Date.now()) {
    const live = await this.prisma.terminalSession.findMany({ where: { state: { in: LIVE } }, select: SESSION_SELECT, take: 500 });
    let ended = 0;
    for (const s of live) {
      const after = await this.settle(s, s.businessId, now);
      if (after.state === 'ended') ended++;
    }
    await this.prisma.terminalFrame.deleteMany({ where: { session: { state: 'ended' } } });
    // Transcripts: each business's own days (default 30); a business with no setting row keeps the default.
    const settings = await this.prisma.remoteOpsSetting.findMany({ select: { businessId: true, transcriptDays: true } });
    let pruned = 0;
    for (const st of settings) {
      pruned += (await this.prisma.terminalTranscriptChunk.deleteMany({
        where: { session: { businessId: st.businessId }, createdAt: { lt: new Date(now - st.transcriptDays * 86_400_000) } },
      })).count;
    }
    pruned += (await this.prisma.terminalTranscriptChunk.deleteMany({
      where: { session: { businessId: { notIn: settings.map((s) => s.businessId) } }, createdAt: { lt: new Date(now - TRANSCRIPT_DAYS_DEFAULT * 86_400_000) } },
    })).count;
    return { ended, pruned };
  }

  // ── The console ───────────────────────────────────────────────────────────

  private async visible(actor: ActorContext, endpointId: string, capability: typeof CAP.COMPUTERS_VIEW | typeof PLATFORM_CAP.COMPUTERS_TERMINAL) {
    if (!ENDPOINT_ID_RE.test(endpointId)) throw new NotFoundException('Computer not found');
    await this.acl.assertEndpointInScope(actor, endpointId, capability);
    const ep = await this.prisma.endpoint.findFirst({
      where: { AND: [{ id: endpointId }, this.acl.endpointVisibilityWhere(actor)] },
      select: {
        id: true, tenantId: true, customerId: true, platform: true, updateChannel: true, signedSeenAt: true, agentVersion: true,
        isOnline: true, lastSeenAt: true, status: true, rustdeskNode: { select: { agentSecretHash: true } },
      },
    });
    if (!ep) throw new NotFoundException('Computer not found');
    return ep;
  }

  private async sessionOf(endpointId: string, sid: string): Promise<Row> {
    if (!SESSION_ID_RE.test(sid)) throw new NotFoundException('Terminal session not found');
    const s = await this.prisma.terminalSession.findFirst({ where: { id: sid, endpointId }, select: SESSION_SELECT });
    if (!s) throw new NotFoundException('Terminal session not found');
    return s;
  }

  private enderFacts(actor: ActorContext) {
    return {
      userId: actor.userId, isPlatformAdmin: actor.isPlatformAdmin, technician: !!actor.technician,
      businessId: actor.businessId, canEditComputers: this.acl.can(actor, CAP.COMPUTERS_EDIT),
    };
  }

  private view(actor: ActorContext, s: Row, now: number, emails: Map<string, string> = new Map()) {
    const live = s.state !== 'ended';
    return {
      id: s.id, endpointId: s.endpointId, shell: s.shell, state: s.state, reason: s.reason,
      technicianId: s.technicianId, technicianEmail: emails.get(s.technicianId) ?? null, mine: s.technicianId === actor.userId,
      retained: s.retained, createdAt: s.createdAt, startedAt: s.startedAt, endedAt: s.endedAt, endReason: s.endReason,
      notAfter: s.notAfter, lastActivityAt: s.lastActivityAt, idleMs: TERMINAL_IDLE_MS,
      ...(live ? remaining(s, now) : { idleSeconds: 0, totalSeconds: 0 }),
      bytesIn: s.bytesIn, bytesOut: s.bytesOut, exitCode: s.exitCode,
      // The shell runs as the agent does. Never claimed otherwise.
      identity: 'SYSTEM' as const,
      canEnd: live && endAs(this.enderFacts(actor), s) !== null,
    };
  }

  /**
   * Open a terminal. In order: the computer in scope (404), the shell and the
   * reason (400), the fresh confirmation (terminal.open), then openRefusal
   * (pool, Windows and the signed agent, device secret, agent version, a
   * `remote` pause, connectivity, one live per technician, three per
   * computer). The audit row is written before the session exists, so a
   * computer is never handed a terminal without its record.
   */
  async open(actor: ActorContext, endpointId: string, body: { shell?: unknown; reason?: unknown }, freshMethod: string | null, now = Date.now()) {
    const ep = await this.visible(actor, endpointId, PLATFORM_CAP.COMPUTERS_TERMINAL);
    if (!isShell(body?.shell)) throw new BadRequestException({ code: 'TERMINAL_INVALID', message: 'Choose cmd or PowerShell.' });
    const reason = cleanReason(body?.reason);
    if (!reason) throw new BadRequestException({ code: 'TERMINAL_REASON_REQUIRED', message: 'Give a reason (3 to 500 characters): it is recorded in the audit log.' });
    assertFresh(freshMethod, { action: 'terminal.open', message: 'Confirm it is you to open a terminal. It runs as SYSTEM: full control of this device.' });

    // Settle what is live first, so an expired session does not count.
    for (const s of await this.prisma.terminalSession.findMany({ where: { endpointId: ep.id, state: { in: LIVE } }, select: SESSION_SELECT })) {
      await this.settle(s, ep.customerId, now);
    }
    const live = await this.prisma.terminalSession.findMany({ where: { endpointId: ep.id, state: { in: LIVE } }, select: { technicianId: true } });
    const refusal = openRefusal({
      pooled: isUnassigned(ep),
      windows: isWindowsPlatform(ep.platform),
      signed: runsSignedAgent({ updateChannel: ep.updateChannel, signedSeenAt: ep.signedSeenAt }, new Date(now)),
      deviceSecret: !!ep.rustdeskNode?.agentSecretHash,
      agentVersion: ep.agentVersion,
      minAgent: TERMINAL_MIN_AGENT,
      online: ep.status !== 'ARCHIVED' && connectivityOf(ep.isOnline, ep.lastSeenAt, now) === 'online',
      paused: !!(await activePause(this.prisma, 'remote', ep.customerId)),
      ownLive: live.some((l) => l.technicianId === actor.userId),
      liveCount: live.length,
    });
    if (refusal) throw new HttpException({ code: refusal.code, message: refusal.message }, refusal.status);

    const setting = await this.prisma.remoteOpsSetting.findUnique({ where: { businessId: ep.customerId! }, select: { terminalTranscripts: true } });
    const id = randomBytes(16).toString('hex');
    const created = new Date(now);
    const notAfter = new Date(hardLimit(now));
    await this.audit.logOrFail({
      action: 'TERMINAL_OPENED', actorId: actor.userId, actorIp: actor.ip, customerId: ep.customerId!, tenantId: ep.tenantId ?? undefined,
      resource: 'terminal_session', resourceId: id,
      meta: { sessionId: id, endpointId: ep.id, shell: body.shell, reason, retained: !!setting?.terminalTranscripts, notAfter: notAfter.toISOString(), identity: 'SYSTEM' },
    });
    try {
      await this.prisma.terminalSession.create({
        data: {
          id, endpointId: ep.id, businessId: ep.customerId!, technicianId: actor.userId, shell: body.shell as string, reason,
          retained: !!setting?.terminalTranscripts, createdAt: created, lastActivityAt: created, notAfter,
        },
      });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        throw new ConflictException({ code: 'TERMINAL_ALREADY_OPEN', message: 'You already have a terminal open on this device. End it first.' });
      }
      throw e;
    }
    this.wake.wake(ep.id);
    const row = await this.prisma.terminalSession.findUniqueOrThrow({ where: { id }, select: SESSION_SELECT });
    return this.view(actor, row, now);
  }

  /** The computer's live and recent terminals: metadata only, never what was typed or printed. View computers, in scope. */
  async list(actor: ActorContext, endpointId: string, now = Date.now()) {
    const ep = await this.visible(actor, endpointId, CAP.COMPUTERS_VIEW);
    const rows = await this.prisma.terminalSession.findMany({ where: { endpointId: ep.id }, orderBy: [{ createdAt: 'desc' }, { id: 'asc' }], take: LIST_RECENT, select: SESSION_SELECT });
    const settled: Row[] = [];
    for (const r of rows) settled.push(await this.settle(r, ep.customerId, now));
    const users = await this.prisma.user.findMany({ where: { id: { in: [...new Set(settled.map((s) => s.technicianId))] } }, select: { id: true, email: true } });
    const emails = new Map(users.map((u) => [u.id, u.email]));
    return {
      sessions: settled.map((s) => this.view(actor, s, now, emails)),
      limits: { idleMinutes: TERMINAL_IDLE_MS / 60_000, maxMinutes: 60, minAgent: TERMINAL_MIN_AGENT },
    };
  }

  /**
   * One session, and — for its own technician only — the output after
   * `after`, which also acknowledges (deletes) everything up to it. A
   * reconnecting browser reads from 0 again; nothing here moves a clock.
   */
  async read(actor: ActorContext, endpointId: string, sid: string, afterRaw: unknown, now = Date.now()) {
    const ep = await this.visible(actor, endpointId, PLATFORM_CAP.COMPUTERS_TERMINAL);
    const s = await this.settle(await this.sessionOf(ep.id, sid), ep.customerId, now);
    const mine = s.technicianId === actor.userId;
    let frames: { seq: number; stream: string; data: string }[] = [];
    if (mine) {
      const n = Number(afterRaw ?? 0);
      const after = Number.isInteger(n) && n >= 0 ? Math.min(n, s.outSeq) : 0;
      if (after > 0) await this.prisma.terminalFrame.deleteMany({ where: { sessionId: s.id, dir: 'out', seq: { lte: after } } });
      const rows = await this.prisma.terminalFrame.findMany({
        where: { sessionId: s.id, dir: 'out', seq: { gt: after } }, orderBy: { seq: 'asc' }, take: TERMINAL_READ_FRAMES, select: { seq: true, stream: true, data: true },
      });
      frames = rows.map((f) => ({ seq: f.seq, stream: f.stream, data: Buffer.from(f.data).toString('base64') }));
    }
    return { session: this.view(actor, s, now), frames };
  }

  private async mine(actor: ActorContext, endpointId: string, sid: string, now: number) {
    const ep = await this.visible(actor, endpointId, PLATFORM_CAP.COMPUTERS_TERMINAL);
    const s0 = await this.sessionOf(ep.id, sid);
    // Bound to one technician: anyone else is told nothing exists.
    if (s0.technicianId !== actor.userId) throw new NotFoundException('Terminal session not found');
    const s = await this.settle(s0, ep.customerId, now);
    if (s.state === 'ended') throw new ConflictException({ code: 'TERMINAL_ENDED', message: `This terminal has ended (${s.endReason}).`, endReason: s.endReason });
    return { ep, s };
  }

  /** The technician's input: one frame, queued for the agent. Only the session's own technician. */
  async input(actor: ActorContext, endpointId: string, sid: string, data: unknown, now = Date.now()) {
    const { s } = await this.mine(actor, endpointId, sid, now);
    const bytes = inputBytes(data);
    if (!bytes) throw new BadRequestException({ code: 'TERMINAL_INPUT_INVALID', message: 'Input must be 1 to 4,096 bytes of text.' });
    if (s.bytesIn + bytes.length > TERMINAL_SESSION_INPUT_MAX) {
      await this.end(s, 'input_cap', { userId: actor.userId, ip: actor.ip });
      throw new ConflictException({ code: 'TERMINAL_ENDED', message: 'This terminal reached its input limit (1 MB) and has ended.', endReason: 'input_cap' });
    }
    const seq = s.inSeq + 1;
    const at = new Date(now);
    await this.prisma.$transaction(async (tx) => {
      const u = await tx.terminalSession.updateMany({
        where: { id: s.id, state: { in: LIVE }, inSeq: s.inSeq },
        data: { inSeq: seq, bytesIn: { increment: bytes.length }, lastActivityAt: touch(s, now) },
      });
      if (u.count === 0) throw new ConflictException({ code: 'TERMINAL_BUSY', message: 'Another input arrived at the same moment. Send it again.' });
      await tx.terminalFrame.create({ data: { sessionId: s.id, dir: 'in', seq, stream: 'stdin', data: bytes, createdAt: at } });
      if (s.retained) await tx.terminalTranscriptChunk.create({ data: { sessionId: s.id, dir: 'in', seq, stream: 'stdin', data: bytes, createdAt: at } });
    });
    this.wake.wake(s.endpointId);
    return { seq };
  }

  /** "I am still here": moves only the idle clock, never past the hard limit. */
  async keepAlive(actor: ActorContext, endpointId: string, sid: string, now = Date.now()) {
    const { s } = await this.mine(actor, endpointId, sid, now);
    await this.prisma.terminalSession.updateMany({ where: { id: s.id, state: { in: LIVE } }, data: { lastActivityAt: touch(s, now) } });
    const after = await this.prisma.terminalSession.findUniqueOrThrow({ where: { id: s.id }, select: SESSION_SELECT });
    this.wake.wake(s.endpointId);
    return this.view(actor, after, now);
  }

  /**
   * End it: its own technician closes it; a Platform Admin, or the
   * business's own member with Edit computers, revokes it. Never asks for a
   * fresh confirmation. Anyone else: 404.
   */
  async endBy(actor: ActorContext, endpointId: string, sid: string, now = Date.now()) {
    const ep = await this.visible(actor, endpointId, CAP.COMPUTERS_VIEW);
    const s = await this.settle(await this.sessionOf(ep.id, sid), ep.customerId, now);
    const as = endAs(this.enderFacts(actor), s);
    if (!as) throw new NotFoundException('Terminal session not found');
    if (s.state === 'ended') return { ended: false, session: this.view(actor, s, now) };
    const ended = await this.end(s, as, { userId: actor.userId, ip: actor.ip });
    const after = await this.prisma.terminalSession.findUniqueOrThrow({ where: { id: s.id }, select: SESSION_SELECT });
    return { ended, session: this.view(actor, after, now) };
  }

  /** The opt-in transcript, when the session kept one. computers:terminal, in scope. */
  async transcript(actor: ActorContext, endpointId: string, sid: string) {
    const ep = await this.visible(actor, endpointId, PLATFORM_CAP.COMPUTERS_TERMINAL);
    const s = await this.sessionOf(ep.id, sid);
    if (!s.retained) throw new NotFoundException({ code: 'TERMINAL_NO_TRANSCRIPT', message: 'No transcript was kept for this session: transcripts are off for this customer.' });
    const rows = await this.prisma.terminalTranscriptChunk.findMany({
      where: { sessionId: s.id }, orderBy: [{ createdAt: 'asc' }, { dir: 'asc' }, { seq: 'asc' }], take: 5_000,
      select: { dir: true, seq: true, stream: true, data: true, createdAt: true },
    });
    return { sessionId: s.id, chunks: rows.map((r) => ({ dir: r.dir, seq: r.seq, stream: r.stream, at: r.createdAt, data: Buffer.from(r.data).toString('base64') })) };
  }

  // ── The agent (called by RemoteAgentService, after the device secret) ──────

  /** Whether the computer has a live terminal: the heartbeat's remotePoll. */
  async liveOn(endpointId: string): Promise<boolean> {
    return (await this.prisma.terminalSession.count({ where: { endpointId, state: { in: LIVE } } })) > 0;
  }

  /**
   * What one poll is told about terminals. `held` is what the worker says it
   * is running, with the last input frame it took from each. A held session
   * that has ended is told `end`; a pending one it does not hold is told
   * `start`; an open one it no longer holds has lost its shell and ends
   * (agent_error). Input frames it took are deleted.
   */
  async forAgent(ep: { id: string; customerId: string | null }, held: { id: string; inAcked: number }[], now = Date.now()): Promise<{ terminals: AgentTerminal[]; work: boolean }> {
    const out: AgentTerminal[] = [];
    let work = false;
    const heldIds = new Set(held.map((h) => h.id));
    for (const h of held) {
      const row = await this.prisma.terminalSession.findFirst({ where: { id: h.id, endpointId: ep.id }, select: SESSION_SELECT });
      if (!row) { out.push({ id: h.id, op: 'end', reason: 'agent_error' }); work = true; continue; }
      const s = await this.settle(row, ep.customerId, now);
      if (s.state === 'ended') { out.push({ id: s.id, op: 'end', reason: s.endReason ?? 'closed' }); work = true; continue; }
      if (s.state === 'pending') { out.push({ id: s.id, op: 'end', reason: 'agent_error' }); await this.end(s, 'agent_error'); work = true; continue; }
      let acked = s.inAcked;
      if (Number.isInteger(h.inAcked) && h.inAcked > s.inAcked && h.inAcked <= s.inSeq) {
        await this.prisma.terminalSession.updateMany({ where: { id: s.id, inAcked: { lt: h.inAcked } }, data: { inAcked: h.inAcked } });
        await this.prisma.terminalFrame.deleteMany({ where: { sessionId: s.id, dir: 'in', seq: { lte: h.inAcked } } });
        acked = h.inAcked;
      }
      const frames = await this.prisma.terminalFrame.findMany({
        where: { sessionId: s.id, dir: 'in', seq: { gt: acked } }, orderBy: { seq: 'asc' }, take: TERMINAL_INPUT_FRAMES_PER_POLL, select: { seq: true, data: true },
      });
      if (frames.length) work = true;
      out.push({
        id: s.id, op: 'open', notAfter: s.notAfter.toISOString(), idleAt: new Date(s.lastActivityAt.getTime() + TERMINAL_IDLE_MS).toISOString(),
        input: frames.map((f) => ({ seq: f.seq, data: Buffer.from(f.data).toString('base64') })),
      });
    }
    const live = await this.prisma.terminalSession.findMany({ where: { endpointId: ep.id, state: { in: LIVE } }, select: SESSION_SELECT, orderBy: { createdAt: 'asc' } });
    for (const row of live) {
      if (heldIds.has(row.id)) continue;
      const s = await this.settle(row, ep.customerId, now);
      if (s.state === 'ended') continue;
      if (s.state === 'open') { await this.end(s, 'agent_error'); continue; }
      out.push({ id: s.id, op: 'start', shell: s.shell, notAfter: s.notAfter.toISOString(), idleAt: new Date(s.lastActivityAt.getTime() + TERMINAL_IDLE_MS).toISOString() });
      work = true;
    }
    return { terminals: out, work };
  }

  /** Whether a held poll has something to say (another process's news). */
  async agentHasWork(endpointId: string, held: { id: string; inAcked: number }[]): Promise<boolean> {
    const heldIds = held.map((h) => h.id);
    const [pending, ended, input] = await Promise.all([
      this.prisma.terminalSession.count({ where: { endpointId, state: 'pending', id: { notIn: heldIds } } }),
      heldIds.length ? this.prisma.terminalSession.count({ where: { endpointId, id: { in: heldIds }, state: 'ended' } }) : 0,
      heldIds.length ? this.prisma.terminalFrame.count({ where: { dir: 'in', session: { endpointId, id: { in: heldIds } }, seq: { gt: Math.min(...held.map((h) => h.inAcked)) } } }) : 0,
    ]);
    return pending + ended + input > 0;
  }

  /**
   * What the agent posts for one terminal: started, output frames, the exit,
   * or a refusal. The session must be this computer's (404 otherwise: a
   * device secret reaches its own sessions only). Returns whether the agent
   * should end it.
   */
  async fromAgent(ep: { id: string; customerId: string | null }, body: {
    sessionId: string; started?: boolean; frames?: unknown; exited?: { code: number } | null; refused?: string;
  }, now = Date.now()) {
    const row = await this.prisma.terminalSession.findFirst({ where: { id: body.sessionId, endpointId: ep.id }, select: SESSION_SELECT });
    if (!row) throw new NotFoundException('Terminal session not found');
    let s = await this.settle(row, ep.customerId, now);
    if (s.state === 'ended') return { end: true, reason: s.endReason };
    if (body.refused) {
      const code = (AGENT_REFUSALS as readonly string[]).includes(body.refused) ? body.refused : 'bad_request';
      await this.end(s, 'agent_refused', {}, { refusal: code });
      return { end: true, reason: 'agent_refused' };
    }
    if (body.started && s.state === 'pending') {
      const u = await this.prisma.terminalSession.updateMany({ where: { id: s.id, state: 'pending' }, data: { state: 'open', startedAt: new Date(now) } });
      if (u.count) {
        await this.audit.log({
          action: 'TERMINAL_STARTED', customerId: s.businessId, resource: 'terminal_session', resourceId: s.id,
          meta: { sessionId: s.id, endpointId: s.endpointId, technicianId: s.technicianId, shell: s.shell, identity: 'SYSTEM' },
        });
      }
      s = (await this.prisma.terminalSession.findUnique({ where: { id: s.id }, select: SESSION_SELECT })) ?? s;
    }
    const frames = outputFrames(body.frames, s.outSeq);
    if (frames === null) throw new BadRequestException({ code: 'TERMINAL_FRAMES_INVALID', message: 'Output frames must follow on, 1–16,384 bytes each, at most 16 a post.' });
    if (frames.length && s.state !== 'open') throw new ConflictException({ code: 'TERMINAL_NOT_STARTED', message: 'Say started before sending output.' });
    if (frames.length) {
      const total = frames.reduce((n, f) => n + f.data.length, 0);
      if (s.bytesOut + total > TERMINAL_SESSION_OUTPUT_MAX) {
        await this.end(s, 'output_cap');
        return { end: true, reason: 'output_cap' };
      }
      const at = new Date(now);
      const last = frames[frames.length - 1].seq;
      const ok = await this.prisma.$transaction(async (tx) => {
        const u = await tx.terminalSession.updateMany({ where: { id: s.id, state: 'open', outSeq: s.outSeq }, data: { outSeq: last, bytesOut: { increment: total } } });
        if (u.count === 0) return false;
        await tx.terminalFrame.createMany({ data: frames.map((f) => ({ sessionId: s.id, dir: 'out', seq: f.seq, stream: f.stream, data: f.data, createdAt: at })) });
        if (s.retained) await tx.terminalTranscriptChunk.createMany({ data: frames.map((f) => ({ sessionId: s.id, dir: 'out', seq: f.seq, stream: f.stream, data: f.data, createdAt: at })) });
        return true;
      });
      if (!ok) throw new ConflictException({ code: 'TERMINAL_BUSY', message: 'Output arrived out of order. Send it again.' });
    }
    if (body.exited) {
      const code = Number.isInteger(body.exited.code) ? body.exited.code : null;
      await this.end(s, 'exited', {}, { exitCode: code });
      return { end: true, reason: 'exited' };
    }
    return { end: false, reason: null };
  }

  /** For the agent: why a computer may no longer poll (it left the business, the agent, Windows). */
  async endAllOn(endpointId: string, reason: EndReason) {
    for (const s of await this.prisma.terminalSession.findMany({ where: { endpointId, state: { in: LIVE } }, select: SESSION_SELECT })) await this.end(s, reason);
  }
}
