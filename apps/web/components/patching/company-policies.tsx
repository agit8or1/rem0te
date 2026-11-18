'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { patchingApi, type PatchPolicySettingInput } from '@/lib/api-client';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useToast } from '@/hooks/use-toast';
import { formatDate } from '@/lib/utils';
import { CLASS_NAMES, DEFAULT_POLICY_CLASSES, DRIVERS_CLASS, POLICY_STATUS, describeWindow, type PolicyWindowInput } from '@/lib/patching';
import { WindowEditor, defaultWindowDraft, draftReady, windowFromDraft } from '@/components/patching/window-editor';
import { RebootChoice, type RebootRule } from '@/components/patching/patch-reboot-choice';
import { PolicyRestartEditor, defaultPolicyRestart, policyRestartBody, policyRestartReady } from '@/components/patching/policy-restart';
import { EFFECTIVE_LABEL, type EffectivePolicy } from '@/components/patching/patch-policy-setting';
import { Building2, Loader2, Plus } from 'lucide-react';
import { describeOccurrence } from '@/lib/tasks';
import { MAX_PER_PLAN, StagingChoice } from '@/components/patching/staging-choice';
import { useApprovalMode } from '@/hooks/use-approval-mode';
import { DIRECT_DEFAULT_REASON } from '@/lib/direct-mode';

/**
 * Company-wide and assignable patch policies (0.50), and every computer's
 * Patch policy setting, for one business.
 *
 * The portal writes each revision's computers itself and proposes a
 * revision when the computers change (or, for a revision made before 0.63, when
 * it nears its expiry; every revision from 0.63 never expires).
 * By default (0.62) they all install together in the window; with "Test on
 * one computer first", a canary it picks and the rest in rings of at most 25
 * that wait for it. Each revision is an ordinary signed policy, admitted on
 * the approval signer like one made by hand.
 */

interface LeftOut { endpointId: string; hostname: string; code: string; message: string }
interface Series {
  id: string; scope: 'business' | 'assigned'; name: string; status: 'active' | 'retired'; createdAt: string; retireReason: string | null;
  settings: { window: PolicyWindowInput; reboot: string; staging?: 'none' | 'canary' };
  computersSetToUse: number;
  /** 0.52: when the running revision next installs (null when nothing runs, or it expires first). */
  nextWindow?: { start: string; end: string } | null;
  /** 0.54: installs and restarts in plain words, and the next restart window. */
  schedule?: string | null; nextRestartWindow?: { start: string; end: string } | null;
  lastCheck: { at: string; code: string; message: string; members: number; rings: number[]; canary: { hostname: string; why: string } | null; leftOut: LeftOut[]; lastRingOnly: string[]; promotion?: { code: string; message: string } | null } | null;
  revisions: { id: string; revision: number; status: string; expiresAt: string | null; createdAt: string; running: boolean; computers: number; approvalUrl: string }[];
  bounds: { revisionMinutes: number; settleMinutes: number; maxComputers: number };
  mayManage: boolean;
}
interface Listing { series: Series[]; computers: { id: string; hostname: string; mode: 'inherit' | 'exclude' | 'policy'; seriesId: string | null; effective: EffectivePolicy['effective'] }[]; mayManage: boolean; mayEdit: boolean }

const selectClass = 'h-8 rounded-md border border-input bg-background px-2 text-xs';
function apiMessage(e: unknown, fallback: string) {
  return (e as { response?: { data?: { message?: string | string[] } } })?.response?.data?.message?.toString() ?? fallback;
}

