'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, BellOff, Plus, Sparkles, Trash2 } from 'lucide-react';
import { businessesApi, emailApi, monitoringApi, type EmailRecipientView, type MonitorKindId, type Severity } from '@/lib/api-client';
import { EmailOffNotice, RecipientsCard } from '@/components/email/recipients-card';
import { usePermissions } from '@/lib/auth';
import { PageHeader } from '@/components/common/page-header';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { apiError } from '@/components/security-controls/shared';

/**
 * Settings → Monitoring (0.29).
 *
 * Monitors are inherited global → business → site → computer; the most
 * specific monitor with a given key wins, and a disabled one switches the
 * inherited monitor off there. Maintenance windows hold notifications (the
 * alert is still recorded) and are unrelated to containment, which stops
 * writes. Who is notified needs fresh authentication to change.
 */

type Rule = {
  id: string; scopeKey: string; scope: 'global' | 'business' | 'site' | 'endpoint'; businessId: string | null; siteId: string | null; endpointId: string | null;
  key: string; kind: MonitorKindId; name: string; enabled: boolean; severity: Severity; params: Record<string, unknown>; updatedAt: string;
};
type Rules = { rules: Rule[]; recommended: { key: string; kind: MonitorKindId; name: string; severity: Severity; params: Record<string, unknown> }[]; may: { global: boolean; business: boolean } };
type Window = { id: string; scopeKey: string; ruleKeys: string[]; reason: string; startsAt: string; endsAt: string; revokedAt: string | null; active: boolean };
/** A webhook, or (0.34) a confirmed email recipient. `email`/`confirmed` come back from the server for display only. */
type Dest = { label: string; url: string } | { label: string; recipientId: string; email?: string | null; confirmed?: boolean };
type Level = { afterMinutes: number; minSeverity: Severity; destinations: Dest[] };
const isEmailHint = (l: Level) => l.destinations.some((d) => 'recipientId' in d);
const isEmail = (d: Dest): d is { label: string; recipientId: string; email?: string | null; confirmed?: boolean } => 'recipientId' in d;
/** What the API accepts: the display-only fields are dropped. */
const wire = (d: Dest) => (isEmail(d) ? { label: d.label, recipientId: d.recipientId } : { label: d.label, url: d.url });
type PolicyView = { scopeKey: string; levels: Level[]; ticketing: { enabled: boolean; minSeverity: Severity }; updatedAt: string };
type Policy = { global: PolicyView | null; business: PolicyView | null; effective: 'business' | 'global' | 'none'; may: { global: boolean; business: boolean } };

const SEVERITIES: Severity[] = ['INFO', 'WARNING', 'CRITICAL'];
const EVENT_LOGS = ['System', 'Application', 'Security', 'Setup'];

/** Form fields per monitor kind. Validation is the server's; this only shapes the input. */
const KIND: Record<MonitorKindId, { label: string; hint: string; fields: { k: string; label: string; type: 'int' | 'text' | 'bool' | 'list' | 'log'; def: unknown }[] }> = {
  OFFLINE: { label: 'Computer offline', hint: 'No heartbeat for this long.', fields: [{ k: 'minutes', label: 'Minutes without a heartbeat', type: 'int', def: 15 }] },
  DISK_FREE: { label: 'Disk space', hint: 'The system disk below this much free.', fields: [{ k: 'minFreePercent', label: 'Minimum free %', type: 'int', def: 10 }] },
  CPU_HIGH: { label: 'Processor busy', hint: 'Above this for several heartbeats in a row.', fields: [{ k: 'percent', label: 'Percent', type: 'int', def: 95 }, { k: 'samples', label: 'Heartbeats in a row', type: 'int', def: 5 }] },
  MEMORY_HIGH: { label: 'Memory used', hint: 'Above this for several heartbeats in a row.', fields: [{ k: 'percent', label: 'Percent', type: 'int', def: 95 }, { k: 'samples', label: 'Heartbeats in a row', type: 'int', def: 5 }] },
  SERVICE_STOPPED: {
    label: 'Windows service stopped', hint: 'The agent reports this service each heartbeat.',
    fields: [{ k: 'service', label: 'Service name (e.g. Spooler)', type: 'text', def: '' }, { k: 'alertIfMissing', label: 'Alert if it is not installed', type: 'bool', def: false }, { k: 'ignoreDisabled', label: 'Ignore it when disabled', type: 'bool', def: true }],
  },
  EVENT_MATCH: {
    label: 'Event log match', hint: 'Matching events since the last report. Name at least one of IDs, levels or provider.',
    fields: [
      { k: 'log', label: 'Log', type: 'log', def: 'System' }, { k: 'ids', label: 'Event IDs (comma-separated)', type: 'list', def: [] },
      { k: 'levels', label: 'Levels (1 critical, 2 error, 3 warning)', type: 'list', def: [] }, { k: 'provider', label: 'Provider (optional)', type: 'text', def: '' },
      { k: 'threshold', label: 'Events before alerting', type: 'int', def: 1 }, { k: 'clearAfterMinutes', label: 'Clear after minutes quiet', type: 'int', def: 60 },
    ],
  },
  REBOOT_PENDING: { label: 'Restart pending', hint: 'Windows has wanted a restart for this long.', fields: [{ k: 'hours', label: 'Hours', type: 'int', def: 72 }] },
};

