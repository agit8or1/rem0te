'use client';

import Link from 'next/link';
import { Plus } from 'lucide-react';
import { PageHeader } from '@/components/common/page-header';
import { Button } from '@/components/ui/button';
import { DeviceList } from '@/components/endpoints/list/device-list';
import { CAP, usePermissions } from '@/lib/auth';

export default function EndpointsPage() {
  const { can } = usePermissions();
  return (
    <div className="p-6 space-y-4">
      <PageHeader title="Devices" description="Every enrolled device in the businesses you can see.">
        {/* One way in (0.32): the guided flow. It replaced "Enroll Client"
            and the "Generate Enrollment Link" modal, which minted a token with
            no business, site or OS and could not tell you when it was used. */}
        {can(CAP.COMPUTERS_ADD) && (
          <Button size="sm" asChild>
            <Link href="/endpoints/enroll" data-testid="add-device">
              <Plus className="h-4 w-4 mr-2" />
              Add device
            </Link>
          </Button>
        )}
      </PageHeader>

      <DeviceList />
    </div>
  );
}
