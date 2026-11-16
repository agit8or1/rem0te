'use client';

import { Fragment, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { ChevronDown, ChevronRight, Trash2, Wand2 } from 'lucide-react';
import { adoptionApi, type AdoptionMapping, type AdoptionMatch, type PooledComputer } from '@/lib/api-client';
import { PageHeader } from '@/components/common/page-header';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { ConnectivityIndicator } from '@/components/common/connectivity-indicator';
import { useToast } from '@/hooks/use-toast';
import { formatDate } from '@/lib/utils';
import { usePermissions } from '@/lib/auth';
import { EMPTY_PLACE, PlacePicker, errText, selectClass, type Place } from '@/components/adoption/place-picker';

/**
 * Devices → Unassigned (0.57). Computers that enrolled through an authorised
 * route (a deployment key in review mode, or a signed install that checked in
 * before it was claimed) but belong to no business yet. Platform Admins only;
 * nothing can connect to or act on them until they are adopted here.
 *
 * Suggestions come only from the assignment rules on the second tab (or the
 * deployment key the computer used). They are never applied by themselves,
 * and never come from who is signed in to the computer.
 */
const ARRIVED: Record<string, string> = {
  deployment_key: 'Deployment key', install_script: 'Install script', heartbeat: 'Agent check-in',
};
const SOURCE: Record<AdoptionMatch['source'], string> = {
  deployment_key: 'rule on its deployment key', key_binding: 'its deployment key', domain: 'domain rule', cidr: 'address rule', hostname_prefix: 'hostname rule',
};
const KIND_LABEL: Record<AdoptionMapping['kind'], string> = {
  deployment_key: 'Deployment key', domain: 'AD / DNS domain', cidr: 'Address range (CIDR)', hostname_prefix: 'Hostname prefix',
};

export default function UnassignedDevicesPage() {
  const router = useRouter();
  const { isPlatformAdmin, isLoading: authLoading } = usePermissions();
  const allowed = authLoading || isPlatformAdmin;
  useEffect(() => { if (!authLoading && !isPlatformAdmin) router.push('/dashboard'); }, [authLoading, isPlatformAdmin, router]);
  if (!allowed) return null;
  return (
    <div className="p-4 sm:p-6 space-y-6">
      <PageHeader
        title="Unassigned computers"
        description="Computers that enrolled but belong to no business yet. Nothing can connect to or act on them until you assign them. Platform Admins only."
        actions={<Button asChild variant="outline" size="sm"><Link href="/admin/deploy">Deploy agents</Link></Button>}
      />
      <Tabs defaultValue="computers">
        <TabsList>
          <TabsTrigger value="computers">Computers</TabsTrigger>
          <TabsTrigger value="rules">Assignment rules</TabsTrigger>
        </TabsList>
        <TabsContent value="computers" className="mt-4"><Pool enabled={isPlatformAdmin} /></TabsContent>
        <TabsContent value="rules" className="mt-4"><Rules enabled={isPlatformAdmin} /></TabsContent>
      </Tabs>
    </div>
  );
}

function Pool({ enabled }: { enabled: boolean }) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const { data, isLoading } = useQuery({ queryKey: ['adoption', 'devices'], queryFn: adoptionApi.devices, refetchInterval: 30_000, enabled });
  const [search, setSearch] = useState('');
  const [arrived, setArrived] = useState('');
  const [suggested, setSuggested] = useState('');
  const [platform, setPlatform] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [open, setOpen] = useState<string | null>(null);
  const [place, setPlace] = useState<Place>(EMPTY_PLACE);

  const computers = useMemo(() => data?.computers ?? [], [data]);
  const bn = (id: string | null | undefined) => (id ? data?.businesses[id] ?? 'a business' : '');
  const sn = (id: string | null | undefined) => (id ? data?.sites[id] ?? 'a site' : '');
  const platforms = useMemo(() => [...new Set(computers.map((c) => c.platform).filter((p): p is string => !!p))].sort(), [computers]);
  const rows = computers.filter((c) => {
    const q = search.trim().toLowerCase();
    if (q && ![c.name, c.hostname, c.rustdeskId, c.sourceIp, c.inventory?.domain, c.inventory?.serialNumber, c.serialNumber, c.deploymentKey?.name]
      .some((v) => (v ?? '').toLowerCase().includes(q))) return false;
    if (arrived && c.arrivedVia !== arrived) return false;
    if (platform && c.platform !== platform) return false;
    if (suggested === 'yes' && !c.suggestion) return false;
    if (suggested === 'none' && c.suggestion) return false;
    if (suggested === 'conflict' && !c.conflict) return false;
    return true;
  });
  const visibleIds = rows.map((r) => r.id);
  const chosen = [...selected].filter((id) => computers.some((c) => c.id === id));

  const done = (n: number, verb: string, skipped: number) => {
    qc.invalidateQueries({ queryKey: ['adoption'] });
    qc.invalidateQueries({ queryKey: ['endpoints'] });
    setSelected(new Set());
    toast({ title: `${n} computer${n === 1 ? '' : 's'} ${verb}`, description: skipped ? `${skipped} had already left the unassigned list and were not changed.` : undefined });
  };
  const assign = useMutation({
    mutationFn: (v: { endpointIds: string[]; businessId: string; siteId: string | null; groupIds: string[]; mappingId: string | null }) => adoptionApi.assign(v),
    onSuccess: (r) => { const n = r.results.filter((x) => x.result === 'adopted').length; done(n, 'assigned', r.results.length - n); setPlace(EMPTY_PLACE); },
    onError: (e) => toast({ title: 'Could not assign', description: errText(e), variant: 'destructive' }),
  });
  const forget = useMutation({
    mutationFn: (ids: string[]) => adoptionApi.forget(ids),
    onSuccess: (r) => { const n = r.results.filter((x) => x.result === 'forgotten').length; done(n, 'forgotten', r.results.length - n); },
    onError: (e) => toast({ title: 'Could not forget', description: errText(e), variant: 'destructive' }),
  });
  const accept = (c: PooledComputer) => {
    const s = c.suggestion;
    if (!s || c.conflict) return;
    assign.mutate({ endpointIds: [c.id], businessId: s.customerId, siteId: s.siteId, groupIds: [], mappingId: s.mappingId });
  };
  const toggle = (id: string) => setSelected((cur) => { const n = new Set(cur); if (n.has(id)) n.delete(id); else n.add(id); return n; });

  return (
    <div className="space-y-4">
      <div className="grid gap-2 sm:grid-cols-4">
        <Input placeholder="Search name, Remote ID, address, domain, serial, key…" value={search} onChange={(e) => setSearch(e.target.value)} aria-label="Search unassigned computers" />
        <select className={selectClass} value={arrived} onChange={(e) => setArrived(e.target.value)} aria-label="How it arrived">
          <option value="">Any arrival</option>
          {Object.entries(ARRIVED).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </select>
        <select className={selectClass} value={suggested} onChange={(e) => setSuggested(e.target.value)} aria-label="Suggestion">
          <option value="">Any suggestion</option>
          <option value="yes">Has a suggestion</option>
          <option value="none">No suggestion</option>
          <option value="conflict">Rules disagree</option>
        </select>
        <select className={selectClass} value={platform} onChange={(e) => setPlatform(e.target.value)} aria-label="Platform">
          <option value="">Any platform</option>
          {platforms.map((p) => <option key={p} value={p}>{p}</option>)}
        </select>
      </div>

      {chosen.length > 0 && (
        <Card data-testid="adoption-bulk">
          <CardHeader className="pb-2"><CardTitle className="text-sm">Assign {chosen.length} selected computer{chosen.length === 1 ? '' : 's'}</CardTitle></CardHeader>
          <CardContent className="space-y-3">
            <PlacePicker value={place} onChange={setPlace} idPrefix="adopt" />
            <p className="text-xs text-muted-foreground">
              Everyone in that business with access will be able to see and act on them. You will be asked to confirm it is you. Each one is recorded in the audit log with your name.
            </p>
            <div className="flex flex-wrap gap-2">
              <Button size="sm" disabled={!place.businessId || assign.isPending}
                onClick={() => assign.mutate({ endpointIds: chosen, businessId: place.businessId, siteId: place.siteId || null, groupIds: place.groupIds, mappingId: null })}>
                Assign
              </Button>
              <Button size="sm" variant="outline" disabled={forget.isPending}
                onClick={() => { if (window.confirm(`Forget ${chosen.length} computer(s)? A computer whose agent keeps running checks in again as a new unassigned entry.`)) forget.mutate(chosen); }}>
                <Trash2 className="h-4 w-4 mr-1" /> Forget
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setSelected(new Set())}>Clear selection</Button>
            </div>
          </CardContent>
        </Card>
      )}

      {isLoading ? (
        <div className="text-sm text-muted-foreground">Loading…</div>
      ) : (
        <div className="rounded-md border bg-background overflow-x-auto">
          <table className="w-full text-sm" data-testid="unassigned-table">
            <thead>
              <tr className="border-b bg-muted/50 text-left">
                <th className="px-3 py-3 w-8">
                  <input type="checkbox" aria-label="Select all shown"
                    checked={visibleIds.length > 0 && visibleIds.every((id) => selected.has(id))}
                    onChange={(e) => setSelected(e.target.checked ? new Set(visibleIds) : new Set())} />
                </th>
                <th className="px-3 py-3 font-medium">Computer</th>
                <th className="px-3 py-3 font-medium">Arrived</th>
                <th className="px-3 py-3 font-medium">Source address</th>
                <th className="px-3 py-3 font-medium">Seen</th>
                <th className="px-3 py-3 font-medium">Suggestion</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {rows.length === 0 ? (
                <tr><td colSpan={6} className="text-center py-8 text-muted-foreground">{computers.length ? 'No computer matches these filters.' : 'No unassigned computers.'}</td></tr>
              ) : rows.map((c) => (
                <Fragment key={c.id}>
                  <tr className="hover:bg-muted/30 align-top">
                    <td className="px-3 py-3"><input type="checkbox" aria-label={`Select ${c.hostname ?? c.name}`} checked={selected.has(c.id)} onChange={() => toggle(c.id)} /></td>
                    <td className="px-3 py-3">
                      <button type="button" className="flex items-center gap-1 font-medium text-left" onClick={() => setOpen(open === c.id ? null : c.id)} aria-expanded={open === c.id}>
                        {open === c.id ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
                        {c.hostname ?? c.name}
                      </button>
                      <div className="text-xs text-muted-foreground mt-0.5 flex flex-wrap gap-x-2">
                        {c.platform && <span>{c.platform}</span>}
                        {c.rustdeskId && <span className="font-mono">{c.rustdeskId}</span>}
                        {[c.inventory?.manufacturer, c.inventory?.model].filter(Boolean).join(' ')}
                      </div>
                    </td>
                    <td className="px-3 py-3 text-xs">
                      <div>{ARRIVED[c.arrivedVia ?? ''] ?? 'Unknown'}</div>
                      {c.deploymentKey && <div className="text-muted-foreground">{c.deploymentKey.name} (…{c.deploymentKey.keyHint})</div>}
                      {!c.agentBound && <Badge variant="outline" className="mt-1">No device secret</Badge>}
                    </td>
                    <td className="px-3 py-3 font-mono text-xs">{c.sourceIp ?? '—'}</td>
                    <td className="px-3 py-3 text-xs text-muted-foreground">
                      <div>First {formatDate(c.createdAt)}</div>
                      <div>Last {formatDate(c.nodeLastSeenAt ?? c.lastSeenAt)}</div>
                      <ConnectivityIndicator x={c} short />
                    </td>
                    <td className="px-3 py-3 text-xs">
                      {c.suggestion ? (
                        <div className="space-y-1">
                          <div>
                            <span className="font-medium">{bn(c.suggestion.customerId)}</span>
                            {c.suggestion.siteId && <span> · {sn(c.suggestion.siteId)}</span>}
                          </div>
                          <div className="text-muted-foreground">by {SOURCE[c.suggestion.source]}{c.suggestion.source !== 'key_binding' ? ` “${c.suggestion.value}”` : ''}</div>
                          {c.conflict ? (
                            <Badge variant="destructive">Rules disagree: {[...new Set(c.matches.map((m) => bn(m.customerId)))].join(' / ')}</Badge>
                          ) : (
                            <Button size="sm" variant="outline" disabled={assign.isPending} onClick={() => accept(c)}>
                              <Wand2 className="h-3.5 w-3.5 mr-1" /> Accept
                            </Button>
                          )}
                        </div>
                      ) : <span className="text-muted-foreground">None</span>}
                    </td>
                  </tr>
                  {open === c.id && (
                    <tr className="bg-muted/20"><td /><td colSpan={5} className="px-3 py-3"><Details c={c} /></td></tr>
                  )}
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function Details({ c }: { c: PooledComputer }) {
  const inv = c.inventory;
  const gb = (mb: number | null | undefined) => (mb ? `${Math.round(mb / 1024)} GB` : null);
  const facts: [string, string | number | null | undefined][] = [
    ['Name', c.name], ['Hostname', c.hostname], ['Remote ID', c.rustdeskId], ['Platform', c.platform], ['Operating system', inv?.osCaption ?? c.osVersion],
    ['OS build', inv?.osBuild], ['Architecture', inv?.osArch], ['Domain', inv?.domain], ['Manufacturer', inv?.manufacturer], ['Model', inv?.model],
    ['Serial number', inv?.serialNumber ?? c.serialNumber], ['Chassis', inv?.chassisType], ['Processor', inv?.cpuModel],
    ['Cores / threads', inv?.cpuCores ? `${inv.cpuCores} / ${inv.cpuThreads ?? '?'}` : null], ['Memory', gb(inv?.memoryTotalMb)], ['System disk', gb(inv?.systemDiskTotalMb)],
    ['MAC address', c.macAddress], ['Reported address', c.ipAddress], ['Source address (seen by the server)', c.sourceIp],
    ['Agent', [c.agentVersion, c.updateChannel].filter(Boolean).join(' · ') || null], ['RustDesk', c.rustdeskVersion],
    ['Device secret', c.agentBound ? 'Bound' : 'None'], ['Inventory collected', inv?.collectedAt ? formatDate(inv.collectedAt) : null],
  ];
  return (
    <div className="space-y-2">
      <dl className="grid gap-x-6 gap-y-1 text-xs sm:grid-cols-2 lg:grid-cols-3">
        {facts.filter(([, v]) => v !== null && v !== undefined && v !== '').map(([k, v]) => (
          <div key={k} className="flex gap-2"><dt className="text-muted-foreground shrink-0">{k}</dt><dd className="font-medium break-all">{v}</dd></div>
        ))}
      </dl>
      {c.matches.length > 1 && (
        <p className="text-xs text-muted-foreground">Every rule that matched, best first: {c.matches.map((m) => `${SOURCE[m.source]} (${m.value})`).join(', ')}.</p>
      )}
      <p className="text-xs text-muted-foreground">Who is signed in is not shown here and is never used to suggest a business.</p>
    </div>
  );
}

function Rules({ enabled }: { enabled: boolean }) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const { data: rules = [], isLoading } = useQuery({ queryKey: ['adoption', 'mappings'], queryFn: adoptionApi.mappings, enabled });
  const { data: keys = [] } = useQuery({ queryKey: ['adoption', 'keys'], queryFn: adoptionApi.keys, enabled });
  const [kind, setKind] = useState<AdoptionMapping['kind']>('domain');
  const [value, setValue] = useState('');
  const [priority, setPriority] = useState('100');
  const [place, setPlace] = useState<Place>(EMPTY_PLACE);
  const create = useMutation({
    mutationFn: () => adoptionApi.createMapping({ businessId: place.businessId, siteId: place.siteId || null, kind, value: value.trim(), priority: Number(priority) || 100 }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['adoption'] }); setValue(''); toast({ title: 'Rule added' }); },
    onError: (e) => toast({ title: 'Could not add the rule', description: errText(e), variant: 'destructive' }),
  });
  const remove = useMutation({
    mutationFn: (id: string) => adoptionApi.deleteMapping(id),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['adoption'] }); toast({ title: 'Rule removed' }); },
    onError: (e) => toast({ title: 'Could not remove the rule', description: errText(e), variant: 'destructive' }),
  });
  const keyChoices = keys.filter((k) => k.customerId === place.businessId && k.state === 'usable');
  const placeholder: Record<AdoptionMapping['kind'], string> = { domain: 'contoso.local or CONTOSO', cidr: '203.0.113.0/24', hostname_prefix: 'ACME-', deployment_key: '' };

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="pb-2"><CardTitle className="text-sm">Add a rule</CardTitle></CardHeader>
        <CardContent className="space-y-3">
          <p className="text-xs text-muted-foreground">
            A rule <strong>suggests</strong> a business and site for an unassigned computer that matches it. Nothing is assigned until you accept it.
            Rules can only use the deployment key, the AD / DNS domain the computer reports, the address the server saw it connect from, and the start of its hostname —
            never who is signed in, a user name or an e-mail address.
          </p>
          <PlacePicker value={place} onChange={setPlace} groups="none" idPrefix="rule" />
          <div className="grid gap-3 sm:grid-cols-3">
            <label className="space-y-1 text-xs font-medium"><span>Matches on</span>
              <select className={selectClass} value={kind} onChange={(e) => { setKind(e.target.value as AdoptionMapping['kind']); setValue(''); }}>
                {(Object.keys(KIND_LABEL) as AdoptionMapping['kind'][]).map((k) => <option key={k} value={k}>{KIND_LABEL[k]}</option>)}
              </select>
            </label>
            <label className="space-y-1 text-xs font-medium"><span>Value</span>
              {kind === 'deployment_key' ? (
                <select className={selectClass} value={value} onChange={(e) => setValue(e.target.value)} disabled={!place.businessId}>
                  <option value="">{place.businessId ? (keyChoices.length ? 'Choose a key…' : 'No usable key for this business') : 'Choose a business first'}</option>
                  {keyChoices.map((k) => <option key={k.id} value={k.id}>{k.name} (…{k.keyHint})</option>)}
                </select>
              ) : (
                <Input value={value} onChange={(e) => setValue(e.target.value)} placeholder={placeholder[kind]} />
              )}
            </label>
            <label className="space-y-1 text-xs font-medium"><span>Priority <span className="font-normal text-muted-foreground">(lower first, 0–1000)</span></span>
              <Input type="number" min={0} max={1000} value={priority} onChange={(e) => setPriority(e.target.value)} />
            </label>
          </div>
          <Button size="sm" disabled={!place.businessId || !value.trim() || create.isPending} onClick={() => create.mutate()}>Add rule</Button>
        </CardContent>
      </Card>

      <div className="rounded-md border bg-background overflow-x-auto">
        <table className="w-full text-sm">
          <thead><tr className="border-b bg-muted/50 text-left">
            <th className="px-3 py-3 font-medium">Matches on</th><th className="px-3 py-3 font-medium">Value</th>
            <th className="px-3 py-3 font-medium">Suggests</th><th className="px-3 py-3 font-medium">Priority</th><th className="px-3 py-3" />
          </tr></thead>
          <tbody className="divide-y">
            {isLoading ? <tr><td colSpan={5} className="px-3 py-6 text-muted-foreground">Loading…</td></tr>
              : rules.length === 0 ? <tr><td colSpan={5} className="px-3 py-6 text-center text-muted-foreground">No rules yet.</td></tr>
                : rules.map((r) => (
                  <tr key={r.id}>
                    <td className="px-3 py-3">{KIND_LABEL[r.kind]}</td>
                    <td className="px-3 py-3 font-mono text-xs">{r.kind === 'deployment_key' ? `${r.keyName ?? 'a key'}${r.keyState && r.keyState !== 'usable' ? ` (${r.keyState})` : ''}` : r.value}</td>
                    <td className="px-3 py-3">{r.businessName}{r.siteName ? ` · ${r.siteName}` : ''}</td>
                    <td className="px-3 py-3">{r.priority}</td>
                    <td className="px-3 py-3 text-right">
                      <Button size="sm" variant="ghost" aria-label="Remove rule" disabled={remove.isPending} onClick={() => remove.mutate(r.id)}><Trash2 className="h-4 w-4" /></Button>
                    </td>
                  </tr>
                ))}
          </tbody>
        </table>
      </div>
      <p className="text-xs text-muted-foreground">
        Order: a rule on the deployment key, then the key&apos;s own business, then domain, hostname prefix and address. Within a kind, lower priority wins, then the narrower range or longer prefix.
        When rules name different businesses the computer is marked “Rules disagree” and must be assigned by hand.
      </p>
    </div>
  );
}
