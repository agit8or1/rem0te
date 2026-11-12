import { BadRequestException, ConflictException, ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { EmailRecipient, SmtpSettings } from '@prisma/client';
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'crypto';
import { lookup } from 'dns/promises';
import { isIP } from 'net';
import { createTransport } from 'nodemailer';
import { z } from 'zod';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { AccessControlService, type ActorContext } from '../rbac/access-control.service';
import { PublicUrlService } from '../platform/public-url.service';
import { activePause, pauseMessage } from '../containment/pause';
import { isMspActor, mayManageNotifications } from '../monitoring/notify-who';
import { checkResolved, checkSmtpHostName, localRelayAllowance, TLS_MODES, tlsModeAllowed, type TlsMode } from './smtp-host';
import { maskAddress, normaliseAddress, oneLine, testMail, verificationMail, type Mail } from './mail-content';

/**
 * Outbound email (0.34): the SMTP relay, the addresses mail may go to, and
 * the one function everything sends through.
 *
 *   relay        Platform Admin only (the controller's guard), changed with
 *                fresh authentication, audited without the password. Off
 *                until it is configured and enabled. The host is checked on
 *                save and, resolved, on every send (smtp-host.ts).
 *   recipients   an address is usable only after someone clicked the link
 *                sent to it. Added and removed with fresh authentication, by
 *                whoever decides who is notified for that scope (a Business
 *                Owner of the business, or the MSP — mayManageNotifications).
 *   send()       refuses when mail is off, when a `notifications` containment
 *                pause covers the business (or everything), and when the
 *                relay's address is not allowed. One message per recipient,
 *                so recipients never see each other's addresses.
 *
 * Why verified addresses and not "users of the business": a stolen session
 * that can edit a policy could otherwise type any address and mail alert
 * text, or a CSV of the fleet, to it. A user's account email is not proof
 * either — accounts are created by admins and carry whatever was typed. A
 * confirmation link proves the mailbox's owner asked for the mail; fresh
 * authentication on adding one means the person adding it had more than a
 * cookie. Neither alone is enough; together a stolen session can do neither.
 *
 * The password: AES-256-GCM under ENCRYPTION_KEY, decrypted only to hand to
 * the transport. It is in no response, audit row or log line, and a change
 * of host, port, username or TLS mode clears it unless a new one is given in
 * the same request — so the relay cannot be pointed somewhere else and sent
 * the old password.
 */

export const SmtpInput = z.object({
  enabled: z.boolean(),
  host: z.string().trim().min(1).max(253),
  port: z.number().int().min(1).max(65535),
  tlsMode: z.enum(TLS_MODES),
  username: z.string().trim().max(256).nullable().optional(),
  /** Absent = keep the stored one (unless the relay changed); null = clear it. */
  password: z.string().min(1).max(512).nullable().optional(),
  fromAddress: z.string().trim().max(254),
  fromName: z.string().trim().max(80).nullable().optional(),
}).strict();

export const RecipientInput = z.object({
  scope: z.enum(['global', 'business']),
  businessId: z.string().regex(/^[A-Za-z0-9_-]{8,64}$/).optional(),
  address: z.string().trim().max(254),
  label: z.string().trim().max(60).optional(),
}).strict();

export const MAX_RECIPIENTS_PER_SCOPE = 25;
const TOKEN_TTL_MS = 7 * 86_400_000;
const RESEND_AFTER_MS = 5 * 60_000;
const ID = /^[A-Za-z0-9_-]{8,64}$/;

const bad = (e: z.ZodError) => new BadRequestException({ code: 'INVALID_REQUEST', message: e.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; ') });
const sha = (s: string) => createHash('sha256').update(s).digest('hex');

export type SendResult = { ok: boolean; status: string };
export interface Attachment { filename: string; content: string; contentType: string }

@Injectable()
export class EmailService {
  private readonly log = new Logger('Email');
  private readonly key: Buffer;

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly acl: AccessControlService,
    private readonly urls: PublicUrlService,
    config: ConfigService,
  ) {
    this.key = Buffer.from(config.get<string>('ENCRYPTION_KEY') ?? '', 'hex');
  }

  // ── Secrets ───────────────────────────────────────────────────────────────

  private enc(text: string): string {
    const iv = randomBytes(12);
    const c = createCipheriv('aes-256-gcm', this.key, iv);
    c.setAAD(Buffer.from('rem0te-smtp-password-v1'));
    const e = Buffer.concat([c.update(text, 'utf8'), c.final()]);
    return `${iv.toString('hex')}:${c.getAuthTag().toString('hex')}:${e.toString('hex')}`;
  }
  private dec(data: string): string {
    const [iv, tag, e] = data.split(':').map((h) => Buffer.from(h, 'hex'));
    const d = createDecipheriv('aes-256-gcm', this.key, iv);
    d.setAAD(Buffer.from('rem0te-smtp-password-v1'));
    d.setAuthTag(tag);
    return d.update(e).toString('utf8') + d.final('utf8');
  }

  // ── Relay settings (Platform Admin; the controller guards and checks freshness) ──

  private settingsRow() { return this.prisma.smtpSettings.findUnique({ where: { id: 'singleton' } }); }

  private settingsView(s: SmtpSettings | null) {
    const allow = localRelayAllowance();
    if (!s) return { configured: false, enabled: false, localRelay: allow };
    return {
      configured: true, enabled: s.enabled, host: s.host, port: s.port, tlsMode: s.tlsMode, username: s.username,
      passwordSet: !!s.passwordEnc, fromAddress: s.fromAddress, fromName: s.fromName,
      updatedAt: s.updatedAt, updatedById: s.updatedById, lastTestAt: s.lastTestAt, lastTestResult: s.lastTestResult,
      localRelay: allow,
    };
  }

  async getSettings() { return this.settingsView(await this.settingsRow()); }

  /** For everyone signed in: is mail on? (The pages that pick recipients say so when it is not.) */
  async status() {
    const s = await this.settingsRow();
    return { enabled: !!s?.enabled };
  }

  async putSettings(a: ActorContext, raw: unknown) {
    const d = SmtpInput.safeParse(raw ?? {});
    if (!d.success) throw bad(d.error);
    const h = checkSmtpHostName(d.data.host);
    if (!h.ok) throw new BadRequestException({ code: 'INVALID_HOST', message: h.reason });
    const loop = h.literal === 'loopback' || (!h.literal && (h.host === 'localhost' || h.host.endsWith('.localhost')));
    if (!tlsModeAllowed(d.data.tlsMode, loop)) {
      throw new BadRequestException({ code: 'PLAINTEXT_REFUSED', message: 'Unencrypted SMTP is allowed only to a relay on this server (loopback). Use implicit TLS (usually port 465) or STARTTLS (usually 587).' });
    }
    const from = normaliseAddress(d.data.fromAddress);
    if (!from) throw new BadRequestException({ code: 'INVALID_FROM', message: 'The from address must be one plain address, like alerts@example.com.' });
    const fromName = d.data.fromName ? oneLine(d.data.fromName, 80).replace(/["<>]/g, '') || null : null;
    const username = d.data.username ? d.data.username : null;

    const cur = await this.settingsRow();
    const relayMoved = !!cur && (cur.host !== h.host || cur.port !== d.data.port || (cur.username ?? null) !== username || cur.tlsMode !== d.data.tlsMode);
    let passwordEnc: string | null;
    let passwordChange: 'set' | 'kept' | 'cleared' | 'cleared_relay_changed' | 'none';
    if (typeof d.data.password === 'string') { passwordEnc = this.enc(d.data.password); passwordChange = 'set'; }
    else if (d.data.password === null) { passwordEnc = null; passwordChange = cur?.passwordEnc ? 'cleared' : 'none'; }
    else if (cur?.passwordEnc && relayMoved) { passwordEnc = null; passwordChange = 'cleared_relay_changed'; }
    else { passwordEnc = cur?.passwordEnc ?? null; passwordChange = passwordEnc ? 'kept' : 'none'; }
    if (username && !passwordEnc && d.data.enabled) {
      throw new BadRequestException({ code: 'PASSWORD_REQUIRED', message: relayMoved && cur?.passwordEnc ? 'The relay changed, so the saved password was not kept. Enter the password again.' : 'A username needs a password.' });
    }

    const data = { enabled: d.data.enabled, host: h.host, port: d.data.port, tlsMode: d.data.tlsMode, username, passwordEnc, fromAddress: from, fromName, updatedById: a.userId };
    const row = await this.prisma.smtpSettings.upsert({ where: { id: 'singleton' }, create: { id: 'singleton', ...data }, update: data });
    const pub = (s: Pick<SmtpSettings, 'enabled' | 'host' | 'port' | 'tlsMode' | 'username' | 'fromAddress'> | null) => s && { enabled: s.enabled, host: s.host, port: s.port, tlsMode: s.tlsMode, username: s.username, fromAddress: s.fromAddress };
    // The password is never in the audit row: only whether it changed.
    await this.audit.logOrFail({
      action: 'SMTP_SETTINGS_CHANGED', actorId: a.userId, actorIp: a.ip, tenantId: a.tenantId ?? undefined, resource: 'smtp_settings', resourceId: 'singleton',
      meta: { before: pub(cur), after: pub(row), password: passwordChange },
    });
    return { ...this.settingsView(row), passwordChange };
  }

  async sendTest(a: ActorContext, raw: unknown) {
    const d = z.object({ recipientId: z.string().regex(ID).optional() }).strict().safeParse(raw ?? {});
    if (!d.success) throw bad(d.error);
    let to: string;
    if (d.data.recipientId) {
      const r = await this.prisma.emailRecipient.findFirst({ where: { id: d.data.recipientId, scopeKey: 'global', verifiedAt: { not: null } } });
      if (!r) throw new NotFoundException('No confirmed global recipient with that id');
      to = r.address;
    } else {
      const own = normaliseAddress(a.email);
      if (!own) throw new BadRequestException({ code: 'NO_ADDRESS', message: 'Your account email is not a deliverable address. Pick a confirmed recipient instead.' });
      to = own;
    }
    const res = await this.send([to], testMail(a.email), { customerId: null });
    await this.prisma.smtpSettings.updateMany({ where: { id: 'singleton' }, data: { lastTestAt: new Date(), lastTestResult: res[0].status } });
    await this.audit.log({ action: 'EMAIL_TEST_SENT', actorId: a.userId, actorIp: a.ip, tenantId: a.tenantId ?? undefined, resource: 'smtp_settings', resourceId: 'singleton', meta: { to: maskAddress(to), ok: res[0].ok, status: res[0].status } });
    return { to: maskAddress(to), ...res[0] };
  }

  // ── Sending ───────────────────────────────────────────────────────────────

  /**
   * Send one message to each address. Never throws; one result per address.
   * The relay's name is resolved here and the connection made to the checked
   * address (the name kept for TLS), so what was checked is what is used.
   */
  async send(to: string[], mail: Mail, opts: { customerId: string | null; attachments?: Attachment[] }): Promise<SendResult[]> {
    const all = (status: string, ok = false) => to.map(() => ({ ok, status }));
    if (!to.length) return [];
    const s = await this.settingsRow();
    if (!s || !s.enabled) return all('email_off');
    const pause = await activePause(this.prisma, 'notifications', opts.customerId);
    if (pause) return all('contained');
    const allow = localRelayAllowance();
    const h = checkSmtpHostName(s.host, allow);
    if (!h.ok) return all('relay_refused');
    let addresses: string[];
    try {
      addresses = h.literal ? [h.host] : (await lookup(h.host, { all: true, verbatim: true })).map((x) => x.address);
    } catch { return all('relay_unresolved'); }
    const r = checkResolved(addresses, allow);
    if (!r.ok) { this.log.warn(`SMTP relay ${s.host} refused: ${r.reason}`); return all('relay_refused'); }
    if (!tlsModeAllowed(s.tlsMode as TlsMode, r.loopback)) return all('plaintext_refused');
    let pass: string | undefined;
    try { pass = s.passwordEnc ? this.dec(s.passwordEnc) : undefined; } catch { return all('password_unreadable'); }
    const transport = createTransport({
      host: r.address, port: s.port,
      secure: s.tlsMode === 'implicit', requireTLS: s.tlsMode === 'starttls', ignoreTLS: s.tlsMode === 'none',
      ...(s.username ? { auth: { user: s.username, pass: pass ?? '' } } : {}),
      tls: { ...(isIP(h.host) ? {} : { servername: h.host }), rejectUnauthorized: true, minVersion: 'TLSv1.2' },
      connectionTimeout: 10_000, greetingTimeout: 10_000, socketTimeout: 30_000, dnsTimeout: 5_000,
      // Nothing in a message may be read from disk or fetched from a URL.
      disableFileAccess: true, disableUrlAccess: true, logger: false, debug: false,
    });
    const out: SendResult[] = [];
    try {
      for (const addr of to) {
        try {
          await transport.sendMail({
            from: s.fromName ? { name: s.fromName, address: s.fromAddress } : s.fromAddress,
            to: addr, subject: mail.subject, text: mail.text,
            attachments: (opts.attachments ?? []).map((x) => ({ filename: x.filename, content: x.content, contentType: x.contentType })),
            headers: { 'Auto-Submitted': 'auto-generated', 'X-Auto-Response-Suppress': 'All' },
          });
          out.push({ ok: true, status: 'sent' });
        } catch (e) {
          out.push({ ok: false, status: this.errorCode(e) });
        }
      }
    } finally { transport.close(); }
    return out;
  }

  /** A short code for a send failure. Never the server's text: it can echo what was sent, the username included. */
  private errorCode(e: unknown): string {
    const x = e as { code?: string; responseCode?: number };
    const code = typeof x.code === 'string' && /^[A-Z_]{2,24}$/.test(x.code) ? x.code : 'ERROR';
    return typeof x.responseCode === 'number' ? `${code} ${x.responseCode}` : code;
  }

  /** Send to recipients by id: only those still confirmed and in `scopeKey` are used. */
  async sendToRecipients(ids: string[], scopeKey: string, mail: Mail, opts: { customerId: string | null; attachments?: Attachment[] }) {
    const rows = ids.length ? await this.prisma.emailRecipient.findMany({ where: { id: { in: ids }, scopeKey, verifiedAt: { not: null } } }) : [];
    const byId = new Map(rows.map((r) => [r.id, r]));
    const usable = ids.filter((id) => byId.has(id));
    const sent = await this.send(usable.map((id) => byId.get(id)!.address), mail, opts);
    const res = new Map(usable.map((id, i) => [id, sent[i]]));
    return ids.map((id) => ({ recipientId: id, to: byId.has(id) ? maskAddress(byId.get(id)!.address) : null, ...(res.get(id) ?? { ok: false, status: 'recipient_not_confirmed' }) }));
  }

  // ── Recipients ────────────────────────────────────────────────────────────

  /** The scope a recipient request is about, checked against who may manage it. */
  private async scopeOf(a: ActorContext, scope: 'global' | 'business', businessId?: string | null) {
    if (scope === 'global') {
      if (businessId) throw new BadRequestException({ code: 'INVALID_REQUEST', message: 'A global recipient names no business.' });
      if (!isMspActor(a)) throw new ForbiddenException({ code: 'NOT_ALLOWED', message: 'Global recipients are managed by the MSP.' });
      return { scopeKey: 'global', customerId: null as string | null, name: 'Your MSP', tenantId: a.tenantId };
    }
    const id = businessId ?? a.businessId;
    if (!id || !ID.test(id)) throw new BadRequestException({ code: 'INVALID_REQUEST', message: 'businessId is required.' });
    const c = await this.prisma.customer.findUnique({ where: { id }, select: { id: true, name: true, tenantId: true } });
    // Another business's list looks like a missing one.
    if (!c || (!isMspActor(a) && a.businessId !== c.id)) throw new NotFoundException('Business not found');
    if (!mayManageNotifications(a, c.id, this.acl.isBusinessOwner(a))) {
      throw new ForbiddenException({ code: 'NOT_ALLOWED', message: 'Email recipients are managed by a Business Owner of this business, or by the MSP.' });
    }
    return { scopeKey: `b:${c.id}`, customerId: c.id as string | null, name: c.name, tenantId: c.tenantId as string | null };
  }

  private recipientView(r: EmailRecipient) {
    return { id: r.id, scopeKey: r.scopeKey, businessId: r.customerId, address: r.address, label: r.label, verified: !!r.verifiedAt, verifiedAt: r.verifiedAt, lastSentAt: r.lastSentAt, tokenExpiresAt: r.verifiedAt ? null : r.tokenExpiresAt, createdAt: r.createdAt };
  }

  async listRecipients(a: ActorContext, scope: 'global' | 'business', businessId?: string | null) {
    const s = await this.scopeOf(a, scope, businessId);
    const rows = await this.prisma.emailRecipient.findMany({ where: { scopeKey: s.scopeKey }, orderBy: [{ address: 'asc' }], take: MAX_RECIPIENTS_PER_SCOPE * 2 });
    return { scopeKey: s.scopeKey, businessId: s.customerId, recipients: rows.map((r) => this.recipientView(r)), email: await this.status() };
  }

  /** Recipients a policy or schedule in `scopeKey` may name — confirmed ones only. For pickers. */
  async confirmedIn(scopeKey: string) {
    return this.prisma.emailRecipient.findMany({ where: { scopeKey, verifiedAt: { not: null } }, orderBy: { address: 'asc' }, take: MAX_RECIPIENTS_PER_SCOPE });
  }

  async addRecipient(a: ActorContext, raw: unknown) {
    const d = RecipientInput.safeParse(raw ?? {});
    if (!d.success) throw bad(d.error);
    const address = normaliseAddress(d.data.address);
    if (!address) throw new BadRequestException({ code: 'INVALID_ADDRESS', message: 'Enter one plain address, like noc@example.com.' });
    const s = await this.scopeOf(a, d.data.scope, d.data.businessId);
    const existing = await this.prisma.emailRecipient.findUnique({ where: { scopeKey_address: { scopeKey: s.scopeKey, address } } });
    if (existing?.verifiedAt) throw new ConflictException({ code: 'ALREADY_CONFIRMED', message: 'That address is already confirmed here.' });
    if (!existing && (await this.prisma.emailRecipient.count({ where: { scopeKey: s.scopeKey } })) >= MAX_RECIPIENTS_PER_SCOPE) {
      throw new BadRequestException({ code: 'TOO_MANY', message: `At most ${MAX_RECIPIENTS_PER_SCOPE} addresses per business. Remove one first.` });
    }
    const label = d.data.label ? oneLine(d.data.label, 60) : null;
    const row = existing
      ? await this.prisma.emailRecipient.update({ where: { id: existing.id }, data: { label: label ?? existing.label } })
      : await this.prisma.emailRecipient.create({ data: { scopeKey: s.scopeKey, customerId: s.customerId, address, label, addedById: a.userId } });
    const sent = await this.sendVerification(row, s.name);
    await this.audit.log({
      action: 'EMAIL_RECIPIENT_ADDED', actorId: a.userId, actorIp: a.ip, tenantId: s.tenantId ?? undefined, customerId: s.customerId ?? undefined,
      resource: 'email_recipient', resourceId: row.id, meta: { scope: s.scopeKey, address, label, again: !!existing, confirmationSent: sent.status },
    });
    return { ...this.recipientView((await this.prisma.emailRecipient.findUnique({ where: { id: row.id } }))!), confirmation: sent };
  }

  async resendVerification(a: ActorContext, id: string) {
    const r = await this.recipientFor(a, id);
    if (r.verifiedAt) throw new ConflictException({ code: 'ALREADY_CONFIRMED', message: 'That address is already confirmed.' });
    if (r.lastSentAt && Date.now() - r.lastSentAt.getTime() < RESEND_AFTER_MS) {
      throw new ConflictException({ code: 'TOO_SOON', message: 'A confirmation was sent less than five minutes ago.' });
    }
    const name = r.customerId ? (await this.prisma.customer.findUnique({ where: { id: r.customerId }, select: { name: true } }))?.name ?? 'A business' : 'Your MSP';
    const sent = await this.sendVerification(r, name);
    await this.audit.log({ action: 'EMAIL_RECIPIENT_ADDED', actorId: a.userId, actorIp: a.ip, tenantId: a.tenantId ?? undefined, customerId: r.customerId ?? undefined, resource: 'email_recipient', resourceId: r.id, meta: { scope: r.scopeKey, address: r.address, again: true, confirmationSent: sent.status } });
    return { ...this.recipientView((await this.prisma.emailRecipient.findUnique({ where: { id: r.id } }))!), confirmation: sent };
  }

  private async sendVerification(r: EmailRecipient, who: string): Promise<SendResult> {
    const token = randomBytes(32).toString('base64url');
    const s = await this.settingsRow();
    if (!s?.enabled) return { ok: false, status: 'email_off' };
    const pause = await activePause(this.prisma, 'notifications', r.customerId);
    if (pause) throw new ForbiddenException({ code: 'CONTAINED', message: pauseMessage(pause, 'notifications'), pauseId: pause.id, scope: pause.scope.toLowerCase() });
    await this.prisma.emailRecipient.update({ where: { id: r.id }, data: { tokenHash: sha(token), tokenExpiresAt: new Date(Date.now() + TOKEN_TTL_MS), lastSentAt: new Date() } });
    const [res] = await this.send([r.address], verificationMail(who, `${this.urls.web()}/verify-email?token=${token}`), { customerId: r.customerId });
    return res;
  }

  private async recipientFor(a: ActorContext, id: string) {
    if (!ID.test(id)) throw new NotFoundException('Recipient not found');
    const r = await this.prisma.emailRecipient.findUnique({ where: { id } });
    if (!r) throw new NotFoundException('Recipient not found');
    if (r.scopeKey === 'global') { if (!isMspActor(a)) throw new NotFoundException('Recipient not found'); }
    else if (!isMspActor(a) && a.businessId !== r.customerId) throw new NotFoundException('Recipient not found');
    else if (!mayManageNotifications(a, r.customerId, this.acl.isBusinessOwner(a))) throw new ForbiddenException({ code: 'NOT_ALLOWED', message: 'Email recipients are managed by a Business Owner of this business, or by the MSP.' });
    return r;
  }

  async removeRecipient(a: ActorContext, id: string) {
    const r = await this.recipientFor(a, id);
    await this.prisma.emailRecipient.delete({ where: { id: r.id } });
    await this.audit.log({ action: 'EMAIL_RECIPIENT_REMOVED', actorId: a.userId, actorIp: a.ip, tenantId: a.tenantId ?? undefined, customerId: r.customerId ?? undefined, resource: 'email_recipient', resourceId: r.id, meta: { scope: r.scopeKey, address: r.address } });
    return { removed: true };
  }

  /**
   * The confirmation link, posted by the page it opens (a GET never
   * confirms: mail scanners follow links). Single use: the token is
   * consumed by a conditional update, so two clicks cannot both confirm.
   */
  async verify(raw: unknown) {
    const d = z.object({ token: z.string().regex(/^[A-Za-z0-9_-]{40,64}$/) }).strict().safeParse(raw ?? {});
    if (!d.success) throw new BadRequestException({ code: 'INVALID_TOKEN', message: 'This confirmation link is not valid.' });
    const hash = sha(d.data.token);
    const now = new Date();
    const r = await this.prisma.emailRecipient.findUnique({ where: { tokenHash: hash } });
    const u = await this.prisma.emailRecipient.updateMany({ where: { tokenHash: hash, verifiedAt: null, tokenExpiresAt: { gt: now } }, data: { verifiedAt: now, tokenHash: null, tokenExpiresAt: null } });
    if (!u.count || !r) throw new BadRequestException({ code: 'INVALID_TOKEN', message: 'This confirmation link is not valid, was already used, or has expired. Ask for a new one.' });
    await this.audit.log({ action: 'EMAIL_RECIPIENT_VERIFIED', customerId: r.customerId ?? undefined, resource: 'email_recipient', resourceId: r.id, meta: { scope: r.scopeKey, address: r.address } });
    return { confirmed: true, address: maskAddress(r.address) };
  }

  /** For a policy or schedule being saved: every id must be a confirmed recipient of exactly this scope. */
  async assertConfirmed(ids: string[], scopeKey: string) {
    const uniq = [...new Set(ids)];
    const n = uniq.length ? await this.prisma.emailRecipient.count({ where: { id: { in: uniq }, scopeKey, verifiedAt: { not: null } } }) : 0;
    if (n !== uniq.length) {
      throw new BadRequestException({ code: 'RECIPIENT_NOT_CONFIRMED', message: 'Every email recipient must be a confirmed address of this business (Settings → Monitoring → Email recipients).' });
    }
    return uniq;
  }

  /** For displays: id → address, for recipients in scope. */
  async addresses(ids: string[], scopeKey: string) {
    const rows = ids.length ? await this.prisma.emailRecipient.findMany({ where: { id: { in: ids }, scopeKey }, select: { id: true, address: true, verifiedAt: true, label: true } }) : [];
    return new Map(rows.map((r) => [r.id, r]));
  }
}
