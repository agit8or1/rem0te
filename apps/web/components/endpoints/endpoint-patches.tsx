'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { endpointsApi, patchingApi } from '@/lib/api-client';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useToast } from '@/hooks/use-toast';
import { formatDate } from '@/lib/utils';
import { AlertTriangle, Download, Loader2, RefreshCw, ShieldCheck } from 'lucide-react';
import { RebootChoice, type RebootRule } from '@/components/patching/patch-reboot-choice';
import { osName, updateSourceLabel } from '@/lib/platform-wording';
import { connectivityLabel, connectivityOf } from '@/lib/connectivity';
import { useApprovalMode } from '@/hooks/use-approval-mode';
import { DIRECT_TOAST } from '@/lib/direct-mode';

/**
 * Windows Update posture of one computer (v0.27), as its signed agent's
 * `patch-scan` last reported it. Since 0.32 "Install updates" here builds a
 * one-computer deployment whose single (canary) ring is a signed plan that
 * two people on the approval roster approve (or, in direct mode, a fresh
 * sign-in) — nothing installs from this tab
 * without them. When the computer cannot be patched there is no button, only
 * why and what to do instead.
 *
 * Everything here is device-reported. It describes what Windows Update told
 * the agent; it does not prove a vulnerability is fixed.
 */

interface PatchUpdate {
  updateId: string; revision: number; kb?: string; title: string; className?: string; severity?: string;
  downloaded: boolean; rebootBehavior: number; sizeBytes: number; installable: boolean; notInstallableBecause: string | null;
}
interface History { updateId: string; revision: number; kb?: string; title: string; result: string; hresult?: string; operation: string; date: string }
/** Built by apps/api/src/patching/summary.ts (0.30). */
export interface Summary {
  evidence: { source: 'signed_agent_scan' | 'standard_agent_scan' | 'none'; at: string | null; ageHours: number | null; freshness: 'fresh' | 'stale' | 'none'; lastSuccessfulScanAt: string | null };
  lastBootAt: string | null; restartedSinceLastInstall: boolean | null;
  online: { isOnline: boolean; lastSeenAt: string | null };
  managedBy: { state: 'rem0te_or_windows_update' | 'external' | 'unknown'; managers: { id: string; label: string; explanation: string }[]; explanation: string | null };
  rebootRequired: boolean | null; pendingCount: number; relevantKbs: string[];
  confirmations: { kb: string | null; title: string; state: string; detail: string | null; confirmedByLaterScan: boolean; resultAt: string | null }[];
  deploy: { possible: boolean; reason: string | null };
  warnings: string[];
}
export interface Patches {
  summary: Summary;
  supported: boolean; scannedAt: string | null; scanRequestedAt: string | null; scanPending: boolean; error: string | null;
  managers: { id: string; label: string }[]; autoUpdate: string | null;
  reboot: { pending: boolean; sources: string[] } | null;
  updates: PatchUpdate[]; history: History[];
  basic: { checkedAt: string | null; rebootRequired: boolean | null; updates: { title: string; kb: string | null; severity: string | null; sizeBytes: number | null }[] } | null;
  /** 0.32: whether Install updates is offered here, and if not, why and what to do. */
  install: {
    possible: boolean; reason: string | null; fix: string | null; installable: number;
    // 0.34: the fix is the Agent card's button, or a page to read.
    fixAction?: 'agent-card'; fixLink?: { href: string; label: string } | null;
  };
}

const REBOOT_SOURCE: Record<string, string> = {
  component_servicing: 'Windows servicing', windows_update: 'Windows Update', pending_file_rename: 'pending file replacement', update_agent: 'the update agent',
};
const RESULT: Record<string, 'success' | 'destructive' | 'warning' | 'outline'> = { succeeded: 'success', succeeded_with_errors: 'warning', failed: 'destructive', aborted: 'destructive', in_progress: 'outline', unknown: 'outline' };
const size = (b: number) => (b >= 1 << 30 ? `${(b / (1 << 30)).toFixed(1)} GB` : `${Math.max(1, Math.round(b / (1 << 20)))} MB`);

