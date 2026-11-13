'use client';

import * as React from 'react';
import Link from 'next/link';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Loader2, ShieldCheck } from 'lucide-react';
import { endpointsApi } from '@/lib/api-client';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { ConfirmDialog } from '@/components/common/confirm-dialog';
import { useToast } from '@/hooks/use-toast';
import { cn } from '@/lib/utils';

/**
 * The agent's actions (0.37): Update agent / Check for update now, Upgrade to
 * full agent and cancelling that request — the reads, the mutations and the
 * dialogs, in one place. The Agent card and the computer page's header both
 * use them, each with its own dialog state, so the confirmation text, the
 * reason, the fresh sign-in (the api-client's STEP_UP_REQUIRED interceptor),
 * the toasts and the refusals are the same wherever the button is pressed.
 * Both read and invalidate the same query keys, so both update together.
 *
 * Nothing here decides anything: every button is re-checked by the server,
 * which also says why when it refuses (`update.reason`, `migration.reason`).
 */

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
  /** 0.36: what the server will do about this agent by itself. Null if it could not be worked out. */
  autoUpdate: null | AutoUpdateState;
}

export interface AutoUpdateState {
  state: 'up_to_date' | 'queued' | 'updating' | 'failing' | 'opted_out' | 'manual' | 'unknown';
  reason: string;
  text: string;
  channel: 'standard' | 'standard_pre015' | 'signed' | null;
  target: string | null;
  mode: 'ANY_TIME' | 'WINDOW' | 'OFF';
  policy: { id: string; scope: 'business' | 'site' | 'group'; name: string; window: string | null } | null;
  window: { open: boolean; opensAt: string | null; closesAt: string | null } | null;
  attempts: { made: number; max: number; lastAt: string | null };
  nextAt: string | null;
  waitingForCheckIn: boolean;
  manual: { command: string | null } | null;
  history: { id: string; channel: string; fromVersion: string | null; targetVersion: string; attempt: number; dispatchedAt: string; outcome: string | null; resolvedAt: string | null; automatic: true }[];
}

/** A migration request in one of these states is still open: it is shown, not offered again. */
export const OPEN_MIGRATION_STATES = new Set(['pending', 'held', 'dispatched', 'downloaded', 'not_confirmed']);

export const UPGRADE_LABEL = 'Upgrade to full agent';
export const UPGRADE_PENDING_LABEL = 'Upgrade requested — waiting for check-in';
export const FULL_AGENT_HREF = '/endpoints/full-agent';

function apiMessage(e: unknown, fallback: string) {
  return (e as { response?: { data?: { message?: string | string[] } } })?.response?.data?.message?.toString() ?? fallback;
}

export function useAgentActions(endpointId: string, enabled = true) {
  const { toast } = useToast();
  const qc = useQueryClient();
  const [confirmUpdate, setConfirmUpdate] = React.useState(false);
  const [migrateOpen, setMigrateOpen] = React.useState(false);
  const [reason, setReason] = React.useState('');

  const query = useQuery<AgentCardData>({
    queryKey: ['endpoint-agent', endpointId],
    queryFn: () => endpointsApi.agent(endpointId).then((r) => r.data?.data),
    retry: false,
    enabled,
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
      toast({ title: 'Upgrade requested', description: 'The computer is handed the migration at its next check-in. The page header, the Agent card and Devices → Agent migrations follow it.' });
    },
    onError: (e) => toast({ title: 'Not requested', description: apiMessage(e, 'The request failed.'), variant: 'destructive' }),
  });
  const cancel = useMutation({
    mutationFn: () => endpointsApi.cancelAgentMigration(endpointId),
    onSuccess: () => { refresh(); toast({ title: 'Upgrade request cancelled' }); },
    onError: (e) => toast({ title: 'Not cancelled', description: apiMessage(e, 'The request failed.'), variant: 'destructive' }),
  });
  const copy = (t: string) => { navigator.clipboard?.writeText(t).then(() => toast({ title: 'Copied' })).catch(() => undefined); };

  return {
    a: query.data, isLoading: query.isLoading, isError: query.isError,
    update, migrate, cancel, copy,
    askUpdate: () => setConfirmUpdate(true),
    askMigrate: () => setMigrateOpen(true),
    dialog: { confirmUpdate, setConfirmUpdate, migrateOpen, setMigrateOpen, reason, setReason },
  };
}

export type AgentActions = ReturnType<typeof useAgentActions>;

/**
 * What "Upgrade to full agent" is for this computer. Null where it means
 * nothing: a signed agent (already the full agent), Linux and macOS (there is
 * no signed agent for them), or a computer that has not reported Windows —
 * exactly where the server sends no `migration` block, or the agent is signed.
 */
export type UpgradeView =
  | { state: 'enabled' }
  | { state: 'pending'; text: string; requestedAt: string; reason: string }
  | { state: 'blocked'; reason: string; fix: string | null; link: { href: string; label: string } | null }
  | { state: 'no-permission'; reason: string };

