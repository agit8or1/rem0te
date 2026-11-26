import { BadRequestException, ConflictException, HttpException, Injectable, NotFoundException } from '@nestjs/common';
import { createHash } from 'crypto';
import { z } from 'zod';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { AccessControlService, type ActorContext } from '../rbac/access-control.service';
import { CAP } from '../rbac/capabilities';
import { UserBudget } from '../common/user-budget';
import { AiSettingsService } from './ai-settings.service';
import { callProvider } from './client';
import { cleanAnswer, SYSTEM_PROMPT, userPrompt } from './prompt';
import { alertPayload, eventFingerprint, eventPayload, knownNames, type AiPayload, type EventInput } from './redact';

/** What a button names: one event of a stored event-log result, or one alert on this computer. */
export const SourceInput = z.discriminatedUnion('source', [
  z.object({ source: z.literal('event'), commandId: z.string().regex(/^[A-Za-z0-9_-]{8,64}$/), index: z.number().int().min(0).max(999) }).strict(),
  z.object({ source: z.literal('alert'), alertId: z.string().regex(/^[A-Za-z0-9_-]{8,64}$/) }).strict(),
]);
export type SourceInput = z.infer<typeof SourceInput>;

export interface ResolvedSource {
  endpoint: { id: string; name: string; tenantId: string | null; customerId: string | null; osVersion: string | null };
  businessName: string | null;
  sourceRef: string;
  /** The event's own identity (unredacted, never sent anywhere). */
  identity: string;
  kind: 'event' | 'alert';
  event?: EventInput;
  alert?: { id: string; kind: string; ruleKey: string; severity: string; title: string; detail: unknown; firstSeenAt: string };
  payload: AiPayload;
}

const CACHE_MS = 24 * 3600_000;

/**
 * "Ask AI" on an event-log entry or an alert (0.48).
 *
 * The browser names the entry (a stored command result and its index, or an
 * alert id) — never its text. The server reads it from what the computer
 * reported, so this route cannot be used as a general prompt to the provider,
 * and the text cannot be swapped for something else.
 *
 * Order: scope (404 for another business's computer), capability (an event
 * needs computers:event_logs, as reading the log does; an alert needs
 * monitoring:alerts), the per-user budget, provider configured, then the
 * redacted payload. A cache hit sends nothing. Otherwise AI_ASKED is written
 * BEFORE the request leaves (logOrFail: no record, no request), and
 * AI_ANSWERED after — ids, provider, model, sizes, redaction counts and token
 * counts, never text.
 */
