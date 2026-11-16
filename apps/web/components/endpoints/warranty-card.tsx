'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { BadgeCheck, Copy, ExternalLink } from 'lucide-react';
import { warrantyApi, type WarrantyView } from '@/lib/api-client';
import { usePermissions, CAP } from '@/lib/auth';
import { lookupResultText, WARRANTY_GAP_LABEL, WARRANTY_STATE_LABEL } from '@/lib/hardware-support';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { apiError } from '@/components/security-controls/shared';
import { useToast } from '@/hooks/use-toast';
import { CardHeading } from './card-heading';

/**
 * Warranty and support (0.56), beside the Hardware card. The vendor's support,
 * warranty and driver pages for this machine (built from what its firmware
 * reported — lib/hardware-support.ts, the same table the API uses), the
 * stored warranty dates and where they came from, and — for someone who may
 * edit the computer — entering them by hand or asking the vendor now.
 *
 * Every vendor link opens in a new tab with rel="noopener noreferrer".
 */
const day = (s: string | null | undefined) => (s ? s.slice(0, 10) : '');

function Line({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-4">
      <span className="text-muted-foreground shrink-0">{label}</span>
      <span className="text-right min-w-0 break-words">{children}</span>
    </div>
  );
}

export function WarrantyCard({ endpointId }: { endpointId: string }) {
  const { can, isPlatformAdmin } = usePermissions();
  const mayEdit = can(CAP.COMPUTERS_EDIT);
  const qc = useQueryClient();
  const { toast } = useToast();
  const { data } = useQuery<WarrantyView>({
    queryKey: ['endpoint-warranty', endpointId],
    queryFn: () => warrantyApi.get(endpointId).then((r) => r.data.data),
  });
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState({ startsAt: '', endsAt: '', coverage: '' });
  const done = (r: WarrantyView) => { qc.setQueryData(['endpoint-warranty', endpointId], r); qc.invalidateQueries({ queryKey: ['device-list'] }); };
  const save = useMutation({
    mutationFn: (clear: boolean) => warrantyApi.set(endpointId, clear
      ? { startsAt: null, endsAt: null, coverage: null }
      : { startsAt: form.startsAt || null, endsAt: form.endsAt || null, coverage: form.coverage.trim() || null }).then((r) => r.data.data as WarrantyView),
    onSuccess: (r, clear) => { done(r); setEditing(false); toast({ title: clear ? 'Warranty cleared' : 'Warranty saved' }); },
    onError: (e) => toast({ title: 'Not saved', description: apiError(e).message, variant: 'destructive' }),
  });
  const check = useMutation({
    mutationFn: () => warrantyApi.lookup(endpointId).then((r) => r.data.data as WarrantyView & { result: string }),
    onSuccess: (r) => { done(r); toast({ title: r.result === 'OK' ? 'Warranty updated from the vendor' : 'The vendor did not answer with a warranty', description: r.result === 'OK' ? undefined : `${lookupResultText(r.result)} (${r.result})` }); },
    onError: (e) => toast({ title: 'Lookup refused', description: apiError(e).message, variant: 'destructive' }),
  });

  if (!data) return null;
  const { warranty: w, support: s, lookup: l } = data;
  const tone = w.state === 'expired' ? 'destructive' : w.state === 'expiring_30' || w.state === 'expiring_60' ? 'warning' : w.state === 'unknown' ? 'outline' : 'secondary';
  const copy = async () => {
    if (!s.serial) return;
    try { await navigator.clipboard.writeText(s.serial); toast({ title: 'Serial copied', description: 'Paste it on the vendor’s page.' }); } catch { /* clipboard refused */ }
  };

  return (
    <Card data-testid="warranty-card">
      <CardHeading title="Warranty & support" icon={BadgeCheck} aside={s.maker.kind === 'virtual' && w.state === 'unknown' ? undefined : <Badge variant={tone} data-testid="warranty-state">{WARRANTY_STATE_LABEL[w.state]}</Badge>} />
      <CardContent className="space-y-2.5 text-sm">
        {s.maker.kind === 'virtual' ? (
          <p className="text-muted-foreground" data-testid="warranty-virtual">{s.note}</p>
        ) : s.maker.kind === 'unknown' ? (
          <p className="text-muted-foreground">No support links: the manufacturer is not one this page knows, or none was reported.</p>
        ) : (
          <div className="space-y-1.5" data-testid="support-links">
            <div className="flex flex-wrap gap-2">
              {s.links.map((k) => (
                <a key={k.url} href={k.url} target="_blank" rel="noopener noreferrer" data-kind={k.kind}
                  className="inline-flex items-center gap-1 rounded-md border px-2 py-1 text-xs hover:bg-muted">
                  {s.vendorLabel}: {k.label}<ExternalLink className="h-3 w-3" aria-hidden />
                </a>
              ))}
            </div>
            {s.serial && !s.links.some((k) => k.serialInUrl) && (
              <Button variant="ghost" size="sm" className="h-7 px-2 text-xs" onClick={copy} data-testid="copy-serial"><Copy className="mr-1 h-3 w-3" />Copy serial {s.serial}</Button>
            )}
            {s.note && <p className="text-xs text-muted-foreground">{s.note}</p>}
          </div>
        )}

        {w.endsAt ? (
          <>
            <Line label="Ends">{day(w.endsAt)}{w.daysLeft !== null ? <span className="text-muted-foreground"> · {w.daysLeft < 0 ? `${-w.daysLeft} days ago` : `${w.daysLeft} days left`}</span> : null}</Line>
            {w.startsAt && <Line label="Started">{day(w.startsAt)}</Line>}
            {w.coverage && <Line label="Coverage">{w.coverage}</Line>}
            <Line label="Source">{w.sourceLabel}{w.checkedAt ? <span className="text-muted-foreground"> · {new Date(w.checkedAt).toLocaleDateString()}</span> : null}</Line>
          </>
        ) : data.gap && data.gap.reason !== 'virtual' ? (
          <div className="space-y-1 rounded-md border border-dashed p-2" data-testid="warranty-gap" data-reason={data.gap.reason}>
            <p><span className="font-medium">No warranty date</span> <span className="text-muted-foreground">· {WARRANTY_GAP_LABEL[data.gap.reason]}</span></p>
            <p className="text-xs text-muted-foreground">{data.gap.text}</p>
            {data.gap.settings && (isPlatformAdmin
              ? <Link href="/settings/warranty" className="text-xs underline" data-testid="warranty-gap-settings">Open Settings → Warranty</Link>
              : <p className="text-xs text-muted-foreground">Ask a Platform Admin: lookups are set up in Settings → Warranty.</p>)}
          </div>
        ) : null}
        {l.lastAttemptAt && l.lastResult && l.lastResult !== 'OK' && w.endsAt && <p className="text-xs text-muted-foreground">Last vendor lookup {new Date(l.lastAttemptAt).toLocaleString()}: {lookupResultText(l.lastResult)} ({l.lastResult}).</p>}

        {mayEdit && !editing && (
          <div className="flex flex-wrap gap-2 pt-1">
            <Button variant="outline" size="sm" data-testid="warranty-edit" onClick={() => { setForm({ startsAt: day(w.source === 'manual' ? w.startsAt : null), endsAt: day(w.source === 'manual' ? w.endsAt : null), coverage: w.source === 'manual' ? w.coverage ?? '' : '' }); setEditing(true); }}>
              {w.source === 'manual' ? 'Edit dates' : 'Enter dates by hand'}
            </Button>
            {w.source === 'manual' && <Button variant="ghost" size="sm" disabled={save.isPending} onClick={() => save.mutate(true)}>Clear</Button>}
            {l.implemented && l.enabled && w.source !== 'manual' && <Button variant="ghost" size="sm" disabled={check.isPending} onClick={() => check.mutate()} data-testid="warranty-check-now">Check now with {l.vendorLabel}</Button>}
          </div>
        )}
        {editing && (
          <div className="space-y-2 rounded-md border p-2" data-testid="warranty-form">
            <label className="block space-y-1"><span className="text-xs text-muted-foreground">Warranty ends</span>
              <Input type="date" className="h-8" value={form.endsAt} onChange={(e) => setForm((f) => ({ ...f, endsAt: e.target.value }))} data-testid="warranty-ends" /></label>
            <label className="block space-y-1"><span className="text-xs text-muted-foreground">Started (optional)</span>
              <Input type="date" className="h-8" value={form.startsAt} onChange={(e) => setForm((f) => ({ ...f, startsAt: e.target.value }))} /></label>
            <label className="block space-y-1"><span className="text-xs text-muted-foreground">Coverage (optional)</span>
              <Input className="h-8" maxLength={200} placeholder="e.g. ProSupport Plus, next business day" value={form.coverage} onChange={(e) => setForm((f) => ({ ...f, coverage: e.target.value }))} /></label>
            <p className="text-xs text-muted-foreground">Entered by hand, it is never overwritten by a vendor lookup. Changes are audited.</p>
            <div className="flex gap-2">
              <Button size="sm" disabled={save.isPending || !form.endsAt} onClick={() => save.mutate(false)} data-testid="warranty-save">Save</Button>
              <Button size="sm" variant="ghost" onClick={() => setEditing(false)}>Cancel</Button>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
