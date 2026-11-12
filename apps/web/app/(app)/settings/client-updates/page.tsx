'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, CalendarClock, Plus, Trash2 } from 'lucide-react';
import { agentAutoUpdateApi, businessesApi, clientUpdatesApi, type AgentAutoUpdateSettings } from '@/lib/api-client';
import { usePermissions } from '@/lib/auth';
import {
  browserTimeZone, DAY_NAMES, knownTimeZones, type ComputerRow, type PolicyPayload, type PolicyView, type WindowSpec,
} from '@/lib/client-updates';
import { PageHeader } from '@/components/common/page-header';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { apiError } from '@/components/security-controls/shared';
import { connectivityFrom, connectivityHint, connectivityLabel, CONNECTIVITY_DOT } from '@/lib/connectivity';

/**
 * Settings → Client updates (0.32).
 *
 * A business — and, optionally, each of its sites and (0.35) device groups —
 * gets a policy that lets
 * the server update outdated RustDesk clients by itself, but only inside an
 * update window outside working hours. Everything this page shows comes from
 * the API: the window's next opening, why a computer is waiting, and why one
 * will never update automatically. Turning a policy on asks the person to
 * confirm it is them (the step-up dialog); turning it off does not.
 *
 * Precedence (0.35), decided by the API: a device group's policy beats a site
 * override, which beats the business policy; between two groups a computer
 * is in, the lower priority number wins. The Computers table says which one
 * governs each computer and why.
 */

const fmt = (d: string | null | undefined) => (d ? new Date(d).toLocaleString() : '—');
const DEFAULT_WINDOW: WindowSpec = { days: [0, 1, 2, 3, 4, 5, 6], start: '22:00', end: '05:00' };

function Notice({ n }: { n: { ok: boolean; text: string } | null }) {
  if (!n) return null;
  return <div className={`rounded-md border p-3 text-sm ${n.ok ? 'border-emerald-300 bg-emerald-50 text-emerald-900 dark:bg-emerald-950 dark:text-emerald-100' : 'border-destructive/40 bg-destructive/10 text-destructive'}`}>{n.text}</div>;
}

function WindowLine({ p }: { p: PolicyView }) {
  if (!p.valid) return <p className="text-sm text-destructive">The stored window no longer validates, so it is treated as closed. Save a new one.</p>;
  return (
    <p className="text-sm text-muted-foreground">
      {p.description}.{' '}
      {!p.enabled ? 'Off — nothing is queued automatically.'
        : p.window.open ? <>Open now, until {fmt(p.window.closesAt)}; next opens {fmt(p.window.opensAt)}.</>
          : <>Closed now; next opens {fmt(p.window.opensAt)}{p.window.closesAt ? `, until ${fmt(p.window.closesAt)}` : ''}.</>}
    </p>
  );
}