@Injectable()
export class AiService {
  private readonly budget = new UserBudget(Number(process.env.AI_ASK_PER_HOUR ?? 30), 3600_000);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly acl: AccessControlService,
    private readonly settings: AiSettingsService,
  ) {}

  /** Scope, capability, and the entry itself. Shared with PSA tickets. */
  async resolveSource(actor: ActorContext, endpointId: string, raw: unknown): Promise<ResolvedSource> {
    const ep = await this.acl.assertEndpointInScope(actor, endpointId, CAP.COMPUTERS_VIEW);
    this.acl.assertCapability(actor, CAP.COMPUTERS_VIEW);
    const d = SourceInput.safeParse(raw ?? {});
    if (!d.success) throw new BadRequestException({ code: 'INVALID_REQUEST', message: 'Name an event (commandId and index) or an alert (alertId).' });
    const full = await this.prisma.endpoint.findUnique({
      where: { id: ep.id },
      select: {
        id: true, name: true, hostname: true, serialNumber: true, osVersion: true, tenantId: true, customerId: true,
        customer: { select: { name: true } }, site: { select: { name: true } },
        inventory: { select: { serialNumber: true, domain: true, loggedOnUser: true, osCaption: true, osBuild: true } },
      },
    });
    if (!full) throw new NotFoundException('Computer not found');
    const names = knownNames([full.name, full.hostname, full.serialNumber, full.inventory?.serialNumber, full.inventory?.domain, full.inventory?.loggedOnUser, full.customer?.name, full.site?.name]);
    const os = full.inventory?.osCaption ? `${full.inventory.osCaption}${full.inventory.osBuild ? ` (build ${full.inventory.osBuild})` : ''}` : full.osVersion;
    const endpoint = { id: full.id, name: full.name, tenantId: full.tenantId, customerId: full.customerId, osVersion: os ?? null };
    const base = { endpoint, businessName: full.customer?.name ?? null };

    if (d.data.source === 'event') {
      await this.acl.assertEndpointInScope(actor, endpointId, CAP.COMPUTERS_EVENT_LOGS);
      this.acl.assertCapability(actor, CAP.COMPUTERS_EVENT_LOGS);
      const cmd = await this.prisma.endpointCommand.findFirst({ where: { id: d.data.commandId, endpointId: ep.id, type: 'EVENT_LOG_QUERY', status: 'SUCCEEDED' } });
      const events = (cmd?.result as { events?: unknown[] } | null)?.events;
      const row = Array.isArray(events) ? (events[d.data.index] as Record<string, unknown> | undefined) : undefined;
      if (!cmd || !row || typeof row !== 'object') throw new NotFoundException('Event not found');
      const params = (cmd.params ?? {}) as { logName?: unknown };
      const s = (v: unknown) => (typeof v === 'string' ? v : null);
      const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
      const event: EventInput = { logName: s(params.logName), eventId: n(row.eventId), provider: s(row.provider), level: n(row.level), levelName: s(row.levelName), timeCreated: s(row.timeCreated), message: s(row.message) };
      return { ...base, kind: 'event', event, sourceRef: `event:${cmd.id}:${d.data.index}`, identity: eventFingerprint(event), payload: eventPayload(event, endpoint.osVersion, names) };
    }
    this.acl.assertCapability(actor, CAP.ALERTS_VIEW);
    const a = await this.prisma.monitorAlert.findFirst({ where: { id: d.data.alertId, endpointId: ep.id, customerId: full.customerId } });
    if (!a) throw new NotFoundException('Alert not found');
    const alert = { id: a.id, kind: a.kind, ruleKey: a.ruleKey, severity: a.severity, title: a.title, detail: a.detail, firstSeenAt: a.firstSeenAt.toISOString() };
    return { ...base, kind: 'alert', alert, sourceRef: `alert:${a.id}`, identity: createHash('sha256').update(`alert:${a.id}`).digest('hex'), payload: alertPayload(alert, endpoint.osVersion, names) };
  }

  private cacheKey(provider: string, model: string, baseUrl: string | null, fingerprint: string) {
    return createHash('sha256').update(JSON.stringify([provider, model, baseUrl, fingerprint])).digest('hex');
  }

  /** The cached answer for this entry under the current provider, if any. For a ticket's "include AI explanation". */
  async cachedFor(src: ResolvedSource): Promise<{ answer: string; provider: string; model: string } | null> {
    const s = await this.settings.row();
    if (!s) return null;
    const hit = await this.prisma.aiAnswer.findUnique({ where: { cacheKey: this.cacheKey(s.provider, s.model, s.baseUrl, src.payload.fingerprint) } });
    return hit && hit.expiresAt > new Date() ? { answer: hit.answer, provider: hit.provider, model: hit.model } : null;
  }

  async ask(actor: ActorContext, endpointId: string, raw: unknown) {
    const src = await this.resolveSource(actor, endpointId, raw);
    const base = {
      actorId: actor.userId, actorIp: actor.ip, actorAgent: actor.userAgent,
      tenantId: src.endpoint.tenantId ?? undefined, customerId: src.endpoint.customerId ?? undefined, resource: 'endpoint', resourceId: src.endpoint.id,
    };
    if (!this.budget.take(actor.userId)) throw new HttpException({ code: 'AI_RATE_LIMITED', message: 'You have asked the AI a lot in the last hour. Try again later.' }, 429);
    const active = await this.settings.active();
    if (!active) throw new ConflictException({ code: 'AI_NOT_CONFIGURED', message: 'Not configured — a Platform Admin sets a provider in Administration → AI.' });
    const { cfg, key } = active;
    const ids = { source: src.kind, sourceRef: src.sourceRef, provider: cfg.provider, model: cfg.model };
    const key24 = this.cacheKey(cfg.provider, cfg.model, cfg.baseUrl, src.payload.fingerprint);

    const hit = await this.prisma.aiAnswer.findUnique({ where: { cacheKey: key24 } });
    if (hit && hit.expiresAt > new Date()) {
      await this.audit.log({ ...base, action: 'AI_ASKED', meta: { ...ids, cached: true, chars: src.payload.chars, redactions: src.payload.counts, inputTokens: 0, outputTokens: 0 } });
      return { answer: hit.answer, provider: cfg.provider, model: hit.model, cached: true, redactions: src.payload.counts, askedAt: hit.createdAt };
    }

    // The record of what left is written before it leaves, or nothing leaves.
    await this.audit.logOrFail({ ...base, action: 'AI_ASKED', meta: { ...ids, cached: false, chars: src.payload.chars, redactions: src.payload.counts } });
    const r = await callProvider(cfg, key, SYSTEM_PROMPT, userPrompt(src.payload.text));
    if (!r.ok) {
      await this.audit.log({ ...base, action: 'AI_ANSWERED', meta: { ...ids, status: 'failed', code: r.code } });
      throw new HttpException({ code: 'AI_FAILED', message: `The AI provider did not answer (${r.code}).` }, 502);
    }
    const answer = cleanAnswer(r.answer.text);
    if (!answer) {
      await this.audit.log({ ...base, action: 'AI_ANSWERED', meta: { ...ids, status: 'failed', code: 'EMPTY' } });
      throw new HttpException({ code: 'AI_FAILED', message: 'The AI provider returned an empty answer.' }, 502);
    }
    const model = r.answer.model ?? cfg.model;
    const now = new Date();
    await this.prisma.aiAnswer.deleteMany({ where: { expiresAt: { lt: now } } });
    await this.prisma.aiAnswer.upsert({
      where: { cacheKey: key24 },
      create: { cacheKey: key24, provider: cfg.provider, model, answer, inputTokens: r.answer.inputTokens, outputTokens: r.answer.outputTokens, expiresAt: new Date(now.getTime() + CACHE_MS) },
      update: { model, answer, inputTokens: r.answer.inputTokens, outputTokens: r.answer.outputTokens, createdAt: now, expiresAt: new Date(now.getTime() + CACHE_MS) },
    });
    await this.audit.log({ ...base, action: 'AI_ANSWERED', meta: { ...ids, status: 'ok', resolvedModel: model, inputTokens: r.answer.inputTokens, outputTokens: r.answer.outputTokens, answerChars: answer.length } });
    return { answer, provider: cfg.provider, model, cached: false, redactions: src.payload.counts, askedAt: now };
  }

  /** What would be sent, for the "redacted before sending" disclosure. Sends nothing. */
  async preview(actor: ActorContext, endpointId: string, raw: unknown) {
    const src = await this.resolveSource(actor, endpointId, raw);
    return { text: src.payload.text, chars: src.payload.chars, redactions: src.payload.counts };
  }
}
