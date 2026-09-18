'use client';

import { useEffect, useState, Suspense } from 'react';
import { useSearchParams, useRouter } from 'next/navigation';
import { useMutation, useQuery } from '@tanstack/react-query';
import { endpointsApi } from '@/lib/api-client';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { StatusIndicator } from '@/components/common/status-indicator';
import { useToast } from '@/hooks/use-toast';
import { usePermissions, CAP } from '@/lib/auth';
import { formatDate } from '@/lib/utils';
import { Link2, AlertTriangle, PlayCircle, Monitor, ArrowRight } from 'lucide-react';
import Link from 'next/link';

/**
 * The landing page for a Tactical RMM URL Action.
 *
 * TRMM cannot consume a REST API — its extension point is a URL Action that
 * opens a browser tab against a template of `{{agent.hostname}}`,
 * `{{agent.agent_id}}`, `{{client.name}}` and `{{site.name}}`. This page is
 * where that tab lands: it resolves those strings to one computer and either
 * gets on with it or asks.
 *
 * Because it opens in the technician's own browser it authenticates as them,
 * against what they can already see. That is the reason no API key appears in
 * the URL template — a URL Action is stored in TRMM's settings, ends up in
 * browser history, and is visible to every TRMM operator who can right-click
 * an agent.
 *
 * `?action=open` lands on the computer's page instead of connecting, for
 * looking before touching.
 */

interface Candidate {
  id: string;
  name: string;
  hostname: string | null;
  platform: string | null;
  isOnline: boolean;
  lastSeenAt: string | null;
  customer: { id: string; name: string } | null;
  site: { id: string; name: string } | null;
}

interface ResolveResult {
  kind: 'agent-id' | 'hostname+client' | 'hostname' | 'ambiguous' | 'none';
  endpoint: Candidate | null;
  candidates: Candidate[];
}

const WHY: Record<ResolveResult['kind'], string> = {
  'agent-id': 'Matched on the Tactical RMM agent id recorded for this computer.',
  'hostname+client': 'Matched on hostname, narrowed by the client name from Tactical RMM.',
  hostname: 'Matched on hostname.',
  ambiguous: 'More than one computer answers to that hostname.',
  none: 'No computer matched.',
};

