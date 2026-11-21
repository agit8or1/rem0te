'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { backupsApi, businessesApi } from '@/lib/api-client';
import { usePermissions, CAP } from '@/lib/auth';
import { PageHeader } from '@/components/common/page-header';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Definition, Empty, Figure, Refused, Section, Table, ago, duration } from '@/components/reports/report-kit';
import { apiError } from '@/components/security-controls/shared';
import { reauthSuffix, useAsks } from '@/lib/confirm-policy';

/**
 * Backups (0.81 Vault, docs/backups.md): what a backup provider reported,
 * read-only. Three facts about a job are kept apart and shown apart — did it
 * complete, did its integrity check pass, and was a restore of it tested — so
 * a successful backup is never shown as a verified restore. Nothing here
 * starts a backup, a restore, a drill or a failover.
 *
 * "Requires setup" until a Platform Admin connects a provider; every empty
 * state says what is needed.
 */
type Measure = { targetMinutes: number | null; measuredMinutes: number | null; exceeded: boolean | null; from: 'asset' | 'business' | null };
type LastJob = { id: string; startedAt: string; finishedAt: string | null; completion: string; integrity: string; restoreTest: string; errorCode: string | null } | null;
type Verified = { drillId: string; at: string; recoveryPointAt: string | null; scope: string; target: string; validation: string; elapsedSeconds: number | null } | null;
type State = {
  lastJob: LastJob; lastSuccessAt: string | null; backup: 'never' | 'ok' | 'stale' | 'failing' | 'running'; staleAfterHours: number;
  drill: 'never_tested' | 'verified' | 'failed' | 'simulated_only'; verified: Verified;
  lastFailedDrill: { at: string; scope: string; failureCode: string | null } | null; rpo: Measure; rto: Measure; summary: string;
};
type Asset = {
  id: string; name: string; type: string; business: { id: string; name: string }; computer: { id: string; name: string } | null; provider: string;
  providerLastSyncAt: string | null; state: State; latestPoint: { at: string; location: string } | null;
  failedDrills: { id: string; at: string; result: string; scope: string; target: string; failureCode: string | null }[]; simulatedDrills: number;
};
type Provider = { kind: string; label: string; transport: 'push' | 'pull'; state: string; stateNote: string; prerequisites: string[]; limitations: string[] };
type Conn = { id: string; businessId: string; kind: string; label: string; transport: string; enabled: boolean; lastSyncAt: string | null; lastResult: string | null; createdAt: string; pushTokenLast4: string | null; credentialLast4: string | null };
interface Overview {
  generatedAt: string; state: 'requires_setup' | 'awaiting_data' | 'connected'; businessId: string | null; needs: string | null;
  connections: Conn[]; providers: Provider[];
  totals: { assets: number; shown: number; stale: number; failing: number; never: number; verified: number; neverTested: number; drillFailed: number; rpoExceeded: number; rtoExceeded: number; unlinked: number };
  objective: { rpoMinutes: number | null; rtoMinutes: number | null } | null;
  assets: Asset[];
  may: { configure: boolean; connect: boolean };
}

