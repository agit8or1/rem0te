'use client';

/**
 * Global search (0.33): a command palette over GET /search.
 *
 * The server decides everything that matters — which groups this person may
 * see (a group they may not use comes back null and is not drawn at all),
 * which rows are in scope, the ranking and the cap of eight per group. This
 * component only debounces the typing, draws the groups, and moves a
 * keyboard cursor through them. Every result is a link to the object's page,
 * which applies its own access rule again when it loads.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { Building2, Laptop, Loader2, MapPin, Search, Siren, User } from 'lucide-react';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { searchApi, type SearchComputerField, type SearchResults } from '@/lib/api-client';
import { cn } from '@/lib/utils';

const MIN = 2;
const MAX = 100;
const DEBOUNCE_MS = 200;

const FIELD_LABEL: Record<SearchComputerField, string> = {
  hostname: 'Hostname', rustdeskId: 'RustDesk ID', serialNumber: 'Serial', loggedOnUser: 'Signed in',
  ipAddress: 'IP address', privateIp: 'Adapter IP', alias: 'Alias',
};

type GroupKey = keyof SearchResults['groups'];
interface Item {
  key: string; group: GroupKey; href: string;
  title: string; detail: string | null; tag?: { text: string; tone: 'ok' | 'muted' | 'warn' | 'bad' } | null;
}
const GROUP_META: Record<GroupKey, { label: string; icon: typeof Laptop }> = {
  computers: { label: 'Devices', icon: Laptop },
  businesses: { label: 'Businesses', icon: Building2 },
  sites: { label: 'Sites', icon: MapPin },
  users: { label: 'People', icon: User },
  alerts: { label: 'Open alerts', icon: Siren },
};
const ORDER: GroupKey[] = ['computers', 'businesses', 'sites', 'users', 'alerts'];

const join = (...parts: (string | null | undefined | false)[]) => parts.filter(Boolean).join(' · ') || null;

/** The rows of every group the caller may see, in display order, each with the page it opens. */
function toItems(r: SearchResults): Record<GroupKey, Item[] | null> {
  const g = r.groups;
  return {
    computers: g.computers?.items.map((c) => ({
      key: `c:${c.id}`, group: 'computers', href: `/endpoints/${c.id}`,
      title: c.name,
      detail: join(c.match ? `${FIELD_LABEL[c.match.field] ?? c.match.field}: ${c.match.value ?? ''}` : c.hostname, c.business?.name, c.site?.name),
      tag: c.isOnline ? { text: 'Online', tone: 'ok' } : { text: 'Offline', tone: 'muted' },
    })) ?? null,
    businesses: g.businesses?.items.map((b) => ({
      key: `b:${b.id}`, group: 'businesses', href: `/businesses/${b.id}`,
      title: b.name, detail: join(b.code, b.city), tag: b.isActive ? null : { text: 'Inactive', tone: 'muted' },
    })) ?? null,
    sites: g.sites?.items.map((s) => ({
      key: `s:${s.id}`, group: 'sites',
      // The site's devices: the device list filtered to it.
      href: `/endpoints?businessId=${encodeURIComponent(s.business.id)}&siteId=${encodeURIComponent(s.id)}`,
      title: s.name, detail: join(s.business.name, s.city),
    })) ?? null,
    users: g.users?.items.map((u) => ({
      key: `u:${u.membershipId}`, group: 'users', href: `/users?search=${encodeURIComponent(u.email)}`,
      title: u.name ?? u.email, detail: join(u.name ? u.email : null, u.accessLevel, u.business?.name),
      tag: u.status === 'ACTIVE' ? null : { text: u.status.toLowerCase(), tone: 'muted' },
    })) ?? null,
    alerts: g.alerts?.items.map((a) => ({
      key: `a:${a.id}`, group: 'alerts',
      href: a.computer ? `/endpoints/${a.computer.id}?tab=monitoring` : '/alerts',
      title: a.title, detail: join(a.computer?.name ?? a.site?.name, a.business?.name, a.state === 'ACKNOWLEDGED' && 'acknowledged'),
      tag: { text: a.severity.toLowerCase(), tone: a.severity === 'CRITICAL' ? 'bad' : a.severity === 'WARNING' ? 'warn' : 'muted' },
    })) ?? null,
  };
}

