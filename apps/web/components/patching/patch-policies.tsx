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
import { POLICY_STATUS, WEEKDAYS, CLASS_NAMES, SEVERITIES, describeWindow } from '@/lib/patching';
import { AlertTriangle, CheckCircle2, Loader2, Plus, ScrollText, XCircle } from 'lucide-react';

/**
 * Patch policies (0.32) and the production pre-flight.
 *
 * A policy is a bounded document — computers in fixed rings with a
 * one-computer canary, the classes and severities it installs, KBs it never
 * installs, a weekly maintenance window, soak and failure threshold, never
 * restart, an expiry within 90 days — approved once by two people on the
 * approval signer. After that the signer signs each ring inside it without
 * further approval. Nothing here approves anything.
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
            <p>{data.ready ? 'Every prerequisite is in place.' : `${data.checks.filter((c) => !c.ok).length} of ${data.checks.length} prerequisites are missing.`} Each line is read from the update repository, the approval signer or the computers&apos; own reports — nothing here is a checkbox. <Link className="underline" href="/docs/patching-setup">Patching setup</Link></p>
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

interface PolicyRow { id: string; name: string; status: string; expiresAt: string; createdAt: string; computers: number; rings: number; window: { days: string[]; start: string; end: string; timezone: string }; nextWindow: { start: string; end: string } | null; lastProposal: { at: string; ok: boolean; code: string; message: string } | null }

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
            Approved once, by two people on the approval signer. Inside its maintenance window the signer then signs the canary, and each later ring after the one before it is confirmed — never anything outside the policy. Fixture-tested only: proven against a simulated Windows Update and synthetic passkeys.
          </p>
          {isLoading ? <p className="text-muted-foreground">Loading…</p>
            : rows.length === 0 ? <p className="text-muted-foreground">No policies.</p>
            : rows.map((p) => (
              <Link key={p.id} href={`/patching/policies/${p.id}`} className="block rounded-md border p-3 hover:bg-muted/50">
                <div className="flex flex-wrap items-center gap-2">
                  <strong>{p.name}</strong>
                  <Badge variant={POLICY_STATUS[p.status] ?? 'outline'}>{p.status.toLowerCase().replace(/_/g, ' ')}</Badge>
                  <span className="text-xs text-muted-foreground">{p.computers} computer{p.computers === 1 ? '' : 's'} in {p.rings} ring{p.rings === 1 ? '' : 's'} · {describeWindow(p.window)} · expires {formatDate(p.expiresAt)}</span>
                </div>
                {p.nextWindow && <p className="text-xs text-muted-foreground mt-1">Next window: {formatDate(p.nextWindow.start)} – {formatDate(p.nextWindow.end)}</p>}
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
  const [ringOf, setRingOf] = useState<Record<string, number | ''>>({});
  const [classes, setClasses] = useState<Set<string>>(new Set([Object.keys(CLASS_NAMES)[0]]));
  const [severities, setSeverities] = useState<Set<string>>(new Set());
  const [excludeKbs, setExcludeKbs] = useState('');
  const [days, setDays] = useState<Set<string>>(new Set(['sat']));
  const [start, setStart] = useState('22:00');
  const [end, setEnd] = useState('04:00');
  const [timezone, setTimezone] = useState(() => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone; } catch { return 'UTC'; } });
  const [soakHours, setSoakHours] = useState(24);
  const [failureThreshold, setFailureThreshold] = useState(0);
  const [expiresInDays, setExpiresInDays] = useState(30);
  const [reason, setReason] = useState('');

  const rings = useMemo(() => {
    const max = Math.max(-1, ...Object.values(ringOf).filter((r): r is number => r !== ''));
    const out: string[][] = Array.from({ length: max + 1 }, () => []);
    for (const [id, r] of Object.entries(ringOf)) if (r !== '') out[r].push(id);
    return out;
  }, [ringOf]);
  const ringsOk = rings.length >= 1 && rings[0].length === 1 && rings.every((r) => r.length >= 1 && r.length <= 25);
  const kbs = excludeKbs.split(/[\s,]+/).map((s) => s.trim().toUpperCase()).filter(Boolean);
  const kbsOk = kbs.every((k) => /^KB[0-9]{4,10}$/.test(k));

  const create = useMutation({
    mutationFn: () => patchingApi.createPolicy({
      businessId, name: name.trim(), rings, soakHours, failureThreshold, expiresInDays, reason: reason.trim(), reboot: 'never',
      allow: { classifications: [...classes], ...(severities.size ? { severities: [...severities] } : {}), ...(kbs.length ? { excludeKbs: [...new Set(kbs)] } : {}) },
      window: { days: WEEKDAYS.filter((d) => days.has(d.id)).map((d) => d.id), start, end, timezone },
    }),
    onSuccess: (r) => { toast({ title: 'Policy proposed', description: 'Two approvers now approve it on the approval signer.' }); onDone(); router.push(`/patching/policies/${r.data.data.id}`); },
    onError: (e) => toast({ title: 'Not proposed', description: apiMessage(e, 'The policy was refused.'), variant: 'destructive' }),
  });

  if (isLoading || !c) return <Card className="mb-4"><CardContent className="pt-6 text-sm text-muted-foreground">Loading the computers…</CardContent></Card>;
  const toggle = (set: Set<string>, v: string, on: boolean) => { const n = new Set(set); if (on) n.add(v); else n.delete(v); return n; };
  const ok = name.trim().length >= 3 && ringsOk && classes.size > 0 && days.size > 0 && start !== end && kbsOk && reason.trim().length >= 3;

  return (
    <Card className="mb-4">
      <CardHeader className="pb-3"><CardTitle className="text-sm">New patch policy</CardTitle></CardHeader>
      <CardContent className="space-y-4 text-sm">
        <div className="max-w-md space-y-1">
          <Label htmlFor="pol-name" className="text-xs">Name</Label>
          <Input id="pol-name" maxLength={120} value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Security updates, Saturday night" />
        </div>

        <div className="space-y-1">
          <p className="text-xs font-medium">Computers — ring 0 is one canary; each later ring up to 25. The policy names these exact computers; a re-enrolled computer drops out.</p>
          {c.computers.map((x) => (
            <div key={x.id} className="flex flex-wrap items-center gap-2 text-xs">
              <select className="h-8 rounded-md border border-input bg-background px-2 text-xs" value={ringOf[x.id] ?? ''} onChange={(e) => setRingOf((m) => ({ ...m, [x.id]: e.target.value === '' ? '' : Number(e.target.value) }))}>
                <option value="">not in this policy</option>
                {[0, 1, 2, 3, 4].map((r) => <option key={r} value={r}>{r === 0 ? 'ring 0 (canary)' : `ring ${r}`}</option>)}
              </select>
              <span>{x.hostname}</span>
              {x.notReady && <span className="text-muted-foreground">— {x.notReady}</span>}
              {x.managers.length > 0 && <span className="text-muted-foreground">— managed by {x.managers.join(', ')}; it will be left out of every ring</span>}
            </div>
          ))}
          {!ringsOk && Object.keys(ringOf).length > 0 && <p className="text-xs text-destructive">Ring 0 must be exactly one computer, and no ring may be empty or larger than 25.</p>}
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <div className="space-y-1">
            <p className="text-xs font-medium">Classes it may install</p>
            {Object.entries(CLASS_NAMES).map(([id, n]) => (
              <label key={id} className="flex items-center gap-2 text-xs"><input type="checkbox" checked={classes.has(id)} onChange={(e) => setClasses((s) => toggle(s, id, e.target.checked))} />{n}</label>
            ))}
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

        <div className="space-y-2">
          <p className="text-xs font-medium">Maintenance window</p>
          <div className="flex flex-wrap gap-3 text-xs">
            {WEEKDAYS.map((d) => <label key={d.id} className="flex items-center gap-1"><input type="checkbox" checked={days.has(d.id)} onChange={(e) => setDays((s) => toggle(s, d.id, e.target.checked))} />{d.label}</label>)}
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 max-w-2xl">
            <div className="space-y-1"><Label className="text-xs">Starts (local)</Label><Input type="time" value={start} onChange={(e) => setStart(e.target.value)} /></div>
            <div className="space-y-1"><Label className="text-xs">Ends (local; earlier = next day)</Label><Input type="time" value={end} onChange={(e) => setEnd(e.target.value)} /></div>
            <div className="space-y-1"><Label className="text-xs">Time zone (IANA)</Label><Input value={timezone} onChange={(e) => setTimezone(e.target.value)} /></div>
          </div>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 max-w-2xl">
          <div className="space-y-1"><Label className="text-xs">Soak between rings (hours)</Label><Input type="number" min={0} max={168} value={soakHours} onChange={(e) => setSoakHours(Number(e.target.value))} /></div>
          <div className="space-y-1"><Label className="text-xs">Failed computers allowed per ring</Label><Input type="number" min={0} max={25} value={failureThreshold} onChange={(e) => setFailureThreshold(Number(e.target.value))} /></div>
          <div className="space-y-1"><Label className="text-xs">Expires after (days, at most 90)</Label><Input type="number" min={1} max={90} value={expiresInDays} onChange={(e) => setExpiresInDays(Number(e.target.value))} /></div>
        </div>

        <div className="space-y-1 max-w-xl">
          <Label htmlFor="pol-reason" className="text-xs">Reason (shown to the approvers)</Label>
          <Input id="pol-reason" maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} />
        </div>

        <p className="text-xs text-muted-foreground flex gap-2"><AlertTriangle className="h-3.5 w-3.5 shrink-0 mt-0.5 text-yellow-600" />
          Computers are never restarted: a restart rule needs a change to what the agent accepts, and is not in this release. Proposing needs a fresh sign-in; approving happens only on the approval signer.
        </p>
        <div className="flex gap-2">
          <Button size="sm" disabled={!ok || create.isPending} onClick={() => create.mutate()}>{create.isPending && <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />}Propose for approval</Button>
          <Button size="sm" variant="ghost" onClick={onDone}>Cancel</Button>
        </div>
      </CardContent>
    </Card>
  );
}
