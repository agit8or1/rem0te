'use client';

import * as React from 'react';
import Link from 'next/link';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, CheckCircle2, Circle, Copy, PauseCircle, PlayCircle, RotateCcw } from 'lucide-react';
import { PageHeader } from '@/components/common/page-header';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ConfirmDialog } from '@/components/common/confirm-dialog';
import { agentSigningApi } from '@/lib/api-client';
import { usePermissions, CAP } from '@/lib/auth';
import { useToast } from '@/hooks/use-toast';
import { formatDate } from '@/lib/utils';
import { ago } from '@/components/endpoints/workspace/device-model';

/**
 * Devices → Full agent (0.37): moving computers to the signed ("full")
 * agent, as four steps with their live state, each saying what to do when it
 * is not done. Everything here is read from GET /agent-signing/overview: the
 * counts are of the computers this person can see; the repository, the
 * automatic migration's mode and its state are platform facts. The portal
 * cannot see the timestamp timer on the signing host, so step 3 infers from
 * the expiry of the timestamp it serves, and says so.
 */

type Kind = 'standard' | 'migrating' | 'signed' | 'held' | 'not_eligible';
interface Row {
  id: string; name: string; business: { id: string; name: string } | null; kind: Kind; text: string; hold: string | null;
  online: boolean; lastSeenAt: string | null; agentVersion: string | null; onPublishedBuild: boolean | null; automatic: boolean | null;
}
interface Rollout {
  id: string; state: 'choosing_canary' | 'canary' | 'soaking' | 'rolling' | 'halted'; text: string; targetSha256: string; targetVersion: string | null;
  canary: { id: string | null; name: string } | null; canaryRequestedAt: string | null; canaryConfirmedAt: string | null; soakEndsAt: string | null;
  waitUntil: string | null; waitText: string | null; halted: { at: string; code: string; reason: string } | null; rollingAt: string | null; triedCanaries: number;
  progress: { requested: number; completed: number; open: number; stopped: number } | null;
}
interface Overview {
  platformAdmin: boolean;
  steps: {
    signing: { done: boolean; reason: string | null; command: string; docs: string };
    published: {
      done: boolean; agent: { sha256: string; version: string | null; commit: string | null } | null; tray: { sha256: string; version: string | null; commit: string | null } | null;
      portalVersion: string; behind: boolean | null; command: string;
    };
    timestamp: { done: boolean; expires: string | null; hoursLeft: number | null; state: 'fresh' | 'expiring' | 'expired' | 'unknown'; command: string; timer: string };
    computers: {
      done: boolean; counts: Record<Kind, number>; holds: Record<string, number>; notEligible: { linux: number; macos: number; other: number }; signedOnBuild: number;
      holdLabels: Record<string, string>;
      auto: {
        mode: 'off' | 'canary_then_all'; soakMinutes: number; processOn: boolean; gate: string | null; gateText: string | null; perHour: number;
        trustMode: string; legacyPortalMigration: boolean; rollout: Rollout | null;
      };
      rows: Row[]; total: number;
    };
  };
}

const KIND_LABEL: Record<Kind, string> = { standard: 'Standard', migrating: 'Moving', signed: 'Signed', held: 'Held', not_eligible: 'Not eligible' };
const STATE_LABEL: Record<Rollout['state'], string> = { choosing_canary: 'Choosing a canary', canary: 'Canary moving', soaking: 'Soaking', rolling: 'Moving the rest', halted: 'Halted' };

function apiMessage(e: unknown, fallback: string) {
  return (e as { response?: { data?: { message?: string | string[] } } })?.response?.data?.message?.toString() ?? fallback;
}

function Command({ text, label }: { text: string; label: string }) {
  const { toast } = useToast();
  return (
    <div className="flex items-start gap-2">
      <code className="block min-w-0 flex-1 break-all rounded bg-muted px-2 py-1.5 text-xs">{text}</code>
      <Button size="sm" variant="ghost" className="h-7 shrink-0 px-2" aria-label={`Copy: ${label}`}
        onClick={() => { navigator.clipboard?.writeText(text).then(() => toast({ title: 'Copied' })).catch(() => undefined); }}>
        <Copy className="h-3.5 w-3.5" />
      </Button>
    </div>
  );
}

