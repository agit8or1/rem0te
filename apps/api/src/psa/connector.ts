/**
 * A PSA connector (0.48): how a ticket draft reaches a ticketing system.
 *
 * Three ship: email-to-ticket (the PSA's inbound support address, through the
 * §42 relay, confirmed by its mailbox first), webhook (HTTPS POST of a fixed
 * JSON body, optionally HMAC-signed) and ClientSt0r (a signed
 * `ticket.create_request` event, offered only when the peer advertises it).
 *
 * Adding a native API connector (HaloPSA, Autotask, ConnectWise REST…) is one
 * new file in ./connectors implementing PsaDriver, plus its kind in KINDS and
 * in migration CHECK `PsaConnector_kind`. Its outbound HTTP must go through
 * common/safe-https.ts, its secrets through common/secret-box.ts, and it must
 * never put a secret in `view()`.
 */
import type { PsaConnector } from '@prisma/client';
import type { EmailService } from '../email/email.service';
import type { PrismaService } from '../prisma/prisma.service';
import type { TicketDraft } from './ticket';

export const KINDS = ['email', 'webhook', 'clientst0r'] as const;
export type Kind = (typeof KINDS)[number];

export interface Scope { scopeKey: string; customerId: string | null }

export interface DriverDeps {
  prisma: PrismaService;
  email: EmailService;
  encKey: string | undefined;
}

/** The fields a driver writes on the connector row. */
export type ConnectorFields = Pick<PsaConnector, 'emailRecipientId' | 'webhookUrl' | 'webhookSecretEnc'>;

export interface SendResult { ok: boolean; status: string; ref?: string | null; url?: string | null }

export interface PsaDriver {
  kind: Kind;
  label: string;
  /**
   * Validate the kind-specific part of a save. `current` is the row being
   * replaced, if it is the same kind (a secret may be kept). Throws a 400.
   */
  parse(raw: Record<string, unknown>, scope: Scope, current: PsaConnector | null, deps: DriverDeps): Promise<ConnectorFields & { audit: Record<string, unknown> }>;
  /** What the settings page shows. Never a secret. */
  view(row: PsaConnector, deps: DriverDeps): Promise<Record<string, unknown>>;
  /** Whether a ticket for a computer of `customerId` can be sent now, and if not why (said on the button). */
  ready(row: PsaConnector, deps: DriverDeps, customerId: string | null): Promise<{ ok: true } | { ok: false; reason: string }>;
  send(row: PsaConnector, draft: TicketDraft, deps: DriverDeps): Promise<SendResult>;
}
