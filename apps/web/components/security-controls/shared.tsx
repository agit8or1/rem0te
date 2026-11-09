'use client';

/**
 * Shapes and small pieces shared by Settings → Security → Technician Access,
 * the Security Features catalog and the Connect page's temporary-access card.
 * Shapes come from apps/api/src/security-controls (presets.ts,
 * policy-admin.service.ts, access-policy.service.ts).
 */
import { useQuery } from '@tanstack/react-query';
import { Lock, Ban } from 'lucide-react';
import { techniciansApi } from '@/lib/api-client';
import { cn } from '@/lib/utils';

// ─── Types ───────────────────────────────────────────────────────────────────

export type Mode = 'off' | 'allowed' | 'request';

export interface PresetPolicy {
  inventoryView: 'off' | 'allowed';
  supportRequests: 'off' | 'allowed';
  eventLogs: 'off' | 'allowed';
  diagnostics: 'off' | 'basic' | 'advanced';
  standardWorkstationsOnly: boolean;
  remoteViewOnly: Mode;
  remoteControl: Mode;
  elevation: Mode;
  unattended: Mode;
  clipboard: Mode;
  fileTransfer: Mode;
  credentialReveal: 'off';
  enrollment: 'off';
  scripts: 'off';
  patches: 'off' | 'request';
  fixRequests: 'off' | 'low_risk' | 'higher_risk';
  fixApproval: 'off';
  fleetExecution: 'off';
  maxSessionMinutes: number;
}
export type PolicyField = keyof PresetPolicy;

export interface ControlStatus { label: string; locked?: string; unavailable?: string }

export interface Preset {
  id: string;
  key: string;
  name: string;
  tier: 'L1' | 'L2' | 'L3' | string;
  builtIn: boolean;
  description: string;
  capabilities: string[];
  policy: PresetPolicy;
  version: number;
  _count?: { assignments: number };
}

export interface PresetList { presets: Preset[]; controlStatus: Record<string, ControlStatus> }

export interface TrustChange {
  id: string;
  kind: string;
  target: string;
  before: unknown;
  after: unknown;
  requestedById: string;
  status: string;
  widening: string[];
  createdAt: string;
  reviewedById?: string | null;
  reviewedAt?: string | null;
}

export interface TemporaryAccess {
  id: string;
  userId: string;
  customerId: string;
  endpointId: string;
  mode: 'CONTROL' | 'ELEVATION' | 'PROTECTED_EXCEPTION' | string;
  reason: string;
  durationMinutes: number;
  status: 'PENDING' | 'APPROVED' | 'DENIED' | 'REVOKED' | string;
  decidedById: string | null;
  decidedAt: string | null;
  decisionNote: string | null;
  activatedAt: string | null;
  expiresAt: string | null;
  createdAt: string;
}

export interface PersonLite {
  id: string;
  email: string;
  firstName: string | null;
  lastName: string | null;
  ownBusiness?: { id: string; name: string } | null;
}

/** A save that widens trust is diverted to independent review instead. */
export type ReviewResult<T extends string, V> =
  | ({ pendingReview: false } & { [K in T]: V })
  | { pendingReview: true; request: { id: string; widening: string[] } };

// ─── Errors ──────────────────────────────────────────────────────────────────

type ApiErr = { response?: { status?: number; data?: { code?: string; message?: string | string[] } } };

/** The server's code and readable message, verbatim. */
export function apiError(e: unknown, fallback = 'Something went wrong'): { code?: string; status?: number; message: string } {
  const r = (e as ApiErr)?.response;
  const m = r?.data?.message;
  const message = Array.isArray(m) ? m.join('; ') : m || (e as Error)?.message || fallback;
  return { code: r?.data?.code, status: r?.status, message };
}

/**
 * For decisions: NOT_INDEPENDENT means the person deciding is the person who
 * asked. The server's message already says so; this keeps the wording the
 * same wherever a decision is made.
 */
export function decisionError(e: unknown): string {
  const err = apiError(e, 'The decision was not recorded');
  if (err.code === 'NOT_INDEPENDENT') return `You requested this, so someone else must decide it. ${err.message}`;
  return err.message;
}

// ─── Display ─────────────────────────────────────────────────────────────────

export function personName(u: { firstName?: string | null; lastName?: string | null; email: string } | null | undefined) {
  if (!u) return '—';
  return `${u.firstName ?? ''} ${u.lastName ?? ''}`.trim() || u.email;
}

const VALUE_LABEL: Record<string, string> = {
  off: 'Off',
  allowed: 'Allowed in scope',
  request: 'Request time-limited',
  basic: 'Basic',
  advanced: 'Advanced',
  low_risk: 'Low-risk only',
  higher_risk: 'Up to higher-risk',
};

export function valueLabel(field: string, v: unknown): string {
  if (typeof v === 'boolean') return v ? 'Yes' : 'No';
  if (typeof v === 'number') return field === 'maxSessionMinutes' ? `${v} min` : String(v);
  return VALUE_LABEL[String(v)] ?? String(v);
}

export const CHIP = {
  off: 'bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300',
  on: 'bg-green-100 text-green-800 dark:bg-green-900/60 dark:text-green-200',
  request: 'bg-sky-100 text-sky-800 dark:bg-sky-900/60 dark:text-sky-200',
  locked: 'bg-slate-200 text-slate-800 dark:bg-slate-700 dark:text-slate-100',
  warn: 'bg-amber-100 text-amber-800 dark:bg-amber-900/60 dark:text-amber-200',
  bad: 'bg-red-100 text-red-800 dark:bg-red-900/60 dark:text-red-200',
} as const;

export function Chip({ className, title, children }: { className: string; title?: string; children: React.ReactNode }) {
  return (
    <span title={title} className={cn('inline-flex items-center gap-1 whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium', className)}>
      {children}
    </span>
  );
}

function valueChipClass(v: unknown): string {
  if (v === 'off' || v === false) return CHIP.off;
  if (v === 'request') return CHIP.request;
  return CHIP.on;
}

/**
 * The chip for one preset control: Locked and Unavailable take precedence
 * over the value, because the value of a locked or unenforceable control is
 * not something the tier actually gets to use.
 */
export function ControlChip({ field, value, status }: { field: string; value: unknown; status?: ControlStatus }) {
  if (status?.locked) return <Chip className={CHIP.locked} title={status.locked}><Lock className="h-3 w-3" />Locked</Chip>;
  if (status?.unavailable) {
    return <Chip className={CHIP.warn} title={status.unavailable}><Ban className="h-3 w-3" />Unavailable</Chip>;
  }
  return <Chip className={valueChipClass(value)}>{valueLabel(field, value)}</Chip>;
}

export const DECISION_STYLE: Record<string, string> = {
  allowed: CHIP.on,
  denied: CHIP.bad,
  unavailable: CHIP.warn,
  requires_request: CHIP.request,
};

/** People the manager can see, keyed by id, for turning ids into names. */
export function usePeople() {
  return useQuery<PersonLite[]>({
    queryKey: ['technicians', 'people'],
    queryFn: () => techniciansApi.people().then((r) => r.data?.data ?? []),
    retry: false,
  });
}

export function JsonBlock({ value }: { value: unknown }) {
  return (
    <pre className="max-h-64 overflow-auto rounded-md bg-muted p-2 text-xs leading-relaxed">
      {JSON.stringify(value, null, 2)}
    </pre>
  );
}
