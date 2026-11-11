'use client';

import { PageHeader } from '@/components/common/page-header';
import { AddDeviceFlow } from '@/components/endpoints/add-device/add-device-flow';

/**
 * Add device — the one way to enrol a computer (0.32). The Devices page's
 * "Add device" button, the Devices › Add device tab, Quick Start and a
 * computer's "make an enrollment link for this computer" all lead here.
 */
export default function AddDevicePage() {
  return (
    <div className="max-w-3xl space-y-6 p-6">
      <PageHeader
        title="Add device"
        description="Choose where the device belongs, get its install command, and watch it arrive."
      />
      <AddDeviceFlow />
    </div>
  );
}