function TrmmLanding() {
  const params = useSearchParams();
  const router = useRouter();
  const { toast } = useToast();
  const { can } = usePermissions();

  const host = params.get('host') ?? params.get('hostname') ?? '';
  const client = params.get('client') ?? '';
  const site = params.get('site') ?? '';
  const agent = params.get('agent') ?? params.get('agent_id') ?? '';
  const action = params.get('action') === 'open' ? 'open' : 'connect';

  const [launched, setLaunched] = useState(false);

  const { data, isLoading } = useQuery({
    queryKey: ['trmm-resolve', host, client, site, agent],
    queryFn: () =>
      endpointsApi
        .trmmResolve({ host, client, site, agent })
        .then((r) => r.data?.data as ResolveResult),
    enabled: !!(host || agent),
    retry: false,
  });

  const link = useMutation({
    mutationFn: (endpointId: string) => endpointsApi.trmmLink(endpointId, agent),
    onError: () =>
      toast({
        title: 'Could not remember that',
        description: 'The connection still works; the next launch will ask again.',
        variant: 'destructive',
      }),
  });

  const exact = data && data.kind !== 'ambiguous' && data.kind !== 'none' ? data.endpoint : null;

  /**
   * Go straight there on an unambiguous match.
   *
   * `launched` guards it because this effect re-runs on any render and a
   * connect is not idempotent — it issues a credential and writes a session
   * row. Firing twice would be two sessions for one click.
   */
  useEffect(() => {
    if (!exact || launched) return;
    setLaunched(true);
    if (action === 'open') {
      router.replace(`/endpoints/${exact.id}`);
    } else {
      void go(exact.id);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [exact, launched, action]);

  async function go(endpointId: string, remember = false) {
    if (remember && agent && can(CAP.COMPUTERS_EDIT)) {
      // Best-effort: a failed mapping must not stop the connection the person
      // actually asked for.
      await link.mutateAsync(endpointId).catch(() => undefined);
    }
    if (action === 'open') {
      router.push(`/endpoints/${endpointId}`);
      return;
    }
    try {
      const res = await endpointsApi.connect(endpointId);
      const info = res.data?.data as { rustdeskId?: string; password?: string | null } | undefined;
      if (!info?.rustdeskId) {
        toast({
          title: 'Computer not ready',
          description: 'This computer has not finished enrollment.',
          variant: 'destructive',
        });
        return;
      }
      if (info.password) {
        try { await navigator.clipboard.writeText(info.password); } catch { /* ignore */ }
      }
      window.location.href = endpointsApi.connectScriptUrl(endpointId);
    } catch {
      toast({ title: 'Error', description: 'Could not start the connection', variant: 'destructive' });
    }
  }

  if (!host && !agent) {
    return (
      <Shell>
        <Problem title="Nothing to look up">
          This page is opened by a Tactical RMM URL Action and needs at least a
          hostname or an agent id. See the setup instructions in{' '}
          <Link href="/docs/tactical-rmm" className="underline">the documentation</Link>.
        </Problem>
      </Shell>
    );
  }

  if (isLoading) {
    return <Shell><p className="text-sm text-muted-foreground">Looking up {host || agent}…</p></Shell>;
  }

  if (exact) {
    return (
      <Shell>
        <p className="text-sm text-muted-foreground">
          {action === 'open' ? 'Opening' : 'Connecting to'} <strong>{exact.name}</strong>…
        </p>
        <p className="text-xs text-muted-foreground mt-1">{WHY[data!.kind]}</p>
      </Shell>
    );
  }

  const list = data?.candidates ?? [];

  return (
    <Shell>
      {list.length > 0 ? (
        <>
          <Problem title="More than one computer matches" tone="warn">
            Tactical RMM sent the hostname <code className="font-mono">{host}</code>
            {client && <> for client <code className="font-mono">{client}</code></>}, and it
            matches {list.length} computers. Pick the right one — Rem0te will not guess,
            because guessing here opens a session on somebody else&apos;s machine.
          </Problem>
          <div className="space-y-2 mt-4">
            {list.map((c) => (
              <Card key={c.id} className="hover:bg-muted/40 transition-colors">
                <CardContent className="p-3 flex items-center justify-between gap-4">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <StatusIndicator status={c.isOnline ? 'online' : 'offline'} />
                      <span className="font-medium text-sm truncate">{c.name}</span>
                      {c.platform && <Badge variant="secondary" className="text-[10px]">{c.platform}</Badge>}
                    </div>
                    <p className="text-xs text-muted-foreground truncate">
                      {c.customer?.name ?? 'Unassigned'}
                      {c.site?.name ? ` · ${c.site.name}` : ''}
                      {c.hostname ? ` · ${c.hostname}` : ''}
                      {c.lastSeenAt ? ` · seen ${formatDate(c.lastSeenAt)}` : ''}
                    </p>
                  </div>
                  <Button size="sm" onClick={() => go(c.id, true)}>
                    {action === 'open' ? <Monitor className="h-3 w-3 mr-1" /> : <PlayCircle className="h-3 w-3 mr-1" />}
                    {action === 'open' ? 'Open' : 'Connect'}
                  </Button>
                </CardContent>
              </Card>
            ))}
          </div>
          {agent && can(CAP.COMPUTERS_EDIT) && (
            <p className="text-xs text-muted-foreground mt-3 flex items-center gap-1.5">
              <Link2 className="h-3 w-3" />
              Choosing one records it against this Tactical RMM agent, so the next
              launch goes straight through.
            </p>
          )}
        </>
      ) : (
        <Problem title="No computer matched" tone="warn">
          <p>
            Tactical RMM sent
            {host && <> hostname <code className="font-mono">{host}</code></>}
            {client && <>, client <code className="font-mono">{client}</code></>}
            {agent && <>, agent <code className="font-mono">{agent}</code></>}
            {' '}— nothing in Rem0te matches, or nothing you have access to does.
          </p>
          <p className="mt-2">
            The computer may not be enrolled in Rem0te, or it may be enrolled under a
            different name. <Link href="/endpoints" className="underline">Browse computers</Link>
            {' '}to check.
          </p>
        </Problem>
      )}
    </Shell>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="p-6 max-w-3xl">
      <div className="flex items-center gap-2 mb-4">
        <ArrowRight className="h-4 w-4 text-muted-foreground" />
        <h1 className="text-lg font-semibold">From Tactical RMM</h1>
      </div>
      {children}
    </div>
  );
}

function Problem({
  title, children, tone = 'info',
}: {
  title: string; children: React.ReactNode; tone?: 'info' | 'warn';
}) {
  return (
    <Card className={tone === 'warn' ? 'border-amber-500/40 bg-amber-500/5' : undefined}>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm flex items-center gap-2">
          {tone === 'warn' && <AlertTriangle className="h-4 w-4 text-amber-600" />}
          {title}
        </CardTitle>
      </CardHeader>
      <CardContent className="text-sm text-muted-foreground space-y-1">{children}</CardContent>
    </Card>
  );
}

export default function TrmmPage() {
  // useSearchParams needs a Suspense boundary under the App Router, or the
  // whole route opts out of static rendering with a build-time warning.
  return (
    <Suspense fallback={<Shell><p className="text-sm text-muted-foreground">Loading…</p></Shell>}>
      <TrmmLanding />
    </Suspense>
  );
}
