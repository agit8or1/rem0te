import { BadRequestException, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { AiSettings } from '@prisma/client';
import { z } from 'zod';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import type { ActorContext } from '../rbac/access-control.service';
import { checkPublicHttpsUrl } from '../common/safe-https';
import { openSecret, sealSecret } from '../common/secret-box';
import { AUTH_STYLES, DEFAULT_MODEL, last4, MODEL_RE, PROVIDER_LABEL, PROVIDERS, type AuthStyle, type Provider, type ProviderConfig } from './providers';
import { callProvider } from './client';
import { TEST_SYSTEM, TEST_USER } from './prompt';

/**
 * Settings → AI (0.48): the one provider "Ask AI" uses. Platform Admin only
 * (the controller's guard); saving needs fresh authentication — never routine
 * (§62) — because it decides where redacted event text is sent and holds a
 * key that spends the MSP's money.
 *
 * The key: AES-256-GCM under ENCRYPTION_KEY (common/secret-box.ts, purpose
 * `rem0te-ai-key-v1`), decrypted only to build one request. It is in no
 * response (only `keySet` and its last four characters), audit row or log
 * line. A change of provider, base URL or auth style clears it unless a new
 * one is given in the same request, so it can never be sent somewhere other
 * than where it was entered for.
 */
export const AiInput = z.object({
  enabled: z.boolean(),
  provider: z.enum(PROVIDERS),
  model: z.string().trim().max(128).optional(),
  baseUrl: z.string().trim().max(2048).nullable().optional(),
  authStyle: z.enum(AUTH_STYLES).optional(),
  /** Absent = keep (unless the destination moved); null = clear. */
  apiKey: z.string().min(8).max(512).regex(/^[\x21-\x7e]+$/, 'printable characters, no spaces').nullable().optional(),
}).strict();

const bad = (e: z.ZodError) => new BadRequestException({ code: 'INVALID_REQUEST', message: e.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; ') });

@Injectable()
export class AiSettingsService {
  private readonly encKey: string | undefined;
  constructor(private readonly prisma: PrismaService, private readonly audit: AuditService, config: ConfigService) {
    this.encKey = config.get<string>('ENCRYPTION_KEY');
  }

  row() { return this.prisma.aiSettings.findUnique({ where: { id: 'singleton' } }); }

  view(s: AiSettings | null) {
    if (!s) return { configured: false, enabled: false, provider: null, model: null, baseUrl: null, authStyle: 'bearer', keySet: false, keyLast4: null, defaults: DEFAULT_MODEL };
    return {
      configured: true, enabled: s.enabled, provider: s.provider, providerLabel: PROVIDER_LABEL[s.provider as Provider] ?? s.provider, model: s.model, baseUrl: s.baseUrl, authStyle: s.authStyle,
      keySet: !!s.apiKeyEnc, keyLast4: s.apiKeyEnc ? s.apiKeyLast4 : null,
      updatedAt: s.updatedAt, updatedById: s.updatedById, lastTestAt: s.lastTestAt, lastTestResult: s.lastTestResult, defaults: DEFAULT_MODEL,
    };
  }

  async get() { return this.view(await this.row()); }

  /** For everyone signed in: is Ask AI available, and with what? Never the key or the URL. */
  async status() {
    const s = await this.row();
    const ready = !!s?.enabled && !!s.apiKeyEnc;
    return { enabled: ready, provider: ready ? s!.provider : null, providerLabel: ready ? PROVIDER_LABEL[s!.provider as Provider] : null, model: ready ? s!.model : null };
  }

  async put(a: ActorContext, raw: unknown) {
    const d = AiInput.safeParse(raw ?? {});
    if (!d.success) throw bad(d.error);
    const provider = d.data.provider;
    const model = (d.data.model || DEFAULT_MODEL[provider]).trim();
    if (!MODEL_RE.test(model)) throw new BadRequestException({ code: 'INVALID_MODEL', message: 'Enter the model id, for example claude-sonnet-5-5 or gpt-5.1-mini.' });
    let baseUrl: string | null = null;
    if (provider === 'openai_compatible') {
      const c = checkPublicHttpsUrl(d.data.baseUrl, 'The base URL');
      if (!c.ok) throw new BadRequestException({ code: 'INVALID_BASE_URL', message: c.reason });
      if (c.url.search) throw new BadRequestException({ code: 'INVALID_BASE_URL', message: 'The base URL must not have a query string.' });
      baseUrl = c.url.toString().replace(/\/+$/, '');
    } else if (d.data.baseUrl) {
      throw new BadRequestException({ code: 'INVALID_BASE_URL', message: 'Only an OpenAI-compatible provider takes a base URL.' });
    }
    const authStyle: AuthStyle = provider === 'openai_compatible' ? d.data.authStyle ?? 'bearer' : 'bearer';

    const cur = await this.row();
    const moved = !!cur && (cur.provider !== provider || (cur.baseUrl ?? null) !== baseUrl || cur.authStyle !== authStyle);
    let apiKeyEnc: string | null; let apiKeyLast4: string | null;
    let keyChange: 'set' | 'kept' | 'cleared' | 'cleared_destination_changed' | 'none';
    if (typeof d.data.apiKey === 'string') { apiKeyEnc = sealSecret(this.encKey, 'rem0te-ai-key-v1', d.data.apiKey); apiKeyLast4 = last4(d.data.apiKey); keyChange = 'set'; }
    else if (d.data.apiKey === null) { apiKeyEnc = null; apiKeyLast4 = null; keyChange = cur?.apiKeyEnc ? 'cleared' : 'none'; }
    else if (cur?.apiKeyEnc && moved) { apiKeyEnc = null; apiKeyLast4 = null; keyChange = 'cleared_destination_changed'; }
    else { apiKeyEnc = cur?.apiKeyEnc ?? null; apiKeyLast4 = cur?.apiKeyLast4 ?? null; keyChange = apiKeyEnc ? 'kept' : 'none'; }
    if (d.data.enabled && !apiKeyEnc) {
      throw new BadRequestException({ code: 'KEY_REQUIRED', message: moved && cur?.apiKeyEnc ? 'The provider or address changed, so the saved key was not kept. Enter the key again.' : 'Enter an API key to switch AI on.' });
    }
    const data = { enabled: d.data.enabled, provider, model, baseUrl, authStyle, apiKeyEnc, apiKeyLast4, updatedById: a.userId };
    const row = await this.prisma.aiSettings.upsert({ where: { id: 'singleton' }, create: { id: 'singleton', ...data }, update: data });
    const pub = (s: AiSettings | null) => s && { enabled: s.enabled, provider: s.provider, model: s.model, baseUrl: s.baseUrl, authStyle: s.authStyle };
    // The key is never in the audit row: only whether it changed.
    await this.audit.logOrFail({
      action: 'AI_SETTINGS_CHANGED', actorId: a.userId, actorIp: a.ip, tenantId: a.tenantId ?? undefined, resource: 'ai_settings', resourceId: 'singleton',
      meta: { before: pub(cur), after: pub(row), key: keyChange },
    });
    return { ...this.view(row), keyChange };
  }

  /** The configuration and decrypted key, for one call. Null when off or unreadable. */
  async active(): Promise<{ cfg: ProviderConfig; key: string } | null> {
    const s = await this.row();
    if (!s?.enabled || !s.apiKeyEnc) return null;
    let key: string;
    try { key = openSecret(this.encKey, 'rem0te-ai-key-v1', s.apiKeyEnc); } catch { return null; }
    return { cfg: { provider: s.provider as Provider, model: s.model, baseUrl: s.baseUrl, authStyle: s.authStyle as AuthStyle }, key };
  }

  /** Send a tiny prompt with the saved settings (whether or not AI is switched on). */
  async test(a: ActorContext) {
    const s = await this.row();
    if (!s?.apiKeyEnc) return { ok: false, status: 'not_configured' };
    let key: string;
    try { key = openSecret(this.encKey, 'rem0te-ai-key-v1', s.apiKeyEnc); } catch { return { ok: false, status: 'key_unreadable' }; }
    const cfg: ProviderConfig = { provider: s.provider as Provider, model: s.model, baseUrl: s.baseUrl, authStyle: s.authStyle as AuthStyle };
    const started = Date.now();
    const r = await callProvider(cfg, key, TEST_SYSTEM, TEST_USER, 16);
    const status = r.ok ? 'ok' : r.code;
    await this.prisma.aiSettings.update({ where: { id: 'singleton' }, data: { lastTestAt: new Date(), lastTestResult: status } });
    await this.audit.log({
      action: 'AI_SETTINGS_TESTED', actorId: a.userId, actorIp: a.ip, tenantId: a.tenantId ?? undefined, resource: 'ai_settings', resourceId: 'singleton',
      meta: { provider: cfg.provider, model: cfg.model, ok: r.ok, status, inputTokens: r.ok ? r.answer.inputTokens : 0, outputTokens: r.ok ? r.answer.outputTokens : 0 },
    });
    return { ok: r.ok, status, model: r.ok ? r.answer.model ?? cfg.model : cfg.model, latencyMs: Date.now() - started };
  }
}
