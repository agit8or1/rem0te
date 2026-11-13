'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import {
  Archive, ArchiveRestore, ChevronDown, Copy, Download, Eye, Loader2, MoreHorizontal, PackageCheck, PlayCircle, ShieldCheck, Stethoscope, Wrench, FileDown,
} from 'lucide-react';
import { endpointsApi, diagnosticsApi } from '@/lib/api-client';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { ConfirmDialog } from '@/components/common/confirm-dialog';
import { useToast } from '@/hooks/use-toast';
import type { WorkspaceTab } from './device-model';
import { AgentActionDialogs, UPGRADE_LABEL, UpgradeButton, upgradeView, type AgentActions } from './agent-actions';

/**
 * CONNECT · DIAGNOSE · RUN ACTION · PATCH · MORE.
 *
 * A primary button that cannot work for this computer is disabled and the
 * reason is printed under the bar — a tooltip on a disabled button never
 * shows. Archive and the other rare or destructive things live in MORE, each
 * behind a confirmation that names what it does; nothing destructive sits
 * next to Connect. None of this is a control: every route re-checks.
 *
 * 0.37: with computers:edit, the agent's own buttons sit here too, from the
 * same read, mutations and dialogs as the Agent card (agent-actions.tsx):
 * Upgrade to full agent on a standard Windows agent (always a button —
 * disabled with its reason, the fix and Devices → Full agent when the server
 * does not offer it; "Upgrade requested — waiting for check-in" while a
 * request is open), Update agent / Check for update now, "Full agent" on a
 * signed agent, and the manual command on Linux and macOS.
 */

type Confirm = 'archive' | 'restore' | 'reinstall' | null;

const CONFIRM_TEXT: Record<Exclude<Confirm, null>, { title: string; label: string; destructive: boolean; body: (name: string) => string }> = {
  archive: {
    title: 'Archive this computer?', label: 'Archive computer', destructive: true,
    body: (n) => `${n} leaves the device list and nobody can connect to it until it is restored. Its history is kept. Nothing is changed on the computer itself.`,
  },
  restore: {
    title: 'Restore this computer?', label: 'Restore computer', destructive: false,
    body: (n) => `${n} returns to the device list and the people with access can connect to it again.`,
  },
  reinstall: {
    title: 'Reinstall the agent?', label: 'Queue reinstall', destructive: false,
    body: (n) => `The installer re-runs on ${n} at its next heartbeat. It keeps the server settings, password and enrolment, replaces the agent and pulls the current RustDesk client. It is a software install on someone's computer.`,
  },
};

function apiMessage(e: unknown, fallback: string) {
  return (e as { response?: { data?: { message?: string | string[] } } })?.response?.data?.message?.toString() ?? fallback;
}