export function CompanyPoliciesCard({ businessId }: { businessId: string }) {
  const { toast } = useToast();
  const qc = useQueryClient();
  const [creating, setCreating] = useState<'business' | 'assigned' | null>(null);
  const { data, isLoading } = useQuery({
    queryKey: ['patch-series', businessId],
    queryFn: () => patchingApi.series(businessId).then((r) => r.data.data as Listing),
    refetchInterval: 30_000,
  });
  const refresh = () => qc.invalidateQueries({ queryKey: ['patch-series', businessId] });
  const retire = useMutation({
    mutationFn: ({ id, reason }: { id: string; reason: string }) => patchingApi.retireSeries(id, reason),
    onSuccess: () => { refresh(); toast({ title: 'Policy retired', description: 'Its revisions are revoked on the approval signer; nothing more is proposed under it.' }); },
    onError: (e) => toast({ title: 'Not retired', description: apiMessage(e, 'Refused.'), variant: 'destructive' }),
  });
  const setting = useMutation({
    mutationFn: ({ id, body }: { id: string; body: PatchPolicySettingInput }) => patchingApi.setEndpointPolicy(id, body),
    onSuccess: () => { refresh(); toast({ title: 'Patch policy saved', description: 'It applies by revision.' }); },
    onError: (e) => toast({ title: 'Not saved', description: apiMessage(e, 'Refused.'), variant: 'destructive' }),
  });
  const active = (data?.series ?? []).filter((s) => s.status === 'active');
  const hasBusiness = active.some((s) => s.scope === 'business');
  const assigned = active.filter((s) => s.scope === 'assigned');

  return (
    <>
      {creating && <CreateSeries businessId={businessId} scope={creating} computers={data?.computers ?? []} onDone={() => { setCreating(null); refresh(); }} />}
      <Card className="mb-4" data-testid="company-policies">
        <CardHeader className="pb-3 flex flex-row flex-wrap items-center justify-between gap-2 space-y-0">
          <CardTitle className="text-sm flex items-center gap-2"><Building2 className="h-4 w-4" />Company-wide patch policy</CardTitle>
          {data?.mayManage && !creating && (
            <div className="flex flex-wrap gap-2">
              {!hasBusiness && <Button size="sm" variant="outline" onClick={() => setCreating('business')}><Plus className="h-4 w-4 mr-1" />Company-wide policy</Button>}
              <Button size="sm" variant="outline" onClick={() => setCreating('assigned')}><Plus className="h-4 w-4 mr-1" />Assignable policy</Button>
            </div>
          )}
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          <p className="text-xs text-muted-foreground">
            A company-wide policy covers every computer of the business whose Patch policy is Inherit: Windows, on the signed agent, not archived. They all install together in the window — or, with &ldquo;Test on one computer first&rdquo;, the portal picks a test computer (the one that checks in most reliably, unless you chose one) and puts the rest in rings of at most 25 that wait for it. It proposes a new revision when computers join or leave. Revisions do not expire: each stands until a newer one replaces it or the policy is retired. Each revision is a signed, closed list, admitted on the approval signer exactly like a policy made by hand. An assignable policy covers only the computers set to use it — a separate policy for servers, say.
          </p>
          {isLoading || !data ? <p className="text-muted-foreground">Loading…</p> : data.series.length === 0 ? <p className="text-muted-foreground">None yet.</p> : data.series.map((s) => (
            <div key={s.id} className="rounded-md border p-3 space-y-2">
              <div className="flex flex-wrap items-center gap-2">
                <strong>{s.name}</strong>
                <Badge variant="outline">{s.scope === 'business' ? 'company-wide' : 'assignable'}</Badge>
                <Badge variant={s.status === 'active' ? 'success' : 'outline'}>{s.status}</Badge>
                <Badge variant="outline" data-testid="series-staging">{s.settings.staging === 'none' ? 'all at once' : 'one computer first'}</Badge>
                <span className="text-xs text-muted-foreground">{s.schedule ?? `${describeWindow(s.settings.window)} · ${s.settings.reboot === 'never' ? 'never restarts' : 'restarts if required, in the window'}`} {s.scope === 'assigned' ? ` · ${s.computersSetToUse} computer(s) set to use it` : ''}</span>
                {s.nextRestartWindow && <span className="w-full text-xs" data-testid="series-next-restart">Next restart window: <strong>{describeOccurrence(s.nextRestartWindow, s.settings.window.timezone)}</strong></span>}
                <span className="w-full text-xs" data-testid="series-next-window">{s.nextWindow ? <>Next install window: <strong>{describeOccurrence(s.nextWindow, s.settings.window.timezone)}</strong></> : <span className="text-muted-foreground">No install window coming up{s.status === 'active' ? ' — no revision is running' : ''}.</span>}</span>
                {s.status === 'active' && s.mayManage && (
                  <Button size="sm" variant="ghost" className="ml-auto" disabled={retire.isPending} onClick={() => { const reason = window.prompt('Why retire this policy? Its revisions are revoked on the approval signer.'); if (reason && reason.trim().length >= 3) retire.mutate({ id: s.id, reason: reason.trim() }); }}>Retire</Button>
                )}
              </div>
              {s.status === 'retired' && s.retireReason && <p className="text-xs text-muted-foreground">Retired: {s.retireReason}</p>}
              {s.lastCheck && s.status === 'active' && (
                <div className="text-xs space-y-1">
                  <p><span className="text-muted-foreground">Last check {formatDate(s.lastCheck.at)}:</span> {s.lastCheck.message}</p>
                  {s.lastCheck.promotion && <p><span className="text-muted-foreground">Take-over:</span> {s.lastCheck.promotion.message}</p>}
                  {s.lastCheck.members > 0 && <p className="text-muted-foreground">Next revision would name {s.lastCheck.members} computer(s){s.settings.staging === 'none' ? `, all at once${s.lastCheck.rings.length > 1 ? ` (plans of ${s.lastCheck.rings.join(', ')})` : ''}` : ` in rings of ${s.lastCheck.rings.join(', ')}`}{s.lastCheck.canary ? `; test computer ${s.lastCheck.canary.hostname} (${s.lastCheck.canary.why})` : ''}{s.lastCheck.lastRingOnly.length ? `; in the last ring only, with no result key: ${s.lastCheck.lastRingOnly.join(', ')}` : ''}.</p>}
                  {s.lastCheck.leftOut.length > 0 && (
                    <details><summary className="cursor-pointer">Left out: {s.lastCheck.leftOut.length} computer(s)</summary>
                      <ul className="mt-1 space-y-0.5">{s.lastCheck.leftOut.map((x) => <li key={x.endpointId}><Link className="underline" href={`/endpoints/${x.endpointId}`}>{x.hostname}</Link> — {x.message}</li>)}</ul>
                    </details>
                  )}
                </div>
              )}
              {s.revisions.length > 0 && (
                <ul className="text-xs space-y-0.5">
                  {s.revisions.map((r) => (
                    <li key={r.id} className="flex flex-wrap items-center gap-2">
                      <Link className="underline" href={`/patching/policies/${r.id}`}>Revision {r.revision}</Link>
                      <Badge variant={POLICY_STATUS[r.status] ?? 'outline'}>{r.status.toLowerCase().replace(/_/g, ' ')}</Badge>
                      {r.running && <Badge variant="secondary">running</Badge>}
                      <span className="text-muted-foreground">{r.computers} computer(s) · proposed {formatDate(r.createdAt)}{r.expiresAt ? ` · expires ${formatDate(r.expiresAt)} (made before 0.63; renewed into one that never expires)` : ''}</span>
                    </li>
                  ))}
                </ul>
              )}
              <p className="text-xs text-muted-foreground">Bounds: a change is proposed after it has held {s.bounds.settleMinutes} min, at most one revision pass per {s.bounds.revisionMinutes} min for the business, never during a deployment; at most {s.bounds.maxComputers} computers.</p>
            </div>
          ))}

          {data && data.computers.length > 0 && (
            <details>
              <summary className="cursor-pointer text-xs font-medium">Each computer&apos;s Patch policy ({data.computers.length})</summary>
              <div className="mt-2 space-y-1">
                {data.computers.map((c) => {
                  const st = EFFECTIVE_LABEL[c.effective.state];
                  const value = c.mode === 'policy' ? `policy:${c.seriesId}` : c.mode;
                  return (
                    <div key={c.id} className="flex flex-wrap items-center gap-2 text-xs">
                      <select aria-label={`Patch policy for ${c.hostname}`} className={selectClass} value={value} disabled={!data.mayEdit || setting.isPending}
                        onChange={(e) => { const v = e.target.value; setting.mutate({ id: c.id, body: v.startsWith('policy:') ? { mode: 'policy', seriesId: v.slice(7) } : { mode: v as 'inherit' | 'exclude' } }); }}>
                        <option value="inherit">Inherit</option>
                        <option value="exclude">Exclude</option>
                        {assigned.map((s) => <option key={s.id} value={`policy:${s.id}`}>Use &quot;{s.name}&quot;</option>)}
                        {c.mode === 'policy' && !assigned.some((s) => s.id === c.seriesId) && <option value={value}>Use a retired policy</option>}
                      </select>
                      <Link className="underline" href={`/endpoints/${c.id}`}>{c.hostname}</Link>
                      <Badge variant={st.variant}>{st.label}</Badge>
                      <span className="text-muted-foreground">{c.effective.why}</span>
                    </div>
                  );
                })}
              </div>
            </details>
          )}
        </CardContent>
      </Card>
    </>
  );
}

