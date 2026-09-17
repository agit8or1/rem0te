'use client';

import { useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { endpointsApi } from '@/lib/api-client';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { useToast } from '@/hooks/use-toast';
import { formatDate } from '@/lib/utils';
import { ScrollText, Search, Loader2, AlertTriangle, ChevronDown, ChevronRight } from 'lucide-react';

/**
 * Reading a Windows event log off a managed computer.
 *
 * There is no channel to reach into an endpoint, so this is a request, not a
 * query: the server stages it, the computer collects it on its next heartbeat,
 * runs `Get-WinEvent` and posts the page back. That means up to about three
 * minutes of waiting, and the UI is built around that rather than pretending
 * to be live — a spinner with no explanation reads as a hang.
 *
 * The log names here match the server's allowlist. Sending anything else is
 * rejected server-side; the select exists so nobody has to guess.
 */

const LOGS = ['Application', 'System', 'Security', 'Setup', 'Windows PowerShell'] as const;

/**
 * Windows levels, as a person thinks of them.
 *
 * Information is two numbers. Level 0 is `LogAlways`, which is what almost
 * every Security log entry is — Event Viewer shows those as Information, but
 * they are not level 4. Offering only 4 meant that picking
 * Critical/Error/Warning, the obvious default for troubleshooting, returned an
 * empty table from the Security log and looked like a broken feature.
 */
const LEVELS = [
  { values: [1], label: 'Critical' },
  { values: [2], label: 'Error' },
  { values: [3], label: 'Warning' },
  { values: [4, 0], label: 'Information' },
] as const;

const RANGES = [
  { value: 1, label: 'Last hour' },
  { value: 6, label: 'Last 6 hours' },
  { value: 24, label: 'Last 24 hours' },
  { value: 72, label: 'Last 3 days' },
  { value: 168, label: 'Last 7 days' },
  { value: 336, label: 'Last 14 days' },
] as const;

const COUNTS = [25, 50, 100, 200] as const;

interface EventRow {
  timeCreated: string | null;
  eventId: number | null;
  level: number | null;
  levelName: string | null;
  provider: string | null;
  message: string | null;
}

interface CommandRow {
  id: string;
  status: 'PENDING' | 'DISPATCHED' | 'SUCCEEDED' | 'FAILED' | 'EXPIRED';
  error: string | null;
  params: { logName?: string; sinceHours?: number; maxEvents?: number } | null;
  result: { events?: EventRow[] } | null;
  createdAt: string;
  completedAt: string | null;
}

function LevelBadge({ level, name }: { level: number | null; name: string | null }) {
  const label = name ?? (level !== null ? `Level ${level}` : 'Unknown');
  const tone =
    level === 1 ? 'bg-red-600 text-white'
    : level === 2 ? 'bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-300'
    : level === 3 ? 'bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300'
    : 'bg-muted text-muted-foreground';
  return (
    <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium ${tone}`}>
      {label}
    </span>
  );
}

function EventRowView({ row }: { row: EventRow }) {
  const [open, setOpen] = useState(false);
  const message = row.message ?? '';
  // One line is enough to recognise an event; the rest is behind a click
  // because a Windows event message is routinely thirty lines of XML prose.
  const firstLine = message.split('\n')[0];
  const hasMore = message.length > firstLine.length;

  return (
    <div className="border-b last:border-0 py-2">
      <div className="flex items-start gap-3">
        <div className="shrink-0 w-[150px] text-xs text-muted-foreground font-mono pt-0.5">
          {row.timeCreated ? formatDate(row.timeCreated) : '—'}
        </div>
        <div className="shrink-0 pt-0.5">
          <LevelBadge level={row.level} name={row.levelName} />
        </div>
        <div className="shrink-0 w-[70px] text-xs font-mono text-muted-foreground pt-0.5">
          {row.eventId ?? '—'}
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-xs text-muted-foreground truncate">{row.provider ?? '—'}</div>
          <div className="text-sm whitespace-pre-wrap break-words">
            {open ? message : firstLine}
          </div>
          {hasMore && (
            <button
              onClick={() => setOpen((o) => !o)}
              className="mt-1 flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
            >
              {open ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
              {open ? 'Less' : 'More'}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

export function EndpointEventLog({
  endpointId,
  isOnline,
}: {
  endpointId: string;
  isOnline: boolean;
}) {
  const { toast } = useToast();

  const [logName, setLogName] = useState<string>('System');
  const [sinceHours, setSinceHours] = useState<number>(24);
  const [maxEvents, setMaxEvents] = useState<number>(50);
  const [levels, setLevels] = useState<number[]>([1, 2, 3]);
  const [provider, setProvider] = useState('');
  const [commandId, setCommandId] = useState<string | null>(null);

  const request = useMutation({
    mutationFn: () =>
      endpointsApi.requestEventLog(endpointId, {
        logName,
        levels,
        maxEvents,
        sinceHours,
        ...(provider.trim() ? { providerName: provider.trim() } : {}),
      }),
    onSuccess: (res) => {
      const id = (res.data?.data as { commandId?: string } | undefined)?.commandId ?? null;
      setCommandId(id);
    },
    onError: (e: unknown) => {
      const message =
        (e as { response?: { data?: { message?: string } } })?.response?.data?.message ??
        'Could not queue the request';
      toast({ title: 'Error', description: message, variant: 'destructive' });
    },
  });

  // Whatever was last asked of this machine, so the tab opens with content
  // instead of a blank form. Only consulted until this session makes its own
  // request, at which point `commandId` takes over.
  const { data: previous } = useQuery({
    queryKey: ['endpoint-event-log-latest', endpointId],
    queryFn: () =>
      endpointsApi.latestEventLog(endpointId).then(
        (r) => (r.data?.data ?? null) as CommandRow | null,
      ),
    enabled: !commandId,
    staleTime: 30_000,
  });

  const { data: command } = useQuery({
    queryKey: ['endpoint-command', endpointId, commandId],
    queryFn: () =>
      endpointsApi.command(endpointId, commandId as string).then(
        (r) => r.data?.data as CommandRow,
      ),
    enabled: !!commandId,
    // Polled only while the endpoint still has it. `false` stops the interval
    // outright — an outstanding request that has landed must not keep the page
    // hitting the API every few seconds for the rest of the session.
    refetchInterval: (q) => {
      const s = q.state.data?.status;
      return s === 'PENDING' || s === 'DISPATCHED' ? 4000 : false;
    },
  });

  // This session's request wins; otherwise fall back to the stored one.
  const shown = command ?? previous ?? null;
  const waiting = shown?.status === 'PENDING' || shown?.status === 'DISPATCHED';
  const events = shown?.status === 'SUCCEEDED' ? shown.result?.events ?? [] : [];
  // A result nobody on this screen asked for gets said so, rather than
  // implying the Fetch button produced it.
  const isHistoric = !command && !!previous;

  function toggleLevel(values: readonly number[]) {
    setLevels((cur) =>
      values.every((v) => cur.includes(v))
        ? cur.filter((l) => !values.includes(l))
        : [...cur, ...values.filter((v) => !cur.includes(v))],
    );
  }

  // Asking for the Security log at Critical/Error/Warning returns nothing, for
  // a reason nobody would guess from an empty table.
  const securityNeedsInformation =
    logName === 'Security' && levels.length > 0 && !levels.includes(0);

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm flex items-center gap-2">
            <ScrollText className="h-4 w-4 text-muted-foreground" />
            Query the Windows event log
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <div className="space-y-1.5">
              <Label className="text-xs">Log</Label>
              <Select value={logName} onValueChange={setLogName}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {LOGS.map((l) => (
                    <SelectItem key={l} value={l}>{l}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">Time range</Label>
              <Select
                value={String(sinceHours)}
                onValueChange={(v) => setSinceHours(Number(v))}
              >
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {RANGES.map((r) => (
                    <SelectItem key={r.value} value={String(r.value)}>{r.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">Most recent</Label>
              <Select
                value={String(maxEvents)}
                onValueChange={(v) => setMaxEvents(Number(v))}
              >
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {COUNTS.map((c) => (
                    <SelectItem key={c} value={String(c)}>{c} events</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="space-y-1.5">
            <Label className="text-xs">Levels</Label>
            <div className="flex flex-wrap gap-2">
              {LEVELS.map((l) => (
                <button
                  key={l.label}
                  onClick={() => toggleLevel(l.values)}
                  className={`rounded-full border px-3 py-1 text-xs transition-colors ${
                    l.values.every((v) => levels.includes(v))
                      ? 'bg-primary text-primary-foreground border-primary'
                      : 'text-muted-foreground hover:bg-accent'
                  }`}
                >
                  {l.label}
                </button>
              ))}
            </div>
            {levels.length === 0 && (
              <p className="text-[11px] text-muted-foreground">
                No level selected — every level will be returned.
              </p>
            )}
            {securityNeedsInformation && (
              <p className="text-[11px] text-amber-600">
                Security audit entries are logged as Information. Without it selected,
                this query will come back empty.
              </p>
            )}
          </div>

          <div className="space-y-1.5">
            <Label className="text-xs">Source (optional)</Label>
            <Input
              value={provider}
              onChange={(e) => setProvider(e.target.value)}
              placeholder="e.g. Microsoft-Windows-WindowsUpdateClient"
              className="font-mono text-xs"
            />
          </div>

          <div className="flex items-center justify-between gap-3 flex-wrap">
            <p className="text-xs text-muted-foreground">
              {isOnline
                ? 'Collected on this computer’s next heartbeat — up to about three minutes.'
                : 'This computer is offline. The request waits up to 30 minutes for it to check in, then expires.'}
            </p>
            <Button
              size="sm"
              onClick={() => request.mutate()}
              disabled={request.isPending || waiting}
            >
              {waiting ? (
                <Loader2 className="h-3 w-3 mr-1 animate-spin" />
              ) : (
                <Search className="h-3 w-3 mr-1" />
              )}
              {waiting ? 'Waiting for the computer…' : 'Fetch'}
            </Button>
          </div>
        </CardContent>
      </Card>

      {shown && (
        <Card>
          <CardHeader className="pb-3">
            <div className="flex items-center justify-between gap-2 flex-wrap">
              <CardTitle className="text-sm">
                {shown.params?.logName ?? 'Event'} log
                {shown.status === 'SUCCEEDED' && (
                  <span className="text-muted-foreground font-normal">
                    {' '}
                    — {events.length} event{events.length === 1 ? '' : 's'}
                  </span>
                )}
              </CardTitle>
              <Badge
                variant={
                  shown.status === 'SUCCEEDED' ? 'secondary'
                  : shown.status === 'FAILED' || shown.status === 'EXPIRED' ? 'destructive'
                  : 'outline'
                }
                className="text-xs"
              >
                {shown.status === 'PENDING' ? 'Queued'
                  : shown.status === 'DISPATCHED' ? 'Collecting'
                  : shown.status === 'SUCCEEDED' ? 'Done'
                  : shown.status === 'EXPIRED' ? 'Expired'
                  : 'Failed'}
              </Badge>
            </div>
          </CardHeader>
          <CardContent>
            {isHistoric && shown.status === 'SUCCEEDED' && (
              <p className="text-xs text-muted-foreground mb-3">
                Collected {formatDate(shown.completedAt ?? shown.createdAt)} — from an
                earlier request. Fetch again for current entries.
              </p>
            )}
            {waiting && (
              <p className="text-sm text-muted-foreground py-4 text-center">
                Requested {formatDate(shown.createdAt)}. This page updates itself when
                the computer answers.
              </p>
            )}

            {(shown.status === 'FAILED' || shown.status === 'EXPIRED') && (
              <div className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm">
                <AlertTriangle className="h-4 w-4 shrink-0 text-destructive mt-0.5" />
                <div>
                  <div className="font-medium">
                    {shown.status === 'EXPIRED'
                      ? 'The computer never picked this up'
                      : 'The computer could not read that log'}
                  </div>
                  <p className="text-xs text-muted-foreground mt-0.5 break-words">
                    {shown.error ??
                      'It did not check in before the request expired. Try again when it is online.'}
                  </p>
                </div>
              </div>
            )}

            {shown.status === 'SUCCEEDED' && events.length === 0 && (
              <p className="text-sm text-muted-foreground py-4 text-center">
                No events matched. Nothing was logged at those levels in that window —
                on a healthy machine that is the usual answer for Critical over an hour.
              </p>
            )}

            {events.length > 0 && (
              <div className="-my-2">
                {/* Wide by nature: a timestamp, a level, an id, a source and a
                    message do not compress, so this scrolls sideways on a
                    narrow window rather than wrapping into porridge. */}
                <div className="overflow-x-auto">
                  <div className="min-w-[720px]">
                    {events.map((row, i) => (
                      <EventRowView key={`${row.eventId}-${row.timeCreated}-${i}`} row={row} />
                    ))}
                  </div>
                </div>
              </div>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