export function DeviceActions({
  endpointId, ep, onConnect, onViewOnly, connecting, onOpenTab, perms, actionReason, reportsInventory, agent,
}: {
  endpointId: string;
  ep: Record<string, unknown>;
  onConnect: () => void;
  onViewOnly: () => void;
  connecting: boolean;
  onOpenTab: (t: WorkspaceTab) => void;
  perms: { view: boolean; edit: boolean; remove: boolean; technician: boolean };
  /** Why RUN ACTION cannot work here, or null. */
  actionReason: string | null;
  reportsInventory: boolean;
  /** The agent's actions (0.37), shared with the Agent card; given only to someone with computers:edit. */
  agent?: AgentActions;
}) {
  const { toast } = useToast();
  const router = useRouter();
  const qc = useQueryClient();
  const [confirm, setConfirm] = useState<Confirm>(null);
  const name = (ep.name as string) ?? 'This computer';
  const archived = ep.status === 'ARCHIVED';
  const rustdeskId = (ep.rustdeskNode as { rustdeskId?: string } | null)?.rustdeskId;
  const connectReason = archived
    ? 'This computer is archived. Restore it from More first.'
    : !rustdeskId ? 'This computer has not finished enrolment, so it has no RustDesk ID to connect to.' : null;

  const archive = useMutation({
    mutationFn: () => endpointsApi.archive(endpointId),
    onSuccess: () => {
      setConfirm(null);
      toast({ title: 'Computer archived', description: 'Restore it from its page if that was a mistake.' });
      router.push('/endpoints');
    },
    onError: (e) => toast({ title: 'Not archived', description: apiMessage(e, 'Failed to archive'), variant: 'destructive' }),
  });
  const restore = useMutation({
    mutationFn: () => endpointsApi.restore(endpointId),
    onSuccess: () => {
      setConfirm(null);
      toast({ title: 'Computer restored' });
      qc.invalidateQueries({ queryKey: ['endpoint', endpointId] });
    },
    onError: (e) => toast({ title: 'Not restored', description: apiMessage(e, 'Failed to restore'), variant: 'destructive' }),
  });
  const reinstall = useMutation({
    mutationFn: () => endpointsApi.reinstallAgent(endpointId),
    onSuccess: () => {
      setConfirm(null);
      toast({ title: 'Reinstall queued', description: 'The installer re-runs on this computer at its next heartbeat.' });
      qc.invalidateQueries({ queryKey: ['endpoint-inventory', endpointId] });
    },
    onError: (e) => {
      setConfirm(null);
      toast({ title: 'Cannot reinstall from here', description: apiMessage(e, 'Could not queue the reinstall'), variant: 'destructive' });
    },
  });
  const busy = archive.isPending || restore.isPending || reinstall.isPending;

  const reasons: { label: string; why: string; extra?: React.ReactNode; testId?: string }[] = [];
  if (connectReason) reasons.push({ label: 'Connect', why: connectReason });
  if (perms.view && actionReason && actionReason !== 'Checking…') reasons.push({ label: 'Run action', why: actionReason });

  // The agent's buttons (0.37), from GET /endpoints/:id/agent.
  const a = agent?.a;
  const up = agent ? upgradeView(a, perms.edit) : null;
  if (a && up?.state === 'blocked') {
    const extra = up.link && up.link.href !== '/endpoints/full-agent' ? up.link : null;
    reasons.push({
      label: UPGRADE_LABEL, why: up.reason, testId: 'header-upgrade-reason',
      extra: <> {up.fix && <>What to do: {up.fix} </>}{extra && <>See <Link className="underline" href={extra.href}>{extra.label}</Link>. </>}<Link className="underline" href="/endpoints/full-agent" data-testid="header-upgrade-full-agent-link">Devices → Full agent</Link>.</>,
    });
  }
  if (a && !a.update.command && !a.update.possible && a.update.reason) reasons.push({ label: a.update.label, why: a.update.reason, testId: 'header-update-reason' });

  return (
    <div className="space-y-1.5 max-w-full" data-testid="device-actions">
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" onClick={onConnect} disabled={connecting || !!connectReason} data-testid="action-connect">
          <PlayCircle className="h-4 w-4 mr-1.5" />Connect
        </Button>
        {perms.view && (
          <Button size="sm" variant="outline" onClick={() => onOpenTab('diagnostics')} data-testid="action-diagnose">
            <Stethoscope className="h-4 w-4 mr-1.5" />Diagnose
          </Button>
        )}
        {perms.view && (
          <Button size="sm" variant="outline" onClick={() => onOpenTab('actions')} disabled={!!actionReason} data-testid="action-run">
            <Wrench className="h-4 w-4 mr-1.5" />Run action
          </Button>
        )}
        {perms.view && (
          <Button size="sm" variant="outline" onClick={() => onOpenTab('patches')} data-testid="action-patch">
            <PackageCheck className="h-4 w-4 mr-1.5" />Patch
          </Button>
        )}
        {a && up && <UpgradeButton view={up} onClick={agent!.askMigrate} testId="header-upgrade-full-agent" />}
        {a && a.kind === 'signed' && (
          <span className="inline-flex h-9 items-center gap-1.5 rounded-md border border-green-200 bg-green-50 px-3 text-sm font-medium text-green-900 dark:border-green-900 dark:bg-green-950/50 dark:text-green-100"
            title="This computer runs the full (signed) agent: it installs only what the signed repository lists." data-testid="header-full-agent">
            <ShieldCheck className="h-4 w-4" aria-hidden="true" />Full agent
          </span>
        )}
        {a && (a.update.command ? (
          <Button size="sm" variant="outline" onClick={() => agent!.copy(a.update.command!)} title={a.update.command} data-testid="header-agent-command">
            <Copy className="h-4 w-4 mr-1.5" />Copy update command
          </Button>
        ) : a.kind !== 'unknown' && (
          <span title={a.update.possible ? undefined : a.update.reason ?? undefined} className="inline-flex max-w-full">
            <Button size="sm" variant="outline" onClick={agent!.askUpdate} disabled={!a.update.possible || agent!.update.isPending} data-testid="header-update-agent">
              {agent!.update.isPending ? <Loader2 className="h-4 w-4 mr-1.5 animate-spin" /> : <Wrench className="h-4 w-4 mr-1.5" />}{a.update.label}
            </Button>
          </span>
        ))}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button size="sm" variant="outline" aria-label="More actions" data-testid="action-more">
              <MoreHorizontal className="h-4 w-4 mr-1" />More<ChevronDown className="h-3.5 w-3.5 ml-1 opacity-60" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-64">
            {/* View-only is enforced only for preset-backed technician grants,
                and only by refusing a launch the computer cannot restrict. For
                anyone else the server has never applied it, so it is not
                offered rather than implying a restriction that does not exist
                (0.25.0). */}
            {perms.technician && (
              <DropdownMenuItem disabled={connecting || !!connectReason} onSelect={onViewOnly}>
                <Eye className="h-4 w-4 mr-2" />Connect view-only
              </DropdownMenuItem>
            )}
            {perms.view && (
              <DropdownMenuItem asChild>
                <a href={diagnosticsApi.reportUrl(endpointId)}><FileDown className="h-4 w-4 mr-2" />Download diagnostics report</a>
              </DropdownMenuItem>
            )}
            {perms.edit && reportsInventory && !archived && (
              <DropdownMenuItem onSelect={() => setConfirm('reinstall')}>
                <Download className="h-4 w-4 mr-2" />Reinstall agent…
              </DropdownMenuItem>
            )}
            {perms.remove && (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">Removes access</DropdownMenuLabel>
                {archived ? (
                  <DropdownMenuItem onSelect={() => setConfirm('restore')}>
                    <ArchiveRestore className="h-4 w-4 mr-2" />Restore computer…
                  </DropdownMenuItem>
                ) : (
                  <DropdownMenuItem className="text-red-600 focus:text-red-600 dark:text-red-400 dark:focus:text-red-400" onSelect={() => setConfirm('archive')}>
                    <Archive className="h-4 w-4 mr-2" />Archive computer…
                  </DropdownMenuItem>
                )}
              </>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      {reasons.length > 0 && (
        <ul className="text-xs text-muted-foreground space-y-0.5" data-testid="action-reasons">
          {reasons.map((r) => <li key={r.label} data-testid={r.testId}><span className="font-medium text-foreground">{r.label}</span> unavailable: {r.why}{r.extra}</li>)}
        </ul>
      )}
      {a && up?.state === 'pending' && (
        <p className="text-xs text-muted-foreground" data-testid="header-upgrade-pending">
          <span className="font-medium text-foreground">{UPGRADE_LABEL}:</span> {up.text} Follow it on the Agent card or <Link className="underline" href="/endpoints/agent-migrations">Agent migrations</Link>.
        </p>
      )}
      {a?.update.command && (
        <p className="text-xs text-muted-foreground break-all" data-testid="header-agent-command-text">
          <span className="font-medium text-foreground">{a.update.label}</span> on the computer: <code className="rounded bg-muted px-1">{a.update.command}</code>
        </p>
      )}
      {agent && <AgentActionDialogs actions={agent} />}

      {confirm && (
        <ConfirmDialog
          open
          onOpenChange={(o) => { if (!o && !busy) setConfirm(null); }}
          title={CONFIRM_TEXT[confirm].title}
          description={CONFIRM_TEXT[confirm].body(name)}
          confirmLabel={CONFIRM_TEXT[confirm].label}
          destructive={CONFIRM_TEXT[confirm].destructive}
          loading={busy}
          onConfirm={() => (confirm === 'archive' ? archive.mutate() : confirm === 'restore' ? restore.mutate() : reinstall.mutate())}
        />
      )}
    </div>
  );
}
