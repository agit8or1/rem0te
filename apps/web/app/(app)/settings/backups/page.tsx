'use client';

import { useState, type ReactNode } from 'react';
import Link from 'next/link';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Check, Copy, Eye, EyeOff } from 'lucide-react';
import { backupsApi, businessesApi, type BackupCapabilityState, type BackupConnectionView, type BackupSetupView } from '@/lib/api-client';
import { usePermissions } from '@/lib/auth';
import { PageHeader } from '@/components/common/page-header';
import { ConfirmDialog } from '@/components/common/confirm-dialog';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { apiError } from '@/components/security-controls/shared';
import { confirmSentence, reauthSuffix, useAsks } from '@/lib/confirm-policy';

/**
 * Administration → Backup connections (0.82 Wharf; docs/backups.md, docs/st0r-push-contract.md).
 *
 * Setting up St0r's push for one business, step by step: create the
 * connection (its token shown once, with a copy button), what to give St0r
 * (the push address from the public address setting, the token, the headers,
 * a curl example with the token masked until revealed), the test push
 * (St0r's ?dryRun=1, whose last result shows here), then monitors and links.
 * Connections can be rotated (a new token, the old one refused at once) or
 * revoked. Every capability is in one of the four states.
 *
 * Platform Admin only, as in 0.81: a push token is a credential that writes a
 * business's backup status and alerts, and creating or rotating one asks the
 * person to confirm it is them when backup.connection asks.
 */
const STATE: Record<BackupCapabilityState, { label: string; cls: string }> = {
  available: { label: 'Available', cls: 'border-emerald-500/50 bg-emerald-500/10 text-emerald-800 dark:text-emerald-300' },
  requires_setup: { label: 'Requires setup', cls: 'border-amber-500/50 bg-amber-500/10 text-amber-900 dark:text-amber-200' },
  planned: { label: 'Planned', cls: 'border-sky-500/50 bg-sky-500/10 text-sky-900 dark:text-sky-200' },
  unsupported: { label: 'Unsupported', cls: 'border-muted-foreground/40 bg-muted text-muted-foreground' },
};
const when = (s: string | null | undefined) => (s ? new Date(s).toLocaleString() : 'never');
const mask = (connId: string, last4: string | null) => `rbk_${connId}_${'•'.repeat(12)}${last4 ?? '????'}`;

function CopyButton({ text, label, testId }: { text: string; label: string; testId?: string }) {
  const [done, setDone] = useState(false);
  return (
    <Button type="button" size="sm" variant="outline" data-testid={testId} aria-label={label}
      onClick={() => { void navigator.clipboard?.writeText(text).then(() => { setDone(true); setTimeout(() => setDone(false), 1500); }).catch(() => undefined); }}>
      {done ? <Check className="mr-1 h-3.5 w-3.5" /> : <Copy className="mr-1 h-3.5 w-3.5" />}{done ? 'Copied' : 'Copy'}
    </Button>
  );
}

function Step({ n, title, children, testId }: { n: number; title: string; children: ReactNode; testId?: string }) {
  return (
    <li className="flex min-w-0 gap-3" data-testid={testId}>
      <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full border text-xs font-medium">{n}</span>
      <div className="min-w-0 flex-1 space-y-2"><p className="font-medium">{title}</p>{children}</div>
    </li>
  );
}

function Mono({ children, testId }: { children: ReactNode; testId?: string }) {
  return <code className="block min-w-0 whitespace-pre-wrap break-all rounded-md border bg-muted/50 p-2 font-mono text-xs" data-testid={testId}>{children}</code>;
}

