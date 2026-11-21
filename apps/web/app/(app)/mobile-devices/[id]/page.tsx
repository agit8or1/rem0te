'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { ArrowLeft } from 'lucide-react';
import { PageHeader } from '@/components/common/page-header';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { mobileApi } from '@/lib/api-client';
import { usePermissions, CAP } from '@/lib/auth';
import { formatDate } from '@/lib/utils';
import {
  CommandStateBadge, ComplianceBadge, READ_ONLY_NOTE, formatBytes,
  type MobileCommand, type MobileDevice,
} from '@/components/mobile/mobile-ui';

/**
 * One mobile device (0.80 Tablet): what it is, who owns it, whether the
 * provider finds it compliant, and its command history. Read-only.
 *
 * The command history keeps "accepted by the provider" and "completed on the
 * device" apart. A provider accepting a lock means it queued it for the
 * device; the device has done it only when it reports so, which may be much
 * later or never.
 */

const SCOPE_EXPLAIN: Record<MobileDevice['managementScope'], string> = {
  device: 'The provider manages the whole device.',
  work_profile: 'Only the Android work profile is managed. The rest of the phone is the owner\'s, and removing management removes only the profile.',
  user_enrollment: 'Only managed apps and their data are managed (Apple User Enrollment). The rest of the device is the owner\'s.',
};

function Fact({ label, children, testId }: { label: string; children: React.ReactNode; testId?: string }) {
  return (
    <div className="min-w-0" data-testid={testId}>
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="text-sm break-words">{children}</dd>
    </div>
  );
}