const BACKUP: Record<State['backup'], { label: string; tone: string }> = {
  ok: { label: 'Backed up', tone: 'text-green-700 dark:text-green-400' },
  running: { label: 'Running', tone: 'text-muted-foreground' },
  stale: { label: 'Stale', tone: 'text-amber-700 dark:text-amber-300' },
  failing: { label: 'Failing', tone: 'text-red-600 dark:text-red-400' },
  never: { label: 'No backup yet', tone: 'text-amber-700 dark:text-amber-300' },
};
const COMPLETION: Record<string, string> = { succeeded: 'Succeeded', partial: 'Partial', failed: 'Failed', cancelled: 'Cancelled', running: 'Running', unknown: 'Unknown' };
const INTEGRITY: Record<string, string> = { passed: 'Passed', failed: 'Failed', not_checked: 'Not checked' };
const RESTORE: Record<string, string> = { verified: 'Verified', failed: 'Failed', not_tested: 'Not tested' };
const DRILL: Record<State['drill'], string> = { verified: 'Verified', failed: 'Last drill failed', never_tested: 'Never tested', simulated_only: 'Simulated only (not verified)' };
const SCOPE: Record<string, string> = { file: 'file', volume: 'volume', full_image: 'full image', application: 'application' };
const tone = (v: string) => (v === 'failed' ? 'text-red-600 dark:text-red-400' : v === 'verified' || v === 'passed' || v === 'succeeded' ? 'text-green-700 dark:text-green-400' : 'text-muted-foreground');
const when = (s: string | null | undefined) => (s ? new Date(s).toLocaleString() : '—');
const measure = (m: Measure) => (m.targetMinutes === null
  ? <span className="text-muted-foreground">{m.measuredMinutes === null ? 'No target' : `${duration(m.measuredMinutes)} · no target`}</span>
  : <span className={m.exceeded ? 'text-red-600 dark:text-red-400' : m.exceeded === false ? 'text-green-700 dark:text-green-400' : 'text-muted-foreground'}>
    {m.measuredMinutes === null ? 'Not measured' : duration(m.measuredMinutes)} / {duration(m.targetMinutes)}{m.from === 'business' ? ' (business)' : ''}
  </span>);

