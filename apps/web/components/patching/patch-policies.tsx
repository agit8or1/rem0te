'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useMutation, useQuery } from '@tanstack/react-query';
import { patchingApi } from '@/lib/api-client';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useToast } from '@/hooks/use-toast';
import { formatDate } from '@/lib/utils';
import { useAsks } from '@/lib/confirm-policy';
import { POLICY_STATUS, CLASS_NAMES, DEFAULT_POLICY_CLASSES, DRIVERS_CLASS, SEVERITIES, describeWindow, type PolicyWindowInput } from '@/lib/patching';
import { WindowEditor, defaultWindowDraft, draftReady, windowFromDraft } from '@/components/patching/window-editor';
import { AlertTriangle, CheckCircle2, Loader2, Plus, ScrollText, XCircle } from 'lucide-react';
import { RebootChoice, type RebootRule } from '@/components/patching/patch-reboot-choice';
import { PolicyRestartEditor, defaultPolicyRestart, policyRestartBody, policyRestartReady } from '@/components/patching/policy-restart';
import { MAX_ALL_AT_ONCE, MAX_PER_PLAN, StagingChoice, chunkRings } from '@/components/patching/staging-choice';
import { useApprovalMode } from '@/hooks/use-approval-mode';
import { DIRECT_DEFAULT_REASON } from '@/lib/direct-mode';

/**
 * Patch policies (0.32) and the production pre-flight.
 *
 * A policy is a bounded document — the computers it patches, the classes
 * and severities it installs, KBs it never installs, a weekly or (0.53)
 * monthly maintenance window, its restart rules —
 * approved once on the approval signer (by two people, or at once in direct
 * mode). After that the signer signs each plan inside it without further
 * approval. Nothing here approves anything.
 *
 * 0.62: by default every computer installs together in the window ("all at
 * once"); "Test on one computer first" gives the canary and gated rings. In
 * direct mode the form says Create policy and asks for no reason.
 */

function apiMessage(e: unknown, fallback: string) {
  return (e as { response?: { data?: { message?: string | string[] } } })?.response?.data?.message?.toString() ?? fallback;
}

interface Check { id: string; ok: boolean; title: string; detail: string; fix: string | null; step: number }

/** What a production install still lacks, from real state only. Platform Admins. */
export function PreflightCard() {
  const { data, isLoading, refetch, isFetching } = useQuery({
    queryKey: ['patching-preflight'],
    queryFn: () => patchingApi.preflight().then((r) => r.data.data as { ready: boolean; checks: Check[] }),
  });
  return (
    <Card className="mb-4" data-testid="patching-preflight">
      <CardHeader className="pb-3 flex flex-row items-center justify-between space-y-0">
        <CardTitle className="text-sm flex items-center gap-2"><ScrollText className="h-4 w-4" />Signed patching pre-flight</CardTitle>
        <Button size="sm" variant="outline" disabled={isFetching} onClick={() => refetch()}>{isFetching && <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />}Check again</Button>
      </CardHeader>
      <CardContent className="space-y-2 text-xs">
        {isLoading || !data ? <p className="text-muted-foreground">Checking…</p> : (
          <>
            <p>{data.ready ? 'Every prerequisite is in place.' : `${data.checks.filter((c) => !c.ok).length} of ${data.checks.length} prerequisites are missing.`} Each line is read from the update repository, the approval signer or the devices&apos; own reports — nothing here is a checkbox. <Link className="underline" href="/docs/patching-setup">Patching setup</Link></p>
            <ul className="space-y-1.5">
              {data.checks.map((c) => (
                <li key={c.id} className="flex gap-2">
                  {c.ok ? <CheckCircle2 className="h-3.5 w-3.5 shrink-0 mt-0.5 text-green-600" /> : <XCircle className="h-3.5 w-3.5 shrink-0 mt-0.5 text-destructive" />}
                  <span><strong>{c.title}</strong> <span className="text-muted-foreground">(step {c.step})</span> — {c.detail}{c.fix && <span className="block text-muted-foreground">Fix: {c.fix}</span>}</span>
                </li>
              ))}
            </ul>
          </>
        )}
      </CardContent>
    </Card>
  );
}

