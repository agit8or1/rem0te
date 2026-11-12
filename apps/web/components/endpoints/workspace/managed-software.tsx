'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, ExternalLink, Loader2, Package } from 'lucide-react';
import { actionsApi, softwareApi, type SoftwareDetection } from '@/lib/api-client';
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
 * Uninstall. Each button makes a one-computer deployment whose plan waits for
 * two approvals on the approval signer. The buttons appear only when the
 * server says the request is possible; otherwise its reason and fix are shown.
 */

interface Availability { possible: boolean; reason: string | null; fix: string | null; warning: string | null }
interface Row {
  id: string; name: string; publisher: string | null; packageId: string; version: string; scope: string; detection: SoftwareDetection;
  compliance: 'compliant' | 'outdated' | 'missing' | 'unknown'; stale: boolean;
  evidence: { source: 'inventory' | 'agent'; at: string; state: string; version: string | null } | null;
  last: { jobId: string; operation: 'install' | 'uninstall'; status: string; outcome: string | null; reason: string | null; at: string; deploymentId: string | null } | null;
}
interface Data { inventoryAt: string | null; install: Availability; uninstall: Availability; entries: Row[] }
interface CatalogAction { id: string; title: string; description: string; warnings: string[]; acknowledge: string; verification: string; doesNotProve: string[]; maxWindowHours: number }

const STATE: Record<Row['compliance'], { label: string; variant: 'success' | 'warning' | 'destructive' | 'outline' }> = {
  compliant: { label: 'installed', variant: 'success' }, outdated: { label: 'outdated', variant: 'warning' },
  missing: { label: 'not installed', variant: 'outline' }, unknown: { label: 'unknown', variant: 'outline' },
};
const words = (s: string) => s.toLowerCase().replace(/_/g, ' ');

function NotPossible({ op, a }: { op: string; a: Availability }) {
  return (
    <p className="text-xs" data-not-possible={op}>
      <span className="font-medium">{op} is not possible: </span>{a.reason}{a.fix ? <span className="text-muted-foreground"> {a.fix}</span> : null}
    </p>
  );
}

export function ManagedSoftware({ endpointId }: { endpointId: string }) {
  const { data, error, isLoading } = useQuery({
    queryKey: ['endpoint-software', endpointId],
    queryFn: () => softwareApi.endpoint(endpointId).then((r) => r.data.data as Data),
    retry: false,
  });
  const [asking, setAsking] = useState<{ row: Row; op: 'install' | 'uninstall' } | null>(null);

  return (
    <Card data-testid="managed-software">
      <CardHeader className="pb-3">
        <CardTitle className="text-sm flex items-center gap-2"><Package className="h-4 w-4" />Managed software</CardTitle>
        <p className="text-xs text-muted-foreground">
          Packages from the <Link className="underline" href="/automation/software">software catalog</Link>. Installing or uninstalling one creates a plan that two people approve on the approval signer.
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
              {data.entries.length === 0 ? <p className="text-muted-foreground">The catalog has nothing for this computer&apos;s business.</p> : (
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
                              {data.install.possible && <Button size="sm" variant="outline" className="h-7 text-xs mr-1" onClick={() => setAsking({ row: e, op: 'install' })}>Install</Button>}
                              {data.uninstall.possible && <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={() => setAsking({ row: e, op: 'uninstall' })}>Uninstall</Button>}
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
      {asking && <RequestDialog endpointId={endpointId} row={asking.row} op={asking.op} warning={data?.[asking.op].warning ?? null} onClose={() => setAsking(null)} />}
    </Card>
  );
}

function RequestDialog({ endpointId, row, op, warning, onClose }: { endpointId: string; row: Row; op: 'install' | 'uninstall'; warning: string | null; onClose: () => void }) {
  const { toast } = useToast();
  const qc = useQueryClient();
  const [reason, setReason] = useState('');
  const [windowHours, setWindowHours] = useState(8);
  const [ack, setAck] = useState(false);
  const [approvalUrl, setApprovalUrl] = useState<string | null>(null);
  const [deploymentId, setDeploymentId] = useState<string | null>(null);
  const { data: catalog } = useQuery({
    queryKey: ['actions-catalog'],
    queryFn: () => actionsApi.catalog().then((r) => r.data.data as { configured: boolean; actions: CatalogAction[] }),
  });
  const action = catalog?.actions.find((a) => a.id === `windows.software.${op}`);
  const m = useMutation({
    mutationFn: () => softwareApi.single(endpointId, row.id, op, { reason: reason.trim(), windowHours }),
    onSuccess: (r) => {
      const d = r.data.data as { job?: { approvalUrl?: string }; deployment?: { id: string } };
      setApprovalUrl(d.job?.approvalUrl ?? null);
      setDeploymentId(d.deployment?.id ?? null);
      qc.invalidateQueries({ queryKey: ['endpoint-software', endpointId] });
    },
    onError: (e) => toast({ title: 'Not requested', description: refusalText(e, 'The request was refused.'), variant: 'destructive' }),
  });
  const verb = op === 'install' ? 'Install' : 'Uninstall';

  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{verb} {row.name} {op === 'install' ? row.version : ''}</DialogTitle>
          <DialogDescription>{action?.description ?? `${verb}s ${row.packageId} on this computer.`}</DialogDescription>
        </DialogHeader>
        {approvalUrl || deploymentId ? (
          <div className="space-y-2 text-sm" data-requested>
            <p>Requested. Nothing runs until two people on the approval roster approve it; you cannot approve your own request.</p>
            {approvalUrl && <p><a className="underline inline-flex items-center gap-1" href={approvalUrl} target="_blank" rel="noopener noreferrer"><ExternalLink className="h-3.5 w-3.5" />Open the approval page</a></p>}
            {deploymentId && <p className="text-xs"><Link className="underline" href={`/automation/software/deployments/${deploymentId}`}>Follow it on its deployment page</Link></p>}
            <DialogFooter><Button size="sm" onClick={onClose}>Close</Button></DialogFooter>
          </div>
        ) : (
          <div className="space-y-3 text-sm">
            {warning && <p className="text-xs flex gap-2"><AlertTriangle className="h-3.5 w-3.5 shrink-0 mt-0.5 text-yellow-600" />{warning}</p>}
            {action && (
              <ul className="list-disc pl-5 text-xs space-y-1">{action.warnings.map((w) => <li key={w}>{w}</li>)}</ul>
            )}
            {action && <p className="text-xs text-muted-foreground">{action.verification} It does not prove {action.doesNotProve.join(', ')}.</p>}
            <div className="space-y-1">
              <Label htmlFor="ms-reason" className="text-xs">Why (shown to the approvers)</Label>
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
              <Button size="sm" disabled={!action || !ack || reason.trim().length < 3 || windowHours < 1 || windowHours > 24 || m.isPending} onClick={() => m.mutate()}>
                {m.isPending && <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />}Request {op}
              </Button>
            </DialogFooter>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
