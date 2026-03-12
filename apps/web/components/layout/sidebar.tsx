'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import {
  LayoutDashboard,
  Monitor,
  PlayCircle,
  FileText,
  Settings,
  LogOut,
  Shield,
  Link2,
  Sun,
  Moon,
  Download,
  Sparkles,
  HelpCircle,
  ShieldCheck,
  Info,
  UserCircle,
  Heart,
  Star,
  Users,
  Globe,
  MonitorCheck,
} from 'lucide-react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  DropdownMenuSeparator,
} from '@/components/ui/dropdown-menu';
import { cn } from '@/lib/utils';
import { authApi, tenantsApi } from '@/lib/api-client';
import { useRouter } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { useTheme } from '@/lib/theme-provider';

const NAV_ITEMS = [
  { href: '/dashboard', label: 'Dashboard', icon: LayoutDashboard },
  { href: '/endpoints', label: 'Enrolled Clients', icon: MonitorCheck },
  { href: '/sessions', label: 'Sessions', icon: PlayCircle },
  { href: '/connect', label: 'Connect', icon: Link2 },
  { href: '/audit', label: 'Audit Log', icon: FileText },
  { href: '/quickstart', label: 'Quick Start', icon: Sparkles },
  { href: '/help', label: 'Help & Docs', icon: HelpCircle },
  { href: '/settings', label: 'Settings', icon: Settings },
  // Downloads conditionally rendered at bottom of this list
];

export function Sidebar() {
  const pathname = usePathname();
  const router = useRouter();
  const { theme, setTheme } = useTheme();

  const { data: me } = useQuery({
    queryKey: ['me'],
    queryFn: () => authApi.me().then((r) => r.data?.data),
  });

  const tenantId: string = me?.tenantId ?? '';

  const { data: tenantData } = useQuery({
    queryKey: ['tenant', tenantId],
    queryFn: () => tenantsApi.get(tenantId).then((r) => r.data?.data),
    enabled: !!tenantId,
  });

  const tenant = tenantData as Record<string, unknown> | undefined;
  const settings = tenant?.settings as Record<string, unknown> | undefined;
  const branding = tenant?.branding as Record<string, unknown> | null | undefined;
  const showDownloadPage = settings?.showDownloadPage !== false; // default true
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

  function cycleTheme() {
    if (theme === 'light') setTheme('dark');
    else if (theme === 'dark') setTheme('system');
    else setTheme('light');
  }

  const ThemeIcon = theme === 'light' ? Sun : theme === 'dark' ? Moon : Monitor;
  const themeLabel = theme === 'light' ? 'Light' : theme === 'dark' ? 'Dark' : 'System';

  function supportMenu() {
    return (
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button className="flex w-full items-center gap-3 rounded-md px-3 py-2 text-sm font-medium text-muted-foreground hover:bg-accent hover:text-accent-foreground transition-colors">
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

  function navLink(href: string, label: string, Icon: React.ComponentType<{ className?: string }>, external = false) {
    const active = !external && (pathname === href || (href !== '/settings' && pathname.startsWith(`${href}/`)));
    const linkProps = external ? { target: '_blank', rel: 'noopener noreferrer' } : {};
    return (
      <Link
        key={href}
        href={href}
        {...linkProps}
        className={cn(
          'flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors',
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
        <span className={`font-semibold text-sm truncate ${accentColor ? 'text-white' : ''}`}>
          {portalTitle}
        </span>
      </div>

      {/* Nav */}
      <nav className="flex-1 overflow-y-auto py-4 px-2 space-y-1">
        {NAV_ITEMS.map(({ href, label, icon: Icon }) => navLink(href, label, Icon))}
        {me?.isPlatformAdmin && navLink('/admin/security', 'Security', ShieldCheck)}
        {showDownloadPage && navLink('/download', 'Downloads', Download)}
      </nav>

      {/* Footer */}
      <div className="border-t p-2 space-y-1">
        {navLink('/account', 'My Account', UserCircle)}
        {navLink('/about', 'About', Info)}
        {supportMenu()}
        <button
          onClick={cycleTheme}
          className="flex w-full items-center gap-3 rounded-md px-3 py-2 text-sm font-medium text-muted-foreground hover:bg-accent hover:text-accent-foreground transition-colors"
          title={`Theme: ${themeLabel} (click to cycle)`}
        >
          <ThemeIcon className="h-4 w-4" />
          {themeLabel} theme
        </button>
        <button
          onClick={handleLogout}
          className="flex w-full items-center gap-3 rounded-md px-3 py-2 text-sm font-medium text-muted-foreground hover:bg-accent hover:text-accent-foreground transition-colors"
        >
          <LogOut className="h-4 w-4" />
          Sign out
        </button>
      </div>
    </aside>
  );
}