function CreateSeries({ businessId, scope, computers, onDone }: { businessId: string; scope: 'business' | 'assigned'; computers: Listing['computers']; onDone: () => void }) {
  const { toast } = useToast();
  const [name, setName] = useState('');
  // 0.62: all at once unless "Test on one computer first" is ticked.
  const [testFirst, setTestFirst] = useState(false);
  const direct = useApprovalMode({ businessId }) === 'direct';
  const [classes, setClasses] = useState<Set<string>>(new Set(DEFAULT_POLICY_CLASSES));
  const [win, setWin] = useState(defaultWindowDraft);
  const [soakHours, setSoakHours] = useState(24);
  const [failureThreshold, setFailureThreshold] = useState(0);
  const [reboot, setReboot] = useState<RebootRule>('never');
  const [restart, setRestart] = useState(defaultPolicyRestart);
  const [canary, setCanary] = useState('');
  const [reason, setReason] = useState('');
  const toggle = (set: Set<string>, v: string, on: boolean) => { const n = new Set(set); if (on) n.add(v); else n.delete(v); return n; };
  const create = useMutation({
    mutationFn: () => patchingApi.createSeries({
      businessId, scope, name: name.trim(), allow: { classifications: [...classes] }, staging: testFirst ? 'canary' : 'none',
      // All at once: no soak, and one computer's failure does not hold the rest of the window back.
      soakHours: testFirst ? soakHours : 0, failureThreshold: testFirst ? failureThreshold : MAX_PER_PLAN,
      reboot, reason: direct ? (reason.trim() || DIRECT_DEFAULT_REASON) : reason.trim(),
      window: windowFromDraft(win), ...policyRestartBody(restart, reboot), ...(testFirst && canary ? { canaryEndpointId: canary } : {}),
    }),
    onSuccess: () => {
      toast({
        title: scope === 'business' ? 'Company-wide policy created' : 'Assignable policy created',
        description: scope === 'business'
          ? (direct ? 'It is active now (direct mode): its computers install in the next window.' : 'Revision 1 was proposed on the approval signer.')
          : (direct ? 'Set computers to use it; it is active for them as soon as they are (direct mode).' : 'Set computers to use it; its first revision follows.'),
      });
      onDone();
    },
    onError: (e) => toast({ title: 'Not created', description: apiMessage(e, 'Refused.'), variant: 'destructive' }),
  });
  const ok = name.trim().length >= 3 && classes.size > 0 && draftReady(win) && policyRestartReady(restart) && (direct || reason.trim().length >= 3);
  return (
    <Card className="mb-4">
      <CardHeader className="pb-3"><CardTitle className="text-sm">{scope === 'business' ? 'New company-wide patch policy' : 'New assignable patch policy'}</CardTitle></CardHeader>
      <CardContent className="space-y-4 text-sm">
        <div className="max-w-md space-y-1"><Label htmlFor="ser-name" className="text-xs">Name</Label><Input id="ser-name" maxLength={100} value={name} onChange={(e) => setName(e.target.value)} placeholder={scope === 'business' ? 'e.g. All computers, Saturday night' : 'e.g. Servers, Sunday early morning'} /></div>
        <div className="space-y-1">
          <p className="text-xs font-medium">Classes it may install</p>
          {Object.entries(CLASS_NAMES).map(([id, n]) => <label key={id} className="flex items-center gap-2 text-xs"><input type="checkbox" checked={classes.has(id)} onChange={(e) => setClasses((s) => toggle(s, id, e.target.checked))} />{n}</label>)}
          {classes.has(DRIVERS_CLASS) && <p className="text-xs text-muted-foreground">Drivers install as Windows Update offers them, on every computer in each ring. Needs the 0.42 agent.</p>}
        </div>
        <StagingChoice id="ser" value={testFirst} onChange={setTestFirst} />
        <WindowEditor id="ser" value={win} onChange={setWin} />
        {testFirst && (
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 max-w-2xl">
            <div className="space-y-1"><Label className="text-xs">Soak between rings (hours)</Label><Input type="number" min={0} max={168} value={soakHours} onChange={(e) => setSoakHours(Number(e.target.value))} /></div>
            <div className="space-y-1"><Label className="text-xs">Failed computers allowed per ring</Label><Input type="number" min={0} max={25} value={failureThreshold} onChange={(e) => setFailureThreshold(Number(e.target.value))} /></div>
          </div>
        )}
        <div className="max-w-xl"><RebootChoice id="ser-reboot" value={reboot} onChange={setReboot} scope="policy" /></div>
        <PolicyRestartEditor id="ser" value={restart} onChange={setRestart} reboot={reboot} />
        {testFirst && <div className="max-w-md space-y-1">
          <Label htmlFor="ser-canary" className="text-xs">Test computer</Label>
          <select id="ser-canary" className={`${selectClass} w-full h-9`} value={canary} onChange={(e) => setCanary(e.target.value)}>
            <option value="">Let the portal pick (checks in most reliably)</option>
            {computers.map((c) => <option key={c.id} value={c.id}>{c.hostname}</option>)}
          </select>
          <p className="text-xs text-muted-foreground">Used while it is eligible; otherwise the portal picks another and says why.</p>
        </div>}
        {!direct && <div className="space-y-1 max-w-xl"><Label htmlFor="ser-reason" className="text-xs">Reason (written into every revision the approvers see)</Label><Input id="ser-reason" data-testid="ser-reason" maxLength={300} value={reason} onChange={(e) => setReason(e.target.value)} /></div>}
        <p className="text-xs text-muted-foreground">These settings stay fixed for the policy&apos;s life; to change them, retire it and create another. Creating needs a fresh sign-in.{direct ? ' Direct mode is on for this business: each revision is active as soon as it is made.' : ''}</p>
        <div className="flex gap-2">
          <Button size="sm" data-testid="ser-submit" disabled={!ok || create.isPending} onClick={() => create.mutate()}>{create.isPending && <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />}{direct ? 'Create policy' : 'Create'}</Button>
          <Button size="sm" variant="ghost" onClick={onDone}>Cancel</Button>
        </div>
      </CardContent>
    </Card>
  );
}
