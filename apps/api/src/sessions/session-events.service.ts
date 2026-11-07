import { Injectable, Logger } from '@nestjs/common';
import { createHash, randomBytes } from 'crypto';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import {
  applySessionEvent, OPEN_STATUSES, type SessionEventInput, type SessionSnapshot,
  type SessionStatusValue, type TransitionResult,
} from './session-state';

class StaleSnapshot extends Error {}

/**
 * Persists session state transitions decided by session-state.ts.
 *
 * Safety properties, each enforced here rather than hoped for:
 *   duplicate     the event row carries a dedupeKey under a unique index;
 *                 a second delivery fails the insert and changes nothing
 *   concurrent    the session update is conditional on the status and
 *                 statusChangedAt that were read; a lost race re-reads and
 *                 re-decides (bounded retries)
 *   out of order  decided by the state machine (rank + terminal lock); a
 *                 late event is still stored, with applied=false, so the
 *                 timeline shows it arrived
 *   cross-session the caller resolves the session from an authenticated
 *                 credential bound to it (telemetry token, launcher token,
 *                 device secret + endpoint) — never from a request body id
 */
@Injectable()
export class SessionEventsService {
  private readonly logger = new Logger(SessionEventsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async record(
    sessionId: string,
    input: SessionEventInput,
    opts: {
      dedupeKey?: string; metadata?: Record<string, unknown>; actorId?: string;
      /**
       * For requests a person makes (complete, cancel, report): a refused
       * transition writes NOTHING — no timeline row either — and the caller
       * answers 409. Machine signals leave this off on purpose, so a late or
       * out-of-order heartbeat is still visible on the timeline as not applied.
       */
      requireApplied?: boolean;
    } = {},
  ): Promise<TransitionResult & { duplicate?: boolean; status?: SessionStatusValue }> {
    for (let attempt = 0; attempt < 3; attempt++) {
      const s = await this.prisma.supportSession.findUnique({
        where: { id: sessionId },
        select: {
          id: true, tenantId: true, customerId: true, status: true, createdAt: true, statusChangedAt: true,
          launchRequestedAt: true, launcherAckAt: true, clientOpenedAt: true, connectionConfirmedAt: true,
          endedAt: true, statusSource: true, lastSignalAt: true, timingQuality: true,
        },
      });
      if (!s) return { applied: false, reason: 'session_closed', patch: {} };

      const snapshot: SessionSnapshot = { ...s, status: s.status as SessionStatusValue };
      const result = applySessionEvent(snapshot, input);
      if (opts.requireApplied && !result.applied) {
        return { ...result, status: snapshot.status };
      }

      try {
        await this.prisma.$transaction(async (tx) => {
          await tx.supportSessionEvent.create({
            data: {
              supportSessionId: s.id,
              event: input.type,
              source: input.source,
              occurredAt: input.occurredAt ?? input.receivedAt,
              dedupeKey: opts.dedupeKey ?? null,
              applied: result.applied,
              metadata: {
                ...(opts.metadata ?? {}),
                ...(result.applied ? {} : { notAppliedReason: result.reason }),
              } as Prisma.InputJsonValue,
            },
          });
          if (Object.keys(result.patch).length > 0) {
            const u = await tx.supportSession.updateMany({
              where: { id: s.id, status: s.status, statusChangedAt: s.statusChangedAt },
              data: result.patch as Prisma.SupportSessionUpdateManyMutationInput,
            });
            if (u.count === 0) throw new StaleSnapshot();
          }
        });
      } catch (e) {
        if (e instanceof StaleSnapshot) continue;
        // A conditional update that lost the race rolled the event row back
        // with it; re-read and re-decide (a terminal winner refuses this one).
        if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
          return { applied: false, reason: 'not_a_forward_step', patch: {}, duplicate: true, status: snapshot.status };
        }
        throw e;
      }

      if (result.applied) {
        await this.audit.log({
          tenantId: s.tenantId, customerId: s.customerId ?? undefined, actorId: opts.actorId,
          action: 'SESSION_STATE_CHANGED', resource: 'support_session', resourceId: s.id,
          meta: { from: s.status, to: result.patch.status, event: input.type, source: input.source },
        });
      }
      return { ...result, status: (result.patch.status as SessionStatusValue | undefined) ?? snapshot.status };
    }
    this.logger.warn(`Session ${sessionId}: gave up after concurrent updates for ${input.type}`);
    return { applied: false, reason: 'not_a_forward_step', patch: {} };
  }

