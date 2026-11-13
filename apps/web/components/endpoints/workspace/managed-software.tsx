'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, ExternalLink, Loader2, Package, Search } from 'lucide-react';
import { actionsApi, softwareApi, type SoftwareDetection } from '@/lib/api-client';
import { DIRECT_REQUEST_NOTE, DIRECT_TOAST } from '@/lib/direct-mode';
import { formatDate } from '@/lib/utils';
import { useToast } from '@/hooks/use-toast';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { describeDetection, refusalText } from '@/components/software/software-ui';
import { ago } from './device-model';

/**
 * Managed software on one computer (0.34): every catalog entry that applies
 * here, whether its detection rule holds, the last software plan, and Install /
 * Uninstall. Each button makes a one-computer deployment. The buttons appear
 * only when the server says the request is possible; otherwise its reason and
 * fix are shown.
 *
 * 0.41: a search of the winget community catalog with one-click Install (the
 * server makes or reuses the catalog entry from the package's manifest), and
 * Uninstall for any program in the installed-software list (see
 * software-tab.tsx, which uses RemoveProgramDialog from here). In direct mode
 * (the approval signer's setting, 0.40) nothing here says anyone approves.
 */

export interface Availability { possible: boolean; reason: string | null; fix: string | null; warning: string | null }
interface Row {
  id: string; name: string; publisher: string | null; packageId: string; version: string; scope: string; detection: SoftwareDetection;
  compliance: 'compliant' | 'outdated' | 'missing' | 'unknown'; stale: boolean;
  evidence: { source: 'inventory' | 'agent'; at: string; state: string; version: string | null } | null;
  last: { jobId: string; operation: 'install' | 'uninstall'; status: string; outcome: string | null; reason: string | null; at: string; deploymentId: string | null } | null;
}
export interface InstalledProgram {
  name: string; version: string | null; publisher: string | null; key: string | null; view: '64' | '32' | null; entryId: string | null;
  removal: { possible: boolean; method: 'catalog' | 'msi' | 'quiet' | null; reason: string | null };
  last: { jobId: string; status: string; outcome: string | null; reason: string | null; at: string } | null;
}
export interface EndpointSoftware {
  inventoryAt: string | null; install: Availability; uninstall: Availability; remove: Availability;
  approval: 'direct' | 'signed' | null; architecture: string; installed: InstalledProgram[]; entries: Row[];
}
interface CatalogAction { id: string; title: string; description: string; warnings: string[]; acknowledge: string; verification: string; doesNotProve: string[]; maxWindowHours: number }
interface WingetHit { packageId: string; name: string; publisher: string | null; moniker: string | null; latestVersion: string; installable: boolean }
interface WingetSearchResult { query: string; results: WingetHit[]; index: { refreshedAt: string | null; packages: number; lastError: string | null; sweep: 'on' | 'off' } }

const STATE: Record<Row['compliance'], { label: string; variant: 'success' | 'warning' | 'destructive' | 'outline' }> = {
  compliant: { label: 'installed', variant: 'success' }, outdated: { label: 'outdated', variant: 'warning' },
  missing: { label: 'not installed', variant: 'outline' }, unknown: { label: 'unknown', variant: 'outline' },
};
const words = (s: string) => s.toLowerCase().replace(/_/g, ' ');

/** The computer's software as the server sees it; the Software tab's two cards share one query. */
export function useEndpointSoftware(endpointId: string) {
  return useQuery({
    queryKey: ['endpoint-software', endpointId],
    queryFn: () => softwareApi.endpoint(endpointId).then((r) => r.data.data as EndpointSoftware),
    retry: false,
  });
}

function NotPossible({ op, a }: { op: string; a: Availability }) {
  return (
    <p className="text-xs" data-not-possible={op}>
      <span className="font-medium">{op} is not possible: </span>{a.reason}{a.fix ? <span className="text-muted-foreground"> {a.fix}</span> : null}
    </p>
  );
}

type Asking =
  | { kind: 'entry'; row: Row; op: 'install' | 'uninstall' }
  | { kind: 'winget'; hit: WingetHit };

