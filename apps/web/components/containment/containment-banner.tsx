'use client';

import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { OctagonPause } from 'lucide-react';
import { containmentApi } from '@/lib/api-client';
import { useCurrentUser } from '@/lib/auth';

type BannerPause = { id: string; scope: 'global' | 'business'; businessName: string | null; kinds: string[]; reason: string; setBy: 'msp' | 'customer'; createdAt: string };

const KIND: Record<string, string> = { actions: 'approved actions', remote: 'remote connections and chat', updates: 'agent updates', integration: 'ClientSt0r jobs' };

/**
 * A strip across the top of every page while something that applies to the
 * current business is paused (0.28). It says what is stopped and why, so a
 * refused click is never a mystery.
 */
export function ContainmentBanner() {
  const { data: user } = useCurrentUser();
  const { data } = useQuery<BannerPause[]>({
    queryKey: ['containment-banner', user?.businessId ?? null],
    queryFn: () => containmentApi.banner().then((r) => r.data.data ?? []),
    enabled: !!user,
    refetchInterval: 60_000,
    retry: false,
  });
  if (!data?.length) return null;
  return (
    <div role="status" className="border-b border-red-300 bg-red-50 px-4 py-2 text-sm text-red-900 dark:border-red-900 dark:bg-red-950 dark:text-red-100">
      {data.map((p) => (
        <div key={p.id} className="flex flex-wrap items-center gap-x-2">
          <OctagonPause className="h-4 w-4 shrink-0" />
          <strong>{p.scope === 'global' ? 'Write pause (all businesses)' : `${p.businessName ?? 'This business'} is suspended`}:</strong>
          <span>{p.kinds.map((k) => KIND[k] ?? k).join(', ')} stopped</span>
          <span className="text-red-800/80 dark:text-red-200/80">— {p.reason}</span>
          <Link href="/settings/security/containment" className="ml-auto underline">Containment</Link>
        </div>
      ))}
    </div>
  );
}
