'use client';

/**
 * A new automation schedule (0.58), or a revision of one (?supersedes=<id>).
 * The API checks everything again as the author, now, and the approval
 * signer checks the document by its own rules; this form only gathers it.
 * Creating asks for a fresh sign-in (automation.policy), and in direct mode
 * also as the request itself (actions.direct), because it is active at once.
 */
import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useMutation, useQuery } from '@tanstack/react-query';
import { AlertTriangle, Loader2 } from 'lucide-react';
import {
  automationApi, businessesApi, endpointsApi, scriptRunsApi, scriptsApi, softwareApi,
  type AutomationCreateInput, type AutomationOfflineInput, type ScriptArgument, type ScriptParameter,
} from '@/lib/api-client';
import { CAP, usePermissions } from '@/lib/auth';
import { useAsks } from '@/lib/confirm-policy';
import { useToast } from '@/hooks/use-toast';
import { useApprovalMode } from '@/hooks/use-approval-mode';
import { DIRECT_DEFAULT_REASON } from '@/lib/direct-mode';
import { cn } from '@/lib/utils';
import { PageHeader } from '@/components/common/page-header';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { WindowEditor, defaultWindowDraft, draftReady, windowFromDraft, type WindowDraft } from '@/components/patching/window-editor';
import {
  HourlyEditor, MAX_RUNS_PER_OCCURRENCE, MAX_TARGETS, OfflineChoice, RecurrencePreview, apiMessage, defaultHourly, hourlyRecurrence, selectClass,
  type HourlyDraft,
} from '@/components/automation/schedule-ui';

const CHARSET_RE: Record<string, RegExp> = {
  alphanumeric: /^[A-Za-z0-9]*$/, identifier: /^[A-Za-z0-9_.-]*$/, hostname: /^[A-Za-z0-9.-]*$/, safe_text: /^[A-Za-z0-9 _.,:@-]*$/,
};
function argumentsFrom(decls: ScriptParameter[], raw: Record<string, string | boolean>): { args: Record<string, ScriptArgument>; problem: string | null } {
  const args: Record<string, ScriptArgument> = {};
  for (const d of decls) {
    const v = raw[d.name];
    if (d.type === 'boolean') { if (v === true || d.required) args[d.name] = v === true; continue; }
    const s = typeof v === 'string' ? v : typeof v === 'number' ? String(v) : '';
    if (s === '') { if (d.required) return { args, problem: `${d.name} is required.` }; continue; }
    if (d.type === 'integer') {
      if (!/^-?\d+$/.test(s)) return { args, problem: `${d.name} must be a whole number.` };
      const n = Number(s);
      if (n < d.min || n > d.max) return { args, problem: `${d.name} must be ${d.min} to ${d.max}.` };
      args[d.name] = n;
    } else if (d.type === 'string') {
      if (s.length > d.maxLength) return { args, problem: `${d.name} is at most ${d.maxLength} characters.` };
      if (!CHARSET_RE[d.charset]?.test(s)) return { args, problem: `${d.name} allows ${d.charset.replace('_', ' ')} characters only.` };
      args[d.name] = s;
    } else args[d.name] = s;
  }
  return { args, problem: null };
}

interface ScriptRow { id: string; name: string; approved: { version: number } | null }
interface EntryRow { id: string; name: string; version: string; packageId: string; archivedAt: string | null }
interface Ep { id: string; name: string; hostname?: string | null }
interface Group { id: string; name: string; business: { id: string } | null; kind: 'static' | 'rule'; members: number | null }
type Readiness = { version: { id: string; parameters: ScriptParameter[] }; timeouts: number[]; you: { canRun: boolean }; allowlist: { status: string } | null };
type Prior = { id: string; name: string; status: string; businessId: string; document: { name: string; task: { kind: 'script'; params: { scriptVersionId: string; parameters: Record<string, ScriptArgument>; timeoutMinutes: number } } | { kind: 'software'; operation: 'install' | 'uninstall'; display: { entryId: string } }; targets: { kind: 'computers'; computers: { endpointId: string }[] } | { kind: 'group'; groupId: string; maxTargets: number }; recurrence: Record<string, unknown>; offline: AutomationOfflineInput; maxRunsPerOccurrence: number } };

