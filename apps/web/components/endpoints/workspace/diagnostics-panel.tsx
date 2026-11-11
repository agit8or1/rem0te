'use client';

import { useState, useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { endpointsApi, diagnosticsApi } from '@/lib/api-client';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { ConfirmDialog } from '@/components/common/confirm-dialog';
import { useToast } from '@/hooks/use-toast';
import { formatDate } from '@/lib/utils';
import {
  RefreshCw, CheckCircle2, XCircle, AlertTriangle, HelpCircle, Info, Clock, Download, Laptop,
} from 'lucide-react';

/** Test connection (v0.20), moved here unchanged from the computer page in 0.31. */

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-4">
      <span className="text-muted-foreground shrink-0">{label}</span>
      <span className="text-right">{children}</span>
    </div>
  );
}

function apiMessage(e: unknown, fallback: string) {
  return (e as { response?: { data?: { message?: string | string[] } } })?.response?.data?.message?.toString() ?? fallback;
}

// ─── Test connection ─────────────────────────────────────────────────────────

/** Shapes from apps/api/src/diagnostics/diagnostics.service.ts. */
type CheckStatus = 'pass' | 'fail' | 'warn' | 'stale' | 'unavailable' | 'info';
type CheckLocation = 'technician' | 'endpoint' | 'server';
interface DiagnosticCheck {
  key: string;
  label: string;
  location: CheckLocation;
  status: CheckStatus;
  source: string;
  observedAt: string | null;
  summary: string;
  nextSteps: string[];
  actions: { id: string; label: string; changesConfiguration: boolean }[];
}
interface DiagnosticsResult {
  endpoint: { id: string; name: string; hostname: string | null; rustdeskId: string | null };
  ranAt: string;
  checks: DiagnosticCheck[];
  byLocation: { location: CheckLocation; worst: CheckStatus; failing: string[] }[];
  disclaimer: string;
}

const CHECK_STYLE: Record<CheckStatus, { label: string; icon: React.ElementType; className: string }> = {
  pass: {
    label: 'Pass', icon: CheckCircle2,
    className: 'bg-green-100 text-green-800 border-green-200 dark:bg-green-900 dark:text-green-100 dark:border-green-800',
  },
  fail: {
    label: 'Fail', icon: XCircle,
    className: 'bg-red-100 text-red-800 border-red-200 dark:bg-red-900 dark:text-red-100 dark:border-red-800',
  },
  warn: {
    label: 'Warning', icon: AlertTriangle,
    className: 'bg-amber-100 text-amber-800 border-amber-200 dark:bg-amber-900 dark:text-amber-100 dark:border-amber-800',
  },
  stale: {
    label: 'Out of date', icon: Clock,
    className: 'bg-orange-50 text-orange-800 border-orange-200 dark:bg-orange-950 dark:text-orange-200 dark:border-orange-900',
  },
  unavailable: {
    label: 'Unknown', icon: HelpCircle,
    className: 'bg-muted text-muted-foreground border-border border-dashed',
  },
  info: {
    label: 'Info', icon: Info,
    className: 'bg-sky-50 text-sky-800 border-sky-200 dark:bg-sky-950 dark:text-sky-200 dark:border-sky-900',
  },
};

const LOCATION_LABEL: Record<CheckLocation, string> = {
  technician: 'Your computer',
  endpoint: 'This computer',
  server: 'Rem0te server',
};

