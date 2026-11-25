/**
 * Email-to-ticket (0.48). ConnectWise, Autotask, HaloPSA, Syncro, Freshdesk,
 * Zendesk and most others open a ticket from mail to their inbound support
 * address. That address is an EmailRecipient of the connector's own scope,
 * so it is usable only once someone reading that mailbox (the PSA's own
 * inbox shows the confirmation mail as a ticket) clicked the link — the
 * §42 rule, reused as it is. Sending goes through EmailService, so the relay
 * checks, the notifications pause and the one-recipient-per-message rule
 * all apply.
 */
import { BadRequestException } from '@nestjs/common';
import { maskAddress } from '../../email/mail-content';
import type { PsaDriver } from '../connector';

export const emailDriver: PsaDriver = {
  kind: 'email',
  label: 'Email-to-ticket',

  async parse(raw, scope, _cur, deps) {
    const id = raw.emailRecipientId;
    if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{8,64}$/.test(id)) throw new BadRequestException({ code: 'INVALID_REQUEST', message: 'Pick the PSA\'s support address from this scope\'s email addresses (add it there first).' });
    const r = await deps.prisma.emailRecipient.findFirst({ where: { id, scopeKey: scope.scopeKey } });
    if (!r) throw new BadRequestException({ code: 'RECIPIENT_NOT_IN_SCOPE', message: 'That address is not one of this scope\'s email addresses.' });
    return { emailRecipientId: r.id, webhookUrl: null, webhookSecretEnc: null, audit: { to: maskAddress(r.address), confirmed: !!r.verifiedAt } };
  },

  async view(row, deps) {
    const r = row.emailRecipientId ? await deps.prisma.emailRecipient.findFirst({ where: { id: row.emailRecipientId, scopeKey: row.scopeKey } }) : null;
    return { emailRecipientId: row.emailRecipientId, address: r?.address ?? null, confirmed: !!r?.verifiedAt };
  },

  async ready(row, deps) {
    const r = row.emailRecipientId ? await deps.prisma.emailRecipient.findFirst({ where: { id: row.emailRecipientId, scopeKey: row.scopeKey } }) : null;
    if (!r) return { ok: false, reason: 'The PSA\'s support address was removed. Pick another under Administration → PSA / ticketing.' };
    if (!r.verifiedAt) return { ok: false, reason: 'The PSA\'s support address has not been confirmed yet: open the confirmation email that arrived as a ticket and follow its link.' };
    if (!(await deps.email.status()).enabled) return { ok: false, reason: 'Outbound email is off (Administration → Email).' };
    return { ok: true };
  },

  async send(row, draft, deps) {
    const [r] = await deps.email.sendToRecipients([row.emailRecipientId ?? ''], row.scopeKey, { subject: draft.subject, text: `${draft.body}\n\n— Sent from rem0te by ${draft.requestedBy}.` }, { customerId: draft.business.id });
    return { ok: r.ok, status: `email ${r.status}`, ref: null };
  },
};
