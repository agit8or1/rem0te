'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, ExternalLink, Loader2, Play, ShieldCheck, ShieldOff } from 'lucide-react';
import { endpointsApi, scriptRunsApi, type ScriptArgument, type ScriptParameter } from '@/lib/api-client';
import { useToast } from '@/hooks/use-toast';
import { cn, formatDate } from '@/lib/utils';
import { DIRECT_TOAST, directApproved } from '@/lib/direct-mode';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { apiMessage, selectClass, shortHash } from './script-ui';
import { ConnectivityIndicator } from '@/components/common/connectivity-indicator';

/**
 * Running an approved version (0.34). Three steps, and this panel only ever
 * asks for them:
 *
 *   1. propose the version to the approval signer's own allowlist (a reviewer);
 *   2. two approvers who did not write it add it, on the signer's page;
 *   3. request a run on up to 25 computers, which two approvers then approve,
 *      (0.39: in direct mode, set by the signer's operator, steps 2 and 3
 *      happen at the request, after a fresh sign-in — there is nothing to
 *      approve)
 *      again on the signer's page.
 *
 * The portal cannot add to the allowlist or approve a run, so there is no
 * control here that does either: the links open the approval signer.
 * Arguments are checked here, by the API, by the signer and by the agent
 * against the version's declared parameters.
 */

interface Readiness {
  version: { id: string; name: string; scope: 'global' | 'business'; businessId: string | null; version: number; status: string; parameters: ScriptParameter[]; contentSha256: string };
  signerConfigured: boolean;
  /** 0.39: the signer's default policy is in direct mode, so a proposal is added at once. */
  allowlistDirect?: boolean;
  allowlist: { id: string; status: string; approvalUrl: string; contentSha256: string; createdAt: string; revokedAt: string | null; revokeReason: string | null } | null;
  revoked: boolean;
  timeouts: number[]; maxTargets: number; maxOutputBytes: number; retentionDays: number;
  you: { canPropose: boolean; canRevoke: boolean; canRun: boolean };
  warnings: string[]; acknowledge: string; proven: string;
}
interface EndpointLite { id: string; name: string; hostname?: string | null; isOnline?: boolean; lastSeenAt?: string | null; connectivity?: string }

const ENTRY: Record<string, { label: string; variant: 'success' | 'warning' | 'outline' | 'destructive' }> = {
  AWAITING_APPROVAL: { label: 'Awaiting approval on the signer', variant: 'warning' },
  ACTIVE: { label: 'On the signer\'s allowlist', variant: 'success' },
  REJECTED: { label: 'Rejected on the signer', variant: 'destructive' },
  REVOKED: { label: 'Revoked', variant: 'destructive' },
};

/** The same charsets as the API (actions/script-run.ts) and the agent. */
const CHARSET_RE: Record<string, RegExp> = {
  alphanumeric: /^[A-Za-z0-9]*$/, identifier: /^[A-Za-z0-9_.-]*$/, hostname: /^[A-Za-z0-9.-]*$/, safe_text: /^[A-Za-z0-9 _.,:@-]*$/,
};

/** Typed arguments from the form, or the first problem. Empty optional fields are left out. */
function argumentsFrom(decls: ScriptParameter[], raw: Record<string, string | boolean>): { args: Record<string, ScriptArgument>; problem: string | null } {
  const args: Record<string, ScriptArgument> = {};
  for (const d of decls) {
    const v = raw[d.name];
    if (d.type === 'boolean') { if (v === true || d.required) args[d.name] = v === true; continue; }
    const s = typeof v === 'string' ? v : '';
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
    } else {
      args[d.name] = s;
    }
  }
  return { args, problem: null };
}

