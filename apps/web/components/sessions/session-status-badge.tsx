import * as React from 'react';

import {
  Circle,
  CheckCircle,
  XCircle,
  Clock,
  HelpCircle,
  MonitorPlay,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { msaStageOf, STATUS_STAGE, stageOf, type RemoteStage, type SessionEvidence } from '@/lib/remote-states';

/**
 * Session status (0.91: in the directive's eight stages, lib/remote-states.ts,
 * the same words as the API's STATUS_LABEL in sessions/session-state.ts).
 *
 * Each status is tied to the one signal that can move a session into it, so
 * a label never claims more than that signal shows: "Authorization granted"
 * is a released credential, not a session; "Client opened" is RustDesk
 * starting on the technician's computer, not a connection; "Session active"
 * needs the computer's agent to still see the connection.
 */
/** A status's stage label when nothing but the status is known (0.91: the directive's eight, lib/remote-states.ts). */
export const SESSION_STATUS_LABEL: Record<string, string> = Object.fromEntries(
  Object.keys(STATUS_STAGE).map((k) => [k, stageOf({ status: k }).label]),
);

/** Closed states. Mirrors TERMINAL in session-state.ts. */
export const TERMINAL_SESSION_STATUSES = ['SESSION_COMPLETED', 'FAILED', 'CANCELED', 'STATUS_UNKNOWN'];

export function isTerminalSessionStatus(status: string | null | undefined) {
  return !!status && TERMINAL_SESSION_STATUSES.includes(status.toUpperCase());
}

/*
 * 0.91 (UX P1-5): the badge shows the directive's eight stages
 * (lib/remote-states.ts), worked out from the session's evidence, and says
 * what that evidence shows in its tooltip. Given only a status it cannot tell
 * "Session active" from "Device connection confirmed", so it says the
 * latter: never more than the row shows.
 */
const NEUTRAL = 'bg-muted text-muted-foreground border-border';

const STYLE: Record<RemoteStage, { icon: React.ElementType; className: string }> = {
  launch_requested: { icon: Clock, className: NEUTRAL },
  authorized: { icon: Clock, className: `${NEUTRAL} border-dashed` },
  client_opened: { icon: MonitorPlay, className: 'bg-sky-50 text-sky-800 border-sky-200 dark:bg-sky-950 dark:text-sky-200 dark:border-sky-900' },
  connection_confirmed: { icon: Circle, className: 'bg-blue-50 text-blue-800 border-blue-200 dark:bg-blue-950 dark:text-blue-100 dark:border-blue-900' },
  active: { icon: Circle, className: 'bg-green-100 text-green-800 border-green-200 dark:bg-green-900 dark:text-green-100 dark:border-green-800' },
  ended: { icon: CheckCircle, className: NEUTRAL },
  failed: { icon: XCircle, className: 'bg-red-100 text-red-800 border-red-200 dark:bg-red-900 dark:text-red-100 dark:border-red-800' },
  unknown: { icon: HelpCircle, className: 'bg-zinc-100 text-zinc-700 border-zinc-300 border-dashed dark:bg-zinc-900 dark:text-zinc-300 dark:border-zinc-700' },
};

interface SessionStatusBadgeProps {
  status: string;
  /** The session row (or its evidence fields): lets the badge say "Session active" when the agent still sees it. */
  session?: Omit<SessionEvidence, 'status'> | null;
  className?: string;
}

export function SessionStatusBadge({ status, session, className }: SessionStatusBadgeProps) {
  const v = stageOf({ ...(session ?? {}), status });
  const config = STYLE[v.stage];
  const Icon = config.icon;

  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-semibold whitespace-nowrap',
        config.className,
        className,
      )}
      title={v.detail}
      data-stage={v.stage}
      data-testid="session-stage"
    >
      <Icon className="h-3 w-3" aria-hidden="true" />
      {v.label}
      <span className="sr-only">. {v.detail}</span>
    </span>
  );
}

/**
 * 0.91 (P1-5): the steps a session has evidence for, in order, each with the
 * time its own signal arrived. A step with no time has not happened, as far
 * as anything can tell; the last line says what the evidence shows now.
 */
export function SessionStages({ session }: { session: Record<string, unknown> }) {
  const at = (k: string) => (typeof session[k] === 'string' ? new Date(session[k] as string) : null);
  const steps: { label: string; when: Date | null; note?: string }[] = [
    { label: 'Launch requested', when: at('createdAt') },
    { label: 'Authorization granted', when: at('launchRequestedAt') ?? at('launcherAckAt'), note: 'a credential was released' },
    { label: 'Client opened', when: at('clientOpenedAt'), note: 'on your own computer' },
    { label: 'Device connection confirmed', when: at('connectionConfirmedAt'), note: session.statusSource === 'technician' ? 'reported by the technician' : 'seen by the device’s agent' },
    { label: session.status === 'FAILED' ? 'Session failed' : session.status === 'STATUS_UNKNOWN' ? 'Connection state unknown' : 'Session ended', when: at('endedAt') ?? (isTerminalSessionStatus(session.status as string) ? at('completedAt') : null), note: session.endInferred ? 'inferred, not observed' : undefined },
  ];
  const v = stageOf(session as unknown as SessionEvidence);
  return (
    <div className="space-y-2" data-testid="session-stages">
      <ol className="space-y-1 text-sm">
        {steps.map((st) => (
          <li key={st.label} className={cn('flex flex-wrap items-baseline gap-x-2', !st.when && 'text-muted-foreground')} data-reached={st.when ? 'true' : 'false'}>
            <span aria-hidden="true">{st.when ? '✓' : '·'}</span>
            <span className={cn(st.when && 'font-medium')}>{st.label}</span>
            <span className="text-xs text-muted-foreground">
              {st.when ? st.when.toLocaleString() : 'not seen'}{st.when && st.note ? ` · ${st.note}` : ''}
            </span>
          </li>
        ))}
      </ol>
      <p className="rounded-md border bg-muted/40 px-3 py-2 text-xs text-muted-foreground" data-testid="session-stage-detail">
        <span className="font-medium text-foreground">{v.label}.</span> {v.detail}
      </p>
    </div>
  );
}

/** A managed grant's timeline step as one of the eight stages (0.91, P1-5). */
export function MsaStageBadge({ current, className }: { current: string; className?: string }) {
  const v = msaStageOf(current);
  const config = STYLE[v.stage];
  const Icon = config.icon;
  return (
    <span className={cn('inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-semibold whitespace-nowrap', config.className, className)}
      title={v.detail} data-stage={v.stage} data-testid="msa-stage">
      <Icon className="h-3 w-3" aria-hidden="true" />
      {v.label}
    </span>
  );
}
