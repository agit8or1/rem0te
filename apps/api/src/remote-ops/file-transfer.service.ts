import {
  BadRequestException, ConflictException, GoneException, HttpException, Injectable, Logger, NotFoundException, OnModuleDestroy, OnModuleInit,
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
  AGENT_FILE_ERRORS, ENDPOINT_ID_RE, FILE_CHUNK_BYTES, FILE_CHUNK_KEEP_MS, FILE_MAX_MB_DEFAULT, FILE_STALL_MS,
  FILE_TRANSFER_MAX_MS, FILE_WINDOW_CHUNKS, FILES_MIN_AGENT, SESSION_ID_RE, type FileDirection, type FileEndReason,
} from './limits';
import { cleanReason, endAs } from './policy';
import {
  checkPath, chunkFits, chunksFor, decodeChunk, fileEndAction, fileExpiry, fileRefusal, isLiveTransfer, isSha256, maxBytesOf,
} from './file-policy';
import { RemoteWakeService } from './remote-wake.service';

const LIVE = ['pending', 'transferring'];
const SWEEP_MS_DEFAULT = 30_000;
const LIST_RECENT = 20;

const SELECT = {
  id: true, endpointId: true, businessId: true, technicianId: true, direction: true, path: true, overwrite: true, reason: true,
  state: true, size: true, sha256: true, maxBytes: true, chunks: true, inSeq: true, ackSeq: true, bytesDone: true,
  createdAt: true, notAfter: true, lastProgressAt: true, deliveredAt: true, endedAt: true, endReason: true, endedById: true,
} as const;
type Row = Prisma.FileTransferGetPayload<{ select: typeof SELECT }>;

/** What a held agent poll is told about one transfer. */
export type AgentFile =
  | { id: string; op: 'start'; direction: FileDirection; path: string; overwrite: boolean; size: number | null; sha256: string | null; maxBytes: number; notAfter: string }
  | { id: string; op: 'end'; reason: string };

const num = (b: bigint | null) => (b === null ? null : Number(b));

/**
 * Background file transfer (0.78 Courier, docs/file-transfer.md). It is the
 * only writer of FileTransfer and FileTransferChunk.
 *
 * Upload (`to_computer`):
 *   1. The browser declares the path, the size and the SHA-256.
 *   2. The browser sends chunks of 512 KiB. At most eight wait at a time.
 *   3. The agent pulls them. Each one is deleted as the agent takes the next.
 *   4. The agent writes a temporary file beside the target and checks the
 *      SHA-256. Only then does it put the file in place, and it never
 *      replaces an existing file unless the request said so.
 *
 * Download (`from_computer`):
 *   1. The agent hashes the file and declares its size and SHA-256.
 *   2. The agent pushes chunks. At most eight wait for the browser.
 *   3. The browser takes them, checks the whole file's SHA-256, and says it
 *      has them.
 *
 * Who may do what:
 *   - Upload and download are separate platform-only capabilities.
 *   - Asking is in scope, with a reason, under the fresh confirmation
 *     `files.transfer` (default `off`). Then fileRefusal runs.
 *   - Cancelling follows the terminal's rule (the technician, a Platform
 *     Admin, or the business's own member with Edit computers).
 *
 * When a transfer stops:
 *   - A `remote` pause ends a live transfer.
 *   - So do the 60-minute limit, and 10 minutes with no chunk moving.
 *
 * The audit log records ids, the direction, the path, the size and the
 * SHA-256, never content.
 */
