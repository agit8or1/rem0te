'use client';

import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import {
  businessesApi, endpointsApi, sitesApi, enrollmentApi,
} from '@/lib/api-client';
import { PageHeader } from '@/components/common/page-header';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { StatusIndicator } from '@/components/common/status-indicator';
import { formatDate } from '@/lib/utils';
import { useToast } from '@/hooks/use-toast';
import { usePermissions, CAP } from '@/lib/auth';
import { Download, Plus, X, Zap } from 'lucide-react';

export default function BusinessDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { toast } = useToast();
  const qc = useQueryClient();
  const { isPlatformAdmin, can } = usePermissions();

  const { data: business, isLoading } = useQuery({
    queryKey: ['business', id],
    queryFn: () => businessesApi.get(id).then((r) => r.data?.data),
  });

  const { data: sites } = useQuery({
    queryKey: ['sites', id],
    queryFn: () => sitesApi.list(id).then((r) => r.data?.data ?? []),
  });

  const { data: endpointsData } = useQuery({
    queryKey: ['endpoints', 'business', id],
    queryFn: () => endpointsApi.list({ businessId: id }).then((r) => r.data?.data),
  });

  // Unassigned computers are a platform-level view — a business never owns one.
  const { data: unassignedData } = useQuery({
    queryKey: ['endpoints', 'unassigned'],
    queryFn: () => endpointsApi.list({ businessId: 'null' }).then((r) => r.data?.data),
    enabled: isPlatformAdmin,
  });

  const { data: people } = useQuery({
    queryKey: ['business-users', id],
    queryFn: () => businessesApi.listUsers(id).then((r) => r.data?.data ?? []),
    enabled: can(CAP.USERS_VIEW),
  });

  const [selectedUnassigned, setSelectedUnassigned] = useState('');
  const [installerToken, setInstallerToken] = useState<string | null>(null);

  const assignMutation = useMutation({
    mutationFn: (epId: string) => endpointsApi.update(epId, { customerId: id }),
    onSuccess: () => {
      toast({ title: 'Computer moved into this business' });
      setSelectedUnassigned('');
      qc.invalidateQueries({ queryKey: ['endpoints'] });
    },
    onError: (e: { response?: { data?: { message?: string } } }) =>
      toast({ title: 'Could not assign', description: e.response?.data?.message, variant: 'destructive' }),
  });

  const unassignMutation = useMutation({
    mutationFn: (epId: string) => endpointsApi.update(epId, { customerId: null }),
    onSuccess: () => {
      toast({ title: 'Computer removed from this business' });
      qc.invalidateQueries({ queryKey: ['endpoints'] });
    },
    onError: (e: { response?: { data?: { message?: string } } }) =>
      toast({ title: 'Could not remove', description: e.response?.data?.message, variant: 'destructive' }),
  });

  const setQuickConnect = useMutation({
    mutationFn: (enabled: boolean) => businessesApi.update(id, { quickConnectEnabled: enabled }),
    onSuccess: () => {
      toast({ title: 'Quick Connect setting updated' });
      qc.invalidateQueries({ queryKey: ['business', id] });
    },
    onError: (e: { response?: { data?: { message?: string } } }) =>
      toast({ title: 'Could not update', description: e.response?.data?.message, variant: 'destructive' }),
  });

  // Managed-device installer, bound to THIS business at mint time. The machine
  // that redeems it cannot choose a different one.
  const mintInstaller = useMutation({
    mutationFn: () => enrollmentApi.createToken({ businessId: id, accessMode: 'COMPANY_WIDE' }),
    onSuccess: (r) => setInstallerToken(r.data?.data?.token ?? null),
    onError: (e: { response?: { data?: { message?: string } } }) =>
      toast({ title: 'Could not create installer link', description: e.response?.data?.message, variant: 'destructive' }),
  });

  if (isLoading) return <div className="p-6 text-muted-foreground text-sm">Loading…</div>;
  if (!business) return <div className="p-6 text-muted-foreground text-sm">Not found</div>;

  const b = business as Record<string, unknown>;
  const siteList: Record<string, unknown>[] = Array.isArray(sites) ? sites : [];
  const endpointList: Record<string, unknown>[] = Array.isArray(endpointsData?.endpoints) ? endpointsData.endpoints : [];
  const unassignedList: Record<string, unknown>[] = Array.isArray(unassignedData?.endpoints) ? unassignedData.endpoints : [];
  const peopleList: Record<string, unknown>[] = Array.isArray(people) ? people : [];
  const quickConnectEnabled = (b.quickConnectEnabled as boolean) ?? false;
  const origin = typeof window !== 'undefined' ? window.location.origin : '';

  return (
    <div className="p-6 space-y-6">
      <PageHeader title={b.name as string} description={(b.email as string) ?? ''}>
        <Badge variant={(b.isActive as boolean) ? 'default' : 'secondary'}>
          {(b.isActive as boolean) ? 'Active' : 'Disabled'}
        </Badge>
      </PageHeader>

      <Tabs defaultValue="overview">
        <TabsList>
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="computers">Computers ({endpointList.length})</TabsTrigger>
          {can(CAP.USERS_VIEW) && <TabsTrigger value="people">People ({peopleList.length})</TabsTrigger>}
          <TabsTrigger value="downloads">Downloads</TabsTrigger>
          <TabsTrigger value="sites">Sites ({siteList.length})</TabsTrigger>
        </TabsList>

        <TabsContent value="overview" className="mt-4 space-y-4">
          <Card>
            <CardHeader><CardTitle className="text-sm">Details</CardTitle></CardHeader>
            <CardContent className="space-y-3 text-sm">
              <Row label="Code">
                {b.code ? <Badge variant="outline" className="font-mono">{b.code as string}</Badge> : '—'}
              </Row>
              <Row label="Email">{(b.email as string) ?? '—'}</Row>
              <Row label="Phone">{(b.phone as string) ?? '—'}</Row>
              <Row label="Address">{(b.address as string) ?? '—'}</Row>
              <Row label="Created">{formatDate(b.createdAt as string)}</Row>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-sm">
                <Zap className="h-4 w-4" /> Quick Connect
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <p className="text-sm text-muted-foreground">
                Allows this business&apos;s users to connect to a temporary support client using an
                ID and password the remote person reads out. The platform master switch has to be on
                as well, and each Business User still needs the <em>Use Quick Connect</em> permission.
              </p>
              <div className="flex items-center gap-3">
                <input
                  type="checkbox"
                  id="qc-enabled"
                  className="h-4 w-4"
                  checked={quickConnectEnabled}
                  disabled={!isPlatformAdmin || setQuickConnect.isPending}
                  onChange={(e) => setQuickConnect.mutate(e.target.checked)}
                />
                <Label htmlFor="qc-enabled">
                  Quick Connect {quickConnectEnabled ? 'enabled' : 'disabled'} for this business
                </Label>
              </div>
              {!isPlatformAdmin && (
                <p className="text-xs text-muted-foreground">
                  Only a Platform Admin can change this.
                </p>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="computers" className="mt-4 space-y-4">
          {isPlatformAdmin && unassignedList.length > 0 && (
            <Card>
              <CardHeader><CardTitle className="text-sm">Move an unassigned computer here</CardTitle></CardHeader>
              <CardContent>
                <p className="text-xs text-muted-foreground mb-3">
                  Unassigned computers have checked in but do not belong to any business yet.
                </p>
                <div className="flex gap-2">
                  <Select value={selectedUnassigned} onValueChange={setSelectedUnassigned}>
                    <SelectTrigger className="flex-1">
                      <SelectValue placeholder="Select an unassigned computer" />
                    </SelectTrigger>
                    <SelectContent>
                      {unassignedList.map((ep) => (
                        <SelectItem key={ep.id as string} value={ep.id as string}>
                          {ep.name as string}{ep.hostname ? ` (${ep.hostname as string})` : ''}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Button
                    size="sm"
                    disabled={!selectedUnassigned || assignMutation.isPending}
                    onClick={() => selectedUnassigned && assignMutation.mutate(selectedUnassigned)}
                  >
                    <Plus className="h-4 w-4 mr-1" /> Assign
                  </Button>
                </div>
              </CardContent>
            </Card>
          )}

          <div className="rounded-md border bg-background overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b bg-muted/50">
                  <th className="text-left px-4 py-3 font-medium">Name</th>
                  <th className="text-left px-4 py-3 font-medium">Platform</th>
                  <th className="text-left px-4 py-3 font-medium">Status</th>
                  <th className="text-left px-4 py-3 font-medium">Last Seen</th>
                  <th className="px-4 py-3" />
                </tr>
              </thead>
              <tbody className="divide-y">
                {endpointList.length === 0 ? (
                  <tr><td colSpan={5} className="text-center py-6 text-muted-foreground">
                    No computers in this business yet. Use the Downloads tab to enroll one.
                  </td></tr>
                ) : endpointList.map((ep) => (
                  <tr key={ep.id as string} className="hover:bg-muted/30">
                    <td className="px-4 py-3">
                      <Link href={`/endpoints/${ep.id as string}`} className="font-medium hover:underline">
                        {ep.name as string}
                      </Link>
                      {ep.hostname ? <p className="text-xs text-muted-foreground">{ep.hostname as string}</p> : null}
                    </td>
                    <td className="px-4 py-3">
                      {ep.platform ? <Badge variant="secondary">{ep.platform as string}</Badge> : '—'}
                    </td>
                    <td className="px-4 py-3">
                      <StatusIndicator status={(ep.isOnline as boolean) ? 'online' : 'offline'} />
                    </td>
                    <td className="px-4 py-3 text-muted-foreground text-xs">
                      {formatDate(ep.lastSeenAt as string)}
                    </td>
                    <td className="px-4 py-3 text-right">
                      {isPlatformAdmin && (
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-7 w-7 p-0 text-muted-foreground hover:text-destructive"
                          title="Remove from this business"
                          onClick={() => unassignMutation.mutate(ep.id as string)}
                          disabled={unassignMutation.isPending}
                        >
                          <X className="h-3.5 w-3.5" />
                        </Button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </TabsContent>

        {can(CAP.USERS_VIEW) && (
          <TabsContent value="people" className="mt-4">
            <div className="rounded-md border bg-background overflow-hidden">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b bg-muted/50">
                    <th className="text-left px-4 py-3 font-medium">Name</th>
                    <th className="text-left px-4 py-3 font-medium">Email</th>
                    <th className="text-left px-4 py-3 font-medium">Level</th>
                    <th className="text-left px-4 py-3 font-medium">Status</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {peopleList.length === 0 ? (
                    <tr><td colSpan={4} className="text-center py-6 text-muted-foreground">
                      No people yet. Add them from the Users page.
                    </td></tr>
                  ) : peopleList.map((m) => {
                    const u = m.user as Record<string, unknown>;
                    const role = m.role as Record<string, unknown>;
                    return (
                      <tr key={m.id as string}>
                        <td className="px-4 py-3 font-medium">
                          {`${u.firstName ?? ''} ${u.lastName ?? ''}`.trim() || '—'}
                        </td>
                        <td className="px-4 py-3 text-muted-foreground">{u.email as string}</td>
                        <td className="px-4 py-3">
                          <Badge variant="outline">
                            {role.type === 'BUSINESS_OWNER' ? 'Business Owner' : 'Business User'}
                          </Badge>
                        </td>
                        <td className="px-4 py-3">
                          <Badge variant={(u.status as string) === 'ACTIVE' ? 'default' : 'secondary'}>
                            {(u.status as string) ?? 'INVITED'}
                          </Badge>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </TabsContent>
        )}

        <TabsContent value="downloads" className="mt-4 space-y-4">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-sm">
                <Download className="h-4 w-4" /> Managed Device Installer
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <p className="text-sm text-muted-foreground">
                Installs the permanent Rem0te agent. Any computer that runs this link is enrolled as
                a <strong>managed computer belonging to {b.name as string}</strong> — the binding is
                fixed when the link is created and the machine cannot change it.
              </p>
              {installerToken ? (
                <div className="space-y-2">
                  <Label>One-time install command (Windows, run as Administrator)</Label>
                  <Input
                    readOnly
                    className="font-mono text-xs"
                    value={`irm ${origin}/api/v1/public/install/win/${installerToken} | iex`}
                    onFocus={(e) => e.currentTarget.select()}
                  />
                  <p className="text-xs text-muted-foreground">
                    Valid for 24 hours and usable once.
                  </p>
                </div>
              ) : (
                <Button
                  disabled={!can(CAP.COMPUTERS_ADD) || mintInstaller.isPending}
                  onClick={() => mintInstaller.mutate()}
                >
                  Create installer link
                </Button>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-sm">
                <Zap className="h-4 w-4" /> Quick Connect Client
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <p className="text-sm text-muted-foreground">
                For temporary support only. The person runs it, reads out the ID and password it
                shows, and closes it when you are done. <strong>No permanent managed computer is
                created</strong> and nothing is installed as a service.
              </p>
              {quickConnectEnabled ? (
                <Button variant="outline" asChild>
                  <a href="/quick" target="_blank" rel="noopener noreferrer">
                    Open the public Quick Connect page
                  </a>
                </Button>
              ) : (
                <p className="text-sm text-muted-foreground">
                  Quick Connect is disabled for this business.
                </p>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="sites" className="mt-4">
          <div className="rounded-md border bg-background overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b bg-muted/50">
                  <th className="text-left px-4 py-3 font-medium">Name</th>
                  <th className="text-left px-4 py-3 font-medium">City</th>
                  <th className="text-left px-4 py-3 font-medium">Computers</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {siteList.length === 0 ? (
                  <tr><td colSpan={3} className="text-center py-6 text-muted-foreground">No sites.</td></tr>
                ) : siteList.map((s) => (
                  <tr key={s.id as string} className="hover:bg-muted/30">
                    <td className="px-4 py-3 font-medium">{s.name as string}</td>
                    <td className="px-4 py-3 text-muted-foreground">{(s.city as string) ?? '—'}</td>
                    <td className="px-4 py-3 text-muted-foreground">
                      {((s._count as { endpoints?: number }) ?? {})?.endpoints ?? 0}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </TabsContent>
      </Tabs>
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-4">
      <span className="text-muted-foreground">{label}</span>
      <span>{children}</span>
    </div>
  );
}
