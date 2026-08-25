'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import {
  LayoutDashboard,
  Monitor,
  PlayCircle,
  FileText,
  Settings,
  LogOut,
  Shield,
  Zap,
  Sun,
  Moon,
  Download,
  ShieldCheck,
  Info,
  UserCircle,
  Heart,
  Star,
  Users,
  Globe,
  Building2,
  MonitorCheck,
  MonitorX,
  RefreshCw,
  Activity,
} from 'lucide-react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  DropdownMenuSeparator,
} from '@/components/ui/dropdown-menu';
import { cn } from '@/lib/utils';
import { authApi, platformApi } from '@/lib/api-client';
import { useQuery } from '@tanstack/react-query';
import { useTheme } from '@/lib/theme-provider';
import { usePermissions, CAP, type Capability } from '@/lib/auth';

type NavItem = {
  href: string;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  /** Omit to always show; otherwise the user must hold this capability. */
  cap?: Capability;
  /** Platform Admin only. */
  platformOnly?: boolean;
};

/** Always visible — every signed-in person has some computers of their own. */
const MY_NAV: NavItem[] = [
  { href: '/my-computers', label: 'My Computers', icon: Monitor },
];

/**
 * The working section. Each entry declares the capability it needs, so a
 * Business User only ever sees the parts they can actually use — no
 * hand-maintained per-role menus.
 */
const MAIN_NAV: NavItem[] = [
  { href: '/dashboard', label: 'Dashboard', icon: LayoutDashboard },
  { href: '/businesses', label: 'Businesses', icon: Building2, platformOnly: true },
  { href: '/endpoints', label: 'Computers', icon: MonitorCheck, cap: CAP.COMPUTERS_VIEW },
  { href: '/users', label: 'Users', icon: Users, cap: CAP.USERS_VIEW },
  { href: '/sessions', label: 'Sessions', icon: PlayCircle, cap: CAP.SESSIONS_VIEW },
  { href: '/quick-connect', label: 'Quick Connect', icon: Zap, cap: CAP.QUICK_CONNECT },
  { href: '/endpoints/enroll', label: 'Downloads', icon: Download, cap: CAP.COMPUTERS_ADD },
  { href: '/audit', label: 'Audit Log', icon: FileText, cap: CAP.AUDIT_VIEW },
];

/**
 * Operator-only infrastructure.
 *
 * "Updates" points at /about because that is where the version check, update
 * runner and changelog actually live; /admin/status is host health (CPU,
 * memory, systemd units), which is a different question.
 */
const PLATFORM_NAV: NavItem[] = [
  { href: '/admin/access', label: 'Access Control', icon: ShieldCheck },
  { href: '/admin/security', label: 'Security', icon: Shield },
  { href: '/admin/unassigned', label: 'Unassigned Computers', icon: MonitorX },
  { href: '/admin/status', label: 'System Status', icon: Activity },
  { href: '/about', label: 'Updates', icon: RefreshCw },
];

export function Sidebar() {
  const pathname = usePathname();
  const router = useRouter();
  const { resolvedTheme, setTheme } = useTheme();
  const { user, can, isPlatformAdmin, isBusinessOwner, accessLevel, businessName } = usePermissions();

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

  function visible(item: NavItem) {
    if (item.platformOnly) return isPlatformAdmin;
    if (!item.cap) return true;
    return can(item.cap);
  }

  function navLink(item: NavItem) {
    const { href, label, icon: Icon } = item;
    const active = pathname === href
      || (href !== '/settings' && href !== '/endpoints' && pathname.startsWith(`${href}/`));
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

  const mainItems = MAIN_NAV.filter(visible);
  const sectionLabel = isPlatformAdmin ? 'Administration' : businessName ?? 'My Business';

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

      <nav className="flex-1 overflow-y-auto py-3 px-2 space-y-0.5">
        {MY_NAV.map(navLink)}

        {mainItems.length > 0 && (
          <>
            <div className="pt-3 pb-0.5 px-3 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/70 truncate">
              {sectionLabel}
            </div>
            {mainItems.map(navLink)}
            {/* A Business Owner configures their own business; the platform
                operator configures the platform. Same slot, different scope. */}
            {isBusinessOwner && navLink({
              href: '/settings',
              label: isPlatformAdmin ? 'Settings' : 'Business Settings',
              icon: Settings,
            })}
          </>
        )}

        {isPlatformAdmin && (
          <>
            <div className="pt-3 pb-0.5 px-3 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/70">
              Platform
            </div>
            {PLATFORM_NAV.map(navLink)}
          </>
        )}
      </nav>

      <div className="border-t p-2 space-y-0.5">
        {navLink({ href: '/account', label: 'My Account', icon: UserCircle })}
        {/* Platform Admins reach the same page as "Updates" above. */}
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
      </div>
    </aside>
  );
}