const SOURCE: Record<Summary['evidence']['source'], string> = { signed_agent_scan: 'Signed agent scan', standard_agent_scan: 'Standard agent scan (read-only)', none: 'No scan received' };
const FRESH: Record<Summary['evidence']['freshness'], 'success' | 'warning' | 'outline'> = { fresh: 'success', stale: 'warning', none: 'outline' };
const MANAGED: Record<Summary['managedBy']['state'], string> = { rem0te_or_windows_update: 'Windows Update (rem0te can deploy)', external: 'Managed elsewhere', unknown: 'Unknown' };
const age = (h: number | null) => (h == null ? '' : h < 1 ? 'under an hour old' : h < 48 ? `${Math.round(h)} h old` : `${Math.round(h / 24)} days old`);

/** The evidence first: where it came from, how old it is, and who manages updates here. */
export function PatchSummaryCard({ s, platform }: { s: Summary; platform?: unknown }) {
  // Linux and macOS (0.35): their own package manager, no KBs, and nothing rem0te deploys.
  const os = osName(platform);
  const posix = os === 'Linux' || os === 'macOS';
  const row = (k: string, v: React.ReactNode) => (<div className="flex flex-wrap gap-x-2"><dt className="text-muted-foreground w-44 shrink-0">{k}</dt><dd className="min-w-0">{v}</dd></div>);
  return (
    <Card data-testid="patch-summary">
      <CardHeader className="pb-3"><CardTitle className="text-sm">Patch status</CardTitle></CardHeader>
      <CardContent className="space-y-3 text-xs">
        <dl className="space-y-1.5">
          {row('Evidence', <span className="flex flex-wrap items-center gap-2">{SOURCE[s.evidence.source]}<Badge variant={FRESH[s.evidence.freshness]} className="text-[10px]">{s.evidence.freshness === 'none' ? 'unknown' : s.evidence.freshness}</Badge>{s.evidence.at && <span className="text-muted-foreground">{formatDate(s.evidence.at)} · {age(s.evidence.ageHours)}</span>}</span>)}
          {row('Last successful scan', s.evidence.lastSuccessfulScanAt ? formatDate(s.evidence.lastSuccessfulScanAt) : 'none')}
          {row('Last boot', s.lastBootAt ? formatDate(s.lastBootAt) : 'unknown')}
          {row('Connection', connectivityOf(s.online.isOnline, s.online.lastSeenAt) === 'offline' ? `offline${s.online.lastSeenAt ? ` since ${formatDate(s.online.lastSeenAt)}` : ''}` : connectivityLabel(connectivityOf(s.online.isOnline, s.online.lastSeenAt), s.online.lastSeenAt))}
          {row('Restart pending', s.rebootRequired == null ? 'unknown' : s.rebootRequired ? 'yes' : 'no')}
          {row('Who manages patching', <span>{posix ? (os === 'Linux' ? 'The package manager on the computer (apt, dnf or zypper)' : 'Software Update on the computer') : s.managedBy.state === 'external' ? s.managedBy.managers.map((m) => m.label).join(', ') : MANAGED[s.managedBy.state]}</span>)}
          {!posix && row('Relevant KBs', s.relevantKbs.length ? s.relevantKbs.join(', ') : s.evidence.source === 'none' ? 'unknown' : 'none offered')}
          {row('Deploy from rem0te', s.deploy.possible ? 'available' : <span className="text-muted-foreground">{s.deploy.reason}</span>)}
        </dl>
        {s.managedBy.explanation && s.managedBy.state !== 'rem0te_or_windows_update' && (
          <p className="rounded-md border p-2 text-muted-foreground">{s.managedBy.explanation}</p>
        )}
        {s.warnings.filter((w) => w !== s.managedBy.explanation).map((w) => (
          <p key={w} className="flex gap-2"><AlertTriangle className="h-3.5 w-3.5 shrink-0 mt-0.5 text-yellow-600" />{w}</p>
        ))}
        {s.confirmations.length > 0 && (
          <div className="space-y-1">
            <p className="font-medium">Installed by an approved plan</p>
            {s.confirmations.map((c, i) => (
              <div key={`${c.kb ?? c.title}-${i}`} className="flex flex-wrap items-center gap-2">
                <strong>{c.kb ?? c.title}</strong>
                <Badge variant={c.confirmedByLaterScan ? 'success' : c.state === 'failed' ? 'destructive' : 'outline'} className="text-[10px]">
                  {c.confirmedByLaterScan ? 'confirmed by a later scan' : c.state.replace(/_/g, ' ')}
                </Badge>
                {c.detail && <span className="text-muted-foreground">{c.detail}</span>}
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function apiMessage(e: unknown, fallback: string) {
  return (e as { response?: { data?: { message?: string | string[] } } })?.response?.data?.message?.toString() ?? fallback;
}

/**
 * Install updates on this one computer (0.32). Becomes a one-computer
 * deployment; its plan awaits two approvals on the approval signer, or in
 * direct mode (0.40) is signed at once after a fresh sign-in. When it
 * is not possible: the reason and the next step, never a disabled button.
 */
function InstallUpdates({ endpointId, p, onOpenAgentCard }: { endpointId: string; p: Patches; onOpenAgentCard?: () => void }) {
  const { toast } = useToast();
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [reason, setReason] = useState('');
  const [windowHours, setWindowHours] = useState(8);
  const [reboot, setReboot] = useState<RebootRule>('never');
  const [done, setDone] = useState<{ approvalUrl: string; deploymentId: string; direct: boolean } | null>(null);
  const installable = p.updates.filter((u) => u.installable);
  const key = (u: { updateId: string; revision: number }) => `${u.updateId}@${u.revision}`;
  // 0.40.1: in direct mode this is an install button, not a request for approval.
  const direct = useApprovalMode({ endpointId }) === 'direct';
  const go = useMutation({
    mutationFn: () => patchingApi.install(endpointId, {
      updates: installable.filter((u) => picked.has(key(u))).map((u) => ({ updateId: u.updateId, revision: u.revision })),
      reboot, reason: reason.trim() || (direct ? 'Installed from the computer’s Patches tab' : ''), windowHours,
    }),
    onSuccess: (r) => {
      const d = r.data.data as { job: { approvalUrl: string; direct?: boolean }; deployment: { id: string } };
      setDone({ approvalUrl: d.job.approvalUrl, deploymentId: d.deployment.id, direct: !!d.job.direct });
      setOpen(false); setPicked(new Set()); setReason(''); setReboot('never');
      qc.invalidateQueries({ queryKey: ['endpoint-patches', endpointId] });
      toast(d.job.direct ? { title: 'Installing', description: DIRECT_TOAST } : { title: 'Install requested', description: 'It awaits two approvals on the approval signer.' });
    },
    onError: (e) => toast({ title: 'Not requested', description: apiMessage(e, 'The request was refused.'), variant: 'destructive' }),
  });
  const requested = done && (
    done.direct
      ? <p>Approved automatically (direct mode). It installs when the computer next checks in · <Link className="underline" href={`/patching/${done.deploymentId}`}>follow it</Link></p>
      : <p>Requested: <a className="underline" href={done.approvalUrl} target="_blank" rel="noreferrer">its approval page</a> · <Link className="underline" href={`/patching/${done.deploymentId}`}>its deployment</Link></p>
  );

  if (!p.install.possible) {
    return (
      <Card data-testid="patch-install-unavailable">
        <CardHeader className="pb-3"><CardTitle className="text-sm flex items-center gap-2"><Download className="h-4 w-4" />Install updates</CardTitle></CardHeader>
        <CardContent className="space-y-1 text-xs">
          <p><strong>Not available on this computer.</strong> {p.install.reason}</p>
          {p.install.fix && (
            <p className="text-muted-foreground">
              What to do: {p.install.fix}
              {p.install.fixLink && <> See <Link className="underline" href={p.install.fixLink.href}>{p.install.fixLink.label}</Link>.</>}
              {!p.install.fixLink && /Patching setup/.test(p.install.fix) && <> See <Link className="underline" href="/docs/patching-setup">Patching setup</Link>.</>}
            </p>
          )}
          {p.install.fixAction === 'agent-card' && onOpenAgentCard && (
            <Button size="sm" variant="outline" className="mt-1 h-7 text-xs" onClick={onOpenAgentCard} data-testid="open-agent-card">Open the Agent card</Button>
          )}
          {requested}
        </CardContent>
      </Card>
    );
  }
  return (
    <Card data-testid="patch-install">
      <CardHeader className="pb-3 flex flex-row items-center justify-between space-y-0">
        <CardTitle className="text-sm flex items-center gap-2"><Download className="h-4 w-4" />Install updates</CardTitle>
        {!open && <Button size="sm" onClick={() => setOpen(true)}>Install updates…</Button>}
      </CardHeader>
      <CardContent className="space-y-3 text-xs">
        <p className="text-muted-foreground" data-testid="patch-install-mode">
          {direct
            ? 'Pick the updates and install them. Direct mode is on: it is signed as soon as you confirm it is you, and installs on this computer when it next checks in.'
            : 'Installs on this computer only. Two people on the approval roster approve it on the approval signer — not you, and not from here. It runs inside the window you give.'}
        </p>
        {requested}
        {open && (
          <div className="space-y-3">
            <div className="space-y-1">
              <div className="flex items-center justify-between">
                <p className="font-medium">Updates ({installable.length} installable)</p>
                <Button size="sm" variant="ghost" className="h-6 text-xs" data-testid="patch-select-all"
                  onClick={() => setPicked(picked.size === installable.length ? new Set() : new Set(installable.map(key)))}>
                  {picked.size === installable.length ? 'Select none' : 'Select all'}
                </Button>
              </div>
              {installable.map((u) => {
                const k = key(u);
                return (
                  <label key={k} className="flex items-start gap-2 rounded-md border p-2">
                    <input type="checkbox" className="mt-0.5" checked={picked.has(k)} onChange={(e) => setPicked((s) => { const n = new Set(s); if (e.target.checked) n.add(k); else n.delete(k); return n; })} />
                    <span>{u.kb && <strong>{u.kb} </strong>}{u.title}<span className="block text-muted-foreground">{u.className ?? 'Unclassified'}{u.severity ? ` · ${u.severity}` : ''}{u.rebootBehavior > 0 ? ' · may need a restart' : ''}</span></span>
                  </label>
                );
              })}
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 max-w-xl">
              <RebootChoice id="inst-reboot" value={reboot} onChange={setReboot} scope="plan" />
              <div className="space-y-1">
                <Label htmlFor="inst-window" className="text-xs">Window to run in (hours)</Label>
                <Input id="inst-window" type="number" min={1} max={24} value={windowHours} onChange={(e) => setWindowHours(Math.min(24, Math.max(1, Number(e.target.value) || 1)))} />
              </div>
            </div>
            <div className="space-y-1 max-w-xl">
              <Label htmlFor="inst-reason" className="text-xs">{direct ? 'Note (optional, recorded in the audit log)' : 'Reason (shown to the approvers)'}</Label>
              <Input id="inst-reason" maxLength={400} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. the user reports the November CU is missing" />
            </div>
            <div className="flex gap-2">
              <Button size="sm" data-testid="patch-install-go" disabled={picked.size === 0 || (!direct && reason.trim().length < 3) || (reason.trim().length > 0 && reason.trim().length < 3) || go.isPending} onClick={() => go.mutate()}>
                {go.isPending && <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />}{direct ? (picked.size ? `Install ${picked.size} selected` : 'Install selected') : 'Request approval'}
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setOpen(false)}>Cancel</Button>
            </div>
            <p className="text-muted-foreground">Fixture-tested only: proven against a simulated Windows Update and synthetic passkeys, not yet on a real Windows computer.</p>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

export function EndpointPatches({ endpointId, platform, onOpenAgentCard }: { endpointId: string; platform?: unknown; onOpenAgentCard?: () => void }) {
  // The read-only Linux and macOS agents report through the same basic scan; their words are their own (0.35).
  const os = osName(platform);
  const source = updateSourceLabel(platform);
  const { toast } = useToast();
  const qc = useQueryClient();
  // A basic scan has no request marker on the server, so poll for a while after Scan now.
  const [waitUntil, setWaitUntil] = useState(0);
  const { data: p, isLoading } = useQuery({
    queryKey: ['endpoint-patches', endpointId],
    queryFn: () => patchingApi.endpoint(endpointId).then((r) => r.data.data as Patches),
    refetchInterval: (q) => ((q.state.data as Patches | undefined)?.scanPending || Date.now() < waitUntil ? 20_000 : false),
  });
  const rescan = useMutation({
    mutationFn: () => endpointsApi.refreshInventory(endpointId),
    onSuccess: () => { setWaitUntil(Date.now() + 10 * 60_000); qc.invalidateQueries({ queryKey: ['endpoint-patches', endpointId] }); toast({ title: 'Scan requested', description: 'The computer scans at its next check-in and reports back.' }); },
    onError: () => toast({ title: 'Not requested', variant: 'destructive' }),
  });

  if (isLoading || !p) return <p className="text-sm text-muted-foreground">Loading…</p>;
  if (!p.supported && !p.scannedAt) {
    // Every agent answers the inventory's update scan (every 12 hours, or on
    // Scan now), so there is always something to show. Installing through a
    // deployment is what needs the signed agent — not seeing the updates.
    const b = p.basic;
    return (
      <div className="space-y-4">
        <PatchSummaryCard s={p.summary} platform={platform} />
        <InstallUpdates endpointId={endpointId} p={p} onOpenAgentCard={onOpenAgentCard} />
        <Card>
          <CardHeader className="pb-3 flex flex-row items-center justify-between space-y-0">
            <CardTitle className="text-sm flex items-center gap-2"><ShieldCheck className="h-4 w-4" />{source}</CardTitle>
            <Button size="sm" variant="outline" disabled={rescan.isPending} onClick={() => rescan.mutate()}>
              {rescan.isPending ? <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5 mr-1" />}Scan now
            </Button>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            <p className="text-xs text-muted-foreground">
              {b?.checkedAt ? `Last scanned ${formatDate(b.checkedAt)}` : 'Not scanned yet — the agent scans automatically within 12 hours of its first check-in.'}
            </p>
            {b?.rebootRequired && (
              <p className="text-xs flex gap-2"><AlertTriangle className="h-3.5 w-3.5 shrink-0 mt-0.5 text-yellow-600" />A restart is pending. Rem0te restarts a computer only when an approved update install with the in-window restart rule does it.</p>
            )}
            {b?.checkedAt && <p className="text-xs">{b.updates.length === 0 ? (os === 'Windows' ? 'Windows Update offers nothing.' : 'No pending updates reported.') : `${b.updates.length} update${b.updates.length === 1 ? '' : 's'} offered.`}</p>}
            <p className="text-xs text-muted-foreground">
              {os === 'Linux' || os === 'macOS' ? (
                <>Reported by the read-only {os} agent{os === 'Linux' ? ', from apt, dnf or zypper as they stand (it never refreshes a repository)' : ', from softwareupdate'}. rem0te installs nothing on {os}: <Link className="underline" href="/patching">patch deployments</Link> are Windows only.</>
              ) : (
                <>Reported by the standard agent. Installing these through a <Link className="underline" href="/patching">patch deployment</Link> needs the signed agent (update channel <code>signed</code>), which runs only plans approved on the roster — see <Link className="underline" href="/docs/staged-patching">Staged patching</Link>.</>
              )}
            </p>
          </CardContent>
        </Card>
        {b && b.updates.length > 0 && (
          <Card>
            <CardHeader className="pb-3"><CardTitle className="text-sm">Offered</CardTitle></CardHeader>
            <CardContent className="space-y-2">
              {b.updates.map((u, i) => (
                <div key={`${u.kb ?? ''}-${i}`} className="rounded-md border p-2 text-xs space-y-1">
                  <div className="flex flex-wrap items-center gap-2">{u.kb && <strong>{u.kb}</strong>}<span>{u.title}</span></div>
                  <div className="flex flex-wrap items-center gap-2 text-muted-foreground">
                    {u.severity && <Badge variant={u.severity === 'Critical' ? 'destructive' : 'outline'} className="text-[10px]">{u.severity}</Badge>}
                    {u.sizeBytes ? <span>{size(u.sizeBytes)}</span> : null}
                  </div>
                </div>
              ))}
            </CardContent>
          </Card>
        )}
      </div>
    );
  }
  const installable = p.updates.filter((u) => u.installable);
  return (
    <div className="space-y-4">
      <PatchSummaryCard s={p.summary} platform={platform} />
      <InstallUpdates endpointId={endpointId} p={p} onOpenAgentCard={onOpenAgentCard} />
      <Card>
        <CardHeader className="pb-3 flex flex-row items-center justify-between space-y-0">
          <CardTitle className="text-sm flex items-center gap-2"><ShieldCheck className="h-4 w-4" />Windows Update</CardTitle>
          <Button size="sm" variant="outline" disabled={rescan.isPending || p.scanPending} onClick={() => rescan.mutate()}>
            {rescan.isPending || p.scanPending ? <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5 mr-1" />}
            {p.scanPending ? 'Scan requested' : 'Scan now'}
          </Button>
        </CardHeader>
        <CardContent className="space-y-2 text-sm">
          <p className="text-xs text-muted-foreground">
            {p.scannedAt ? `Last scanned ${formatDate(p.scannedAt)}` : 'Not scanned yet'} · automatic updates {p.autoUpdate ?? 'unknown'}
          </p>
          {p.error && <p className="text-xs text-destructive">The last scan failed: {p.error}. The lists below may be out of date.</p>}
          {p.managers.length > 0 && (
            <div className="rounded-md border border-yellow-300 bg-yellow-50 dark:border-yellow-800 dark:bg-yellow-950/40 p-3 text-xs flex gap-2">
              <AlertTriangle className="h-3.5 w-3.5 shrink-0 mt-0.5 text-yellow-600" />
              <span>Updates on this computer are managed by <strong>{p.managers.map((m) => m.label).join(', ')}</strong>. Rem0te will not install updates here — the computer itself refuses, so the two do not fight over it.</span>
            </div>
          )}
          {p.reboot?.pending && (
            <p className="text-xs flex gap-2"><AlertTriangle className="h-3.5 w-3.5 shrink-0 mt-0.5 text-yellow-600" />A restart is pending ({p.reboot.sources.map((s) => REBOOT_SOURCE[s] ?? s).join(', ')}). Installed updates take effect after a restart: someone restarts it, or an approved install with the in-window restart rule does.</p>
          )}
          <p className="text-xs">
            {p.updates.length === 0 ? 'Windows Update offers nothing.' : `${p.updates.length} offered, ${installable.length} installable by a deployment.`}{' '}
            <Link className="underline" href="/patching">Patch deployments</Link>
          </p>
        </CardContent>
      </Card>

      {p.updates.length > 0 && (
        <Card>
          <CardHeader className="pb-3"><CardTitle className="text-sm">Offered</CardTitle></CardHeader>
          <CardContent className="space-y-2">
            {p.updates.map((u) => (
              <div key={`${u.updateId}@${u.revision}`} className="rounded-md border p-2 text-xs space-y-1">
                <div className="flex flex-wrap items-center gap-2">
                  {u.kb && <strong>{u.kb}</strong>}
                  <span>{u.title}</span>
                </div>
                <div className="flex flex-wrap items-center gap-2 text-muted-foreground">
                  <Badge variant="outline" className="text-[10px]">{u.className ?? 'Unclassified'}</Badge>
                  {u.severity && <Badge variant={u.severity === 'Critical' ? 'destructive' : 'outline'} className="text-[10px]">{u.severity}</Badge>}
                  <span>{size(u.sizeBytes)}{u.downloaded ? ', downloaded' : ''}{u.rebootBehavior > 0 ? ', may need a restart' : ''}</span>
                  {u.installable ? <Badge variant="success" className="text-[10px]">installable</Badge> : <span>not installable: {u.notInstallableBecause}</span>}
                </div>
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader className="pb-3"><CardTitle className="text-sm">Update history (from Windows)</CardTitle></CardHeader>
        <CardContent className="space-y-1 text-xs">
          {p.history.length === 0 ? <p className="text-muted-foreground">None reported.</p> : p.history.map((h, i) => (
            <div key={`${h.updateId}-${h.date}-${i}`} className="flex flex-wrap items-center gap-2">
              <Badge variant={RESULT[h.result] ?? 'outline'} className="text-[10px]">{h.result.replace(/_/g, ' ')}</Badge>
              <span className="text-muted-foreground">{h.date ? formatDate(h.date) : ''}</span>
              <span>{h.operation !== 'install' ? `${h.operation}: ` : ''}{h.kb ? <strong>{h.kb} </strong> : null}{h.title}</span>
              {h.hresult && h.result !== 'succeeded' && <code>{h.hresult}</code>}
            </div>
          ))}
        </CardContent>
      </Card>
    </div>
  );
}
