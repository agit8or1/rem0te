'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, ArrowLeft, CheckCircle2, OctagonPause, ShieldCheck } from 'lucide-react';
import { auditIntegrityApi, businessesApi, containmentApi, type ContainmentKind } from '@/lib/api-client';
import { usePermissions } from '@/lib/auth';
import { PageHeader } from '@/components/common/page-header';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { apiError } from '@/components/security-controls/shared';

/**
 * Settings → Security → Containment (0.28).
 *
 * Stop writes — for everyone, or for one business — while an incident is
 * looked at. Setting a pause is one click and needs no re-authentication;
 * lifting one needs fresh authentication and, for an MSP pause, someone other
 * than whoever set it. A business's own suspension is lifted only by that
 * business. The approval signer keeps its own copy, which its operator lifts.
 */

type Pause = {
  id: string; scope: 'global' | 'business'; businessId: string | null; businessName: string | null; kinds: ContainmentKind[]; reason: string;
  setBy: 'msp' | 'customer'; setById: string; createdAt: string; signer: { requestedAt: string; result: string | null } | null;
  clearedAt: string | null; clearedById: string | null; clearReason: string | null;
};
type SignerPause = { id: string; scope: string; businessId?: string; reason: string; setBy: string; ref?: string; at: string };
type State = {
  active: Pause[]; history: Pause[]; you: string;
  signer: { configured: boolean; reachable: boolean | null; pauses: SignerPause[] };
  may: { global: boolean; business: 'any' | string | null };
};
type Integrity = {
  headSeq: string; sealedAt: string | null; unsealed: number; sealLagSeconds: number | null;
  export: { configured: string[]; exportedThroughSeq: string; exportedAt: string | null; error: string | null; lagSeconds: number | null };
  verify: { at: string | null; throughSeq: string; ok: boolean | null; problems: { seq: string; kind: string; detail: string }[]; checked: number };
  checkpoints: { signed: boolean; keyId: string | null; last: { seq: string; at: string } | null };
};

const KINDS: { id: ContainmentKind; label: string; hint: string }[] = [
  { id: 'actions', label: 'Approved actions', hint: 'New requests, and delivery of plans already approved. Also sent to the approval signer.' },
  { id: 'remote', label: 'Remote connections', hint: 'Connect, launcher links and Quick Connect.' },
  { id: 'updates', label: 'Agent updates', hint: 'RustDesk and agent update or reinstall instructions, and rollout dispatch.' },
  { id: 'integration', label: 'ClientSt0r jobs', hint: 'New ticket-analysis jobs, and queued ones.' },
  { id: 'notifications', label: 'Outbound email', hint: 'Alert emails, scheduled reports, address confirmations and test emails. Alert webhooks are not covered.' },
];
const label = (k: string) => KINDS.find((x) => x.id === k)?.label ?? k;
const fmt = (d: string | null | undefined) => (d ? new Date(d).toLocaleString() : '—');