export default function BackupSettingsPage() {
  const { user, isPlatformAdmin } = usePermissions();
  const qc = useQueryClient();
  const ask = useAsks('backup.connection');
  const [biz, setBiz] = useState('');
  /** The token, only in this page's memory, only right after create or rotate. */
  const [fresh, setFresh] = useState<{ connId: string; token: string } | null>(null);
  const [reveal, setReveal] = useState(false);
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  const [confirm, setConfirm] = useState<{ kind: 'rotate' | 'revoke'; conn: BackupConnectionView } | null>(null);

  const businesses = useQuery({
    queryKey: ['businesses', ''],
    queryFn: () => businessesApi.list().then((r) => ((r.data as { data?: { id: string; name: string }[] })?.data ?? [])),
    enabled: isPlatformAdmin, retry: false,
  });
  const q = useQuery<BackupSetupView>({
    queryKey: ['backup-setup', biz],
    queryFn: () => backupsApi.connections(biz || null).then((r) => r.data.data as BackupSetupView),
    enabled: isPlatformAdmin, retry: false,
  });
  const refresh = () => { void qc.invalidateQueries({ queryKey: ['backup-setup'] }); void qc.invalidateQueries({ queryKey: ['backups'] }); };
  const onError = (e: unknown) => setNote({ ok: false, text: apiError(e).message });
  const create = useMutation({
    mutationFn: () => backupsApi.connect({ businessId: biz, kind: 'st0r' }).then((r) => r.data.data as { connection: BackupConnectionView; pushToken: string }),
    onSuccess: (r) => { setFresh({ connId: r.connection.id, token: r.pushToken }); setReveal(false); setNote({ ok: true, text: 'St0r connection created. Copy the token now: it is shown once.' }); refresh(); },
    onError,
  });
  const rotate = useMutation({
    mutationFn: (id: string) => backupsApi.rotate(id).then((r) => r.data.data as { connection: BackupConnectionView; pushToken: string }),
    onSuccess: (r) => { setFresh({ connId: r.connection.id, token: r.pushToken }); setReveal(false); setConfirm(null); setNote({ ok: true, text: 'New token issued. The old token no longer works: give St0r this one now.' }); refresh(); },
    onError: (e) => { setConfirm(null); onError(e); },
  });
  const revoke = useMutation({
    mutationFn: (id: string) => backupsApi.revoke(id),
    onSuccess: () => { setFresh(null); setConfirm(null); setNote({ ok: true, text: 'Connection revoked. Its token stopped working; what it reported is kept.' }); refresh(); },
    onError: (e) => { setConfirm(null); onError(e); },
  });

  if (!user) return null;
  if (!isPlatformAdmin) return <div className="p-6 text-sm text-muted-foreground">Backup providers are connected by a Platform Admin.</div>;

  const d = q.data;
  const live = d?.connections.filter((c) => !c.revokedAt) ?? [];
  const revoked = d?.connections.filter((c) => c.revokedAt) ?? [];
  const st0r = live.find((c) => c.kind === 'st0r') ?? null;
  const tokenNow = fresh && st0r && fresh.connId === st0r.id ? fresh.token : null;
  const shownToken = st0r ? (tokenNow && reveal ? tokenNow : mask(st0r.id, st0r.pushTokenLast4)) : '<token>';
  const curl = d ? [
    `curl -sS -X POST '${d.setup.dryRunUrl}' \\`,
    `  -H 'Authorization: Bearer ${shownToken}' \\`,
    `  -H 'Content-Type: application/json' \\`,
    `  --data '{"v":1,"assets":[]}'`,
  ].join('\n') : '';
  const curlReal = curl.replace(/\?dryRun=1/, '');
  const comet = d?.providers.find((p) => p.kind === 'comet');

  return (
    <div className="max-w-4xl space-y-4 p-4 md:p-6" data-testid="backup-settings">
      <Link href="/settings" className="inline-flex items-center text-sm text-muted-foreground hover:underline"><ArrowLeft className="mr-1 h-4 w-4" />Settings</Link>
      <PageHeader title="Backups" description="Connect a customer's St0r so it pushes backup status to Rem0te. Rem0te only reads what St0r sends: nothing here starts a backup, a restore, a drill or a failover." />

      <div className="flex flex-wrap items-center gap-2">
        <Label htmlFor="bs-biz" className="text-sm">Customer</Label>
        <select id="bs-biz" className="h-9 max-w-full rounded-md border bg-background px-2 text-sm" value={biz} onChange={(e) => { setBiz(e.target.value); setFresh(null); setNote(null); }} data-testid="backup-settings-business">
          <option value="">Pick a customer…</option>
          {(businesses.data ?? []).map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
        </select>
      </div>

      {note && <div className={`rounded-md border p-3 text-sm ${note.ok ? 'border-emerald-300 bg-emerald-50 text-emerald-900 dark:border-emerald-800 dark:bg-emerald-950 dark:text-emerald-100' : 'border-destructive/40 bg-destructive/10 text-destructive'}`} data-testid="backup-settings-note">{note.text}</div>}
      {q.error ? <p className="text-sm text-destructive">{apiError(q.error).message}</p> : null}
      {q.isLoading && <p className="text-sm text-muted-foreground">Loading…</p>}

      {d && !biz && <p className="text-sm text-muted-foreground">Pick a customer to set up its St0r push. Each customer has its own connection and token, and the token decides which customer a push writes to.</p>}

      {d && biz && (
        <>
          <Card data-testid="backup-settings-steps">
            <CardHeader><CardTitle className="text-sm">Set up St0r, step by step</CardTitle></CardHeader>
            <CardContent className="text-sm">
              <ol className="space-y-5">
                <Step n={1} title="Create the St0r connection" testId="backup-step-create">
                  {st0r ? (
                    <p className="text-muted-foreground">Created {when(st0r.createdAt)}. Token ends in <span className="font-mono">…{st0r.pushTokenLast4}</span>{st0r.tokenRotatedAt ? `, rotated ${when(st0r.tokenRotatedAt)}` : ''}.</p>
                  ) : (
                    <>
                      <p className="text-muted-foreground">This makes the push token for this customer. It is shown <strong>once</strong>: Rem0te keeps only its SHA-256. {confirmSentence(ask)}</p>
                      <Button size="sm" disabled={create.isPending} onClick={() => create.mutate()} data-testid="backup-create-st0r">{`Create St0r connection${reauthSuffix(ask)}`}</Button>
                    </>
                  )}
                  {tokenNow && (
                    <div className="space-y-2 rounded-md border border-amber-500/50 bg-amber-500/10 p-3" data-testid="backup-token-once">
                      <p className="font-medium">Push token — shown once</p>
                      <Mono testId="backup-token-value">{reveal ? tokenNow : mask(st0r!.id, st0r!.pushTokenLast4)}</Mono>
                      <div className="flex flex-wrap gap-2">
                        <Button size="sm" variant="outline" onClick={() => setReveal((v) => !v)} data-testid="backup-token-reveal">{reveal ? <EyeOff className="mr-1 h-3.5 w-3.5" /> : <Eye className="mr-1 h-3.5 w-3.5" />}{reveal ? 'Hide' : 'Reveal'}</Button>
                        <CopyButton text={tokenNow} label="Copy the push token" testId="backup-token-copy" />
                      </div>
                      <p className="text-xs">Put it in St0r now, stored as a secret. Once you leave this page it cannot be shown again; if it is lost, rotate the token.</p>
                    </div>
                  )}
                </Step>

                <Step n={2} title="Give St0r the address, the token and the headers" testId="backup-step-give">
                  <div className="space-y-1">
                    <p className="text-xs text-muted-foreground">Push address (from Settings → General → Public address)</p>
                    <div className="flex min-w-0 items-start gap-2"><div className="min-w-0 flex-1"><Mono testId="backup-push-url">{d.setup.url}</Mono></div><CopyButton text={d.setup.url} label="Copy the push address" /></div>
                    {d.setup.warning && <p className="text-xs text-amber-800 dark:text-amber-300" data-testid="backup-url-warning">{d.setup.warning}</p>}
                  </div>
                  <div className="space-y-1">
                    <p className="text-xs text-muted-foreground">Headers</p>
                    <Mono>{d.setup.headers.map((h) => `${h.name}: ${h.name === 'Authorization' ? `Bearer ${st0r ? mask(st0r.id, st0r.pushTokenLast4) : '<token>'}` : h.value}`).join('\n')}</Mono>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    Body: JSON, contract version {d.setup.contractVersion} (<code>{'"v": 1'}</code>). At most {Math.round(d.setup.limits.bytes / 1048576)} MB, {d.setup.limits.assets} assets,
                    {' '}{d.setup.limits.jobsPerAsset} jobs, {d.setup.limits.pointsPerAsset} recovery points and {d.setup.limits.drillsPerAsset} drills per asset, {d.setup.limits.perMinute} requests a minute.
                    St0r&apos;s developers build to the <Link href="/docs/st0r-push-contract" className="underline">St0r push contract</Link>.
                  </p>
                </Step>

                <Step n={3} title="Send a test push (dry run)" testId="backup-step-test">
                  <p className="text-muted-foreground">St0r sends the same request to the address with <code>?dryRun=1</code>. Rem0te checks the token and the body exactly as for a real push, writes nothing but an audit entry, and answers what it would write, how each asset would link, and what is wrong.</p>
                  <div className="flex min-w-0 items-start gap-2"><div className="min-w-0 flex-1"><Mono testId="backup-curl">{curl}</Mono></div>{tokenNow && reveal ? <CopyButton text={curl} label="Copy the curl command" /> : null}</div>
                  {!(tokenNow && reveal) && <p className="text-xs text-muted-foreground">The token is masked. {tokenNow ? 'Reveal it above to copy a working command.' : 'It was shown once when it was made.'}</p>}
                  {st0r && (
                    <p className="text-xs" data-testid="backup-last-dryrun">
                      Last test push: {st0r.lastDryRun ? <>{when(st0r.lastDryRun.at)} — {st0r.lastDryRun.valid ? <span className="text-emerald-700 dark:text-emerald-400">valid</span> : <span className="text-destructive">{st0r.lastDryRun.issues} problem(s)</span>}{st0r.lastDryRun.warnings ? `, ${st0r.lastDryRun.warnings} warning(s)` : ''}</> : 'none yet'}.
                    </p>
                  )}
                </Step>

                <Step n={4} title="Push for real" testId="backup-step-push">
                  <Mono>{curlReal}</Mono>
                  <p className="text-xs text-muted-foreground">St0r pushes as backups finish, and its recent state at least every 15 minutes. Re-sending is always safe: every item is keyed by St0r&apos;s own id, and a finished job is never put back to running.</p>
                </Step>

                <Step n={5} title="Add backup monitors, and link assets to devices" testId="backup-step-after">
                  <p className="text-muted-foreground">
                    Alerts need a <em>Backup stale</em>, <em>Backup failed</em>, <em>Restore drill failed</em> or <em>RPO exceeded</em> monitor in{' '}
                    <Link href="/settings/monitoring" className="underline">Monitoring → Monitoring policies</Link>. They are raised on the device an asset is linked to.
                    An asset whose name St0r reports differently can be linked by hand on <Link href="/backups" className="underline">Backups</Link>.
                  </p>
                </Step>
              </ol>
            </CardContent>
          </Card>

          <Card data-testid="backup-settings-connections">
            <CardHeader><CardTitle className="text-sm">Connections</CardTitle></CardHeader>
            <CardContent className="space-y-3 text-sm">
              {live.length === 0 && <p className="text-muted-foreground">No connection for this customer yet.</p>}
              {live.map((c) => (
                <div key={c.id} className="min-w-0 space-y-2 rounded-md border p-3" data-testid="backup-connection" data-connection={c.id}>
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium">{c.label}</span>
                    <Badge variant="outline">{c.transport === 'push' ? 'pushes to Rem0te' : 'Rem0te reads it'}</Badge>
                    {c.lastResult && <Badge variant={c.lastResult === 'OK' ? 'secondary' : 'destructive'} data-testid="backup-connection-result">{c.lastResult === 'OK' ? 'last report OK' : c.lastResult}</Badge>}
                  </div>
                  <dl className="grid grid-cols-1 gap-x-4 gap-y-1 text-xs sm:grid-cols-2">
                    <div><dt className="inline text-muted-foreground">Last push: </dt><dd className="inline">{when(c.lastSyncAt)}</dd></div>
                    <div><dt className="inline text-muted-foreground">Assets: </dt><dd className="inline" data-testid="backup-connection-assets">{c.assetCount} ({c.linkedCount} linked to a device)</dd></div>
                    <div><dt className="inline text-muted-foreground">{c.transport === 'push' ? 'Token' : 'Credential'}: </dt><dd className="inline font-mono">…{c.pushTokenLast4 ?? c.credentialLast4 ?? '—'}</dd></div>
                    <div><dt className="inline text-muted-foreground">Created: </dt><dd className="inline">{when(c.createdAt)}{c.tokenRotatedAt ? ` · rotated ${when(c.tokenRotatedAt)}` : ''}</dd></div>
                  </dl>
                  {c.lastError && (
                    <p className="break-words rounded-md border border-destructive/40 bg-destructive/10 p-2 text-xs text-destructive" data-testid="backup-connection-error">
                      Last refused {when(c.lastErrorAt)}: {c.lastError}
                    </p>
                  )}
                  <div className="flex flex-wrap gap-2">
                    {c.transport === 'push' && <Button size="sm" variant="outline" disabled={rotate.isPending} onClick={() => setConfirm({ kind: 'rotate', conn: c })} data-testid="backup-rotate">{`Rotate token${reauthSuffix(ask)}`}</Button>}
                    <Button size="sm" variant="outline" disabled={revoke.isPending} onClick={() => setConfirm({ kind: 'revoke', conn: c })} data-testid="backup-revoke">Revoke</Button>
                  </div>
                </div>
              ))}
              {revoked.length > 0 && (
                <details className="text-xs text-muted-foreground"><summary className="cursor-pointer">{revoked.length} revoked</summary>
                  <ul className="mt-1 space-y-1">{revoked.map((c) => <li key={c.id}>{c.label} · revoked {when(c.revokedAt)} · {c.assetCount} assets kept</li>)}</ul>
                </details>
              )}
              <p className="text-xs text-muted-foreground">Rotating issues a new token and the old one stops working <strong>at once</strong> — no overlap, because a token is usually rotated when it may be known to someone else. Pushes refused meanwhile are simply sent again. Revoking is final and never asks you to confirm it is you.</p>
            </CardContent>
          </Card>

          {d.capabilities && (
            <Card data-testid="backup-settings-capabilities">
              <CardHeader><CardTitle className="text-sm">What works for this customer</CardTitle></CardHeader>
              <CardContent className="space-y-2 text-sm">
                {d.capabilities.map((c) => (
                  <div key={c.key} className="flex min-w-0 flex-col gap-1 border-b pb-2 last:border-b-0 sm:flex-row sm:items-start sm:gap-3" data-capability={c.key} data-state={c.state}>
                    <span className={`w-fit shrink-0 rounded-md border px-2 py-0.5 text-xs ${STATE[c.state].cls}`}>{STATE[c.state].label}</span>
                    <div className="min-w-0"><p className="font-medium">{c.label}</p><p className="text-xs text-muted-foreground">{c.note}</p></div>
                  </div>
                ))}
              </CardContent>
            </Card>
          )}

          {comet && (
            <Card data-testid="backup-settings-comet">
              <CardHeader><CardTitle className="flex flex-wrap items-center gap-2 text-sm">{comet.label}<span className={`rounded-md border px-2 py-0.5 text-xs ${STATE.planned.cls}`}>Planned</span></CardTitle></CardHeader>
              <CardContent className="space-y-2 text-sm">
                <p className="text-muted-foreground">{comet.stateNote} Creating a Comet connection is refused until it is built.</p>
                <p className="font-medium">What it will need</p>
                <ul className="list-disc space-y-1 pl-5 text-xs">{comet.prerequisites.map((x) => <li key={x}>{x}</li>)}</ul>
                <p className="font-medium">What it cannot do</p>
                <ul className="list-disc space-y-1 pl-5 text-xs">{comet.limitations.map((x) => <li key={x}>{x}</li>)}</ul>
              </CardContent>
            </Card>
          )}
        </>
      )}

      <ConfirmDialog
        open={!!confirm}
        onOpenChange={(o) => { if (!o) setConfirm(null); }}
        title={confirm?.kind === 'rotate' ? 'Rotate the push token?' : 'Revoke this connection?'}
        description={confirm?.kind === 'rotate'
          ? `A new token is shown once, and the current token (…${confirm?.conn.pushTokenLast4 ?? ''}) stops working immediately. St0r's pushes are refused until it has the new one. ${confirmSentence(ask)}`
          : `The token stops working for good and the connection cannot be reused; what ${confirm?.conn.label ?? 'it'} reported is kept. To connect again, create a new connection.`}
        confirmLabel={confirm?.kind === 'rotate' ? 'Rotate token' : 'Revoke'}
        destructive
        loading={rotate.isPending || revoke.isPending}
        onConfirm={() => { if (!confirm) return; if (confirm.kind === 'rotate') rotate.mutate(confirm.conn.id); else revoke.mutate(confirm.conn.id); }}
      />
    </div>
  );
}
