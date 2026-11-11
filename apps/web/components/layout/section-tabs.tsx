'use client';

/**
 * The tabs of a hub section (Devices, Remote Support), drawn above the page
 * from the same model as the sidebar. Only on a hub's own pages: a device's
 * workspace (/endpoints/abc) has its own header and tabs.
 */
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { usePermissions } from '@/lib/auth';
import { cn } from '@/lib/utils';
import { locate, visibleItems, type NavCtx } from './nav-model';

export function SectionTabs() {
  const pathname = usePathname();
  const { can, isPlatformAdmin, isBusinessOwner, technician, assignedBusinesses, canManageTechnicians, isIndependentReviewer } = usePermissions();
  const here = locate(pathname);
  if (!here || here.section.kind !== 'hub' || !here.leaf || here.leaf.href !== pathname) return null;
  const ctx: NavCtx = {
    can, isPlatformAdmin, isBusinessOwner, technician: !!technician,
    hasAssignments: assignedBusinesses.length > 0, canManageTechnicians, isIndependentReviewer,
  };
  const items = visibleItems(here.section, ctx);
  if (items.length < 2) return null;
  return (
    <nav aria-label={here.section.label} className="border-b bg-background px-6" data-section-tabs={here.section.id}>
      <div className="flex gap-1 overflow-x-auto">
        {items.map(({ href, label, icon: Icon }) => {
          const active = href === here.leaf?.href;
          return (
            <Link key={href} href={href} aria-current={active ? 'page' : undefined}
              className={cn(
                'flex items-center gap-2 whitespace-nowrap border-b-2 px-3 py-2.5 text-sm font-medium transition-colors',
                active ? 'border-primary text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground',
              )}>
              <Icon className="h-4 w-4" />
              {label}
            </Link>
          );
        })}
      </div>
    </nav>
  );
}
