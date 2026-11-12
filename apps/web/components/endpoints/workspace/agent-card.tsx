'use client';

import * as React from 'react';
import Link from 'next/link';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Copy, Loader2, ShieldCheck, Wrench } from 'lucide-react';
import { endpointsApi } from '@/lib/api-client';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { ConfirmDialog } from '@/components/common/confirm-dialog';
import { Row } from '@/components/endpoints/endpoint-specs';
import { useToast } from '@/hooks/use-toast';
import { formatDate } from '@/lib/utils';
import { agentSilentAlert, ago, alertHref } from './device-model';
import type { AlertRow } from '@/components/monitoring/alerts';

/** GET /endpoints/:id/agent (0.34). */
export interface AgentCardData {
  kind: 'standard' | 'signed' | 'linux' | 'macos' | 'rustdesk-only' | 'unknown';
  platform: string | null;
  version: string | null;
  server: string;
  current: { state: 'current' | 'behind' | 'unknown'; text: string };
  channel: 'signed' | 'standard' | null;
  signed: { trustRootVersion: number | null; targetsVersion: number | null; reportedAt: string | null; sha256: string | null } | null;
  lastUpdate: { checkedAt: string; result: string | null } | null;
  portal: { mode: string; legacyPortalMigration: boolean; modeLabel: string; repository: boolean; signedAgentSha256: string | null };
  updatesPaused: string | null;
  reinstall: { pending: boolean; dispatched: boolean };
  update: { possible: boolean; label: string; reason: string | null; command?: string };
  migration: null | {
    possible: boolean; code: string | null; reason: string | null; fix: string | null; link: { href: string; label: string } | null;
    request: null | { id: string; state: string; text: string; requestedAt: string; dispatchedAt: string | null; fetchedAt: string | null; completedAt: string | null; cancelledAt: string | null; reason: string };
  };
}

const KIND_LABEL: Record<AgentCardData['kind'], string> = {
  standard: 'Standard (Windows)',
  signed: 'Signed (Windows)',
  linux: 'Standard (Linux, read-only)',
  macos: 'Standard (macOS, read-only)',
  'rustdesk-only': 'RustDesk only',
  unknown: 'Unknown',
};

const OPEN_STATES = new Set(['pending', 'held', 'dispatched', 'downloaded', 'not_confirmed']);

function apiMessage(e: unknown, fallback: string) {
  return (e as { response?: { data?: { message?: string | string[] } } })?.response?.data?.message?.toString() ?? fallback;
}

/**
 * The Agent card (0.34): which agent this computer runs, whether it is
 * current, and the buttons that update it or move it to the signed agent.
 * Every button is re-checked by the server, which also says why when it
 * refuses; a button that cannot work is replaced by its reason.
 */
