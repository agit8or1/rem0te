'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { keepPreviousData, useMutation, useQuery } from '@tanstack/react-query';
import { ArrowDown, ArrowUp, ChevronLeft, ChevronRight, Loader2, X } from 'lucide-react';
import { softwareApi } from '@/lib/api-client';
import { useToast } from '@/hooks/use-toast';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { WingetIndexStatus, refusalText, selectClass, type WingetIndex } from './software-ui';

/**
 * The winget community catalog as a table (0.43): every package in the
 * server's copy of the index, 50 a page, filtered as you type (with the 0.42
 * ranking), by publisher and by first letter, and sorted by name. Each row
 * says which catalog already holds it and at what version, for the catalog
 * chosen as the target. Ticking rows and "Add N selected" adds them in one
 * request (at most 25, one fresh sign-in, each through the one-click add
 * path: manifest, installer, detection rule, audited); "Remove" archives the
 * target's entries through the ordinary archive route.
 */

interface Mark { scope: 'global' | 'business'; businessId: string | null; businessName: string | null; entryId: string; version: string; revision: number }
interface Row { packageId: string; name: string; publisher: string | null; moniker: string | null; latestVersion: string; installable: boolean; inCatalog: Mark[] }
interface Page {
  mode: 'browse'; query: string; sort: 'relevance' | 'name' | '-name'; ranked: boolean; publisher: string | null; letter: string | null;
  page: number; pages: number; pageSize: number; total: number; results: Row[];
  target: { businessId: string; businessName: string } | null;
  you: { canAddGlobal: boolean; canAddBusiness: boolean };
  index: WingetIndex;
}
type RowResult =
  | { packageId: string; status: 'added' | 'updated' | 'already'; in: 'global' | 'business'; entryId: string; version: string }
  | { packageId: string; status: 'refused'; code: string; message: string }
  | { packageId: string; status: 'removed' }
  | { packageId: string; status: 'not_removed'; message: string };

const BULK_MAX = 25;
/** The archive route allows ten a minute; removing more is done in turns. */
const REMOVE_MAX = 10;
const LETTERS = [...'ABCDEFGHIJKLMNOPQRSTUVWXYZ', '#'];
const QUERY_RE = /^[A-Za-z0-9][A-Za-z0-9 .+_-]{1,63}$/;

const lower = (s: string) => s.toLowerCase();