export default function ContainmentPage() {
  const { user, businessId, businessName, canManageTechnicians, isPlatformAdmin, technician } = usePermissions();
  const qc = useQueryClient();
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null);
  const msp = (isPlatformAdmin || canManageTechnicians) && !technician;

  const { data, isLoading, error } = useQuery<State>({
    queryKey: ['containment'],
    queryFn: () => containmentApi.state().then((r) => r.data.data),
    enabled: !!user,
    retry: false,
  });
  const { data: businesses } = useQuery<{ id: string; name: string }[]>({
    queryKey: ['businesses-for-containment'],
    queryFn: () => businessesApi.list().then((r) => ((r.data as { data?: { id: string; name: string }[] })?.data ?? [])),
    enabled: !!data && data.may.business === 'any',
  });
  const { data: integrity } = useQuery<Integrity>({
    queryKey: ['audit-integrity'],
    queryFn: () => auditIntegrityApi.get().then((r) => r.data.data),
    enabled: msp,
    retry: false,
  });

  const refresh = () => { qc.invalidateQueries({ queryKey: ['containment'] }); qc.invalidateQueries({ queryKey: ['containment-banner'] }); };
  const fail = (e: unknown) => setNotice({ ok: false, text: apiError(e).message });

  // ── Set ────────────────────────────────────────────────────────────────
  const [scope, setScope] = useState<'global' | 'business'>('business');
  const [target, setTarget] = useState<string>('');
  const [kinds, setKinds] = useState<ContainmentKind[]>(KINDS.map((k) => k.id));
  const [reason, setReason] = useState('');
  const set = useMutation({
    mutationFn: () => containmentApi.set({
      scope, ...(scope === 'business' ? { businessId: data?.may.business === 'any' ? target : (data?.may.business as string) } : {}), kinds, reason,
    }).then((r) => r.data.data as Pause),
    onSuccess: (p) => {
      setReason('');
      setNotice({ ok: true, text: `Paused${p.signer?.result ? ` · approval signer: ${p.signer.result}` : ''}.` });
      refresh();
    },
    onError: fail,
  });

  // ── Clear ──────────────────────────────────────────────────────────────
  const [clearing, setClearing] = useState<string | null>(null);
  const [clearReason, setClearReason] = useState('');
  const clear = useMutation({
    mutationFn: (id: string) => containmentApi.clear(id, clearReason).then((r) => r.data.data as Pause),
    onSuccess: (p) => {
      setClearing(null); setClearReason('');
      setNotice({ ok: true, text: p.signer ? 'Lifted in the portal. The approval signer still holds its copy — its operator lifts it with the signer CLI (pause clear).' : 'Lifted.' });
      refresh();
    },
    onError: fail,
  });

  const verify = useMutation({
    mutationFn: () => auditIntegrityApi.verify().then((r) => r.data.data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['audit-integrity'] }),
    onError: fail,
  });

  if (!user) return null;
  if (error) {
    return <div className="p-6 text-sm text-muted-foreground">{apiError(error).message}</div>;
  }

  const canSet = !!data && (data.may.global || !!data.may.business);
  const ownBusinessOnly = data && data.may.business && data.may.business !== 'any';
  const reasonOk = reason.trim().length >= 3 && (scope === 'global' || data?.may.business !== 'any' || !!target) && kinds.length > 0;

  return (
    <div className="space-y-4 p-4 md:p-6">
      <Link href="/settings" className="inline-flex items-center text-sm text-muted-foreground hover:underline">
        <ArrowLeft className="mr-1 h-4 w-4" />Settings
      </Link>
      <PageHeader title="Containment" description="Stop writes while an incident is investigated — for every business, or one. Viewing and the audit log keep working." />
      {isLoading && <p className="text-sm text-muted-foreground">Loading…</p>}
      {notice && (
        <div className={`rounded-md border p-3 text-sm ${notice.ok ? 'border-emerald-300 bg-emerald-50 text-emerald-900 dark:bg-emerald-950 dark:text-emerald-100' : 'border-destructive/40 bg-destructive/10 text-destructive'}`}>{notice.text}</div>
      )}

      {data && (
        <>
          <Card>
            <CardHeader><CardTitle className="text-sm">Active</CardTitle></CardHeader>
            <CardContent className="space-y-3 text-sm">
              {data.active.length === 0 && <p className="flex items-center gap-2 text-muted-foreground"><CheckCircle2 className="h-4 w-4 text-emerald-600" />Nothing is paused.</p>}
              {data.active.map((p) => (
                <div key={p.id} className="rounded-md border border-red-300 p-3 dark:border-red-900">
                  <div className="flex flex-wrap items-center gap-2">
                    <OctagonPause className="h-4 w-4 text-red-600" />
                    <strong>{p.scope === 'global' ? 'Every business' : p.businessName ?? p.businessId}</strong>
                    {p.kinds.map((k) => <Badge key={k} variant="secondary">{label(k)}</Badge>)}
                    <Badge variant="outline">{p.setBy === 'customer' ? 'set by the business' : 'set by the MSP'}</Badge>
                    {p.setById === data.you && <Badge variant="outline">you set this</Badge>}
                  </div>
                  <p className="mt-1">{p.reason}</p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    Since {fmt(p.createdAt)}
                    {p.signer && <> · approval signer: {p.signer.result ?? 'requested'}</>}
                  </p>
                  {clearing === p.id ? (
                    <div className="mt-2 space-y-2">
                      <Label htmlFor={`clear-${p.id}`}>Why is it safe to resume?</Label>
                      <Textarea id={`clear-${p.id}`} value={clearReason} onChange={(e) => setClearReason(e.target.value)} rows={2} maxLength={300} />
                      <div className="flex gap-2">
                        <Button size="sm" disabled={clearReason.trim().length < 3 || clear.isPending} onClick={() => clear.mutate(p.id)}>Lift (re-authenticate)</Button>
                        <Button size="sm" variant="ghost" onClick={() => setClearing(null)}>Cancel</Button>
                      </div>
                      <p className="text-xs text-muted-foreground">
                        {p.setBy === 'customer' ? 'Only an owner of this business can lift a suspension it set itself.' : 'Someone other than whoever set it must lift it.'}
                      </p>
                    </div>
                  ) : (
                    <Button size="sm" variant="outline" className="mt-2" onClick={() => { setClearing(p.id); setClearReason(''); }}>Lift…</Button>
                  )}
                </div>
              ))}
            </CardContent>
          </Card>

          {canSet && (
            <Card>
              <CardHeader><CardTitle className="text-sm">Pause</CardTitle></CardHeader>
              <CardContent className="space-y-3 text-sm">
                <p className="text-muted-foreground">
                  Takes effect at once and needs no re-authentication. {ownBusinessOnly
                    ? <>As an owner of {businessName ?? 'this business'}, you can suspend it; only an owner of it can lift that — your MSP cannot.</>
                    : <>Lifting needs someone other than you.</>}
                </p>
                {data.may.global && (
                  <div className="flex flex-wrap gap-4">
                    <label className="flex items-center gap-2"><input type="radio" checked={scope === 'business'} onChange={() => setScope('business')} />One business</label>
                    <label className="flex items-center gap-2"><input type="radio" checked={scope === 'global'} onChange={() => setScope('global')} />Every business (global write pause)</label>
                  </div>
                )}
                {scope === 'business' && data.may.business === 'any' && (
                  <div className="space-y-1">
                    <Label htmlFor="ct-business">Business</Label>
                    <select id="ct-business" className="w-full rounded-md border bg-background p-2 md:w-96" value={target} onChange={(e) => setTarget(e.target.value)}>
                      <option value="">Choose…</option>
                      {(businesses ?? []).map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
                    </select>
                  </div>
                )}
                {scope === 'business' && ownBusinessOnly && <p>Business: <strong>{businessName ?? businessId}</strong></p>}
                <fieldset className="space-y-1">
                  <legend className="mb-1 font-medium">Stop</legend>
                  {KINDS.map((k) => (
                    <label key={k.id} className="flex items-start gap-2">
                      <input type="checkbox" className="mt-1" checked={kinds.includes(k.id)} onChange={(e) => setKinds(e.target.checked ? [...kinds, k.id] : kinds.filter((x) => x !== k.id))} />
                      <span><span className="font-medium">{k.label}</span> <span className="text-muted-foreground">— {k.hint}</span></span>
                    </label>
                  ))}
                </fieldset>
                <div className="space-y-1">
                  <Label htmlFor="ct-reason">Reason (shown to everyone it affects)</Label>
                  <Textarea id="ct-reason" value={reason} onChange={(e) => setReason(e.target.value)} rows={2} maxLength={300} placeholder="e.g. Investigating a possibly phished technician account" />
                </div>
                <Button variant="destructive" disabled={!reasonOk || set.isPending} onClick={() => set.mutate()}>
                  <OctagonPause className="mr-2 h-4 w-4" />Pause now
                </Button>
              </CardContent>
            </Card>
          )}

          {msp && (
            <Card>
              <CardHeader><CardTitle className="text-sm">Approval signer</CardTitle></CardHeader>
              <CardContent className="space-y-2 text-sm">
                {!data.signer.configured ? <p className="text-muted-foreground">No approval signer is configured.</p> : data.signer.reachable === false ? (
                  <p className="flex items-center gap-2 text-destructive"><AlertTriangle className="h-4 w-4" />The signer did not answer.</p>
                ) : data.signer.pauses.length === 0 ? <p className="text-muted-foreground">The signer holds no pause.</p> : (
                  <ul className="space-y-1">
                    {data.signer.pauses.map((p) => <li key={p.id}><Badge variant="secondary">{p.scope}{p.businessId ? ` ${p.businessId.slice(0, 8)}…` : ''}</Badge> {p.reason} <span className="text-xs text-muted-foreground">({p.setBy}, {fmt(p.at)})</span></li>)}
                  </ul>
                )}
                <p className="text-xs text-muted-foreground">
                  The portal can ask the signer to pause, never to resume. Its operator lifts a pause on the signer host:{' '}
                  <code>node dist/approval-signer/main.js pause clear --id … --reason …</code>. The layer that holds even if this portal is
                  compromised is the signed <code>control/pause.json</code>, published from the release machine — see{' '}
                  <Link className="underline" href="/docs/containment">Containment</Link>.
                </p>
              </CardContent>
            </Card>
          )}

          {msp && integrity && (
            <Card>
              <CardHeader><CardTitle className="flex items-center gap-2 text-sm"><ShieldCheck className="h-4 w-4" />Audit log integrity</CardTitle></CardHeader>
              <CardContent className="space-y-2 text-sm">
                <div className="flex flex-wrap items-center gap-2">
                  {integrity.verify.ok === null ? <Badge variant="secondary">Not yet verified</Badge>
                    : integrity.verify.ok ? <Badge>Intact</Badge> : <Badge variant="destructive">Broken</Badge>}
                  <span className="text-muted-foreground">{integrity.verify.checked} entries checked through {integrity.verify.throughSeq}, {fmt(integrity.verify.at)}</span>
                  <Button size="sm" variant="outline" disabled={verify.isPending} onClick={() => verify.mutate()}>{verify.isPending ? 'Verifying…' : 'Verify now'}</Button>
                </div>
                {integrity.verify.problems.length > 0 && (
                  <ul className="space-y-1 text-destructive">
                    {integrity.verify.problems.slice(0, 10).map((p) => <li key={`${p.kind}-${p.seq}`}>Entry {p.seq}: {p.kind.replace(/_/g, ' ')} — {p.detail}</li>)}
                  </ul>
                )}
                <p>Sealed through entry {integrity.headSeq}{integrity.unsealed ? ` (${integrity.unsealed} waiting, ${integrity.sealLagSeconds ?? 0}s)` : ''}.</p>
                <p>
                  Export: {integrity.export.configured.length ? `${integrity.export.configured.join(' + ')}, through entry ${integrity.export.exportedThroughSeq}` : <span className="text-amber-700 dark:text-amber-300">not configured — without an off-host copy, a rewrite of the whole chain is not detectable</span>}
                  {integrity.export.error && <span className="text-destructive"> · failing: {integrity.export.error}</span>}
                </p>
                <p>Checkpoints: {integrity.checkpoints.signed ? `signed (key ${integrity.checkpoints.keyId})` : 'unsigned'}{integrity.checkpoints.last ? `, last at entry ${integrity.checkpoints.last.seq}` : ''}.</p>
              </CardContent>
            </Card>
          )}

          {data.history.length > 0 && (
            <Card>
              <CardHeader><CardTitle className="text-sm">Recently lifted</CardTitle></CardHeader>
              <CardContent className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead className="text-left text-muted-foreground"><tr><th className="py-1 pr-3">Scope</th><th className="pr-3">Stopped</th><th className="pr-3">Why</th><th className="pr-3">From</th><th className="pr-3">Lifted</th><th>Why lifted</th></tr></thead>
                  <tbody>
                    {data.history.map((p) => (
                      <tr key={p.id} className="border-t align-top">
                        <td className="py-1 pr-3">{p.scope === 'global' ? 'Every business' : p.businessName ?? p.businessId}</td>
                        <td className="pr-3">{p.kinds.map(label).join(', ')}</td>
                        <td className="pr-3">{p.reason}</td>
                        <td className="pr-3">{fmt(p.createdAt)}</td>
                        <td className="pr-3">{fmt(p.clearedAt)}</td>
                        <td>{p.clearReason}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </CardContent>
            </Card>
          )}
        </>
      )}
    </div>
  );
}
