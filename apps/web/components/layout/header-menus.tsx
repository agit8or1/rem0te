'use client';

/**
 * The header's menus (0.87 Compass): breadcrumbs, the customer the person
 * is working in, favourites and recent items, quick actions, critical
 * alerts, help and the profile menu (theme, density, navigation mode,
 * account, sign out). Every one is a Radix menu or a link: keyboard
 * reachable, Esc closes and returns focus to its button.
 *
 * None of it is a control. A quick action is a link to the page that does
 * the work, drawn only when the menu would show that page; favourites are
 * named by the server through each record's own visibility rule.
 */
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Bell, Building2, Check, ChevronRight, ChevronsUpDown, CircleHelp, Globe, Heart, LayoutGrid, LogOut, Monitor, Moon, Plus, Star,
  StarOff, Sun, UserCircle, X, Info,
} from 'lucide-react';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuRadioGroup, DropdownMenuRadioItem,
  DropdownMenuSeparator, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { authApi, businessesApi, monitoringApi, setActiveBusiness, type NavItem } from '@/lib/api-client';
import { CAP, usePermissions } from '@/lib/auth';
import { useTheme } from '@/lib/theme-provider';
import { targetOf, useNavCtx, useNavigation } from '@/lib/navigation';
import { cn } from '@/lib/utils';
import { allPages, locate, pageLabel, visibleItems } from './nav-model';
import { WORKSPACES, type WorkspaceId } from '@/lib/workspace-modes';

export const headerButton = 'flex h-8 shrink-0 items-center justify-center gap-1.5 rounded-md px-2 text-sm text-muted-foreground outline-none transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:ring-2 focus-visible:ring-ring data-[state=open]:bg-accent data-[state=open]:text-accent-foreground';

// ── Breadcrumbs ──────────────────────────────────────────────────────────────

const DETAIL: Record<string, string> = { '/endpoints': 'Device', '/businesses': 'Customer', '/automation/scripts': 'Script', '/alerts': 'Alert', '/patching': 'Policy', '/automation/schedules': 'Schedule' };