/** The first occurrence of the query, marked. Plain text otherwise. */
function Mark({ text, q }: { text: string; q: string }) {
  const i = q ? text.toLowerCase().indexOf(q.toLowerCase()) : -1;
  if (i < 0) return <>{text}</>;
  return <>{text.slice(0, i)}<mark className="rounded-sm bg-yellow-200/70 px-0 text-inherit dark:bg-yellow-500/30">{text.slice(i, i + q.length)}</mark>{text.slice(i + q.length)}</>;
}

const TONE = {
  ok: 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-400',
  muted: 'bg-muted text-muted-foreground',
  warn: 'bg-amber-500/15 text-amber-700 dark:text-amber-400',
  bad: 'bg-red-500/15 text-red-700 dark:text-red-400',
};

function errorText(e: unknown): string {
  const r = (e as { response?: { status?: number; data?: { message?: string } } })?.response;
  if (r?.status === 429) return 'Too many searches from here in the last minute. Wait a moment and try again.';
  return r?.data?.message ?? 'Search failed. Try again.';
}

export function CommandPalette({ open, onOpenChange }: { open: boolean; onOpenChange: (v: boolean) => void }) {
  const router = useRouter();
  const [text, setText] = useState('');
  const [q, setQ] = useState('');
  const [active, setActive] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

  // Debounce: one request when typing pauses, not one per keystroke.
  useEffect(() => {
    const t = setTimeout(() => setQ(text.trim().replace(/\s+/g, ' ')), DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [text]);
  useEffect(() => { if (!open) { setText(''); setQ(''); } }, [open]);

  const ready = q.length >= MIN && q.length <= MAX;
  const { data, error, isFetching } = useQuery({
    queryKey: ['global-search', q],
    queryFn: ({ signal }) => searchApi.search(q, signal).then((r) => r.data.data),
    enabled: open && ready,
    staleTime: 15_000,
    retry: false,
  });
  const shown = ready ? data : undefined;
  const groups = useMemo(() => (shown && shown.query === q ? toItems(shown) : null), [shown, q]);
  const flat = useMemo(() => (groups ? ORDER.flatMap((k) => groups[k] ?? []) : []), [groups]);
  useEffect(() => { setActive(0); }, [groups]);
  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>(`[data-index="${active}"]`);
    el?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  function go(item: Item | undefined) {
    if (!item) return;
    openHref(item.href);
  }
  function openHref(href: string) {
    onOpenChange(false);
    // The device list and the users page read their filters from the address
    // when they mount; on the same page, a client-side push would not remount
    // them, so that one case is a full navigation.
    const path = href.split('?')[0];
    if (href.includes('?') && path === window.location.pathname) window.location.assign(href);
    else router.push(href);
  }
  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (!flat.length) return;
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive((i) => (i + 1) % flat.length); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((i) => (i - 1 + flat.length) % flat.length); }
    else if (e.key === 'Home' && e.ctrlKey) { e.preventDefault(); setActive(0); }
    else if (e.key === 'End' && e.ctrlKey) { e.preventDefault(); setActive(flat.length - 1); }
    else if (e.key === 'Enter') { e.preventDefault(); go(flat[active]); }
  }

  const visibleGroups = groups ? ORDER.filter((k) => groups[k] !== null) : [];
  const total = flat.length;
  const activeId = total ? `gs-opt-${active}` : undefined;
  let index = -1;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        data-testid="global-search"
        className="top-0 flex h-[100dvh] max-w-xl translate-y-0 flex-col gap-0 overflow-hidden p-0 data-[state=closed]:slide-out-to-top-0 data-[state=open]:slide-in-from-top-0 sm:top-[10vh] sm:h-auto sm:max-h-[75vh]"
      >
        <DialogTitle className="sr-only">Search</DialogTitle>
        <DialogDescription className="sr-only">
          Search devices, businesses, sites, people and open alerts you have access to. Use the arrow keys to move and Enter to open.
        </DialogDescription>
        <div className="flex items-center gap-2 border-b px-3 pr-11">
          {isFetching ? <Loader2 className="h-4 w-4 shrink-0 animate-spin text-muted-foreground" /> : <Search className="h-4 w-4 shrink-0 text-muted-foreground" />}
          <input
            autoFocus
            value={text}
            maxLength={MAX}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder="Search devices, businesses, people…"
            aria-label="Search"
            role="combobox"
            aria-expanded={total > 0}
            aria-controls="gs-results"
            aria-activedescendant={activeId}
            aria-autocomplete="list"
            data-testid="global-search-input"
            className="h-12 w-full min-w-0 bg-transparent text-base outline-none placeholder:text-muted-foreground sm:text-sm"
          />
        </div>

        <div ref={listRef} id="gs-results" role="listbox" aria-label="Search results" className="min-h-0 flex-1 overflow-y-auto p-2 text-sm">
          {!ready && (
            <p className="px-2 py-6 text-center text-muted-foreground" data-testid="global-search-hint">
              {text.trim().length > MAX ? `At most ${MAX} characters.` : `Type at least ${MIN} characters.`}
              <span className="mt-1 block text-xs">
                Devices by name, hostname, RustDesk ID, serial, signed-in user or IP address; businesses, sites, people and open alerts — only those you can open.
              </span>
            </p>
          )}
          {ready && error && <p className="px-2 py-6 text-center text-muted-foreground" role="alert">{errorText(error)}</p>}
          {ready && !error && !groups && <p className="px-2 py-6 text-center text-muted-foreground">Searching…</p>}
          {groups && total === 0 && (
            <p className="px-2 py-6 text-center text-muted-foreground" data-testid="global-search-empty">
              Nothing you can open matches <span className="font-medium text-foreground">“{q}”</span>.
            </p>
          )}
          {groups && total > 0 && visibleGroups.map((k) => {
            const items = groups[k] ?? [];
            if (!items.length) return null;
            const { label, icon: Icon } = GROUP_META[k];
            const more = shown?.groups[k]?.more;
            return (
              <div key={k} role="group" aria-labelledby={`gs-h-${k}`} className="mb-1" data-group={k}>
                <div id={`gs-h-${k}`} className="flex items-center gap-2 px-2 pb-1 pt-2 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                  <Icon className="h-3.5 w-3.5" />{label}
                  {more && <span className="font-normal normal-case tracking-normal">· first {shown?.cap}</span>}
                </div>
                {items.map((it) => {
                  index += 1;
                  const i = index;
                  const on = i === active;
                  return (
                    <a
                      key={it.key}
                      id={`gs-opt-${i}`}
                      data-index={i}
                      role="option"
                      aria-selected={on}
                      href={it.href}
                      onMouseMove={() => { if (!on) setActive(i); }}
                      onClick={(e) => { if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return; e.preventDefault(); go(it); }}
                      className={cn('flex min-w-0 items-center gap-3 rounded-md px-2 py-2 outline-none', on ? 'bg-accent text-accent-foreground' : 'text-foreground')}
                    >
                      <div className="min-w-0 flex-1">
                        <div className="truncate font-medium"><Mark text={it.title} q={q} /></div>
                        {it.detail && <div className="truncate text-xs text-muted-foreground"><Mark text={it.detail} q={q} /></div>}
                      </div>
                      {it.tag && <span className={cn('shrink-0 rounded px-1.5 py-0.5 text-[11px] font-medium', TONE[it.tag.tone])}>{it.tag.text}</span>}
                    </a>
                  );
                })}
                {k === 'computers' && more && (
                  <a href={`/endpoints?search=${encodeURIComponent(q)}`} onClick={(e) => { e.preventDefault(); openHref(`/endpoints?search=${encodeURIComponent(q)}`); }}
                    className="block px-2 py-1.5 text-xs text-primary hover:underline">
                    More devices: search the device list
                  </a>
                )}
              </div>
            );
          })}
        </div>

        <div className="hidden items-center gap-3 border-t px-3 py-2 text-[11px] text-muted-foreground sm:flex">
          <span><kbd className="rounded border px-1">↑</kbd> <kbd className="rounded border px-1">↓</kbd> move</span>
          <span><kbd className="rounded border px-1">Enter</kbd> open</span>
          <span><kbd className="rounded border px-1">Esc</kbd> close</span>
        </div>
      </DialogContent>
    </Dialog>
  );
}
