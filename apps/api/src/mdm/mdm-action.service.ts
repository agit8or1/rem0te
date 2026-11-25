import { BadRequestException, HttpException, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { randomBytes } from 'node:crypto';
import { AuditService } from '../audit/audit.service';
import { activePause, pauseMessage } from '../containment/pause';
import { PrismaService } from '../prisma/prisma.service';
import type { ActorContext } from '../rbac/access-control.service';
import { assertFresh } from '../security-controls/review';
import { AndroidEmmService } from './android/android-emm.service';
import { AppleMdmService } from './apple/apple-mdm.service';
import { apply, queuedCommand, type CommandFacts } from './command-state';
import { MdmSendError, type MdmDriver, type SendResult } from './driver';
import { makeDrivers } from './drivers';
import { LOST_COMMAND_TTL_MS, lostDeviceRefusal, parseLostDeviceRequest } from './lost-device';
import { isOneOf, PROVIDERS, type Provider } from './model';
import { commandView, MdmService } from './mdm.service';

/**
 * Lost-device commands from Rem0te (0.86 Lighthouse, docs/own-mdm.md M4,
 * §95): lock a phone or tablet, or start or stop its lost mode. The only
 * caller of a driver's send(), and the only writer of MdmCommand besides
 * the sync: it creates a `portal` command and moves it once, right after
 * the provider answers. Everything later (the device fetching it, the
 * device's result, expiry) is the sync's, through the same state machine.
 *
 * In order, nothing sent until every step passed:
 *
 *   1. scope: mobile:view and then mobile:act where the caller is (a
 *      Platform Admin; a technician on a whole-business assignment; anyone
 *      else pinned to their own business); another business's device 404s;
 *   2. the request: one of the three kinds, a bounded printable message and
 *      phone number (lost-device.ts), refused rather than trimmed;
 *   3. the fresh confirmation, naming `mdm.act` (§62, default off);
 *   4. the device's own refusals: enrolled, its connector enabled, Apple
 *      lost mode only when the device reported itself supervised, Android
 *      lost mode never on a personal device, no message where the platform
 *      shows none;
 *   5. containment: the business's (or a global) `actions` pause refuses
 *      every kind; Android also checks `integration`, because sending is a
 *      call to Google;
 *   6. MDM_COMMAND_REQUESTED with logOrFail: ids, the kind, the provider and
 *      whether a message or a phone number was given, NEVER their text;
 *   7. the command row (queued, origin `portal`, Rem0te's own id as its
 *      providerCommandId), one not-yet-accepted command of a kind per
 *      device (0103's index);
 *   8. the driver's send(), then the row moved through the state machine
 *      (sent; and accepted when the provider accepted in the same call), or
 *      failed with `provider_rejected:<code>` and a 502.
 *
 * Nothing here logs; the message and phone number go to the driver and
 * nowhere else.
 */
@Injectable()
export class MdmActionService {
  private readonly drivers: Record<Provider, MdmDriver>;

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly mdm: MdmService,
    apple: AppleMdmService,
    android: AndroidEmmService,
  ) {
    this.drivers = makeDrivers({ apple, android });
  }

  async send(actor: ActorContext, id: string, body: unknown, q: Record<string, unknown>, freshMethod: string | null) {
    const d = await this.mdm.visibleForAct(actor, id, q);
    const parsed = parseLostDeviceRequest(body);
    if (!parsed.ok) throw new BadRequestException({ code: parsed.code, message: parsed.message });
    const r = parsed.value;
    assertFresh(freshMethod, { action: 'mdm.act', message: 'Confirm it is you to send a command to this phone or tablet.' });

    const refusal = lostDeviceRefusal(r.kind, await this.mdm.facts(d), r);
    if (refusal) throw new HttpException({ code: refusal.code, message: refusal.message }, refusal.status);
    const held = await activePause(this.prisma, 'actions', d.customerId);
    if (held) throw new HttpException({ code: 'MDM_ACTIONS_PAUSED', message: pauseMessage(held, 'actions') }, 409);
    if (d.provider === 'android') {
      const ip = await activePause(this.prisma, 'integration', d.customerId);
      if (ip) throw new HttpException({ code: 'MDM_INTEGRATION_PAUSED', message: pauseMessage(ip, 'integration') }, 409);
    }
    const connector = await this.prisma.mdmConnector.findUnique({ where: { id: d.connectorId } });
    if (!connector || !connector.enabled || !isOneOf(PROVIDERS, connector.provider) || connector.provider !== d.provider) {
      throw new HttpException({ code: 'MOBILE_CONNECTOR_DISABLED', message: 'This device\'s connector is disabled.' }, 409);
    }
    const drv = this.drivers[connector.provider];
    if (!drv.ready(connector).ok) throw new HttpException({ code: 'MOBILE_CONNECTOR_NOT_READY', message: 'This device\'s connector cannot be used now.' }, 409);

    // One not-yet-accepted command of a kind per device (0103's index holds it under a race): refused before anything is audited.
    if (await this.prisma.mdmCommand.findFirst({ where: { mobileDeviceId: d.id, kind: r.kind, origin: 'portal', state: { in: ['queued', 'sent'] } }, select: { id: true } })) throw openCommand();

    const now = new Date();
    // Rem0te's own id for the command, recorded before anything is sent (the Apple queue uses it as its row id).
    const ref = `mc${randomBytes(12).toString('hex')}`;
    const expiresAt = new Date(now.getTime() + LOST_COMMAND_TTL_MS);
    const commandId = randomBytes(12).toString('hex');
    await this.audit.logOrFail({
      action: 'MDM_COMMAND_REQUESTED', actorId: actor.userId, actorIp: actor.ip, tenantId: d.tenantId, customerId: d.customerId,
      resource: 'mdm_command', resourceId: commandId,
      meta: { commandId, mobileDeviceId: d.id, kind: r.kind, provider: d.provider, hasMessage: r.message !== null, hasPhoneNumber: r.phoneNumber !== null },
    });
    const start = queuedCommand(expiresAt);
    try {
      await this.prisma.mdmCommand.create({
        data: {
          id: commandId, tenantId: d.tenantId, customerId: d.customerId, mobileDeviceId: d.id, connectorId: connector.id, providerCommandId: ref,
          kind: r.kind, origin: 'portal', requestedById: actor.userId, requestedAt: now, state: start.state, expiresAt,
        },
      });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        throw openCommand();
      }
      throw e;
    }

    let sent: SendResult | null = null, failure: string | null = null;
    try {
      sent = await drv.send(connector, d, { ref, kind: r.kind, message: r.message, phoneNumber: r.phoneNumber, expiresAt });
    } catch (e) {
      failure = e instanceof MdmSendError ? e.code : 'unreachable';
    }
    const at = new Date();
    let next: CommandFacts = start;
    const step = (ev: Parameters<typeof apply>[1]) => { const s = apply(next, ev); if (s.ok) next = s.next; };
    if (sent) {
      step({ type: 'sent', at });
      // Android: the Operation is Google's acceptance, recorded when Rem0te got it. Apple accepts when the device fetches it (the sync).
      if (sent.acceptedAt) step({ type: 'provider_accepted', at });
    } else {
      step({ type: 'provider_rejected', at, code: failure ?? 'unreachable' });
    }
    const row = await this.prisma.$transaction(async (tx) => {
      await tx.mdmCommand.updateMany({
        where: { id: commandId, state: 'queued' },
        data: {
          state: next.state, sentAt: next.sentAt, providerAcceptedAt: next.providerAcceptedAt, failedAt: next.failedAt, failureCode: next.failureCode,
          ...(sent ? { providerCommandId: sent.providerCommandId } : {}),
        },
      });
      return tx.mdmCommand.findUniqueOrThrow({ where: { id: commandId } });
    });
    await this.audit.log({
      action: sent ? 'MDM_COMMAND_SENT' : 'MDM_COMMAND_SEND_FAILED', actorId: actor.userId, actorIp: actor.ip, tenantId: d.tenantId, customerId: d.customerId,
      resource: 'mdm_command', resourceId: commandId,
      meta: { commandId, mobileDeviceId: d.id, kind: r.kind, provider: d.provider, ...(sent ? { accepted: !!sent.acceptedAt } : { code: failure }) },
    });
    if (!sent) {
      throw new HttpException({ code: 'MDM_SEND_FAILED', message: SEND_FAILED[failure ?? 'unreachable'] ?? SEND_FAILED.unreachable, reason: failure, command: commandView(row) }, 502);
    }
    return { command: commandView(row) };
  }
}

const openCommand = () => new HttpException({ code: 'MOBILE_COMMAND_OPEN', message: 'The same command is already waiting for this device. Wait for it to be accepted.' }, 409);

const SEND_FAILED: Record<string, string> = {
  unsupported: 'The device cannot take this command (lost mode needs a supervised iPhone or iPad). Nothing was sent.',
  not_ready: 'The provider is not set up to send commands. Nothing was sent.',
  refused: 'The provider refused the command.',
  conflict: 'The same command is already waiting for this device.',
  unreachable: 'The provider could not be reached. Nothing is known to have been sent; try again.',
  bad_response: 'The provider answered something Rem0te did not expect.',
  quota: 'The provider is limiting requests. Try again later.',
};