const fmt = (d: string | null | undefined) => (d ? new Date(d).toLocaleString() : '—');
const scopeLabel = (r: { scope: string }) => ({ global: 'Global', business: 'Business', site: 'Site', endpoint: 'Computer' } as Record<string, string>)[r.scope] ?? r.scope;
const paramsText = (p: Record<string, unknown>) => Object.entries(p).filter(([, v]) => v !== '' && !(Array.isArray(v) && v.length === 0)).map(([k, v]) => `${k}=${Array.isArray(v) ? v.join(',') : String(v)}`).join(' · ');

function Notice({ n }: { n: { ok: boolean; text: string } | null }) {
  if (!n) return null;
  return <div className={`rounded-md border p-3 text-sm ${n.ok ? 'border-emerald-300 bg-emerald-50 text-emerald-900 dark:bg-emerald-950 dark:text-emerald-100' : 'border-destructive/40 bg-destructive/10 text-destructive'}`}>{n.text}</div>;
}

export default function MonitoringSettingsPage() {
  const { user, isPlatformAdmin, canManageTechnicians, technician, businessId: ownBusiness } = usePermissions();
  const msp = (isPlatformAdmin || canManageTechnicians) && !technician;
  const [picked, setPicked] = useState('');
  // ?businessId= opens one business's policies (Add device links here). Read
  // after mount so the page still prerenders; only meaningful to someone who
  // may pick a business at all, and the server re-checks the choice.
  useEffect(() => {
    const b = new URLSearchParams(window.location.search).get('businessId');
    if (b && /^[a-z0-9]{10,40}$/.test(b)) setPicked(b);
  }, []);
  const businessId = ownBusiness ?? (picked || null);
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null);
  const fail = (e: unknown) => setNotice({ ok: false, text: apiError(e).message });
  const ok = (text: string) => setNotice({ ok: true, text });

  const { data: businesses } = useQuery<{ id: string; name: string }[]>({
    queryKey: ['businesses-for-monitoring'],
    queryFn: () => businessesApi.list().then((r) => ((r.data as { data?: { id: string; name: string }[] })?.data ?? [])),
    enabled: msp && !ownBusiness,
  });

  if (!user) return null;
  return (
    <div className="space-y-4 p-4 md:p-6">
      <Link href="/settings" className="inline-flex items-center text-sm text-muted-foreground hover:underline">
        <ArrowLeft className="mr-1 h-4 w-4" />Settings
      </Link>
      <PageHeader
        title="Monitoring"
        description="What is watched, when alerts stay quiet, and who is told. Nothing here changes a computer — monitors only read what the agent already reports."
        actions={<Button variant="outline" asChild><Link href="/alerts">Open alerts</Link></Button>}
      />
      {msp && !ownBusiness && (
        <div className="space-y-1">
          <Label htmlFor="mon-business">Business</Label>
          <select id="mon-business" className="w-full rounded-md border bg-background p-2 text-sm md:w-96" value={picked} onChange={(e) => { setPicked(e.target.value); setNotice(null); }}>
            <option value="">Global (every business)</option>
            {(businesses ?? []).map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
          </select>
        </div>
      )}
      <Notice n={notice} />
      <Tabs defaultValue="monitors">
        <TabsList>
          <TabsTrigger value="monitors">Monitors</TabsTrigger>
          <TabsTrigger value="windows">Maintenance windows</TabsTrigger>
          <TabsTrigger value="notify">Notifications</TabsTrigger>
        </TabsList>
        <TabsContent value="monitors"><Monitors businessId={businessId} ok={ok} fail={fail} /></TabsContent>
        <TabsContent value="windows"><Windows businessId={businessId} ok={ok} fail={fail} /></TabsContent>
        <TabsContent value="notify" className="space-y-4">
          <Notify businessId={businessId} ok={ok} fail={fail} />
          <RecipientsCard scope={businessId ? 'business' : 'global'} businessId={businessId} ok={ok} fail={fail} />
        </TabsContent>
      </Tabs>
    </div>
  );
}

