'use client';

/**
 * Restart windows (0.60, docs/restart-windows.md): "restart if Windows needs
 * it, nightly 02:00–04:00 in this time zone", set on a business (the default
 * for its computers), on a device group, or on one computer — which may
 * instead say "no automatic restarts". Computer > group > business.
 *
 * Every automatic restart is a signed windows.reboot.schedule plan, and a
 * window is approved on the approval signer with two passkeys (or is active
 * at once in direct mode). Until it is approved it governs nothing, and the
 * card says so plainly: "Waiting for approval". Whether a change asks the
 * person to confirm it is them is the server's decision (restart.window).
 */
import { useState } from 'react';
import Link from 'next/link';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Power } from 'lucide-react';
import { restartWindowsApi, type RestartWindowBody } from '@/lib/api-client';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { useToast } from '@/hooks/use-toast';
import { useAsks } from '@/lib/confirm-policy';
import { describeOccurrence } from '@/lib/tasks';
import type { PolicyWindowInput } from '@/lib/patching';
import { WindowEditor, defaultWindowDraft, draftReady, windowFromDraft, type WindowDraft } from '@/components/patching/window-editor';
import { IGNORE_REMOTE_SESSION_LABEL, SIGNED_IN_USER_NOTE } from '@/components/endpoints/restart-options';

type Rule = 'if_required' | 'always';
type PolicyView = {
  id: string; status: string; paused: boolean; direct: boolean; approvalUrl: string | null; approvals: number;
  rule: Rule; ignoreRemoteSession: boolean; window: PolicyWindowInput | null; description: string; does: string;
  /** 0.63: null for a window that never expires (every one set from 0.63). */
  expiresAt: string | null; expiresSoon: boolean; nextWindow: { start: string; end: string } | null; upcoming: { start: string; end: string }[];
  setBy: string; setAt: string; reason: string; lastNote: { at: string; code: string; message: string } | null;
};
type SettingView = {
  id: string; scope: 'business' | 'group' | 'computer'; mode: 'window' | 'off'; priority: number | null;
  groupId: string | null; groupName: string | null; endpointId: string | null; computer: string | null;
  inForce: boolean; notInForceBecause: string | null; window: PolicyView | null; pending: PolicyView | null; updatedAt: string;
};
type Readiness = { signerConfigured: boolean; signerSupportsRestartWindows: boolean; sweep: { enabled: boolean; everySeconds: number }; why: string | null };
type BusinessView = {
  businessId: string; businessName: string; readiness: Readiness; approval: { mode: 'direct' | 'signed' } | null; contained: boolean;
  business: SettingView | null; groups: SettingView[]; computers: SettingView[];
  availableGroups: { id: string; name: string; kind: string }[]; siteTimezones: string[];
  may: { edit: boolean; reason: string | null }; attemptsLast7Days: { asked: number; signed: number; refused: number };
};
type Attempt = { at: string; windowKey: string; attempt: number; code: string; message: string; jobId: string | null; jobStatus: string | null; targetStatus: string | null; outcome: string | null; reason: string | null; scheduledFor: string | null };
export type ComputerView = {
  endpointId: string; businessId?: string; businessName?: string | null; siteTimezone?: string | null;
  own: SettingView | null; effective: (SettingView & { source: string }) | null; patchPolicy: string | null;
  notInForce: (SettingView & { source: string })[]; restartPending: boolean | null; text: string; attempts: Attempt[];
  may: { edit: boolean; reason: string | null }; readiness: Readiness; approval?: { mode: 'direct' | 'signed' } | null;
};

const RULE_LABEL: Record<Rule, string> = {
  if_required: 'Restart if Windows needs it',
  always: 'Restart every time the window opens (maintenance restart)',
};
const errMessage = (e: unknown) => (e as { response?: { data?: { message?: string } } })?.response?.data?.message ?? 'The request failed.';

function draftFrom(w: PolicyWindowInput | null | undefined, tz: string | null | undefined): WindowDraft {
  const d = defaultWindowDraft();
  if (!w) return { ...d, days: new Set(['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat']), start: '02:00', end: '04:00', timezone: tz || d.timezone };
  if ('days' in w) return { ...d, kind: 'weekly', days: new Set(w.days), start: w.start, end: w.end, timezone: w.timezone };
  if ('day' in w) return { ...d, kind: 'monthly', monthly: 'day', day: w.day, start: w.start, end: w.end, timezone: w.timezone };
  return { ...d, kind: 'monthly', monthly: 'weekday', week: w.week, weekday: w.weekday, offsetDays: w.offsetDays, start: w.start, end: w.end, timezone: w.timezone };
}

