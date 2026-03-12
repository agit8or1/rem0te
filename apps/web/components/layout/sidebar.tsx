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
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { authApi, tenantsApi } from '@/lib/api-client';
import { useRouter } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { useTheme } from '@/lib/theme-provider';

const NAV_ITEMS = [
  { href: '/dashboard', label: 'Dashboard', icon: LayoutDashboard },
  { href: '/audit', label: 'Audit Log', icon: FileText },
  { href: '/connect', label: 'Connect', icon: Link2 },
  { href: '/help', label: 'Help & Docs', icon: HelpCircle },
  { href: '/quickstart', label: 'Quick Start', icon: Sparkles },
  { href: '/sessions', label: 'Sessions', icon: PlayCircle },
  { href: '/settings', label: 'Settings', icon: Settings },
  // Downloads rendered separately at bottom
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
  const showDownloadPage = settings?.showDownloadPage !== false; // default true

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

  function navLink(href: string, label: string, Icon: React.ComponentType<{ className?: string }>) {
    const active = pathname === href || (href !== '/settings' && pathname.startsWith(`${href}/`));
    return (
      <Link
        key={href}
        href={href}
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
      {/* Logo */}
      <div className="flex h-14 items-center gap-2 border-b px-4">
        <Shield className="h-5 w-5 text-primary" />
        <span className="font-semibold text-sm">Reboot Remote</span>
      </div>

      {/* Nav */}
      <nav className="flex-1 overflow-y-auto py-4 px-2 space-y-1">
        {NAV_ITEMS.map(({ href, label, icon: Icon }) => navLink(href, label, Icon))}
        {me?.isPlatformAdmin && navLink('/admin/security', 'Security', ShieldCheck)}
      </nav>

      {/* Footer */}
      <div className="border-t p-2 space-y-1">
        {navLink('/account', 'My Account', UserCircle)}
        {showDownloadPage && navLink('/download', 'Downloads Page', Download)}
        {navLink('/about', 'About', Info)}
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
