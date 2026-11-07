'use client';

import { useRouter } from 'next/navigation';
import { useQueryClient } from '@tanstack/react-query';
import { Building2, ChevronsUpDown, Check, LayoutGrid } from 'lucide-react';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { setActiveBusiness } from '@/lib/api-client';
import { usePermissions } from '@/lib/auth';

/**
 * Which business an MSP technician is working in. Only shown to someone with
 * at least one live assignment. Switching sets a cookie the API reads on every
 * request — and honours only for the person's own business or a business they
 * are assigned to right now — then refetches everything, so no page keeps
 * showing the previous business's data.
 */
export function BusinessSwitcher() {
  const router = useRouter();
  const qc = useQueryClient();
  const { user, technician, assignedBusinesses, businessName } = usePermissions();
  if (!user || assignedBusinesses.length === 0) return null;

  const activeId = technician?.businessId ?? user.businessId ?? null;
  const label = technician?.businessName ?? businessName ?? 'My account';

  async function choose(id: string | null) {
    setActiveBusiness(id);
    await qc.invalidateQueries();
    router.refresh();
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          className="mx-2 mt-2 flex w-[calc(100%-1rem)] items-center gap-2 rounded-md border bg-card px-2.5 py-1.5 text-left text-sm hover:bg-accent"
          aria-label="Switch business"
        >
          <Building2 className="h-4 w-4 shrink-0 text-muted-foreground" />
          <span className="min-w-0 flex-1">
            <span className="block truncate font-medium">{label}</span>
            {technician && <span className="block text-[10px] uppercase tracking-wider text-amber-600 dark:text-amber-400">Technician access</span>}
          </span>
          <ChevronsUpDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-56">
        <DropdownMenuItem onClick={() => choose(user.ownBusinessId ?? null)} className="flex items-center gap-2">
          {!technician ? <Check className="h-4 w-4" /> : <span className="w-4" />}
          {user.ownBusinessId ? (user.business?.name && !technician ? user.business.name : 'My own business') : 'My account'}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        {assignedBusinesses.map((b) => (
          <DropdownMenuItem key={b.id} onClick={() => choose(b.id)} className="flex items-center gap-2">
            {activeId === b.id && technician ? <Check className="h-4 w-4" /> : <span className="w-4" />}
            <span className="truncate">{b.name}</span>
          </DropdownMenuItem>
        ))}
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={() => router.push('/technician')} className="flex items-center gap-2">
          <LayoutGrid className="h-4 w-4" />All assigned businesses
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