function CheckBadge({ status }: { status: CheckStatus }) {
  const s = CHECK_STYLE[status] ?? CHECK_STYLE.unavailable;
  const Icon = s.icon;
  return (
    <span className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-semibold whitespace-nowrap ${s.className}`}>
      <Icon className="h-3 w-3" aria-hidden="true" />
      {s.label}
    </span>
  );
}

/** Fields the read-only helper reports (see technicianChecks in the API). */
const TECH_REPORT_FIELDS: { key: string; label: string }[] = [
  { key: 'installed', label: 'RustDesk installed' },
  { key: 'installedVersion', label: 'Installed version' },
  { key: 'portableCached', label: 'Portable copy cached' },
  { key: 'portableVersion', label: 'Portable version' },
  { key: 'configHost', label: 'Server address in RustDesk' },
  { key: 'hostMatches', label: 'Server address matches' },
  { key: 'keyMatches', label: 'Server key matches' },
  { key: 'tcp21116', label: 'TCP 21116 reachable' },
  { key: 'tcp21117', label: 'TCP 21117 reachable' },
];

function reportValue(v: unknown): string {
  if (v === true) return 'Yes';
  if (v === false) return 'No';
  if (v === null || v === undefined || v === '') return '—';
  return String(v);
}

export function DiagnosticsPanel({ endpointId, canConnect }: { endpointId: string; canConnect: boolean }) {
  const { toast } = useToast();
  const qc = useQueryClient();
  const [pending, setPending] = useState<{ id: string; label: string } | null>(null);
  const [helperAt, setHelperAt] = useState<number | null>(null);

  const { data, isLoading, isFetching, isError, error, refetch } = useQuery<DiagnosticsResult>({
    queryKey: ['diagnostics', endpointId],
    queryFn: () => diagnosticsApi.forEndpoint(endpointId).then((r) => r.data?.data),
    retry: false,
    staleTime: 0,
  });

  // After the helper is downloaded, poll for its report for up to 15 minutes.
  const { data: latest } = useQuery<{ submittedAt: string; report: Record<string, unknown> | null } | null>({
    queryKey: ['diagnostics', 'technician-latest'],
    queryFn: () => diagnosticsApi.latestTechnicianReport().then((r) => r.data?.data ?? null),
    enabled: canConnect,
    retry: false,
    refetchInterval: helperAt && Date.now() - helperAt < 15 * 60_000 ? 10_000 : false,
  });

  const latestAt = latest?.submittedAt ? new Date(latest.submittedAt).getTime() : 0;
  useEffect(() => {
    if (helperAt && latestAt > helperAt) {
      setHelperAt(null);
      qc.invalidateQueries({ queryKey: ['diagnostics', endpointId] });
      toast({ title: 'Report received from your computer' });
    }
  }, [helperAt, latestAt, endpointId, qc, toast]);

  const action = useMutation({
    mutationFn: (actionId: string) => {
      if (actionId === 'reinstall_agent') return endpointsApi.reinstallAgent(endpointId);
      if (actionId === 'accept_device_secret') return endpointsApi.acceptDeviceSecret(endpointId);
      if (actionId === 'rotate_credential') return endpointsApi.rotateCredential(endpointId);
      return Promise.reject(new Error('Unsupported action'));
    },
    onSuccess: () => {
      // Each of these is queued for the computer's next check-in, not done.
      toast({ title: 'Requested', description: 'The computer applies this on its next check-in.' });
      setPending(null);
      qc.invalidateQueries({ queryKey: ['diagnostics', endpointId] });
      qc.invalidateQueries({ queryKey: ['endpoint', endpointId] });
    },
    onError: (e: unknown) => {
      toast({ title: 'Not done', description: apiMessage(e, 'The request failed'), variant: 'destructive' });
      setPending(null);
    },
  });

  function runAction(a: { id: string; label: string }) {
    if (a.id === 'run_technician_check') {
      if (!canConnect) return;
      setHelperAt(Date.now());
      window.location.href = diagnosticsApi.helperUrl(endpointId);
      return;
    }
    if (a.id === 'technician_setup') {
      window.location.href = '/downloads';
      return;
    }
    setPending(a);
  }

  const actionAvailable = (id: string) =>
    id === 'run_technician_check' ? canConnect
      : ['technician_setup', 'reinstall_agent', 'accept_device_secret', 'rotate_credential'].includes(id);

  return (
    <>
      <Card>
        <CardHeader className="pb-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <CardTitle className="text-sm">Test connection</CardTitle>
            <div className="flex flex-wrap gap-2">
              <Button size="sm" variant="outline" onClick={() => refetch()} disabled={isFetching}>
                <RefreshCw className={`h-3.5 w-3.5 mr-1 ${isFetching ? 'animate-spin' : ''}`} />
                Run again
              </Button>
              <Button size="sm" variant="outline" asChild>
                <a href={diagnosticsApi.reportUrl(endpointId)}>
                  <Download className="h-3.5 w-3.5 mr-1" />
                  Download report
                </a>
              </Button>
              {canConnect && (
                <Button size="sm" variant="outline" asChild>
                  <a href={diagnosticsApi.helperUrl(endpointId)} onClick={() => setHelperAt(Date.now())}>
                    <Laptop className="h-3.5 w-3.5 mr-1" />
                    Check my computer
                  </a>
                </Button>
              )}
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-4 text-sm">
          {isLoading ? (
            <p className="text-muted-foreground">Running checks…</p>
          ) : isError || !data ? (
            <p className="text-destructive">{apiMessage(error, 'Could not run the checks.')}</p>
          ) : (
            <>
              <p className="text-xs text-muted-foreground">{data.disclaimer}</p>
              <p className="text-xs text-muted-foreground">Run {formatDate(data.ranAt)}.</p>

              <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                {data.byLocation.map((l) => (
                  <div key={l.location} className="rounded-md border bg-muted/30 px-3 py-2 space-y-1">
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-xs font-medium">{LOCATION_LABEL[l.location]}</span>
                      <CheckBadge status={l.worst} />
                    </div>
                    {l.failing.length > 0 && (
                      <p className="text-xs text-muted-foreground">Failing: {l.failing.join(', ')}</p>
                    )}
                  </div>
                ))}
              </div>

              {(['technician', 'endpoint', 'server'] as CheckLocation[]).map((loc) => {
                const checks = data.checks.filter((c) => c.location === loc);
                if (!checks.length) return null;
                return (
                  <div key={loc} className="space-y-2">
                    <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{LOCATION_LABEL[loc]}</p>
                    <div className="divide-y rounded-md border">
                      {checks.map((c, i) => (
                        <div key={`${c.key}-${i}`} className="p-3 space-y-1.5">
                          <div className="flex flex-wrap items-center justify-between gap-2">
                            <span className="font-medium">{c.label}</span>
                            <CheckBadge status={c.status} />
                          </div>
                          <p>{c.summary}</p>
                          {c.nextSteps.length > 0 && (
                            <ul className="list-disc pl-5 text-muted-foreground space-y-0.5">
                              {c.nextSteps.map((n, j) => <li key={j}>{n}</li>)}
                            </ul>
                          )}
                          <p className="text-xs text-muted-foreground">
                            {c.source}{c.observedAt ? ` · observed ${formatDate(c.observedAt)}` : ' · never observed'}
                          </p>
                          {c.actions.filter((a) => actionAvailable(a.id)).length > 0 && (
                            <div className="flex flex-wrap gap-2 pt-1">
                              {c.actions.filter((a) => actionAvailable(a.id)).map((a) => (
                                <Button key={a.id} size="sm" variant="outline" className="h-7 text-xs" onClick={() => runAction(a)}>
                                  {a.label}
                                </Button>
                              ))}
                            </div>
                          )}
                        </div>
                      ))}
                    </div>
                  </div>
                );
              })}
            </>
          )}
        </CardContent>
      </Card>

      {canConnect && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-sm">Latest check of your computer</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            {helperAt && (
              <p className="text-xs text-muted-foreground">
                Waiting for the helper to report. Run the downloaded file on your Windows computer.
              </p>
            )}
            {!latest ? (
              <p className="text-muted-foreground">
                No report yet. &ldquo;Check my computer&rdquo; downloads a read-only helper for Windows that reports back here.
              </p>
            ) : (
              <>
                <p className="text-xs text-muted-foreground">Reported {formatDate(latest.submittedAt)}.</p>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-1.5">
                  {TECH_REPORT_FIELDS.filter((f) => latest.report && f.key in latest.report).map((f) => (
                    <Row key={f.key} label={f.label}>{reportValue(latest.report?.[f.key])}</Row>
                  ))}
                </div>
              </>
            )}
          </CardContent>
        </Card>
      )}

      <ConfirmDialog
        open={!!pending}
        onOpenChange={(o) => { if (!o) setPending(null); }}
        title={pending?.label ?? ''}
        description="This changes configuration on the computer. It is queued and applied on the computer's next check-in."
        confirmLabel="Request it"
        loading={action.isPending}
        onConfirm={() => pending && action.mutate(pending.id)}
      />
    </>
  );
}
