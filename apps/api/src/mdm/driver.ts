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
 * READ-ONLY in 0.80. 0.86 (docs/own-mdm.md M4, §95) adds `send()` for the
 * three lost-device kinds (lost-device.ts) and nothing else: no cancel, no
 * wipe. 3.4 adds the destructive ones behind a second approver (decision
 * 16). Only MdmActionService calls send(), after scope, mobile:act, the fresh
 * confirmation, the device's own refusals, the containment pauses and the
 * audit row (logOrFail). The command state machine is command-state.ts.
 */
import type { MdmConnector, MobileDevice } from '@prisma/client';
import type { LostDeviceKind } from './lost-device';
import type { Provider } from './model';

export type Ready = { ok: true } | { ok: false; reason: string };

/** One page of raw records and the cursor for the next (null: the listing is complete). */
export interface RawPage { records: unknown[]; next: string | null }

/** A driver failure: a short code the connector row records, never the provider's text. */
export class MdmDriverError extends Error {
  constructor(readonly code: 'unreachable' | 'bad_response' | 'refused' | 'not_ready', message: string) { super(message); this.name = 'MdmDriverError'; }
}

/**
 * One lost-device command to send (0.86). `ref` is Rem0te's own id for it,
 * already recorded as the command's providerCommandId: a provider that lets
 * Rem0te name the command (its own Apple queue) uses it, so the sync can
 * never see the command before Rem0te's row names it. The message and phone
 * number are handed to the provider and nowhere else.
 */
export interface OutgoingCommand {
  ref: string;
  kind: LostDeviceKind;
  message: string | null;
  phoneNumber: string | null;
  expiresAt: Date;
}

/**
 * What the provider said. `providerCommandId` is its id for the command
 * (Apple: `ref`; Android: `<device>:<operation>`). `acceptedAt` is set only
 * when the provider took it in the same call (Android's Operation); Apple
 * accepts when the device fetches it, which the sync reads later.
 */
export interface SendResult { providerCommandId: string; acceptedAt: Date | null }

/** A send failure: a short code for the command's failureCode (`provider_rejected:<code>`), never the provider's text. */
export class MdmSendError extends Error {
  constructor(readonly code: 'unsupported' | 'not_ready' | 'refused' | 'conflict' | 'unreachable' | 'bad_response' | 'quota') { super(code); this.name = 'MdmSendError'; }
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
  /** Send one lost-device command to one device (0.86). Throws MdmSendError. */
  send(row: MdmConnector, device: MobileDevice, cmd: OutgoingCommand): Promise<SendResult>;
}
