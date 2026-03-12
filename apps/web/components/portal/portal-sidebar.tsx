'use client';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { Monitor, PlayCircle, LayoutDashboard, LogOut, Shield } from 'lucide-react';
import { cn } from '@/lib/utils';
import { authApi } from '@/lib/api-client';

const NAV = [
  { href: '/portal', label: 'Dashboard', icon: LayoutDashboard, exact: true },
  { href: '/portal/endpoints', label: 'My Devices', icon: Monitor },
  { href: '/portal/sessions', label: 'Support Sessions', icon: PlayCircle },
];

export function PortalSidebar() {
  const pathname = usePathname();
  const router = useRouter();

  async function logout() {
    await authApi.logout().catch(() => null);
    router.push('/login');
  }

  return (
    <aside className="flex h-screen w-56 flex-col border-r bg-background">
      <div className="flex h-14 items-center gap-2 border-b px-4">
        <Shield className="h-5 w-5 text-primary" />
        <span className="font-semibold text-sm">Support Portal</span>
      </div>
      <nav className="flex-1 py-4 px-2 space-y-1">
        {NAV.map(({ href, label, icon: Icon, exact }) => {
          const active = exact ? pathname === href : pathname.startsWith(href);
          return (
            <Link key={href} href={href} className={cn(
              'flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors',
              active ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-accent hover:text-accent-foreground',
            )}>
              <Icon className="h-4 w-4" />
              {label}
            </Link>
          );
        })}
      </nav>
      <div className="border-t p-2">
        <button onClick={logout} className="flex w-full items-center gap-3 rounded-md px-3 py-2 text-sm font-medium text-muted-foreground hover:bg-accent hover:text-accent-foreground transition-colors">
          <LogOut className="h-4 w-4" />
          Sign out
        </button>
      </div>
    </aside>
  );
}