interface PolicyRow { id: string; name: string; status: string; expiresAt: string | null; createdAt: string; computers: number; rings: number; staging?: 'none' | 'canary' | null; window: PolicyWindowInput; nextWindow: { start: string; end: string } | null; schedule?: string; nextRestartWindow?: { start: string; end: string } | null; lastProposal: { at: string; ok: boolean; code: string; message: string } | null }

export function PoliciesCard({ businessId }: { businessId: string }) {
  const [creating, setCreating] = useState(false);
  const { data: rows = [], isLoading, refetch } = useQuery({
    queryKey: ['patch-policies', businessId],
    queryFn: () => patchingApi.policies(businessId).then((r) => r.data.data as PolicyRow[]),
  });
  return (
    <>
      {creating && <CreatePolicy businessId={businessId} onDone={() => { setCreating(false); refetch(); }} />}
      <Card className="mb-4">
        <CardHeader className="pb-3 flex flex-row items-center justify-between space-y-0">
          <CardTitle className="text-sm">Automatic patch policies</CardTitle>
          {!creating && <Button size="sm" variant="outline" onClick={() => setCreating(true)}><Plus className="h-4 w-4 mr-1" />New policy</Button>}
        </CardHeader>
        <CardContent className="space-y-2 text-sm">
          <p className="text-xs text-muted-foreground">
            Approved once on the approval signer: by two people on its roster, or at once in direct mode. Inside its maintenance window every device in it installs together — or, with &ldquo;Test on one device first&rdquo;, one device first and then rings that each wait for the one before — never anything outside the policy. It does not expire: it stands until it is revoked. Fixture-tested only: proven against a simulated Windows Update and synthetic passkeys.
          </p>
          {isLoading ? <p className="text-muted-foreground">Loading…</p>
            : rows.length === 0 ? <p className="text-muted-foreground">No policies.</p>
            : rows.map((p) => (
              <Link key={p.id} href={`/patching/policies/${p.id}`} className="block rounded-md border p-3 hover:bg-muted/50">
                <div className="flex flex-wrap items-center gap-2">
                  <strong>{p.name}</strong>
                  <Badge variant={POLICY_STATUS[p.status] ?? 'outline'}>{p.status.toLowerCase().replace(/_/g, ' ')}</Badge>
                  <span className="text-xs text-muted-foreground">{p.computers} device{p.computers === 1 ? '' : 's'} {p.staging === 'none' ? 'all at once' : `in ${p.rings} ring${p.rings === 1 ? '' : 's'}, one device first`} · {describeWindow(p.window)}{p.expiresAt ? ` · made before 0.63, expires ${formatDate(p.expiresAt)}` : ''}</span>
                </div>
                {p.schedule && <p className="text-xs mt-1" data-testid="policy-schedule">{p.schedule}</p>}
                {p.nextWindow && <p className="text-xs text-muted-foreground mt-1">Next window: {formatDate(p.nextWindow.start)} – {formatDate(p.nextWindow.end)}</p>}
                {p.nextRestartWindow && <p className="text-xs text-muted-foreground mt-1" data-testid="policy-next-restart">Next restart window: {formatDate(p.nextRestartWindow.start)} – {formatDate(p.nextRestartWindow.end)}</p>}
                {p.lastProposal && <p className="text-xs mt-1">{p.lastProposal.ok ? 'Last' : 'Last refusal'} ({formatDate(p.lastProposal.at)}): {p.lastProposal.message}</p>}
              </Link>
            ))}
        </CardContent>
      </Card>
    </>
  );
}

interface Candidates { computers: { id: string; hostname: string; notReady: string | null; scannedAt: string | null; managers: string[]; isOnline: boolean }[] }

