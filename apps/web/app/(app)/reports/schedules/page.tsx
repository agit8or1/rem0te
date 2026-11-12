'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Trash2 } from 'lucide-react';
import { businessesApi, reportSchedulesApi, sitesApi, type ReportScheduleInput, type ScheduledReportKey } from '@/lib/api-client';
import { usePermissions } from '@/lib/auth';
import { PageHeader } from '@/components/common/page-header';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { apiError } from '@/components/security-controls/shared';
import { EmailOffNotice } from '@/components/email/recipients-card';

/**
 * Scheduled reports (0.34): a report emailed weekly or monthly to confirmed
 * addresses. Evaluated as the schedule's owner at send time — their access is
 * re-checked then, and the schedule switches itself off if they lost it.
 * Creating or changing one needs fresh authentication.
 */
const REPORTS: { id: ScheduledReportKey; label: string }[] = [
  { id: 'patch-compliance', label: 'Patch compliance' }, { id: 'agent-coverage', label: 'Agent coverage' },
  { id: 'alert-frequency', label: 'Alert frequency' }, { id: 'offline-time', label: 'Offline time' },
];
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const STATUS: Record<string, string> = { sending: 'sending (interrupted if old)', sent: 'sent', partial: 'partly sent', failed: 'failed', blocked: 'blocked by containment', missed: 'missed' };

type Delivery = { period: string; status: string; dueAt: string; finishedAt: string | null; rows: number | null; detail: { reason?: string; why?: string } | null };
type Schedule = {
  id: string; report: ScheduledReportKey; businessId: string | null; siteId: string | null; params: { silentDays?: number };
  frequency: 'weekly' | 'monthly'; dayOfWeek: number | null; dayOfMonth: number | null; time: string; timeZone: string; describe: string | null; periodDays: number;
  attachCsv: boolean; enabled: boolean; disabledReason: string | null; nextRunAt: string | null; ownerId: string;
  recipients: { id: string; address: string | null; label: string | null; confirmed: boolean }[]; deliveries: Delivery[];
};
type ListData = { schedules: Schedule[]; recipients: { id: string; address: string; label: string | null }[]; email: { enabled: boolean }; may: { create: boolean } };

const browserZone = () => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; } catch { return 'UTC'; } };
const blank = (): ReportScheduleInput => ({ report: 'patch-compliance', frequency: 'weekly', dayOfWeek: 1, dayOfMonth: null, time: '08:00', timeZone: browserZone(), attachCsv: false, recipientIds: [], enabled: true });