export function ScriptRunPanel({ versionId }: { versionId: string }) {
  const { toast } = useToast();
  const qc = useQueryClient();
  const { data: r, error } = useQuery({
    queryKey: ['script-run', versionId],
    queryFn: () => scriptRunsApi.readiness(versionId).then((x) => x.data.data as Readiness),
    refetchInterval: (q) => ((q.state.data as Readiness | undefined)?.allowlist?.status === 'AWAITING_APPROVAL' ? 15_000 : false),
    retry: false,
  });
  const refresh = () => qc.invalidateQueries({ queryKey: ['script-run', versionId] });
  const [revokeReason, setRevokeReason] = useState('');
  const fail = (title: string) => (e: unknown) => toast({ title, description: apiMessage(e, 'Refused.'), variant: 'destructive' });
  const propose = useMutation({
    mutationFn: () => scriptRunsApi.propose(versionId),
    onSuccess: (x) => {
      const active = (x.data?.data as { status?: string } | undefined)?.status === 'ACTIVE';
      toast(active ? { title: 'Added to the allowlist', description: 'Approved automatically (direct mode). It can be run now.' } : { title: 'Proposed to the approval signer', description: 'Two approvers who did not write it must add it there.' });
      refresh();
    },
    onError: fail('Not proposed'),
  });
  const revoke = useMutation({
    mutationFn: () => scriptRunsApi.revoke(versionId, revokeReason.trim()),
    onSuccess: () => { toast({ title: 'Revoked', description: 'This content can never be run again. Edit it into a new version to run a fix.' }); setRevokeReason(''); refresh(); },
    onError: fail('Not revoked'),
  });

  if (error) return null; // No library rights to run (the API answered 404): nothing to offer.
  if (!r) return null;
  const e = r.allowlist;
  const st = e ? ENTRY[e.status] ?? { label: e.status, variant: 'outline' as const } : null;

  return (
    <Card data-script-run-panel>
      <CardHeader className="pb-3"><CardTitle className="text-sm flex items-center gap-2"><Play className="h-4 w-4" />Run this version</CardTitle></CardHeader>
      <CardContent className="space-y-3 text-sm">
        <p className="text-xs text-muted-foreground" data-script-run-proven>{r.proven}</p>
        {!r.signerConfigured && <p className="text-xs">No approval signer is configured on this server, so scripts cannot be run here. See <Link className="underline" href="/docs/approved-actions">Approved actions</Link>.</p>}

        <div className="space-y-1">
          <p className="text-xs font-medium flex items-center gap-2">Approval signer allowlist {st && <Badge variant={st.variant}>{st.label}</Badge>}</p>
          {!e && !r.revoked && <p className="text-xs text-muted-foreground">{r.allowlistDirect
            ? 'Not proposed yet. The approval signer is in direct mode: proposing it adds its SHA-256 to the signer\u2019s allowlist at once, after you confirm it is you.'
            : <>Not proposed yet. A reviewer proposes it; two approvers on the approval roster who did not write it then read it on the signer&apos;s page and add its SHA-256.</>}</p>}
          {e && <p className="text-xs text-muted-foreground">Entry for content <code className="font-mono">{shortHash(e.contentSha256)}</code>, proposed {formatDate(e.createdAt)}.{e.revokedAt ? ` Revoked ${formatDate(e.revokedAt)}${e.revokeReason ? `: ${e.revokeReason}` : ''}.` : ''}</p>}
          {r.revoked && <p className="text-xs">This content was revoked. Revocation is permanent: the approval signer will never allow these exact bytes again. Edit it into a new version and have that reviewed.</p>}
          {e?.status === 'AWAITING_APPROVAL' && !r.allowlistDirect && (
            <Button size="sm" variant="outline" asChild>
              <a href={e.approvalUrl} target="_blank" rel="noopener noreferrer"><ExternalLink className="h-3.5 w-3.5 mr-1" />Open the approval signer&apos;s page</a>
            </Button>
          )}
          {r.you.canPropose && r.signerConfigured && (
            <Button size="sm" disabled={propose.isPending} onClick={() => propose.mutate()}><ShieldCheck className="h-4 w-4 mr-1" />Propose to the approval signer</Button>
          )}
        </div>

        {r.you.canRun && <RunForm r={r} />}

        {r.you.canRevoke && (
          <details className="rounded-md border p-2">
            <summary className="cursor-pointer text-xs font-medium">Revoke from the allowlist</summary>
            <div className="mt-2 space-y-2">
              <p className="text-xs text-muted-foreground">Permanent. The approval signer refuses every new run of this content, and every run not yet signed. A run already signed may still reach a computer within its window; cancel it from the computer&apos;s Actions tab.</p>
              <Textarea rows={2} maxLength={300} value={revokeReason} onChange={(x) => setRevokeReason(x.target.value)} placeholder="Why, e.g. it deletes the wrong folder on some computers" aria-label="Reason for revoking" />
              <Button size="sm" variant="destructive" disabled={revokeReason.trim().length < 3 || revoke.isPending} onClick={() => revoke.mutate()}><ShieldOff className="h-4 w-4 mr-1" />Revoke permanently</Button>
            </div>
          </details>
        )}
      </CardContent>
    </Card>
  );
}