function CreatePolicy({ businessId, onDone }: { businessId: string; onDone: () => void }) {
  const { toast } = useToast();
  const router = useRouter();
  const { data: c, isLoading } = useQuery({
    queryKey: ['patch-candidates', businessId],
    queryFn: () => patchingApi.candidates(businessId).then((r) => r.data.data as Candidates),
  });
  const [name, setName] = useState('');
  // 0.62: all at once unless "Test on one computer first" is ticked.
  const [testFirst, setTestFirst] = useState(false);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [ringOf, setRingOf] = useState<Record<string, number | ''>>({});
  const [classes, setClasses] = useState<Set<string>>(new Set(DEFAULT_POLICY_CLASSES));
  const [severities, setSeverities] = useState<Set<string>>(new Set());
  const [excludeKbs, setExcludeKbs] = useState('');
  const [win, setWin] = useState(defaultWindowDraft);
  const [soakHours, setSoakHours] = useState(24);
  const [failureThreshold, setFailureThreshold] = useState(0);
  const [reason, setReason] = useState('');
  const [reboot, setReboot] = useState<RebootRule>('never');
  const [restart, setRestart] = useState(defaultPolicyRestart);
  const askPropose = useAsks('patching.policy');
  const direct = useApprovalMode({ businessId }) === 'direct';

  const stagedRings = useMemo(() => {
    const max = Math.max(-1, ...Object.values(ringOf).filter((r): r is number => r !== ''));
    const out: string[][] = Array.from({ length: max + 1 }, () => []);
    for (const [id, r] of Object.entries(ringOf)) if (r !== '') out[r].push(id);
    return out;
  }, [ringOf]);
  // All at once: the ticked computers, in the list's order, as plans of up to 25 that wait for nothing.
  const order = (c?.computers ?? []).map((x) => x.id);
  const allRings = useMemo(() => chunkRings(order.filter((id) => picked.has(id))), [order.join(','), picked]); // eslint-disable-line react-hooks/exhaustive-deps
  const rings = testFirst ? stagedRings : allRings;
  const ringsOk = testFirst
    ? rings.length >= 1 && rings[0].length === 1 && rings.every((r) => r.length >= 1 && r.length <= MAX_PER_PLAN)
    : picked.size >= 1 && picked.size <= MAX_ALL_AT_ONCE;
  const kbs = excludeKbs.split(/[\s,]+/).map((s) => s.trim().toUpperCase()).filter(Boolean);
  const kbsOk = kbs.every((k) => /^KB[0-9]{4,10}$/.test(k));

  const create = useMutation({
    mutationFn: () => patchingApi.createPolicy({
      businessId, name: name.trim(), rings, staging: testFirst ? 'canary' : 'none',
      // All at once: no soak, and one computer's failure does not hold the rest of the window back.
      soakHours: testFirst ? soakHours : 0, failureThreshold: testFirst ? failureThreshold : MAX_PER_PLAN,
      // 0.63: no expiry is sent, so the policy never expires; it stands until it is revoked.
      reason: direct ? (reason.trim() || DIRECT_DEFAULT_REASON) : reason.trim(), reboot,
      allow: { classifications: [...classes], ...(severities.size ? { severities: [...severities] } : {}), ...(kbs.length ? { excludeKbs: [...new Set(kbs)] } : {}) },
      window: windowFromDraft(win), ...policyRestartBody(restart, reboot),
    }),
    onSuccess: (r) => {
      // 0.40: in direct mode the signer makes it active at once.
      const active = r.data.data.direct === true && r.data.data.status === 'ACTIVE';
      toast(active ? { title: 'Policy active', description: `It is active now (direct mode). ${testFirst ? 'Its test device installs first' : 'Its devices install'} in its next window.` } : { title: 'Policy proposed', description: 'Two approvers now approve it on the approval signer.' });
      // 0.62: in direct mode there is nothing to approve, so the list is where it is followed.
      onDone();
      if (!active) router.push(`/patching/policies/${r.data.data.id}`);
    },
    onError: (e) => toast({ title: direct ? 'Not created' : 'Not proposed', description: apiMessage(e, 'The policy was refused.'), variant: 'destructive' }),
  });

  if (isLoading || !c) return <Card className="mb-4"><CardContent className="pt-6 text-sm text-muted-foreground">Loading the devices…</CardContent></Card>;
  const toggle = (set: Set<string>, v: string, on: boolean) => { const n = new Set(set); if (on) n.add(v); else n.delete(v); return n; };
  const ok = name.trim().length >= 3 && ringsOk && classes.size > 0 && draftReady(win) && policyRestartReady(restart) && kbsOk && (direct || reason.trim().length >= 3);

  return (
    <Card className="mb-4">
      <CardHeader className="pb-3"><CardTitle className="text-sm">New patch policy</CardTitle></CardHeader>
      <CardContent className="space-y-4 text-sm">
        <div className="max-w-md space-y-1">
          <Label htmlFor="pol-name" className="text-xs">Name</Label>
          <Input id="pol-name" maxLength={120} value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Security updates, Saturday night" />
        </div>

        <div className="space-y-2">
          <StagingChoice id="pol" value={testFirst} onChange={setTestFirst} />
          {testFirst ? (
            <>
              <p className="text-xs font-medium">Devices — ring 0 is the one test device; each later ring up to {MAX_PER_PLAN}. The policy names these exact devices; a re-enrolled device drops out.</p>
              {c.computers.map((x) => (
                <div key={x.id} className="flex flex-wrap items-center gap-2 text-xs">
                  <select className="h-8 rounded-md border border-input bg-background px-2 text-xs" value={ringOf[x.id] ?? ''} onChange={(e) => setRingOf((m) => ({ ...m, [x.id]: e.target.value === '' ? '' : Number(e.target.value) }))}>
                    <option value="">not in this policy</option>
                    {[0, 1, 2, 3, 4].map((r) => <option key={r} value={r}>{r === 0 ? 'ring 0 (test device)' : `ring ${r}`}</option>)}
                  </select>
                  <span>{x.hostname}</span>
                  {x.notReady && <span className="text-muted-foreground">— {x.notReady}</span>}
                  {x.managers.length > 0 && <span className="text-muted-foreground">— managed by {x.managers.join(', ')}; it will be left out of every ring</span>}
                </div>
              ))}
              {!ringsOk && Object.keys(ringOf).length > 0 && <p className="text-xs text-destructive">Ring 0 must be exactly one device, and no ring may be empty or larger than {MAX_PER_PLAN}.</p>}
            </>
          ) : (
            <>
              <p className="text-xs font-medium">Devices — tick the ones this policy patches. The policy names these exact devices; a re-enrolled device drops out.</p>
              {c.computers.length > 1 && (
                <label className="flex items-center gap-2 text-xs text-muted-foreground">
                  <input type="checkbox" data-testid="pol-pick-all" checked={picked.size === c.computers.length} onChange={(e) => setPicked(e.target.checked ? new Set(c.computers.map((x) => x.id)) : new Set())} />Select all
                </label>
              )}
              {c.computers.map((x) => (
                <label key={x.id} className="flex flex-wrap items-center gap-2 text-xs">
                  <input type="checkbox" data-testid={`pol-pick-${x.id}`} checked={picked.has(x.id)} onChange={(e) => setPicked((s0) => { const n = new Set(s0); if (e.target.checked) n.add(x.id); else n.delete(x.id); return n; })} />
                  <span>{x.hostname}</span>
                  {x.notReady && <span className="text-muted-foreground">— {x.notReady}</span>}
                  {x.managers.length > 0 && <span className="text-muted-foreground">— managed by {x.managers.join(', ')}; it will be left out</span>}
                </label>
              ))}
              {picked.size > MAX_ALL_AT_ONCE && <p className="text-xs text-destructive">At most {MAX_ALL_AT_ONCE} devices in one policy. Give the rest their own policy.</p>}
              {picked.size > MAX_PER_PLAN && picked.size <= MAX_ALL_AT_ONCE && <p className="text-xs text-muted-foreground">{picked.size} devices go out as {allRings.length} plans of up to {MAX_PER_PLAN}, all in the same window.</p>}
            </>
          )}
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <div className="space-y-1">
            <p className="text-xs font-medium">Classes it may install</p>
            {Object.entries(CLASS_NAMES).map(([id, n]) => (
              <label key={id} className="flex items-center gap-2 text-xs"><input type="checkbox" checked={classes.has(id)} onChange={(e) => setClasses((s) => toggle(s, id, e.target.checked))} />{n}</label>
            ))}
            {classes.has(DRIVERS_CLASS) && <p className="text-xs text-muted-foreground" data-testid="policy-drivers-note">Drivers install as Windows Update offers them, on every device in each ring. A driver can be harder to undo than an update; {testFirst ? 'the test device is where you find out' : 'tick "Test on one device first" to find out on one device before the rest'}. Needs the 0.42 agent.</p>}
          </div>
          <div className="space-y-1">
            <p className="text-xs font-medium">Severities (none ticked: any)</p>
            {SEVERITIES.map((s) => (
              <label key={s} className="flex items-center gap-2 text-xs"><input type="checkbox" checked={severities.has(s)} onChange={(e) => setSeverities((x) => toggle(x, s, e.target.checked))} />{s}</label>
            ))}
          </div>
          <div className="space-y-1">
            <Label htmlFor="pol-kbs" className="text-xs">KBs never to install</Label>
            <Input id="pol-kbs" value={excludeKbs} onChange={(e) => setExcludeKbs(e.target.value)} placeholder="KB5044284, KB5044099" />
            {!kbsOk && <p className="text-xs text-destructive">Each must look like KB1234567.</p>}
          </div>
        </div>

        <WindowEditor id="pol" value={win} onChange={setWin} />

        {testFirst && (
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 max-w-2xl">
            <div className="space-y-1"><Label className="text-xs">Soak between rings (hours)</Label><Input type="number" min={0} max={168} value={soakHours} onChange={(e) => setSoakHours(Number(e.target.value))} /></div>
            <div className="space-y-1"><Label className="text-xs">Failed devices allowed per ring</Label><Input type="number" min={0} max={25} value={failureThreshold} onChange={(e) => setFailureThreshold(Number(e.target.value))} /></div>
          </div>
        )}

        <div className="max-w-xl">
          <RebootChoice id="pol-reboot" value={reboot} onChange={setReboot} scope="policy" />
        </div>

        <PolicyRestartEditor id="pol" value={restart} onChange={setRestart} reboot={reboot} />

        {!direct && (
          <div className="space-y-1 max-w-xl">
            <Label htmlFor="pol-reason" className="text-xs">Reason (shown to the approvers)</Label>
            <Input id="pol-reason" data-testid="pol-reason" maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} />
          </div>
        )}

        {direct ? (
          <p className="text-xs text-muted-foreground" data-testid="pol-direct-note">Direct mode is on for this customer (set by the approval signer&apos;s operator): the policy is active as soon as you create it{askPropose ? ', after you confirm it is you' : ''}. Its plans never ask for more than it allows.</p>
        ) : (
          <p className="text-xs text-muted-foreground flex gap-2"><AlertTriangle className="h-3.5 w-3.5 shrink-0 mt-0.5 text-yellow-600" />
            The restart rules, the restart window and the RustDesk exception are part of what the approvers sign: a ring plan may never ask for more than it. {askPropose ? 'Proposing needs a fresh sign-in; approving' : 'Approving'} happens only on the approval signer.
          </p>
        )}
        <div className="flex gap-2">
          <Button size="sm" data-testid="pol-submit" disabled={!ok || create.isPending} onClick={() => create.mutate()}>{create.isPending && <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />}{direct ? 'Create policy' : 'Propose for approval'}</Button>
          <Button size="sm" variant="ghost" onClick={onDone}>Cancel</Button>
        </div>
      </CardContent>
    </Card>
  );
}
