'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, Loader2, Power, ShieldAlert, TerminalSquare, Timer } from 'lucide-react';
import { terminalApi } from '@/lib/api-client';
import { CAP, usePermissions } from '@/lib/auth';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { useToast } from '@/hooks/use-toast';
import { compareVersions } from '@/lib/device-tools';
import { agentType, ago } from './device-model';

/**
 * Terminal (0.77 Conduit, docs/remote-terminal.md): a background cmd or
 * PowerShell on a Windows computer running the signed agent, with no screen
 * sharing. It runs as SYSTEM — full control of the computer — and the panel
 * says so wherever it can be opened.
 *
 * Everything is the server's: opening (a Platform Admin only, a reason, a
 * fresh confirmation when the policy asks, which the api-client interceptor
 * prompts for), the state, both clocks, who may end it. The agent's worker
 * starts at the computer's next check-in (up to about three minutes) and
 * polls; this panel reads the output about once a second. Reading never
 * moves the idle clock — only typing and Keep alive do — so reopening the
 * page continues the session without extending it.
 *
 * Output is shown as text (React escapes it), decoded as UTF-8: cmd and
 * Windows PowerShell write the console code page, so accented characters may
 * show as replacement marks (`chcp 65001` in cmd changes that).
 */

type Session = {
  id: string; shell: 'cmd' | 'powershell'; state: 'pending' | 'open' | 'ended'; reason: string;
  technicianId: string; technicianEmail: string | null; mine: boolean; retained: boolean;
  createdAt: string; startedAt: string | null; endedAt: string | null; endReason: string | null;
  notAfter: string; lastActivityAt: string; idleSeconds: number; totalSeconds: number;
  bytesIn: number; bytesOut: number; exitCode: number | null; identity: 'SYSTEM'; canEnd: boolean;
};
type ListView = { sessions: Session[]; limits: { idleMinutes: number; maxMinutes: number; minAgent: string } };

const MAX_SCREEN = 256 * 1024;

const END_TEXT: Record<string, string> = {
  closed: 'Closed by its technician',
  revoked: 'Revoked',
  expired_idle: 'Ended: 15 minutes without input',
  expired_max: 'Ended: the 60-minute limit',
  paused: 'Ended: remote access was paused by containment',
  exited: 'The shell exited',
  agent_refused: 'The device refused to start the shell',
  agent_error: 'The device lost the shell',
  output_cap: 'Ended: the output limit (8 MB)',
  input_cap: 'Ended: the input limit (1 MB)',
  endpoint_unavailable: 'Ended: the device is no longer available',
};

const mmss = (s: number) => `${Math.floor(Math.max(0, s) / 60)}:${String(Math.max(0, s) % 60).padStart(2, '0')}`;
const errText = (e: unknown, fallback: string) =>
  (e as { response?: { data?: { message?: string | string[] } } })?.response?.data?.message?.toString() ?? fallback;
const errCode = (e: unknown) => (e as { response?: { data?: { code?: string } } })?.response?.data?.code;

function decode(b64: string): string {
  try {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
  } catch {
    return '';
  }
}

