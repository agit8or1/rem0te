'use client';

import Link from 'next/link';
import { Copy, Loader2, Wrench } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Row } from '@/components/endpoints/endpoint-specs';
import { formatDate } from '@/lib/utils';
import { agentSilentAlert, ago, alertHref } from './device-model';
import type { AlertRow } from '@/components/monitoring/alerts';
import {
  AgentActionDialogs, OPEN_MIGRATION_STATES, UPGRADE_LABEL, UpgradeButton, UpgradeReason, upgradeView, useAgentActions,
  type AgentCardData, type AutoUpdateState,
} from './agent-actions';

export type { AgentCardData, AutoUpdateState } from './agent-actions';

const AUTO_LABEL: Record<AutoUpdateState['state'], string> = {
  up_to_date: 'Up to date',
  queued: 'Update queued',
  updating: 'Updating',
  failing: 'Auto-update failing',
  opted_out: 'Opted out',
  manual: 'Update manually',
  unknown: 'Unknown',
};

const MODE_LABEL: Record<AutoUpdateState['mode'], string> = { ANY_TIME: 'any time, paced', WINDOW: 'inside the update window', OFF: 'off' };

const short = (v: string | null) => (v && /^[0-9a-f]{64}$/.test(v) ? `build ${v.slice(0, 12)}…` : v ?? '—');

/**
 * 0.38: Upgrade to full agent, run on the computer itself. Open by default
 * when the computer fetched a migration and has not checked in since: the
 * console cannot reach it, so this is the way back.
 */
function LocalUpgrade({ local, onCopy }: { local: { command: string; stuck: boolean }; onCopy: (t: string) => void }) {
  return (
    <details open={local.stuck} className={`border-t pt-3 text-xs ${local.stuck ? '' : 'text-muted-foreground'}`} data-testid="agent-local-upgrade" data-stuck={local.stuck ? 'true' : 'false'}>
      <summary className="cursor-pointer font-medium text-foreground">{local.stuck ? 'Stopped checking in after its upgrade: fix it on the computer' : 'Upgrade on the computer itself'}</summary>
      <div className="mt-2 space-y-1.5">
        {local.stuck && (
          <p className="rounded-md border border-amber-500/40 bg-amber-500/5 p-2" data-testid="agent-local-upgrade-stuck">
            It downloaded the upgrade to the full agent and has not checked in since, so nothing sent from here reaches it.
            Run this once on the computer to finish the upgrade. It keeps the computer’s enrolment.
          </p>
        )}
        <p>In PowerShell <span className="font-medium">as administrator</span> on the computer, paste and run:</p>
        <div className="flex items-start gap-2">
          <code className="block min-w-0 flex-1 break-all rounded bg-muted px-2 py-1.5 font-mono text-[11px] leading-snug" data-testid="agent-local-upgrade-command">{local.command}</code>
          <Button size="sm" variant="ghost" className="h-7 px-2" aria-label="Copy the upgrade command" onClick={() => onCopy(local.command)}>
            <Copy className="h-3.5 w-3.5" />
          </Button>
        </div>
        <p className="text-muted-foreground">
          It downloads the signed agent this portal publishes, runs it only if it matches the published digest, and the agent
          verifies everything else it installs. It takes about a minute; the computer reports the full agent within three.
          If it does not, <code>C:\ProgramData\Rem0te\Logs\install.log</code> says why.
        </p>
      </div>
    </details>
  );
}