function RunForm({ r }: { r: Readiness }) {
  const { toast } = useToast();
  const decls = r.version.parameters;
  const [raw, setRaw] = useState<Record<string, string | boolean>>({});
  const [ids, setIds] = useState<string[]>([]);
  const [timeout, setTimeoutMinutes] = useState<number>(r.timeouts.includes(5) ? 5 : r.timeouts[0]);
  const [reason, setReason] = useState('');
  const [ack, setAck] = useState(false);
  const [q, setQ] = useState('');
  const [requested, setRequested] = useState<{ id: string; approvalUrl: string; endpointIds: string[]; direct?: string } | null>(null);
  const { data: eps, isLoading } = useQuery<EndpointLite[]>({
    queryKey: ['script-run', 'endpoints', r.version.businessId ?? 'current'],
    queryFn: () => endpointsApi.list({ ...(r.version.businessId ? { businessId: r.version.businessId } : {}), limit: '200' }).then((x) => x.data?.data?.endpoints ?? []),
    retry: false,
  });
  const { args, problem } = argumentsFrom(decls, raw);
  const run = useMutation({
    mutationFn: () => scriptRunsApi.run({ scriptVersionId: r.version.id, endpointIds: ids, parameters: args, timeoutMinutes: timeout, reason: reason.trim() }),
    onSuccess: (x) => {
      const j = x.data.data as { id: string; approvalUrl: string; direct?: boolean; requestedByName?: string | null; createdAt: string };
      setRequested({ id: j.id, approvalUrl: j.approvalUrl, endpointIds: ids, ...(j.direct ? { direct: directApproved(j.requestedByName, j.createdAt) } : {}) });
      setAck(false);
      toast(j.direct ? { title: 'Approved automatically', description: DIRECT_TOAST } : { title: 'Run requested', description: 'Nothing runs until two approvers approve it on the approval signer\'s page.' });
    },
    onError: (e) => toast({ title: 'Not requested', description: apiMessage(e, 'The request was refused.'), variant: 'destructive' }),
  });
  const shown = (eps ?? []).filter((e) => !q.trim() || `${e.name} ${e.hostname ?? ''}`.toLowerCase().includes(q.toLowerCase()));

  return (
    <div className="space-y-3 border-t pt-3" data-script-run-form>
      <div className="rounded-md border border-yellow-300 bg-yellow-50 dark:border-yellow-800 dark:bg-yellow-950/40 p-3 space-y-1">
        {r.warnings.map((w) => <p key={w} className="flex gap-2 text-xs"><AlertTriangle className="h-3.5 w-3.5 shrink-0 mt-0.5 text-yellow-600" />{w}</p>)}
      </div>

      <div className="space-y-1">
        <Label className="text-xs">Computers ({ids.length} of at most {r.maxTargets}) · Windows, signed agent 0.34 or later</Label>
        {isLoading ? <p className="text-xs text-muted-foreground">Loading computers…</p> : (
          <>
            <Input placeholder="Filter computers…" value={q} onChange={(x) => setQ(x.target.value)} />
            <div className="max-h-48 space-y-1 overflow-y-auto rounded-md border p-1">
              {shown.length === 0 && <p className="p-2 text-xs text-muted-foreground">No computers you can reach.</p>}
              {shown.map((e) => {
                const on = ids.includes(e.id);
                return (
                  <label key={e.id} className={cn('flex w-full items-center gap-2 rounded px-2 py-1 text-sm', on ? 'bg-primary/5' : 'hover:bg-muted/50')}>
                    <input type="checkbox" checked={on} disabled={!on && ids.length >= r.maxTargets}
                      onChange={() => setIds(on ? ids.filter((x) => x !== e.id) : [...ids, e.id])} />
                    <span className="flex-1 truncate">{e.name}</span>
                    {e.isOnline !== undefined && <ConnectivityIndicator x={e} short lowercase showDot={false} className="text-xs" />}
                  </label>
                );
              })}
            </div>
          </>
        )}
      </div>

      {decls.length > 0 && (
        <div className="space-y-2">
          <p className="text-xs font-medium">Arguments</p>
          {decls.map((d) => (
            <div key={d.name} className="space-y-1">
              {d.type === 'boolean' ? (
                <label className="flex items-center gap-2 text-xs"><input type="checkbox" checked={raw[d.name] === true} onChange={(x) => setRaw({ ...raw, [d.name]: x.target.checked })} /><code>-{d.name}</code>{d.description ? ` · ${d.description}` : ''}</label>
              ) : (
                <>
                  <Label htmlFor={`arg-${d.name}`} className="text-xs"><code>-{d.name}</code>{d.required ? ' (required)' : ''}{d.description ? ` · ${d.description}` : ''}</Label>
                  {d.type === 'choice' ? (
                    <select id={`arg-${d.name}`} className={selectClass} value={String(raw[d.name] ?? '')} onChange={(x) => setRaw({ ...raw, [d.name]: x.target.value })}>
                      <option value="">{d.required ? 'Choose…' : '(not given)'}</option>
                      {d.choices.map((c) => <option key={c} value={c}>{c}</option>)}
                    </select>
                  ) : (
                    <Input id={`arg-${d.name}`} inputMode={d.type === 'integer' ? 'numeric' : undefined} maxLength={d.type === 'string' ? d.maxLength : 12}
                      value={String(raw[d.name] ?? '')} onChange={(x) => setRaw({ ...raw, [d.name]: x.target.value })}
                      placeholder={d.type === 'integer' ? `${d.min} to ${d.max}` : `${d.charset.replace('_', ' ')}, up to ${d.maxLength}`} />
                  )}
                </>
              )}
            </div>
          ))}
          <p className="text-xs text-muted-foreground">Arguments are passed to the script as data, never as a command line. The approval signer and the agent check them against these declarations again.</p>
        </div>
      )}

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
        <div className="space-y-1">
          <Label htmlFor="run-timeout" className="text-xs">Stop it after</Label>
          <select id="run-timeout" className={selectClass} value={timeout} onChange={(x) => setTimeoutMinutes(Number(x.target.value))}>
            {r.timeouts.map((t) => <option key={t} value={t}>{t} minute{t === 1 ? '' : 's'}</option>)}
          </select>
        </div>
      </div>
      <p className="text-xs text-muted-foreground">The first {Math.round(r.maxOutputBytes / 1024)} KB of its output and of its errors are kept, redacted on the computer and again here, for {r.retentionDays} days, on each computer&apos;s Actions tab.</p>
      <div className="space-y-1">
        <Label htmlFor="run-reason" className="text-xs">Why (shown to the approvers)</Label>
        <Textarea id="run-reason" rows={2} maxLength={500} value={reason} onChange={(x) => setReason(x.target.value)} placeholder="e.g. Ticket 77: clear the stuck print queue on reception" />
      </div>
      <label className="flex items-start gap-2 text-xs"><input type="checkbox" className="mt-0.5" checked={ack} onChange={(x) => setAck(x.target.checked)} />{r.acknowledge}</label>
      {problem && <p className="text-xs text-destructive" role="alert">{problem}</p>}
      <Button size="sm" disabled={!ack || ids.length === 0 || !!problem || reason.trim().length < 3 || run.isPending} onClick={() => run.mutate()}>
        {run.isPending && <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />}Request a run
      </Button>
      <p className="text-xs text-muted-foreground flex gap-2"><ShieldCheck className="h-3.5 w-3.5 shrink-0 mt-0.5" />Requesting runs nothing. Two approvers on the approval roster, neither of whom wrote this script, approve the exact plan with a passkey on the approval signer&apos;s page. You cannot approve your own request. (In direct mode, set on the approval signer for this business, the run is signed as soon as you request it, after you confirm it is you.)</p>
      {requested && (
        <div className="rounded-md border p-2 space-y-1 text-xs" data-script-run-requested>
          <p>{requested.direct ? `${requested.direct}. It runs when each computer next checks in.` : 'Requested. Waiting for approval.'}</p>
          <div className="flex flex-wrap gap-2">
            {!requested.direct && <Button size="sm" variant="outline" asChild><a href={requested.approvalUrl} target="_blank" rel="noopener noreferrer"><ExternalLink className="h-3.5 w-3.5 mr-1" />Open the approval page</a></Button>}
            {requested.endpointIds.slice(0, 5).map((id) => {
              const e = (eps ?? []).find((x) => x.id === id);
              return <Button key={id} size="sm" variant="ghost" asChild><Link href={`/endpoints/${id}?tab=actions`}>{e?.name ?? 'Computer'}: results</Link></Button>;
            })}
          </div>
        </div>
      )}
    </div>
  );
}