export function DeviceTerminalTab({ endpointId, ep }: { endpointId: string; ep: Record<string, unknown> }) {
  const { can } = usePermissions();
  const canOpen = can(CAP.COMPUTERS_TERMINAL);
  const qc = useQueryClient();
  const { toast } = useToast();
  const agent = agentType(ep);
  const windowsSigned = agent.kind === 'signed' && !agent.readOnlyOs;

  const list = useQuery<ListView>({
    queryKey: ['terminal', endpointId],
    queryFn: () => terminalApi.list(endpointId).then((r) => r.data.data as ListView),
    refetchInterval: 5_000,
    retry: false,
  });
  const sessions = list.data?.sessions ?? [];
  const mine = sessions.find((s) => s.mine && s.state !== 'ended') ?? null;
  const [viewing, setViewing] = useState<string | null>(null);
  useEffect(() => { if (mine && viewing !== mine.id) setViewing(mine.id); }, [mine, viewing]);

  const minAgent = list.data?.limits.minAgent ?? '0.77.0';
  const versionOk = typeof ep.agentVersion === 'string' && (compareVersions(ep.agentVersion, minAgent) ?? -1) >= 0;

  const [shell, setShell] = useState<'cmd' | 'powershell'>('powershell');
  const [reason, setReason] = useState('');
  const openM = useMutation({
    mutationFn: () => terminalApi.open(endpointId, { shell, reason }).then((r) => r.data.data as Session),
    onSuccess: (s) => {
      setReason('');
      setViewing(s.id);
      void qc.invalidateQueries({ queryKey: ['terminal', endpointId] });
    },
    onError: (e) => toast({ title: 'Terminal not opened', description: errText(e, 'The terminal could not be opened.'), variant: 'destructive' }),
  });
  const endM = useMutation({
    mutationFn: (sid: string) => terminalApi.end(endpointId, sid),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['terminal', endpointId] }),
    onError: (e) => toast({ title: 'Not ended', description: errText(e, 'The session could not be ended.'), variant: 'destructive' }),
  });

  const [transcript, setTranscript] = useState<{ id: string; text: string } | null>(null);
  const showTranscript = async (sid: string) => {
    try {
      const r = await terminalApi.transcript(endpointId, sid);
      const chunks = (r.data.data?.chunks ?? []) as { dir: 'in' | 'out'; data: string }[];
      setTranscript({ id: sid, text: chunks.map((c) => (c.dir === 'in' ? `> ${decode(c.data)}` : decode(c.data))).join('') });
    } catch (e) {
      toast({ title: 'No transcript', description: errText(e, 'The transcript could not be read.'), variant: 'destructive' });
    }
  };

  return (
    <div className="space-y-4" data-testid="terminal-tab">
      <div className="flex items-start gap-2 rounded-md border border-red-300 bg-red-50 p-3 text-sm text-red-900 dark:border-red-900 dark:bg-red-950/40 dark:text-red-200" role="note" data-testid="terminal-identity">
        <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
        <p><strong>SYSTEM — full control of this device.</strong> A terminal runs cmd or PowerShell in the background as the agent does, with no screen sharing and nothing shown to the person at the device. Every session is recorded in the audit log with its reason; what is typed and printed is kept only when this customer keeps transcripts.</p>
      </div>

      {!windowsSigned ? (
        <Card><CardContent className="pt-6 text-sm text-muted-foreground" data-testid="terminal-unsupported">
          A terminal needs a Windows device running the full (signed) agent {minAgent} or later. {agent.explanation}
        </CardContent></Card>
      ) : !versionOk ? (
        <Card><CardContent className="pt-6 text-sm text-muted-foreground" data-testid="terminal-unsupported">
          This device’s agent ({String(ep.agentVersion ?? 'unknown')}) is older than {minAgent}, which first ran a terminal. Let it update first.
        </CardContent></Card>
      ) : null}

      {viewing && <LiveTerminal key={viewing} endpointId={endpointId} sid={viewing} onClosed={() => void qc.invalidateQueries({ queryKey: ['terminal', endpointId] })} onDismiss={() => setViewing(null)} />}

      {canOpen && windowsSigned && versionOk && !mine && (
        <Card data-testid="terminal-open">
          <CardHeader className="pb-2"><CardTitle className="flex items-center gap-2 text-base"><TerminalSquare className="h-4 w-4" />Open a terminal</CardTitle></CardHeader>
          <CardContent>
            <form className="grid gap-3 sm:grid-cols-[10rem_1fr_auto] sm:items-end" onSubmit={(e) => { e.preventDefault(); openM.mutate(); }}>
              <div className="space-y-1">
                <Label htmlFor="terminal-shell">Shell</Label>
                <select id="terminal-shell" value={shell} onChange={(e) => setShell(e.target.value as 'cmd' | 'powershell')} data-testid="terminal-shell"
                  className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm">
                  <option value="powershell">PowerShell</option>
                  <option value="cmd">Command Prompt (cmd)</option>
                </select>
              </div>
              <div className="space-y-1">
                <Label htmlFor="terminal-reason">Reason (recorded in the audit log)</Label>
                <Input id="terminal-reason" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} placeholder="e.g. Ticket 4812: printer queue stuck" data-testid="terminal-reason" />
              </div>
              <Button type="submit" disabled={openM.isPending || reason.trim().length < 3} data-testid="terminal-open-button">
                {openM.isPending && <Loader2 className="mr-1 h-4 w-4 animate-spin" />}Open as SYSTEM
              </Button>
            </form>
            <p className="mt-2 text-xs text-muted-foreground">It starts at the device’s next check-in, which can take up to about three minutes. It ends after {list.data?.limits.idleMinutes ?? 15} minutes without input and after {list.data?.limits.maxMinutes ?? 60} minutes in all, whatever happens.</p>
          </CardContent>
        </Card>
      )}
      {!canOpen && (
        <p className="text-sm text-muted-foreground" data-testid="terminal-not-permitted">Only a Platform Admin can open a terminal. You can see who opened one here, and end a session if you may edit this device.</p>
      )}

      <Card>
        <CardHeader className="pb-2"><CardTitle className="text-base">Recent terminal sessions</CardTitle></CardHeader>
        <CardContent>
          {list.isLoading ? <p className="text-sm text-muted-foreground">Loading…</p>
            : list.isError ? <p className="text-sm text-muted-foreground">{errText(list.error, 'Could not read the sessions.')}</p>
              : sessions.length === 0 ? <p className="text-sm text-muted-foreground" data-testid="terminal-none">No terminal has been opened on this device.</p>
                : (
                  <ul className="divide-y text-sm" data-testid="terminal-sessions">
                    {sessions.map((s) => (
                      <li key={s.id} className="flex flex-wrap items-center justify-between gap-2 py-2" data-testid="terminal-session-row" data-state={s.state}>
                        <div className="min-w-0">
                          <div className="font-medium">{s.shell === 'cmd' ? 'cmd' : 'PowerShell'} · {s.technicianEmail ?? 'a technician'} · {s.state === 'ended' ? (END_TEXT[s.endReason ?? ''] ?? s.endReason) : s.state === 'open' ? 'Open' : 'Waiting for the device'}</div>
                          <div className="break-words text-xs text-muted-foreground">“{s.reason}” · opened {ago(s.createdAt)} · {s.bytesIn} B in, {s.bytesOut} B out{s.exitCode != null ? ` · exit ${s.exitCode}` : ''}</div>
                        </div>
                        <div className="flex gap-2">
                          {s.retained && canOpen && <Button size="sm" variant="outline" onClick={() => void showTranscript(s.id)}>Transcript</Button>}
                          {s.canEnd && !s.mine && <Button size="sm" variant="destructive" onClick={() => endM.mutate(s.id)} disabled={endM.isPending} data-testid="terminal-revoke">End session</Button>}
                        </div>
                      </li>
                    ))}
                  </ul>
                )}
        </CardContent>
      </Card>

      <Dialog open={!!transcript} onOpenChange={(o) => { if (!o) setTranscript(null); }}>
        <DialogContent className="max-w-3xl w-[calc(100vw-1rem)]">
          <DialogHeader>
            <DialogTitle>Transcript</DialogTitle>
            <DialogDescription>Kept because this customer keeps terminal transcripts. Lines you typed start with “&gt;”.</DialogDescription>
          </DialogHeader>
          <pre className="max-h-[60vh] overflow-auto whitespace-pre-wrap break-words rounded bg-muted p-3 font-mono text-xs">{transcript?.text || '(empty)'}</pre>
        </DialogContent>
      </Dialog>
    </div>
  );
}