export default function ReportSchedulesPage() {
  const { user, isPlatformAdmin, isBusinessOwner, technician, businessId: ownBusiness } = usePermissions();
  const qc = useQueryClient();
  const [picked, setPicked] = useState('');
  const businessId = isPlatformAdmin ? (picked || null) : ownBusiness;
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null);
  const fail = (e: unknown) => setNotice({ ok: false, text: apiError(e).message });
  const allowed = isPlatformAdmin || (isBusinessOwner && !technician);

  const { data, error } = useQuery<ListData>({ queryKey: ['report-schedules', businessId], queryFn: () => reportSchedulesApi.list(businessId).then((r) => r.data.data), enabled: allowed, retry: false });
  const { data: businesses } = useQuery<{ id: string; name: string }[]>({
    queryKey: ['businesses-for-schedules'], queryFn: () => businessesApi.list().then((r) => ((r.data as { data?: { id: string; name: string }[] })?.data ?? [])), enabled: isPlatformAdmin,
  });
  const { data: sites } = useQuery<{ id: string; name: string }[]>({
    queryKey: ['sites-for-schedules', businessId], queryFn: () => sitesApi.list(businessId ?? undefined).then((r) => ((r.data as { data?: { id: string; name: string }[] })?.data ?? [])), enabled: !!businessId,
  });
  const bizName = (id: string | null) => (id ? businesses?.find((b) => b.id === id)?.name ?? (id === ownBusiness ? 'Your business' : id) : 'All businesses');

  const [editing, setEditing] = useState<string | null>(null);
  // A schedule keeps its business; an edit names the one it already has.
  const [editingBiz, setEditingBiz] = useState<string | null>(null);
  const [form, setForm] = useState<ReportScheduleInput>(blank());
  useEffect(() => { setEditing(null); setForm(blank()); }, [businessId]);
  const refresh = () => qc.invalidateQueries({ queryKey: ['report-schedules'] });
  const save = useMutation({
    mutationFn: () => {
      const body: ReportScheduleInput = {
        ...form, businessId: businessId ?? null, siteId: form.siteId || null,
        dayOfWeek: form.frequency === 'weekly' ? form.dayOfWeek ?? 1 : null, dayOfMonth: form.frequency === 'monthly' ? form.dayOfMonth ?? 1 : null,
        ...(form.report === 'agent-coverage' ? {} : { silentDays: undefined }),
      };
      return (editing ? reportSchedulesApi.update(editing, { ...body, businessId: editingBiz }) : reportSchedulesApi.create(body)).then(() => undefined);
    },
    onSuccess: () => { setNotice({ ok: true, text: editing ? 'Schedule saved. You are now its owner: it is evaluated with your access.' : 'Schedule created.' }); setEditing(null); setForm(blank()); refresh(); },
    onError: fail,
  });
  const toggle = useMutation({ mutationFn: (s: Schedule) => reportSchedulesApi.update(s.id, { enabled: !s.enabled }), onSuccess: () => refresh(), onError: fail });
  const remove = useMutation({ mutationFn: (id: string) => reportSchedulesApi.remove(id), onSuccess: () => { setNotice({ ok: true, text: 'Schedule deleted.' }); refresh(); }, onError: fail });
  const edit = (s: Schedule) => {
    setEditing(s.id);
    setEditingBiz(s.businessId);
    setForm({ report: s.report, siteId: s.siteId, frequency: s.frequency, dayOfWeek: s.dayOfWeek, dayOfMonth: s.dayOfMonth, time: s.time, timeZone: s.timeZone, attachCsv: s.attachCsv, recipientIds: s.recipients.map((r) => r.id), enabled: s.enabled, ...(s.params?.silentDays ? { silentDays: s.params.silentDays } : {}) });
  };
  const set = (p: Partial<ReportScheduleInput>) => setForm((f) => ({ ...f, ...p }));

  if (!user) return null;
  return (
    <div className="space-y-4 p-4 md:p-6">
      <PageHeader title="Scheduled reports" description="A report emailed every week or month to confirmed addresses, computed with its owner's access at the time it is sent." />
      {!allowed ? <p className="text-sm text-muted-foreground">Scheduled reports are set up by a Business Owner, or by a Platform Admin.</p> : (
        <>
          {isPlatformAdmin && (
            <div className="space-y-1">
              <Label htmlFor="sched-business">Business</Label>
              <select id="sched-business" className="w-full rounded-md border bg-background p-2 text-sm md:w-96" value={picked} onChange={(e) => { setPicked(e.target.value); setNotice(null); }}>
                <option value="">All businesses (platform-wide reports)</option>
                {(businesses ?? []).map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
              </select>
            </div>
          )}
          {notice && <div className={`rounded-md border p-3 text-sm ${notice.ok ? 'border-emerald-300 bg-emerald-50 text-emerald-900 dark:bg-emerald-950 dark:text-emerald-100' : 'border-destructive/40 bg-destructive/10 text-destructive'}`}>{notice.text}</div>}
          {error ? <p className="text-sm text-muted-foreground">{apiError(error).message}</p> : null}
          <EmailOffNotice enabled={data?.email.enabled} />
          <Card data-testid="report-schedules">
            <CardHeader><CardTitle className="text-sm">Schedules {businessId ? `for ${bizName(businessId)}` : isPlatformAdmin ? '(every business)' : ''}</CardTitle></CardHeader>
            <CardContent className="space-y-2 text-sm">
              {data && data.schedules.length === 0 && <p className="text-muted-foreground">No scheduled reports yet.</p>}
              {data?.schedules.map((s) => (
                <div key={s.id} className="space-y-1 rounded-md border p-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <strong>{REPORTS.find((r) => r.id === s.report)?.label ?? s.report}</strong>
                    <span className="text-muted-foreground">{bizName(s.businessId)}{s.siteId ? ` · ${sites?.find((x) => x.id === s.siteId)?.name ?? 'one site'}` : ''}</span>
                    {s.enabled ? <Badge>on</Badge> : <Badge variant="outline">off</Badge>}
                    {s.attachCsv && <Badge variant="secondary">CSV attached</Badge>}
                    <div className="ml-auto flex gap-1">
                      {s.businessId === businessId
                        ? <Button size="sm" variant="outline" onClick={() => edit(s)}>Edit</Button>
                        : <Button size="sm" variant="outline" onClick={() => setPicked(s.businessId ?? '')}>Open its business</Button>}
                      <Button size="sm" variant="outline" disabled={toggle.isPending} onClick={() => toggle.mutate(s)}>{s.enabled ? 'Switch off' : 'Switch on'}</Button>
                      <Button size="sm" variant="ghost" aria-label="Delete schedule" disabled={remove.isPending} onClick={() => remove.mutate(s.id)}><Trash2 className="h-4 w-4" /></Button>
                    </div>
                  </div>
                  <p className="text-muted-foreground">{s.describe ?? `${s.frequency} at ${s.time} (${s.timeZone})`} · covers the last {s.periodDays} days · next: {s.nextRunAt ? new Date(s.nextRunAt).toLocaleString() : '—'}</p>
                  {s.disabledReason && <p className="text-xs text-destructive">{s.disabledReason}</p>}
                  <p className="text-xs">To: {s.recipients.map((r) => (r.address ? `${r.address}${r.confirmed ? '' : ' (not confirmed)'}` : 'a removed address')).join(', ')}</p>
                  {s.deliveries.length > 0 && (
                    <ul className="text-xs text-muted-foreground">
                      {s.deliveries.map((d) => (
                        <li key={d.period}>{new Date(d.dueAt).toLocaleString()} — {STATUS[d.status] ?? d.status}{d.rows !== null ? ` · ${d.rows} rows` : ''}{d.detail?.why ? ` · ${d.detail.why}` : d.detail?.reason ? ` · ${d.detail.reason}` : ''}</li>
                      ))}
                    </ul>
                  )}
                </div>
              ))}
            </CardContent>
          </Card>
          {(data?.may.create || editing) && data && (
            <Card data-testid="report-schedule-form">
              <CardHeader><CardTitle className="text-sm">{editing ? 'Edit schedule' : 'New schedule'}</CardTitle></CardHeader>
              <CardContent className="space-y-3 text-sm">
                <div className="grid gap-3 md:grid-cols-3">
                  <div className="space-y-1"><Label htmlFor="sf-report">Report</Label>
                    <select id="sf-report" className="w-full rounded-md border bg-background p-2" value={form.report} onChange={(e) => set({ report: e.target.value as ScheduledReportKey })}>{REPORTS.map((r) => <option key={r.id} value={r.id}>{r.label}</option>)}</select>
                  </div>
                  {businessId && (
                    <div className="space-y-1"><Label htmlFor="sf-site">Site</Label>
                      <select id="sf-site" className="w-full rounded-md border bg-background p-2" value={form.siteId ?? ''} onChange={(e) => set({ siteId: e.target.value || null })}>
                        <option value="">Every site</option>{(sites ?? []).map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
                      </select>
                    </div>
                  )}
                  {form.report === 'agent-coverage' && (
                    <div className="space-y-1"><Label htmlFor="sf-silent">Not heard from in</Label>
                      <select id="sf-silent" className="w-full rounded-md border bg-background p-2" value={form.silentDays ?? 7} onChange={(e) => set({ silentDays: Number(e.target.value) })}>{[1, 3, 7, 14, 30, 90].map((n) => <option key={n} value={n}>{n} days</option>)}</select>
                    </div>
                  )}
                </div>
                <div className="grid gap-3 md:grid-cols-4">
                  <div className="space-y-1"><Label htmlFor="sf-freq">Every</Label>
                    <select id="sf-freq" className="w-full rounded-md border bg-background p-2" value={form.frequency} onChange={(e) => set({ frequency: e.target.value as 'weekly' | 'monthly' })}><option value="weekly">Week (covers 7 days)</option><option value="monthly">Month (covers 30 days)</option></select>
                  </div>
                  {form.frequency === 'weekly' ? (
                    <div className="space-y-1"><Label htmlFor="sf-dow">On</Label>
                      <select id="sf-dow" className="w-full rounded-md border bg-background p-2" value={form.dayOfWeek ?? 1} onChange={(e) => set({ dayOfWeek: Number(e.target.value) })}>{DAYS.map((d, i) => <option key={d} value={i}>{d}</option>)}</select>
                    </div>
                  ) : (
                    <div className="space-y-1"><Label htmlFor="sf-dom">On day</Label>
                      <select id="sf-dom" className="w-full rounded-md border bg-background p-2" value={form.dayOfMonth ?? 1} onChange={(e) => set({ dayOfMonth: Number(e.target.value) })}>{Array.from({ length: 28 }, (_, i) => i + 1).map((n) => <option key={n} value={n}>{n}</option>)}</select>
                    </div>
                  )}
                  <div className="space-y-1"><Label htmlFor="sf-time">At</Label><Input id="sf-time" type="time" value={form.time} onChange={(e) => set({ time: e.target.value })} /></div>
                  <div className="space-y-1"><Label htmlFor="sf-tz">Time zone</Label><Input id="sf-tz" value={form.timeZone} onChange={(e) => set({ timeZone: e.target.value })} /></div>
                </div>
                <p className="text-xs text-muted-foreground">Days of the month stop at 28 so every month has the day. A time skipped by a daylight-saving change is sent at the change; a time that happens twice is sent once, the first time.</p>
                <div className="space-y-1">
                  <Label>Send to (confirmed addresses of {businessId ? 'this business' : 'the MSP'})</Label>
                  {data.recipients.length === 0 && <p className="text-xs text-muted-foreground">No confirmed address yet. Add and confirm one under {businessId ? 'Settings → Monitoring → Notifications' : 'Settings → Email'}.</p>}
                  {data.recipients.map((r) => (
                    <label key={r.id} className="flex items-center gap-2"><input type="checkbox" checked={form.recipientIds.includes(r.id)} onChange={(e) => set({ recipientIds: e.target.checked ? [...form.recipientIds, r.id] : form.recipientIds.filter((x) => x !== r.id) })} />{r.address}{r.label ? <span className="text-muted-foreground"> — {r.label}</span> : null}</label>
                  ))}
                </div>
                <label className="flex items-center gap-2"><input type="checkbox" checked={form.attachCsv} onChange={(e) => set({ attachCsv: e.target.checked })} />Attach the report as CSV (the same audited export as Download CSV, with the same row limit)</label>
                <div className="flex gap-2">
                  <Button disabled={save.isPending || form.recipientIds.length === 0} onClick={() => save.mutate()}>{editing ? 'Save' : 'Create'} (re-authenticate)</Button>
                  {editing && <Button variant="ghost" onClick={() => { setEditing(null); setForm(blank()); }}>Cancel</Button>}
                </div>
                <p className="text-xs text-muted-foreground">Without a CSV the email carries only a link: recipients sign in to see the report. <Link className="underline" href="/docs">How scheduled reports work</Link>.</p>
              </CardContent>
            </Card>
          )}
        </>
      )}
    </div>
  );
}
