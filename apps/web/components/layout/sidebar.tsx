'use client';

/**
 * The main menu (0.87 Compass): nine groups from nav-model.ts on the
 * navigation colour, compact and collapsible.
 *
 *   Expanded   232 px. Rows 36 px (32 in compact density), icons 18 px. The
 *              group holding the current page opens by itself; opening
 *              another closes the rest, except groups the person pinned
 *              (the pin beside each group name). Standard mode lists each
 *              group's everyday pages; Advanced lists all of them. Either
 *              way the rest are tabs of the same pages and in Ctrl+K.
 *   Collapsed  60 px icon rail. Each icon has a tooltip (on hover and on
 *              keyboard focus) and opens its group as a flyout menu (Radix:
 *              a real menu, arrow keys, Esc returns focus to the icon).
 *   Drawer     Below `md` the same sidebar, always expanded, inside the
 *              off-canvas drawer (nav-drawer.tsx).
 *
 * A technician workspace (0.90, lib/workspace-modes.ts) lists only its own
 * pages and leaves out a group with none (the page you are on is still
 * listed); a line at the foot names it and goes back to every page.
 *
 * Collapsed, mode and pinned groups are the person's own preferences, kept
 * on the server (GET/PUT /me/navigation). Hiding an entry is a convenience,
 * never the control: every route checks permissions itself.
 */
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { ChevronDown, Pin, PinOff, Shield } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { NAV, locate, sidebarItems, under, visibleItems, type NavLeaf, type NavSection } from './nav-model';
import { workspaceOf } from '@/lib/workspace-modes';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { cn } from '@/lib/utils';
import { updateApi } from '@/lib/api-client';
import { useBrandAccent } from './brand-accent';
import { usePermissions } from '@/lib/auth';
import { useNavCtx, useNavigation } from '@/lib/navigation';

export const SIDEBAR_WIDTH = { expanded: 232, collapsed: 60 } as const;

type Tip = { label: string; top: number } | null;

