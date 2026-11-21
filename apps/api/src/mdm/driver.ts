/**
 * An MDM connector (0.80 Tablet, roadmap 3.1), on the PsaDriver pattern
 * (psa/connector.ts): how the portal reads a mobile-device provider.
 *
 * One driver ships: the loopback stand-in (drivers/standin.ts), which exists
 * only for the test suites and reaches nothing outside 127.0.0.1. No real
 * provider is connected, and no provider host appears anywhere in this
 * module (check-security-invariants §90).
 *
 * Adding a provider (3.2: the owner's existing one, read-only) is one new file
 * in ./drivers implementing MdmDriver, its key in PROVIDERS (model.ts) and in
 * migration CHECK `MdmConnector_provider_check`. Its outbound HTTP must go
 * through common/safe-https.ts (public DNS and TLS only: decision 17), its
 * credential through common/secret-box.ts under its own purpose, and it must
 * never put a credential in `view()` or an error.
 *
 * READ-ONLY in 0.80. The interface has no send, cancel or wipe: 3.3 adds
 * `send()` for the lost-device kinds and 3.4 the destructive ones behind a
 * second approver (decision 16). The command state machine they will use is
 * already here (command-state.ts).
 */
import type { MdmConnector } from '@prisma/client';
import type { Provider } from './model';

export type Ready = { ok: true } | { ok: false; reason: string };

/** One page of raw records and the cursor for the next (null: the listing is complete). */
export interface RawPage { records: unknown[]; next: string | null }

/** A driver failure: a short code the connector row records, never the provider's text. */
export class MdmDriverError extends Error {
  constructor(readonly code: 'unreachable' | 'bad_response' | 'refused' | 'not_ready', message: string) { super(message); this.name = 'MdmDriverError'; }
}

export interface MdmDriver {
  provider: Provider;
  label: string;
  /** Whether this connector can be read now, and if not why (shown on the setup panel). Never calls out. */
  ready(row: MdmConnector): Ready;
  /** One page of the provider's devices for this connector's tenant. Throws MdmDriverError. */
  listDevices(row: MdmConnector, cursor: string | null): Promise<RawPage>;
  /** One page of commands the provider reports for this tenant (issued in its own console). Throws MdmDriverError. */
  listCommands(row: MdmConnector, cursor: string | null): Promise<RawPage>;
}
