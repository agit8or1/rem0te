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
 * In 0.71 a grant is issued only by `issueTest` (the Platform Admin test
 * route); Connect does not call this service (step 4).
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

  /** Public keys only: what step 4 will publish in the signed release metadata. Platform Admin. */
  async publicKeys() {
    this.assertEnabled();
    const rows = await this.prisma.msaGrantKey.findMany({ orderBy: { createdAt: 'desc' }, select: { keyId: true, publicKey: true, createdAt: true, retiredAt: true } });
    return rows.map((r) => ({ keyId: r.keyId, algorithm: 'ed25519', publicKey: r.publicKey, createdAt: r.createdAt, retiredAt: r.retiredAt, active: r.retiredAt === null }));
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
      meta: { grantId: grant.grantId, endpointId: ep.id, mode: grant.mode, consent: grant.consent, keyId: key.keyId, source: 'test' },
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
      : 0;

    const answer = async () => {
      const t = Date.now();
      await this.expireDue(ep.id, t);
      if (await activePause(this.prisma, 'remote', ep.customerId)) return { grants: [] as Envelope[], paused: true };
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
      return { grants, paused: false };
    };

    let out = await answer();
    if (out.grants.length || out.paused || dto.wait === false) return { ...out, acked, holdMs: 0 };

    if (!this.waiters.has(ep.id) && this.waiters.size >= this.maxPolls) return { ...out, acked, holdMs: 0, retryAfterMs: 5_000 };
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
        void this.prisma.msaGrant.count({ where: { endpointId: ep.id, state: 'issued', notAfter: { gte: new Date() } } })
          .then((n) => { if (n > 0) finish('grant'); })
          .catch(() => { /* the hold just runs out */ });
      }, POLL_RECHECK_MS);
      this.waiters.set(ep.id, me);
    });
    // A superseded poll hands nothing over: grants go only to the newest poll.
    if (why === 'superseded') return { grants: [], paused: false, acked, holdMs: Date.now() - started, superseded: true };
    out = await answer();
    return { ...out, acked, holdMs: Date.now() - started };
  }
}
