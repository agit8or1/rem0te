'use client';

/**
 * Shared pieces of the Mobile devices pages (0.80 Tablet). Everything the
 * API sends is drawn as text: names, models and the provider's compliance
 * reason come from a third party.
 */
import { Badge } from '@/components/ui/badge';

export type ComplianceState = 'compliant' | 'noncompliant' | 'in_grace_period' | 'not_evaluated' | 'unknown';
export type CommandState = 'queued' | 'sent' | 'acknowledged' | 'completed' | 'failed' | 'expired';

export interface MobileDevice {
  id: string; name: string | null; business: { id: string; name: string } | null;
  provider: string; providerLabel: string; providerDeviceId: string;
  platform: string; platformLabel: string; ownership: 'corporate' | 'byod'; ownershipLabel: string;
  managementScope: 'device' | 'work_profile' | 'user_enrollment'; managementScopeLabel: string;
  enrollmentState: string; enrollmentLabel: string; enrolledAt: string | null;
  complianceState: ComplianceState; complianceLabel: string; complianceReason: string | null;
  model: string | null; manufacturer: string | null; osVersion: string | null; serialNumber: string | null;
  storage: { totalBytes: number; freeBytes: number | null } | null;
  lastCheckInAt: string | null; lastSyncedAt: string; notReportedSince: string | null;
}

export interface MobileCommand {
  id: string; kind: string; kindLabel: string; destructive: boolean; origin: 'portal' | 'provider'; requestedBy?: string | null;
  state: CommandState; stateLabel: string; requestedAt: string; sentAt: string | null;
  providerAccepted: { done: boolean; at: string | null };
  deviceCompleted: { done: boolean; at: string | null };
  waitingFor: 'send' | 'provider' | 'device' | null;
  failedAt: string | null; failureCode: string | null; expiresAt: string | null; expiredAt: string | null;
}

export interface Connector {
  id: string; business: { id: string; name: string } | null; provider: string; providerLabel: string;
  enabled: boolean; ready: boolean; reason: string | null; lastSyncAt: string | null; lastSyncResult: string | null; lastSyncDevices: number | null; devices: number;
}

export interface Setup {
  state: 'available' | 'requires_setup';
  connectors: Connector[];
  sweep: { enabled: boolean };
  readOnly: true;
  prerequisites: { key: string; title: string; needs: string; plannedIn: string }[];
}

const COMPLIANCE_VARIANT: Record<ComplianceState, 'success' | 'destructive' | 'warning' | 'secondary'> = {
  compliant: 'success', noncompliant: 'destructive', in_grace_period: 'warning', not_evaluated: 'secondary', unknown: 'secondary',
};

export function ComplianceBadge({ state, label }: { state: ComplianceState; label: string }) {
  return <Badge variant={COMPLIANCE_VARIANT[state] ?? 'secondary'} data-compliance={state}>{label}</Badge>;
}

const STATE_VARIANT: Record<CommandState, 'success' | 'destructive' | 'warning' | 'secondary' | 'outline'> = {
  queued: 'outline', sent: 'secondary', acknowledged: 'warning', completed: 'success', failed: 'destructive', expired: 'secondary',
};

export function CommandStateBadge({ state, label }: { state: CommandState; label: string }) {
  return <Badge variant={STATE_VARIANT[state] ?? 'secondary'} data-state={state}>{label}</Badge>;
}

export function RequiresSetupBadge() {
  return <Badge variant="warning" data-testid="mdm-requires-setup">Requires setup</Badge>;
}

export function formatBytes(n: number | null | undefined): string {
  if (n === null || n === undefined) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let v = n, i = 0;
  while (v >= 1000 && i < units.length - 1) { v /= 1000; i++; }
  return `${v >= 10 || i === 0 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

/**
 * 0.86: a phone or tablet can be locked, or put in and out of lost mode,
 * from its own page by someone holding mobile:act. Nothing can be erased.
 */
export const READ_ONLY_NOTE = 'Rem0te shows what the phone or tablet reports. From a device\'s page it can be locked, or put in and out of lost mode; nothing can be erased or wiped from Rem0te.';
