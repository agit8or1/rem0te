/**
 * Webhook (0.48): an HTTPS POST of a fixed JSON ticket body, for HaloPSA and
 * Syncro automations, Zapier, Make and n8n. The URL is a public HTTPS name
 * (checked on save, resolved and checked on every send, connected to the
 * checked address, certificate verified, no redirects: common/safe-https.ts).
 *
 * Optional signing: with a secret saved (AES-256-GCM, never returned), each
 * request carries
 *   X-Rem0te-Timestamp: <unix seconds>
 *   X-Rem0te-Signature: sha256=<hex HMAC-SHA256(secret, "<timestamp>.<body>")>
 * so the receiver can check it came from this server and is fresh.
 *
 * The receiver may answer with JSON naming the ticket — `ticket_id`, `id`,
 * `ticketId`, `number` or `ref`, and optionally `url` — which is kept as an
 * inert reference. The URL's path is often its secret, so only its host is
 * ever shown or audited.
 */
import { BadRequestException } from '@nestjs/common';
import { createHmac } from 'crypto';
import { checkPublicHttpsUrl, OutboundError, safePost } from '../../common/safe-https';
import { openSecret, sealSecret } from '../../common/secret-box';
import type { PsaDriver } from '../connector';
import { cleanRef, cleanUrl, type TicketDraft } from '../ticket';

export const WEBHOOK_TIMEOUT_MS = 15_000;
export const WEBHOOK_MAX_RESPONSE = 64 * 1024;

export const hostOf = (u: string | null) => { try { return u ? new URL(u).host : null; } catch { return null; } };

/** The fixed body. Exported so the unit test checks exactly what is sent. */
export function webhookBody(d: TicketDraft, sentAt: Date): string {
  return JSON.stringify({
    source: 'rem0te', type: 'ticket.create', version: 1, sent_at: sentAt.toISOString(),
    ticket: {
      subject: d.subject, body: d.body, note: d.note, link: d.link,
      computer: d.computer, business: d.business, requested_by: d.requestedBy, source_ref: d.sourceRef,
      event: d.event, alert: d.alert, ai: d.ai,
    },
  });
}

export function signature(secret: string, timestamp: string, body: string): string {
  return `sha256=${createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex')}`;
}

export const webhookDriver: PsaDriver = {
  kind: 'webhook',
  label: 'Webhook',

  async parse(raw, _scope, cur, deps) {
    const c = checkPublicHttpsUrl(raw.webhookUrl, 'The webhook URL');
    if (!c.ok) throw new BadRequestException({ code: 'INVALID_URL', message: c.reason });
    const url = c.url.toString();
    const given = raw.webhookSecret;
    let enc: string | null; let change: string;
    if (typeof given === 'string') {
      if (given.length < 16 || given.length > 256 || !/^[\x21-\x7e]+$/.test(given)) throw new BadRequestException({ code: 'INVALID_SECRET', message: 'The signing secret must be 16–256 printable characters with no spaces.' });
      enc = sealSecret(deps.encKey, 'rem0te-psa-webhook-secret-v1', given); change = 'set';
    } else if (given === null) { enc = null; change = cur?.webhookSecretEnc ? 'cleared' : 'none'; }
    // A secret is kept only for the same URL: pointing the webhook elsewhere drops it.
    else if (cur?.webhookSecretEnc && cur.webhookUrl === url) { enc = cur.webhookSecretEnc; change = 'kept'; }
    else { enc = null; change = cur?.webhookSecretEnc ? 'cleared_url_changed' : 'none'; }
    return { emailRecipientId: null, webhookUrl: url, webhookSecretEnc: enc, audit: { host: c.url.host, secret: change } };
  },

  async view(row) {
    return { webhookHost: hostOf(row.webhookUrl), webhookUrlSet: !!row.webhookUrl, signed: !!row.webhookSecretEnc };
  },

  async ready(row) {
    return row.webhookUrl ? { ok: true } : { ok: false, reason: 'No webhook URL is saved.' };
  },

  async send(row, draft, deps) {
    if (!row.webhookUrl) return { ok: false, status: 'not_configured' };
    const body = webhookBody(draft, new Date());
    const headers: Record<string, string> = { 'content-type': 'application/json', accept: 'application/json', 'user-agent': 'rem0te-psa/1' };
    if (row.webhookSecretEnc) {
      let secret: string;
      try { secret = openSecret(deps.encKey, 'rem0te-psa-webhook-secret-v1', row.webhookSecretEnc); } catch { return { ok: false, status: 'secret_unreadable' }; }
      const ts = String(Math.floor(Date.now() / 1000));
      headers['x-rem0te-timestamp'] = ts;
      headers['x-rem0te-signature'] = signature(secret, ts, body);
    }
    let res;
    try { res = await safePost(row.webhookUrl, headers, body, { timeoutMs: WEBHOOK_TIMEOUT_MS, maxBytes: WEBHOOK_MAX_RESPONSE }); }
    catch (e) { return { ok: false, status: e instanceof OutboundError ? e.code : 'NETWORK' }; }
    if (res.status < 200 || res.status >= 300) return { ok: false, status: `HTTP ${res.status}` };
    let j: Record<string, unknown> | null = null;
    try { j = JSON.parse(res.body.toString('utf8')); } catch { /* an empty or non-JSON 2xx is still a success */ }
    const ref = j && typeof j === 'object' ? cleanRef(j.ticket_id ?? j.ticketId ?? j.id ?? j.number ?? j.ref) : null;
    return { ok: true, status: `HTTP ${res.status}`, ref, url: j && typeof j === 'object' ? cleanUrl(j.url ?? j.ticket_url) : null };
  },
};