export default function ClientUpdatesPage() {
  const { user, isPlatformAdmin, canManageTechnicians, technician, businessId: ownBusiness } = usePermissions();
  const msp = (isPlatformAdmin || canManageTechnicians) && !technician;
  const [picked, setPicked] = useState('');
  const businessId = ownBusiness ?? (picked || null);
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null);

  const { data: businesses } = useQuery<{ id: string; name: string }[]>({
    queryKey: ['businesses-for-client-updates'],
    queryFn: () => businessesApi.list().then((r) => ((r.data as { data?: { id: string; name: string }[] })?.data ?? [])),
    enabled: msp && !ownBusiness,
  });
  const policy = useQuery<PolicyPayload>({
    queryKey: ['client-update-policy', businessId],
    queryFn: () => clientUpdatesApi.policy(businessId).then((r) => r.data?.data as PolicyPayload),
    enabled: !!user && !!businessId,
    refetchInterval: 60_000,
  });
  const computers = useQuery<{ target: PolicyPayload['target']; computers: ComputerRow[] }>({
    queryKey: ['client-update-computers', businessId],
    queryFn: () => clientUpdatesApi.computers(businessId).then((r) => r.data?.data),
    enabled: !!user && !!businessId,
    refetchInterval: 60_000,
  });

  if (!user) return null;
  const d = policy.data;
  return (
    <div className="space-y-4 p-4 md:p-6">
      <Link href="/settings" className="inline-flex items-center text-sm text-muted-foreground hover:underline">
        <ArrowLeft className="mr-1 h-4 w-4" />Settings
      </Link>
      <PageHeader
        title="Client updates"
        description="Let the server update outdated RustDesk clients by itself, only inside an update window outside working hours. Clicking Update on the Updates page still goes at once."
      />
      {msp && !ownBusiness && (
        <div className="space-y-1">
          <Label htmlFor="cu-business">Business</Label>
          <select id="cu-business" className="w-full rounded-md border bg-background p-2 text-sm md:w-96" value={picked} onChange={(e) => { setPicked(e.target.value); setNotice(null); }}>
            <option value="">Choose a business…</option>
            {(businesses ?? []).map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
          </select>
        </div>
      )}
      <Notice n={notice} />
      {isPlatformAdmin && <AgentAutoUpdateCard setNotice={setNotice} />}
      {!businessId && <p className="text-sm text-muted-foreground">Choose a business to see and set its policy.</p>}
      {policy.isError && <Notice n={{ ok: false, text: apiError(policy.error).message }} />}
      {d && (
        <>
          <div className="space-y-2">
            {d.containment.paused && (
              <Notice n={{ ok: false, text: `Updates are paused for ${d.containment.scope === 'global' ? 'every business' : 'this business'} (containment): nothing is queued or handed out until the pause is lifted. Reason: ${d.containment.reason ?? '—'}` }} />
            )}
            {!d.sweep.enabled && (
              <Notice n={{ ok: false, text: 'The client-update sweep is turned off on this server (CLIENT_UPDATE_SWEEP=off), so nothing is queued automatically whatever the policy says.' }} />
            )}
            <p className="text-sm text-muted-foreground">
              Target: {d.target.version ? <span className="font-mono">v{d.target.version}</span> : 'unknown (GitHub unreachable and no version pin) — nothing is queued until it is known'}
              {d.target.pinned && ' (the platform’s supported-version pin)'}.
              {!d.may.edit && d.may.reason && <> You can see this policy but not change it: {d.may.reason}</>}
            </p>
          </div>

          <Card>
            <CardHeader><CardTitle className="flex items-center gap-2 text-sm"><CalendarClock className="h-4 w-4" />{d.business.name} — business policy</CardTitle></CardHeader>
            <CardContent className="space-y-3">
              {d.policy ? <WindowLine p={d.policy} /> : <p className="text-sm text-muted-foreground">No policy yet: off. Computers update only when someone clicks Update.</p>}
              <PolicyForm key={`b-${d.policy?.updatedAt ?? 'new'}`} businessId={d.business.id} siteId={null} current={d.policy}
                defaultTz={browserTimeZone()} canEdit={d.may.edit} setNotice={setNotice} />
            </CardContent>
          </Card>

          {d.sites.length > 0 && (
            <Card>
              <CardHeader><CardTitle className="text-sm">Sites</CardTitle></CardHeader>
              <CardContent className="space-y-4">
                <p className="text-sm text-muted-foreground">A site override replaces the business policy for that site’s computers — including being off when the business policy is on.</p>
                {d.sites.map((s) => <SiteRow key={s.id} businessId={d.business.id} site={s} canEdit={d.may.edit} setNotice={setNotice} />)}
              </CardContent>
            </Card>
          )}

          <Card data-testid="cu-groups">
            <CardHeader><CardTitle className="text-sm">Device groups</CardTitle></CardHeader>
            <CardContent className="space-y-4">
              <p className="text-sm text-muted-foreground">{d.precedence} Members are counted now, over the computers you can see; a rule group&apos;s members change by themselves as computers change.</p>
              {d.groups.length === 0 && <p className="text-sm text-muted-foreground">This business has no device groups. Make one on the <Link href="/endpoints" className="underline">device list</Link>.</p>}
              {d.groups.map((g) => <GroupRow key={g.id} businessId={d.business.id} group={g} canEdit={d.may.edit} setNotice={setNotice} />)}
            </CardContent>
          </Card>

          <Computers rows={computers.data?.computers ?? null} error={computers.isError ? apiError(computers.error).message : null} />
        </>
      )}
    </div>
  );
}

