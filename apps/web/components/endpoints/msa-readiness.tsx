'use client';

import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { Info, ShieldQuestion } from 'lucide-react';
import { msaApi } from '@/lib/api-client';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import { CardHeading } from '@/components/endpoints/card-heading';
import { cn, formatDate } from '@/lib/utils';
import { MsaManagedControls } from '@/components/endpoints/msa-managed';
import { MsaSessionsList } from '@/components/endpoints/msa-sessions';

/**
 * Managed Secure Access readiness (0.69): what the signed agent's read-only
 * RustDesk preflight says about a computer, as decided by the API's
 * msa/readiness.ts. Display only. Nothing on this card, or behind it,
 * changes a setting, a password or a session — the card says so first.
 */

export type MsaState = 'unsupported' | 'upgrade_available' | 'compatible' | 'unknown' | 'managed' | 'managed_verified' | 'enforcement_failure';

export interface MsaReadiness {
  state: MsaState; label: string; reasons: string[]; verified: boolean;
  checkedAt: string | null; rustdeskVersion: string | null; labTested: boolean | null;
}
export interface MsaEndpointView {
  endpointId: string;
  readiness: MsaReadiness;
  preflight: {
    checkedAt: string; installed: boolean; expectedPath: boolean; version: string | null; build: string; service: string;
    cli: string; keysOk: number; keysTotal: number;
  } | null;
  note: string;
  labTested: { versions: string[]; min: string; max: string };
  minAgent: string;
  /** 0.72: MSA_GRANTS is on, so the managed routes exist. Absent or false: never ask them. */
  managedControls?: boolean;
}

/** The one sentence every readiness view leads with (the API's READINESS_NOTE). */
export const MSA_NOTE = 'Readiness only — Managed Secure Access is not available yet; nothing has changed on this device.';
export const MSA_FLEET_NOTE = 'Readiness only — Managed Secure Access is not available yet; nothing has changed on any device.';

const TONE: Record<MsaState, string> = {
  compatible: 'border-emerald-600/40 text-emerald-800 dark:text-emerald-300',
  upgrade_available: 'border-amber-600/40 text-amber-800 dark:text-amber-300',
  unsupported: 'border-muted-foreground/40 text-muted-foreground',
  unknown: 'border-muted-foreground/40 text-muted-foreground',
  managed: 'border-sky-600/40 text-sky-800 dark:text-sky-300',
  managed_verified: 'border-emerald-600/40 text-emerald-800 dark:text-emerald-300',
  enforcement_failure: 'border-destructive/50 text-destructive',
};

export function MsaStateBadge({ state, label, testId }: { state: MsaState; label: string; testId?: string }) {
  return <Badge variant="outline" className={cn('font-medium', TONE[state])} data-state={state} data-testid={testId}>{label}</Badge>;
}

export function MsaNote({ text = MSA_NOTE, testId }: { text?: string; testId?: string }) {
  return (
    <div className="flex gap-2 rounded-md border border-sky-500/40 bg-sky-500/5 px-3 py-2 text-xs" data-testid={testId}>
      <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
      <p>{text}</p>
    </div>
  );
}

const BUILD_LABEL: Record<string, string> = { flutter: 'Flutter', sciter: 'Sciter', unknown: 'not recognised' };
const SERVICE_LABEL: Record<string, string> = { running: 'running', stopped: 'stopped', missing: 'not installed', other: 'not running normally' };

/** The device page's card (Overview, beside the Agent card). */
export function MsaReadinessCard({ endpointId }: { endpointId: string }) {
  const { data, isLoading, isError } = useQuery<MsaEndpointView>({
    queryKey: ['msa-readiness', endpointId],
    queryFn: () => msaApi.forEndpoint(endpointId).then((r) => r.data?.data),
    retry: false,
  });
  const r = data?.readiness;
  const pf = data?.preflight;
  return (
    <Card data-testid="msa-readiness-card">
      <CardHeading
        title="Secure remote access readiness"
        icon={ShieldQuestion}
        aside={<Link href="/endpoints/remote-readiness" className="text-xs text-muted-foreground underline-offset-2 hover:underline" data-testid="msa-card-fleet-link">All devices</Link>}
      />
      <CardContent className="space-y-2.5 text-sm">
        <MsaNote testId="msa-card-note" text={data?.note ?? MSA_NOTE} />
        {isLoading && <p className="text-muted-foreground">Loading…</p>}
        {isError && <p className="text-muted-foreground">Readiness could not be loaded.</p>}
        {r && (
          <>
            <div className="flex flex-wrap items-center gap-2">
              <MsaStateBadge state={r.state} label={r.label} testId="msa-card-state" />
              {r.checkedAt && <span className="text-xs text-muted-foreground" title={formatDate(r.checkedAt)}>checked {formatDate(r.checkedAt)}</span>}
            </div>
            <ul className="list-disc space-y-1 pl-5 text-xs" data-testid="msa-card-reasons">
              {r.reasons.map((t, i) => <li key={i}>{t}</li>)}
            </ul>
            {pf && (
              <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs" data-testid="msa-card-facts">
                <dt className="text-muted-foreground">RustDesk</dt>
                <dd className="min-w-0 break-words">{pf.version ?? 'version not read'} · {BUILD_LABEL[pf.build] ?? pf.build} build{r.labTested === true ? ' · lab-tested release' : ''}</dd>
                <dt className="text-muted-foreground">Installed</dt>
                <dd>{pf.installed ? (pf.expectedPath ? 'Program Files\\RustDesk, run by the service' : 'Program Files\\RustDesk, but the service runs another copy') : 'not in Program Files\\RustDesk'}</dd>
                <dt className="text-muted-foreground">Service</dt>
                <dd>{SERVICE_LABEL[pf.service] ?? pf.service}</dd>
                <dt className="text-muted-foreground">Read-only checks</dt>
                <dd>{pf.cli === 'not_run' ? 'not run' : `${pf.keysOk} of ${pf.keysTotal} answered`}</dd>
              </dl>
            )}
            <p className="text-xs text-muted-foreground">
              The signed agent reads RustDesk&apos;s settings with its own command line every 6 hours, and whenever RustDesk changes. That read never writes one.
              {r.state === 'managed' || r.state === 'managed_verified' || r.state === 'enforcement_failure'
                ? ' A Platform Admin moved this device into Managed Secure Access.'
                : ' Compatible means it could be managed; it is not managed now.'}
            </p>
          </>
        )}
        {data?.managedControls === true && (
          <>
            <MsaManagedControls endpointId={endpointId} />
            <MsaSessionsList endpointId={endpointId} />
          </>
        )}
      </CardContent>
    </Card>
  );
}