export default function MobileDevicePage() {
  const { id } = useParams<{ id: string }>();
  const { can } = usePermissions();
  const allowed = can(CAP.MOBILE_VIEW);
  const dev = useQuery<{ device: MobileDevice }>({
    queryKey: ['mobile-device', id],
    queryFn: () => mobileApi.get(id).then((r) => r.data?.data),
    enabled: allowed && !!id,
    retry: false,
  });
  const cmds = useQuery<{ commands: MobileCommand[]; max: number }>({
    queryKey: ['mobile-device-commands', id],
    queryFn: () => mobileApi.commands(id).then((r) => r.data?.data),
    enabled: allowed && !!id && !!dev.data,
    refetchInterval: 60_000,
  });
  const d = dev.data?.device;

  return (
    <div className="p-4 sm:p-6 space-y-5">
      <Link href="/mobile-devices" className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
        <ArrowLeft className="h-4 w-4" aria-hidden /> Mobile devices
      </Link>
      <PageHeader title={d?.name ?? d?.providerDeviceId ?? 'Mobile device'} description={d ? [d.business?.name, d.providerLabel].filter(Boolean).join(' · ') : undefined} />
      {!allowed ? <p className="text-sm text-muted-foreground">This page needs the View mobile devices permission.</p> : (
        <>
          {dev.isLoading && <p className="text-sm text-muted-foreground">Loading…</p>}
          {dev.isError && <p className="text-sm text-destructive" data-testid="mdm-not-found">This mobile device was not found, or you cannot see it.</p>}
          {d && (
            <>
              <p className="text-xs text-muted-foreground">{READ_ONLY_NOTE}</p>
              <div className="grid gap-4 lg:grid-cols-3">
                <Card data-testid="mdm-device-card">
                  <CardHeader className="pb-2"><CardTitle className="text-base">Device</CardTitle></CardHeader>
                  <CardContent>
                    <dl className="grid grid-cols-2 gap-3">
                      <Fact label="Platform">{d.platformLabel}{d.osVersion ? ` ${d.osVersion}` : ''}</Fact>
                      <Fact label="Model">{[d.manufacturer, d.model].filter(Boolean).join(' ') || '—'}</Fact>
                      <Fact label="Enrollment">{d.enrollmentLabel}{d.enrolledAt ? `, ${formatDate(d.enrolledAt)}` : ''}</Fact>
                      <Fact label="Last check-in">{d.lastCheckInAt ? formatDate(d.lastCheckInAt) : 'Unknown'}</Fact>
                      <Fact label="Storage">{d.storage ? `${formatBytes(d.storage.freeBytes)} free of ${formatBytes(d.storage.totalBytes)}` : '—'}</Fact>
                      <Fact label="Serial number" testId="mdm-serial">{d.serialNumber ?? (d.ownership === 'byod' ? 'Not kept for a personal device' : '—')}</Fact>
                    </dl>
                  </CardContent>
                </Card>
                <Card data-testid="mdm-ownership-card">
                  <CardHeader className="pb-2"><CardTitle className="text-base">Ownership</CardTitle></CardHeader>
                  <CardContent className="space-y-2 text-sm">
                    <p className="font-medium" data-ownership={d.ownership}>{d.ownershipLabel}</p>
                    <p><span className="text-muted-foreground">Managed:</span> {d.managementScopeLabel}</p>
                    <p className="text-xs text-muted-foreground">{SCOPE_EXPLAIN[d.managementScope]}</p>
                  </CardContent>
                </Card>
                <Card data-testid="mdm-compliance-card">
                  <CardHeader className="pb-2"><CardTitle className="text-base">Compliance</CardTitle></CardHeader>
                  <CardContent className="space-y-2 text-sm">
                    <ComplianceBadge state={d.complianceState} label={d.complianceLabel} />
                    {d.complianceReason && <p className="break-words">{d.complianceReason}</p>}
                    <p className="text-xs text-muted-foreground">Evaluated by the provider, read {formatDate(d.lastSyncedAt)}.</p>
                  </CardContent>
                </Card>
              </div>

              <Card>
                <CardHeader className="pb-2"><CardTitle className="text-base">Command history</CardTitle></CardHeader>
                <CardContent className="space-y-3">
                  <p className="text-xs text-muted-foreground">
                    <strong className="text-foreground">Accepted by the provider</strong> and <strong className="text-foreground">completed on the device</strong> are
                    separate. A provider accepting a command only means it queued it; the device has done it when the device reports so.
                    Commands come from the provider&apos;s own console; none can be sent from Rem0te yet.
                  </p>
                  {cmds.isError && <p className="text-sm text-destructive">Command history could not be loaded.</p>}
                  {cmds.data && cmds.data.commands.length === 0 && <p className="text-sm text-muted-foreground" data-testid="mdm-no-commands">No commands reported for this device.</p>}
                  {cmds.data && cmds.data.commands.length > 0 && (
                    <ul className="divide-y rounded-md border" data-testid="mdm-commands">
                      {cmds.data.commands.map((c) => (
                        <li key={c.id} className="space-y-1.5 p-3 text-xs" data-state={c.state} data-kind={c.kind}>
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="text-sm font-medium">{c.kindLabel}</span>
                            {c.destructive && <span className="rounded-full border border-destructive/50 px-2 py-0.5 text-[11px] text-destructive">Destructive</span>}
                            <CommandStateBadge state={c.state} label={c.stateLabel} />
                            <span className="text-muted-foreground">Requested {formatDate(c.requestedAt)}{c.origin === 'provider' ? ' in the provider' : ''}</span>
                          </div>
                          <dl className="grid gap-2 sm:grid-cols-2">
                            <div data-testid="mdm-cmd-accepted" data-done={c.providerAccepted.done ? 'yes' : 'no'}>
                              <dt className="text-muted-foreground">Accepted by the provider</dt>
                              <dd>{c.providerAccepted.at ? formatDate(c.providerAccepted.at) : 'Not yet'}</dd>
                            </div>
                            <div data-testid="mdm-cmd-completed" data-done={c.deviceCompleted.done ? 'yes' : 'no'}>
                              <dt className="text-muted-foreground">Completed on the device</dt>
                              <dd>{c.deviceCompleted.at ? formatDate(c.deviceCompleted.at) : c.state === 'acknowledged' ? 'Not yet: waiting for the device' : 'No'}</dd>
                            </div>
                          </dl>
                          {c.failureCode && <p className="text-destructive break-all">Failed: {c.failureCode}</p>}
                          {c.expiredAt && <p className="text-muted-foreground">Expired {formatDate(c.expiredAt)} without finishing.</p>}
                        </li>
                      ))}
                    </ul>
                  )}
                </CardContent>
              </Card>
            </>
          )}
        </>
      )}
    </div>
  );
}
