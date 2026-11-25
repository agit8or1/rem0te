'use client';

/**
 * The tabs of a hub (0.31; 0.87), drawn above the page from the same model as
 * the sidebar: every visible entry sharing the page's hub, advanced entries
 * included, so Standard mode never makes a page unreachable. Only on a hub
 * entry's own page: a device's workspace (/endpoints/abc) has its own tabs.
 */
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { cn } from '@/lib/utils';
import { useNavCtx, useNavigation } from '@/lib/navigation';
import { hubTabs } from './nav-model';

export function SectionTabs() {
  const pathname = usePathname() ?? '/';
  const ctx = useNavCtx();
  const { prefs } = useNavigation();
  const tabs = hubTabs(pathname, ctx);
  if (!tabs) return null;
  return (
    <nav aria-label={`${tabs.label} pages`} className="border-b bg-background px-4 md:px-6" data-section-tabs={tabs.hub}>
      <div className="-mb-px flex gap-0.5 overflow-x-auto">
        {tabs.items.map(({ href, label, icon: Icon, tier }) => {
          const active = href === tabs.current.href;
          return (
            <Link key={href} href={href} aria-current={active ? 'page' : undefined} data-tier={tier}
              className={cn(
                'flex items-center gap-1.5 whitespace-nowrap rounded-t border-b-2 px-3 py-2 text-sm font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring',
                active ? 'border-primary text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground',
                // In Standard, the pages the menu leaves out are still here; quieter, never hidden.
                prefs.mode === 'standard' && tier === 'advanced' && !active && 'font-normal',
              )}>
              <Icon className="h-4 w-4" aria-hidden="true" />
              {label}
            </Link>
          );
        })}
      </div>
    </nav>
  );
}