type Props = { businessId: string | null; ok: (t: string) => void; fail: (e: unknown) => void };

function ParamFields({ kind, value, onChange }: { kind: MonitorKindId; value: Record<string, unknown>; onChange: (v: Record<string, unknown>) => void }) {
  return (
    <div className="grid gap-2 md:grid-cols-3">
      {KIND[kind].fields.map((f) => {
        const v = value[f.k] ?? f.def;
        const set = (x: unknown) => onChange({ ...value, [f.k]: x });
        if (f.type === 'bool') return <label key={f.k} className="flex items-center gap-2 text-sm"><input type="checkbox" checked={!!v} onChange={(e) => set(e.target.checked)} />{f.label}</label>;
        if (f.type === 'log') return (
          <div key={f.k} className="space-y-1"><Label>{f.label}</Label>
            <select className="w-full rounded-md border bg-background p-2 text-sm" value={String(v)} onChange={(e) => set(e.target.value)}>{EVENT_LOGS.map((l) => <option key={l}>{l}</option>)}</select>
          </div>
        );
        return (
          <div key={f.k} className="space-y-1"><Label>{f.label}</Label>
            <Input value={Array.isArray(v) ? v.join(',') : String(v ?? '')} inputMode={f.type === 'int' || f.type === 'list' ? 'numeric' : undefined}
              onChange={(e) => set(f.type === 'int' ? (e.target.value === '' ? '' : Number(e.target.value)) : f.type === 'list' ? e.target.value.split(/[,\s]+/).filter(Boolean).map(Number) : e.target.value)} />
          </div>
        );
      })}
    </div>
  );
}
const clean = (p: Record<string, unknown>) => Object.fromEntries(Object.entries(p).filter(([, v]) => v !== ''));
const defaults = (k: MonitorKindId) => Object.fromEntries(KIND[k].fields.map((f) => [f.k, f.def]));

