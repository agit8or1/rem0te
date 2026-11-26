'use client';

/**
 * A record page's own shortcuts (0.87): add it to favourites, and on a
 * customer, keep it in view in the header and open its devices. Links and
 * preferences only; the pages they open check access themselves.
 */
import Link from 'next/link';
import { Building2, MonitorCheck, Star } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { CAP, usePermissions } from '@/lib/auth';
import { useNavigation } from '@/lib/navigation';
import type { NavItemKind } from '@/lib/api-client';
import { cn } from '@/lib/utils';

export function FavoriteButton({ kind, refId, label, compact = false }: { kind: NavItemKind; refId: string; label: string; compact?: boolean }) {
  const { favoriteOf, toggleFavorite, favPending, ready } = useNavigation();
  const on = !!favoriteOf(kind, refId);
  const title = on ? `Remove ${label} from favourites` : `Add ${label} to favourites`;
  return (
    <Button size="sm" variant={compact ? 'ghost' : 'outline'} className={compact ? 'h-8 w-8 p-0' : undefined} disabled={!ready || favPending}
      onClick={() => toggleFavorite(kind, refId)} aria-pressed={on} data-testid="record-favorite" title={title} aria-label={compact ? title : undefined}>
      {/* 0.87 review: on a phone the label took a row of its own; the star alone says it there.
          0.88: `compact` (the device header) is the star alone at every width; the name says the rest. */}
      <Star className={cn('h-4 w-4', !compact && 'sm:mr-1.5', on && 'fill-amber-400 text-amber-500')} aria-hidden="true" />
      {!compact && <span className="sr-only sm:not-sr-only">{on ? 'Favourite' : 'Add to favourites'}</span>}
    </Button>
  );
}

export function CustomerBar({ id, name }: { id: string; name: string }) {
  const { isPlatformAdmin, can } = usePermissions();
  const { prefs, setPrefs } = useNavigation();
  const inView = prefs.contextBusiness?.id === id;
  return (
    <div className="flex flex-wrap items-center gap-2" data-testid="customer-bar">
      {can(CAP.COMPUTERS_VIEW) && (
        <Button size="sm" variant="outline" asChild>
          <Link href={`/endpoints?businessId=${encodeURIComponent(id)}`} data-testid="customer-devices-link"><MonitorCheck className="mr-1.5 h-4 w-4" aria-hidden="true" />Devices</Link>
        </Button>
      )}
      <FavoriteButton kind="business" refId={id} label={name} />
      {isPlatformAdmin && (
        <Button size="sm" variant="outline" aria-pressed={inView} onClick={() => setPrefs({ contextBusinessId: inView ? null : id })} data-testid="customer-keep-in-view">
          <Building2 className="mr-1.5 h-4 w-4" aria-hidden="true" />{inView ? 'In view in the header' : 'Keep in view'}
        </Button>
      )}
    </div>
  );
}
