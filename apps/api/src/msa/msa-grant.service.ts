import { ConflictException, ForbiddenException, Injectable, Logger, NotFoundException, OnModuleDestroy, ServiceUnavailableException, BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { z } from 'zod';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { AccessControlService, type ActorContext } from '../rbac/access-control.service';
import { EnrollmentService } from '../enrollment/enrollment.service';
import { activePause } from '../containment/pause';
import { runsSignedAgent } from '../common/agent-identity';
import { isWindowsPlatform } from '../common/platform';
import { assertAssigned } from '../common/unassigned';
import { openSecret, sealSecret } from '../common/secret-box';
import {
  CONSENTS, ENTITY_ID_RE, GRANT_ID_RE, GRANT_VERSION, IDLE_MINUTES_MAX, IDLE_MINUTES_MIN, MAX_MINUTES_MAX, MAX_MINUTES_MIN,
  MAX_START_WINDOW_MS, MODES, RUSTDESK_ID_RE, isoSeconds, newGrantId, newGrantKey, newGrantPassword, signGrant,
  type Envelope, type Grant,
} from './grant';
import { msaGrantsEnabled, MSA_NOT_ENABLED } from './msa-grants-flag';
import { CONNECT_APPLY_TIMEOUT_MS, LIVE_GRANT_STATES, VERIFY_GRANT_MINUTES, withinCeiling, type GrantSource, type ManagedState, type RevokeReason } from './managed';
import { REVOCATION_MAX_GRANTS, REVOCATION_WINDOW_MS, signRevocation, type RevocationEnvelope } from './revocation';
import type { GrantTerms, ManagedLaunchMode } from './connect-terms';
import { UpdateTrustService } from '../update-trust/update-trust.service';
import { MSA_GRANT_KEY_ADD_COMMAND, MSA_GRANT_KEY_PUBLISH_COMMAND } from './grant-key-commands';

/** How long a poll is held when nothing is waiting. Under the 30 s most proxies allow. */
export const POLL_HOLD_MS_DEFAULT = 25_000;
/** A held poll looks at the database this often too: another API process may have issued the grant. */
export const POLL_RECHECK_MS = 5_000;
/** Held polls in this process, at most. Beyond it a poll returns at once with retryAfterMs. */
export const POLL_MAX_DEFAULT = 500;
/** At most this many grants in one answer, and this many ids in one ack. */
export const POLL_MAX_GRANTS = 5;
export const ACK_MAX = 20;
/** The read route's page. */
export const LIST_MAX = 50;

const clampInt = (raw: string | undefined, dflt: number, min: number, max: number) => {
  const n = Number(raw);
  return Number.isInteger(n) && n >= min && n <= max ? n : dflt;
};

/** The test route's body: everything optional, strict, defaulting to the least a grant can allow. */
const TestBody = z.strictObject({
  mode: z.enum(MODES).optional(),
  permissions: z.strictObject({
    clipboard: z.boolean().optional(), files: z.boolean().optional(), audio: z.boolean().optional(),
    tunnel: z.boolean().optional(), restart: z.boolean().optional(),
  }).optional(),
  consent: z.enum(CONSENTS).optional(),
  maxMinutes: z.number().int().min(MAX_MINUTES_MIN).max(MAX_MINUTES_MAX).optional(),
  idleMinutes: z.number().int().min(IDLE_MINUTES_MIN).max(IDLE_MINUTES_MAX).optional(),
});

type Waiter = { wake: (why: 'grant' | 'superseded' | 'shutdown') => void };

/**
 * Managed Secure Access grants (0.71, build step 3), behind MSA_GRANTS.
 *
 * The only writer of MsaGrantKey and MsaGrant, and the only user of the three
 * rem0te-msa-grant-* secret-box purposes (§81). Every public method asserts
 * the flag first, so even a caller that bypassed the controllers' gate gets
 * MSA_NOT_ENABLED before anything is read.
 *
 * A grant is issued by `issueTest` (the Platform Admin test route, 0.71),
 * `issueForConnect` (MsaSessionService.connect, after the launch policy,
 * 0.73) and `issueVerification` (a cutover run's verification grant, 0.73);
 * every one is signed, audited first and stored here. 0.73 adds the signed
 * revocations (MsaRevocation), also written only here.
 */
@Injectable()
export class MsaGrantService implements OnModuleDestroy {
  private readonly logger = new Logger('MsaGrants');
  private readonly encKey: string | undefined;
  private readonly holdMs = clampInt(process.env.MSA_POLL_HOLD_MS, POLL_HOLD_MS_DEFAULT, 1_000, POLL_HOLD_MS_DEFAULT);
  private readonly maxPolls = clampInt(process.env.MSA_POLL_MAX, POLL_MAX_DEFAULT, 1, 5_000);
  /** One held poll per computer; a newer poll from the same computer ends the older one. */
  private readonly waiters = new Map<string, Waiter>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly acl: AccessControlService,
    private readonly enrollment: EnrollmentService,
    private readonly updateTrust: UpdateTrustService,
    config: ConfigService,
  ) {
    this.encKey = config.get<string>('ENCRYPTION_KEY');
  }

  onModuleDestroy() {
    for (const w of [...this.waiters.values()]) w.wake('shutdown');
  }

  get heldPolls(): number { return this.waiters.size; }

  private assertEnabled() {
    if (!msaGrantsEnabled()) throw new NotFoundException({ code: MSA_NOT_ENABLED, message: 'Managed Secure Access grants are not enabled on this server.' });
  }

  // ── The grant key ─────────────────────────────────────────────────────────

  /**
   * The active key, generated on first use. Two first issuances racing both
   * try to insert; the partial unique index lets one win, and the other reads
   * the winner. The private key is sealed before it is stored and is opened
   * only here, immediately before signing.
   */
  private async activeKey(actor: ActorContext): Promise<{ keyId: string; privatePem: string }> {
    const open = (row: { keyId: string; privateKeyEnc: string }) => {
      try {
        return { keyId: row.keyId, privatePem: openSecret(this.encKey, 'rem0te-msa-grant-key-v1', row.privateKeyEnc) };
      } catch {
        throw new ServiceUnavailableException({ code: 'MSA_GRANT_KEY_UNAVAILABLE', message: 'The grant key could not be opened (ENCRYPTION_KEY changed?). No grant was issued.' });
      }
    };
    const existing = await this.prisma.msaGrantKey.findFirst({ where: { retiredAt: null }, select: { keyId: true, privateKeyEnc: true } });
    if (existing) return open(existing);
    const k = newGrantKey();
    let privateKeyEnc: string;
    try {
      privateKeyEnc = sealSecret(this.encKey, 'rem0te-msa-grant-key-v1', k.privatePem);
    } catch {
      throw new ServiceUnavailableException({ code: 'MSA_GRANT_KEY_UNAVAILABLE', message: 'ENCRYPTION_KEY is not set: no grant key can be made.' });
    }
    try {
      await this.prisma.msaGrantKey.create({ data: { keyId: k.keyId, publicKey: k.publicKey, privateKeyEnc } });
    } catch {
      const winner = await this.prisma.msaGrantKey.findFirst({ where: { retiredAt: null }, select: { keyId: true, privateKeyEnc: true } });
      if (!winner) throw new ServiceUnavailableException({ code: 'MSA_GRANT_KEY_UNAVAILABLE', message: 'The grant key could not be created. Try again.' });
      return open(winner);
    }
    await this.audit.log({
      action: 'MSA_GRANT_KEY_CREATED', actorId: actor.userId, actorIp: actor.ip,
      resource: 'msa_grant_key', resourceId: k.keyId, meta: { keyId: k.keyId },
    });
    this.logger.log(`Generated the MSA grant key ${k.keyId}`);
    return { keyId: k.keyId, privatePem: k.privatePem };
  }

  /**
   * Public keys only, and whether each is in the signed release metadata
   * the agents verify (msa/grant-keys.json, read as served — the agent
   * verifies it itself). For a key not yet published, the two commands the
   * owner runs on the release host (§56: text the portal shows, never runs).
   * Platform Admin.
   */
  async publicKeys() {
    this.assertEnabled();
    const rows = await this.prisma.msaGrantKey.findMany({ orderBy: { createdAt: 'desc' }, select: { keyId: true, publicKey: true, createdAt: true, retiredAt: true } });
    const published = new Set(this.updateTrust.publishedMsaGrantKeyIds());
    return rows.map((r) => ({
      keyId: r.keyId, algorithm: 'ed25519', publicKey: r.publicKey, createdAt: r.createdAt, retiredAt: r.retiredAt, active: r.retiredAt === null,
      published: published.has(r.keyId),
      commands: r.retiredAt === null && !published.has(r.keyId)
        ? [`${MSA_GRANT_KEY_ADD_COMMAND} --key-id ${r.keyId} --public-key ${r.publicKey}`, MSA_GRANT_KEY_PUBLISH_COMMAND]
        : [],
    }));
  }

  /**
   * 0.72: make the grant key now (Platform Admin, a fresh confirmation,
   * msa.grant), so it can be published before any computer is cut over.
   * Returns the active key's public half; an existing key is returned as is.
   */
  async ensureKey(actor: ActorContext) {
    this.assertEnabled();
    const k = await this.activeKey(actor);
    await this.audit.log({
      action: 'MSA_GRANT_KEY_ENSURED', actorId: actor.userId, actorIp: actor.ip, resource: 'msa_grant_key', resourceId: k.keyId, meta: { keyId: k.keyId },
    });
    return (await this.publicKeys()).find((x) => x.keyId === k.keyId);
  }

  /** 0.72: the active key id, when it is in the published signed metadata; else null. */
  async activePublishedKeyId(): Promise<string | null> {
    this.assertEnabled();
    const row = await this.prisma.msaGrantKey.findFirst({ where: { retiredAt: null }, select: { keyId: true } });
    return row && this.updateTrust.publishedMsaGrantKeyIds().includes(row.keyId) ? row.keyId : null;
  }

  // ── Issuing ───────────────────────────────────────────────────────────────

  /**
   * The Platform Admin test route's issuance (0.71). The caller (the
   * controller) has already required a Platform Admin and a fresh
   * confirmation (msa.grant). Refused, in order: a computer the actor cannot
   * see (404), a pooled computer (ENDPOINT_UNASSIGNED), not Windows or not
   * the signed agent (MSA_SIGNED_AGENT_REQUIRED), no RustDesk ID or device
   * secret on record (MSA_GRANT_NO_DEVICE), a `remote` containment pause
   * (CONTAINED). The audit row is written (logOrFail) before the grant row
   * exists, so a grant can never be delivered without its record.
   */
  async issueTest(actor: ActorContext, endpointId: string, raw: unknown, now = Date.now()) {
    this.assertEnabled();
    if (!ENTITY_ID_RE.test(endpointId)) throw new NotFoundException('Computer not found');
    const body = TestBody.safeParse(raw ?? {});
    if (!body.success) throw new BadRequestException({ code: 'MSA_GRANT_INVALID', message: 'The grant request is not valid.' });
    const b = body.data;
    const maxMinutes = b.maxMinutes ?? 60;
    const idleMinutes = b.idleMinutes ?? Math.min(15, maxMinutes);
    if (idleMinutes > maxMinutes) throw new BadRequestException({ code: 'MSA_GRANT_INVALID', message: 'The idle limit cannot exceed the session limit.' });

    await this.acl.assertEndpointInScope(actor, endpointId, 'computers:view');
    const ep = await this.prisma.endpoint.findFirst({
      where: { AND: [{ id: endpointId }, this.acl.endpointVisibilityWhere(actor)] },
      select: {
        id: true, tenantId: true, customerId: true, platform: true, updateChannel: true, signedSeenAt: true,
        rustdeskNode: { select: { rustdeskId: true, agentSecretHash: true } },
      },
    });
    if (!ep) throw new NotFoundException('Computer not found');
    assertAssigned(ep);
    if (!isWindowsPlatform(ep.platform) || !runsSignedAgent({ updateChannel: ep.updateChannel, signedSeenAt: ep.signedSeenAt }, new Date(now))) {
      throw new ConflictException({ code: 'MSA_SIGNED_AGENT_REQUIRED', message: 'Managed Secure Access needs a Windows computer running the signed agent.' });
    }
    const rid = ep.rustdeskNode?.rustdeskId ?? '';
    if (!RUSTDESK_ID_RE.test(rid) || !ep.rustdeskNode?.agentSecretHash) {
      throw new ConflictException({ code: 'MSA_GRANT_NO_DEVICE', message: 'This computer has no RustDesk ID or device secret on record.' });
    }
    const pause = await activePause(this.prisma, 'remote', ep.customerId);
    if (pause) throw new ForbiddenException({ code: 'CONTAINED', message: 'Remote connections are paused for this computer: no grant was issued.', pauseId: pause.id, scope: pause.scope.toLowerCase() });

    // 0.72: a managed computer's agent ACTS on a grant. It may not exceed the
    // managed ceiling (view-only, nothing beyond), not while it rolls back,
    // and not under a key the agents cannot verify.
    const managed = await this.prisma.msaManagedComputer.findUnique({ where: { endpointId: ep.id }, select: { state: true } });
    if (managed) {
      if ((managed.state as ManagedState) === 'rollback_pending') throw new ConflictException({ code: 'MSA_ROLLBACK_PENDING', message: 'This computer is rolling back to Legacy: no grant was issued.' });
      const perms = {
        clipboard: b.permissions?.clipboard ?? false, files: b.permissions?.files ?? false, audio: b.permissions?.audio ?? false,
        tunnel: b.permissions?.tunnel ?? false, restart: b.permissions?.restart ?? false,
      };
      if (!withinCeiling(b.mode ?? 'view', perms)) throw new ConflictException({ code: 'MSA_ABOVE_CEILING', message: 'A managed computer allows control with clipboard, file transfer and audio, never a tunnel or a remote restart: no grant was issued.' });
      if (!(await this.activePublishedKeyId())) throw new ConflictException({ code: 'MSA_GRANT_KEY_NOT_PUBLISHED', message: 'The grant key is not in the signed release metadata yet, so the agent would refuse the grant: no grant was issued.' });
    }

    const key = await this.activeKey(actor);
    const nb = Math.floor(now / 1000) * 1000;
    const grant: Grant = {
      v: GRANT_VERSION, grantId: newGrantId(), endpointId: ep.id, rustdeskId: rid, businessId: ep.customerId!, technicianId: actor.userId,
      mode: b.mode ?? 'view',
      permissions: {
        clipboard: b.permissions?.clipboard ?? false, files: b.permissions?.files ?? false, audio: b.permissions?.audio ?? false,
        tunnel: b.permissions?.tunnel ?? false, restart: b.permissions?.restart ?? false,
      },
      consent: b.consent ?? 'required',
      notBefore: isoSeconds(nb), notAfter: isoSeconds(nb + MAX_START_WINDOW_MS),
      maxMinutes, idleMinutes, password: newGrantPassword(),
    };
    if (!ENTITY_ID_RE.test(grant.technicianId) || !ENTITY_ID_RE.test(grant.businessId)) throw new BadRequestException({ code: 'MSA_GRANT_INVALID', message: 'The grant request is not valid.' });
    const envelope = signGrant(grant, key.privatePem, key.keyId);

    // The record first: if it cannot be written, nothing is issued.
    await this.audit.logOrFail({
      action: 'MSA_GRANT_ISSUED', actorId: actor.userId, actorIp: actor.ip, tenantId: ep.tenantId ?? undefined, customerId: ep.customerId ?? undefined,
      resource: 'endpoint', resourceId: ep.id,
      meta: { grantId: grant.grantId, endpointId: ep.id, mode: grant.mode, consent: grant.consent, keyId: key.keyId, source: 'test', managed: !!managed },
    });
    await this.prisma.$transaction([
      // A newer grant replaces any earlier one not yet delivered to this computer.
      this.prisma.msaGrant.updateMany({ where: { endpointId: ep.id, state: 'issued' }, data: { state: 'cancelled' } }),
      this.prisma.msaGrant.create({
        data: {
          id: grant.grantId, endpointId: ep.id, businessId: grant.businessId, technicianId: grant.technicianId, keyId: key.keyId,
          mode: grant.mode, permissions: grant.permissions, consent: grant.consent,
          notBefore: new Date(grant.notBefore), notAfter: new Date(grant.notAfter), maxMinutes, idleMinutes, state: 'issued',
          envelopeEnc: sealSecret(this.encKey, 'rem0te-msa-grant-envelope-v1', JSON.stringify(envelope)),
          passwordEnc: sealSecret(this.encKey, 'rem0te-msa-grant-pw-v1', grant.password),
        },
      }),
    ]);
    this.waiters.get(ep.id)?.wake('grant');
    return {
      grantId: grant.grantId, endpointId: ep.id, keyId: key.keyId, mode: grant.mode, permissions: grant.permissions, consent: grant.consent,
      notBefore: grant.notBefore, notAfter: grant.notAfter, maxMinutes, idleMinutes, state: 'issued',
    };
  }

  // ── Reading ───────────────────────────────────────────────────────────────

  /** Grants whose start window passed while still undelivered become `expired` (conditional, so a delivery racing it wins or loses cleanly). */
  private expireDue(endpointId: string, now: number) {
    return this.prisma.msaGrant.updateMany({ where: { endpointId, state: 'issued', notAfter: { lt: new Date(now) } }, data: { state: 'expired' } });
  }

  /** A computer's recent grants: never the envelope or the password. computers:view, in scope. */
  async listForEndpoint(actor: ActorContext, endpointId: string, now = Date.now()) {
    this.assertEnabled();
    if (!ENTITY_ID_RE.test(endpointId)) throw new NotFoundException('Computer not found');
    await this.acl.assertEndpointInScope(actor, endpointId, 'computers:view');
    const ep = await this.prisma.endpoint.findFirst({ where: { AND: [{ id: endpointId }, this.acl.endpointVisibilityWhere(actor)] }, select: { id: true } });
    if (!ep) throw new NotFoundException('Computer not found');
    await this.expireDue(ep.id, now);
    const rows = await this.prisma.msaGrant.findMany({
      where: { endpointId: ep.id }, orderBy: [{ createdAt: 'desc' }, { id: 'asc' }], take: LIST_MAX,
      select: {
        id: true, endpointId: true, technicianId: true, keyId: true, mode: true, permissions: true, consent: true,
        notBefore: true, notAfter: true, maxMinutes: true, idleMinutes: true, state: true, deliveredAt: true, createdAt: true,
        appliedAt: true, connectedAt: true, endedAt: true, outcome: true, failedKeys: true, revealedAt: true,
        source: true, launchMode: true, receivedAt: true, launchedAt: true, revokedAt: true, revokedById: true, revokeReason: true,
      },
    });
    return rows.map(({ id, ...r }) => ({ grantId: id, ...r }));
  }

  // ── The device long-poll ──────────────────────────────────────────────────

  /**
   * One poll from a computer's signed agent. The device secret is checked
   * (EnrollmentService.authenticateDevice) before anything else is read;
   * then only a Windows computer whose identity is the signed agent, and
   * assigned to a business, may poll. An ack marks those of its own grants
   * still `issued` and inside their window `delivered` (conditional, so a
   * repeated ack changes nothing). Grants are withheld while a `remote`
   * pause is in force. With nothing to hand over, the poll is held until a
   * grant is issued for this computer, a newer poll from it arrives, or the
   * hold runs out.
   */
  async poll(dto: { rustdeskId: string; agentSecret: string; ack?: string[]; wait?: boolean }) {
    this.assertEnabled();
    const dev = await this.enrollment.authenticateDevice(dto.rustdeskId, dto.agentSecret, 'msa_poll_unauthenticated');
    const ep = await this.prisma.endpoint.findUnique({
      where: { id: dev.endpointId },
      select: { id: true, tenantId: true, customerId: true, platform: true, updateChannel: true, signedSeenAt: true },
    });
    if (!ep) throw new NotFoundException('This device is not attached to a computer');
    if (!isWindowsPlatform(ep.platform) || !runsSignedAgent({ updateChannel: ep.updateChannel, signedSeenAt: ep.signedSeenAt })) {
      throw new ForbiddenException({ code: 'MSA_SIGNED_AGENT_REQUIRED', message: 'Only the signed Windows agent may poll for grants.' });
    }
    assertAssigned(ep);

    const now = Date.now();
    const ackIds = [...new Set((dto.ack ?? []).filter((x) => GRANT_ID_RE.test(x)))].slice(0, ACK_MAX);
    const acked = ackIds.length
      ? (await this.prisma.msaGrant.updateMany({
          where: { id: { in: ackIds }, endpointId: ep.id, state: 'issued', notAfter: { gte: new Date(now) } },
          data: { state: 'delivered', deliveredAt: new Date(now) },
        })).count
        // 0.73: the same ack carries revocation ids (32 hex too).
        + (await this.prisma.msaRevocation.updateMany({
          where: { id: { in: ackIds }, endpointId: ep.id, state: 'issued' },
          data: { state: 'delivered', deliveredAt: new Date(now) },
        })).count
      : 0;
    // 0.73: Connect refuses a computer whose agent is not polling. The one
    // MsaManagedComputer field this service writes (§82, §83).
    await this.prisma.msaManagedComputer.updateMany({ where: { endpointId: ep.id }, data: { lastPollAt: new Date(now) } });

    // 0.72: the computer's managed state rides on every answer. The agent
    // runs only while it has one, and rolls back when it says so.
    const managedNow = async () => {
      const m = await this.prisma.msaManagedComputer.findUnique({ where: { endpointId: ep.id }, select: { state: true } });
      return m ? { state: m.state as ManagedState, rollback: m.state === 'rollback_pending' } : null;
    };
    const answer = async () => {
      const t = Date.now();
      await this.expireDue(ep.id, t);
      await this.timeoutDue(ep.id, t);
      if (await activePause(this.prisma, 'remote', ep.customerId)) {
        // 0.73: a `remote` pause ends every session on the computer, not
        // just new ones: a signed revocation of every grant that reached it.
        // Undelivered grants stay withheld, as before (0.71).
        await this.revoke(null, ep.id, { all: true, reason: 'pause', states: ['delivered', 'applied'] }, t);
        return { grants: [] as Envelope[], paused: true, revocations: await this.revocationsFor(ep.id, t) };
      }
      // Nothing is handed to a computer that is rolling back.
      if ((await managedNow())?.rollback) return { grants: [] as Envelope[], paused: false, revocations: await this.revocationsFor(ep.id, t) };
      const rows = await this.prisma.msaGrant.findMany({
        where: { endpointId: ep.id, state: 'issued', notAfter: { gte: new Date(t) } },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], take: POLL_MAX_GRANTS, select: { id: true, envelopeEnc: true },
      });
      const grants: Envelope[] = [];
      for (const r of rows) {
        try {
          grants.push(JSON.parse(openSecret(this.encKey, 'rem0te-msa-grant-envelope-v1', r.envelopeEnc)) as Envelope);
        } catch {
          this.logger.warn(`Grant ${r.id} could not be opened; not delivered`);
        }
      }
      return { grants, paused: false, revocations: await this.revocationsFor(ep.id, t) };
    };

    let out = await answer();
    const managed = await managedNow();
    // A computer rolling back is answered at once.
    if (out.grants.length || out.revocations.length || out.paused || dto.wait === false || managed?.rollback) return { ...out, acked, holdMs: 0, endpointId: ep.id, managed };

    if (!this.waiters.has(ep.id) && this.waiters.size >= this.maxPolls) return { ...out, acked, holdMs: 0, retryAfterMs: 5_000, endpointId: ep.id, managed };
    this.waiters.get(ep.id)?.wake('superseded');
    const started = Date.now();
    const why = await new Promise<'grant' | 'superseded' | 'shutdown' | 'timeout'>((resolve) => {
      let done = false;
      const finish = (w: 'grant' | 'superseded' | 'shutdown' | 'timeout') => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        clearInterval(recheck);
        if (this.waiters.get(ep.id) === me) this.waiters.delete(ep.id);
        resolve(w);
      };
      const me: Waiter = { wake: finish };
      const timer = setTimeout(() => finish('timeout'), this.holdMs);
      const recheck = setInterval(() => {
        void Promise.all([
          this.prisma.msaGrant.count({ where: { endpointId: ep.id, state: 'issued', notAfter: { gte: new Date() } } }),
          this.prisma.msaRevocation.count({ where: { endpointId: ep.id, state: 'issued', notAfter: { gte: new Date() } } }),
          activePause(this.prisma, 'remote', ep.customerId).then((p) => (p ? 1 : 0)),
        ])
          .then(([n, r, paused]) => { if (n > 0 || r > 0 || paused > 0) finish('grant'); })
          .catch(() => { /* the hold just runs out */ });
      }, POLL_RECHECK_MS);
      this.waiters.set(ep.id, me);
    });
    // A superseded poll hands nothing over: grants go only to the newest poll.
    if (why === 'superseded') return { grants: [], revocations: [], paused: false, acked, holdMs: Date.now() - started, superseded: true, endpointId: ep.id, managed: await managedNow() };
    out = await answer();
    return { ...out, acked, holdMs: Date.now() - started, endpointId: ep.id, managed: await managedNow() };
  }

  /** 0.72: wake a held poll for this computer (its managed state changed: confirmed, rolled back). */
  wake(endpointId: string) {
    this.waiters.get(endpointId)?.wake('grant');
  }

  /**
   * 0.72: the managed test session's one-time password, shown ONCE to the
   * Platform Admin (a fresh confirmation, msa.reveal, in the controller).
   * Only for a grant the agent reported applied, not ended, on a computer
   * this person can see. The reveal is audited first (logOrFail, ids only),
   * then claimed by one conditional write, and only then is the password
   * opened. It is never shown again.
   */
  async reveal(actor: ActorContext, grantId: string) {
    this.assertEnabled();
    if (!GRANT_ID_RE.test(grantId)) throw new NotFoundException('Grant not found');
    const g = await this.prisma.msaGrant.findUnique({ where: { id: grantId }, select: { id: true, endpointId: true, state: true, revealedAt: true } });
    if (!g) throw new NotFoundException('Grant not found');
    await this.acl.assertEndpointInScope(actor, g.endpointId, 'computers:view');
    const ep = await this.prisma.endpoint.findFirst({ where: { AND: [{ id: g.endpointId }, this.acl.endpointVisibilityWhere(actor)] }, select: { id: true, tenantId: true, customerId: true } });
    if (!ep) throw new NotFoundException('Grant not found');
    if (g.state !== 'applied') throw new ConflictException({ code: 'MSA_GRANT_NOT_APPLIED', message: 'The agent has not reported this grant applied (or its session ended): there is no password to show.' });
    if (g.revealedAt) throw new ConflictException({ code: 'MSA_PASSWORD_ALREADY_REVEALED', message: 'This one-time password was already shown once. Send a new test grant.' });
    await this.audit.logOrFail({
      action: 'MSA_PASSWORD_REVEALED', actorId: actor.userId, actorIp: actor.ip, tenantId: ep.tenantId ?? undefined, customerId: ep.customerId ?? undefined,
      resource: 'endpoint', resourceId: ep.id, meta: { grantId: g.id, endpointId: ep.id },
    });
    const claimed = await this.prisma.msaGrant.updateMany({
      where: { id: g.id, state: 'applied', revealedAt: null }, data: { revealedAt: new Date(), revealedById: actor.userId },
    });
    if (claimed.count !== 1) throw new ConflictException({ code: 'MSA_PASSWORD_ALREADY_REVEALED', message: 'This one-time password was already shown once. Send a new test grant.' });
    const row = await this.prisma.msaGrant.findUnique({ where: { id: g.id }, select: { passwordEnc: true } });
    try {
      return { grantId: g.id, oneTimePassword: openSecret(this.encKey, 'rem0te-msa-grant-pw-v1', row!.passwordEnc), shownOnce: true };
    } catch {
      throw new ServiceUnavailableException({ code: 'MSA_GRANT_KEY_UNAVAILABLE', message: 'The password could not be opened (ENCRYPTION_KEY changed?).' });
    }
  }

  // ── 0.73: Connect, verification grants, the password release ─────────────

  /**
   * The shared front of a managed issuance: a computer this person can see,
   * assigned, the signed Windows agent, a RustDesk ID and device secret on
   * record, no `remote` pause, a managed row in the state the caller needs,
   * and a published grant key.
   */
  private async managedComputer(actor: ActorContext, endpointId: string, want: ManagedState, now: number) {
    if (!ENTITY_ID_RE.test(endpointId)) throw new NotFoundException('Computer not found');
    await this.acl.assertEndpointInScope(actor, endpointId, 'computers:view');
    const ep = await this.prisma.endpoint.findFirst({
      where: { AND: [{ id: endpointId }, this.acl.endpointVisibilityWhere(actor)] },
      select: {
        id: true, tenantId: true, customerId: true, platform: true, updateChannel: true, signedSeenAt: true,
        rustdeskNode: { select: { rustdeskId: true, agentSecretHash: true } },
      },
    });
    if (!ep) throw new NotFoundException('Computer not found');
    assertAssigned(ep);
    if (!isWindowsPlatform(ep.platform) || !runsSignedAgent({ updateChannel: ep.updateChannel, signedSeenAt: ep.signedSeenAt }, new Date(now))) {
      throw new ConflictException({ code: 'MSA_SIGNED_AGENT_REQUIRED', message: 'Managed Secure Access needs a Windows computer running the signed agent.' });
    }
    const rid = ep.rustdeskNode?.rustdeskId ?? '';
    if (!RUSTDESK_ID_RE.test(rid) || !ep.rustdeskNode?.agentSecretHash) {
      throw new ConflictException({ code: 'MSA_GRANT_NO_DEVICE', message: 'This computer has no RustDesk ID or device secret on record.' });
    }
    const pause = await activePause(this.prisma, 'remote', ep.customerId);
    if (pause) throw new ForbiddenException({ code: 'CONTAINED', message: 'Remote connections are paused for this computer: no grant was issued.', pauseId: pause.id, scope: pause.scope.toLowerCase() });
    const managed = await this.prisma.msaManagedComputer.findUnique({ where: { endpointId: ep.id }, select: { state: true } });
    if (!managed) throw new ConflictException({ code: 'MSA_NOT_MANAGED', message: 'This computer is in Legacy mode.' });
    if (managed.state !== want) {
      const code = managed.state === 'rollback_pending' ? 'MSA_ROLLBACK_PENDING' : managed.state === 'enforcement_failure' ? 'MSA_ENFORCEMENT_FAILURE' : want === 'verified' ? 'MSA_NOT_VERIFIED' : 'MSA_NOT_PENDING';
      throw new ConflictException({ code, message: `This computer is Managed (${managed.state.replace('_', ' ')}): no grant was issued.` });
    }
    if (!(await this.activePublishedKeyId())) throw new ConflictException({ code: 'MSA_GRANT_KEY_NOT_PUBLISHED', message: 'The grant key is not in the signed release metadata yet, so the agent would refuse the grant: no grant was issued.' });
    return { ep, rid };
  }

  /** Sign, audit (first), store. The terms were decided by the caller's rule, never by a request body. */
  private async signAndStore(
    actor: ActorContext, ep: { id: string; tenantId: string | null; customerId: string | null }, rid: string,
    terms: GrantTerms, source: GrantSource, launchMode: ManagedLaunchMode | null, now: number,
  ) {
    if (!withinCeiling(terms.mode, terms.permissions)) throw new ConflictException({ code: 'MSA_ABOVE_CEILING', message: 'The grant would exceed the managed ceiling: no grant was issued.' });
    const key = await this.activeKey(actor);
    const nb = Math.floor(now / 1000) * 1000;
    const grant: Grant = {
      v: GRANT_VERSION, grantId: newGrantId(), endpointId: ep.id, rustdeskId: rid, businessId: ep.customerId!, technicianId: actor.userId,
      mode: terms.mode, permissions: { ...terms.permissions }, consent: terms.consent,
      notBefore: isoSeconds(nb), notAfter: isoSeconds(nb + MAX_START_WINDOW_MS),
      maxMinutes: terms.maxMinutes, idleMinutes: terms.idleMinutes, password: newGrantPassword(),
    };
    if (!ENTITY_ID_RE.test(grant.technicianId) || !ENTITY_ID_RE.test(grant.businessId)) throw new BadRequestException({ code: 'MSA_GRANT_INVALID', message: 'The grant request is not valid.' });
    const envelope = signGrant(grant, key.privatePem, key.keyId);
    await this.audit.logOrFail({
      action: 'MSA_GRANT_ISSUED', actorId: actor.userId, actorIp: actor.ip, tenantId: ep.tenantId ?? undefined, customerId: ep.customerId ?? undefined,
      resource: 'endpoint', resourceId: ep.id,
      meta: { grantId: grant.grantId, endpointId: ep.id, mode: grant.mode, consent: grant.consent, keyId: key.keyId, source, managed: true, launchMode, permissions: grant.permissions, maxMinutes: grant.maxMinutes },
    });
    await this.prisma.$transaction([
      this.prisma.msaGrant.updateMany({ where: { endpointId: ep.id, state: 'issued' }, data: { state: 'cancelled' } }),
      this.prisma.msaGrant.create({
        data: {
          id: grant.grantId, endpointId: ep.id, businessId: grant.businessId, technicianId: grant.technicianId, keyId: key.keyId,
          mode: grant.mode, permissions: grant.permissions, consent: grant.consent,
          notBefore: new Date(grant.notBefore), notAfter: new Date(grant.notAfter), maxMinutes: grant.maxMinutes, idleMinutes: grant.idleMinutes,
          state: 'issued', source, launchMode,
          envelopeEnc: sealSecret(this.encKey, 'rem0te-msa-grant-envelope-v1', JSON.stringify(envelope)),
          passwordEnc: sealSecret(this.encKey, 'rem0te-msa-grant-pw-v1', grant.password),
        },
      }),
    ]);
    this.waiters.get(ep.id)?.wake('grant');
    return {
      grantId: grant.grantId, endpointId: ep.id, keyId: key.keyId, mode: grant.mode, permissions: grant.permissions, consent: grant.consent,
      notBefore: grant.notBefore, notAfter: grant.notAfter, maxMinutes: grant.maxMinutes, idleMinutes: grant.idleMinutes, state: 'issued',
    };
  }

  /**
   * Connect's issuance (MsaSessionService.connect is the only caller). It has
   * already run authorizeConnect({ managed: true }) — role, preset, view-only
   * and consent, schedules, containment, the pool, the fleet limits — and
   * turned that decision into `terms` (connect-terms.ts). This checks the
   * computer again (verified managed, the signed agent, no pause, a
   * published key) and the ceiling, then signs.
   */
  async issueForConnect(actor: ActorContext, endpointId: string, launchMode: ManagedLaunchMode, terms: GrantTerms, now = Date.now()) {
    this.assertEnabled();
    const { ep, rid } = await this.managedComputer(actor, endpointId, 'verified', now);
    return this.signAndStore(actor, ep, rid, terms, 'connect', launchMode, now);
  }

  /**
   * A cutover run's verification grant for a computer it just moved to
   * Managed (pending): view-only, consent required, five minutes. The agent
   * applies and reads it back; nobody is given its password, and it ends
   * with no connection. MsaCutoverRunService is the only caller.
   */
  async issueVerification(actor: ActorContext, endpointId: string, now = Date.now()) {
    this.assertEnabled();
    const { ep, rid } = await this.managedComputer(actor, endpointId, 'pending', now);
    return this.signAndStore(actor, ep, rid, {
      mode: 'view', permissions: { clipboard: false, files: false, audio: false, tunnel: false, restart: false },
      consent: 'required', maxMinutes: VERIFY_GRANT_MINUTES, idleMinutes: VERIFY_GRANT_MINUTES,
    }, 'verify', null, now);
  }

  /**
   * A Connect grant's one-time password, released ONCE, to the technician
   * the grant names, for the Connect script (MsaSessionService.connectScript,
   * which re-ran authorizeConnect first). Only once the agent reported it
   * applied and before it ended. Audited first (ids only), claimed by one
   * conditional write, then opened.
   */
  async release(actor: ActorContext, grantId: string) {
    this.assertEnabled();
    if (!GRANT_ID_RE.test(grantId)) throw new NotFoundException('Grant not found');
    const g = await this.prisma.msaGrant.findUnique({ where: { id: grantId }, select: { id: true, endpointId: true, state: true, revealedAt: true, technicianId: true, source: true } });
    if (!g || g.source !== 'connect' || g.technicianId !== actor.userId) throw new NotFoundException('Grant not found');
    await this.acl.assertEndpointInScope(actor, g.endpointId, 'computers:view');
    const ep = await this.prisma.endpoint.findFirst({
      where: { AND: [{ id: g.endpointId }, this.acl.endpointVisibilityWhere(actor)] },
      select: { id: true, tenantId: true, customerId: true, rustdeskNode: { select: { rustdeskId: true } } },
    });
    if (!ep) throw new NotFoundException('Grant not found');
    if (g.state !== 'applied') throw new ConflictException({ code: 'MSA_GRANT_NOT_APPLIED', message: 'The computer\'s agent has not applied this session (or it already ended): there is nothing to connect with.' });
    if (g.revealedAt) throw new ConflictException({ code: 'MSA_PASSWORD_ALREADY_RELEASED', message: 'This session\'s one-time password was already handed to a Connect script. Press Connect again for a new session.' });
    await this.audit.logOrFail({
      action: 'MSA_PASSWORD_RELEASED', actorId: actor.userId, actorIp: actor.ip, tenantId: ep.tenantId ?? undefined, customerId: ep.customerId ?? undefined,
      resource: 'endpoint', resourceId: ep.id, meta: { grantId: g.id, endpointId: ep.id, via: 'connect_script' },
    });
    const at = new Date();
    const claimed = await this.prisma.msaGrant.updateMany({
      where: { id: g.id, state: 'applied', revealedAt: null }, data: { revealedAt: at, revealedById: actor.userId, launchedAt: at },
    });
    if (claimed.count !== 1) throw new ConflictException({ code: 'MSA_PASSWORD_ALREADY_RELEASED', message: 'This session\'s one-time password was already handed to a Connect script. Press Connect again for a new session.' });
    const row = await this.prisma.msaGrant.findUnique({ where: { id: g.id }, select: { passwordEnc: true } });
    try {
      return { grantId: g.id, rustdeskId: ep.rustdeskNode?.rustdeskId ?? '', password: openSecret(this.encKey, 'rem0te-msa-grant-pw-v1', row!.passwordEnc) };
    } catch {
      throw new ServiceUnavailableException({ code: 'MSA_GRANT_KEY_UNAVAILABLE', message: 'The password could not be opened (ENCRYPTION_KEY changed?).' });
    }
  }

  // ── 0.73: revocation ──────────────────────────────────────────────────────

  /**
   * Revoke grants on ONE computer: the named ones, a technician's, or (all)
   * every live one. Callers have decided who may (MsaSessionService) or are
   * the system (a `remote` pause, a Connect that was never applied in time).
   * The grants move to `revoked` first (conditional, so nothing more is
   * delivered), then a signed revocation is stored for the agent's next
   * poll, which wakes. It only ever reduces: it can end sessions, never
   * start or extend one. Audited (ids, the reason, never a password).
   */
  async revoke(
    actor: ActorContext | null, endpointId: string,
    sel: { grantIds?: string[]; technicianId?: string; all?: boolean; reason: RevokeReason; states?: ('issued' | 'delivered' | 'applied')[] }, now = Date.now(),
  ): Promise<{ revoked: number; revocationId: string | null }> {
    this.assertEnabled();
    if (!ENTITY_ID_RE.test(endpointId)) return { revoked: 0, revocationId: null };
    const named = sel.grantIds ? [...new Set(sel.grantIds.filter((x) => GRANT_ID_RE.test(x)))] : null;
    if (named && named.length === 0 && !sel.all) return { revoked: 0, revocationId: null };
    const live = await this.prisma.msaGrant.findMany({
      where: {
        endpointId, state: { in: sel.states ?? [...LIVE_GRANT_STATES] },
        ...(named ? { id: { in: named } } : {}), ...(sel.technicianId ? { technicianId: sel.technicianId } : {}),
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'asc' }], take: REVOCATION_MAX_GRANTS, select: { id: true },
    });
    // Nothing live, nothing to end: a pause or a computer-wide revoke with no
    // session open sends nothing (every session on a managed computer comes
    // from a grant recorded here, and stays live here until the agent says
    // it ended).
    if (live.length === 0) return { revoked: 0, revocationId: null };
    const ids = live.map((g) => g.id).sort();
    const at = new Date(now);
    const revoked = ids.length
      ? (await this.prisma.msaGrant.updateMany({
          where: { id: { in: ids }, endpointId, state: { in: [...LIVE_GRANT_STATES] } },
          data: { state: 'revoked', revokedAt: at, revokedById: actor?.userId ?? null, revokeReason: sel.reason },
        })).count
      : 0;
    if (revoked === 0) return { revoked: 0, revocationId: null };
    const ep = await this.prisma.endpoint.findUnique({
      where: { id: endpointId }, select: { id: true, tenantId: true, customerId: true, rustdeskNode: { select: { rustdeskId: true } } },
    });
    const rid = ep?.rustdeskNode?.rustdeskId ?? '';
    // No key means no grant was ever signed, so there is nothing to end.
    const keyRow = await this.prisma.msaGrantKey.findFirst({ where: { retiredAt: null }, select: { keyId: true, privateKeyEnc: true } });
    let revocationId: string | null = null;
    if (ep && keyRow && RUSTDESK_ID_RE.test(rid)) {
      let privatePem: string | null;
      try { privatePem = openSecret(this.encKey, 'rem0te-msa-grant-key-v1', keyRow.privateKeyEnc); } catch { privatePem = null; }
      if (privatePem) {
        const issued = Math.floor(now / 1000) * 1000;
        const doc = {
          v: 1 as const, revocationId: newGrantId(), endpointId: ep.id, rustdeskId: rid, all: !!sel.all, grantIds: ids,
          issuedAt: isoSeconds(issued), notAfter: isoSeconds(issued + REVOCATION_WINDOW_MS),
        };
        const env: RevocationEnvelope = signRevocation(doc, privatePem, keyRow.keyId);
        await this.prisma.msaRevocation.create({
          data: {
            id: doc.revocationId, endpointId: ep.id, keyId: keyRow.keyId, reason: sel.reason, all: doc.all, grantIds: ids,
            issuedAt: new Date(doc.issuedAt), notAfter: new Date(doc.notAfter), envelope: JSON.stringify(env), createdById: actor?.userId ?? null,
          },
        });
        revocationId = doc.revocationId;
      } else {
        this.logger.warn(`The grant key could not be opened: revocation for ${endpointId} recorded but not signed`);
      }
    }
    await this.audit.log({
      action: 'MSA_SESSION_REVOKED', actorId: actor?.userId, actorIp: actor?.ip, tenantId: ep?.tenantId ?? undefined, customerId: ep?.customerId ?? undefined,
      resource: 'endpoint', resourceId: endpointId, meta: { endpointId, grantIds: ids, reason: sel.reason, all: !!sel.all, revocationId },
    });
    this.waiters.get(endpointId)?.wake('grant');
    return { revoked, revocationId };
  }

  /** Connect grants the agent never applied within CONNECT_APPLY_TIMEOUT_MS are revoked (reason `timeout`): fail closed. */
  private async timeoutDue(endpointId: string, now: number) {
    const due = await this.prisma.msaGrant.findMany({
      where: { endpointId, source: 'connect', state: { in: ['issued', 'delivered'] }, createdAt: { lt: new Date(now - CONNECT_APPLY_TIMEOUT_MS) } },
      select: { id: true }, take: REVOCATION_MAX_GRANTS,
    });
    if (due.length) await this.revoke(null, endpointId, { grantIds: due.map((g) => g.id), reason: 'timeout' }, now);
  }

  /** Revocations still to hand over: expire the old ones, then the issued ones, oldest first. */
  private async revocationsFor(endpointId: string, now: number): Promise<RevocationEnvelope[]> {
    await this.prisma.msaRevocation.updateMany({ where: { endpointId, state: 'issued', notAfter: { lt: new Date(now) } }, data: { state: 'expired' } });
    const rows = await this.prisma.msaRevocation.findMany({
      where: { endpointId, state: 'issued' }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], take: POLL_MAX_GRANTS, select: { envelope: true },
    });
    return rows.map((r) => JSON.parse(r.envelope) as RevocationEnvelope);
  }

  /**
   * 0.73: Connect's timeout check, from MsaSessionService when the console
   * reads a session's progress (the poll checks too).
   */
  async checkTimeout(endpointId: string, now = Date.now()) {
    this.assertEnabled();
    await this.timeoutDue(endpointId, now);
  }

  /** 0.73: whether this computer's agent is polling: a held poll here, or a poll recorded recently (another API process). */
  isHeld(endpointId: string): boolean {
    return this.waiters.has(endpointId);
  }
}
