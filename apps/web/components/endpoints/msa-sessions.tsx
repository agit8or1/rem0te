'use client';

import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { msaSessionsApi } from '@/lib/api-client';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { apiError } from '@/components/security-controls/shared';
import { useToast } from '@/hooks/use-toast';
import { formatDate } from '@/lib/utils';

/**
 * Managed Secure Access sessions (0.73, build step 5). Every route used here
 * is behind MSA_GRANTS: the components below are mounted only after an
 * ungated readiness answer said `managedControls: true`, so with the switch
 * off the console requests none of them.
 *
 * The timeline is the API's (msa/session-timeline.ts): each step is something
 * the portal or the computer's signed agent observed. Launched means the
 * one-time password was handed over; it is never shown as Connected.
 */

export type TimelineStep = 'requested' | 'authorized' | 'received' | 'applied' | 'launched' | 'connected' | 'disconnected' | 'expired' | 'revoked' | 'failed';
export interface MsaSession {
  grantId: string; endpointId: string; technicianId: string;
  technician: { id: string; email: string; name: string | null } | null;
  source: 'test' | 'connect' | 'verify'; launchMode: string | null;
  mode: 'view' | 'control';
  permissions: { clipboard: boolean; files: boolean; audio: boolean; tunnel: boolean; restart: boolean };
  consent: 'required' | 'not_required';
  maxMinutes: number; idleMinutes: number; state: string; createdAt: string;
  mine: boolean; ready: boolean; canRevoke: boolean;
  timeline: { status: string; current: TimelineStep; live: boolean; steps: { step: TimelineStep; label: string; at: string; note?: string }[]; cannotSee: string[] };
  refused?: { code: string; message: string } | null;
  endpoint?: { id: string; name: string; hostname: string | null; businessId: string | null; businessName: string | null };
}

const SOURCE_TEXT: Record<MsaSession['source'], string> = { connect: 'Connect', test: 'Test grant', verify: 'Cutover verification' };

export function sessionWhat(s: Pick<MsaSession, 'mode' | 'permissions' | 'consent' | 'maxMinutes'>): string {
  const p = s.permissions;
  const extras = [p.clipboard && 'clipboard', p.files && 'file transfer', p.audio && 'audio'].filter(Boolean) as string[];
  return [
    s.mode === 'view' ? 'View only' : `Control${extras.length ? ` with ${extras.join(', ')}` : ''}`,
    s.consent === 'required' ? 'the person at the device must accept' : null,
    `up to ${s.maxMinutes} min`,
  ].filter(Boolean).join(' · ');
}

export function technicianText(s: MsaSession) {
  return s.technician ? (s.technician.name || s.technician.email) : 'someone no longer listed';
}

/** The steps, each with its time and note, then what the agent cannot see. */
export function SessionTimeline({ s }: { s: MsaSession }) {
  return (
    <div className="space-y-1.5" data-testid="msa-session-timeline">
      <ol className="space-y-1 border-l pl-3">
        {s.timeline.steps.map((t, i) => (
          <li key={`${t.step}-${i}`} data-step={t.step}>
            <span className="font-medium">{t.label}</span>
            <span className="text-muted-foreground"> · {formatDate(t.at)}</span>
            {t.note && <p className="text-muted-foreground">{t.note}</p>}
          </li>
        ))}
      </ol>
      {s.timeline.cannotSee.length > 0 && (
        <div className="text-muted-foreground" data-testid="msa-session-cannot-see">
          <p className="font-medium">What the agent cannot see</p>
          <ul className="list-disc pl-5">{s.timeline.cannotSee.map((c, i) => <li key={i}>{c}</li>)}</ul>
        </div>
      )}
    </div>
  );
}

