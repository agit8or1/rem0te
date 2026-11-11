'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { usePermissions } from '@/lib/auth';
import { NAV, visibleItems } from '@/components/layout/nav-model';
import { PageHeader } from '@/components/common/page-header';

/** /reports opens the first report this person may see, the same one the menu opens. */
export default function ReportsIndex() {
  const router = useRouter();
  const { can, isPlatformAdmin, isBusinessOwner, technician, assignedBusinesses, canManageTechnicians, isLoading } = usePermissions();
  const section = NAV.find((s) => s.id === 'reports')!;
  const first = visibleItems(section, {
    can, isPlatformAdmin, isBusinessOwner, technician: !!technician, hasAssignments: assignedBusinesses.length > 0, canManageTechnicians,
  })[0];
  useEffect(() => { if (!isLoading && first) router.replace(first.href); }, [isLoading, first, router]);
  return (
    <div className="p-6">
      <PageHeader title="Reports" description={isLoading || first ? 'Opening…' : 'No report is available to you: reports need the View computers or monitoring:alerts permission.'} />
    </div>
  );
}