/** One live session of the person's own: the screen, the clocks, typing, Keep alive and End. */
function LiveTerminal({ endpointId, sid, onClosed, onDismiss }: { endpointId: string; sid: string; onClosed: () => void; onDismiss: () => void }) {
  const { toast } = useToast();
  const [text, setText] = useState('');
  const [session, setSession] = useState<Session | null>(null);
  const [readAt, setReadAt] = useState(Date.now());
  const [now, setNow] = useState(Date.now());
  const [line, setLine] = useState('');
  const after = useRef(0);
  const screen = useRef<HTMLPreElement>(null);

  useEffect(() => {
    let stop = false;
    let timer: ReturnType<typeof setTimeout>;
    const tick = async () => {
      try {
        const r = await terminalApi.read(endpointId, sid, after.current);
        const d = r.data.data as { session: Session; frames: { seq: number; data: string }[] };
        if (stop) return;
        if (d.frames.length) {
          const add = d.frames.map((f) => decode(f.data)).join('');
          after.current = d.frames[d.frames.length - 1].seq;
          setText((t) => (t + add).slice(-MAX_SCREEN));
        }
        setSession(d.session);
        setReadAt(Date.now());
        if (d.session.state === 'ended') { onClosed(); return; }
        timer = setTimeout(tick, d.frames.length ? 200 : 900);
      } catch (e) {
        if (stop) return;
        if (errCode(e) === 'TERMINAL_ENDED' || (e as { response?: { status?: number } })?.response?.status === 404) { onClosed(); return; }
        timer = setTimeout(tick, 3000);
      }
    };
    void tick();
    return () => { stop = true; clearTimeout(timer); };
  }, [endpointId, sid, onClosed]);
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(t); }, []);
  useEffect(() => { if (screen.current) screen.current.scrollTop = screen.current.scrollHeight; }, [text]);

  const elapsed = Math.floor((now - readAt) / 1000);
  const idleLeft = session ? session.idleSeconds - elapsed : 0;
  const totalLeft = session ? session.totalSeconds - elapsed : 0;
  const live = session && session.state !== 'ended';

  const send = useMutation({
    mutationFn: (data: string) => terminalApi.input(endpointId, sid, data),
    onError: (e) => toast({ title: 'Not sent', description: errText(e, 'The input was not sent.'), variant: 'destructive' }),
  });
  const keep = useMutation({
    mutationFn: () => terminalApi.keepAlive(endpointId, sid).then((r) => r.data.data as Session),
    onSuccess: (s) => { setSession(s); setReadAt(Date.now()); },
  });
  const end = useMutation({
    mutationFn: () => terminalApi.end(endpointId, sid),
    onSuccess: () => onClosed(),
  });
  const stateText = useMemo(() => {
    if (!session) return 'Connecting…';
    if (session.state === 'pending') return 'Waiting for the device to start the shell (its next check-in)…';
    if (session.state === 'open') return 'Connected';
    return END_TEXT[session.endReason ?? ''] ?? `Ended (${session.endReason})`;
  }, [session]);

  return (
    <Card data-testid="terminal-live" data-state={session?.state ?? 'loading'}>
      <CardHeader className="pb-2">
        <CardTitle className="flex flex-wrap items-center justify-between gap-2 text-base">
          <span className="flex items-center gap-2"><TerminalSquare className="h-4 w-4" />{session?.shell === 'cmd' ? 'Command Prompt' : 'PowerShell'} <span className="text-xs font-normal text-muted-foreground">as SYSTEM</span></span>
          <span className="flex items-center gap-1 text-xs font-normal" data-testid="terminal-state">
            {session?.state === 'pending' && <Loader2 className="h-3 w-3 animate-spin" />}
            {session?.state === 'ended' && <AlertTriangle className="h-3 w-3" />}
            {stateText}
          </span>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-2">
        {live && (
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground" data-testid="terminal-clocks">
            <span className="flex items-center gap-1"><Timer className="h-3 w-3" />Idle limit in <strong className="text-foreground" data-testid="terminal-idle">{mmss(idleLeft)}</strong></span>
            <span>Session ends in <strong className="text-foreground" data-testid="terminal-total">{mmss(totalLeft)}</strong> (never extended)</span>
          </div>
        )}
        <pre ref={screen} data-testid="terminal-screen" aria-live="polite"
          className="h-72 overflow-auto whitespace-pre-wrap break-words rounded-md bg-zinc-950 p-3 font-mono text-xs leading-relaxed text-zinc-100 sm:h-96">
          {text || (session?.state === 'pending' ? 'The shell starts when the device next checks in…' : '')}
        </pre>
        {live && (
          <form className="flex flex-col gap-2 sm:flex-row" onSubmit={(e) => {
            e.preventDefault();
            if (!line) return;
            send.mutate(`${line}\n`);
            setLine('');
          }}>
            <Input value={line} onChange={(e) => setLine(e.target.value)} placeholder={session?.state === 'pending' ? 'Waiting for the shell…' : 'Type a command and press Enter'}
              disabled={session?.state !== 'open'} maxLength={4000} autoComplete="off" spellCheck={false} className="font-mono" aria-label="Command" data-testid="terminal-input" />
            <div className="flex gap-2">
              <Button type="submit" disabled={session?.state !== 'open' || !line || send.isPending}>Send</Button>
              <Button type="button" variant="outline" onClick={() => keep.mutate()} disabled={keep.isPending} data-testid="terminal-keepalive">Keep alive</Button>
              <Button type="button" variant="destructive" onClick={() => end.mutate()} disabled={end.isPending} data-testid="terminal-end"><Power className="mr-1 h-4 w-4" />End session</Button>
            </div>
          </form>
        )}
        {!live && session && (
          <div className="flex justify-end"><Button variant="outline" size="sm" onClick={onDismiss}>Close</Button></div>
        )}
      </CardContent>
    </Card>
  );
}