export default function BackupsPage() {
  const { can, isPlatformAdmin } = usePermissions();
  const allowed = can(CAP.BACKUPS_VIEW);
  const [biz, setBiz] = useState('');
  const businesses = useQuery({
    queryKey: ['businesses', ''],
    queryFn: () => businessesApi.list().then((r) => ((r.data as { data?: { id: string; name: string }[] })?.data ?? [])),
    enabled: isPlatformAdmin, retry: false,
  });
  const q = useQuery({
    queryKey: ['backups', biz],
    queryFn: () => backupsApi.overview(biz || null).then((r) => r.data.data as Overview),
    enabled: allowed, retry: false,
  });
  const d = q.data;
  const t = d?.totals;

  return (
    <div className="space-y-6 p-4 sm:p-6" data-testid="backups-page">
      <PageHeader title="Backups" description="What your backup provider reports: the last job, the last verified restore, and recovery point and time objectives measured against target. Read-only." />
      {!allowed ? <Refused error={{ response: { status: 403, data: { message: 'Backups need the See backup status (backups:view) permission.' } } }} /> : (
        <>
          {isPlatformAdmin && (
            <div className="flex flex-wrap items-center gap-2">
              <Label htmlFor="bk-biz" className="text-sm">Business</Label>
              <select id="bk-biz" className="h-9 max-w-full rounded-md border bg-background px-2 text-sm" value={biz} onChange={(e) => setBiz(e.target.value)} data-testid="backups-business">
                <option value="">Every business</option>
                {(businesses.data ?? []).map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
              </select>
            </div>
          )}
          {q.error ? <Refused error={q.error} /> : null}
          {q.isLoading && <p className="text-sm text-muted-foreground">Loading…</p>}
          {d && (
            <>
              <Definition>
                <p>A <strong>successful job</strong> means the provider finished it. Its <strong>integrity check</strong> is a separate fact, and a <strong>verified restore</strong> is a third: only a restore drill that really ran (not simulated), on an isolated target, and checked what it restored. A successful backup is never shown as verified.</p>
                <p>Computed {new Date(d.generatedAt).toLocaleString()} from what the provider last reported. Nothing here starts a backup, a restore or a failover.</p>
              </Definition>
              {d.needs && <div className="rounded-md border border-amber-500/50 bg-amber-500/10 p-3 text-sm" data-testid="backups-needs" data-state={d.state}>
                <p className="font-medium">{d.state === 'requires_setup' ? 'Requires setup' : 'Waiting for the first report'}</p>
                <p className="mt-1">{d.needs}</p>
              </div>}
              {t && t.assets > 0 && (
                <div className="grid grid-cols-2 gap-3 lg:grid-cols-4" data-testid="backups-figures">
                  <Figure label="Protected assets" value={t.assets} hint={t.unlinked ? `${t.unlinked} not linked to a computer (no alerts)` : 'Each linked to a computer'} />
                  <Figure label="Stale or failing" value={t.stale + t.failing} tone={t.stale + t.failing ? 'bad' : 'good'} hint={`${t.stale} stale · ${t.failing} failing · ${t.never} with no backup yet`} />
                  <Figure label="Restore verified" value={t.verified} tone={t.verified < t.assets ? 'warn' : 'good'} hint={`${t.neverTested} never tested by a real drill · ${t.drillFailed} last drill failed`} />
                  <Figure label="Over RPO / RTO" value={`${t.rpoExceeded} / ${t.rtoExceeded}`} tone={t.rpoExceeded + t.rtoExceeded ? 'bad' : undefined} hint="Measured against the asset's target, else the business's" />
                </div>
              )}
              {d.state !== 'requires_setup' && t && t.assets === 0 && (
                <Empty>No protected assets reported{d.state === 'awaiting_data' ? ' yet' : ''}. Assets appear here once the provider reports them; an asset is linked to a computer only when the provider names its Rem0te id or a hostname that matches exactly one computer in the business.</Empty>
              )}
              {d.assets.length > 0 && (
                <Section title="Assets" note={t && t.assets > t.shown ? `Showing ${t.shown} of ${t.assets}` : undefined}>
                  <Table
                    head={['Asset', 'Computer', 'Backup', 'Last job', 'Integrity', 'Restore of that job', 'Last verified restore', 'RPO', 'RTO']}
                    empty="No assets."
                    rows={d.assets.map((a) => [
                      <span key="n" className="block min-w-[10rem]" data-asset={a.id}><span className="font-medium">{a.name}</span><span className="block text-xs text-muted-foreground">{a.type.replace('_', ' ')} · {a.business.name}</span></span>,
                      a.computer ? <Link key="c" href={`/endpoints/${a.computer.id}`} className="hover:underline">{a.computer.name}</Link> : <span key="c" className="text-muted-foreground">Not linked</span>,
                      <span key="b" className={BACKUP[a.state.backup].tone} data-backup={a.state.backup}>{BACKUP[a.state.backup].label}{a.state.lastSuccessAt ? <span className="block text-xs text-muted-foreground">success {ago(a.state.lastSuccessAt)}</span> : null}</span>,
                      a.state.lastJob ? <span key="j" className={tone(a.state.lastJob.completion)} data-completion={a.state.lastJob.completion}>{COMPLETION[a.state.lastJob.completion] ?? a.state.lastJob.completion}<span className="block text-xs text-muted-foreground">{ago(a.state.lastJob.finishedAt ?? a.state.lastJob.startedAt)}{a.state.lastJob.errorCode ? ` · ${a.state.lastJob.errorCode}` : ''}</span></span> : '—',
                      a.state.lastJob ? <span key="i" className={tone(a.state.lastJob.integrity)} data-integrity={a.state.lastJob.integrity}>{INTEGRITY[a.state.lastJob.integrity] ?? a.state.lastJob.integrity}</span> : '—',
                      a.state.lastJob ? <span key="r" className={tone(a.state.lastJob.restoreTest)} data-restore={a.state.lastJob.restoreTest}>{RESTORE[a.state.lastJob.restoreTest] ?? a.state.lastJob.restoreTest}</span> : '—',
                      a.state.verified
                        ? <span key="v" data-drill={a.state.drill}><span className={a.state.drill === 'failed' ? 'text-amber-700 dark:text-amber-300' : 'text-green-700 dark:text-green-400'}>{a.state.drill === 'failed' ? 'Last drill failed; before that ' : ''}{ago(a.state.verified.at)}</span>
                          <span className="block text-xs text-muted-foreground">point {when(a.state.verified.recoveryPointAt)} · {SCOPE[a.state.verified.scope] ?? a.state.verified.scope} · {a.state.verified.elapsedSeconds === null ? 'time not reported' : duration(a.state.verified.elapsedSeconds / 60)}</span></span>
                        : <span key="v" className={a.state.drill === 'failed' ? 'text-red-600 dark:text-red-400' : 'text-muted-foreground'} data-drill={a.state.drill}>{DRILL[a.state.drill]}</span>,
                      measure(a.state.rpo),
                      measure(a.state.rto),
                    ])}
                  />
                </Section>
              )}
              {d.assets.some((a) => a.failedDrills.length) && (
                <Section title="Failed restore drills">
                  <Table
                    head={['Asset', 'When', 'Result', 'Scope', 'Target', 'Reason']}
                    empty="None."
                    rows={d.assets.flatMap((a) => a.failedDrills.map((f) => [a.name, when(f.at), f.result, SCOPE[f.scope] ?? f.scope, f.target.replace('_', ' '), f.failureCode ?? '—']))}
                  />
                </Section>
              )}
              {d.businessId && <Objectives d={d} />}
              {isPlatformAdmin && <Connections d={d} biz={biz} />}
              <Section title="Providers and what they can tell us">
                <div className="grid gap-3 md:grid-cols-2" data-testid="backups-providers">
                  {d.providers.map((p) => (
                    <div key={p.kind} className="min-w-0 space-y-2 rounded-md border bg-card p-3 text-sm" data-provider={p.kind}>
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-medium">{p.label}</span>
                        <Badge variant="outline">{p.transport === 'push' ? 'pushes to Rem0te' : 'Rem0te reads it'}</Badge>
                        <Badge variant="secondary">{p.state.replace('_', ' ')}</Badge>
                      </div>
                      <p className="text-xs text-muted-foreground">{p.stateNote}</p>
                      <details><summary className="cursor-pointer text-xs font-medium">What it needs</summary><ul className="mt-1 list-disc space-y-1 pl-5 text-xs">{p.prerequisites.map((x) => <li key={x}>{x}</li>)}</ul></details>
                      <details><summary className="cursor-pointer text-xs font-medium">Limitations</summary><ul className="mt-1 list-disc space-y-1 pl-5 text-xs">{p.limitations.map((x) => <li key={x}>{x}</li>)}</ul></details>
                    </div>
                  ))}
                </div>
              </Section>
            </>
          )}
        </>
      )}
    </div>
  );
}

/** Business RPO/RTO targets: monitoring:configure (they are monitor thresholds). */
function Objectives({ d }: { d: Overview }) {
  const qc = useQueryClient();
  const [rpo, setRpo] = useState(d.objective?.rpoMinutes ? String(d.objective.rpoMinutes) : '');
  const [rto, setRto] = useState(d.objective?.rtoMinutes ? String(d.objective.rtoMinutes) : '');
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  const save = useMutation({
    mutationFn: () => backupsApi.setObjective({ businessId: d.businessId!, rpoMinutes: rpo ? Number(rpo) : null, rtoMinutes: rto ? Number(rto) : null }),
    onSuccess: () => { setNote({ ok: true, text: 'Saved.' }); void qc.invalidateQueries({ queryKey: ['backups'] }); },
    onError: (e) => setNote({ ok: false, text: apiError(e).message }),
  });
  return (
    <Section title="Recovery objectives for this business" note="An asset's own target, where set, comes first">
      <div className="space-y-3 rounded-md border bg-card p-3 text-sm" data-testid="backups-objectives">
        <p className="text-xs text-muted-foreground">RPO is how much data you can afford to lose: measured from the newest recovery point. RTO is how long a restore may take: measured only from a verified restore drill&apos;s elapsed time, never guessed. Both in minutes; leave both empty to clear.</p>
        {d.may.configure ? (
          <div className="flex flex-wrap items-end gap-3">
            <div className="space-y-1"><Label htmlFor="bk-rpo">RPO (minutes)</Label><Input id="bk-rpo" className="w-36" type="number" min={5} max={525600} value={rpo} onChange={(e) => setRpo(e.target.value)} /></div>
            <div className="space-y-1"><Label htmlFor="bk-rto">RTO (minutes)</Label><Input id="bk-rto" className="w-36" type="number" min={5} max={525600} value={rto} onChange={(e) => setRto(e.target.value)} /></div>
            <Button size="sm" disabled={save.isPending} onClick={() => save.mutate()}>Save targets</Button>
          </div>
        ) : (
          <p>{d.objective ? `RPO ${d.objective.rpoMinutes ? duration(d.objective.rpoMinutes) : 'not set'} · RTO ${d.objective.rtoMinutes ? duration(d.objective.rtoMinutes) : 'not set'}` : 'No targets set.'} Setting them needs monitoring:configure for the whole business.</p>
        )}
        {note && <p className={note.ok ? 'text-green-700 dark:text-green-400' : 'text-destructive'}>{note.text}</p>}
      </div>
    </Section>
  );
}

/** Platform Admin: connect St0r (a push token, shown once) or revoke a connection. */
function Connections({ d, biz }: { d: Overview; biz: string }) {
  const qc = useQueryClient();
  const ask = useAsks('backup.connection');
  const [token, setToken] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const refresh = () => void qc.invalidateQueries({ queryKey: ['backups'] });
  const connect = useMutation({
    mutationFn: () => backupsApi.connect({ businessId: biz, kind: 'st0r' }).then((r) => r.data.data as { pushToken?: string }),
    onSuccess: (r) => { setToken(r.pushToken ?? null); setNote(null); refresh(); },
    onError: (e) => setNote(apiError(e).message),
  });
  const revoke = useMutation({ mutationFn: (id: string) => backupsApi.revoke(id), onSuccess: () => { setToken(null); refresh(); }, onError: (e) => setNote(apiError(e).message) });
  const live = d.connections;
  return (
    <Section title="Provider connections" note="Platform Admin">
      <div className="space-y-3 rounded-md border bg-card p-3 text-sm" data-testid="backups-connections">
        {live.length === 0 && <p className="text-muted-foreground">No provider is connected{biz ? ' for this business' : ''}.</p>}
        {live.map((c) => (
          <div key={c.id} className="flex flex-wrap items-center gap-2">
            <span className="font-medium">{c.label}</span>
            <span className="text-xs text-muted-foreground">{c.pushTokenLast4 ? `token …${c.pushTokenLast4}` : c.credentialLast4 ? `credential …${c.credentialLast4}` : ''} · last report {c.lastSyncAt ? ago(c.lastSyncAt) : 'never'}{c.lastResult && c.lastResult !== 'OK' ? ` · ${c.lastResult}` : ''}</span>
            <Button size="sm" variant="outline" className="ml-auto" disabled={revoke.isPending} onClick={() => { if (window.confirm(`Revoke the ${c.label} connection? Its token stops working at once; what it reported is kept.`)) revoke.mutate(c.id); }}>Revoke</Button>
          </div>
        ))}
        {biz ? (
          !live.some((c) => c.kind === 'st0r') && <Button size="sm" disabled={connect.isPending} onClick={() => connect.mutate()} data-testid="backups-connect-st0r">{`Connect St0r${reauthSuffix(ask)}`}</Button>
        ) : <p className="text-xs text-muted-foreground">Pick a business above to connect a provider.</p>}
        {token && (
          <div className="space-y-1 rounded-md border border-amber-500/50 bg-amber-500/10 p-3" data-testid="backups-token">
            <p className="font-medium">St0r push token — shown once</p>
            <code className="block break-all text-xs">{token}</code>
            <p className="text-xs">Configure St0r with this token and this portal&apos;s address. Rem0te keeps only its SHA-256; if it is lost, revoke the connection and make a new one.</p>
          </div>
        )}
        {note && <p className="text-destructive">{note}</p>}
        <p className="text-xs text-muted-foreground">Comet is planned (it needs a read-only Comet API user and is read by Rem0te, not pushed). Neither provider can be told to back up, restore or fail over from here.</p>
      </div>
    </Section>
  );
}