/** A policy's state in words, with "Waiting for approval" said plainly. */
function StatusBadge({ p, inForce }: { p: PolicyView | null; inForce: boolean }) {
  if (!p) return <Badge variant="destructive">Gone</Badge>;
  if (p.status === 'AWAITING_APPROVAL') return <Badge variant="warning" data-testid="restart-window-waiting">Waiting for approval</Badge>;
  if (p.status === 'ACTIVE' && p.paused) return <Badge variant="secondary">Paused</Badge>;
  if (p.status === 'ACTIVE' && inForce) return <Badge variant="success">In force{p.direct ? ' (direct mode)' : ''}</Badge>;
  return <Badge variant="destructive">{p.status === 'ACTIVE' ? 'Expired' : p.status.toLowerCase().replace(/_/g, ' ')}</Badge>;
}

function PolicySummary({ p, testid }: { p: PolicyView; testid: string }) {
  const tz = p.window?.timezone ?? 'UTC';
  return (
    <div className="space-y-1 text-xs" data-testid={testid}>
      <p><span className="font-medium">{RULE_LABEL[p.rule]}</span>, {p.description}.</p>
      {p.ignoreRemoteSession && <p className="text-amber-700 dark:text-amber-400">{IGNORE_REMOTE_SESSION_LABEL}.</p>}
      {p.nextWindow && <p><span className="text-muted-foreground">Next window:</span> <strong>{describeOccurrence(p.nextWindow, tz)}</strong></p>}
      {p.status === 'AWAITING_APPROVAL' && (
        <p className="text-amber-700 dark:text-amber-400">
          Waiting for approval on the approval signer ({p.approvals} of 2 passkey approvals). Until then it restarts nothing.
          {p.approvalUrl && <> <a className="underline" href={p.approvalUrl} target="_blank" rel="noopener noreferrer">Open the approval page</a>.</>}
        </p>
      )}
      <p className="text-muted-foreground">Set by {p.setBy}{p.expiresAt ? ` · set before 0.63, so it expires ${new Date(p.expiresAt).toLocaleDateString()}; Change → Save sets it again without an expiry` : ''}.</p>
      {p.lastNote && <p className="text-amber-700 dark:text-amber-400">{p.lastNote.message}</p>}
    </div>
  );
}