function Step({ n, title, state, children }: { n: number; title: string; state: 'done' | 'todo' | 'warn'; children: React.ReactNode }) {
  const Icon = state === 'done' ? CheckCircle2 : state === 'warn' ? AlertTriangle : Circle;
  const tone = state === 'done' ? 'text-emerald-600 dark:text-emerald-400' : state === 'warn' ? 'text-amber-600 dark:text-amber-400' : 'text-muted-foreground';
  return (
    <li className="relative flex gap-3 pb-6 last:pb-0" data-testid={`full-agent-step-${n}`} data-state={state}>
      <span className="absolute left-[11px] top-7 bottom-0 w-px bg-border" aria-hidden />
      <Icon className={`relative z-10 mt-0.5 h-6 w-6 shrink-0 bg-background ${tone}`} aria-hidden />
      <div className="min-w-0 flex-1 space-y-2">
        <h2 className="text-sm font-semibold">
          <span className="text-muted-foreground">Step {n}.</span> {title}
          <span className="sr-only"> — {state === 'done' ? 'done' : state === 'warn' ? 'needs attention' : 'not done'}</span>
        </h2>
        <div className="space-y-2 text-sm">{children}</div>
      </div>
    </li>
  );
}

function AutoMigration({ a, admin }: { a: Overview['steps']['computers']['auto']; admin: boolean }) {
  const { toast } = useToast();
  const qc = useQueryClient();
  const [soak, setSoak] = React.useState(String(a.soakMinutes));
  const [confirm, setConfirm] = React.useState<null | 'resume' | 'restart'>(null);
  React.useEffect(() => { setSoak(String(a.soakMinutes)); }, [a.soakMinutes]);
  const done = () => qc.invalidateQueries({ queryKey: ['agent-signing-overview'] });
  const put = useMutation({
    mutationFn: (body: { mode?: 'off' | 'canary_then_all'; soakMinutes?: number }) => agentSigningApi.putAuto(body),
    onSuccess: () => { done(); toast({ title: 'Saved' }); },
    onError: (e) => toast({ title: 'Not saved', description: apiMessage(e, 'The request failed.'), variant: 'destructive' }),
  });
  const act = useMutation({
    mutationFn: (what: 'resume' | 'restart') => (what === 'resume' ? agentSigningApi.resume() : agentSigningApi.restart()),
    onSuccess: () => { setConfirm(null); done(); toast({ title: 'Done' }); },
    onError: (e) => { setConfirm(null); toast({ title: 'Not done', description: apiMessage(e, 'The request failed.'), variant: 'destructive' }); },
  });
  const r = a.rollout;
  const soakN = Number(soak);
  const soakValid = Number.isInteger(soakN) && soakN >= 15 && soakN <= 1440;
  return (
    <div className="rounded-md border p-3 space-y-2" data-testid="full-agent-auto" data-mode={a.mode} data-gate={a.gate ?? ''} data-state={r?.state ?? ''}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium">Automatic migration</span>
        <Badge variant={a.mode === 'off' ? 'outline' : 'secondary'}>{a.mode === 'off' ? 'Off' : 'Canary, then all'}</Badge>
        {!a.gate && r && <Badge variant={r.state === 'halted' ? 'destructive' : 'outline'}>{STATE_LABEL[r.state]}</Badge>}
      </div>
      {a.mode !== 'off' && (
        <p className="text-xs text-muted-foreground">
          One computer moves first. The rest move only after it has reported the signed agent on the published build for {a.soakMinutes} minutes with no failed
          update, at most {a.perHour} an hour (the automatic-update pace), skipping computers that are paused, in a staged rollout, opted out by their update
          policy, or not checking in. A failure or no confirmation within 2 hours halts it.
        </p>
      )}
      {a.gateText && <p className="text-xs">{a.gateText}</p>}
      {!a.gate && r && (
        <div className="space-y-1 text-xs" data-testid="full-agent-rollout">
          <p>{r.text}</p>
          {r.canary && (
            <p>
              Canary: {r.canary.id ? <Link className="underline" href={`/endpoints/${r.canary.id}`}>{r.canary.name}</Link> : r.canary.name}
              {r.canaryRequestedAt && <> · asked {ago(r.canaryRequestedAt)}</>}
              {r.canaryConfirmedAt && <> · confirmed {ago(r.canaryConfirmedAt)}</>}
            </p>
          )}
          {r.soakEndsAt && <p>Soak ends {formatDate(r.soakEndsAt)}.</p>}
          {r.waitText && r.waitUntil && r.state !== 'soaking' && <p className="text-muted-foreground">{r.waitText} By {formatDate(r.waitUntil)}.</p>}
          {r.halted && <p className="text-destructive" data-testid="full-agent-halted">Halted {ago(r.halted.at)}: {r.halted.reason}</p>}
          {r.progress && <p className="text-muted-foreground">This build, all businesses: {r.progress.requested} asked, {r.progress.completed} moved, {r.progress.open} in progress, {r.progress.stopped} stopped.</p>}
        </div>
      )}
      {admin ? (
        <div className="flex flex-wrap items-end gap-2 pt-1">
          {a.mode === 'off' ? (
            <Button size="sm" onClick={() => put.mutate({ mode: 'canary_then_all' })} disabled={put.isPending} data-testid="full-agent-turn-on">
              <PlayCircle className="mr-1.5 h-4 w-4" />Turn on
            </Button>
          ) : (
            <Button size="sm" variant="outline" onClick={() => put.mutate({ mode: 'off' })} disabled={put.isPending} data-testid="full-agent-turn-off">
              <PauseCircle className="mr-1.5 h-4 w-4" />Turn off
            </Button>
          )}
          <div className="flex items-end gap-1.5">
            <div className="space-y-1">
              <Label htmlFor="full-agent-soak" className="text-xs">Soak (minutes, 15–1440)</Label>
              <Input id="full-agent-soak" inputMode="numeric" className="h-8 w-24" value={soak} onChange={(e) => setSoak(e.target.value)} />
            </div>
            <Button size="sm" variant="outline" className="h-8" disabled={!soakValid || soakN === a.soakMinutes || put.isPending} onClick={() => put.mutate({ soakMinutes: soakN })}>Save</Button>
          </div>
          {r?.state === 'halted' && !a.gate && (
            <>
              <Button size="sm" variant="outline" onClick={() => setConfirm('resume')} data-testid="full-agent-resume"><PlayCircle className="mr-1.5 h-4 w-4" />Resume</Button>
              <Button size="sm" variant="outline" onClick={() => setConfirm('restart')} data-testid="full-agent-restart"><RotateCcw className="mr-1.5 h-4 w-4" />Restart with another canary</Button>
            </>
          )}
        </div>
      ) : (
        <p className="text-xs text-muted-foreground">A Platform Admin changes this.</p>
      )}
      <p className="text-xs text-muted-foreground">
        To move particular computers now, select them on <Link className="underline" href="/endpoints">All devices</Link> and use <strong>Upgrade to signed…</strong>,
        or press <strong>Upgrade to signed agent</strong> on a computer&apos;s Agent card. Follow every request on <Link className="underline" href="/endpoints/agent-migrations">Agent migrations</Link>.
      </p>
      {confirm && (
        <ConfirmDialog
          open
          onOpenChange={(o) => { if (!o && !act.isPending) setConfirm(null); }}
          title={confirm === 'resume' ? 'Resume with the same canary?' : 'Restart with another canary?'}
          description={confirm === 'resume'
            ? 'The same computer is asked again, and its 2-hour and soak clocks start from now. The rest still move only after it passes. You will be asked to confirm it is you.'
            : 'Another eligible computer is picked as the canary; this one is not picked again for this build. You will be asked to confirm it is you.'}
          confirmLabel={confirm === 'resume' ? 'Resume' : 'Restart'}
          loading={act.isPending}
          onConfirm={() => act.mutate(confirm)}
        />
      )}
    </div>
  );
}

