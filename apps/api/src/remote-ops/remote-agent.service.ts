import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { z } from 'zod';
import { PrismaService } from '../prisma/prisma.service';
import { EnrollmentService } from '../enrollment/enrollment.service';
import { runsSignedAgent } from '../common/agent-identity';
import { isWindowsPlatform } from '../common/platform';
import { assertAssigned } from '../common/unassigned';
import { AGENT_REFUSALS, REMOTE_POLL_HOLD_MS, REMOTE_POLL_RECHECK_MS, SESSION_ID_RE } from './limits';
import { RemoteWakeService } from './remote-wake.service';
import { TerminalService } from './terminal.service';

const RID = z.string().regex(/^[0-9]{6,15}$/);
const SECRET = z.string().min(16).max(128);

const PollBody = z.strictObject({
  rustdeskId: RID,
  agentSecret: SECRET,
  wait: z.boolean().optional(),
  terminals: z.array(z.strictObject({ id: z.string().regex(SESSION_ID_RE), inAcked: z.number().int().min(0) })).max(8).optional(),
});

const OutputBody = z.strictObject({
  rustdeskId: RID,
  agentSecret: SECRET,
  sessionId: z.string().regex(SESSION_ID_RE),
  started: z.boolean().optional(),
  // Checked frame by frame by policy.outputFrames.
  frames: z.array(z.unknown()).max(16).optional(),
  exited: z.strictObject({ code: z.number().int() }).optional(),
  refused: z.enum(AGENT_REFUSALS).optional(),
});

const clampHold = (raw: string | undefined) => {
  const n = Number(raw);
  return Number.isInteger(n) && n >= 200 && n <= REMOTE_POLL_HOLD_MS ? n : REMOTE_POLL_HOLD_MS;
};

/**
 * The remote worker's channel (0.77): `rem0te-agent.exe remote-worker`,
 * started by the signed heartbeat only when the portal answers
 * `remotePoll: true`, polls here and exits when there is nothing for it.
 * Outbound only: the computer listens on nothing.
 *
 * Every call parses strictly, then checks the device secret
 * (EnrollmentService.authenticateDevice) before anything else is read, then
 * admits only an assigned Windows computer running the signed agent. A
 * session is reachable only through its own computer's secret.
 */
@Injectable()
export class RemoteAgentService {
  private readonly holdMs = clampHold(process.env.REMOTE_POLL_HOLD_MS);

  constructor(
    private readonly prisma: PrismaService,
    private readonly enrollment: EnrollmentService,
    private readonly wake: RemoteWakeService,
    private readonly terminals: TerminalService,
  ) {}

  private async device(rustdeskId: string, agentSecret: string, reason: string) {
    const dev = await this.enrollment.authenticateDevice(rustdeskId, agentSecret, reason);
    const ep = await this.prisma.endpoint.findUnique({
      where: { id: dev.endpointId },
      select: { id: true, tenantId: true, customerId: true, platform: true, updateChannel: true, signedSeenAt: true },
    });
    if (!ep) throw new NotFoundException('This device is not attached to a computer');
    if (!isWindowsPlatform(ep.platform) || !runsSignedAgent({ updateChannel: ep.updateChannel, signedSeenAt: ep.signedSeenAt })) {
      throw new ForbiddenException({ code: 'REMOTE_SIGNED_AGENT_REQUIRED', message: 'Only the signed Windows agent may use the remote channel.' });
    }
    assertAssigned(ep);
    return ep;
  }

  async poll(raw: unknown) {
    const p = PollBody.safeParse(raw ?? {});
    if (!p.success) throw new BadRequestException({ code: 'REMOTE_POLL_INVALID', message: 'The poll is not valid.' });
    const dto = p.data;
    const ep = await this.device(dto.rustdeskId, dto.agentSecret, 'remote_poll_unauthenticated');
    const held = dto.terminals ?? [];
    let out = await this.terminals.forAgent(ep, held);
    if (!out.work && dto.wait !== false) {
      const why = await this.wake.hold(ep.id, this.holdMs, REMOTE_POLL_RECHECK_MS, () => this.terminals.agentHasWork(ep.id, held));
      if (why === 'superseded') return { endpointId: ep.id, terminals: [], superseded: true, holdMs: 0 };
      out = await this.terminals.forAgent(ep, held);
    }
    return { endpointId: ep.id, terminals: out.terminals, holdMs: this.holdMs };
  }

  async terminalOutput(raw: unknown) {
    const p = OutputBody.safeParse(raw ?? {});
    if (!p.success) throw new BadRequestException({ code: 'REMOTE_OUTPUT_INVALID', message: 'The output post is not valid.' });
    const dto = p.data;
    const ep = await this.device(dto.rustdeskId, dto.agentSecret, 'remote_output_unauthenticated');
    return this.terminals.fromAgent(ep, { sessionId: dto.sessionId, started: dto.started, frames: dto.frames, exited: dto.exited ?? null, refused: dto.refused });
  }
}