  /** A fresh telemetry token for a session; only its hash is stored. */
  async issueTelemetryToken(sessionId: string): Promise<string> {
    const token = randomBytes(24).toString('hex');
    await this.prisma.supportSession.update({
      where: { id: sessionId },
      data: { telemetryTokenHash: createHash('sha256').update(token).digest('hex') },
    });
    return token;
  }

  /**
   * Telemetry from a Connect script, authenticated by the token embedded in
   * that script. The token names exactly one session; nothing in the body can
   * point it at another. Accepted for 12 hours after the session was created.
   */
  async recordScriptTelemetry(token: string, type: 'launcher_acknowledged' | 'client_opened' | 'client_launch_failed', detail?: string) {
    if (!/^[0-9a-f]{48}$/.test(token)) return { accepted: false };
    const s = await this.prisma.supportSession.findUnique({
      where: { telemetryTokenHash: createHash('sha256').update(token).digest('hex') },
      select: { id: true, createdAt: true },
    });
    if (!s || Date.now() - s.createdAt.getTime() > 12 * 3600_000) return { accepted: false };
    const r = await this.record(s.id, { type, source: 'connect_script', receivedAt: new Date() }, {
      // One of each per session: a re-run of the same script is a duplicate.
      dedupeKey: `script:${type}`,
      metadata: detail ? { detail: String(detail).replace(/[^\x20-\x7e]/g, '').slice(0, 200) } : undefined,
    });
    return { accepted: true, applied: r.applied, status: r.status };
  }

  /**
   * Reconcile the endpoint agent's report of incoming RustDesk sessions with
   * the open launches against that computer. Called only for a heartbeat that
   * authenticated with the device secret, so only the computer itself can
   * move its own sessions.
   *
   * The signal says that SOMEONE is connected, never who. Attribution is
   * therefore conservative: a connection is confirmed against a launch only
   * when exactly one recent unconfirmed launch exists for this computer.
   * Two candidates and it is recorded as observed but ambiguous on each, and
   * neither is confirmed.
   */
  async reconcileEndpointSignal(endpointId: string, activeCount: number, observedAt: Date) {
    const bucket = Math.floor(observedAt.getTime() / 60_000);
    const open = await this.prisma.supportSession.findMany({
      where: { endpointId, isAdHoc: false, status: { in: OPEN_STATUSES } },
      select: { id: true, status: true, launchRequestedAt: true, createdAt: true },
      orderBy: { createdAt: 'desc' },
      take: 20,
    });
    const confirmed = open.filter((s) => s.status === 'SESSION_STARTED');

    if (activeCount > 0) {
      for (const s of confirmed) {
        await this.prisma.supportSession.updateMany({
          where: { id: s.id, status: 'SESSION_STARTED' }, data: { lastSignalAt: observedAt },
        });
      }
      // Each running connection-manager process beyond those already
      // attributed is one unexplained connection.
      const unexplained = activeCount - confirmed.length;
      if (unexplained <= 0) return;
      const recentCutoff = observedAt.getTime() - 30 * 60_000;
      const candidates = open.filter((s) => s.status !== 'SESSION_STARTED' &&
        (s.launchRequestedAt ?? s.createdAt).getTime() >= recentCutoff);
      if (candidates.length === 1) {
        await this.record(candidates[0].id, { type: 'connection_confirmed', source: 'endpoint_agent', occurredAt: observedAt, receivedAt: new Date() }, {
          dedupeKey: `agent:confirm`,
          metadata: { attribution: 'only_recent_launch_for_this_computer', activeCount, precision: 'heartbeat interval (about 3 minutes)' },
        });
      } else if (candidates.length > 1) {
        for (const c of candidates) {
          await this.prisma.supportSessionEvent.create({
            data: {
              supportSessionId: c.id, event: 'connection_observed_ambiguous', source: 'endpoint_agent',
              occurredAt: observedAt, applied: false, dedupeKey: `agent:ambiguous:${bucket}`,
              metadata: { activeCount, candidates: candidates.length },
            },
          }).catch(() => { /* duplicate in this minute */ });
        }
      }
      return;
    }

    // Nothing connected now: every confirmed session on this computer ended
    // at or before this observation.
    for (const s of confirmed) {
      await this.record(s.id, { type: 'disconnected', source: 'endpoint_agent', occurredAt: observedAt, receivedAt: new Date() }, {
        dedupeKey: 'agent:disconnect',
        metadata: { precision: 'heartbeat interval (about 3 minutes)' },
      });
    }
  }
}