export default function FullAgentPage() {
  const { can } = usePermissions();
  const allowed = can(CAP.COMPUTERS_VIEW);
  const { data, isLoading, isError } = useQuery<Overview>({
    queryKey: ['agent-signing-overview'],
    queryFn: () => agentSigningApi.overview().then((r) => r.data?.data),
    enabled: allowed,
    refetchInterval: 30_000,
  });
  const s = data?.steps;
  const c = s?.computers;

  return (
    <div className="p-4 sm:p-6 space-y-5">
      <PageHeader
        title="Full agent"
        description="Moving computers from the standard agent to the signed agent, which runs only code signed with keys this portal never holds. Four steps; this page reads each one's state from the server."
      />
      {!allowed ? <p className="text-sm text-muted-foreground">This page needs the View computers permission.</p> : (
        <>
          <div className="rounded-md border border-amber-500/40 bg-amber-500/5 p-3 text-xs" data-testid="full-agent-honest">
            The signed agent and its tray have not yet run on real Windows. The first computer that moves — the canary — is the first time; that is why
            the rest wait for it.
          </div>
          {isLoading && <p className="text-sm text-muted-foreground">Loading…</p>}
          {isError && <p className="text-sm text-destructive">The status could not be loaded.</p>}
          {s && c && (
            <Card>
              <CardContent className="p-4 sm:p-6">
                <ol className="space-y-0" data-testid="full-agent-steps">
                  <Step n={1} title="Signing set up on this server" state={s.signing.done ? 'done' : 'todo'}>
                    {s.signing.done ? (
                      <p className="text-muted-foreground">This server has a signed update repository.</p>
                    ) : (
                      <>
                        <p>Not yet{s.signing.reason ? `: ${s.signing.reason}` : '.'}</p>
                        <p className="text-muted-foreground">
                          Run this once, as root, from the source checkout. It creates a separate <code>rem0te-release</code> user that holds the keys (the portal cannot
                          read them), the repository, the commands below and the daily timestamp timer, and publishes the first release.
                        </p>
                        <Command text={s.signing.command} label="the setup command" />
                        <p className="text-muted-foreground">
                          Add <code>--apply-env</code> to have it put <code>UPDATE_REPO_DIR=/var/lib/rem0te-updates</code> in{' '}
                          <code>/etc/reboot-remote/api.env</code> (without it, it prints the line to add), then restart the API
                          (<code>sudo systemctl restart reboot-remote-api</code>). This step stays &ldquo;not yet&rdquo; until that restart.
                          The automatic migration below is on by default and asks its canary within a minute of it; turn it off first if
                          you want to wait. Afterwards, move the root keys off this server: <code>sudo rem0te-signed-export-root &lt;dir&gt;</code>.
                        </p>
                        <p><Link className="underline" href={s.signing.docs}>Update signing → The easy way</Link></p>
                      </>
                    )}
                  </Step>

                  <Step n={2} title="A signed agent is published" state={!s.published.done ? 'todo' : s.published.behind ? 'warn' : 'done'}>
                    {s.published.agent ? (
                      <>
                        <p>
                          Published: {s.published.agent.version ? `version ${s.published.agent.version}` : 'no version recorded'}
                          {s.published.agent.commit && <>, commit <code>{s.published.agent.commit.slice(0, 12)}</code></>}
                          {' '}· build <code>{s.published.agent.sha256.slice(0, 12)}…</code>. This portal is {s.published.portalVersion}.
                        </p>
                        {s.published.tray && <p className="text-xs text-muted-foreground">Tray: build <code>{s.published.tray.sha256.slice(0, 12)}…</code>{s.published.tray.version ? ` (${s.published.tray.version})` : ''}.</p>}
                        {s.published.behind && <p className="text-amber-700 dark:text-amber-400">The published agent is not this portal&apos;s version. Publish again:</p>}
                        {s.published.behind === null && <p className="text-xs text-muted-foreground">The signed target carries no version, so it cannot be compared with this portal.</p>}
                        {s.published.behind !== false && <Command text={s.published.command} label="the publish command" />}
                      </>
                    ) : (
                      <>
                        <p>No signed agent is published{s.signing.done ? '' : ' (step 1 first)'}.</p>
                        <p className="text-muted-foreground">Run after every release (it is the last step of each deploy): it builds the agent, tray and installer from the checkout, signs, verifies and publishes them.</p>
                        <Command text={s.published.command} label="the publish command" />
                      </>
                    )}
                  </Step>

                  <Step n={3} title="Timestamp kept fresh" state={s.timestamp.state === 'fresh' ? 'done' : s.timestamp.state === 'unknown' ? 'todo' : 'warn'}>
                    {s.timestamp.expires ? (
                      <p className={s.timestamp.state === 'fresh' ? '' : 'text-amber-700 dark:text-amber-400'}>
                        The timestamp this portal serves {s.timestamp.state === 'expired' ? 'expired' : 'expires'} {formatDate(s.timestamp.expires)}
                        {s.timestamp.hoursLeft !== null && s.timestamp.hoursLeft > 0 ? ` (in ${s.timestamp.hoursLeft < 48 ? `${s.timestamp.hoursLeft} h` : `${Math.floor(s.timestamp.hoursLeft / 24)} days`})` : ''}.
                        {s.timestamp.state === 'expired' && ' Every agent refuses updates until it is re-signed.'}
                        {s.timestamp.state === 'expiring' && ' Under 48 hours: the daily re-sign may not be running.'}
                      </p>
                    ) : <p>No timestamp is served yet (step 1 first).</p>}
                    <p className="text-xs text-muted-foreground">
                      The timer <code>{s.timestamp.timer}</code> re-signs it daily on this server. The portal cannot see that timer; this step only reads the expiry of
                      what it serves. To check the timer itself:
                    </p>
                    <Command text={s.timestamp.command} label="the status command" />
                  </Step>

                  <Step n={4} title="Computers moved" state={c.done ? 'done' : c.counts.migrating || c.counts.standard ? 'todo' : c.counts.held ? 'warn' : 'todo'}>
                    <div className="flex flex-wrap gap-2 text-xs" data-testid="full-agent-counts">
                      {(['standard', 'migrating', 'signed', 'held', 'not_eligible'] as Kind[]).map((k) => (
                        <Badge key={k} variant={k === 'held' && c.counts.held ? 'outline' : 'secondary'} data-kind={k}>{KIND_LABEL[k]}: {c.counts[k]}</Badge>
                      ))}
                    </div>
                    {c.counts.signed > 0 && <p className="text-xs text-muted-foreground">{c.signedOnBuild} of {c.counts.signed} signed computers run the published build; the others update themselves.</p>}
                    {c.counts.held > 0 && (
                      <ul className="text-xs space-y-0.5" data-testid="full-agent-holds">
                        {Object.entries(c.holds).map(([k, v]) => <li key={k}>{c.holdLabels[k] ?? k}: {v}</li>)}
                      </ul>
                    )}
                    {c.counts.not_eligible > 0 && (
                      <p className="text-xs text-muted-foreground">
                        Not eligible: {[c.notEligible.linux ? `${c.notEligible.linux} Linux` : '', c.notEligible.macos ? `${c.notEligible.macos} macOS` : '', c.notEligible.other ? `${c.notEligible.other} not reporting Windows` : ''].filter(Boolean).join(', ')}.
                        There is no signed agent for Linux or macOS; those agents only report.
                      </p>
                    )}
                    <AutoMigration a={c.auto} admin={data.platformAdmin} />
                    {c.rows.length > 0 && (
                      <details className="text-xs" open={c.total <= 25}>
                        <summary className="cursor-pointer text-sm font-medium">Computers ({c.total})</summary>
                        <ul className="mt-2 divide-y rounded-md border" data-testid="full-agent-computers">
                          {c.rows.map((r) => (
                            <li key={r.id} className="flex flex-wrap items-start gap-x-3 gap-y-1 p-2" data-kind={r.kind}>
                              <div className="min-w-0 flex-1 basis-48">
                                <Link href={`/endpoints/${r.id}`} className="font-medium hover:underline break-all">{r.name}</Link>
                                <p className="text-muted-foreground">{r.business?.name ?? '—'}{r.agentVersion ? ` · ${r.agentVersion}` : ''}{r.lastSeenAt ? ` · seen ${ago(r.lastSeenAt)}` : ''}</p>
                              </div>
                              <div className="min-w-0 flex-1 basis-56">
                                <Badge variant={r.kind === 'signed' ? 'secondary' : 'outline'}>{KIND_LABEL[r.kind]}</Badge>
                                <p className="mt-0.5 text-muted-foreground">{r.text}</p>
                              </div>
                            </li>
                          ))}
                        </ul>
                        {c.total > c.rows.length && <p className="mt-1 text-muted-foreground">Showing {c.rows.length} of {c.total}.</p>}
                      </details>
                    )}
                  </Step>
                </ol>
              </CardContent>
            </Card>
          )}
          {isLoading || !s ? null : (
            <p className="text-xs text-muted-foreground">
              More: <Link className="underline" href="/docs/update-signing#moving-computers-automatically-037">Update signing → Moving computers automatically</Link>
              {data?.platformAdmin && <> · <Link className="underline" href="/settings/security/update-signing">Settings → Security → Update signing</Link></>}
            </p>
          )}
        </>
      )}
    </div>
  );
}