export function AgentCard({ endpointId, canEdit, alerts }: { endpointId: string; canEdit: boolean; alerts?: AlertRow[] | null }) {
  // 0.36: an open agent-silent alert, from the Monitoring view the page already reads (null without monitoring:alerts).
  const silent = agentSilentAlert(alerts);
  const { toast } = useToast();
  const qc = useQueryClient();
  const [confirmUpdate, setConfirmUpdate] = React.useState(false);
  const [migrateOpen, setMigrateOpen] = React.useState(false);
  const [reason, setReason] = React.useState('');

  const { data: a, isLoading, isError } = useQuery<AgentCardData>({
    queryKey: ['endpoint-agent', endpointId],
    queryFn: () => endpointsApi.agent(endpointId).then((r) => r.data?.data),
    retry: false,
  });
  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['endpoint-agent', endpointId] });
    qc.invalidateQueries({ queryKey: ['endpoint-patches', endpointId] });
  };

  const update = useMutation({
    mutationFn: () => endpointsApi.updateAgent(endpointId),
    onSuccess: (r) => {
      setConfirmUpdate(false);
      refresh();
      const check = r.data?.data?.what === 'check';
      toast({ title: check ? 'Update check queued' : 'Agent update queued', description: check ? 'The signed agent checks the signed repository at its next check-in and installs only what it lists.' : 'The current installer re-runs at the computer’s next check-in. It keeps the enrolment, device secret and RustDesk settings.' });
    },
    onError: (e) => { setConfirmUpdate(false); toast({ title: 'Not queued', description: apiMessage(e, 'The request failed.'), variant: 'destructive' }); },
  });
  const migrate = useMutation({
    mutationFn: () => endpointsApi.migrateAgent(endpointId, reason.trim()),
    onSuccess: () => {
      setMigrateOpen(false); setReason(''); refresh();
      toast({ title: 'Upgrade requested', description: 'The computer is handed the migration at its next check-in. This card and Devices → Agent migrations follow it.' });
    },
    onError: (e) => toast({ title: 'Not requested', description: apiMessage(e, 'The request failed.'), variant: 'destructive' }),
  });
  const cancel = useMutation({
    mutationFn: () => endpointsApi.cancelAgentMigration(endpointId),
    onSuccess: () => { refresh(); toast({ title: 'Upgrade request cancelled' }); },
    onError: (e) => toast({ title: 'Not cancelled', description: apiMessage(e, 'The request failed.'), variant: 'destructive' }),
  });

  return (
    <Card id="agent-card" data-testid="agent-card" className="scroll-mt-4">
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between gap-2">
          <CardTitle className="text-sm">Agent</CardTitle>
          <Link href="/endpoints/agent-migrations" className="text-xs text-muted-foreground underline-offset-2 hover:underline">Agent migrations</Link>
        </div>
      </CardHeader>
      <CardContent className="space-y-2.5 text-sm">
        {isLoading ? <p className="text-muted-foreground">Loading…</p> : isError || !a ? <p className="text-muted-foreground">The agent’s details could not be loaded.</p> : (
          <>
            {silent && (
              <div className="rounded-md border border-amber-500/40 bg-amber-500/5 p-2 text-xs space-y-0.5" data-testid="agent-silent-alert">
                <p><span className="font-medium">Agent silent</span> — <Link className="underline" href={alertHref(silent)}>open alert</Link>, raised {ago(silent.firstSeenAt)}.</p>
                <p className="text-muted-foreground">Remote control should still work: RustDesk is reachable. Update the agent below, or re-run the installer on the machine.</p>
              </div>
            )}
            <Row label="Type"><Badge variant="secondary">{KIND_LABEL[a.kind]}</Badge></Row>
            <Row label="Version">{a.version ?? '—'}</Row>
            <Row label="Current">
              <span className="inline-flex flex-col items-end gap-0.5">
                <Badge variant={a.current.state === 'current' ? 'secondary' : 'outline'} className={a.current.state === 'behind' ? 'border-amber-500 text-amber-700 dark:text-amber-400' : ''}>
                  {a.current.state === 'current' ? 'Current' : a.current.state === 'behind' ? 'Behind' : 'Unknown'}
                </Badge>
                <span className="text-xs text-muted-foreground">{a.current.text}</span>
              </span>
            </Row>
            {a.channel && <Row label="Update channel">{a.channel === 'signed' ? 'Signed (verifies everything it installs)' : 'Standard (trusts the portal)'}</Row>}
            {a.channel && <Row label="Portal update mode">{a.portal.modeLabel}</Row>}
            {a.signed && <Row label="Trust root / targets">v{a.signed.trustRootVersion ?? '?'} / v{a.signed.targetsVersion ?? '?'}</Row>}
            {(a.kind === 'signed' || a.lastUpdate) && (
              <Row label="Last update result">
                {a.lastUpdate ? <span title={formatDate(a.lastUpdate.checkedAt)}>{a.lastUpdate.result || '—'} · {ago(a.lastUpdate.checkedAt)}</span>
                  : <span className="text-muted-foreground">Not reported (signed builds before 0.34 do not report it; <code>rem0te-agent.exe status</code> on the computer shows it)</span>}
              </Row>
            )}
            {a.reinstall.pending && <Row label="Queued">{a.reinstall.dispatched ? 'Handed to the computer; waiting for it to report back' : 'Waiting for the next check-in'}</Row>}
            {a.updatesPaused && <p className="rounded-md border border-amber-500/40 bg-amber-500/5 p-2 text-xs">{a.updatesPaused}</p>}

            {/* Update agent / Check now / re-run the installer */}
            <div className="border-t pt-3 space-y-2">
              {a.update.command ? (
                <div className="space-y-1.5">
                  <p className="text-xs text-muted-foreground">{a.update.reason}</p>
                  <div className="flex items-start gap-2">
                    <code className="block min-w-0 flex-1 break-all rounded bg-muted px-2 py-1.5 text-xs">{a.update.command}</code>
                    <Button size="sm" variant="ghost" className="h-7 px-2" aria-label="Copy the command"
                      onClick={() => { navigator.clipboard?.writeText(a.update.command!).then(() => toast({ title: 'Copied' })).catch(() => undefined); }}>
                      <Copy className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                </div>
              ) : a.update.possible && canEdit ? (
                <Button size="sm" variant="outline" onClick={() => setConfirmUpdate(true)} disabled={update.isPending}>
                  {update.isPending ? <Loader2 className="h-4 w-4 mr-1.5 animate-spin" /> : <Wrench className="h-4 w-4 mr-1.5" />}{a.update.label}
                </Button>
              ) : a.update.reason ? (
                <p className="text-xs text-muted-foreground">{a.update.label}: {a.update.reason}</p>
              ) : !canEdit ? <p className="text-xs text-muted-foreground">Updating the agent needs the computers:edit permission.</p> : null}
            </div>

            {/* Upgrade to signed agent */}
            {a.migration && (
              <div className="border-t pt-3 space-y-2" data-testid="agent-migration">
                {a.migration.request && (
                  <div className="text-xs space-y-0.5">
                    <p><span className="font-medium">Upgrade to signed agent:</span> {a.migration.request.text}</p>
                    <p className="text-muted-foreground">Requested {ago(a.migration.request.requestedAt)} · “{a.migration.request.reason}”</p>
                    {canEdit && OPEN_STATES.has(a.migration.request.state) && (
                      <Button size="sm" variant="ghost" className="h-7 px-2 text-xs" disabled={cancel.isPending} onClick={() => cancel.mutate()}>Cancel the request</Button>
                    )}
                  </div>
                )}
                {a.migration.possible && canEdit ? (
                  <Button size="sm" onClick={() => setMigrateOpen(true)} data-testid="agent-migrate">
                    <ShieldCheck className="h-4 w-4 mr-1.5" />Upgrade to signed agent
                  </Button>
                ) : a.migration.possible ? (
                  <p className="text-xs text-muted-foreground">Upgrading to the signed agent needs the computers:edit permission.</p>
                ) : a.migration.reason ? (
                  <div className="text-xs space-y-1" data-testid="agent-migration-blocked">
                    <p><span className="font-medium">Upgrade to signed agent is not available:</span> {a.migration.reason}</p>
                    {a.migration.fix && <p className="text-muted-foreground">What to do: {a.migration.fix}{a.migration.link && <> See <Link className="underline" href={a.migration.link.href}>{a.migration.link.label}</Link>.</>}</p>}
                  </div>
                ) : null}
              </div>
            )}
          </>
        )}
      </CardContent>

      {confirmUpdate && a && (
        <ConfirmDialog
          open
          onOpenChange={(o) => { if (!o && !update.isPending) setConfirmUpdate(false); }}
          title={a.kind === 'signed' ? 'Check for an agent update now?' : 'Update the agent?'}
          description={a.kind === 'signed'
            ? 'The signed agent runs rem0te-agent.exe update at its next check-in. It installs only what the signed repository lists, verified against the root compiled into it.'
            : 'The current standard installer re-runs at the computer’s next check-in, as Reinstall agent does. It keeps the enrolment, device secret and RustDesk configuration and password, and downloads the RustDesk client again.'}
          confirmLabel="Queue it"
          loading={update.isPending}
          onConfirm={() => update.mutate()}
        />
      )}

      <Dialog open={migrateOpen} onOpenChange={(o) => { if (!o && !migrate.isPending) setMigrateOpen(false); }}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Upgrade this computer to the signed agent?</DialogTitle>
            <DialogDescription>
              At its next check-in the computer is handed, once, the portal’s migration script. It downloads the signed
              agent, checks it against the digest the signed repository publishes, and runs <code>migrate</code>, which
              keeps the enrolment, device secret and RustDesk configuration. That one run trusts the portal, as every
              standard-agent update already does; afterwards the computer runs only code signed offline. You will be asked
              to confirm it is you.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-1.5">
            <Label htmlFor="agent-migrate-reason" className="text-xs">Reason (recorded in the audit log)</Label>
            <Input id="agent-migrate-reason" maxLength={400} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. pilot machine for signed patching" />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setMigrateOpen(false)} disabled={migrate.isPending}>Cancel</Button>
            <Button onClick={() => migrate.mutate()} disabled={reason.trim().length < 3 || migrate.isPending}>
              {migrate.isPending && <Loader2 className="h-4 w-4 mr-1.5 animate-spin" />}Request upgrade
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