/** The editor: a rule, a window, and the RustDesk exception (never ticked by default). */
function WindowForm({ id, initial, tz, zones, allowOff, priority, onSave, onCancel, busy, ask, direct }: {
  id: string; initial: PolicyView | null; tz: string | null | undefined; zones?: string[]; allowOff: boolean; priority?: number | null;
  onSave: (b: RestartWindowBody) => void; onCancel: () => void; busy: boolean; ask: boolean; direct: boolean;
}) {
  const [mode, setMode] = useState<'window' | 'off'>('window');
  const [rule, setRule] = useState<Rule>(initial?.rule ?? 'if_required');
  const [draft, setDraft] = useState<WindowDraft>(() => draftFrom(initial?.window, tz));
  const [ignore, setIgnore] = useState(initial?.ignoreRemoteSession ?? false);
  const [prio, setPrio] = useState<string>(priority ? String(priority) : '');
  const ready = mode === 'off' || draftReady(draft);
  const save = () => {
    const p = prio.trim() ? { priority: Math.trunc(Number(prio)) } : {};
    if (mode === 'off') onSave({ mode: 'off', ...p });
    else onSave({ mode: 'window', rule, window: windowFromDraft(draft), ...(ignore ? { ignoreRemoteSession: true as const } : {}), ...p });
  };
  return (
    <div className="space-y-3 rounded-md border p-3" data-testid={`${id}-form`}>
      {allowOff && (
        <div className="flex flex-wrap gap-4 text-xs">
          <label className="flex items-center gap-1.5"><input type="radio" name={`${id}-mode`} checked={mode === 'window'} onChange={() => setMode('window')} />A restart window</label>
          <label className="flex items-center gap-1.5"><input type="radio" name={`${id}-mode`} checked={mode === 'off'} onChange={() => setMode('off')} data-testid={`${id}-off`} />No automatic restarts</label>
        </div>
      )}
      {mode === 'window' ? (
        <>
          <div className="space-y-1">
            <label className="text-xs font-medium" htmlFor={`${id}-rule`}>When</label>
            <select id={`${id}-rule`} className="w-full rounded-md border bg-background p-2 text-xs md:w-[28rem]" value={rule} onChange={(e) => setRule(e.target.value as Rule)} data-testid={`${id}-rule`}>
              <option value="if_required">{RULE_LABEL.if_required}</option>
              <option value="always">{RULE_LABEL.always}</option>
            </select>
          </div>
          <WindowEditor id={id} value={draft} onChange={setDraft} title="Restart window" />
          {zones && zones.length > 0 && (
            <p className="text-xs text-muted-foreground">Site time zones: {zones.map((z) => <button key={z} type="button" className="underline mr-2" onClick={() => setDraft({ ...draft, timezone: z })}>{z}</button>)}</p>
          )}
          <label className="flex items-start gap-2 text-xs">
            <input type="checkbox" checked={ignore} onChange={(e) => setIgnore(e.target.checked)} data-testid={`${id}-ignore-remote`} />
            <span>{IGNORE_REMOTE_SESSION_LABEL}</span>
          </label>
          <p className="text-xs text-muted-foreground">
            The computer warns for 15 minutes, then restarts; the restart always falls inside the window. {SIGNED_IN_USER_NOTE}{' '}
            {ignore ? '' : 'While a technician is connected through RustDesk it waits, and is tried again 15 minutes later and in the next window.'}
          </p>
        </>
      ) : (
        <p className="text-xs text-muted-foreground">Nothing restarts these computers automatically, whatever is set above them. Takes effect at once.</p>
      )}
      {priority !== undefined && (
        <div className="space-y-1">
          <label className="text-xs font-medium" htmlFor={`${id}-priority`}>Priority (1 wins over 2 when a computer is in two groups)</label>
          <input id={`${id}-priority`} type="number" min={1} max={999} className="h-8 w-24 rounded-md border bg-background px-2 text-xs block" value={prio} onChange={(e) => setPrio(e.target.value)} placeholder="next" />
        </div>
      )}
      <div className="flex gap-2">
        <Button size="sm" disabled={!ready || busy} onClick={save} data-testid={`${id}-save`}>{mode === 'window' && ask ? 'Save (confirm it is you)' : 'Save'}</Button>
        <Button size="sm" variant="outline" onClick={onCancel} disabled={busy}>Cancel</Button>
      </div>
      {mode === 'window' && (direct
        ? <p className="text-xs text-muted-foreground" data-testid={`${id}-direct-note`}>Direct mode is on for this business: the window is in force as soon as you save it.</p>
        : <p className="text-xs text-muted-foreground" data-testid={`${id}-approval-note`}>Unless the business uses direct mode, a window is approved by two people with passkeys on the approval signer before it restarts anything. A change replaces the window in force only once it is approved.</p>)}
    </div>
  );
}

function SettingBlock({ s, label, editable, ask, direct, tz, zones, onSave, onClear, busy, testid }: {
  s: SettingView | null; label: string; editable: boolean; ask: boolean; direct: boolean; tz?: string | null; zones?: string[];
  onSave: (b: RestartWindowBody) => void; onClear?: () => void; busy: boolean; testid: string;
}) {
  const [editing, setEditing] = useState(false);
  const allowOff = s?.scope !== 'business' && !testid.endsWith('business');
  return (
    <div className="space-y-2 border-b pb-3 last:border-0" data-testid={testid}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-medium">{label}</span>
        {s?.mode === 'off' && <Badge variant="secondary">No automatic restarts</Badge>}
        {s?.mode === 'window' && <StatusBadge p={s.window} inForce={s.inForce} />}
        {s?.scope === 'group' && s.priority !== null && <span className="text-xs text-muted-foreground">priority {s.priority}</span>}
        {!s && <span className="text-xs text-muted-foreground">Not set</span>}
      </div>
      {s?.mode === 'window' && s.window && <PolicySummary p={s.window} testid={`${testid}-summary`} />}
      {s?.mode === 'window' && !s.inForce && s.notInForceBecause && s.window?.status !== 'AWAITING_APPROVAL' && <p className="text-xs text-destructive">Not in force: {s.notInForceBecause}.</p>}
      {s?.pending && (
        <div className="rounded-md bg-amber-50 dark:bg-amber-950/40 p-2" data-testid={`${testid}-pending`}>
          <p className="text-xs font-medium">A change is waiting for approval — the window above stays in force until it is approved:</p>
          <PolicySummary p={s.pending} testid={`${testid}-pending-summary`} />
        </div>
      )}
      {editable && !editing && (
        <div className="flex gap-2">
          <Button size="sm" variant="outline" onClick={() => setEditing(true)} data-testid={`${testid}-edit`}>{s ? 'Change' : 'Set'}</Button>
          {s && onClear && <Button size="sm" variant="outline" onClick={onClear} disabled={busy} data-testid={`${testid}-clear`}>Remove</Button>}
        </div>
      )}
      {editing && <WindowForm id={`${testid}-f`} initial={s?.window ?? null} tz={tz} zones={zones} allowOff={allowOff} priority={s?.scope === 'group' || testid.includes('group') ? (s?.priority ?? null) : undefined} busy={busy} ask={ask} direct={direct}
        onCancel={() => setEditing(false)} onSave={(b) => { onSave(b); setEditing(false); }} />}
    </div>
  );
}