/** Disconnect one session, after a confirmation. */
function DisconnectButton({ s, onDone }: { s: MsaSession; onDone: () => void }) {
  const { toast } = useToast();
  const [asking, setAsking] = useState(false);
  const revoke = useMutation({
    mutationFn: () => msaSessionsApi.revokeGrant(s.grantId),
    onSuccess: () => { setAsking(false); onDone(); toast({ title: 'Disconnect sent', description: 'The device\'s agent ends the session when it receives the signed revocation. If it is offline, the session still ends at its time limit.' }); },
    onError: (e: unknown) => toast({ title: 'Not disconnected', description: apiError(e).message, variant: 'destructive' }),
  });
  return (
    <>
      <Button size="sm" variant="outline" onClick={() => setAsking(true)} data-testid="msa-session-disconnect">Disconnect</Button>
      <Dialog open={asking} onOpenChange={setAsking}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Disconnect this session?</DialogTitle>
            <DialogDescription>
              {technicianText(s)}&apos;s session ({sessionWhat(s)}) is revoked now. The device&apos;s agent ends it when the signed revocation reaches it; nothing can extend it afterwards.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setAsking(false)}>Cancel</Button>
            <Button variant="destructive" disabled={revoke.isPending} onClick={() => revoke.mutate()} data-testid="msa-session-disconnect-confirm">Disconnect</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

/** The device page's Managed sessions list (View computers). */
export function MsaSessionsList({ endpointId }: { endpointId: string }) {
  const qc = useQueryClient();
  const [open, setOpen] = useState<string | null>(null);
  const { data, isError } = useQuery<{ sessions: MsaSession[]; canRevokeAny: boolean } | null>({
    queryKey: ['msa-sessions', endpointId],
    queryFn: () => msaSessionsApi.forEndpoint(endpointId).then((r) => r.data?.data ?? null),
    retry: false,
    refetchInterval: 10_000,
  });
  if (isError) return <p className="text-xs text-muted-foreground">Managed sessions could not be loaded.</p>;
  if (!data) return null;
  const done = () => { void qc.invalidateQueries({ queryKey: ['msa-sessions', endpointId] }); void qc.invalidateQueries({ queryKey: ['msa-managed', endpointId] }); };
  return (
    <div className="space-y-1.5 text-xs" data-testid="msa-sessions">
      <p className="font-medium">Managed sessions</p>
      {data.sessions.length === 0 ? <p className="text-muted-foreground">No managed sessions on this device yet.</p> : (
        <ul className="divide-y rounded-md border">
          {data.sessions.map((s) => (
            <li key={s.grantId} className="space-y-1.5 px-2.5 py-2" data-state={s.state} data-live={s.timeline.live ? 'true' : 'false'}>
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-medium" data-testid="msa-session-status">{s.timeline.status}</span>
                <span className="text-muted-foreground">{SOURCE_TEXT[s.source] ?? s.source} · {technicianText(s)} · {formatDate(s.createdAt)}</span>
                <span className="ml-auto flex gap-1.5">
                  <Button size="sm" variant="ghost" className="h-7 px-2 text-xs" onClick={() => setOpen(open === s.grantId ? null : s.grantId)} aria-expanded={open === s.grantId}>
                    {open === s.grantId ? 'Hide timeline' : 'Timeline'}
                  </Button>
                  {s.canRevoke && s.timeline.live && <DisconnectButton s={s} onDone={done} />}
                </span>
              </div>
              <p className="text-muted-foreground">{sessionWhat(s)}</p>
              {s.refused && <p className="text-destructive">{s.refused.message}</p>}
              {open === s.grantId && <SessionTimeline s={s} />}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// ── Connect through a session grant ─────────────────────────────────────────

const WAIT_STEPS: { step: TimelineStep; label: string }[] = [
  { step: 'authorized', label: 'Authorized: the launch policy allowed it and the grant was signed' },
  { step: 'received', label: 'Received by the device\'s agent' },
  { step: 'applied', label: 'Applied: every setting read back' },
];

/**
 * Connect on a managed and verified computer: POST connect, then follow the
 * grant until the agent reports it applied, then download the Connect script
 * (which carries the one-time password and works once) — the same hand-over
 * as a Legacy Connect. Refusals are shown as the API words them.
 */
export function useManagedConnect(endpointId: string) {
  const { toast } = useToast();
  const [grantId, setGrantId] = useState<string | null>(null);
  const [startedAt, setStartedAt] = useState(0);
  const [timeoutMs, setTimeoutMs] = useState(60_000);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const launched = useRef(false);
  const start = useMutation({
    mutationFn: (mode?: 'view_only') => msaSessionsApi.connect(endpointId, mode).then((r) => r.data?.data as { grantId: string; applyTimeoutMs?: number }),
    onMutate: () => { setError(null); setGrantId(null); launched.current = false; setOpen(true); },
    onSuccess: (d) => { setGrantId(d.grantId); setStartedAt(Date.now()); setTimeoutMs(d.applyTimeoutMs ?? 60_000); },
    onError: (e: unknown) => setError(apiError(e, 'The session could not be started.').message),
  });
  const { data: session } = useQuery<MsaSession | null>({
    queryKey: ['msa-session-grant', grantId],
    queryFn: () => msaSessionsApi.grant(grantId!).then((r) => r.data?.data ?? null),
    enabled: open && !!grantId,
    retry: false,
    refetchInterval: (q) => {
      const s = q.state.data as MsaSession | null | undefined;
      return s && !s.timeline.live ? false : launched.current ? 3_000 : 1_000;
    },
  });
  useEffect(() => {
    if (!session?.ready || launched.current) return;
    launched.current = true;
    window.location.href = msaSessionsApi.connectScriptUrl(session.grantId);
    toast({ title: session.mode === 'view' ? 'Starting a view-only session' : 'Starting the session', description: `Managed session: ${sessionWhat(session)}. The Connect script carries a one-time password and works once.` });
  }, [session, toast]);
  return {
    connect: (mode?: 'view_only') => start.mutate(mode),
    pending: start.isPending || (open && !!grantId && !session?.ready && !!session?.timeline.live && !launched.current),
    dialog: (
      <ManagedConnectDialog
        open={open} onOpenChange={setOpen} error={error} session={session ?? null}
        startedAt={startedAt} timeoutMs={timeoutMs} launched={launched.current} starting={start.isPending}
      />
    ),
  };
}

function ManagedConnectDialog(p: {
  open: boolean; onOpenChange: (o: boolean) => void; error: string | null; session: MsaSession | null;
  startedAt: number; timeoutMs: number; launched: boolean; starting: boolean;
}) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!p.open) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [p.open]);
  const s = p.session;
  const seen = new Set(s?.timeline.steps.map((x) => x.step) ?? []);
  const left = p.startedAt ? Math.max(0, Math.ceil((p.startedAt + p.timeoutMs - now) / 1000)) : null;
  const ended = !!s && !s.timeline.live;
  return (
    <Dialog open={p.open} onOpenChange={p.onOpenChange}>
      <DialogContent data-testid="msa-connect-dialog">
        <DialogHeader>
          <DialogTitle>Managed session</DialogTitle>
          <DialogDescription>
            This device is in Managed Secure Access: it connects through a short-lived session grant that its signed agent applies and checks. There is no permanent password to launch with.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-2 text-sm">
          {p.error ? (
            <p className="text-destructive" data-testid="msa-connect-error">{p.error}</p>
          ) : (
            <>
              <ol className="space-y-1" data-testid="msa-connect-steps">
                {WAIT_STEPS.map((w) => (
                  <li key={w.step} data-done={seen.has(w.step) ? 'true' : 'false'} className={seen.has(w.step) ? '' : 'text-muted-foreground'}>
                    {seen.has(w.step) ? '✓' : '…'} {w.label}
                  </li>
                ))}
                {(seen.has('launched') || p.launched) && <li>✓ Launched: the Connect script was downloaded. This is not yet a connection.</li>}
                {seen.has('connected') && <li>✓ Connected, as the agent saw it (RustDesk accepted a connection)</li>}
              </ol>
              {s && <p className="text-xs" data-testid="msa-connect-status">{s.timeline.status}</p>}
              {s?.refused && <p className="text-destructive" data-testid="msa-connect-refused">{s.refused.message}</p>}
              {!seen.has('applied') && !ended && left !== null && (
                <p className="text-xs text-muted-foreground">Waiting for the device&apos;s agent: up to {left} s more. If it does not apply the grant in time, the grant is revoked and nothing connects.</p>
              )}
              {p.starting && <p className="text-xs text-muted-foreground">Asking the launch policy…</p>}
              {s && <p className="text-xs text-muted-foreground">{sessionWhat(s)}</p>}
            </>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => p.onOpenChange(false)}>Close</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