export function ManagedSoftware({ endpointId }: { endpointId: string }) {
  const { data, error, isLoading } = useEndpointSoftware(endpointId);
  const [asking, setAsking] = useState<Asking | null>(null);
  const direct = data?.approval === 'direct';

  return (
    <Card data-testid="managed-software">
      <CardHeader className="pb-3">
        <CardTitle className="text-sm flex items-center gap-2"><Package className="h-4 w-4" />Managed software</CardTitle>
        <p className="text-xs text-muted-foreground">
          Packages from the <Link className="underline" href="/automation/software">software catalog</Link>, and any package in the winget community catalog.{' '}
          {direct
            ? 'Direct mode is on for this business: installing or uninstalling one is signed at once and runs when the computer next checks in.'
            : 'Installing or uninstalling one creates a plan that two people approve on the approval signer.'}
        </p>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        {isLoading ? <p className="text-muted-foreground">Loading…</p>
          : error ? <p className="text-muted-foreground">{refusalText(error, 'The software catalog for this computer could not be loaded.')}</p>
          : data && (
            <>
              {(!data.install.possible || !data.uninstall.possible) && (
                <div className="space-y-1 rounded-md border p-2">
                  {!data.install.possible && <NotPossible op="Install" a={data.install} />}
                  {!data.uninstall.possible && (data.install.possible || data.uninstall.reason !== data.install.reason) && <NotPossible op="Uninstall" a={data.uninstall} />}
                </div>
              )}
              {[data.install.warning, data.uninstall.warning].filter((w, i, a): w is string => !!w && a.indexOf(w) === i).map((w) => (
                <p key={w} className="text-xs flex gap-2" data-software-warning><AlertTriangle className="h-3.5 w-3.5 shrink-0 mt-0.5 text-yellow-600" />{w}</p>
              ))}
              <WingetSearch canInstall={data.install.possible} architecture={data.architecture} onInstall={(hit) => setAsking({ kind: 'winget', hit })} />
              {data.entries.length === 0 ? <p className="text-muted-foreground">The catalog has nothing for this computer&apos;s business yet. Search above to install a package; it is added to the catalog as it is installed.</p> : (
                <div className="overflow-x-auto rounded-md border">
                  <table className="w-full text-left text-xs">
                    <thead className="text-muted-foreground">
                      <tr><th className="px-3 py-1.5 font-medium">Software</th><th className="px-3 font-medium">State</th><th className="px-3 font-medium">Last plan</th><th className="px-3 font-medium" /></tr>
                    </thead>
                    <tbody>
                      {data.entries.map((e) => {
                        const s = STATE[e.compliance];
                        return (
                          <tr key={e.id} className="border-t align-top" data-managed-row>
                            <td className="px-3 py-1.5">
                              <Link className="font-medium underline" href={`/automation/software/${e.id}`}>{e.name}</Link> <span className="font-mono">{e.version}</span>
                              <span className="block text-muted-foreground font-mono">{e.packageId}</span>
                            </td>
                            <td className="px-3 py-1.5">
                              <Badge variant={s.variant} className="text-[10px]">{s.label}</Badge>
                              <span className="block text-muted-foreground" title={describeDetection(e.detection)}>
                                {e.evidence ? `${e.evidence.version ? `${e.evidence.version} · ` : ''}from ${e.evidence.source === 'agent' ? 'a software plan' : 'the inventory'} ${ago(e.evidence.at)}${e.stale ? ' (stale)' : ''}` : 'no evidence yet'}
                              </span>
                            </td>
                            <td className="px-3 py-1.5">
                              {e.last ? (
                                <>
                                  {e.last.operation} · {e.last.outcome ? words(e.last.outcome) : words(e.last.status)}{e.last.reason ? ` (${words(e.last.reason)})` : ''}
                                  <span className="block text-muted-foreground" title={formatDate(e.last.at)}>
                                    {ago(e.last.at)}{e.last.deploymentId && <> · <Link className="underline" href={`/automation/software/deployments/${e.last.deploymentId}`}>deployment</Link></>}
                                  </span>
                                </>
                              ) : <span className="text-muted-foreground">—</span>}
                            </td>
                            <td className="px-3 py-1.5 whitespace-nowrap text-right">
                              {data.install.possible && <Button size="sm" variant="outline" className="h-7 text-xs mr-1" onClick={() => setAsking({ kind: 'entry', row: e, op: 'install' })}>Install</Button>}
                              {data.uninstall.possible && <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={() => setAsking({ kind: 'entry', row: e, op: 'uninstall' })}>Uninstall</Button>}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
              {data.inventoryAt && <p className="text-xs text-muted-foreground">Inventory {ago(data.inventoryAt)}. Only display-name rules are read from it; the other rules are known once a software plan has run here.</p>}
            </>
          )}
      </CardContent>
      {asking?.kind === 'entry' && data && (
        <RequestDialog
          endpointId={endpointId} direct={direct} actionId={`windows.software.${asking.op}`} warning={data[asking.op].warning}
          title={`${asking.op === 'install' ? 'Install' : 'Uninstall'} ${asking.row.name} ${asking.op === 'install' ? asking.row.version : ''}`}
          fallback={`${asking.op === 'install' ? 'Installs' : 'Uninstalls'} ${asking.row.packageId} on this computer.`}
          verb={asking.op}
          send={(reason, windowHours) => softwareApi.single(endpointId, asking.row.id, asking.op, { reason, windowHours })}
          onClose={() => setAsking(null)}
        />
      )}
      {asking?.kind === 'winget' && data && (
        <RequestDialog
          endpointId={endpointId} direct={direct} actionId="windows.software.install" warning={data.install.warning}
          title={`Install ${asking.hit.name} ${asking.hit.latestVersion}`}
          fallback={`Installs ${asking.hit.packageId} on this computer.`}
          verb="install"
          note={`The server reads ${asking.hit.packageId} ${asking.hit.latestVersion}'s installer manifest from winget-pkgs, picks the machine-wide installer winget would choose for this computer (${data.architecture}), pins its SHA-256 and derives how to tell it is installed. If this business's catalog has no entry for it at that version, one is added (Business Owner or Platform Admin only, with a fresh sign-in). The computer hashes what winget downloads and refuses a mismatch.`}
          send={(reason, windowHours) => softwareApi.quickInstall(endpointId, { packageId: asking.hit.packageId, version: asking.hit.latestVersion, ...(reason ? { reason } : {}), windowHours })}
          optionalReason
          onClose={() => setAsking(null)}
        />
      )}
    </Card>
  );
}

function WingetSearch({ canInstall, architecture, onInstall }: { canInstall: boolean; architecture: string; onInstall: (h: WingetHit) => void }) {
  const [q, setQ] = useState('');
  const [asked, setAsked] = useState('');
  const { data, error, isFetching } = useQuery({
    queryKey: ['winget-search', asked],
    queryFn: () => softwareApi.wingetSearch(asked).then((r) => r.data.data as WingetSearchResult),
    enabled: asked.length >= 2,
    retry: false,
    staleTime: 60_000,
  });
  return (
    <div className="space-y-2 rounded-md border p-2" data-testid="winget-search">
      <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); setAsked(q.trim()); }}>
        <Input className="h-8" placeholder="Search the winget catalog (name, publisher or package id)" aria-label="Search the winget catalog" value={q} maxLength={64} onChange={(e) => setQ(e.target.value)} />
        <Button type="submit" size="sm" variant="outline" className="h-8" disabled={q.trim().length < 2}>
          {isFetching ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Search className="h-3.5 w-3.5" />}<span className="ml-1">Search</span>
        </Button>
      </form>
      {error && <p className="text-xs text-muted-foreground">{refusalText(error, 'The search failed.')}</p>}
      {data && (
        <>
          {data.index.packages === 0 && (
            <p className="text-xs text-muted-foreground">The server has not read the winget index yet{data.index.lastError ? ` (last attempt: ${data.index.lastError})` : ''}. It reads it daily{data.index.sweep === 'off' ? ', but the sweep is switched off on this server' : ''}; a Platform Admin can read it now on Automation → Software catalog.</p>
          )}
          {data.results.length > 0 ? (
            <ul className="divide-y text-xs" data-winget-results>
              {data.results.map((h) => (
                <li key={h.packageId} className="flex items-center justify-between gap-2 py-1.5" data-winget-hit={h.packageId}>
                  <span className="min-w-0">
                    <span className="font-medium">{h.name}</span> <span className="font-mono">{h.latestVersion}</span>
                    <span className="block text-muted-foreground font-mono truncate">{h.packageId}</span>
                  </span>
                  {canInstall && h.installable && <Button size="sm" variant="outline" className="h-7 text-xs shrink-0" onClick={() => onInstall(h)}>Install</Button>}
                  {!h.installable && <span className="text-muted-foreground shrink-0">version not installable from here</span>}
                </li>
              ))}
            </ul>
          ) : data.index.packages > 0 && <p className="text-xs text-muted-foreground">Nothing in the winget catalog matches “{data.query}”.</p>}
          {data.index.refreshedAt && <p className="text-[11px] text-muted-foreground">Index of {data.index.packages.toLocaleString()} packages, read {ago(data.index.refreshedAt)}. Installs for {architecture}, machine-wide.</p>}
        </>
      )}
    </div>
  );
}

/**
 * The request for one software plan on this computer, as the server will
 * treat it: in direct mode it is signed at once (the reason goes to the audit
 * log); otherwise it waits for two approvers on the approval page.
 */
export function RequestDialog({ endpointId, direct, actionId, warning, title, fallback, verb, note, send, optionalReason, onClose }: {
  endpointId: string; direct: boolean; actionId: string; warning: string | null; title: string; fallback: string; verb: string; note?: string;
  send: (reason: string, windowHours: number) => Promise<{ data: { data: unknown } }>; optionalReason?: boolean; onClose: () => void;
}) {
  const { toast } = useToast();
  const qc = useQueryClient();
  const [reason, setReason] = useState('');
  const [windowHours, setWindowHours] = useState(8);
  const [ack, setAck] = useState(false);
  const [done, setDone] = useState<{ approvalUrl: string | null; deploymentId: string | null; jobDirect: boolean } | null>(null);
  const { data: catalog } = useQuery({
    queryKey: ['actions-catalog', endpointId],
    queryFn: () => actionsApi.catalog(endpointId).then((r) => r.data.data as { configured: boolean; actions: CatalogAction[]; approval: 'direct' | 'signed' | null }),
  });
  const isDirect = catalog ? catalog.approval === 'direct' : direct;
  const action = catalog?.actions.find((a) => a.id === actionId);
  const m = useMutation({
    mutationFn: () => send(reason.trim(), windowHours),
    onSuccess: (r) => {
      const d = r.data.data as { job?: { approvalUrl?: string; direct?: boolean }; deployment?: { id: string } };
      setDone({ approvalUrl: d.job?.approvalUrl ?? null, deploymentId: d.deployment?.id ?? null, jobDirect: !!d.job?.direct });
      if (d.job?.direct) toast({ title: 'Approved automatically', description: DIRECT_TOAST });
      qc.invalidateQueries({ queryKey: ['endpoint-software', endpointId] });
      qc.invalidateQueries({ queryKey: ['endpoint-actions', endpointId] });
    },
    onError: (e) => toast({ title: 'Not requested', description: refusalText(e, 'The request was refused.'), variant: 'destructive' }),
  });
  const reasonOk = optionalReason ? reason.trim().length === 0 || reason.trim().length >= 3 : reason.trim().length >= 3;

  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{action?.description ?? fallback}</DialogDescription>
        </DialogHeader>
        {done ? (
          <div className="space-y-2 text-sm" data-requested>
            {done.jobDirect
              ? <p data-testid="direct-approved">{DIRECT_TOAST}</p>
              : <p>Requested. Nothing runs until two people on the approval roster approve it; you cannot approve your own request.</p>}
            {done.approvalUrl && !done.jobDirect && <p><a className="underline inline-flex items-center gap-1" href={done.approvalUrl} target="_blank" rel="noopener noreferrer"><ExternalLink className="h-3.5 w-3.5" />Open the approval page</a></p>}
            {done.deploymentId && <p className="text-xs"><Link className="underline" href={`/automation/software/deployments/${done.deploymentId}`}>Follow it on its deployment page</Link></p>}
            <DialogFooter><Button size="sm" onClick={onClose}>Close</Button></DialogFooter>
          </div>
        ) : (
          <div className="space-y-3 text-sm">
            {isDirect && <p className="text-xs text-muted-foreground" data-testid="direct-mode-note">{DIRECT_REQUEST_NOTE}</p>}
            {warning && <p className="text-xs flex gap-2"><AlertTriangle className="h-3.5 w-3.5 shrink-0 mt-0.5 text-yellow-600" />{warning}</p>}
            {note && <p className="text-xs text-muted-foreground">{note}</p>}
            {action && (
              <ul className="list-disc pl-5 text-xs space-y-1">{action.warnings.map((w) => <li key={w}>{w}</li>)}</ul>
            )}
            {action && <p className="text-xs text-muted-foreground">{action.verification} It does not prove {action.doesNotProve.join(', ')}.</p>}
            <div className="space-y-1">
              <Label htmlFor="ms-reason" className="text-xs">{isDirect ? 'Why (recorded in the audit log)' : 'Why (shown to the approvers)'}{optionalReason ? ' — optional' : ''}</Label>
              <Textarea id="ms-reason" rows={2} maxLength={400} value={reason} onChange={(e) => setReason(e.target.value)} />
            </div>
            <div className="space-y-1 w-48">
              <Label htmlFor="ms-window" className="text-xs">May run within (hours, 1–24)</Label>
              <Input id="ms-window" type="number" min={1} max={24} value={windowHours} onChange={(e) => setWindowHours(Number(e.target.value))} />
            </div>
            {action ? (
              <label className="flex items-start gap-2 text-xs"><input type="checkbox" className="mt-0.5" checked={ack} onChange={(e) => setAck(e.target.checked)} />{action.acknowledge}</label>
            ) : <p className="text-xs text-muted-foreground">Loading the action&apos;s terms…</p>}
            <DialogFooter>
              <Button size="sm" variant="outline" onClick={onClose}>Cancel</Button>
              <Button size="sm" disabled={!action || !ack || !reasonOk || windowHours < 1 || windowHours > 24 || m.isPending} onClick={() => m.mutate()}>
                {m.isPending && <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />}{isDirect ? `Run ${verb}` : `Request ${verb}`}
              </Button>
            </DialogFooter>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

/** Uninstall a program from the installed-software list: its catalog entry's uninstall, or windows.software.remove. */
export function RemoveProgramDialog({ endpointId, program, data, onClose }: { endpointId: string; program: InstalledProgram; data: EndpointSoftware; onClose: () => void }) {
  const direct = data.approval === 'direct';
  if (program.entryId) {
    return (
      <RequestDialog
        endpointId={endpointId} direct={direct} actionId="windows.software.uninstall" warning={data.uninstall.warning}
        title={`Uninstall ${program.name}`} fallback={`Uninstalls ${program.name} with winget, through its catalog entry.`} verb="uninstall"
        note="A software catalog entry describes this program, so it is uninstalled through that entry (winget uninstall of its package)."
        send={(reason, windowHours) => softwareApi.single(endpointId, program.entryId!, 'uninstall', { reason, windowHours })}
        onClose={onClose}
      />
    );
  }
  return (
    <RequestDialog
      endpointId={endpointId} direct={direct} actionId="windows.software.remove" warning={data.remove.warning}
      title={`Uninstall ${program.name}`} fallback={`Removes ${program.name} by its uninstall key.`} verb="uninstall"
      note={program.removal.method === 'msi'
        ? `A Windows Installer product: the computer runs msiexec /x ${program.key} /qn /norestart after checking the key still names “${program.name}”.`
        : `The computer runs the silent uninstall command this program registered under “${program.key}”, after checking the key still names “${program.name}”.`}
      send={(reason, windowHours) => softwareApi.removeProgram(endpointId, { key: program.key!, view: program.view!, displayName: program.name, ...(reason ? { reason } : {}), windowHours })}
      optionalReason
      onClose={onClose}
    />
  );
}