export function Breadcrumbs() {
  const pathname = usePathname() ?? '/';
  const ctx = useNavCtx();
  const here = locate(pathname);
  if (!here) return null;
  const { section, leaf } = here;
  const first = visibleItems(section, ctx)[0];
  const crumbs: { label: string; href?: string }[] = [];
  if (section.kind !== 'link') crumbs.push({ label: section.label, href: first && first.href !== pathname ? first.href : undefined });
  if (leaf) crumbs.push({ label: leaf.label, href: leaf.href !== pathname ? leaf.href : undefined });
  if (leaf && leaf.href !== pathname) crumbs.push({ label: DETAIL[leaf.href] ?? 'Details' });
  if (!crumbs.length) return null;
  return (
    <nav aria-label="Breadcrumb" className="hidden min-w-0 items-center lg:flex" data-testid="breadcrumbs">
      <ol className="flex min-w-0 items-center gap-1 text-sm">
        {crumbs.map((c, i) => {
          const last = i === crumbs.length - 1;
          return (
            <li key={`${c.label}-${i}`} className="flex min-w-0 items-center gap-1">
              {i > 0 && <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />}
              {c.href && !last ? (
                <Link href={c.href} className="truncate rounded text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring">{c.label}</Link>
              ) : (
                <span className={cn('truncate', last ? 'font-medium text-foreground' : 'text-muted-foreground')} aria-current={last ? 'page' : undefined}>{c.label}</span>
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

// ── Customer context ─────────────────────────────────────────────────────────

/**
 * Which customer the person is working in.
 *
 * A technician with assignments switches business: a cookie the API reads
 * and honours only for their own business or a live assignment (0.30; this
 * is the old sidebar BusinessSwitcher, moved). A Platform Admin, who sees
 * every customer anyway, picks one to keep in view: stored as
 * contextBusinessId, checked against GET /businesses' own rule on every
 * read, and a shortcut to that customer, never a filter on what they may see.
 */
export function ContextSelector() {
  const router = useRouter();
  const qc = useQueryClient();
  const { user, technician, assignedBusinesses, businessName, isPlatformAdmin } = usePermissions();
  const { prefs, setPrefs } = useNavigation();
  const { data: customers } = useQuery({
    queryKey: ['businesses', 'context-list'],
    queryFn: () => businessesApi.list().then((r) => ((r.data as { data?: { id: string; name: string }[] })?.data ?? [])),
    enabled: !!user && isPlatformAdmin,
    staleTime: 5 * 60_000,
  });
  if (!user) return null;

  if (assignedBusinesses.length > 0) {
    const activeId = technician?.businessId ?? user.businessId ?? null;
    const label = technician?.businessName ?? businessName ?? 'My account';
    const choose = async (id: string | null) => { setActiveBusiness(id); await qc.invalidateQueries(); router.refresh(); };
    return (
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button type="button" className={cn(headerButton, 'max-w-[14rem] border bg-card text-foreground')} aria-label={`Switch customer: ${label}`} data-testid="context-selector">
            <Building2 className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
            <span className="hidden min-w-0 truncate sm:inline">{label}</span>
            {technician && <span className="hidden rounded bg-amber-500/15 px-1 text-xs font-medium text-amber-800 dark:text-amber-300 md:inline">Technician</span>}
            <ChevronsUpDown className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-64">
          <DropdownMenuLabel className="text-xs text-muted-foreground">Working in</DropdownMenuLabel>
          <DropdownMenuItem onClick={() => choose(user.ownBusinessId ?? null)} className="gap-2">
            {!technician ? <Check className="h-4 w-4" /> : <span className="w-4" />}
            {user.ownBusinessId ? (user.business?.name && !technician ? user.business.name : 'My own customer') : 'My account'}
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          {assignedBusinesses.map((b) => (
            <DropdownMenuItem key={b.id} onClick={() => choose(b.id)} className="gap-2">
              {activeId === b.id && technician ? <Check className="h-4 w-4" /> : <span className="w-4" />}
              <span className="truncate">{b.name}</span>
            </DropdownMenuItem>
          ))}
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={() => router.push('/technician')} className="gap-2"><LayoutGrid className="h-4 w-4" />All assigned customers</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    );
  }

  if (!isPlatformAdmin) return null;
  const current = prefs.contextBusiness;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button type="button" className={cn(headerButton, 'max-w-[14rem] border bg-card', current ? 'text-foreground' : '')}
          aria-label={current ? `Customer in view: ${current.name}` : 'Choose a customer to keep in view'} data-testid="context-selector">
          <Building2 className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
          <span className="hidden min-w-0 truncate sm:inline">{current?.name ?? 'All customers'}</span>
          <ChevronsUpDown className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="max-h-[70vh] w-64 overflow-y-auto">
        {current && (
          <>
            <DropdownMenuItem asChild><Link href={`/businesses/${current.id}`} className="gap-2"><Building2 className="h-4 w-4" />Open {current.name}</Link></DropdownMenuItem>
            <DropdownMenuSeparator />
          </>
        )}
        <DropdownMenuLabel className="text-xs text-muted-foreground">Keep in view</DropdownMenuLabel>
        <DropdownMenuItem onClick={() => setPrefs({ contextBusinessId: null })} className="gap-2" data-testid="context-none">
          {!current ? <Check className="h-4 w-4" /> : <span className="w-4" />}All customers
        </DropdownMenuItem>
        {(customers ?? []).slice(0, 50).map((b) => (
          <DropdownMenuItem key={b.id} onClick={() => setPrefs({ contextBusinessId: b.id })} className="gap-2" data-testid="context-option">
            {current?.id === b.id ? <Check className="h-4 w-4" /> : <span className="w-4" />}<span className="truncate">{b.name}</span>
          </DropdownMenuItem>
        ))}
        {(customers?.length ?? 0) > 50 && <DropdownMenuItem asChild><Link href="/businesses" className="text-muted-foreground">All {customers!.length} customers…</Link></DropdownMenuItem>}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

// ── Favourites and recent ────────────────────────────────────────────────────

function itemLabel(i: NavItem) {
  if (i.kind === 'page') { const p = pageLabel(i.href); return { title: p?.label ?? i.href, detail: p?.group ?? null }; }
  return { title: i.title ?? 'Untitled', detail: i.detail };
}
const KIND_WORD: Record<NavItem['kind'], string> = { device: 'Device', business: 'Customer', site: 'Site', script: 'Script', page: 'Page' };

export function FavoritesMenu() {
  const pathname = usePathname() ?? '/';
  const { favorites, recent, favoriteOf, toggleFavorite, removeFavorite, caps, favError } = useNavigation();
  const target = targetOf(pathname);
  const fav = target ? favoriteOf(target.kind, target.ref) : null;
  const full = !fav && favorites.length >= caps.favorites;
  const row = (i: NavItem, removable: boolean) => {
    const l = itemLabel(i);
    return (
      <DropdownMenuItem key={i.id} asChild className="group/fav pr-1">
        <Link href={i.href} className="flex min-w-0 items-center gap-2" data-testid={removable ? 'favorite-item' : 'recent-item'}>
          <span className="min-w-0 flex-1">
            <span className="block truncate">{l.title}</span>
            <span className="block truncate text-xs text-muted-foreground">{KIND_WORD[i.kind]}{l.detail ? ` · ${l.detail}` : ''}</span>
          </span>
          {removable && (
            <button type="button" aria-label={`Remove ${l.title} from favourites`} className="rounded p-1 text-muted-foreground hover:bg-background hover:text-foreground"
              onClick={(e) => { e.preventDefault(); e.stopPropagation(); removeFavorite(i.id); }}>
              <X className="h-3.5 w-3.5" aria-hidden="true" />
            </button>
          )}
        </Link>
      </DropdownMenuItem>
    );
  };
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button type="button" className={headerButton} aria-label="Favourites and recent" data-testid="favorites-trigger">
          <Star className={cn('h-4 w-4', fav && 'fill-amber-400 text-amber-500')} aria-hidden="true" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="max-h-[75vh] w-80 overflow-y-auto" data-testid="favorites-menu">
        {target && (
          <>
            <DropdownMenuItem disabled={full} onSelect={(e) => { e.preventDefault(); toggleFavorite(target.kind, target.ref); }} className="gap-2" data-testid="favorite-toggle">
              {fav ? <StarOff className="h-4 w-4" /> : <Star className="h-4 w-4" />}
              {fav ? 'Remove this page from favourites' : full ? `Favourites are full (${caps.favorites})` : 'Add this page to favourites'}
            </DropdownMenuItem>
            {favError && <p className="px-2 pb-1 text-xs text-destructive" role="alert">Could not change favourites.</p>}
            <DropdownMenuSeparator />
          </>
        )}
        <DropdownMenuLabel className="text-xs text-muted-foreground">Favourites</DropdownMenuLabel>
        {favorites.length ? favorites.map((i) => row(i, true)) : <p className="px-2 pb-2 text-xs text-muted-foreground">None yet. Open a device, customer, script or page and add it here.</p>}
        <DropdownMenuSeparator />
        <DropdownMenuLabel className="text-xs text-muted-foreground">Recent</DropdownMenuLabel>
        {recent.length ? recent.slice(0, 8).map((i) => row(i, false)) : <p className="px-2 pb-2 text-xs text-muted-foreground">Pages you open appear here.</p>}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

// ── Quick actions ────────────────────────────────────────────────────────────

const QUICK = ['/endpoints/enroll', '/quick-connect', '/automation/scripts', '/automation/software', '/patching', '/reports/patch-compliance'];
const QUICK_LABEL: Record<string, string> = {
  '/endpoints/enroll': 'Add a device', '/quick-connect': 'Start Quick Connect', '/automation/scripts': 'Run or write a script',
  '/automation/software': 'Install software', '/patching': 'Deploy updates', '/reports/patch-compliance': 'Open a report',
};

export function QuickActions() {
  const ctx = useNavCtx();
  const pages = allPages(ctx);
  const items = QUICK.map((h) => pages.find((p) => p.href === h)).filter((p): p is NonNullable<typeof p> => !!p);
  if (!items.length) return null;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button type="button" className={headerButton} aria-label="Quick actions" data-testid="quick-actions-trigger">
          <Plus className="h-4 w-4" aria-hidden="true" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-60">
        <DropdownMenuLabel className="text-xs text-muted-foreground">Quick actions</DropdownMenuLabel>
        {items.map((p) => {
          const I = p.icon;
          return <DropdownMenuItem key={p.href} asChild><Link href={p.href} className="gap-2"><I className="h-4 w-4" aria-hidden="true" />{QUICK_LABEL[p.href]}</Link></DropdownMenuItem>;
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

// ── Critical alerts ──────────────────────────────────────────────────────────

/** Open critical alerts this person may see (GET /monitoring/alerts, its own rule). Polled every minute, never in a hidden tab. */
export function AlertsBell() {
  const { user, can } = usePermissions();
  const enabled = !!user && can(CAP.ALERTS_VIEW);
  const { data } = useQuery({
    queryKey: ['alerts', 'header-critical'],
    queryFn: () => monitoringApi.alerts({ state: 'active', severity: 'critical', limit: 10 }).then((r) => ((r.data?.data?.alerts ?? []) as unknown[]).length),
    enabled, refetchInterval: 60_000, refetchIntervalInBackground: false, retry: false, staleTime: 30_000,
  });
  if (!enabled) return null;
  const n = data ?? 0;
  const label = n ? `${n >= 10 ? '10 or more' : n} open critical alert${n === 1 ? '' : 's'}` : 'Alerts: no open critical alerts';
  return (
    <Link href="/alerts" className={cn(headerButton, 'relative')} aria-label={label} title={label} data-testid="alerts-bell">
      <Bell className="h-4 w-4" aria-hidden="true" />
      {n > 0 && (
        <span className="absolute -right-0.5 -top-0.5 min-w-[1.1rem] rounded-full bg-destructive px-1 text-center text-xs font-semibold leading-[1.1rem] text-destructive-foreground" aria-hidden="true">
          {n >= 10 ? '9+' : n}
        </span>
      )}
    </Link>
  );
}

export function HelpLink() {
  return (
    <Link href="/help" className={headerButton} aria-label="Help and documentation" title="Help and documentation" data-testid="help-link">
      <CircleHelp className="h-4 w-4" aria-hidden="true" />
    </Link>
  );
}

// ── Profile ──────────────────────────────────────────────────────────────────

export function ProfileMenu() {
  const router = useRouter();
  const { user, isPlatformAdmin, canManageTechnicians, technician, accessLevel } = usePermissions();
  const { theme, setTheme } = useTheme();
  const { prefs, setPrefs } = useNavigation();
  if (!user) return null;
  // Owner decision 2: the project's own links are for the MSP's staff, never a customer's people.
  const staff = isPlatformAdmin || canManageTechnicians || !!technician;
  const name = user.email;
  const initials = (user.email.split('@')[0].match(/[A-Za-z0-9]/g) ?? ['?']).slice(0, 2).join('').toUpperCase();

  async function signOut() {
    // 0.59: a session that came from single sign-on is also ended at the provider.
    let redirectTo: string | null = null;
    try { redirectTo = (await authApi.logout()).data?.data?.redirectTo ?? null; } catch { /* signed out here or not, the login page is next */ }
    if (redirectTo && /^https?:\/\//.test(redirectTo)) window.location.assign(redirectTo);
    else router.push('/login');
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button type="button" className={cn(headerButton, 'px-1')} aria-label={`Account menu for ${name}`} data-testid="profile-menu-trigger">
          <span className="flex h-7 w-7 items-center justify-center rounded-full bg-primary text-xs font-semibold text-primary-foreground" aria-hidden="true">{initials}</span>
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="max-h-[85vh] w-64 overflow-y-auto" data-testid="profile-menu">
        <DropdownMenuLabel className="font-normal">
          <span className="block truncate text-sm font-semibold">{name}</span>
          {accessLevel && <span className="block truncate text-xs text-muted-foreground">{accessLevel}</span>}
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem asChild><Link href="/account" className="gap-2"><UserCircle className="h-4 w-4" />My account</Link></DropdownMenuItem>
        <DropdownMenuSeparator />
        {/* F-8: the toggle went light ↔ dark and could never get back to System. */}
        <DropdownMenuLabel className="text-xs text-muted-foreground">Theme</DropdownMenuLabel>
        <DropdownMenuRadioGroup value={theme} onValueChange={(v) => setTheme(v as 'light' | 'dark' | 'system')}>
          <DropdownMenuRadioItem value="light" data-testid="theme-light"><Sun className="mr-2 h-4 w-4" />Light</DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="dark" data-testid="theme-dark"><Moon className="mr-2 h-4 w-4" />Dark</DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="system" data-testid="theme-system"><Monitor className="mr-2 h-4 w-4" />Match system</DropdownMenuRadioItem>
        </DropdownMenuRadioGroup>
        <DropdownMenuSeparator />
        <DropdownMenuLabel className="text-xs text-muted-foreground">Density</DropdownMenuLabel>
        <DropdownMenuRadioGroup value={prefs.density} onValueChange={(v) => setPrefs({ density: v as 'comfortable' | 'compact' })}>
          <DropdownMenuRadioItem value="comfortable" data-testid="density-comfortable">Comfortable</DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="compact" data-testid="density-compact">Compact</DropdownMenuRadioItem>
        </DropdownMenuRadioGroup>
        <DropdownMenuSeparator />
        <DropdownMenuLabel className="text-xs text-muted-foreground">Menu</DropdownMenuLabel>
        <DropdownMenuRadioGroup value={prefs.mode} onValueChange={(v) => setPrefs({ mode: v as 'standard' | 'advanced' })}>
          <DropdownMenuRadioItem value="standard" data-testid="mode-standard" title="Everyday pages; the rest are tabs on them and in search">Standard</DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="advanced" data-testid="mode-advanced" title="Every page in the menu">Advanced</DropdownMenuRadioItem>
        </DropdownMenuRadioGroup>
        <DropdownMenuSeparator />
        {/* 0.90 (P1-4): which pages the menu puts in front. Presentation only: it grants and removes nothing. */}
        <DropdownMenuLabel className="text-xs text-muted-foreground">Workspace</DropdownMenuLabel>
        <DropdownMenuRadioGroup value={prefs.workspace} onValueChange={(v) => setPrefs({ workspace: v as WorkspaceId })}>
          {WORKSPACES.map((w) => (
            <DropdownMenuRadioItem key={w.id} value={w.id} data-testid={`workspace-${w.id}`} title={w.description}>
              <span className="min-w-0">
                <span className="block">{w.label}</span>
                <span className="block text-xs text-muted-foreground">{w.description}</span>
              </span>
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
        <p className="px-2 pb-1 text-xs text-muted-foreground" data-testid="workspace-note">
          A workspace changes the menu, not what you may do: every page is still in search.
        </p>
        <DropdownMenuSeparator />
        {!isPlatformAdmin && <DropdownMenuItem asChild><Link href="/about" className="gap-2"><Info className="h-4 w-4" />About</Link></DropdownMenuItem>}
        {staff && (
          <>
            <DropdownMenuLabel className="text-xs text-muted-foreground">Support Rem0te</DropdownMenuLabel>
            <DropdownMenuItem asChild><a href="https://github.com/agit8or1/rem0te" target="_blank" rel="noopener noreferrer" className="gap-2"><Star className="h-4 w-4 text-yellow-500" />Star on GitHub</a></DropdownMenuItem>
            <DropdownMenuItem asChild><a href="https://github.com/sponsors/agit8or1" target="_blank" rel="noopener noreferrer" className="gap-2"><Heart className="h-4 w-4 text-red-500" />Sponsors page</a></DropdownMenuItem>
            <DropdownMenuItem asChild><a href="https://mspreboot.com" target="_blank" rel="noopener noreferrer" className="gap-2"><Globe className="h-4 w-4" />mspreboot.com</a></DropdownMenuItem>
            <DropdownMenuSeparator />
          </>
        )}
        <DropdownMenuItem onClick={signOut} className="gap-2" data-testid="sign-out"><LogOut className="h-4 w-4" />Sign out</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** For tests and the docs: the header's pieces, in order. */
export const HEADER_ORDER = ['toggle', 'breadcrumbs', 'context', 'search', 'quick', 'favorites', 'alerts', 'chat', 'tasks', 'help', 'profile'] as const;
