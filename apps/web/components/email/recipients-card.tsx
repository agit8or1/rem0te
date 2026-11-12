'use client';

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Mail, Trash2 } from 'lucide-react';
import { emailApi, type EmailRecipientView } from '@/lib/api-client';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { apiError } from '@/components/security-controls/shared';

/**
 * Confirmed email recipients (0.34) for one scope: a business, or the MSP's
 * global list. An address is usable by notification policies and scheduled
 * reports only after someone clicked the confirmation link sent to it.
 * Adding, re-sending and removing need fresh authentication (the api-client
 * interceptor asks and retries).
 */
export function EmailOffNotice({ enabled }: { enabled: boolean | undefined }) {
  if (enabled !== false) return null;
  return <p className="rounded-md border border-amber-300 bg-amber-50 p-2 text-xs text-amber-900 dark:bg-amber-950 dark:text-amber-100">Outbound email is not configured on this server. A Platform Admin sets it up under Settings → Email; until then no confirmation, alert email or report is sent.</p>;
}

export function RecipientsCard({ scope, businessId, ok, fail }: { scope: 'global' | 'business'; businessId: string | null; ok: (t: string) => void; fail: (e: unknown) => void }) {
  const qc = useQueryClient();
  const key = ['email-recipients', scope, businessId];
  const { data, error } = useQuery<{ recipients: EmailRecipientView[]; email: { enabled: boolean } }>({
    queryKey: key, queryFn: () => emailApi.recipients(scope, businessId).then((r) => r.data.data), retry: false,
  });
  const [address, setAddress] = useState('');
  const [label, setLabel] = useState('');
  const refresh = () => { qc.invalidateQueries({ queryKey: ['email-recipients'] }); qc.invalidateQueries({ queryKey: ['report-schedules'] }); };
  const sentText = (s: string | undefined) => (s === 'sent' ? 'A confirmation link was sent.' : s === 'email_off' ? 'Saved, but outbound email is off: no confirmation was sent yet.' : `The confirmation could not be sent (${s ?? 'unknown'}).`);
  const add = useMutation({
    mutationFn: () => emailApi.addRecipient({ scope, ...(businessId && scope === 'business' ? { businessId } : {}), address: address.trim(), ...(label.trim() ? { label: label.trim() } : {}) }).then((r) => r.data.data),
    onSuccess: (r: { confirmation?: { status: string } }) => { ok(`Address added. ${sentText(r.confirmation?.status)}`); setAddress(''); setLabel(''); refresh(); }, onError: fail,
  });
  const resend = useMutation({ mutationFn: (id: string) => emailApi.resend(id).then((r) => r.data.data), onSuccess: (r: { confirmation?: { status: string } }) => { ok(sentText(r.confirmation?.status)); refresh(); }, onError: fail });
  const remove = useMutation({ mutationFn: (id: string) => emailApi.removeRecipient(id), onSuccess: () => { ok('Address removed. Policies and schedules that named it no longer send to it.'); refresh(); }, onError: fail });

  return (
    <Card data-testid="email-recipients">
      <CardHeader><CardTitle className="flex items-center gap-2 text-sm"><Mail className="h-4 w-4" />Email recipients {scope === 'global' ? '— global (the MSP)' : 'for this business'}</CardTitle></CardHeader>
      <CardContent className="space-y-3 text-sm">
        <p className="text-muted-foreground">
          Alert emails and scheduled reports go only to addresses on this list that have been confirmed: whoever reads the mailbox
          clicks the link sent to it. A typed address is never used directly, so a stolen session cannot mail data to anyone.
          {scope === 'business' ? ' A business\'s policies and schedules use only its own list.' : ' The global notification policy and platform-wide reports use this list.'}
        </p>
        {error ? <p className="text-muted-foreground">{apiError(error).message}</p> : null}
        <EmailOffNotice enabled={data?.email.enabled} />
        {data && data.recipients.length === 0 && <p className="text-muted-foreground">No addresses yet.</p>}
        {data?.recipients.map((r) => (
          <div key={r.id} className="flex flex-wrap items-center gap-2 rounded-md border p-2">
            {r.verified ? <Badge>confirmed</Badge> : <Badge variant="outline">waiting for confirmation</Badge>}
            <span className="font-medium">{r.address}</span>
            {r.label && <span className="text-muted-foreground">{r.label}</span>}
            <span className="text-xs text-muted-foreground">{r.verified ? `confirmed ${new Date(r.verifiedAt!).toLocaleString()}` : r.lastSentAt ? `link sent ${new Date(r.lastSentAt).toLocaleString()}` : 'no link sent yet'}</span>
            <div className="ml-auto flex gap-1">
              {!r.verified && <Button size="sm" variant="outline" disabled={resend.isPending} onClick={() => resend.mutate(r.id)}>Send link again</Button>}
              <Button size="sm" variant="ghost" aria-label={`Remove ${r.address}`} disabled={remove.isPending} onClick={() => remove.mutate(r.id)}><Trash2 className="h-4 w-4" /></Button>
            </div>
          </div>
        ))}
        {data && (
          <div className="flex flex-wrap items-end gap-2">
            <div className="space-y-1"><Label htmlFor={`rcpt-addr-${scope}`}>Address</Label><Input id={`rcpt-addr-${scope}`} className="w-64" type="email" placeholder="noc@example.com" value={address} onChange={(e) => setAddress(e.target.value)} /></div>
            <div className="space-y-1"><Label htmlFor={`rcpt-label-${scope}`}>Label (optional)</Label><Input id={`rcpt-label-${scope}`} className="w-40" value={label} onChange={(e) => setLabel(e.target.value)} /></div>
            <Button size="sm" disabled={!address.includes('@') || add.isPending} onClick={() => add.mutate()}>Add and send link (re-authenticate)</Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