/** The business page's card: the business's own window, its device groups', and the computers with their own. */
export function BusinessRestartWindowCard({ businessId }: { businessId: string }) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const ask = useAsks('restart.window');
  const [addGroup, setAddGroup] = useState('');
  const { data, isError } = useQuery<BusinessView>({
    queryKey: ['restart-windows', 'business', businessId],
    queryFn: () => restartWindowsApi.business(businessId).then((r) => r.data?.data),
    retry: false, refetchInterval: 30_000,
  });
  // 0.62: in direct mode a window is in force when saved, and the toast says so.
  const direct = data?.approval?.mode === 'direct';
  const done = (what: string, setsWindow = false) => (_r?: unknown, b?: RestartWindowBody | { b: RestartWindowBody } | string) => {
    qc.invalidateQueries({ queryKey: ['restart-windows'] });
    const body = b && typeof b === 'object' && 'b' in b ? b.b : b;
    const active = setsWindow && direct && typeof body === 'object' && body?.mode === 'window';
    toast({ title: active ? 'Saved — active' : 'Saved', description: active ? `${what} It is in force now (direct mode).` : what });
  };
  const fail = (e: unknown) => toast({ title: 'Not saved', description: errMessage(e), variant: 'destructive' });
  const setBiz = useMutation({ mutationFn: (b: RestartWindowBody) => restartWindowsApi.setBusiness(businessId, b), onSuccess: done('The business\'s restart window is set.', true), onError: fail });
  const clearBiz = useMutation({ mutationFn: () => restartWindowsApi.clearBusiness(businessId), onSuccess: done('The business\'s restart window is removed.'), onError: fail });
  const setGrp = useMutation({ mutationFn: ({ g, b }: { g: string; b: RestartWindowBody }) => restartWindowsApi.setGroup(businessId, g, b), onSuccess: done('The group\'s restart setting is saved.', true), onError: fail });
  const clearGrp = useMutation({ mutationFn: (g: string) => restartWindowsApi.clearGroup(businessId, g), onSuccess: done('The group\'s restart setting is removed.'), onError: fail });
  const clearPc = useMutation({ mutationFn: (e: string) => restartWindowsApi.clearComputer(e), onSuccess: done('The computer\'s own restart setting is removed.'), onError: fail });
  if (isError || !data) return null;
  const busy = setBiz.isPending || clearBiz.isPending || setGrp.isPending || clearGrp.isPending || clearPc.isPending;
  const tz = data.siteTimezones[0] ?? null;
  const edit = data.may.edit && !data.readiness.why;
  return (
    <Card data-testid="business-restart-window">
      <CardHeader><CardTitle className="flex items-center gap-2 text-sm"><Power className="h-4 w-4" /> Restart window</CardTitle></CardHeader>
      <CardContent className="space-y-3 text-sm">
        <p className="text-muted-foreground">
          When Windows needs a restart (after updates, usually), a computer is restarted automatically only inside its restart window, with a
          15-minute warning. <span className="font-medium text-foreground">With no window, nothing restarts a computer automatically.</span> A
          computer&apos;s own setting wins over a device group&apos;s, and a group&apos;s over the business&apos;s.
        </p>
        {data.readiness.why && <p className="text-xs text-destructive" data-testid="restart-window-not-ready">{data.readiness.why}</p>}
        {data.contained && <p className="text-xs text-destructive">Containment pauses actions for this business: no restart is asked for until it is lifted.</p>}
        {!data.readiness.sweep.enabled && <p className="text-xs text-amber-700 dark:text-amber-400">This API has the restart-window sweep switched off (RESTART_WINDOW_SWEEP=off): no restart is asked for.</p>}
        <SettingBlock s={data.business} label={`Business — ${data.businessName}`} editable={edit} ask={ask} direct={direct} tz={tz} zones={data.siteTimezones} busy={busy} testid="restart-window-business"
          onSave={(b) => setBiz.mutate(b)} onClear={() => clearBiz.mutate()} />
        {data.groups.map((g) => (
          <SettingBlock key={g.id} s={g} label={`Device group — ${g.groupName ?? g.groupId}`} editable={edit} ask={ask} direct={direct} tz={tz} zones={data.siteTimezones} busy={busy} testid={`restart-window-group-${g.groupId}`}
            onSave={(b) => setGrp.mutate({ g: g.groupId!, b })} onClear={() => clearGrp.mutate(g.groupId!)} />
        ))}
        {edit && data.availableGroups.length > 0 && (
          <div className="space-y-2">
            <div className="flex items-center gap-2 text-xs">
              <label htmlFor="restart-window-add-group">Set one for a device group:</label>
              <select id="restart-window-add-group" className="rounded-md border bg-background p-1 text-xs" value={addGroup} onChange={(e) => setAddGroup(e.target.value)} data-testid="restart-window-add-group">
                <option value="">Choose…</option>
                {data.availableGroups.map((g) => <option key={g.id} value={g.id}>{g.name}{g.kind === 'rule' ? ' (rule)' : ''}</option>)}
              </select>
            </div>
            {addGroup && <SettingBlock key={addGroup} s={null} label={`Device group — ${data.availableGroups.find((g) => g.id === addGroup)?.name ?? ''}`} editable ask={ask} direct={direct} tz={tz} zones={data.siteTimezones} busy={busy} testid={`restart-window-group-new-${addGroup}`}
              onSave={(b) => { setGrp.mutate({ g: addGroup, b }); setAddGroup(''); }} />}
          </div>
        )}
        {data.computers.length > 0 && (
          <div className="space-y-1" data-testid="restart-window-computers">
            <p className="text-xs font-medium">Computers with their own setting</p>
            <ul className="space-y-1 text-xs">
              {data.computers.map((c) => (
                <li key={c.id} className="flex flex-wrap items-center gap-2">
                  <Link className="underline" href={`/endpoints/${c.endpointId}?tab=patches`}>{c.computer ?? c.endpointId}</Link>
                  {c.mode === 'off' ? <Badge variant="secondary">No automatic restarts</Badge> : <><StatusBadge p={c.window} inForce={c.inForce} />{c.window && <span className="text-muted-foreground">{c.window.description}</span>}</>}
                  {edit && <Button size="sm" variant="ghost" className="h-6 text-xs" onClick={() => clearPc.mutate(c.endpointId!)} disabled={busy}>Inherit</Button>}
                </li>
              ))}
            </ul>
          </div>
        )}
        <p className="text-xs text-muted-foreground">
          Last 7 days: {data.attemptsLast7Days.asked} restart{data.attemptsLast7Days.asked === 1 ? '' : 's'} asked for, {data.attemptsLast7Days.signed} signed, {data.attemptsLast7Days.refused} refused.{' '}
          {ask ? 'Setting a window, or removing a group\'s setting, asks you to confirm it is you; "No automatic restarts" and removing the business\'s window do not.' : ''}{' '}
          <Link className="underline" href="/docs/restart-windows">How restart windows work</Link>
        </p>
        {!data.may.edit && data.may.reason && <p className="text-xs text-muted-foreground">{data.may.reason}</p>}
      </CardContent>
    </Card>
  );
}