export function upgradeView(a: AgentCardData | undefined, canEdit: boolean): UpgradeView | null {
  if (!a || !a.migration || a.kind === 'signed') return null;
  const m = a.migration;
  if (m.request && OPEN_MIGRATION_STATES.has(m.request.state)) return { state: 'pending', text: m.request.text, requestedAt: m.request.requestedAt, reason: m.request.reason };
  if (!canEdit) return { state: 'no-permission', reason: 'Upgrading to the full agent needs the computers:edit permission.' };
  if (m.possible) return { state: 'enabled' };
  return { state: 'blocked', reason: m.reason ?? 'The server does not offer it for this computer right now.', fix: m.fix, link: m.link };
}

/**
 * The button itself: always a real button for a standard Windows agent —
 * enabled when the server offers the upgrade, otherwise disabled, with the
 * reason as its tooltip (the caller also prints it beside the button, since
 * a tooltip on a disabled button is easy to miss).
 */
export function UpgradeButton({ view, onClick, testId, className }: { view: UpgradeView; onClick: () => void; testId: string; className?: string }) {
  const title = view.state === 'blocked' ? `${view.reason}${view.fix ? ` What to do: ${view.fix}` : ''}`
    : view.state === 'no-permission' ? view.reason
      : view.state === 'pending' ? view.text : undefined;
  const pending = view.state === 'pending';
  return (
    // The span carries the tooltip: some browsers send no hover to a disabled button.
    <span title={title} className="inline-flex max-w-full">
      {/* Wraps rather than widening a 375 px screen: "Upgrade requested — waiting for check-in" is long. */}
      <Button size="sm" variant={view.state === 'enabled' ? 'default' : 'outline'} className={cn('h-auto min-h-9 max-w-full whitespace-normal py-1.5 text-left', className)} onClick={onClick}
        disabled={view.state !== 'enabled'} data-testid={testId} data-state={view.state}>
        <ShieldCheck className="h-4 w-4 mr-1.5 shrink-0" />{pending ? UPGRADE_PENDING_LABEL : UPGRADE_LABEL}
      </Button>
    </span>
  );
}

/** Why the button is disabled, what to do, and where the whole move is shown. */
export function UpgradeReason({ view, testId }: { view: UpgradeView; testId: string }) {
  if (view.state === 'blocked') {
    const extra = view.link && view.link.href !== FULL_AGENT_HREF ? view.link : null;
    return (
      <div className="text-xs space-y-0.5" data-testid={testId} data-state="blocked">
        <p><span className="font-medium text-foreground">{UPGRADE_LABEL} is not available:</span> {view.reason}</p>
        <p className="text-muted-foreground">
          {view.fix && <>What to do: {view.fix} </>}
          {extra && <>See <Link className="underline" href={extra.href}>{extra.label}</Link>. </>}
          <Link className="underline" href={FULL_AGENT_HREF} data-testid={`${testId}-full-agent`}>Devices → Full agent</Link> shows every step.
        </p>
      </div>
    );
  }
  if (view.state === 'no-permission') return <p className="text-xs text-muted-foreground" data-testid={testId} data-state="no-permission">{view.reason}</p>;
  return null;
}

/** The two dialogs, opened through `askUpdate` / `askMigrate`. Render once per hook instance. */
export function AgentActionDialogs({ actions }: { actions: AgentActions }) {
  const { a, update, migrate, dialog } = actions;
  return (
    <>
      {dialog.confirmUpdate && a && (
        <ConfirmDialog
          open
          onOpenChange={(o) => { if (!o && !update.isPending) dialog.setConfirmUpdate(false); }}
          title={a.kind === 'signed' ? 'Check for an agent update now?' : 'Update the agent?'}
          description={a.kind === 'signed'
            ? 'The signed agent runs rem0te-agent.exe update at its next check-in. It installs only what the signed repository lists, verified against the root compiled into it.'
            : 'The current standard installer re-runs at the computer’s next check-in, as Reinstall agent does. It keeps the enrolment, device secret and RustDesk configuration and password, and downloads the RustDesk client again.'}
          confirmLabel="Queue it"
          loading={update.isPending}
          onConfirm={() => update.mutate()}
        />
      )}

      <Dialog open={dialog.migrateOpen} onOpenChange={(o) => { if (!o && !migrate.isPending) dialog.setMigrateOpen(false); }}>
        <DialogContent className="max-w-lg" data-testid="agent-migrate-dialog">
          <DialogHeader>
            <DialogTitle>Upgrade to full agent?</DialogTitle>
            <DialogDescription>
              The full agent is the signed agent. At its next check-in the computer is handed, once, the portal’s
              migration script. It downloads the signed agent, checks it against the digest the signed repository
              publishes, and runs <code>migrate</code>, which keeps the enrolment, device secret and RustDesk
              configuration. That one run trusts the portal, as every standard-agent update already does; afterwards the
              computer runs only code signed offline. You will be asked to confirm it is you.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-1.5">
            <Label htmlFor="agent-migrate-reason" className="text-xs">Reason (recorded in the audit log)</Label>
            <Input id="agent-migrate-reason" maxLength={400} value={dialog.reason} onChange={(e) => dialog.setReason(e.target.value)} placeholder="e.g. pilot machine for signed patching" />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => dialog.setMigrateOpen(false)} disabled={migrate.isPending}>Cancel</Button>
            <Button onClick={() => migrate.mutate()} disabled={dialog.reason.trim().length < 3 || migrate.isPending}>
              {migrate.isPending && <Loader2 className="h-4 w-4 mr-1.5 animate-spin" />}Request upgrade
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
