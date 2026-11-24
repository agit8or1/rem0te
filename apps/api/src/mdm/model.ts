/**
 * Mobile devices (0.80 Tablet, roadmap 3.1): the closed lists.
 *
 * Pure data: this file imports nothing. Every list here is also a CHECK in
 * migration 0096, word for word, and check-security-invariants §90 compares
 * the two. Adding a value is a migration and an invariant change in the same
 * commit.
 *
 * iOS, iPadOS and Android are managed only through an external MDM provider
 * (docs/mobile-devices.md). The Rem0te agent never runs on them, and nothing
 * here reaches a phone: in 0.80 the portal only reads what a provider reports.
 */

/**
 * Providers a connector may name. 0.80: the loopback stand-in (test only).
 * 0.84: `apple`, Rem0te's own MDM server for iPhones and iPads
 * (docs/own-mdm.md M2): the first real driver, which reads Rem0te's own
 * Apple tables and calls no provider.
 */
export const PROVIDERS = ['standin', 'apple'] as const;
export type Provider = (typeof PROVIDERS)[number];

export const PLATFORMS = ['ios', 'ipados', 'android'] as const;
export type Platform = (typeof PLATFORMS)[number];

/** Corporate-owned, or the person's own device (BYOD). */
export const OWNERSHIPS = ['corporate', 'byod'] as const;
export type Ownership = (typeof OWNERSHIPS)[number];

/**
 * How much of the device the provider manages:
 *   device           the whole device (Apple supervised / ADE, Android fully managed);
 *   work_profile     an Android work profile on a personal device: only the profile is managed;
 *   user_enrollment  Apple account-driven User Enrollment: only managed apps and data.
 * work_profile is Android's and user_enrollment Apple's (0096 CHECK).
 */
export const MANAGEMENT_SCOPES = ['device', 'work_profile', 'user_enrollment'] as const;
export type ManagementScope = (typeof MANAGEMENT_SCOPES)[number];

/**
 * Enrollment as the provider reports it. `not_reported` is Rem0te's: a device
 * a complete sync no longer returned (removed at the provider, or retired).
 */
export const ENROLLMENT_STATES = ['pending', 'enrolled', 'unenrolled', 'not_reported'] as const;
export type EnrollmentState = (typeof ENROLLMENT_STATES)[number];

/** The provider evaluates compliance; Rem0te only shows it. */
export const COMPLIANCE_STATES = ['compliant', 'noncompliant', 'in_grace_period', 'not_evaluated', 'unknown'] as const;
export type ComplianceState = (typeof COMPLIANCE_STATES)[number];

/**
 * Command kinds. None can be sent from Rem0te in 0.80: these are the kinds a
 * provider may report having run (issued in its own console), and the closed
 * list 3.3 (lost-device) and 3.4 (destructive, with a second approver) will
 * send from.
 */
export const COMMAND_KINDS = [
  'sync', 'lock', 'locate', 'lost_mode_start', 'lost_mode_stop',
  'retire', 'remove_managed_data', 'wipe',
] as const;
export type CommandKind = (typeof COMMAND_KINDS)[number];

/** Kinds that remove data or management (3.4: decision 16, a second person approves). */
export const DESTRUCTIVE_KINDS: readonly CommandKind[] = ['retire', 'remove_managed_data', 'wipe'];

export const COMMAND_STATES = ['queued', 'sent', 'acknowledged', 'completed', 'failed', 'expired'] as const;
export type CommandState = (typeof COMMAND_STATES)[number];

/** Where a command came from: Rem0te (3.3 onwards) or the provider's own console (read by the sync). */
export const COMMAND_ORIGINS = ['portal', 'provider'] as const;
export type CommandOrigin = (typeof COMMAND_ORIGINS)[number];

/** A connector's last sync result. Closed: 0096 CHECKs it. */
export const SYNC_RESULTS = ['ok', 'partial', 'not_ready', 'paused', 'unreachable', 'bad_response', 'refused'] as const;
export type SyncResult = (typeof SYNC_RESULTS)[number];

export const PROVIDER_LABEL: Record<Provider, string> = { standin: 'Stand-in (tests only)', apple: 'Rem0te (Apple)' };
export const PLATFORM_LABEL: Record<Platform, string> = { ios: 'iOS', ipados: 'iPadOS', android: 'Android' };
export const OWNERSHIP_LABEL: Record<Ownership, string> = { corporate: 'Corporate', byod: 'Personal (BYOD)' };
export const SCOPE_LABEL: Record<ManagementScope, string> = {
  device: 'Whole device', work_profile: 'Work profile only', user_enrollment: 'Managed apps and data only',
};
export const ENROLLMENT_LABEL: Record<EnrollmentState, string> = {
  pending: 'Enrollment pending', enrolled: 'Enrolled', unenrolled: 'Unenrolled', not_reported: 'No longer reported',
};
export const COMPLIANCE_LABEL: Record<ComplianceState, string> = {
  compliant: 'Compliant', noncompliant: 'Not compliant', in_grace_period: 'In grace period', not_evaluated: 'Not evaluated', unknown: 'Unknown',
};
export const COMMAND_KIND_LABEL: Record<CommandKind, string> = {
  sync: 'Sync', lock: 'Lock', locate: 'Locate', lost_mode_start: 'Start lost mode', lost_mode_stop: 'Stop lost mode',
  retire: 'Retire', remove_managed_data: 'Remove work data', wipe: 'Wipe',
};
export const COMMAND_STATE_LABEL: Record<CommandState, string> = {
  queued: 'Queued', sent: 'Sent to provider', acknowledged: 'Accepted by provider', completed: 'Completed on device',
  failed: 'Failed', expired: 'Expired',
};

/** Charsets for what a provider sends. Anything else is refused before it is stored. */
export const PROVIDER_ID_RE = /^[A-Za-z0-9._:-]{1,128}$/;
export const EXTERNAL_TENANT_RE = /^[A-Za-z0-9._-]{1,64}$/;
export const CURSOR_RE = /^[A-Za-z0-9._~-]{1,128}$/;
export const FAILURE_CODE_RE = /^[a-z0-9_.:-]{1,64}$/;
export const SERIAL_RE = /^[A-Za-z0-9-]{4,40}$/;

export const isOneOf = <T extends string>(list: readonly T[], v: unknown): v is T => typeof v === 'string' && (list as readonly string[]).includes(v);