/** Whether, and when, this computer is restarted automatically — one sentence, for the Patches tab's banner. */
export function useComputerRestartWindow(endpointId: string) {
  return useQuery<ComputerView>({
    queryKey: ['restart-windows', 'computer', endpointId],
    queryFn: () => restartWindowsApi.computer(endpointId).then((r) => r.data?.data),
    retry: false, refetchInterval: 30_000,
  });
}

/** The computer's card: what governs it and where from, its own override, and what happened lately. */
export function ComputerRestartWindowCard({ endpointId }: { endpointId: string }) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const ask = useAsks('restart.window');
  const { data, isError } = useComputerRestartWindow(endpointId);
  // 0.62: in direct mode a window is in force when saved, and the toast says so.
  const direct = data?.approval?.mode === 'direct';
  const done = (what: string, setsWindow = false) => (_r?: unknown, b?: RestartWindowBody | { b: RestartWindowBody } | string) => {
    qc.invalidateQueries({ queryKey: ['restart-windows'] });
    const body = b && typeof b === 'object' && 'b' in b ? b.b : b;
    const active = setsWindow && direct && typeof body === 'object' && body?.mode === 'window';
    toast({ title: active ? 'Saved — active' : 'Saved', description: active ? `${what} It is in force now (direct mode).` : what });
  };
  const fail = (e: unknown) => toast({ title: 'Not saved', description: errMessage(e), variant: 'destructive' });
  const set = useMutation({ mutationFn: (b: RestartWindowBody) => restartWindowsApi.setComputer(endpointId, b), onSuccess: done('This computer\'s restart setting is saved.', true), onError: fail });
  const clear = useMutation({ mutationFn: () => restartWindowsApi.clearComputer(endpointId), onSuccess: done('This computer now inherits its restart window.'), onError: fail });
  if (isError || !data) return null;
  const eff = data.effective;
  return (
    <Card data-testid="endpoint-restart-window">
      <CardHeader><CardTitle className="flex items-center gap-2 text-sm"><Power className="h-4 w-4" /> Restart window</CardTitle></CardHeader>
      <CardContent className="space-y-3 text-sm">
        <p data-testid="endpoint-restart-window-text">{data.text}</p>
        {eff && (
          <div className="text-xs space-y-1" data-testid="endpoint-restart-window-effective">
            <p><span className="text-muted-foreground">Governed by:</span> <span className="font-medium">{eff.source}</span>{' '}
              {eff.mode === 'off' ? <Badge variant="secondary">No automatic restarts</Badge> : <StatusBadge p={eff.window} inForce={eff.inForce} />}</p>
            {eff.mode === 'window' && eff.window && <PolicySummary p={eff.window} testid="endpoint-restart-window-summary" />}
          </div>
        )}
        {!eff && <p className="text-xs" data-testid="endpoint-restart-window-none"><span className="font-medium">None</span> — this computer is never restarted automatically.</p>}
        {data.notInForce.map((s) => (
          <p key={s.id} className="text-xs text-amber-700 dark:text-amber-400" data-testid="endpoint-restart-window-not-in-force">
            {s.source}: {s.window?.status === 'AWAITING_APPROVAL' ? 'waiting for approval on the approval signer — it governs this computer once approved' : `not in force — ${s.notInForceBecause}`}.
            {s.window?.approvalUrl && s.window.status === 'AWAITING_APPROVAL' && <> <a className="underline" href={s.window.approvalUrl} target="_blank" rel="noopener noreferrer">Approval page</a>.</>}
          </p>
        ))}
        {data.readiness.why && <p className="text-xs text-destructive">{data.readiness.why}</p>}
        <SettingBlock s={data.own} label="This computer's own setting" editable={data.may.edit && !data.readiness.why} ask={ask} direct={direct} tz={data.siteTimezone} busy={set.isPending || clear.isPending}
          testid="endpoint-restart-window-own" onSave={(b) => set.mutate(b)} onClear={() => clear.mutate()} />
        {data.attempts.length > 0 && (
          <div className="space-y-1" data-testid="endpoint-restart-window-attempts">
            <p className="text-xs font-medium">Recent automatic restarts</p>
            <ul className="text-xs space-y-0.5">
              {data.attempts.slice(0, 5).map((a) => (
                <li key={`${a.windowKey}-${a.attempt}`}>
                  {new Date(a.at).toLocaleString()} — try {a.attempt}: {a.targetStatus ? `${a.targetStatus.toLowerCase().replace(/_/g, ' ')}${a.reason ? ` (${a.reason})` : ''}` : a.code === 'signed' ? 'signed, waiting for the computer' : `${a.code}: ${a.message}`}
                  {a.jobId && <> · <Link className="underline" href={`/endpoints/${endpointId}?tab=actions`}>plan</Link></>}
                </li>
              ))}
            </ul>
          </div>
        )}
        {!data.may.edit && data.may.reason && <p className="text-xs text-muted-foreground">{data.may.reason}</p>}
      </CardContent>
    </Card>
  );
}

/** The "restart required" banners' one sentence: whether, and when, this computer restarts on its own. */
export function RestartWindowSentence({ endpointId, className }: { endpointId: string; className?: string }) {
  const { data } = useComputerRestartWindow(endpointId);
  if (!data) return null;
  return <p className={className ?? 'text-xs'} data-testid="restart-window-sentence">{data.text}</p>;
}
