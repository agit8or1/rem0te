'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft } from 'lucide-react';
import { emailApi, psaApi, type EmailRecipientView, type PsaKind, type PsaScopeView } from '@/lib/api-client';
import { usePermissions } from '@/lib/auth';
import { PageHeader } from '@/components/common/page-header';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { apiError } from '@/components/security-controls/shared';
import { reauthSuffix, useAsks } from '@/lib/confirm-policy';
import { RecipientsCard } from '@/components/email/recipients-card';

/**
 * Settings → PSA / ticketing (0.48): where "Create ticket" sends. A Platform
 * Admin sets the platform default; a Business Owner may give their business
 * its own connector, which then wins for that business's computers. Every
 * save asks for fresh authentication.
 */
const KIND_HELP: Record<PsaKind, string> = {
  email: 'Most PSAs (ConnectWise, Autotask, HaloPSA, Syncro, Freshdesk, Zendesk…) open a ticket from mail sent to their inbound support address. Add that address below; it must be confirmed — the confirmation email arrives in the PSA as a ticket, open it and follow its link — before any ticket is sent. Mail goes through the relay in Settings → Email.',
  webhook: 'An HTTPS POST of a fixed JSON ticket body to a public URL — for HaloPSA or Syncro automations, Zapier, Make or n8n. The address is resolved and checked on every send; certificates are verified and redirects are not followed.',
  clientst0r: 'A signed ticket request to ClientSt0r, for businesses mapped to a ClientSt0r organization. It is offered only once ClientSt0r’s signed capabilities advertise ticket_create_request_v1, which today’s ClientSt0r does not: until then the button says so and nothing is sent.',
};

type Form = { kind: PsaKind; enabled: boolean; label: string; emailRecipientId: string; webhookUrl: string; webhookSecret: string; clearSecret: boolean };