function SiteRow({ businessId, site, canEdit, setNotice }: {
  businessId: string; site: PolicyPayload['sites'][number]; canEdit: boolean; setNotice: (n: { ok: boolean; text: string } | null) => void;
}) {
  const qc = useQueryClient();
  const [adding, setAdding] = useState(false);
  const remove = useMutation({
    mutationFn: () => clientUpdatesApi.removeSiteOverride(businessId, site.id),
    onSuccess: (r) => {
      const n = (r.data?.data as { clearedQueued: number })?.clearedQueued ?? 0;
      setNotice({ ok: true, text: `${site.name} now follows the business policy.${n ? ` ${n} automatic request${n === 1 ? '' : 's'} withdrawn.` : ''}` });
      qc.invalidateQueries({ queryKey: ['client-update-policy'] }); qc.invalidateQueries({ queryKey: ['client-update-computers'] });
    },
    onError: (e) => setNotice({ ok: false, text: apiError(e).message }),
  });
  const tz = site.timezone && knownTimeZones().includes(site.timezone) ? site.timezone : browserTimeZone();
  return (
    <div className="space-y-2 rounded-md border p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="font-medium">{site.name} {site.override ? <Badge variant="secondary" className="ml-1">Override</Badge> : <Badge variant="outline" className="ml-1">Business policy</Badge>}</div>
        {canEdit && (site.override
          ? <Button variant="ghost" size="sm" onClick={() => remove.mutate()} disabled={remove.isPending}><Trash2 className="mr-1 h-4 w-4" />Remove override</Button>
          : !adding && <Button variant="outline" size="sm" onClick={() => setAdding(true)}><Plus className="mr-1 h-4 w-4" />Override for this site</Button>)}
      </div>
      {site.override && <WindowLine p={site.override} />}
      {(site.override || adding) && (
        <PolicyForm key={`s-${site.id}-${site.override?.updatedAt ?? 'new'}`} businessId={businessId} siteId={site.id} current={site.override}
          defaultTz={tz} canEdit={canEdit} setNotice={setNotice} onCancel={site.override ? undefined : () => setAdding(false)} />
      )}
    </div>
  );
}

const USE_TEXT: Record<string, string> = {
  unreadable: 'Its rule can no longer be read, so it matches no computer and its policy applies to none.',
  reads_alerts: 'Its rule picks computers by their alerts, so its policy applies to none. Change the rule or remove the policy.',
};

function GroupRow({ businessId, group, canEdit, setNotice }: {
  businessId: string; group: PolicyPayload['groups'][number]; canEdit: boolean; setNotice: (n: { ok: boolean; text: string } | null) => void;
}) {
  const qc = useQueryClient();
  const [adding, setAdding] = useState(false);
  const remove = useMutation({
    mutationFn: () => clientUpdatesApi.removeGroupPolicy(businessId, group.id),
    onSuccess: (r) => {
      const n = (r.data?.data as { clearedQueued: number })?.clearedQueued ?? 0;
      setNotice({ ok: true, text: `${group.name} no longer has a policy; its computers follow their site or business policy.${n ? ` ${n} automatic request${n === 1 ? '' : 's'} withdrawn.` : ''}` });
      qc.invalidateQueries({ queryKey: ['client-update-policy'] }); qc.invalidateQueries({ queryKey: ['client-update-computers'] });
    },
    onError: (e) => setNotice({ ok: false, text: apiError(e).message }),
  });
  const p = group.policy;
  return (
    <div className="space-y-2 rounded-md border p-3" data-testid={`cu-group-${group.id}`}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="font-medium">
          {group.name}{' '}
          <Badge variant="outline" className="ml-1">{group.kind === 'rule' ? 'Rule' : 'Static'}</Badge>
          {p && <Badge variant="secondary" className="ml-1">Priority {p.priority}</Badge>}
          {p && group.members !== null && <span className="ml-2 text-xs text-muted-foreground">{group.members} computer{group.members === 1 ? '' : 's'} now</span>}
        </div>
        {canEdit && (p
          ? <Button variant="ghost" size="sm" onClick={() => remove.mutate()} disabled={remove.isPending}><Trash2 className="mr-1 h-4 w-4" />Remove policy</Button>
          : !adding && <Button variant="outline" size="sm" onClick={() => setAdding(true)}><Plus className="mr-1 h-4 w-4" />Policy for this group</Button>)}
      </div>
      {group.use && USE_TEXT[group.use] && <p className="text-sm text-destructive">{USE_TEXT[group.use]}</p>}
      {p && <WindowLine p={p} />}
      {(p || adding) && (
        <PolicyForm key={`g-${group.id}-${p?.updatedAt ?? 'new'}`} businessId={businessId} siteId={null} groupId={group.id} current={p}
          defaultTz={browserTimeZone()} canEdit={canEdit} setNotice={setNotice} onCancel={p ? undefined : () => setAdding(false)} />
      )}
    </div>
  );
}

