'use client';

import Link from 'next/link';
import { ArrowLeft } from 'lucide-react';
import { usePermissions } from '@/lib/auth';
import { PageHeader } from '@/components/common/page-header';
import { SecurityFeaturesTab } from '@/components/security-controls/security-features';

/**
 * Settings → Security → Security Features (v0.25). Read-only.
 *
 * The server decides what each caller may see (security-features.service.ts):
 * Platform Admins and technician managers, any scope; a Business Owner, their
 * own business; everyone else is refused. The check below only avoids a
 * request that would be refused — it is not the control.
 */
export default function SecurityFeaturesPage() {
  const { isPlatformAdmin, isBusinessOwner, canManageTechnicians, technician } = usePermissions();
  const allowed = !technician && (!!isPlatformAdmin || !!canManageTechnicians || !!isBusinessOwner);
  return (
    <div className="space-y-4 p-4 md:p-6">
      <Link href="/settings" className="inline-flex items-center text-sm text-muted-foreground hover:underline">
        <ArrowLeft className="mr-1 h-4 w-4" />Settings
      </Link>
      <PageHeader title="Security Features" description="Which technician can reach a customer's computer, and what evidence you will have afterwards." />
      {allowed
        ? <SecurityFeaturesTab />
        : <p className="text-sm text-muted-foreground">Security configuration is visible to Platform Admins, technician managers and Business Owners, from their own account.</p>}
    </div>
  );
}