/** The Agent card's "Automatic updates" block (0.36). Everything it says comes from the API. */
function AutoUpdateBlock({ u, onCopy }: { u: AutoUpdateState; onCopy: (t: string) => void }) {
  const warn = u.state === 'failing' || u.state === 'manual';
  return (
    <div className="border-t pt-3 space-y-1.5 text-xs" data-testid="agent-auto-update" data-state={u.state} data-reason={u.reason}>
      <div className="flex items-center justify-between gap-2">
        <span className="font-medium text-sm">Automatic updates</span>
        <Badge variant={u.state === 'up_to_date' ? 'secondary' : 'outline'} className={warn ? 'border-amber-500 text-amber-700 dark:text-amber-400' : ''}>
          {AUTO_LABEL[u.state]}{u.state === 'failing' ? ` (${u.attempts.made} attempts)` : ''}
        </Badge>
      </div>
      <p className="text-muted-foreground">{u.text}</p>
      {u.state === 'queued' && u.window && !u.window.open && u.window.opensAt && (
        <p className="text-muted-foreground">Window opens {formatDate(u.window.opensAt)}{u.policy?.window ? ` (${u.policy.window})` : ''}.</p>
      )}
      {(u.state === 'queued' || u.state === 'updating') && u.nextAt && <p className="text-muted-foreground">Next change around {formatDate(u.nextAt)}.</p>}
      {u.waitingForCheckIn && <p className="text-muted-foreground">The agent has not checked in for a while; it is asked at its next check-in.</p>}
      {(u.state === 'updating' || u.state === 'failing' || u.attempts.made > 0) && (
        <p className="text-muted-foreground">Attempt {u.attempts.made} of {u.attempts.max}{u.attempts.lastAt ? `, last ${ago(u.attempts.lastAt)}` : ''}{u.target ? ` · to ${short(u.target)}` : ''}.</p>
      )}
      {u.state !== 'manual' && u.state !== 'unknown' && (
        <p className="text-muted-foreground">Policy: {MODE_LABEL[u.mode]}{u.policy ? `, from the ${u.policy.name}` : ' (the platform default)'}.</p>
      )}
      {u.manual?.command && (
        <div className="flex items-start gap-2">
          <code className="block min-w-0 flex-1 break-all rounded bg-muted px-2 py-1.5">{u.manual.command}</code>
          <Button size="sm" variant="ghost" className="h-7 px-2" aria-label="Copy the manual update command" onClick={() => onCopy(u.manual!.command!)}>
            <Copy className="h-3.5 w-3.5" />
          </Button>
        </div>
      )}
      {u.history.length > 0 && (
        <details>
          <summary className="cursor-pointer text-muted-foreground">Automatic update history ({u.history.length})</summary>
          <ul className="mt-1 space-y-0.5">
            {u.history.map((h) => (
              <li key={h.id} title={formatDate(h.dispatchedAt)}>
                Automatic · attempt {h.attempt} · {short(h.fromVersion)} → {short(h.targetVersion)} · {ago(h.dispatchedAt)} · {h.outcome === 'updated' ? 'updated' : h.outcome === 'superseded' ? 'did not update' : 'open'}
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

const KIND_LABEL: Record<AgentCardData['kind'], string> = {
  standard: 'Standard (Windows)',
  signed: 'Signed (Windows)',
  linux: 'Standard (Linux, read-only)',
  macos: 'Standard (macOS, read-only)',
  'rustdesk-only': 'RustDesk only',
  unknown: 'Unknown',
};

/**
 * The Agent card (0.34): which agent this computer runs, whether it is
 * current, and the buttons that update it or move it to the full (signed)
 * agent. Every button is re-checked by the server, which also says why when
 * it refuses. From 0.37 the actions and their dialogs are shared with the
 * page header (agent-actions.tsx), and Upgrade to full agent is always a
 * button on a standard Windows agent: disabled, with its reason, when the
 * server does not offer it.
 */
export function AgentCard({ endpointId, canEdit, alerts }: { endpointId: string; canEdit: boolean; alerts?: AlertRow[] | null }) {
  // 0.36: an open agent-silent alert, from the Monitoring view the page already reads (null without monitoring:alerts).
  const silent = agentSilentAlert(alerts);
  const actions = useAgentActions(endpointId);
  const { a, isLoading, isError, update, cancel, copy } = actions;
  const up = upgradeView(a, canEdit);

  return (
    <Card id="agent-card" data-testid="agent-card" className="scroll-mt-4">
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between gap-2">
          <CardTitle className="text-sm">Agent</CardTitle>
          <span className="flex items-center gap-3">
            <Link href="/endpoints/full-agent" className="text-xs text-muted-foreground underline-offset-2 hover:underline" data-testid="agent-card-full-agent">Full agent</Link>
            <Link href="/endpoints/agent-migrations" className="text-xs text-muted-foreground underline-offset-2 hover:underline">Agent migrations</Link>
          </span>
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

            {a.autoUpdate && (
              <AutoUpdateBlock u={a.autoUpdate} onCopy={copy} />
            )}

            {a.kind === 'signed' && (
              <Row label="Full agent"><span className="inline-flex items-center gap-1 text-xs" data-testid="agent-card-full-agent-status">Yes: it runs the signed agent</span></Row>
            )}

            {/* Update agent / Check now / re-run the installer */}
            <div className="border-t pt-3 space-y-2">
              {a.update.command ? (
                <div className="space-y-1.5">
                  <p className="text-xs text-muted-foreground">{a.update.reason}</p>
                  <div className="flex items-start gap-2">
                    <code className="block min-w-0 flex-1 break-all rounded bg-muted px-2 py-1.5 text-xs">{a.update.command}</code>
                    <Button size="sm" variant="ghost" className="h-7 px-2" aria-label="Copy the command" onClick={() => copy(a.update.command!)}>
                      <Copy className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                </div>
              ) : a.update.possible && canEdit ? (
                <Button size="sm" variant="outline" onClick={actions.askUpdate} disabled={update.isPending}>
                  {update.isPending ? <Loader2 className="h-4 w-4 mr-1.5 animate-spin" /> : <Wrench className="h-4 w-4 mr-1.5" />}{a.update.label}
                </Button>
              ) : a.update.reason ? (
                <p className="text-xs text-muted-foreground">{a.update.label}: {a.update.reason}</p>
              ) : !canEdit ? <p className="text-xs text-muted-foreground">Updating the agent needs the computers:edit permission.</p> : null}
            </div>

            {/* Upgrade to full agent: always a button on a standard Windows agent. */}
            {a.migration?.local && <LocalUpgrade local={a.migration.local} onCopy={copy} />}

            {(up || a.migration?.request) && (
              <div className="border-t pt-3 space-y-2" data-testid="agent-migration">
                {a.migration?.request && (
                  <div className="text-xs space-y-0.5">
                    <p><span className="font-medium">{UPGRADE_LABEL}:</span> {a.migration.request.text}</p>
                    <p className="text-muted-foreground">Requested {ago(a.migration.request.requestedAt)} · “{a.migration.request.reason}”</p>
                    {canEdit && OPEN_MIGRATION_STATES.has(a.migration.request.state) && (
                      <Button size="sm" variant="ghost" className="h-7 px-2 text-xs" disabled={cancel.isPending} onClick={() => cancel.mutate()} data-testid="agent-migrate-cancel">Cancel the request</Button>
                    )}
                  </div>
                )}
                {up && (
                  <div className="space-y-1">
                    <UpgradeButton view={up} onClick={actions.askMigrate} testId="agent-migrate" />
                    <UpgradeReason view={up} testId="agent-migration-blocked" />
                    {up.state === 'enabled' && (
                      <p className="text-xs text-muted-foreground">Or let the automatic migration move it: <Link className="underline" href="/endpoints/full-agent">Full agent</Link> shows every step and where this computer is.</p>
                    )}
                  </div>
                )}
              </div>
            )}
          </>
        )}
      </CardContent>

      <AgentActionDialogs actions={actions} />
    </Card>
  );
}
