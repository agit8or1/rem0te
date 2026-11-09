'use client';

import { useMemo, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Loader2, Search } from 'lucide-react';
import { businessesApi, endpointsApi, securityControlsApi, type InspectAction } from '@/lib/api-client';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { apiError, Chip, CHIP, DECISION_STYLE, JsonBlock, personName, usePeople } from './shared';

const ACTIONS: { key: InspectAction; label: string }[] = [
  { key: 'view_inventory', label: 'View inventory' },
  { key: 'support_requests', label: 'Work support requests' },
  { key: 'event_logs', label: 'Read event logs' },
  { key: 'diagnostics', label: 'Run diagnostics' },
  { key: 'credential_reveal', label: 'Reveal the computer password' },
  { key: 'enrollment', label: 'Enroll computers' },
  { key: 'launch_view_only', label: 'Launch: view only' },
  { key: 'launch_control', label: 'Launch: interactive control' },
  { key: 'launch_elevated', label: 'Launch: elevated' },
  { key: 'launch_unattended', label: 'Launch: unattended' },
  { key: 'clipboard', label: 'Clipboard' },
  { key: 'file_transfer', label: 'File transfer' },
  { key: 'scripts', label: 'Run scripts' },
  { key: 'patches', label: 'Patch work' },
  { key: 'fix_request', label: 'Request a fix' },
  { key: 'fix_approval', label: 'Approve a fix' },
  { key: 'fleet_execution', label: 'Fleet execution' },
  { key: 'approve_requests', label: 'Approve requests (independent review)' },
];

const ANY = '__any__';

interface InspectResult {
  decision: string;
  reasons: string[];
  grants?: Record<string, unknown>[];
  paused?: boolean;
  tier?: string;
}

