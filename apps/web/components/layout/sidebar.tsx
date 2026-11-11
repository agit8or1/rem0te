'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import {
  Settings, LogOut, Shield, Sun, Moon, BookOpen, Info, UserCircle, Heart, Star, Users, Globe,
  ChevronDown, ChevronRight, type LucideIcon,
} from 'lucide-react';
import { useEffect, useState } from 'react';
import { NAV, locate, under, visibleItems, type NavCtx, type NavSection } from './nav-model';
import { BusinessSwitcher } from './business-switcher';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  DropdownMenuSeparator,
} from '@/components/ui/dropdown-menu';
import { cn } from '@/lib/utils';
import { authApi, platformApi, updateApi } from '@/lib/api-client';
import { useQuery } from '@tanstack/react-query';
import { useTheme } from '@/lib/theme-provider';
import { usePermissions } from '@/lib/auth';

type NavItem = {
  href: string;
  label: string;
  icon: LucideIcon;
};

/** Whether the Settings group was left open, per browser. A convenience only. */
const SETTINGS_OPEN_KEY = 'nav.settingsOpen';

export function Sidebar() {
  const pathname = usePathname();
  const router = useRouter();
  const { resolvedTheme, setTheme } = useTheme();
  const {
    user, can, isPlatformAdmin, isBusinessOwner, accessLevel, technician, assignedBusinesses, canManageTechnicians,
  } = usePermissions();

  // Branding lives on the platform record and is readable only by the
  // operator; everyone else just gets the default mark.
  const { data: platform } = useQuery({
    queryKey: ['platform', user?.tenantId],
    queryFn: () => platformApi.get(user!.tenantId!).then((r) => r.data?.data),
    enabled: !!user?.tenantId && isPlatformAdmin,
  });

  const branding = (platform as Record<string, unknown> | undefined)?.branding as Record<string, unknown> | null | undefined;
  const portalTitle = (branding?.portalTitle as string | null) || 'Rem0te';
  const logoUrl = branding?.logoUrl as string | null | undefined;
  const accentColor = branding?.accentColor as string | null | undefined;

  async function handleLogout() {
    try {
      await authApi.logout();
    } finally {
      router.push('/login');
    }
  }

  // A toggle should toggle. This used to cycle light → dark → system, so getting
  // from light back to dark took two clicks and landed on "system" in between —
  // which looks like nothing happened whenever the OS preference matches.
  //
  // Flip against `resolvedTheme` (what is actually on screen) rather than the
  // stored preference, so one click always visibly changes something.
  function toggleTheme() {
    setTheme(resolvedTheme === 'dark' ? 'light' : 'dark');
  }

  const ThemeIcon = resolvedTheme === 'dark' ? Moon : Sun;
  const themeLabel = resolvedTheme === 'dark' ? 'Dark' : 'Light';

  const ctx: NavCtx = {
    can, isPlatformAdmin, isBusinessOwner, technician: !!technician,
    hasAssignments: assignedBusinesses.length > 0, canManageTechnicians,
  };
  const here = locate(pathname);

  // Settings opens by itself on a settings page; otherwise it stays as the
  // person left it.
  const [settingsOpen, setSettingsOpen] = useState(false);
  useEffect(() => {
    try { setSettingsOpen(window.localStorage.getItem(SETTINGS_OPEN_KEY) === '1'); } catch { /* storage unavailable */ }
  }, []);
  const inSettings = here?.section.id === 'settings';
  function toggleSettings() {
    const next = !settingsOpen;
    setSettingsOpen(next);
    try { window.localStorage.setItem(SETTINGS_OPEN_KEY, next ? '1' : '0'); } catch { /* storage unavailable */ }
  }

  const linkClass = (active: boolean) => cn(
    'flex items-center gap-3 rounded-md px-3 py-1.5 text-sm font-medium transition-colors',
    active ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-accent hover:text-accent-foreground',
  );

  /** One sidebar row for a section: link and hub open their first visible page. */
  function sectionLink(section: NavSection) {
    const items = visibleItems(section, ctx);
    if (!items.length) return null;
    const { icon: Icon } = section;
    // A Business User without the device list still has their own devices.
    const label = section.id === 'devices' && items[0].href === '/my-computers' ? 'My devices' : section.label;
    return (
      <Link key={section.id} href={items[0].href} className={linkClass(here?.section.id === section.id)}
        data-nav={section.id}>
        <Icon className="h-4 w-4" />
        {label}
      </Link>
    );
  }

  function settingsGroup(section: NavSection) {
    const items = visibleItems(section, ctx);
    if (!items.length) return null;
    const open = settingsOpen || inSettings;
    const Chevron = open ? ChevronDown : ChevronRight;
    return (
      <div key={section.id}>
        <button type="button" onClick={toggleSettings} aria-expanded={open} data-nav="settings"
          className={cn(linkClass(false), 'w-full', inSettings && 'text-foreground')}>
          <Settings className="h-4 w-4" />
          <span className="flex-1 text-left">Settings</span>
          <Chevron className="h-3.5 w-3.5" />
        </button>
        {open && (
          <div className="mt-0.5 space-y-0.5 pl-4">
            {items.map((i) => {
              const active = here?.leaf?.href === i.href;
              const { icon: Icon } = i;
              return (
                <Link key={i.href} href={i.href} className={cn(linkClass(active), 'py-1 text-[13px]')}>
                  <Icon className="h-3.5 w-3.5" />
                  {i.label}
                </Link>
              );
            })}
          </div>
        )}
      </div>
    );
  }

  function navLink(item: NavItem) {
    const { href, label, icon: Icon } = item;
    const active = under(pathname, href);
    return (
      <Link
        key={href}
        href={href}
        className={cn(
          'flex items-center gap-3 rounded-md px-3 py-1.5 text-sm font-medium transition-colors',
          active
            ? 'bg-primary text-primary-foreground'
            : 'text-muted-foreground hover:bg-accent hover:text-accent-foreground',
        )}
      >
        <Icon className="h-4 w-4" />
        {label}
      </Link>
    );
  }

  function supportMenu() {
    return (
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button className="flex w-full items-center gap-3 rounded-md px-3 py-1.5 text-sm font-medium text-muted-foreground hover:bg-accent hover:text-accent-foreground transition-colors">
            <Heart className="h-4 w-4 text-red-500 fill-red-500" />
            Support Rem0te
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent side="right" align="end" className="w-52">
          <DropdownMenuItem asChild>
            <a href="https://github.com/agit8or1/rem0te" target="_blank" rel="noopener noreferrer" className="flex items-center gap-2">
              <Star className="h-4 w-4 text-yellow-500" />
              Star on GitHub
            </a>
          </DropdownMenuItem>
          <DropdownMenuItem asChild>
            <a href="https://github.com/sponsors/agit8or1" target="_blank" rel="noopener noreferrer" className="flex items-center gap-2">
              <Users className="h-4 w-4 text-primary" />
              Sponsors Page
            </a>
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem asChild>
            <a href="https://mspreboot.com" target="_blank" rel="noopener noreferrer" className="flex items-center gap-2">
              <Globe className="h-4 w-4 text-muted-foreground" />
              mspreboot.com
            </a>
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    );
  }

  // The running version, shown at the bottom of the menu. Nobody reporting a
  // problem can be expected to find the About page first, and "which version
  // are you on?" is the first question asked every time.
  const { data: build } = useQuery({
    queryKey: ['app-version'],
    queryFn: () =>
      updateApi.appVersion().then(
        (r) => r.data?.data as { version: string; codename: string | null } | undefined,
      ),
    staleTime: 60 * 60 * 1000,
    retry: false,
  });


  return (
    <aside className="flex h-screen w-60 flex-col border-r bg-background">
      {/* Logo / branding */}
      <div
        className="flex h-14 items-center gap-2 border-b px-4"
        style={accentColor ? { backgroundColor: accentColor } : undefined}
      >
        {logoUrl ? (
          <img
            src={logoUrl}
            alt={portalTitle}
            className="h-7 w-auto max-w-[100px] object-contain"
            onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }}
          />
        ) : (
          <Shield className={`h-5 w-5 ${accentColor ? 'text-white' : 'text-primary'}`} />
        )}
        <div className="min-w-0 leading-tight">
          <div className={`font-semibold text-sm truncate ${accentColor ? 'text-white' : ''}`}>
            {portalTitle}
          </div>
          {accessLevel && (
            <div className={`text-[10px] uppercase tracking-wider truncate ${accentColor ? 'text-white/70' : 'text-muted-foreground/70'}`}>
              {accessLevel}
            </div>
          )}
        </div>
      </div>

      <BusinessSwitcher />

      <nav className="flex-1 overflow-y-auto py-3 px-2 space-y-0.5" aria-label="Main">
        {NAV.map((section) => (section.kind === 'group' ? settingsGroup(section) : sectionLink(section)))}
      </nav>

      <div className="border-t p-2 space-y-0.5">
        {navLink({ href: '/account', label: 'My Account', icon: UserCircle })}
        {/* Help and Documentation were two main-menu entries for one need. */}
        <Link href="/help" className={linkClass(under(pathname, '/help') || under(pathname, '/docs'))}>
          <BookOpen className="h-4 w-4" />
          Help &amp; docs
        </Link>
        {/* Platform Admins reach the same page as Settings → Updates. */}
        {!isPlatformAdmin && navLink({ href: '/about', label: 'About', icon: Info })}
        {supportMenu()}
        <button
          onClick={toggleTheme}
          className="flex w-full items-center gap-3 rounded-md px-3 py-1.5 text-sm font-medium text-muted-foreground hover:bg-accent hover:text-accent-foreground transition-colors"
          title={`${themeLabel} theme — click to switch to ${resolvedTheme === 'dark' ? 'light' : 'dark'}`}
        >
          <ThemeIcon className="h-4 w-4" />
          {themeLabel} theme
        </button>
        <button
          onClick={handleLogout}
          className="flex w-full items-center gap-3 rounded-md px-3 py-1.5 text-sm font-medium text-muted-foreground hover:bg-accent hover:text-accent-foreground transition-colors"
        >
          <LogOut className="h-4 w-4" />
          Sign out
        </button>
        {build?.version && (
          <Link
            href="/about"
            className="block px-3 pt-1.5 text-[10px] text-muted-foreground/60 hover:text-muted-foreground transition-colors truncate"
            title={build.codename ? `Rem0te v${build.version} — ${build.codename}` : `Rem0te v${build.version}`}
          >
            v{build.version}
            {build.codename && <span className="ml-1">· {build.codename}</span>}
          </Link>
        )}
      </div>
    </aside>
  );
}