function Monitors({ businessId, ok, fail }: Props) {
  const qc = useQueryClient();
  const { data, error } = useQuery<Rules>({ queryKey: ['mon-rules', businessId], queryFn: () => monitoringApi.rules(businessId).then((r) => r.data.data), retry: false });
  const refresh = () => qc.invalidateQueries({ queryKey: ['mon-rules'] });
  const atScope: 'global' | 'business' = businessId ? 'business' : 'global';
  const mayHere = !!data && (atScope === 'global' ? data.may.global : data.may.business);

  const [adding, setAdding] = useState(false);
  const [kind, setKind] = useState<MonitorKindId>('SERVICE_STOPPED');
  const [key, setKey] = useState(''); const [name, setName] = useState('');
  const [severity, setSeverity] = useState<Severity>('WARNING');
  const [params, setParams] = useState<Record<string, unknown>>(defaults('SERVICE_STOPPED'));
  const [editing, setEditing] = useState<string | null>(null);
  const [editParams, setEditParams] = useState<Record<string, unknown>>({});

  const create = useMutation({
    mutationFn: () => monitoringApi.createRule({ scope: atScope, ...(businessId ? { businessId } : {}), key, kind, name, severity, params: clean(params) }),
    onSuccess: () => { ok(`Monitor “${name}” added.`); setAdding(false); setKey(''); setName(''); refresh(); }, onError: fail,
  });
  const recommended = useMutation({
    mutationFn: () => monitoringApi.addRecommended(atScope, businessId ?? undefined).then((r) => r.data.data as { added: unknown[] }),
    onSuccess: (r) => { ok(r.added.length ? `Added ${r.added.length} recommended monitors.` : 'The recommended monitors are all here already.'); refresh(); }, onError: fail,
  });
  const update = useMutation({
    mutationFn: (v: { id: string; data: Parameters<typeof monitoringApi.updateRule>[1] }) => monitoringApi.updateRule(v.id, v.data),
    onSuccess: () => { ok('Saved.'); setEditing(null); refresh(); }, onError: fail,
  });
  const remove = useMutation({ mutationFn: (id: string) => monitoringApi.deleteRule(id), onSuccess: () => { ok('Removed.'); refresh(); }, onError: fail });
  const override = useMutation({
    mutationFn: (r: Rule) => monitoringApi.createRule({ scope: 'business', businessId: businessId!, key: r.key, kind: r.kind, name: r.name, severity: r.severity, enabled: false, params: r.params }),
    onSuccess: () => { ok('Switched off for this business (an override with the same key).'); refresh(); }, onError: fail,
  });

  if (error) return <p className="p-4 text-sm text-muted-foreground">{apiError(error).message}</p>;
  if (!data) return <p className="p-4 text-sm text-muted-foreground">Loading…</p>;
  const shown = data.rules.filter((r) => (businessId ? true : r.scope === 'global'));
  const overridden = new Set(data.rules.filter((r) => r.scope === 'business').map((r) => r.key));

  return (
    <Card data-testid="mon-rules">
      <CardHeader className="flex flex-row items-center justify-between space-y-0">
        <CardTitle className="text-sm">Monitors {businessId ? 'for this business (and inherited)' : '— global, inherited by every business'}</CardTitle>
        {mayHere && (
          <div className="flex gap-2">
            <Button size="sm" variant="outline" disabled={recommended.isPending} onClick={() => recommended.mutate()}><Sparkles className="mr-1 h-4 w-4" />Add recommended</Button>
            <Button size="sm" onClick={() => setAdding((x) => !x)}><Plus className="mr-1 h-4 w-4" />New monitor</Button>
          </div>
        )}
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        {!mayHere && <p className="text-muted-foreground">You can see these but not change them{atScope === 'global' ? ' — global monitors are set by the MSP' : ' — that needs monitoring:configure for the whole business'}.</p>}
        {adding && (
          <div className="space-y-3 rounded-md border p-3" data-testid="mon-new">
            <div className="grid gap-2 md:grid-cols-4">
              <div className="space-y-1"><Label>Kind</Label>
                <select className="w-full rounded-md border bg-background p-2" value={kind} onChange={(e) => { const k = e.target.value as MonitorKindId; setKind(k); setParams(defaults(k)); }}>
                  {(Object.keys(KIND) as MonitorKindId[]).map((k) => <option key={k} value={k}>{KIND[k].label}</option>)}
                </select>
              </div>
              <div className="space-y-1"><Label>Key</Label><Input value={key} placeholder="e.g. spooler" onChange={(e) => setKey(e.target.value.toLowerCase())} /></div>
              <div className="space-y-1"><Label>Name</Label><Input value={name} placeholder="Print Spooler stopped" onChange={(e) => setName(e.target.value)} /></div>
              <div className="space-y-1"><Label>Severity</Label>
                <select className="w-full rounded-md border bg-background p-2" value={severity} onChange={(e) => setSeverity(e.target.value as Severity)}>{SEVERITIES.map((s) => <option key={s}>{s}</option>)}</select>
              </div>
            </div>
            <p className="text-xs text-muted-foreground">{KIND[kind].hint} The key is how inheritance works: a monitor here with the key of an inherited one replaces it.</p>
            <ParamFields kind={kind} value={params} onChange={setParams} />
            <Button size="sm" disabled={!key || !name || create.isPending} onClick={() => create.mutate()}>Add monitor</Button>
          </div>
        )}
        {shown.length === 0 && <p className="text-muted-foreground">No monitors yet. {mayHere ? '“Add recommended” sets up offline, disk, CPU, memory, restart-pending and disk-error monitors you can then adjust.' : ''}</p>}
        <div className="divide-y rounded-md border">
          {shown.map((r) => (
            <div key={r.id} className="p-3">
              <div className="flex flex-wrap items-center gap-2">
                <Badge variant="outline">{scopeLabel(r)}</Badge>
                <span className={`font-medium ${r.enabled ? '' : 'text-muted-foreground line-through'}`}>{r.name}</span>
                <code className="text-xs text-muted-foreground">{r.key}</code>
                <Badge variant="secondary">{r.severity.toLowerCase()}</Badge>
                {!r.enabled && <Badge variant="outline">off here</Badge>}
                {businessId && r.scope === 'global' && overridden.has(r.key) && <Badge variant="outline">overridden below</Badge>}
                <span className="text-xs text-muted-foreground">{KIND[r.kind]?.label} · {paramsText(r.params)}</span>
                <div className="ml-auto flex gap-1">
                  {((r.scope === 'global' && data.may.global && !businessId) || (r.scope !== 'global' && data.may.business)) && (
                    <>
                      <Button size="sm" variant="ghost" onClick={() => update.mutate({ id: r.id, data: { enabled: !r.enabled } })}>{r.enabled ? 'Switch off' : 'Switch on'}</Button>
                      <Button size="sm" variant="ghost" onClick={() => { setEditing(editing === r.id ? null : r.id); setEditParams(r.params); }}>Edit</Button>
                      <Button size="sm" variant="ghost" onClick={() => { if (window.confirm(`Remove “${r.name}”?${r.scope === 'global' ? '' : ' The inherited monitor with this key, if any, applies again.'}`)) remove.mutate(r.id); }}><Trash2 className="h-4 w-4" /></Button>
                    </>
                  )}
                  {businessId && r.scope === 'global' && !overridden.has(r.key) && data.may.business && (
                    <Button size="sm" variant="ghost" onClick={() => override.mutate(r)}>Switch off for this business</Button>
                  )}
                </div>
              </div>
              {editing === r.id && (
                <div className="mt-2 space-y-2">
                  <ParamFields kind={r.kind} value={editParams} onChange={setEditParams} />
                  <div className="flex gap-2">
                    <select className="rounded-md border bg-background p-1 text-sm" defaultValue={r.severity} id={`sev-${r.id}`}>{SEVERITIES.map((s) => <option key={s}>{s}</option>)}</select>
                    <Button size="sm" onClick={() => update.mutate({ id: r.id, data: { params: clean(editParams), severity: (document.getElementById(`sev-${r.id}`) as HTMLSelectElement).value as Severity } })}>Save</Button>
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

function Windows({ businessId, ok, fail }: Props) {
  const qc = useQueryClient();
  const { data, error } = useQuery<Window[]>({ queryKey: ['mon-windows', businessId], queryFn: () => monitoringApi.suppressions(businessId).then((r) => r.data.data), retry: false });
  const refresh = () => { qc.invalidateQueries({ queryKey: ['mon-windows'] }); qc.invalidateQueries({ queryKey: ['alerts'] }); };
  const [reason, setReason] = useState(''); const [hours, setHours] = useState(2); const [keys, setKeys] = useState('');
  const [startsAt, setStartsAt] = useState('');
  const create = useMutation({
    mutationFn: () => {
      const start = startsAt ? new Date(startsAt) : new Date();
      return monitoringApi.createSuppression({
        scope: businessId ? 'business' : 'global', ...(businessId ? { businessId } : {}),
        ruleKeys: keys.split(/[,\s]+/).filter(Boolean), reason,
        ...(startsAt ? { startsAt: start.toISOString() } : {}), endsAt: new Date(start.getTime() + hours * 3_600_000).toISOString(),
      });
    },
    onSuccess: () => { ok('Maintenance window set. Alerts during it are recorded but not notified.'); setReason(''); refresh(); }, onError: fail,
  });
  const revoke = useMutation({ mutationFn: (id: string) => monitoringApi.revokeSuppression(id), onSuccess: () => { ok('Ended. Alerts it held are looked at again now.'); refresh(); }, onError: fail });

  if (error) return <p className="p-4 text-sm text-muted-foreground">{apiError(error).message}</p>;
  return (
    <div className="space-y-4">
      <Card data-testid="mon-window-new">
        <CardHeader><CardTitle className="text-sm">New maintenance window {businessId ? 'for this business' : 'for every business'}</CardTitle></CardHeader>
        <CardContent className="space-y-3 text-sm">
          <p className="text-muted-foreground">
            Holds notifications only. Alerts are still raised and shown here with a <BellOff className="inline h-3 w-3" /> marker, and anything still open when the window ends is notified then.
            This is not containment — to stop changes reaching computers, use Settings → Security → Containment.
          </p>
          <div className="grid gap-2 md:grid-cols-4">
            <div className="space-y-1 md:col-span-2"><Label>Reason</Label><Input value={reason} maxLength={300} placeholder="Server room power work" onChange={(e) => setReason(e.target.value)} /></div>
            <div className="space-y-1"><Label>Starts (blank = now)</Label><Input type="datetime-local" value={startsAt} onChange={(e) => setStartsAt(e.target.value)} /></div>
            <div className="space-y-1"><Label>Hours (max 336)</Label><Input type="number" min={1} max={336} value={hours} onChange={(e) => setHours(Number(e.target.value))} /></div>
          </div>
          <div className="space-y-1"><Label>Only these monitor keys (blank = all)</Label><Input value={keys} placeholder="offline, disk-free" onChange={(e) => setKeys(e.target.value)} /></div>
          <Button size="sm" disabled={reason.trim().length < 3 || !(hours > 0) || create.isPending} onClick={() => create.mutate()}>Set window</Button>
        </CardContent>
      </Card>
      <Card data-testid="mon-windows">
        <CardHeader><CardTitle className="text-sm">Windows (current, upcoming and the last 30 days)</CardTitle></CardHeader>
        <CardContent className="space-y-2 text-sm">
          {data?.length === 0 && <p className="text-muted-foreground">None.</p>}
          {data?.map((w) => (
            <div key={w.id} className="flex flex-wrap items-center gap-2 rounded-md border p-2">
              {w.active ? <Badge>active</Badge> : w.revokedAt ? <Badge variant="outline">ended early</Badge> : new Date(w.startsAt) > new Date() ? <Badge variant="secondary">upcoming</Badge> : <Badge variant="outline">over</Badge>}
              <Badge variant="outline">{w.scopeKey === 'global' ? 'Global' : 'Business'}</Badge>
              <span>{w.reason}</span>
              <span className="text-xs text-muted-foreground">{fmt(w.startsAt)} → {fmt(w.endsAt)}{w.ruleKeys.length ? ` · ${w.ruleKeys.join(', ')}` : ' · all monitors'}</span>
              {!w.revokedAt && new Date(w.endsAt) > new Date() && <Button size="sm" variant="ghost" className="ml-auto" onClick={() => revoke.mutate(w.id)}>End now</Button>}
            </div>
          ))}
        </CardContent>
      </Card>
    </div>
  );
}

function Notify({ businessId, ok, fail }: Props) {
  const qc = useQueryClient();
  const { data, error } = useQuery<Policy>({ queryKey: ['mon-policy', businessId], queryFn: () => monitoringApi.policy(businessId).then((r) => r.data.data), retry: false });
  const scope: 'global' | 'business' = businessId ? 'business' : 'global';
  const current = data ? (scope === 'business' ? data.business : data.global) : null;
  const may = !!data && (scope === 'global' ? data.may.global : data.may.business);
  const [draft, setDraft] = useState<{ levels: Level[]; ticketing: { enabled: boolean; minSeverity: Severity } } | null>(null);
  const edit = draft ?? { levels: current?.levels ?? [], ticketing: current?.ticketing ?? { enabled: false, minSeverity: 'CRITICAL' as Severity } };
  const save = useMutation({
    mutationFn: () => monitoringApi.setPolicy({ scope, ...(businessId ? { businessId } : {}), ticketing: edit.ticketing, levels: edit.levels.map((l) => ({ ...l, destinations: l.destinations.map(wire) })) }),
    onSuccess: () => { ok('Notification policy saved.'); setDraft(null); qc.invalidateQueries({ queryKey: ['mon-policy'] }); }, onError: fail,
  });
  const setLevels = (levels: Level[]) => setDraft({ ...edit, levels });
  const { data: mail } = useQuery<{ enabled: boolean }>({ queryKey: ['email-status'], queryFn: () => emailApi.status().then((r) => r.data.data), retry: false });
  // Confirmed recipients of this policy's scope: the only addresses an email destination may name.
  const { data: book } = useQuery<{ recipients: EmailRecipientView[] }>({
    queryKey: ['email-recipients', scope, businessId], queryFn: () => emailApi.recipients(scope, businessId).then((r) => r.data.data), retry: false, enabled: may,
  });
  const confirmed = (book?.recipients ?? []).filter((r) => r.verified);
  const setDest = (i: number, k: number, d: Dest) => setLevels(edit.levels.map((x, j) => (j === i ? { ...x, destinations: x.destinations.map((y, m) => (m === k ? d : y)) } : x)));

  if (error) return <p className="p-4 text-sm text-muted-foreground">{apiError(error).message}</p>;
  if (!data) return <p className="p-4 text-sm text-muted-foreground">Loading…</p>;
  return (
    <Card data-testid="mon-policy">
      <CardHeader><CardTitle className="text-sm">Who is notified {businessId ? 'for this business' : '— global default'}</CardTitle></CardHeader>
      <CardContent className="space-y-3 text-sm">
        <p className="text-muted-foreground">
          In effect{businessId ? ' here' : ''}: <strong>{data.effective === 'business' ? "this business's own policy" : data.effective === 'global' ? 'the global policy' : 'nothing — alerts are recorded but nobody is notified'}</strong>.
          Each level fires once an alert has been open that many minutes and is not acknowledged. Destinations receive a JSON POST
          (Slack/Teams-style incoming webhooks and ticketing relays work). {businessId ? 'A business destination must be https on a public host name.' : ''}
          {' '}An email destination is one of the confirmed addresses below; the email says only the alert, the computer, the business and a link.
          {' '}Saving asks you to confirm it is you: a destination receives alert text, including computer names.
        </p>
        <EmailOffNotice enabled={mail?.enabled} />
        {!may && <p className="text-muted-foreground">Only {businessId ? 'a Business Owner of this business or the MSP' : 'the MSP'} can change this; addresses are shown shortened.</p>}
        {edit.levels.map((l, i) => (
          <div key={i} className="space-y-2 rounded-md border p-3">
            <strong className="block">Level {i + 1}</strong>
            <div className="flex flex-wrap items-end gap-2">
              <div className="space-y-1"><Label>After minutes</Label><Input className="w-28" type="number" min={0} disabled={!may} value={l.afterMinutes} onChange={(e) => setLevels(edit.levels.map((x, j) => (j === i ? { ...x, afterMinutes: Number(e.target.value) } : x)))} /></div>
              <div className="space-y-1"><Label>At least</Label>
                <select className="rounded-md border bg-background p-2" disabled={!may} value={l.minSeverity} onChange={(e) => setLevels(edit.levels.map((x, j) => (j === i ? { ...x, minSeverity: e.target.value as Severity } : x)))}>{SEVERITIES.map((s) => <option key={s}>{s}</option>)}</select>
              </div>
              {may && <Button size="sm" variant="ghost" onClick={() => setLevels(edit.levels.filter((_, j) => j !== i))}><Trash2 className="h-4 w-4" /></Button>}
            </div>
            {l.destinations.map((d, k) => (
              <div key={k} className="flex flex-wrap gap-2">
                <select aria-label="Destination type" className="rounded-md border bg-background p-2" disabled={!may} value={isEmail(d) ? 'email' : 'webhook'}
                  onChange={(e) => setDest(i, k, e.target.value === 'email' ? { label: d.label, recipientId: confirmed[0]?.id ?? '' } : { label: d.label, url: '' })}>
                  <option value="webhook">Webhook</option>
                  <option value="email">Email</option>
                </select>
                <Input className="w-40" placeholder="Label" disabled={!may} value={d.label} onChange={(e) => setDest(i, k, { ...d, label: e.target.value })} />
                {isEmail(d) ? (
                  may ? (
                    <select aria-label="Recipient" className="min-w-0 flex-1 rounded-md border bg-background p-2" value={d.recipientId} onChange={(e) => setDest(i, k, { label: d.label, recipientId: e.target.value })}>
                      {!confirmed.some((r) => r.id === d.recipientId) && <option value={d.recipientId}>{d.email ? `${d.email} (not confirmed)` : 'Choose a confirmed address'}</option>}
                      {confirmed.map((r) => <option key={r.id} value={r.id}>{r.address}{r.label ? ` — ${r.label}` : ''}</option>)}
                    </select>
                  ) : <span className="self-center">{d.email ?? 'an address that was removed'}{d.confirmed === false ? ' (not confirmed)' : ''}</span>
                ) : (
                  <Input className="min-w-0 flex-1" placeholder="https://hooks.example.com/…" disabled={!may} value={d.url} data-secret onChange={(e) => setDest(i, k, { label: d.label, url: e.target.value })} />
                )}
                {may && <Button size="sm" variant="ghost" onClick={() => setLevels(edit.levels.map((x, j) => (j === i ? { ...x, destinations: x.destinations.filter((_, m) => m !== k) } : x)))}>Remove</Button>}
              </div>
            ))}
            {may && isEmailHint(l) && confirmed.length === 0 && <p className="text-xs text-muted-foreground">No confirmed address yet: add one under Email recipients and confirm it first.</p>}
            {may && l.destinations.length < 5 && <Button size="sm" variant="outline" onClick={() => setLevels(edit.levels.map((x, j) => (j === i ? { ...x, destinations: [...x.destinations, { label: '', url: '' }] } : x)))}>Add destination</Button>}
          </div>
        ))}
        {may && edit.levels.length < 4 && (
          <Button size="sm" variant="outline" onClick={() => setLevels([...edit.levels, { afterMinutes: edit.levels.length ? edit.levels[edit.levels.length - 1].afterMinutes + 30 : 0, minSeverity: 'WARNING', destinations: [{ label: '', url: '' }] }])}>
            <Plus className="mr-1 h-4 w-4" />Add escalation level
          </Button>
        )}
        <div className="flex flex-wrap items-center gap-2 rounded-md border p-3">
          <label className="flex items-center gap-2"><input type="checkbox" disabled={!may} checked={edit.ticketing.enabled} onChange={(e) => setDraft({ ...edit, ticketing: { ...edit.ticketing, enabled: e.target.checked } })} />Offer alerts to ClientSt0r for a ticket, at least</label>
          <select className="rounded-md border bg-background p-1" disabled={!may} value={edit.ticketing.minSeverity} onChange={(e) => setDraft({ ...edit, ticketing: { ...edit.ticketing, minSeverity: e.target.value as Severity } })}>{SEVERITIES.map((s) => <option key={s}>{s}</option>)}</select>
          <span className="text-xs text-muted-foreground">ClientSt0r decides whether to open one, and links it back.</span>
        </div>
        {may && (
          <div className="flex gap-2">
            <Button disabled={!draft || save.isPending} onClick={() => save.mutate()}>Save (re-authenticate)</Button>
            {draft && <Button variant="ghost" onClick={() => setDraft(null)}>Discard changes</Button>}
          </div>
        )}
        {current && <p className="text-xs text-muted-foreground">Last changed {fmt(current.updatedAt)}.</p>}
      </CardContent>
    </Card>
  );
}