function ScopeCard({ scope, businessId, ok, fail }: { scope: 'global' | 'business'; businessId: string | null; ok: (t: string) => void; fail: (e: unknown) => void }) {
  const qc = useQueryClient();
  const key = ['psa-connector', scope, businessId];
  const { data, error } = useQuery<PsaScopeView>({ queryKey: key, queryFn: () => psaApi.connector(scope, businessId).then((r) => r.data.data), retry: false });
  const { data: rec } = useQuery<{ recipients: EmailRecipientView[] }>({ queryKey: ['email-recipients', scope, businessId], queryFn: () => emailApi.recipients(scope, businessId).then((r) => r.data.data), retry: false });
  const [f, setF] = useState<Form | null>(null);
  const askSave = useAsks('psa.connector');
  useEffect(() => {
    if (data && !f) {
      const c = data.connector;
      setF({ kind: c?.kind ?? 'email', enabled: c?.enabled ?? true, label: c?.label ?? '', emailRecipientId: c?.emailRecipientId ?? '', webhookUrl: '', webhookSecret: '', clearSecret: false });
    }
  }, [data, f]);
  const set = (p: Partial<Form>) => setF((x) => (x ? { ...x, ...p } : x));
  const done = (r: PsaScopeView | null, text: string) => { if (r) qc.setQueryData(key, r); setF(null); qc.invalidateQueries({ queryKey: key }); qc.invalidateQueries({ queryKey: ['psa-ticket-status'] }); ok(text); };
  const save = useMutation({
    mutationFn: () => psaApi.saveConnector({
      scope, ...(scope === 'business' && businessId ? { businessId } : {}), kind: f!.kind, enabled: f!.enabled, label: f!.label.trim() || null,
      ...(f!.kind === 'email' ? { emailRecipientId: f!.emailRecipientId } : {}),
      ...(f!.kind === 'webhook' ? { webhookUrl: f!.webhookUrl.trim(), ...(f!.webhookSecret ? { webhookSecret: f!.webhookSecret } : f!.clearSecret ? { webhookSecret: null } : {}) } : {}),
    }).then((r) => r.data.data as PsaScopeView),
    onSuccess: (r) => done(r, 'Connector saved.'), onError: fail,
  });
  const remove = useMutation({ mutationFn: () => psaApi.removeConnector(scope, businessId), onSuccess: () => done(null, 'Connector removed.'), onError: fail });

  const c = data?.connector;
  const recipients = rec?.recipients ?? [];
  const picked = recipients.find((r) => r.id === f?.emailRecipientId);
  const canSave = !!f && (f.kind !== 'email' || !!f.emailRecipientId) && (f.kind !== 'webhook' || !!f.webhookUrl.trim());
  return (
    <>
      <Card data-testid={`psa-${scope}`}>
        <CardHeader>
          <CardTitle className="flex flex-wrap items-center gap-2 text-sm">
            {scope === 'global' ? 'Platform default' : `${data?.name ?? 'This business'}'s own connector`}
            {c ? (c.enabled ? <Badge>{c.kindLabel} · on</Badge> : <Badge variant="outline">{c.kindLabel} · off</Badge>) : <Badge variant="outline">none</Badge>}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          {error ? <p className="text-muted-foreground">{apiError(error).message}</p> : null}
          <p className="text-muted-foreground">
            {scope === 'global'
              ? 'Used for every computer whose business has no enabled connector of its own.'
              : data?.platformDefault
                ? `Without one, this business uses the platform default (${data.platformDefault.kindLabel}${data.platformDefault.enabled ? '' : ', currently off'}).`
                : 'Without one, and with no platform default, Create ticket is not available.'}
          </p>
          {c && (
            <div className="rounded-md border p-2 text-xs text-muted-foreground">
              Now: {c.kindLabel}{c.label ? ` (${c.label})` : ''}
              {c.kind === 'email' && <> → {c.address ?? 'address removed'} {c.confirmed ? <Badge className="ml-1">confirmed</Badge> : <Badge variant="outline" className="ml-1">waiting for confirmation</Badge>}</>}
              {c.kind === 'webhook' && <> → {c.webhookHost ?? '—'}{c.signed ? ' · signed' : ' · unsigned'}</>}
              {c.kind === 'clientst0r' && <> → {c.integrationConfigured ? 'integration configured' : 'integration not configured on this server'}</>}
              . Changed {new Date(c.updatedAt).toLocaleString()}.
            </div>
          )}
          {f && data && (
            <>
              <div className="grid gap-3 md:grid-cols-2">
                <div className="space-y-1">
                  <Label htmlFor={`psa-kind-${scope}`}>Connector</Label>
                  <select id={`psa-kind-${scope}`} className="w-full rounded-md border bg-background p-2" value={f.kind} onChange={(e) => set({ kind: e.target.value as PsaKind })}>
                    {data.kinds.map((k) => <option key={k.kind} value={k.kind}>{k.label}</option>)}
                  </select>
                </div>
                <div className="space-y-1">
                  <Label htmlFor={`psa-label-${scope}`}>Name (optional)</Label>
                  <Input id={`psa-label-${scope}`} placeholder="e.g. HaloPSA" maxLength={60} value={f.label} onChange={(e) => set({ label: e.target.value })} />
                </div>
              </div>
              <p className="text-xs text-muted-foreground">{KIND_HELP[f.kind]}</p>
              {f.kind === 'email' && (
                <div className="space-y-1">
                  <Label htmlFor={`psa-rcpt-${scope}`}>PSA support address</Label>
                  <select id={`psa-rcpt-${scope}`} className="w-full max-w-full rounded-md border bg-background p-2 md:w-[28rem]" value={f.emailRecipientId} onChange={(e) => set({ emailRecipientId: e.target.value })}>
                    <option value="">Pick an address (add it below first)</option>
                    {recipients.map((r) => <option key={r.id} value={r.id}>{r.address}{r.verified ? '' : ' — waiting for confirmation'}</option>)}
                  </select>
                  {picked && !picked.verified && <p className="text-xs text-amber-700 dark:text-amber-300">Waiting for confirmation: no ticket is sent until someone follows the link mailed to this address.</p>}
                </div>
              )}
              {f.kind === 'webhook' && (
                <div className="grid gap-3 md:grid-cols-2">
                  <div className="space-y-1">
                    <Label htmlFor={`psa-url-${scope}`}>Webhook URL</Label>
                    <Input id={`psa-url-${scope}`} className="font-mono" placeholder="https://hooks.example.com/…" autoComplete="off" value={f.webhookUrl} onChange={(e) => set({ webhookUrl: e.target.value })} />
                    {c?.kind === 'webhook' && <p className="text-xs text-muted-foreground">The saved URL is not shown again (its path is often its secret: only {c.webhookHost} is). Enter it again to save any change.</p>}
                  </div>
                  <div className="space-y-1">
                    <Label htmlFor={`psa-secret-${scope}`}>Signing secret (optional)</Label>
                    <Input id={`psa-secret-${scope}`} type="password" autoComplete="new-password" placeholder={c?.signed ? 'Saved — leave blank to keep (same URL only)' : '16+ characters'} value={f.webhookSecret} onChange={(e) => set({ webhookSecret: e.target.value, clearSecret: false })} />
                    {c?.signed && <label className="flex items-center gap-2 text-xs"><input type="checkbox" checked={f.clearSecret} onChange={(e) => set({ clearSecret: e.target.checked, webhookSecret: '' })} />Remove the saved secret</label>}
                  </div>
                  <div className="space-y-1 text-xs text-muted-foreground md:col-span-2">
                    <p>With a secret, every request carries <span className="font-mono">X-Rem0te-Timestamp: &lt;unix seconds&gt;</span> and <span className="font-mono break-all">X-Rem0te-Signature: sha256=&lt;hex HMAC-SHA256(secret, &quot;&lt;timestamp&gt;.&lt;body&gt;&quot;)&gt;</span>. Check both, and refuse an old timestamp.</p>
                    <p>The body is JSON: <span className="font-mono break-all">{'{ source: "rem0te", type: "ticket.create", version: 1, sent_at, ticket: { subject, body, note, link, computer, business, requested_by, source_ref, event, alert, ai } }'}</span>. Answer with JSON naming <span className="font-mono">ticket_id</span> (or id / number / ref) and optionally <span className="font-mono">url</span> to show the reference in rem0te.</p>
                  </div>
                </div>
              )}
              <label className="flex items-center gap-2"><input type="checkbox" checked={f.enabled} onChange={(e) => set({ enabled: e.target.checked })} />Send tickets through this connector</label>
              <div className="flex flex-wrap gap-2">
                <Button disabled={save.isPending || !canSave} onClick={() => save.mutate()}>{`Save${reauthSuffix(askSave)}`}</Button>
                {c && <Button variant="outline" disabled={remove.isPending} onClick={() => remove.mutate()}>Remove</Button>}
                <Button variant="ghost" onClick={() => setF(null)}>Discard changes</Button>
              </div>
            </>
          )}
        </CardContent>
      </Card>
      {f?.kind === 'email' && <RecipientsCard scope={scope} businessId={scope === 'business' ? businessId : null} ok={ok} fail={fail} />}
    </>
  );
}