export function WingetBrowser({ isPlatformAdmin, businesses, initialBusinessId, onChanged }: {
  isPlatformAdmin: boolean;
  businesses: { id: string; name: string }[];
  initialBusinessId?: string;
  onChanged: () => void;
}) {
  const { toast } = useToast();
  const [typed, setTyped] = useState('');
  const [q, setQ] = useState('');
  const [page, setPage] = useState(1);
  const [sort, setSort] = useState<'relevance' | 'name' | '-name' | ''>('');
  const [publisher, setPublisher] = useState('');
  const [letter, setLetter] = useState('');
  // Platform Admin: '' is the global catalog, else a business. Everyone else: their own business (the server decides).
  const [target, setTarget] = useState(isPlatformAdmin ? initialBusinessId ?? '' : '');
  const [selected, setSelected] = useState<Map<string, Row>>(new Map());
  const [results, setResults] = useState<Map<string, RowResult>>(new Map());
  const [removing, setRemoving] = useState<{ row: Row; mark: Mark }[] | null>(null);

  useEffect(() => { if (isPlatformAdmin && initialBusinessId !== undefined) setTarget(initialBusinessId); }, [isPlatformAdmin, initialBusinessId]);
  // Filter as you type, a moment after the typing stops.
  useEffect(() => {
    const t = setTimeout(() => { const s = typed.trim(); setQ(s.length >= 2 && QUERY_RE.test(s) ? s : ''); }, 300);
    return () => clearTimeout(t);
  }, [typed]);
  useEffect(() => { setPage(1); }, [q]);
  // A new target catalog: what was ticked or reported was for the old one.
  useEffect(() => { setSelected(new Map()); setResults(new Map()); }, [target]);

  const params = { q: q || undefined, page, pageSize: 50, sort: sort || undefined, publisher: publisher || undefined, letter: letter || undefined, businessId: isPlatformAdmin && target ? target : undefined };
  const browse = useQuery({
    queryKey: ['winget-browse', params],
    queryFn: () => softwareApi.wingetBrowse(params).then((r) => r.data.data as Page),
    placeholderData: keepPreviousData,
    retry: false,
  });
  const d = browse.data;
  const targetBusiness = isPlatformAdmin ? (target || null) : d?.target?.businessId ?? null;
  const targetName = targetBusiness ? (d?.target?.businessName ?? businesses.find((b) => b.id === targetBusiness)?.name ?? 'this business') : null;
  const targetLabel = targetName ? `the ${targetName} catalog` : 'the global catalog';
  const canWrite = !!d && (targetBusiness ? d.you.canAddBusiness : d.you.canAddGlobal);
  /** The target catalog's own entry for a row (what Remove archives). */
  const own = (r: Row) => r.inCatalog.find((m) => (targetBusiness ? m.businessId === targetBusiness : m.scope === 'global'));
  /** Already there for the target: its own entry, or a global one, which applies to every business. */
  const there = (r: Row) => own(r) ?? (targetBusiness ? r.inCatalog.find((m) => m.scope === 'global') : undefined);

  const picked = useMemo(() => [...selected.values()], [selected]);
  const toAdd = picked.filter((r) => !there(r) && r.installable);
  const toRemove = picked.map((r) => ({ row: r, mark: own(r) })).filter((x): x is { row: Row; mark: Mark } => !!x.mark);

  const add = useMutation({
    mutationFn: () => softwareApi.wingetAddMany({
      ...(targetBusiness ? { scope: 'business' as const, ...(isPlatformAdmin ? { businessId: targetBusiness } : {}) } : { scope: 'global' as const }),
      packages: toAdd.map((r) => ({ packageId: r.packageId, version: r.latestVersion })),
    }),
    onSuccess: (r) => {
      const out = r.data.data as { results: RowResult[]; counts: { added: number; updated: number; already: number; refused: number } };
      setResults((m) => { const n = new Map(m); for (const x of out.results) n.set(lower(x.packageId), x); return n; });
      setSelected((m) => { const n = new Map(m); for (const x of out.results) if (x.status !== 'refused') n.delete(lower(x.packageId)); return n; });
      const c = out.counts;
      toast({ title: `${c.added} added to ${targetLabel}`, description: [c.already ? `${c.already} already there` : '', c.refused ? `${c.refused} refused — the reason is on each row` : ''].filter(Boolean).join(' · ') || undefined, variant: c.refused && !c.added ? 'destructive' : undefined });
      browse.refetch(); onChanged();
    },
    onError: (e) => toast({ title: 'Nothing added', description: refusalText(e, 'The packages could not be added.'), variant: 'destructive' }),
  });

  const toggle = (r: Row) => setSelected((m) => { const n = new Map(m); const k = lower(r.packageId); if (n.has(k)) n.delete(k); else n.set(k, r); return n; });
  const rows = d?.results ?? [];
  const selectable = (r: Row) => canWrite && (r.installable || !!own(r));
  const allOnPage = rows.filter(selectable);
  const allTicked = allOnPage.length > 0 && allOnPage.every((r) => selected.has(lower(r.packageId)));
  const nameSort = () => {
    const order: ('relevance' | 'name' | '-name')[] = q ? ['relevance', 'name', '-name'] : ['name', '-name'];
    const cur = sort || (q ? 'relevance' : 'name');
    setSort(order[(order.indexOf(cur) + 1) % order.length]); setPage(1);
  };
  const effSort = d?.sort ?? (sort || (q ? 'relevance' : 'name'));
  const bad = typed.trim().length >= 2 && !QUERY_RE.test(typed.trim());

  return (
    <Card className="mb-4" data-testid="winget-catalog">
      <CardHeader className="pb-3 space-y-1">
        <CardTitle className="text-sm">Winget community catalog</CardTitle>
        <p className="text-xs text-muted-foreground">
          Every package in winget&apos;s own source index, read at most daily. Tick packages and add them to a catalog; each one pins the installer winget-pkgs lists for its latest version, with a detection rule from its manifest. Installing from a catalog is approved like any entry.
        </p>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        <WingetIndexStatus idx={d?.index} isPlatformAdmin={isPlatformAdmin} onRead={() => browse.refetch()} />

        <div className="flex flex-wrap items-end gap-3">
          <div className="w-72">
            <Label htmlFor="wb-target" className="text-xs">Catalog to build</Label>
            {isPlatformAdmin ? (
              <select id="wb-target" className={selectClass} value={target} onChange={(e) => setTarget(e.target.value)} data-testid="winget-target">
                <option value="">Global catalog (every business)</option>
                {businesses.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
              </select>
            ) : <p id="wb-target" className="h-10 flex items-center text-sm" data-testid="winget-target">{targetName ? `${targetName} catalog` : '—'}</p>}
          </div>
          <div className="w-80">
            <Label htmlFor="wb-q" className="text-xs">Filter</Label>
            <Input id="wb-q" placeholder="Name, publisher or package id" value={typed} maxLength={64} onChange={(e) => setTyped(e.target.value)} aria-label="Filter the winget catalog" />
          </div>
          {publisher && (
            <Badge variant="secondary" className="h-7 gap-1" data-testid="winget-publisher-filter">
              Publisher: {publisher}
              <button type="button" aria-label="Clear the publisher filter" onClick={() => { setPublisher(''); setPage(1); }}><X className="h-3 w-3" /></button>
            </Badge>
          )}
          {browse.isFetching && <Loader2 className="h-4 w-4 animate-spin text-muted-foreground mb-3" />}
        </div>
        {bad && <p className="text-xs text-muted-foreground">Filter with letters, digits, spaces and . + _ - only.</p>}

        <div className="flex flex-wrap gap-0.5" role="group" aria-label="First letter" data-testid="winget-letters">
          <Button size="sm" variant={letter ? 'ghost' : 'secondary'} className="h-6 px-2 text-[11px]" onClick={() => { setLetter(''); setPage(1); }}>All</Button>
          {LETTERS.map((l) => (
            <Button key={l} size="sm" variant={letter === l ? 'secondary' : 'ghost'} className="h-6 w-6 p-0 text-[11px]" aria-pressed={letter === l} onClick={() => { setLetter(letter === l ? '' : l); setPage(1); }}>{l}</Button>
          ))}
        </div>

        {canWrite && (
          <div className="flex flex-wrap items-center gap-2 rounded-md border bg-muted/30 p-2 text-xs" data-testid="winget-selection">
            <span>{picked.length ? `${picked.length} selected` : `Tick packages to add them to, or remove them from, ${targetLabel}.`}</span>
            {toAdd.length > 0 && (
              <Button size="sm" className="h-7 text-xs" disabled={add.isPending || toAdd.length > BULK_MAX} onClick={() => add.mutate()} data-testid="winget-add-selected">
                {add.isPending && <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />}Add {toAdd.length} selected to {targetLabel}
              </Button>
            )}
            {toAdd.length > BULK_MAX && <span className="text-muted-foreground">At most {BULK_MAX} at a time: each one reads its manifest from winget-pkgs.</span>}
            {toRemove.length > 0 && (
              <Button size="sm" variant="outline" className="h-7 text-xs" disabled={toRemove.length > REMOVE_MAX} onClick={() => setRemoving(toRemove)} data-testid="winget-remove-selected">
                Remove {toRemove.length} from {targetLabel}
              </Button>
            )}
            {toRemove.length > REMOVE_MAX && <span className="text-muted-foreground">Remove at most {REMOVE_MAX} at a time.</span>}
            {picked.length > 0 && <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={() => setSelected(new Map())}>Clear</Button>}
          </div>
        )}
        {d && !canWrite && (
          <p className="text-xs text-muted-foreground">
            {targetBusiness ? `Adding to ${targetLabel} is for its Business Owner or a Platform Admin.` : 'Adding to the global catalog is for a Platform Admin.'}
          </p>
        )}

        {browse.error ? <p className="text-xs text-muted-foreground">{refusalText(browse.error, 'The winget catalog could not be loaded.')}</p>
          : !d ? <p className="text-xs text-muted-foreground">Loading the winget catalog…</p>
          : d.total === 0 ? (
            <p className="text-xs text-muted-foreground rounded-md border p-3" data-testid="winget-no-results">
              {d.index.packages === 0
                ? 'Nothing to list: the winget index has not been read on this server yet (see above). The table fills once it has.'
                : `Nothing in the ${d.index.packages.toLocaleString()} packages matches${d.query ? ` “${d.query}”` : ''}${d.publisher ? ` from publisher ${d.publisher}` : ''}${d.letter ? ` starting with ${d.letter}` : ''}.`}
            </p>
          ) : (
            <>
              {d.query && !d.ranked && <p className="text-xs text-muted-foreground">More than 2,000 packages match “{d.query}”, so they are listed by name, not by relevance. Type more to narrow it.</p>}
              <div className="overflow-x-auto rounded-md border">
                <table className="w-full text-left text-xs" data-winget-results>
                  <thead className="text-muted-foreground">
                    <tr>
                      {canWrite && <th className="px-2 py-1.5 w-6"><input type="checkbox" aria-label="Select every package on this page" checked={allTicked} onChange={() => setSelected((m) => { const n = new Map(m); for (const r of allOnPage) { if (allTicked) n.delete(lower(r.packageId)); else n.set(lower(r.packageId), r); } return n; })} /></th>}
                      <th className="px-2 py-1.5 font-medium">
                        <button type="button" className="inline-flex items-center gap-1 whitespace-nowrap hover:underline" onClick={nameSort} data-testid="winget-sort-name" title="Sort by name">
                          Name {effSort === 'name' ? <ArrowUp className="h-3 w-3" /> : effSort === '-name' ? <ArrowDown className="h-3 w-3" /> : <span className="font-normal">· best match first</span>}
                        </button>
                      </th>
                      <th className="px-2 font-medium">Publisher</th>
                      <th className="px-2 font-medium">Package id</th>
                      <th className="px-2 font-medium">Latest version</th>
                      <th className="px-2 font-medium">In catalog</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((r) => {
                      const k = lower(r.packageId);
                      const res = results.get(k);
                      return (
                        <tr key={r.packageId} className="border-t align-top" data-winget-hit={r.packageId}>
                          {canWrite && <td className="px-2 py-1.5"><input type="checkbox" aria-label={`Select ${r.name}`} disabled={!selectable(r)} checked={selected.has(k)} onChange={() => toggle(r)} /></td>}
                          <td className="px-2 py-1.5 font-medium break-words">{r.name}</td>
                          <td className="px-2 py-1.5">
                            {r.publisher ? <button type="button" className="hover:underline text-left" title="Show only this publisher" onClick={() => { setPublisher(r.publisher!); setPage(1); }}>{r.publisher}</button> : <span className="text-muted-foreground">—</span>}
                          </td>
                          <td className="px-2 py-1.5 font-mono break-all">{r.packageId}</td>
                          <td className="px-2 py-1.5 font-mono">{r.latestVersion}{!r.installable && <span className="block font-sans text-muted-foreground">not installable from here</span>}</td>
                          <td className="px-2 py-1.5 space-y-0.5" data-in-catalog>
                            {r.inCatalog.map((m) => (
                              <Link key={m.entryId} href={`/automation/software/${m.entryId}`} className="block">
                                <Badge variant={m === own(r) ? 'secondary' : 'outline'} className="text-[10px]">in {m.scope === 'global' ? 'global' : m.businessName ?? 'business'} catalog · {m.version}</Badge>
                              </Link>
                            ))}
                            {res && <RowOutcome r={res} />}
                            {!r.inCatalog.length && !res && <span className="text-muted-foreground">—</span>}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              <div className="flex flex-wrap items-center justify-between gap-2 text-xs" data-testid="winget-pager">
                <span className="text-muted-foreground">
                  {((d.page - 1) * d.pageSize + 1).toLocaleString()}–{Math.min(d.page * d.pageSize, d.total).toLocaleString()} of {d.total.toLocaleString()} packages{d.total !== d.index.packages ? ` (of ${d.index.packages.toLocaleString()} in the index)` : ''} · page {d.page} of {d.pages}
                </span>
                <span className="flex gap-1">
                  <Button size="sm" variant="outline" className="h-7 text-xs" disabled={d.page <= 1 || browse.isFetching} onClick={() => setPage(d.page - 1)}><ChevronLeft className="h-3.5 w-3.5" />Previous</Button>
                  <Button size="sm" variant="outline" className="h-7 text-xs" disabled={d.page >= d.pages || browse.isFetching} onClick={() => setPage(d.page + 1)}>Next<ChevronRight className="h-3.5 w-3.5" /></Button>
                </span>
              </div>
            </>
          )}
      </CardContent>
      {removing && (
        <RemoveDialog
          items={removing} targetLabel={targetLabel}
          onDone={(out) => {
            setRemoving(null);
            setResults((m) => { const n = new Map(m); for (const x of out) n.set(lower(x.packageId), x); return n; });
            setSelected((m) => { const n = new Map(m); for (const x of out) if (x.status === 'removed') n.delete(lower(x.packageId)); return n; });
            browse.refetch(); onChanged();
          }}
          onClose={() => setRemoving(null)}
        />
      )}
    </Card>
  );
}

function RowOutcome({ r }: { r: RowResult }) {
  let text: string;
  let code: string | undefined;
  if (r.status === 'refused') { text = `refused (${r.code}): ${r.message}`; code = r.code; }
  else if (r.status === 'not_removed') text = `not removed: ${r.message}`;
  else if (r.status === 'removed') text = 'removed (archived)';
  else if (r.status === 'already') text = `already in the ${r.in} catalog at ${r.version}`;
  else text = r.status === 'added' ? `added at ${r.version}` : `moved to ${r.version}`;
  const bad = r.status === 'refused' || r.status === 'not_removed';
  return <span className={`block ${bad ? 'text-destructive' : 'text-muted-foreground'}`} data-row-outcome={r.status} data-code={code}>{text}</span>;
}

/** Remove selected packages from the target catalog: the ordinary archive route, one entry at a time, with one reason. */
function RemoveDialog({ items, targetLabel, onDone, onClose }: { items: { row: Row; mark: Mark }[]; targetLabel: string; onDone: (out: RowResult[]) => void; onClose: () => void }) {
  const [reason, setReason] = useState('');
  const m = useMutation({
    mutationFn: async () => {
      const out: RowResult[] = [];
      for (const { row, mark } of items) {
        try {
          await softwareApi.archive(mark.entryId, { reason: reason.trim(), expectedRevision: mark.revision });
          out.push({ packageId: row.packageId, status: 'removed' });
        } catch (e) {
          out.push({ packageId: row.packageId, status: 'not_removed', message: refusalText(e, 'refused') });
        }
      }
      return out;
    },
    onSuccess: onDone,
  });
  return (
    <Dialog open onOpenChange={(o) => { if (!o && !m.isPending) onClose(); }}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Remove {items.length} from {targetLabel}</DialogTitle>
          <DialogDescription>
            Each entry is archived: it can no longer be installed from, and with an approval signer configured it is revoked there first, so a plan already signed from it is refused by the computer. Software already installed stays installed.
          </DialogDescription>
        </DialogHeader>
        <ul className="list-disc pl-5 text-xs">{items.map(({ row, mark }) => <li key={mark.entryId}>{row.name} <span className="font-mono">{mark.version}</span></li>)}</ul>
        <div className="space-y-1">
          <Label htmlFor="wb-reason" className="text-xs">Why (recorded in the audit log)</Label>
          <Textarea id="wb-reason" rows={2} maxLength={300} value={reason} onChange={(e) => setReason(e.target.value)} />
        </div>
        <DialogFooter>
          <Button size="sm" variant="outline" disabled={m.isPending} onClick={onClose}>Cancel</Button>
          <Button size="sm" variant="destructive" disabled={reason.trim().length < 3 || m.isPending} onClick={() => m.mutate()}>
            {m.isPending && <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />}Remove {items.length}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