function PolicyForm({ businessId, siteId, groupId = null, current, defaultTz, canEdit, setNotice, onCancel }: {
  businessId: string; siteId: string | null; groupId?: string | null; current: PolicyView | null; defaultTz: string; canEdit: boolean;
  setNotice: (n: { ok: boolean; text: string } | null) => void; onCancel?: () => void;
}) {
  const qc = useQueryClient();
  const [enabled, setEnabled] = useState(current?.enabled ?? false);
  const [timeZone, setTimeZone] = useState(current?.timeZone ?? defaultTz);
  const [windows, setWindows] = useState<WindowSpec[]>(current?.windows?.length ? current.windows : [DEFAULT_WINDOW]);
  const [skipActiveSession, setSkipActiveSession] = useState(current?.skipActiveSession ?? true);
  const [skipLoggedOnUser, setSkipLoggedOnUser] = useState(current?.skipLoggedOnUser ?? false);
  const [priority, setPriority] = useState<string>(current?.priority != null ? String(current.priority) : '');
  const [agentMode, setAgentMode] = useState<string>(current?.agentMode ?? '');
  const zones = useMemo(() => knownTimeZones(), []);
  const listId = `tz-${groupId ?? siteId ?? 'business'}`;

  const save = useMutation({
    mutationFn: () => clientUpdatesApi.setPolicy({
      businessId, siteId, enabled, timeZone, windows, skipActiveSession, skipLoggedOnUser,
      agentMode: agentMode === '' ? null : (agentMode as 'ANY_TIME' | 'WINDOW' | 'OFF'),
      ...(groupId ? { groupId, priority: priority === '' ? null : Number(priority) } : {}),
    }),
    onSuccess: (r) => {
      const n = (r.data?.data as { clearedQueued: number })?.clearedQueued ?? 0;
      setNotice({ ok: true, text: `Saved — automatic updates are ${enabled ? 'on' : 'off'}${groupId ? ' for this group' : siteId ? ' for this site' : ''}.${n ? ` ${n} automatic request${n === 1 ? '' : 's'} withdrawn.` : ''}` });
      qc.invalidateQueries({ queryKey: ['client-update-policy'] }); qc.invalidateQueries({ queryKey: ['client-update-computers'] });
    },
    onError: (e) => setNotice({ ok: false, text: apiError(e).message }),
  });
  const setWin = (i: number, w: Partial<WindowSpec>) => setWindows(windows.map((x, j) => (j === i ? { ...x, ...w } : x)));
  const disabled = !canEdit || save.isPending;

  return (
    <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); setNotice(null); save.mutate(); }}>
      <label className="flex items-center gap-2 text-sm font-medium">
        <input type="checkbox" checked={enabled} disabled={disabled} onChange={(e) => setEnabled(e.target.checked)} />
        Update outdated clients automatically inside the window
      </label>
      {groupId && (
        <div className="space-y-1 md:w-96">
          <Label htmlFor={`${listId}-priority`}>Priority (1 first)</Label>
          <Input id={`${listId}-priority`} type="number" min={1} max={999} value={priority} disabled={disabled} onChange={(e) => setPriority(e.target.value)} placeholder="e.g. 10" />
          <p className="text-xs text-muted-foreground">A computer in several groups with a policy follows the one with the lowest number. Two groups of this business cannot share a number.</p>
        </div>
      )}
      <div className="space-y-1 md:w-96">
        <Label htmlFor={`${listId}-input`}>Time zone (the window’s times are in this zone)</Label>
        <Input id={`${listId}-input`} list={listId} value={timeZone} disabled={disabled} onChange={(e) => setTimeZone(e.target.value)} placeholder="Europe/London" />
        <datalist id={listId}>{zones.map((z) => <option key={z} value={z} />)}</datalist>
      </div>
      {windows.map((w, i) => (
        <div key={i} className="flex flex-wrap items-end gap-3 rounded-md border p-2">
          <fieldset className="space-y-1">
            <legend className="text-xs text-muted-foreground">Days (the day a window starts on)</legend>
            <div className="flex flex-wrap gap-2">
              {DAY_NAMES.map((n, day) => (
                <label key={n} className="flex items-center gap-1 text-sm">
                  <input type="checkbox" disabled={disabled} checked={w.days.includes(day)}
                    onChange={(e) => setWin(i, { days: e.target.checked ? [...w.days, day].sort() : w.days.filter((x) => x !== day) })} />{n}
                </label>
              ))}
            </div>
          </fieldset>
          <div className="space-y-1"><Label>From</Label><Input type="time" className="w-32" value={w.start} disabled={disabled} onChange={(e) => setWin(i, { start: e.target.value })} /></div>
          <div className="space-y-1"><Label>Until</Label><Input type="time" className="w-32" value={w.end} disabled={disabled} onChange={(e) => setWin(i, { end: e.target.value })} /></div>
          {windows.length > 1 && <Button type="button" variant="ghost" size="sm" disabled={disabled} onClick={() => setWindows(windows.filter((_, j) => j !== i))}><Trash2 className="h-4 w-4" /></Button>}
        </div>
      ))}
      <p className="text-xs text-muted-foreground">An end earlier than the start runs past midnight (22:00–05:00 on Friday is Friday night into Saturday morning). At least 30 minutes; up to 7 windows.</p>
      {windows.length < 7 && <Button type="button" variant="outline" size="sm" disabled={disabled} onClick={() => setWindows([...windows, { ...DEFAULT_WINDOW }])}><Plus className="mr-1 h-4 w-4" />Another window</Button>}
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" checked={skipActiveSession} disabled={disabled} onChange={(e) => setSkipActiveSession(e.target.checked)} />
        Skip a computer while a remote session is open on it (recommended — the install restarts RustDesk and ends the session)
      </label>
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" checked={skipLoggedOnUser} disabled={disabled} onChange={(e) => setSkipLoggedOnUser(e.target.checked)} />
        Skip a computer while someone is logged on to it (an agent that does not report who is logged on is skipped too)
      </label>
      <div className="space-y-1 border-t pt-3 md:w-[32rem]">
        <Label htmlFor={`${listId}-agent`}>Keep agents up to date automatically</Label>
        <select id={`${listId}-agent`} data-testid="cu-agent-mode" className="w-full rounded-md border bg-background p-2 text-sm" value={agentMode} disabled={disabled} onChange={(e) => setAgentMode(e.target.value)}>
          <option value="">{groupId || siteId ? 'Inherit (the next policy that applies)' : 'Default — any time, paced'}</option>
          <option value="ANY_TIME">Any time, paced</option>
          <option value="WINDOW">Only inside this policy’s window</option>
          <option value="OFF">Off — never update agents automatically</option>
        </select>
        <p className="text-xs text-muted-foreground">
          When a computer’s agent is older than this server’s, its next check-in re-runs the installer (a signed agent runs its own verified update instead).
          Independent of the RustDesk checkbox above. Never during a remote session; at most a few attempts per release; paced across the platform.
          Turning it on or to the window needs you to confirm it is you; turning it off does not.
        </p>
      </div>
      {canEdit && (
        <div className="flex gap-2">
          <Button type="submit" disabled={save.isPending}>{save.isPending ? 'Saving…' : 'Save'}</Button>
          {onCancel && <Button type="button" variant="ghost" onClick={onCancel}>Cancel</Button>}
        </div>
      )}
    </form>
  );
}