export default function PsaSettingsPage() {
  const { user, isPlatformAdmin, isBusinessOwner, businessId, technician } = usePermissions();
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null);
  const ok = (text: string) => setNotice({ ok: true, text });
  const fail = (e: unknown) => setNotice({ ok: false, text: apiError(e).message });
  if (!user) return null;
  const owner = isBusinessOwner && !technician && !!businessId;
  if (!isPlatformAdmin && !owner) return <div className="p-6 text-sm text-muted-foreground">Where tickets are sent is set by a Platform Admin, or by the Business Owner for their business.</div>;
  return (
    <div className="space-y-4 p-4 md:p-6">
      <Link href="/settings" className="inline-flex items-center text-sm text-muted-foreground hover:underline"><ArrowLeft className="mr-1 h-4 w-4" />Settings</Link>
      <PageHeader title="PSA / ticketing" description="Where “Create ticket” on an event-log entry or alert sends. A business's own connector wins; otherwise the platform default is used." />
      {notice && <div className={`rounded-md border p-3 text-sm ${notice.ok ? 'border-emerald-300 bg-emerald-50 text-emerald-900 dark:bg-emerald-950 dark:text-emerald-100' : 'border-destructive/40 bg-destructive/10 text-destructive'}`}>{notice.text}</div>}
      {isPlatformAdmin && <ScopeCard scope="global" businessId={null} ok={ok} fail={fail} />}
      {owner && <ScopeCard scope="business" businessId={businessId} ok={ok} fail={fail} />}
      <p className="text-xs text-muted-foreground">
        Native API connectors (HaloPSA, Autotask, ConnectWise REST) are not built yet; email-to-ticket or a webhook automation covers them today.
        Ticket sends stop under a containment pause on outbound emails. See the documentation page “AI and tickets”.
      </p>
    </div>
  );
}