export default function NewSchedulePage() {
  const router = useRouter();
  const { toast } = useToast();
  const { can, isPlatformAdmin, businessId: own, technician } = usePermissions();
  const askCreate = useAsks('automation.policy');
  const [q, setQ] = useState<{ business?: string; script?: string; entry?: string; supersedes?: string }>({});
  useEffect(() => {
    try {
      const p = new URLSearchParams(window.location.search);
      setQ({ business: p.get('business') ?? undefined, script: p.get('script') ?? undefined, entry: p.get('entry') ?? undefined, supersedes: p.get('supersedes') ?? undefined });
    } catch { /* no query */ }
  }, []);
  const [business, setBusiness] = useState('');
  const [name, setName] = useState('');
  const [reason, setReason] = useState('');
  const [kind, setKind] = useState<'script' | 'software'>('script');
  const [scriptId, setScriptId] = useState('');
  const [versionId, setVersionId] = useState('');
  const [raw, setRaw] = useState<Record<string, string | boolean>>({});
  const [timeout, setTimeoutMinutes] = useState(5);
  const [entryId, setEntryId] = useState('');
  const [operation, setOperation] = useState<'install' | 'uninstall'>('install');
  const [targetKind, setTargetKind] = useState<'computers' | 'group'>('computers');
  const [ids, setIds] = useState<string[]>([]);
  const [groupId, setGroupId] = useState('');
  const [maxTargets, setMaxTargets] = useState(10);
  const [recKind, setRecKind] = useState<'hourly' | 'window'>('window');
  const [hourly, setHourly] = useState<HourlyDraft>(defaultHourly);
  const [win, setWin] = useState<WindowDraft>(() => ({ ...defaultWindowDraft(), days: new Set(['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat']), start: '02:00', end: '04:00' }));
  const [offline, setOffline] = useState<AutomationOfflineInput>({ mode: 'run_when_online' });
  const [maxRuns, setMaxRuns] = useState(1);
  const [filter, setFilter] = useState('');
  // 0.62: in direct mode a schedule is active when saved; no approver reads a reason.
  const direct = useApprovalMode({ businessId: business || undefined }) === 'direct';
  const why = direct ? (reason.trim() || DIRECT_DEFAULT_REASON) : reason.trim();

  const { data: businesses = [] } = useQuery({
    queryKey: ['businesses', ''], enabled: isPlatformAdmin,
    queryFn: () => businessesApi.list().then((r) => ((r.data as { data?: { id: string; name: string }[] })?.data ?? [])),
  });
  useEffect(() => { if (!business) setBusiness(q.business ?? own ?? technician?.businessId ?? ''); }, [q.business, own, technician, business]);

  // A revision starts from the schedule it replaces.
  const prior = useQuery({
    queryKey: ['automation-schedule', q.supersedes], enabled: !!q.supersedes,
    queryFn: () => automationApi.get(q.supersedes!).then((r) => r.data.data as Prior), retry: false,
  });
  useEffect(() => {
    const p = prior.data; if (!p) return;
    const d = p.document;
    setBusiness(p.businessId); setName(d.name);
    if (d.task.kind === 'script') { setKind('script'); setVersionId(d.task.params.scriptVersionId); setTimeoutMinutes(d.task.params.timeoutMinutes); setRaw(Object.fromEntries(Object.entries(d.task.params.parameters).map(([k, v]) => [k, typeof v === 'boolean' ? v : String(v)]))); }
    else { setKind('software'); setEntryId(d.task.display.entryId); setOperation(d.task.operation); }
    if (d.targets.kind === 'computers') { setTargetKind('computers'); setIds(d.targets.computers.map((c) => c.endpointId)); } else { setTargetKind('group'); setGroupId(d.targets.groupId); setMaxTargets(d.targets.maxTargets); }
    const r = d.recurrence as Record<string, unknown>;
    if (r.kind === 'hourly') { setRecKind('hourly'); setHourly({ everyHours: Number(r.everyHours), minute: Number(r.minute), windowMinutes: Number(r.windowMinutes), timezone: String(r.timezone) }); }
    else if (Array.isArray(r.days)) { setRecKind('window'); setWin((w) => ({ ...w, kind: 'weekly', days: new Set(r.days as string[]), start: String(r.start), end: String(r.end), timezone: String(r.timezone) })); }
    else { setRecKind('window'); setWin((w) => ({ ...w, kind: 'monthly', monthly: 'day' in r ? 'day' : 'weekday', day: Number(r.day ?? w.day), week: (r.week as WindowDraft['week']) ?? w.week, weekday: String(r.weekday ?? w.weekday), offsetDays: Number(r.offsetDays ?? 0), start: String(r.start), end: String(r.end), timezone: String(r.timezone) })); }
    setOffline(d.offline); setMaxRuns(d.maxRunsPerOccurrence);
  }, [prior.data]);
  useEffect(() => { if (q.script) { setKind('script'); setVersionId(q.script); } if (q.entry) { setKind('software'); setEntryId(q.entry); } }, [q.script, q.entry]);

  const scripts = useQuery({
    queryKey: ['scripts', business], enabled: !!business && kind === 'script',
    queryFn: () => scriptsApi.list(business).then((r) => ((r.data.data as { scripts: ScriptRow[] }).scripts ?? []).filter((s) => s.approved)), retry: false,
  });
  // The picked script's approved version, then its readiness (declarations, timeouts, allowlist).
  useEffect(() => {
    if (!scriptId) return;
    const s = scripts.data?.find((x) => x.id === scriptId);
    if (!s?.approved) return;
    scriptsApi.version(s.id, s.approved.version).then((r) => { const v = r.data.data as { id?: string; version?: { id: string } }; setVersionId(v.id ?? v.version?.id ?? ''); setRaw({}); }).catch(() => setVersionId(''));
  }, [scriptId, scripts.data]);
  const readiness = useQuery({
    queryKey: ['script-run', versionId], enabled: kind === 'script' && !!versionId,
    queryFn: () => scriptRunsApi.readiness(versionId).then((r) => r.data.data as Readiness), retry: false,
  });
  const entries = useQuery({
    queryKey: ['software-catalog', business, false], enabled: !!business && kind === 'software',
    queryFn: () => softwareApi.list(business).then((r) => ((r.data.data as { entries: EntryRow[] }).entries ?? []).filter((e) => !e.archivedAt)), retry: false,
  });
  const eps = useQuery({
    queryKey: ['schedule-endpoints', business], enabled: !!business,
    queryFn: () => endpointsApi.list({ businessId: business, limit: '200' }).then((r) => (r.data?.data?.endpoints ?? []) as Ep[]), retry: false,
  });
  const groups = useQuery({
    queryKey: ['device-groups', business], enabled: !!business && targetKind === 'group',
    queryFn: () => automationApi.groups(business).then((r) => ((r.data.data as { groups: Group[] }).groups ?? []).filter((g) => g.business?.id === business && g.members !== null)), retry: false,
  });

  const decls = readiness.data?.version.parameters ?? [];
  const { args, problem: argProblem } = argumentsFrom(decls, raw);
  const recurrence = recKind === 'hourly' ? hourlyRecurrence(hourly) : draftReady(win) ? windowFromDraft(win) : null;
  const body: AutomationCreateInput | null = useMemo(() => {
    if (!business || !recurrence) return null;
    const task = kind === 'script' ? (versionId ? { kind: 'script' as const, scriptVersionId: versionId, parameters: args, timeoutMinutes: timeout } : null) : (entryId ? { kind: 'software' as const, entryId, operation } : null);
    const targets = targetKind === 'computers' ? (ids.length ? { kind: 'computers' as const, endpointIds: ids } : null) : (groupId ? { kind: 'group' as const, groupId, maxTargets } : null);
    if (!task || !targets) return null;
    return { businessId: business, name: name.trim(), reason: why, task, targets, recurrence, offline, maxRunsPerOccurrence: maxRuns, ...(q.supersedes ? { supersedes: q.supersedes } : {}) };
  }, [business, recurrence, kind, versionId, args, timeout, entryId, operation, targetKind, ids, groupId, maxTargets, name, why, offline, maxRuns, q.supersedes]);
  const problem = !business ? 'Choose a business.' : name.trim().length < 3 ? 'Give it a name.' : why.length < 3 ? 'Say why (shown to the approvers).'
    : kind === 'script' && !versionId ? 'Choose an approved script.' : kind === 'script' && readiness.data && !readiness.data.you.canRun ? 'This script is not on the approval signer\'s allowlist (or you cannot run it).'
    : kind === 'script' && argProblem ? argProblem : kind === 'software' && !entryId ? 'Choose a catalog package.'
    : targetKind === 'computers' && !ids.length ? 'Choose at least one computer.' : targetKind === 'group' && !groupId ? 'Choose a device group.'
    : !recurrence ? 'Finish the schedule.' : null;

  const create = useMutation({
    mutationFn: () => automationApi.create(body!),
    onSuccess: (r) => {
      const d = r.data.data as { id: string; status: string };
      toast(d.status === 'ACTIVE' ? { title: 'Active', description: 'Direct mode: the schedule is active and runs at its next window.' } : { title: 'Schedule proposed', description: 'Nothing runs until two approvers approve it on the approval signer\'s page.' });
      router.push(`/automation/schedules/${d.id}`);
    },
    onError: (e) => toast({ title: 'Not created', description: apiMessage(e, 'The schedule was refused.'), variant: 'destructive' }),
  });

  if (!can(CAP.COMPUTERS_VIEW)) return <div className="p-6 text-sm text-muted-foreground">You need View computers to make a schedule.</div>;
  const shown = (eps.data ?? []).filter((e) => !filter.trim() || `${e.name} ${e.hostname ?? ''}`.toLowerCase().includes(filter.toLowerCase()));
  return (
    <div className="space-y-4 p-4 sm:p-6 max-w-4xl">
      <PageHeader title={q.supersedes ? 'Revise a schedule' : 'New schedule'} description={direct ? 'What runs, where, when, and what happens to a computer that is offline. Direct mode is on for this business: it is active as soon as you save it.' : 'What runs, where, when, and what happens to a computer that is offline. Two approvers approve it once on the approval signer.'} />
      <p className="text-xs"><Link className="underline" href="/automation/schedules">All schedules</Link></p>
      {q.supersedes && prior.data && <p className="rounded-md border p-3 text-xs" data-testid="schedule-revision">This replaces <strong>{prior.data.name}</strong> once it is approved; until then the current one keeps running. A revision is approved again from the start.</p>}
      {prior.isError && <p className="text-xs text-destructive">Could not load the schedule this revises.</p>}

      <Card>
        <CardHeader><CardTitle className="text-base">What runs</CardTitle></CardHeader>
        <CardContent className="space-y-3">
          {isPlatformAdmin && (
            <div className="space-y-1">
              <Label htmlFor="new-biz" className="text-xs">Business</Label>
              <select id="new-biz" className={selectClass} value={business} disabled={!!q.supersedes} onChange={(e) => { setBusiness(e.target.value); setIds([]); setGroupId(''); }}>
                <option value="">Choose…</option>
                {businesses.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
              </select>
            </div>
          )}
          <div className="space-y-1">
            <Label htmlFor="new-name" className="text-xs">Name</Label>
            <Input id="new-name" maxLength={120} value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Nightly print queue clean-up" data-testid="schedule-name" />
          </div>
          <div className="flex gap-4 text-xs">
            <label className="flex items-center gap-1.5"><input type="radio" name="task-kind" checked={kind === 'script'} onChange={() => setKind('script')} />A library script</label>
            <label className="flex items-center gap-1.5"><input type="radio" name="task-kind" checked={kind === 'software'} onChange={() => setKind('software')} data-testid="task-software" />A catalog package</label>
          </div>
          {kind === 'script' ? (
            <div className="space-y-2">
              <div className="space-y-1">
                <Label htmlFor="new-script" className="text-xs">Approved script</Label>
                <select id="new-script" className={selectClass} value={scriptId} onChange={(e) => setScriptId(e.target.value)} data-testid="schedule-script">
                  <option value="">{versionId && !scriptId ? 'The version chosen' : 'Choose…'}</option>
                  {(scripts.data ?? []).map((s) => <option key={s.id} value={s.id}>{s.name} (version {s.approved!.version})</option>)}
                </select>
                {scripts.isError && <p className="text-xs text-destructive">{apiMessage(scripts.error, 'Could not load the script library.')}</p>}
                {scripts.data && scripts.data.length === 0 && <p className="text-xs text-muted-foreground">No approved scripts you can see.</p>}
              </div>
              {readiness.data && !readiness.data.you.canRun && <p className="text-xs flex gap-1 text-yellow-700 dark:text-yellow-400"><AlertTriangle className="h-3.5 w-3.5 mt-0.5" />Not on the approval signer&apos;s allowlist ({readiness.data.allowlist?.status.toLowerCase().replace(/_/g, ' ') ?? 'not proposed'}). Propose it from the script&apos;s page first.</p>}
              {decls.map((d) => (
                <div key={d.name} className="space-y-1">
                  {d.type === 'boolean' ? (
                    <label className="flex items-center gap-2 text-xs"><input type="checkbox" checked={raw[d.name] === true} onChange={(x) => setRaw({ ...raw, [d.name]: x.target.checked })} /><code>-{d.name}</code></label>
                  ) : (
                    <>
                      <Label htmlFor={`sarg-${d.name}`} className="text-xs"><code>-{d.name}</code>{d.required ? ' (required)' : ''}{d.description ? ` · ${d.description}` : ''}</Label>
                      {d.type === 'choice' ? (
                        <select id={`sarg-${d.name}`} className={selectClass} value={String(raw[d.name] ?? '')} onChange={(x) => setRaw({ ...raw, [d.name]: x.target.value })}>
                          <option value="">{d.required ? 'Choose…' : '(not given)'}</option>
                          {d.choices.map((c) => <option key={c} value={c}>{c}</option>)}
                        </select>
                      ) : <Input id={`sarg-${d.name}`} value={String(raw[d.name] ?? '')} onChange={(x) => setRaw({ ...raw, [d.name]: x.target.value })} />}
                    </>
                  )}
                </div>
              ))}
              {readiness.data && (
                <div className="space-y-1 w-48">
                  <Label htmlFor="new-timeout" className="text-xs">Stop each run after</Label>
                  <select id="new-timeout" className={selectClass} value={timeout} onChange={(e) => setTimeoutMinutes(Number(e.target.value))}>
                    {readiness.data.timeouts.map((t) => <option key={t} value={t}>{t} minute{t === 1 ? '' : 's'}</option>)}
                  </select>
                </div>
              )}
            </div>
          ) : (
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div className="space-y-1">
                <Label htmlFor="new-entry" className="text-xs">Package</Label>
                <select id="new-entry" className={selectClass} value={entryId} onChange={(e) => setEntryId(e.target.value)} data-testid="schedule-entry">
                  <option value="">Choose…</option>
                  {(entries.data ?? []).map((e) => <option key={e.id} value={e.id}>{e.name} {e.version} ({e.packageId})</option>)}
                </select>
                {entries.data && entries.data.length === 0 && <p className="text-xs text-muted-foreground">The catalog has nothing for this business. <Link className="underline" href="/automation/software">Add software</Link> first.</p>}
              </div>
              <div className="space-y-1">
                <Label htmlFor="new-op" className="text-xs">Do</Label>
                <select id="new-op" className={selectClass} value={operation} onChange={(e) => setOperation(e.target.value as 'install' | 'uninstall')}>
                  <option value="install">Install (the agent skips a computer that already has it)</option>
                  <option value="uninstall">Uninstall</option>
                </select>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle className="text-base">Where</CardTitle></CardHeader>
        <CardContent className="space-y-3">
          <div className="flex gap-4 text-xs">
            <label className="flex items-center gap-1.5"><input type="radio" name="target-kind" checked={targetKind === 'computers'} onChange={() => setTargetKind('computers')} />Named computers</label>
            <label className="flex items-center gap-1.5"><input type="radio" name="target-kind" checked={targetKind === 'group'} onChange={() => setTargetKind('group')} data-testid="target-group" />A device group</label>
          </div>
          {targetKind === 'computers' ? (
            <div className="space-y-1">
              <Label className="text-xs">Computers ({ids.length} of at most {MAX_TARGETS})</Label>
              {eps.isLoading ? <p className="text-xs text-muted-foreground">Loading computers…</p> : (
                <>
                  <Input placeholder="Filter computers…" value={filter} onChange={(x) => setFilter(x.target.value)} />
                  <div className="max-h-48 space-y-1 overflow-y-auto rounded-md border p-1" data-testid="schedule-computers">
                    {shown.length === 0 && <p className="p-2 text-xs text-muted-foreground">No computers you can reach.</p>}
                    {shown.map((e) => {
                      const on = ids.includes(e.id);
                      return (
                        <label key={e.id} className={cn('flex w-full items-center gap-2 rounded px-2 py-1 text-sm', on ? 'bg-primary/5' : 'hover:bg-muted/50')}>
                          <input type="checkbox" checked={on} disabled={!on && ids.length >= MAX_TARGETS} onChange={() => setIds(on ? ids.filter((x) => x !== e.id) : [...ids, e.id])} />
                          <span className="flex-1 truncate">{e.name}</span>
                        </label>
                      );
                    })}
                  </div>
                </>
              )}
            </div>
          ) : (
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div className="space-y-1">
                <Label htmlFor="new-group" className="text-xs">Group</Label>
                <select id="new-group" className={selectClass} value={groupId} onChange={(e) => setGroupId(e.target.value)}>
                  <option value="">Choose…</option>
                  {(groups.data ?? []).map((g) => <option key={g.id} value={g.id}>{g.name} ({g.members} now{g.kind === 'rule' ? ', by rule' : ''})</option>)}
                </select>
              </div>
              <div className="space-y-1">
                <Label htmlFor="new-max" className="text-xs">At most this many computers per run</Label>
                <Input id="new-max" type="number" min={1} max={MAX_TARGETS} value={maxTargets} onChange={(e) => setMaxTargets(Math.max(1, Math.min(MAX_TARGETS, Number(e.target.value) || 1)))} />
              </div>
              <p className="text-xs text-muted-foreground sm:col-span-2">
                The group&apos;s members are worked out at every run, as you would see them then. The approval signer cannot see the group: it holds each run to this business and this cap, and the approvers are told so.
              </p>
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle className="text-base">When</CardTitle></CardHeader>
        <CardContent className="space-y-3">
          <div className="flex gap-4 text-xs">
            <label className="flex items-center gap-1.5"><input type="radio" name="rec-kind" checked={recKind === 'window'} onChange={() => setRecKind('window')} />Daily, weekly or monthly window</label>
            <label className="flex items-center gap-1.5"><input type="radio" name="rec-kind" checked={recKind === 'hourly'} onChange={() => setRecKind('hourly')} data-testid="rec-hourly" />Every few hours</label>
          </div>
          {recKind === 'hourly'
            ? <><HourlyEditor value={hourly} onChange={setHourly} /><RecurrencePreview recurrence={recurrence} /></>
            : <><WindowEditor id="sched-window" value={win} onChange={setWin} title="Run window" /><p className="text-xs text-muted-foreground">Tick every day for a daily schedule.</p><RecurrencePreview recurrence={recurrence} /></>}
          <OfflineChoice value={offline} onChange={setOffline} />
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div className="space-y-1">
              <Label htmlFor="new-runs" className="text-xs">Plans per window (1–{MAX_RUNS_PER_OCCURRENCE})</Label>
              <select id="new-runs" className={selectClass} value={maxRuns} onChange={(e) => setMaxRuns(Number(e.target.value))}>
                {Array.from({ length: MAX_RUNS_PER_OCCURRENCE }, (_, i) => i + 1).map((n) => <option key={n} value={n}>{n}</option>)}
              </select>
              <p className="text-xs text-muted-foreground">More than one only helps when a plan closes before the window does (skip if offline, or a short expiry): a later plan names only computers the earlier ones did not. Runs never overlap.</p>
            </div>
            <p className="text-xs text-muted-foreground self-end" data-testid="schedule-no-expiry">The schedule does not expire: it runs until you pause or revoke it.</p>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="space-y-3 pt-4">
          {!direct && (
            <div className="space-y-1">
              <Label htmlFor="new-reason" className="text-xs">Why (shown to the approvers)</Label>
              <Textarea id="new-reason" rows={2} maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} data-testid="schedule-reason" />
            </div>
          )}
          {problem && <p className="text-xs text-muted-foreground" data-testid="schedule-problem">{problem}</p>}
          <Button disabled={!!problem || !body || create.isPending} onClick={() => create.mutate()} data-testid="schedule-create">
            {create.isPending && <Loader2 className="h-4 w-4 mr-1 animate-spin" />}{direct ? 'Create policy' : 'Propose the schedule'}{askCreate ? ' (confirm it is you)' : ''}
          </Button>
          {direct
            ? <p className="text-xs text-muted-foreground" data-testid="schedule-direct-note">Direct mode is on for this business (set by the approval signer&apos;s operator): the schedule is active as soon as you save it.</p>
            : <p className="text-xs text-muted-foreground">Nothing runs until it is approved on the approval signer. In direct mode, which only the signer&apos;s operator can turn on, it is active as soon as you create it.</p>}
        </CardContent>
      </Card>
    </div>
  );
}
