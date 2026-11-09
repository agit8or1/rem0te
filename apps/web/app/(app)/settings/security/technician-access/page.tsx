'use client';

import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { ArrowLeft } from 'lucide-react';
import { securityControlsApi } from '@/lib/api-client';
import { usePermissions } from '@/lib/auth';
import { PageHeader } from '@/components/common/page-header';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { PresetsPanel } from '@/components/security-controls/presets-panel';
import { PolicyPanel } from '@/components/security-controls/policy-panel';
import { InspectorPanel } from '@/components/security-controls/inspector-panel';
import { UpgradePanel } from '@/components/security-controls/upgrade-panel';
import { PausesAlertsPanel, ReviewsPanel } from '@/components/security-controls/review-panels';

/**
 * Settings → Security → Technician Access (v0.23).
 *
 * Presets, the platform access policy, the effective-access inspector, the
 * upgrade impact of presets on existing assignments, the independent-review
 * queue, and pauses/alerts. Every rule shown here is enforced server-side;
 * this page only renders and edits it.
 */
export default function TechnicianAccessPage() {
  const { isLoading, canManageTechnicians, technician, user } = usePermissions();
  const reviewer = !!user?.isPlatformAdmin || (user?.platformPermissions ?? []).includes('approvals:review');

  const { data: pendingTrust = [] } = useQuery<unknown[]>({
    queryKey: ['security-controls', 'trust-changes', 'PENDING'],
    queryFn: () => securityControlsApi.trustChanges('PENDING').then((r) => r.data?.data ?? []),
    enabled: canManageTechnicians,
    retry: false,
  });
  const { data: pendingTemp = [] } = useQuery<unknown[]>({
    queryKey: ['security-controls', 'temporary-access', 'PENDING'],
    queryFn: () => securityControlsApi.temporaryAccess({ status: 'PENDING' }).then((r) => r.data?.data ?? []),
    enabled: reviewer,
    retry: false,
  });
  const pendingCount = pendingTrust.length + (reviewer ? pendingTemp.length : 0);

  if (isLoading) return <div className="p-6 text-sm text-muted-foreground">Loading…</div>;

  return (
    <div className="p-6 space-y-6 max-w-5xl">
      <Link href="/settings" className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
        <ArrowLeft className="h-4 w-4" />Settings
      </Link>
      <PageHeader
        title="Technician Access"
        description="Presets for technician tiers, the platform access policy, and independent review of anything that widens trust."
      />

      {!canManageTechnicians ? (
        <Card><CardContent className="p-6 text-sm text-muted-foreground">
          Technician Access needs Platform Admin or the &ldquo;Manage technician access&rdquo; platform permission.
        </CardContent></Card>
      ) : (
        <>
          {technician && (
            <div className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-200">
              You are working in {technician.businessName} as a technician. Switch back to your own account to change technician
              access; the server refuses changes made from a technician context.
            </div>
          )}
          <Tabs defaultValue="presets">
            <TabsList className="flex-wrap h-auto">
              <TabsTrigger value="presets">Presets</TabsTrigger>
              <TabsTrigger value="policy">Platform policy</TabsTrigger>
              <TabsTrigger value="inspect">Effective access</TabsTrigger>
              <TabsTrigger value="upgrade">Upgrade impact</TabsTrigger>
              <TabsTrigger value="reviews">
                Reviews
                {pendingCount > 0 && <Badge className="ml-1.5 h-5 px-1.5">{pendingCount}</Badge>}
              </TabsTrigger>
              <TabsTrigger value="pauses">Pauses &amp; alerts</TabsTrigger>
            </TabsList>
            <TabsContent value="presets" className="mt-4"><PresetsPanel /></TabsContent>
            <TabsContent value="policy" className="mt-4"><PolicyPanel /></TabsContent>
            <TabsContent value="inspect" className="mt-4"><InspectorPanel /></TabsContent>
            <TabsContent value="upgrade" className="mt-4"><UpgradePanel /></TabsContent>
            <TabsContent value="reviews" className="mt-4"><ReviewsPanel /></TabsContent>
            <TabsContent value="pauses" className="mt-4"><PausesAlertsPanel /></TabsContent>
          </Tabs>
        </>
      )}
    </div>
  );
}