export function Sidebar({ className, inDrawer = false }: { className?: string; inDrawer?: boolean } = {}) {
  const pathname = usePathname() ?? '/';
  const { accessLevel } = usePermissions();
  const ctx = useNavCtx();
  const { prefs, setPrefs } = useNavigation();
  const collapsed = !inDrawer && prefs.sidebarCollapsed;
  const mode = prefs.mode;
  const workspace = workspaceOf(prefs.workspace);
  const pinned = useMemo(() => new Set(prefs.pinnedGroups), [prefs.pinnedGroups]);
  const { portalTitle, logoUrl, accentColor, ink } = useBrandAccent();
  const here = locate(pathname);
  const activeGroup = here?.section.id ?? null;

  // One group opened by hand at a time; the current page's group opens by
  // itself, and the person may close it (until they move to another group).
  const [opened, setOpened] = useState<string | null>(null);
  const [closedActive, setClosedActive] = useState(false);
  useEffect(() => { setClosedActive(false); setOpened(null); }, [activeGroup]);
  const isOpen = (id: string) => pinned.has(id) || opened === id || (id === activeGroup && !closedActive);
  function toggle(id: string) {
    if (isOpen(id)) {
      if (id === activeGroup) setClosedActive(true);
      if (opened === id) setOpened(null);
      if (pinned.has(id)) setPrefs({ pinnedGroups: prefs.pinnedGroups.filter((g) => g !== id) });
    } else {
      setOpened(id);
      if (id === activeGroup) setClosedActive(false);
    }
  }
  function togglePin(id: string) {
    setPrefs({ pinnedGroups: pinned.has(id) ? prefs.pinnedGroups.filter((g) => g !== id) : [...prefs.pinnedGroups, id] });
  }

  // The tooltip of the collapsed rail: positioned beside the hovered or
  // focused icon, outside the scrolling list so it is never clipped.
  const [tip, setTip] = useState<Tip>(null);
  const tipFor = (label: string) => collapsed ? {
    onMouseEnter: (e: React.MouseEvent<HTMLElement>) => setTip({ label, top: e.currentTarget.getBoundingClientRect().top + 18 }),
    onMouseLeave: () => setTip(null),
    onFocus: (e: React.FocusEvent<HTMLElement>) => setTip({ label, top: e.currentTarget.getBoundingClientRect().top + 18 }),
    onBlur: () => setTip(null),
  } : {};

  const row = (active: boolean) => cn(
    'nav-row group/row flex w-full min-w-0 items-center gap-3 rounded-md px-2.5 text-sm font-medium outline-none transition-colors',
    'focus-visible:ring-2 focus-visible:ring-[var(--nav-focus)] focus-visible:ring-offset-0',
    active ? 'bg-[var(--nav-active-bg)] text-[var(--nav-active-fg)]' : 'text-[var(--nav-fg-muted)] hover:bg-[var(--nav-hover)] hover:text-[var(--nav-fg)]',
    collapsed && 'justify-center px-0',
  );

  function leafLink(i: NavLeaf, opts: { child?: boolean; groupId?: string } = {}) {
    const active = here?.leaf?.href === i.href;
    const Icon = i.icon;
    return (
      <Link key={i.href} href={i.href} className={cn(row(active), opts.child && !collapsed && 'nav-child pl-[2.125rem] font-normal')}
        aria-current={active ? 'page' : undefined} data-nav-item={i.href} data-testid={i.testId}
        {...(opts.groupId ? { 'data-nav': opts.groupId } : {})}
        aria-label={collapsed ? i.label : undefined} {...tipFor(i.label)}>
        {!opts.child && <Icon className="h-[18px] w-[18px] shrink-0" aria-hidden="true" />}
        {!collapsed && <span className="truncate">{i.label}</span>}
      </Link>
    );
  }

  function group(section: NavSection) {
    const visible = visibleItems(section, ctx);
    if (!visible.length) return null;
    let items = sidebarItems(section, ctx, mode, workspace.id);
    // In Standard, an advanced page you are on is still listed, so you can see where you are.
    if (here?.section.id === section.id && here.leaf && !items.includes(here.leaf) && visible.includes(here.leaf)) items = [...items, here.leaf];
    if (!items.length && workspace.pages) return null;
    if (!items.length) items = visible.slice(0, 1);
    const Icon = section.icon;
    const active = activeGroup === section.id;
    // A group with one entry is that entry: one click, no expander.
    if (section.kind === 'link' || items.length === 1) {
      const only = items[0];
      const label = section.kind === 'link' ? section.label : only.label;
      return (
        <li key={section.id}>
          {leafLink({ ...only, label, icon: section.kind === 'link' ? only.icon : Icon }, { groupId: section.id })}
        </li>
      );
    }
    if (collapsed) {
      return (
        <li key={section.id}>
          <DropdownMenu onOpenChange={(o) => { if (o) setTip(null); }}>
            <DropdownMenuTrigger asChild>
              <button type="button" className={row(active)} aria-label={section.label} data-nav={section.id} {...tipFor(section.label)}>
                <Icon className="h-[18px] w-[18px] shrink-0" aria-hidden="true" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent side="right" align="start" sideOffset={8} className="w-60" data-testid={`nav-flyout-${section.id}`}>
              <DropdownMenuLabel className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{section.label}</DropdownMenuLabel>
              {visible.map((i) => {
                const I = i.icon;
                const on = here?.leaf?.href === i.href;
                return (
                  <DropdownMenuItem key={i.href} asChild>
                    <Link href={i.href} aria-current={on ? 'page' : undefined} className={cn('gap-2', on && 'font-semibold')} data-nav-item={i.href}>
                      <I className="h-4 w-4" aria-hidden="true" />{i.label}
                    </Link>
                  </DropdownMenuItem>
                );
              })}
            </DropdownMenuContent>
          </DropdownMenu>
        </li>
      );
    }
    const open = isOpen(section.id);
    const listId = `nav-group-${section.id}`;
    const isPinned = pinned.has(section.id);
    return (
      <li key={section.id} data-group={section.id}>
        {/* The pin overlays the row's right side, left of the chevron, so it never takes the label's width
            (at 232 px "Remote support" was cut to "Remote supp…" by an invisible pin). */}
        <div className="relative flex items-center">
          <button type="button" onClick={() => toggle(section.id)} aria-expanded={open} aria-controls={listId} data-nav={section.id}
            className={cn(row(false), active && !open && 'text-[var(--nav-fg)]', active && 'font-semibold text-[var(--nav-fg)]')}>
            <Icon className="h-[18px] w-[18px] shrink-0" aria-hidden="true" />
            <span className="flex-1 truncate text-left">{section.label}</span>
            <ChevronDown className={cn('h-3.5 w-3.5 shrink-0 opacity-70 transition-transform motion-reduce:transition-none', !open && '-rotate-90')} aria-hidden="true" />
          </button>
          {!inDrawer && (
            <button type="button" onClick={() => togglePin(section.id)} aria-pressed={isPinned}
              aria-label={isPinned ? `Unpin ${section.label}` : `Pin ${section.label} open`} title={isPinned ? 'Unpin: closes with the others' : 'Pin: stays open'}
              data-testid={`nav-pin-${section.id}`}
              className={cn('absolute right-7 top-1/2 flex h-6 w-6 -translate-y-1/2 items-center justify-center rounded-md text-[var(--nav-fg-muted)] outline-none transition-opacity hover:bg-[var(--nav-hover)] hover:text-[var(--nav-fg)] focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-[var(--nav-focus)]',
                isPinned ? 'opacity-100' : 'opacity-0 group-hover/nav:opacity-60')}>
              {isPinned ? <PinOff className="h-3.5 w-3.5" aria-hidden="true" /> : <Pin className="h-3.5 w-3.5" aria-hidden="true" />}
            </button>
          )}
        </div>
        {open && (
          <ul id={listId} className="mt-0.5 space-y-0.5" aria-label={section.label}>
            {items.map((i) => <li key={i.href}>{leafLink(i, { child: true })}</li>)}
          </ul>
        )}
      </li>
    );
  }

  const { data: build } = useQuery({
    queryKey: ['app-version'],
    queryFn: () => updateApi.appVersion().then((r) => r.data?.data as { version: string; codename: string | null } | undefined),
    staleTime: 60 * 60 * 1000,
    retry: false,
  });

  const navRef = useRef<HTMLElement>(null);
  return (
    <aside
      className={cn('nav-shell group/nav relative flex h-screen shrink-0 flex-col bg-[var(--nav-bg)] text-[var(--nav-fg)] transition-[width] duration-150 motion-reduce:transition-none', className)}
      style={inDrawer ? undefined : { width: collapsed ? SIDEBAR_WIDTH.collapsed : SIDEBAR_WIDTH.expanded }}
      data-collapsed={collapsed ? 'true' : 'false'} data-testid="sidebar"
    >
      <div
        className={cn('flex h-12 shrink-0 items-center gap-2 border-b border-[var(--nav-border)]', collapsed ? 'justify-center px-2' : 'px-3')}
        style={accentColor && ink ? { backgroundColor: accentColor, color: ink } : undefined}
        data-testid="brand-header"
      >
        {logoUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={logoUrl} alt={portalTitle} className={cn('h-7 w-auto object-contain', collapsed ? 'max-w-[36px]' : 'max-w-[100px]')}
            onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }} />
        ) : (
          <Shield className={cn('h-5 w-5 shrink-0', !accentColor && 'text-[var(--nav-accent)]')} aria-hidden="true" />
        )}
        {!collapsed && (
          <div className="min-w-0 leading-tight">
            <div className="truncate text-sm font-semibold">{portalTitle}</div>
            {accessLevel && <div className={cn('truncate text-xs', !accentColor && 'text-[var(--nav-fg-muted)]')}>{accessLevel}</div>}
          </div>
        )}
      </div>

      <nav ref={navRef} className={cn('nav-scroll min-h-0 flex-1 overflow-y-auto overflow-x-hidden py-2', collapsed ? 'px-2' : 'px-2')} aria-label="Main"
        onScroll={() => setTip(null)}>
        <ul className="space-y-0.5">{NAV.map(group)}</ul>
      </nav>

      {workspace.pages && (
        <div className={cn('shrink-0 border-t border-[var(--nav-border)] py-2', collapsed ? 'px-1 text-center' : 'px-3')} data-testid="nav-workspace">
          {!collapsed && <p className="truncate text-xs text-[var(--nav-fg-muted)]">Workspace: {workspace.label}</p>}
          <button type="button" onClick={() => setPrefs({ workspace: 'all' })} data-testid="nav-workspace-all"
            className="mt-0.5 block w-full truncate rounded text-left text-xs text-[var(--nav-fg)] underline-offset-2 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-[var(--nav-focus)]"
            aria-label={`Show every page (leave the ${workspace.label} workspace)`} {...(collapsed ? tipFor('Show every page') : {})}>
            {collapsed ? 'All' : 'Show every page'}
          </button>
        </div>
      )}

      {build?.version && (
        <div className={cn('shrink-0 border-t border-[var(--nav-border)] py-2', collapsed ? 'px-1 text-center' : 'px-3')}>
          <Link href="/about" className="block truncate rounded text-xs text-[var(--nav-fg-muted)] outline-none hover:text-[var(--nav-fg)] focus-visible:ring-2 focus-visible:ring-[var(--nav-focus)]"
            title={build.codename ? `Rem0te v${build.version} — ${build.codename}` : `Rem0te v${build.version}`} data-testid="nav-version">
            {collapsed ? `v${build.version.split('.').slice(0, 2).join('.')}` : <>v{build.version}{build.codename && <span className="ml-1">· {build.codename}</span>}</>}
          </Link>
        </div>
      )}

      {collapsed && tip && (
        <div role="tooltip" className="pointer-events-none fixed z-[60] -translate-y-1/2 whitespace-nowrap rounded-md bg-popover px-2 py-1 text-xs font-medium text-popover-foreground shadow-md ring-1 ring-border"
          style={{ left: SIDEBAR_WIDTH.collapsed + 6, top: tip.top }} data-testid="nav-tooltip">
          {tip.label}
        </div>
      )}
    </aside>
  );
}

/** Whether `path` is one of the menu's pages (for tests and the palette). */
export function isMenuPage(path: string) {
  return NAV.some((s) => s.items.some((i) => under(path, i.href)));
}