@Injectable()
export class FileTransferService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger('FileTransfer');
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly acl: AccessControlService,
    private readonly wake: RemoteWakeService,
  ) {}

  onModuleInit() {
    // The remote-ops sweep: the terminal's switch stops both.
    if (process.env.TERMINAL_SWEEP === 'off') return;
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
   * End a live transfer exactly once. A conditional write ends it, then its
   * chunks go (except a completed download's, which wait for the browser),
   * then it is audited. Returns false when it had already ended.
   */
  async end(t: Row, reason: FileEndReason, by: { userId?: string | null; ip?: string } = {}, extra: { size?: number; sha256?: string } = {}) {
    const now = new Date();
    const state = reason === 'completed' ? 'completed' : reason === 'cancelled' || reason === 'revoked' ? 'cancelled' : 'failed';
    const r = await this.prisma.fileTransfer.updateMany({
      where: { id: t.id, state: { in: LIVE } },
      data: {
        state, endedAt: now, endReason: reason, endedById: by.userId ?? null,
        ...(state === 'completed' && t.direction === 'to_computer' ? { ackSeq: t.inSeq, bytesDone: t.size ?? 0n } : {}),
      },
    });
    if (r.count === 0) return false;
    if (!(state === 'completed' && t.direction === 'from_computer')) {
      await this.prisma.fileTransferChunk.deleteMany({ where: { transferId: t.id } });
    }
    const done = await this.prisma.fileTransfer.findUnique({ where: { id: t.id }, select: { size: true, sha256: true, bytesDone: true } });
    await this.audit.log({
      action: fileEndAction(reason), actorId: by.userId ?? undefined, actorIp: by.ip, customerId: t.businessId,
      resource: 'file_transfer', resourceId: t.id,
      meta: {
        transferId: t.id, endpointId: t.endpointId, technicianId: t.technicianId, direction: t.direction, path: t.path,
        endReason: reason, size: num(done?.size ?? null), sha256: extra.sha256 ?? done?.sha256 ?? null,
        bytesDone: num(done?.bytesDone ?? 0n), durationMs: now.getTime() - t.createdAt.getTime(),
      },
    });
    this.wake.wake(t.endpointId);
    return true;
  }

  /**
   * End a transfer that is past a limit or under a `remote` pause. Every
   * read, write and agent call passes through this first.
   */
  private async settle(t: Row, customerId: string | null, now = Date.now()): Promise<Row> {
    if (!isLiveTransfer(t.state)) return t;
    const due = fileExpiry(t, now);
    if (due) await this.end(t, due);
    else if (await activePause(this.prisma, 'remote', customerId)) await this.end(t, 'paused');
    else return t;
    return (await this.prisma.fileTransfer.findUnique({ where: { id: t.id }, select: SELECT })) ?? t;
  }

  /**
   * The sweep:
   *   - ends what is due or paused;
   *   - deletes a finished download's chunks once the browser has had 15
   *     minutes to take them;
   *   - deletes any chunk of a transfer that is not live.
   */
  async sweep(now = Date.now()) {
    const live = await this.prisma.fileTransfer.findMany({ where: { state: { in: LIVE } }, select: SELECT, take: 500 });
    let ended = 0;
    for (const t of live) if (!isLiveTransfer((await this.settle(t, t.businessId, now)).state)) ended++;
    const gone = await this.prisma.fileTransferChunk.deleteMany({
      where: {
        OR: [
          { transfer: { state: { in: ['failed', 'cancelled'] } } },
          { transfer: { state: 'completed', direction: 'to_computer' } },
          { transfer: { state: 'completed', endedAt: { lt: new Date(now - FILE_CHUNK_KEEP_MS) } } },
        ],
      },
    });
    return { ended, chunksDeleted: gone.count };
  }

  // ── The console ───────────────────────────────────────────────────────────

  private async visible(actor: ActorContext, endpointId: string, capability: typeof CAP.COMPUTERS_VIEW | typeof PLATFORM_CAP.COMPUTERS_FILES_UPLOAD | typeof PLATFORM_CAP.COMPUTERS_FILES_DOWNLOAD) {
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

  private async transferOf(endpointId: string, tid: string): Promise<Row> {
    if (!SESSION_ID_RE.test(tid)) throw new NotFoundException('Transfer not found');
    const t = await this.prisma.fileTransfer.findFirst({ where: { id: tid, endpointId }, select: SELECT });
    if (!t) throw new NotFoundException('Transfer not found');
    return t;
  }

  private enderFacts(actor: ActorContext) {
    return {
      userId: actor.userId, isPlatformAdmin: actor.isPlatformAdmin, technician: !!actor.technician,
      businessId: actor.businessId, canEditComputers: this.acl.can(actor, CAP.COMPUTERS_EDIT),
    };
  }

  private async maxBytesFor(businessId: string): Promise<number> {
    const s = await this.prisma.remoteOpsSetting.findUnique({ where: { businessId }, select: { fileMaxMb: true } });
    return maxBytesOf(s?.fileMaxMb ?? FILE_MAX_MB_DEFAULT);
  }

  private view(actor: ActorContext, t: Row, emails: Map<string, string> = new Map()) {
    return {
      id: t.id, endpointId: t.endpointId, direction: t.direction, path: t.path, overwrite: t.overwrite, reason: t.reason,
      state: t.state, size: num(t.size), sha256: t.sha256, maxBytes: num(t.maxBytes), chunks: t.chunks, inSeq: t.inSeq, ackSeq: t.ackSeq,
      bytesDone: num(t.bytesDone), createdAt: t.createdAt, notAfter: t.notAfter, lastProgressAt: t.lastProgressAt,
      endedAt: t.endedAt, endReason: t.endReason,
      technicianId: t.technicianId, technicianEmail: emails.get(t.technicianId) ?? null, mine: t.technicianId === actor.userId,
      // The agent reads and writes as it runs: SYSTEM. Never claimed otherwise.
      identity: 'SYSTEM' as const,
      canCancel: isLiveTransfer(t.state) && endAs(this.enderFacts(actor), t) !== null,
    };
  }

  /** The computer's live and recent transfers: metadata only. View computers, in scope. */
  async list(actor: ActorContext, endpointId: string, now = Date.now()) {
    const ep = await this.visible(actor, endpointId, CAP.COMPUTERS_VIEW);
    const rows = await this.prisma.fileTransfer.findMany({ where: { endpointId: ep.id }, orderBy: [{ createdAt: 'desc' }, { id: 'asc' }], take: LIST_RECENT, select: SELECT });
    const settled: Row[] = [];
    for (const r of rows) settled.push(await this.settle(r, ep.customerId, now));
    const users = await this.prisma.user.findMany({ where: { id: { in: [...new Set(settled.map((t) => t.technicianId))] } }, select: { id: true, email: true } });
    const emails = new Map(users.map((u) => [u.id, u.email]));
    return {
      transfers: settled.map((t) => this.view(actor, t, emails)),
      limits: {
        maxBytes: ep.customerId ? await this.maxBytesFor(ep.customerId) : 0, chunkBytes: FILE_CHUNK_BYTES, windowChunks: FILE_WINDOW_CHUNKS,
        maxMinutes: FILE_TRANSFER_MAX_MS / 60_000, stallMinutes: FILE_STALL_MS / 60_000, minAgent: FILES_MIN_AGENT,
      },
    };
  }

  /**
   * Ask for a transfer, in this order:
   *   1. the computer in scope, with the direction's capability (404);
   *   2. the path, the reason, and, for an upload, the size (within the
   *      business's limit) and the SHA-256 (400);
   *   3. the fresh confirmation (`files.transfer`);
   *   4. fileRefusal.
   * The audit row is written before the transfer exists.
   */
  async request(actor: ActorContext, endpointId: string, direction: FileDirection, body: Record<string, unknown>, freshMethod: string | null, now = Date.now()) {
    const cap = direction === 'to_computer' ? PLATFORM_CAP.COMPUTERS_FILES_UPLOAD : PLATFORM_CAP.COMPUTERS_FILES_DOWNLOAD;
    const ep = await this.visible(actor, endpointId, cap);
    const bad = checkPath(body?.path);
    if (bad) throw new BadRequestException({ code: 'FILES_PATH_REFUSED', message: `That path is refused: ${bad}.` });
    const reason = cleanReason(body?.reason);
    if (!reason) throw new BadRequestException({ code: 'FILES_REASON_REQUIRED', message: 'Give a reason (3 to 500 characters): it is recorded in the audit log.' });
    const maxBytes = ep.customerId ? await this.maxBytesFor(ep.customerId) : 0;
    let size: number | null = null;
    let sha256: string | null = null;
    if (direction === 'to_computer') {
      size = Number(body?.size);
      if (!Number.isSafeInteger(size) || size < 0) throw new BadRequestException({ code: 'FILES_SIZE_INVALID', message: 'The file size is not valid.' });
      if (size > maxBytes) throw new BadRequestException({ code: 'FILES_TOO_LARGE', message: `This business allows files up to ${Math.floor(maxBytes / 1048576)} MB.`, maxBytes });
      if (!isSha256(body?.sha256)) throw new BadRequestException({ code: 'FILES_SHA256_INVALID', message: 'The file\'s SHA-256 is missing or not valid.' });
      sha256 = body.sha256;
    }
    const overwrite = body?.overwrite === true;
    if (direction === 'from_computer' && overwrite) throw new BadRequestException({ code: 'FILES_INVALID', message: 'Overwrite applies only to sending a file to the computer.' });
    assertFresh(freshMethod, { action: 'files.transfer', message: 'Confirm it is you to transfer a file. The agent reads and writes as SYSTEM.' });

    for (const t of await this.prisma.fileTransfer.findMany({ where: { endpointId: ep.id, state: { in: LIVE } }, select: SELECT })) {
      await this.settle(t, ep.customerId, now);
    }
    const refusal = fileRefusal({
      pooled: isUnassigned(ep),
      windows: isWindowsPlatform(ep.platform),
      signed: runsSignedAgent({ updateChannel: ep.updateChannel, signedSeenAt: ep.signedSeenAt }, new Date(now)),
      deviceSecret: !!ep.rustdeskNode?.agentSecretHash,
      agentVersion: ep.agentVersion,
      minAgent: FILES_MIN_AGENT,
      online: ep.status !== 'ARCHIVED' && connectivityOf(ep.isOnline, ep.lastSeenAt, now) === 'online',
      paused: !!(await activePause(this.prisma, 'remote', ep.customerId)),
      liveCount: await this.prisma.fileTransfer.count({ where: { endpointId: ep.id, state: { in: LIVE } } }),
    });
    if (refusal) throw new HttpException({ code: refusal.code, message: refusal.message }, refusal.status);

    const id = randomBytes(16).toString('hex');
    const notAfter = new Date(now + FILE_TRANSFER_MAX_MS);
    const path = body.path as string;
    await this.audit.logOrFail({
      action: 'FILE_TRANSFER_REQUESTED', actorId: actor.userId, actorIp: actor.ip, customerId: ep.customerId!, tenantId: ep.tenantId ?? undefined,
      resource: 'file_transfer', resourceId: id,
      meta: { transferId: id, endpointId: ep.id, direction, path, overwrite, size, sha256, reason, maxBytes, identity: 'SYSTEM' },
    });
    await this.prisma.fileTransfer.create({
      data: {
        id, endpointId: ep.id, businessId: ep.customerId!, technicianId: actor.userId, direction, path, overwrite, reason,
        size: size === null ? null : BigInt(size), sha256, maxBytes: BigInt(maxBytes),
        chunks: size === null ? 0 : chunksFor(size), createdAt: new Date(now), lastProgressAt: new Date(now), notAfter,
      },
    });
    this.wake.wake(ep.id);
    return this.view(actor, await this.prisma.fileTransfer.findUniqueOrThrow({ where: { id }, select: SELECT }));
  }

  /** One transfer's state. View computers, in scope. */
  async get(actor: ActorContext, endpointId: string, tid: string, now = Date.now()) {
    const ep = await this.visible(actor, endpointId, CAP.COMPUTERS_VIEW);
    return this.view(actor, await this.settle(await this.transferOf(ep.id, tid), ep.customerId, now));
  }

  /** The technician's own transfer, in the direction's capability. Anyone else is told nothing exists. */
  private async mine(actor: ActorContext, endpointId: string, tid: string, direction: FileDirection, now: number) {
    const cap = direction === 'to_computer' ? PLATFORM_CAP.COMPUTERS_FILES_UPLOAD : PLATFORM_CAP.COMPUTERS_FILES_DOWNLOAD;
    const ep = await this.visible(actor, endpointId, cap);
    const t0 = await this.transferOf(ep.id, tid);
    if (t0.technicianId !== actor.userId || t0.direction !== direction) throw new NotFoundException('Transfer not found');
    return { ep, t: await this.settle(t0, ep.customerId, now) };
  }

  /**
   * An upload's next chunk, from the browser. The rules:
   *   - Chunks come in order. A repeated chunk is accepted and ignored.
   *   - At most eight may wait for the agent. A ninth is
   *     `409 FILES_WINDOW_FULL`, and the browser tries again.
   *   - Each chunk's SHA-256 is checked against the hash sent with it.
   *   - Each chunk must fit the declared size.
   */
  async putChunk(actor: ActorContext, endpointId: string, tid: string, body: { seq?: unknown; data?: unknown; sha256?: unknown }, now = Date.now()) {
    const { t } = await this.mine(actor, endpointId, tid, 'to_computer', now);
    if (!isLiveTransfer(t.state)) throw new ConflictException({ code: 'FILES_ENDED', message: `This transfer has ended (${t.endReason}).`, endReason: t.endReason });
    const seq = Number(body?.seq);
    if (!Number.isInteger(seq) || seq < 1) throw new BadRequestException({ code: 'FILES_CHUNK_INVALID', message: 'The chunk number is not valid.' });
    if (seq <= t.inSeq) return { seq, duplicate: true, inSeq: t.inSeq, ackSeq: t.ackSeq };
    if (seq !== t.inSeq + 1) throw new ConflictException({ code: 'FILES_CHUNK_ORDER', message: `Send chunk ${t.inSeq + 1} next.`, inSeq: t.inSeq });
    if (seq - t.ackSeq > FILE_WINDOW_CHUNKS) throw new ConflictException({ code: 'FILES_WINDOW_FULL', message: 'The computer has not caught up yet. Send this chunk again shortly.', inSeq: t.inSeq, ackSeq: t.ackSeq });
    const data = decodeChunk(body?.data, body?.sha256);
    if (!data || !chunkFits(seq, data.length, Number(t.size))) throw new BadRequestException({ code: 'FILES_CHUNK_INVALID', message: 'The chunk does not match its SHA-256 or the declared size.' });
    const ok = await this.prisma.$transaction(async (tx) => {
      const u = await tx.fileTransfer.updateMany({ where: { id: t.id, state: { in: LIVE }, inSeq: t.inSeq }, data: { inSeq: seq, lastProgressAt: new Date(now) } });
      if (u.count === 0) return false;
      await tx.fileTransferChunk.create({ data: { transferId: t.id, seq, data, sha256: body.sha256 as string } });
      return true;
    });
    if (!ok) throw new ConflictException({ code: 'FILES_BUSY', message: 'Another chunk arrived at the same moment. Send it again.' });
    this.wake.wake(t.endpointId);
    return { seq, duplicate: false, inSeq: seq, ackSeq: t.ackSeq };
  }

  /**
   * A download's chunk, for the browser. Asking for chunk n deletes every
   * chunk before it: the browser has those.
   */
  async getChunk(actor: ActorContext, endpointId: string, tid: string, seqRaw: unknown, now = Date.now()) {
    const { t } = await this.mine(actor, endpointId, tid, 'from_computer', now);
    if (t.state !== 'transferring' && t.state !== 'completed') throw new ConflictException({ code: 'FILES_NOT_READY', message: 'Nothing has arrived from the computer yet.', state: t.state, endReason: t.endReason });
    const seq = Number(seqRaw);
    if (!Number.isInteger(seq) || seq < 1) throw new BadRequestException({ code: 'FILES_CHUNK_INVALID', message: 'The chunk number is not valid.' });
    if (seq > t.inSeq) throw new ConflictException({ code: 'FILES_NOT_READY', message: 'That chunk has not arrived yet.', state: t.state, inSeq: t.inSeq });
    if (seq - 1 > t.ackSeq) {
      await this.prisma.fileTransferChunk.deleteMany({ where: { transferId: t.id, seq: { lt: seq } } });
      await this.prisma.fileTransfer.updateMany({
        where: { id: t.id, ackSeq: { lt: seq - 1 } },
        data: { ackSeq: seq - 1, ...(isLiveTransfer(t.state) ? { lastProgressAt: new Date(now) } : {}) },
      });
      this.wake.wake(t.endpointId);
    }
    const c = await this.prisma.fileTransferChunk.findUnique({ where: { transferId_seq: { transferId: t.id, seq } }, select: { data: true, sha256: true } });
    if (!c) throw new GoneException({ code: 'FILES_CHUNK_GONE', message: 'That chunk is no longer held. Start the download again.' });
    return { seq, data: Buffer.from(c.data).toString('base64'), sha256: c.sha256, last: t.state === 'completed' && seq === t.chunks };
  }

  /**
   * The browser has the whole download. Its remaining chunks are deleted,
   * and it is told whether the hash it computed is the agent's.
   */
  async received(actor: ActorContext, endpointId: string, tid: string, body: { sha256?: unknown }, now = Date.now()) {
    const { t } = await this.mine(actor, endpointId, tid, 'from_computer', now);
    if (t.state !== 'completed') throw new ConflictException({ code: 'FILES_NOT_READY', message: 'The download has not completed.', state: t.state });
    await this.prisma.fileTransferChunk.deleteMany({ where: { transferId: t.id } });
    await this.prisma.fileTransfer.updateMany({ where: { id: t.id, ackSeq: { lt: t.inSeq } }, data: { ackSeq: t.inSeq } });
    return { verified: isSha256(body?.sha256) && body.sha256 === t.sha256, sha256: t.sha256 };
  }

  /**
   * Cancel. The technician cancels their own transfer. A Platform Admin, or
   * the business's own member with Edit computers, may revoke it. This never
   * asks for a fresh confirmation. Anyone else gets a 404.
   */
  async cancel(actor: ActorContext, endpointId: string, tid: string, now = Date.now()) {
    const ep = await this.visible(actor, endpointId, CAP.COMPUTERS_VIEW);
    const t = await this.settle(await this.transferOf(ep.id, tid), ep.customerId, now);
    const as = endAs(this.enderFacts(actor), t);
    if (!as) throw new NotFoundException('Transfer not found');
    if (!isLiveTransfer(t.state)) return { cancelled: false, transfer: this.view(actor, t) };
    const done = await this.end(t, as === 'closed' ? 'cancelled' : 'revoked', { userId: actor.userId, ip: actor.ip });
    return { cancelled: done, transfer: this.view(actor, await this.prisma.fileTransfer.findUniqueOrThrow({ where: { id: t.id }, select: SELECT })) };
  }

  // ── The agent (called by RemoteAgentService, after the device secret) ──────

  /**
   * What one poll is told about transfers. `held` is the transfer ids the
   * worker says it is running.
   *   - A held transfer that has ended is told `end`.
   *   - A pending one never handed out is handed out (`start`), once.
   *   - One handed out that the worker no longer holds has been lost, and
   *     fails as `agent_error`.
   */
  async forAgent(ep: { id: string; customerId: string | null }, held: string[], now = Date.now()): Promise<{ files: AgentFile[]; work: boolean }> {
    const out: AgentFile[] = [];
    let work = false;
    const heldIds = new Set(held);
    for (const id of held) {
      const row = await this.prisma.fileTransfer.findFirst({ where: { id, endpointId: ep.id }, select: SELECT });
      if (!row) { out.push({ id, op: 'end', reason: 'agent_error' }); work = true; continue; }
      const t = await this.settle(row, ep.customerId, now);
      if (!isLiveTransfer(t.state)) { out.push({ id: t.id, op: 'end', reason: t.endReason ?? 'cancelled' }); work = true; }
    }
    const live = await this.prisma.fileTransfer.findMany({ where: { endpointId: ep.id, state: { in: LIVE } }, select: SELECT, orderBy: { createdAt: 'asc' } });
    for (const row of live) {
      if (heldIds.has(row.id)) continue;
      const t = await this.settle(row, ep.customerId, now);
      if (!isLiveTransfer(t.state)) continue;
      if (t.deliveredAt) { await this.end(t, 'agent_error'); continue; }
      const u = await this.prisma.fileTransfer.updateMany({ where: { id: t.id, deliveredAt: null, state: 'pending' }, data: { deliveredAt: new Date(now) } });
      if (u.count === 0) continue;
      out.push({
        id: t.id, op: 'start', direction: t.direction as FileDirection, path: t.path, overwrite: t.overwrite,
        size: num(t.size), sha256: t.sha256, maxBytes: Number(t.maxBytes), notAfter: t.notAfter.toISOString(),
      });
      work = true;
    }
    return { files: out, work };
  }

  /** Whether a held poll has something to say about transfers. */
  async agentHasWork(endpointId: string, held: string[]): Promise<boolean> {
    const [fresh, ended] = await Promise.all([
      this.prisma.fileTransfer.count({ where: { endpointId, state: 'pending', deliveredAt: null } }),
      held.length ? this.prisma.fileTransfer.count({ where: { endpointId, id: { in: held }, state: { notIn: LIVE } } }) : 0,
    ]);
    return fresh + ended > 0;
  }

  /** Whether the computer has a live transfer: part of the heartbeat's remotePoll. */
  async liveOn(endpointId: string): Promise<boolean> {
    return (await this.prisma.fileTransfer.count({ where: { endpointId, state: { in: LIVE } } })) > 0;
  }

  private async agentRow(ep: { id: string; customerId: string | null }, id: string, direction: FileDirection, now: number) {
    const row = await this.prisma.fileTransfer.findFirst({ where: { id, endpointId: ep.id }, select: SELECT });
    if (!row || row.direction !== direction) throw new NotFoundException('Transfer not found');
    return this.settle(row, ep.customerId, now);
  }

  private async moving(t: Row, now: number): Promise<Row> {
    if (t.state !== 'pending') return t;
    await this.prisma.fileTransfer.updateMany({ where: { id: t.id, state: 'pending' }, data: { state: 'transferring', lastProgressAt: new Date(now) } });
    return (await this.prisma.fileTransfer.findUnique({ where: { id: t.id }, select: SELECT })) ?? t;
  }

  /**
   * An upload's chunk `seq`, for the agent. Asking for it says the agent has
   * every chunk before it, so those are deleted. If the chunk has not
   * arrived yet, the answer is `wait`.
   */
  async pull(ep: { id: string; customerId: string | null }, body: { id: string; seq: number }, now = Date.now()) {
    let t = await this.agentRow(ep, body.id, 'to_computer', now);
    if (!isLiveTransfer(t.state)) return { end: true, reason: t.endReason };
    t = await this.moving(t, now);
    const seq = Math.min(body.seq, t.chunks + 1);
    if (seq - 1 > t.ackSeq && seq - 1 <= t.inSeq) {
      await this.prisma.fileTransferChunk.deleteMany({ where: { transferId: t.id, seq: { lt: seq } } });
      await this.prisma.fileTransfer.updateMany({
        where: { id: t.id, ackSeq: { lt: seq - 1 } },
        data: { ackSeq: seq - 1, bytesDone: BigInt(Math.min((seq - 1) * FILE_CHUNK_BYTES, Number(t.size))), lastProgressAt: new Date(now) },
      });
    }
    if (seq > t.chunks) return { end: false, done: true };
    const c = await this.prisma.fileTransferChunk.findUnique({ where: { transferId_seq: { transferId: t.id, seq } }, select: { data: true, sha256: true } });
    if (!c) return { end: false, wait: true };
    return { end: false, seq, data: Buffer.from(c.data).toString('base64'), sha256: c.sha256 };
  }

  /**
   * A download's size and SHA-256, from the agent, before any chunk. A file
   * over the business's limit fails as `too_large`.
   */
  async begin(ep: { id: string; customerId: string | null }, body: { id: string; size: number; sha256: string }, now = Date.now()) {
    let t = await this.agentRow(ep, body.id, 'from_computer', now);
    if (!isLiveTransfer(t.state)) return { end: true, reason: t.endReason };
    if (t.size !== null) return { end: false };
    if (body.size > Number(t.maxBytes)) {
      await this.end(t, 'too_large', {}, {});
      return { end: true, reason: 'too_large' };
    }
    t = await this.moving(t, now);
    await this.prisma.fileTransfer.updateMany({
      where: { id: t.id, size: null, state: { in: LIVE } },
      data: { size: BigInt(body.size), sha256: body.sha256, chunks: chunksFor(body.size), lastProgressAt: new Date(now) },
    });
    return { end: false };
  }

  /**
   * A download's next chunk, from the agent. The rules:
   *   - Chunks come in order. A repeated chunk is accepted and ignored.
   *   - At most eight may wait for the browser. Otherwise the answer is
   *     `wait`.
   *   - Each chunk's SHA-256 is checked against the hash sent with it.
   */
  async push(ep: { id: string; customerId: string | null }, body: { id: string; seq: number; data: string; sha256: string }, now = Date.now()) {
    const t = await this.agentRow(ep, body.id, 'from_computer', now);
    if (!isLiveTransfer(t.state)) return { end: true, reason: t.endReason };
    if (t.size === null) throw new BadRequestException({ code: 'FILES_NOT_BEGUN', message: 'Declare the size and SHA-256 first.' });
    if (body.seq <= t.inSeq) return { end: false, duplicate: true };
    if (body.seq !== t.inSeq + 1) throw new BadRequestException({ code: 'FILES_CHUNK_ORDER', message: `Send chunk ${t.inSeq + 1} next.` });
    if (body.seq - t.ackSeq > FILE_WINDOW_CHUNKS) return { end: false, wait: true };
    const data = decodeChunk(body.data, body.sha256);
    if (!data || !chunkFits(body.seq, data.length, Number(t.size))) throw new BadRequestException({ code: 'FILES_CHUNK_INVALID', message: 'The chunk does not match its SHA-256 or the declared size.' });
    const ok = await this.prisma.$transaction(async (tx) => {
      const u = await tx.fileTransfer.updateMany({
        where: { id: t.id, state: { in: LIVE }, inSeq: t.inSeq },
        data: { inSeq: body.seq, bytesDone: { increment: BigInt(data.length) }, lastProgressAt: new Date(now) },
      });
      if (u.count === 0) return false;
      await tx.fileTransferChunk.create({ data: { transferId: t.id, seq: body.seq, data, sha256: body.sha256 } });
      return true;
    });
    if (!ok) throw new ConflictException({ code: 'FILES_BUSY', message: 'Chunks arrived out of order. Send it again.' });
    return { end: false };
  }

  /**
   * The agent's last word on a transfer: it worked, or why not (a closed
   * list). Completed needs everything to agree:
   *   - upload: the size and SHA-256 the agent wrote are the browser's;
   *   - download: every chunk arrived and the SHA-256 is still the one the
   *     agent declared.
   */
  async finish(ep: { id: string; customerId: string | null }, body: { id: string; ok: boolean; size?: number; sha256?: string; error?: string }, now = Date.now()) {
    const row = await this.prisma.fileTransfer.findFirst({ where: { id: body.id, endpointId: ep.id }, select: SELECT });
    if (!row) throw new NotFoundException('Transfer not found');
    const t = await this.settle(row, ep.customerId, now);
    if (!isLiveTransfer(t.state)) return { end: true, reason: t.endReason };
    if (!body.ok) {
      const code = (AGENT_FILE_ERRORS as readonly string[]).includes(body.error ?? '') ? (body.error as FileEndReason) : 'agent_error';
      await this.end(t, code);
      return { end: true, reason: code };
    }
    const sizeOk = t.size !== null && body.size === Number(t.size);
    const hashOk = !!t.sha256 && body.sha256 === t.sha256;
    const allIn = t.direction === 'to_computer' || t.inSeq === t.chunks;
    if (!sizeOk || !allIn) { await this.end(t, 'size_mismatch'); return { end: true, reason: 'size_mismatch' }; }
    if (!hashOk) { await this.end(t, 'hash_mismatch'); return { end: true, reason: 'hash_mismatch' }; }
    await this.end(t, 'completed', {}, { sha256: t.sha256! });
    return { end: true, reason: 'completed' };
  }
}