/**
 * Settings → Client updates → Keep agents up to date automatically (0.36),
 * the platform-wide half: Platform Admin only. Each business, site or device
 * group can opt out (or limit it to its window) in its policy below.
 */
function AgentAutoUpdateCard({ setNotice }: { setNotice: (n: { ok: boolean; text: string } | null) => void }) {
  const qc = useQueryClient();
  const q = useQuery<AgentAutoUpdateSettings>({
    queryKey: ['agent-auto-update'],
    queryFn: () => agentAutoUpdateApi.get().then((r) => r.data.data),
    refetchInterval: 60_000,
  });
  const d = q.data;
  const [perHour, setPerHour] = useState('');
  const [maxAttempts, setMaxAttempts] = useState('');
  const save = useMutation({
    mutationFn: (body: { enabled?: boolean; perHour?: number; maxAttempts?: number }) => agentAutoUpdateApi.put(body),
    onSuccess: () => { setNotice({ ok: true, text: 'Saved — automatic agent update settings changed.' }); setPerHour(''); setMaxAttempts(''); qc.invalidateQueries({ queryKey: ['agent-auto-update'] }); },
    onError: (e) => setNotice({ ok: false, text: apiError(e).message }),
  });
  return (
    <Card data-testid="agent-auto-update-settings">
      <CardHeader><CardTitle className="text-sm">Keep agents up to date automatically — every business</CardTitle></CardHeader>
      <CardContent className="space-y-3 text-sm">
        {q.isError && <Notice n={{ ok: false, text: apiError(q.error).message }} />}
        {d && (
          <>
            {!d.processOn && <Notice n={{ ok: false, text: 'Turned off on this server (AGENT_AUTO_UPDATE=off): no computer is asked to update, whatever is set here.' }} />}
            <label className="flex items-center gap-2 font-medium">
              <input type="checkbox" checked={d.enabled} disabled={save.isPending} onChange={(e) => save.mutate({ enabled: e.target.checked })} />
              Update outdated agents automatically (on by default)
            </label>
            <p className="text-muted-foreground">
              Standard Windows agents older than <span className="font-mono">{d.served.version}</span> re-run the installer at a check-in, as Update agent does
              {d.served.signedSha256 ? <>; signed agents not on the published build run their own verified update</> : <>; no signed agent build is published, so signed agents are not compared</>}.
              Linux and macOS agents are read-only and are never updated from here. Each attempt downloads the RustDesk client again (about 40 MB).
            </p>
            <div className="flex flex-wrap items-end gap-3">
              <div className="space-y-1">
                <Label htmlFor="aau-per-hour">At most this many starts an hour, across the platform</Label>
                <Input id="aau-per-hour" type="number" min={1} max={2000} className="w-32" placeholder={String(d.perHour)} value={perHour} onChange={(e) => setPerHour(e.target.value)} />
              </div>
              <div className="space-y-1">
                <Label htmlFor="aau-attempts">Attempts per computer per release</Label>
                <Input id="aau-attempts" type="number" min={1} max={10} className="w-32" placeholder={String(d.maxAttempts)} value={maxAttempts} onChange={(e) => setMaxAttempts(e.target.value)} />
              </div>
              <Button type="button" variant="outline" disabled={save.isPending || (perHour === '' && maxAttempts === '')}
                onClick={() => save.mutate({ ...(perHour !== '' ? { perHour: Number(perHour) } : {}), ...(maxAttempts !== '' ? { maxAttempts: Number(maxAttempts) } : {}) })}>
                Save limits
              </Button>
            </div>
            <p className="text-muted-foreground">
              Now: {d.pace.usedLastHour} of {d.pace.perHour} starts used in the last hour. Last 24 hours: {d.lastDay.started} started, {d.lastDay.updated} updated, {d.lastDay.open} still open.
              Attempts are spaced 2 h and 8 h apart; after the last one a computer is shown as failing and is not asked again until the next release or someone clicks Update agent.
            </p>
            {d.failing.count > 0 && (
              <div className="space-y-1" data-testid="agent-auto-update-failing">
                <p className="font-medium text-amber-700 dark:text-amber-400">{d.failing.count} computer{d.failing.count === 1 ? '' : 's'} failing to update automatically</p>
                <ul className="space-y-0.5 text-xs">
                  {d.failing.computers.map((c) => (
                    <li key={c.id}><Link href={`/endpoints/${c.id}#agent-card`} className="underline">{c.name}</Link>{c.business ? ` · ${c.business.name}` : ''} · agent {c.agentVersion ?? '—'} · {c.attempts} attempts, last {fmt(c.lastAt)}</li>
                  ))}
                </ul>
              </div>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}

const STATE_BADGE: Record<ComputerRow['state'], { label: string; variant: 'default' | 'secondary' | 'outline' | 'destructive' }> = {
  current: { label: 'Current', variant: 'secondary' },
  eligible: { label: 'Will auto-update', variant: 'default' },
  manual_only: { label: 'Manual only', variant: 'outline' },
  blocked: { label: 'Not automatic', variant: 'outline' },
  queued_manual: { label: 'Queued by hand', variant: 'default' },
  queued_auto: { label: 'Auto, queued', variant: 'default' },
  queued_auto_waiting: { label: 'Auto, waiting', variant: 'secondary' },
};

function Computers({ rows, error }: { rows: ComputerRow[] | null; error: string | null }) {
  const never = rows?.filter((r) => r.blocker?.permanent).length ?? 0;
  return (
    <Card>
      <CardHeader><CardTitle className="text-sm">Computers</CardTitle></CardHeader>
      <CardContent className="space-y-2">
        {error && <Notice n={{ ok: false, text: error }} />}
        {rows && never > 0 && <p className="text-sm text-amber-700 dark:text-amber-400">{never} computer{never === 1 ? '' : 's'} will never update automatically until someone fixes what is listed against {never === 1 ? 'it' : 'them'}.</p>}
        {rows && rows.length === 0 && <p className="text-sm text-muted-foreground">No computers you can see in this business.</p>}
        {rows && rows.length > 0 && (
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead className="border-b text-muted-foreground">
                <tr>
                  <th className="py-2 pr-3 text-left font-medium">Computer</th>
                  <th className="py-2 pr-3 text-left font-medium">Site</th>
                  <th className="py-2 pr-3 text-left font-medium">Policy</th>
                  <th className="py-2 pr-3 text-left font-medium">RustDesk</th>
                  <th className="py-2 text-left font-medium">Automatic updates</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id} className="border-b last:border-0 align-top">
                    <td className="py-2 pr-3">
                      <div className="flex items-center gap-1.5 font-medium">
                        <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${CONNECTIVITY_DOT[connectivityFrom(r)]}`} data-connectivity={connectivityFrom(r)} title={`${connectivityLabel(connectivityFrom(r), r.lastSeenAt)}. ${connectivityHint(connectivityFrom(r))}`} />
                        <Link href={`/endpoints/${r.id}`} className="truncate hover:underline">{r.name}</Link>
                      </div>
                      <div className="text-muted-foreground">{r.platform ?? 'unknown platform'}</div>
                    </td>
                    <td className="py-2 pr-3">{r.site?.name ?? '—'}{r.policy?.scope === 'site' && <span className="text-muted-foreground"> (override)</span>}</td>
                    <td className="py-2 pr-3" title={r.policy?.why}>
                      {!r.policy ? <span className="text-muted-foreground">None</span>
                        : r.policy.scope === 'group' ? <>Group {r.policy.group?.name} <span className="text-muted-foreground">(priority {r.policy.group?.priority})</span></>
                          : r.policy.scope === 'site' ? 'Site override' : 'Business'}
                      {r.policy?.alsoIn?.length ? <div className="text-muted-foreground">ahead of {r.policy.alsoIn.map((g) => `${g.name} (${g.priority})`).join(', ')}</div> : null}
                    </td>
                    <td className="py-2 pr-3 font-mono">{r.version ? `v${r.version}` : '—'}{r.queued?.targetVersion && <span className="text-muted-foreground"> → v{r.queued.targetVersion}</span>}</td>
                    <td className="py-2">
                      <Badge variant={STATE_BADGE[r.state].variant} className="mr-2 text-[10px]">{STATE_BADGE[r.state].label}</Badge>
                      <span className={r.blocker?.permanent ? 'text-amber-700 dark:text-amber-400' : 'text-muted-foreground'}>{r.text}</span>
                      {r.queued?.hold?.since && <span className="text-muted-foreground"> Since {fmt(r.queued.hold.since)}.</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