export function InspectorPanel() {
  const { data: people = [] } = usePeople();
  const { data: listed = [] } = useQuery<{ id: string; name: string }[]>({
    queryKey: ['businesses', ''],
    queryFn: () => businessesApi.list().then((r) => r.data?.data ?? []),
    retry: false,
  });
  const [userId, setUserId] = useState('');
  const [personFilter, setPersonFilter] = useState('');
  const [businessId, setBusinessId] = useState('');
  const [endpointId, setEndpointId] = useState(ANY);
  const [action, setAction] = useState<InspectAction>('launch_control');

  // As on the Technicians page: a technicians:manage holder cannot list every
  // business, so offer the ones seen in people's own memberships too.
  const businesses = useMemo(() => {
    const m = new Map<string, string>();
    for (const b of listed) m.set(b.id, b.name);
    for (const p of people) if (p.ownBusiness) m.set(p.ownBusiness.id, p.ownBusiness.name);
    return [...m.entries()].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name));
  }, [listed, people]);

  const { data: computers = [] } = useQuery<{ id: string; name: string }[]>({
    queryKey: ['security-controls', 'inspect-endpoints', businessId],
    queryFn: () => endpointsApi.list({ businessId, limit: '200' }).then((r) => r.data?.data?.endpoints ?? []),
    enabled: !!businessId,
    retry: false,
  });

  const shownPeople = people
    .filter((p) => !personFilter.trim() || `${personName(p)} ${p.email}`.toLowerCase().includes(personFilter.toLowerCase()))
    .slice(0, 100);

  const run = useMutation({
    mutationFn: () => securityControlsApi.inspect({
      userId, businessId, action, ...(endpointId !== ANY ? { endpointId } : {}),
    }).then((r) => {
      if (r.data?.success === false) throw new Error(r.data?.error ?? 'Inspection failed');
      return r.data?.data as InspectResult;
    }),
  });
  const result = run.data;
  const needsComputer = action.startsWith('launch_');

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        Asks the same questions the enforcement points ask, for one person, business, computer and action, and shows why.
        Read-only: nothing is changed, granted or logged as an attempt.
      </p>
      <Card>
        <CardContent className="grid gap-3 p-4 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label>Technician</Label>
            <Input placeholder="Filter by name or email…" value={personFilter} onChange={(e) => setPersonFilter(e.target.value)} />
            <Select value={userId} onValueChange={setUserId}>
              <SelectTrigger><SelectValue placeholder="Choose a person" /></SelectTrigger>
              <SelectContent>
                {shownPeople.map((p) => <SelectItem key={p.id} value={p.id}>{personName(p)} · {p.email}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label>Business</Label>
            <Select value={businessId} onValueChange={(v) => { setBusinessId(v); setEndpointId(ANY); }}>
              <SelectTrigger><SelectValue placeholder="Choose a business" /></SelectTrigger>
              <SelectContent>
                {businesses.map((b) => <SelectItem key={b.id} value={b.id}>{b.name}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label>Computer {needsComputer ? '' : '(optional)'}</Label>
            <Select value={endpointId} onValueChange={setEndpointId} disabled={!businessId}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value={ANY}>Any computer in the business</SelectItem>
                {computers.map((c) => <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>)}
              </SelectContent>
            </Select>
            {needsComputer && endpointId === ANY && <p className="text-xs text-muted-foreground">A launch is decided per computer: choose one.</p>}
          </div>
          <div className="space-y-1.5">
            <Label>Action</Label>
            <Select value={action} onValueChange={(v) => setAction(v as InspectAction)}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                {ACTIONS.map((a) => <SelectItem key={a.key} value={a.key}>{a.label}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          <div className="sm:col-span-2">
            <Button onClick={() => run.mutate()} disabled={!userId || !businessId || run.isPending}>
              {run.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Search className="mr-2 h-4 w-4" />}Inspect
            </Button>
          </div>
        </CardContent>
      </Card>

      {run.isError && <p className="text-sm text-destructive">{apiError(run.error, 'Inspection failed').message}</p>}

      {result && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="flex flex-wrap items-center gap-3 text-base">
              <span className={`rounded-md px-3 py-1 text-lg font-semibold capitalize ${DECISION_STYLE[result.decision] ?? CHIP.off}`}>
                {result.decision.replace(/_/g, ' ')}
              </span>
              {result.tier && <Chip className={CHIP.off}>Tier: {result.tier}</Chip>}
              {result.paused && <Chip className={CHIP.bad}>Privileged work paused</Chip>}
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 text-sm">
            <div>
              <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Reasons</div>
              {result.reasons.length === 0 ? <p className="text-muted-foreground">No further detail.</p> : (
                <ul className="list-disc space-y-0.5 pl-5">{result.reasons.map((r) => <li key={r}>{r}</li>)}</ul>
              )}
            </div>
            <div>
              <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Grants that apply</div>
              {!result.grants?.length ? <p className="text-muted-foreground">None cover this computer.</p> : (
                <div className="space-y-2">
                  {result.grants.map((g, i) => <GrantLine key={i} g={g} />)}
                </div>
              )}
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

function GrantLine({ g }: { g: Record<string, unknown> }) {
  const caps = Array.isArray(g.capabilities) ? (g.capabilities as string[]) : [];
  if (typeof g.membership === 'string') {
    return (
      <div className="rounded-md border p-2">
        <div className="font-medium">Membership: {g.membership}</div>
        <div className="text-xs text-muted-foreground">{caps.join(', ') || 'no capabilities'}</div>
      </div>
    );
  }
  if (typeof g.assignmentId !== 'string') return <JsonBlock value={g} />;
  const computers = Array.isArray(g.computers) ? `${(g.computers as string[]).length} computer(s)` : 'all computers';
  return (
    <div className="rounded-md border p-2">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium">{g.via === 'GROUP' ? `Group: ${String(g.group ?? '—')}` : 'Direct assignment'}</span>
        <Chip className={CHIP.off}>Preset: {String(g.preset ?? 'custom')}</Chip>
        <span className="text-xs text-muted-foreground">{computers}</span>
      </div>
      <div className="text-xs text-muted-foreground">{caps.join(', ') || 'no capabilities'}</div>
      <div className="font-mono text-[11px] text-muted-foreground">{g.assignmentId}</div>
    </div>
  );
}
