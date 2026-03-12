'use client';

import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import { customersApi, endpointsApi, sitesApi, authApi, tenantsApi } from '@/lib/api-client';
import { PageHeader } from '@/components/common/page-header';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { StatusIndicator } from '@/components/common/status-indicator';
import { formatDate } from '@/lib/utils';
import { useToast } from '@/hooks/use-toast';
import { X, Plus } from 'lucide-react';

export default function CustomerDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { toast } = useToast();
  const qc = useQueryClient();

  const { data: customer, isLoading } = useQuery({
    queryKey: ['customer', id],
    queryFn: () => customersApi.get(id).then((r) => r.data?.data),
  });

  const { data: sites } = useQuery({
    queryKey: ['sites', id],
    queryFn: () => sitesApi.list(id).then((r) => r.data?.data ?? []),
  });

  const { data: endpointsData } = useQuery({
    queryKey: ['endpoints', 'customer', id],
    queryFn: () => endpointsApi.list({ customerId: id }).then((r) => r.data?.data),
  });

  // Fetch all unassigned endpoints for this tenant so we can assign them
  const { data: meData } = useQuery({
    queryKey: ['me'],
    queryFn: () => authApi.me().then((r) => r.data?.data),
  });
  const tenantId: string = meData?.tenantId ?? '';
  const { data: tenantData } = useQuery({
    queryKey: ['tenant', tenantId],
    queryFn: () => tenantsApi.get(tenantId).then((r) => r.data?.data),
    enabled: !!tenantId,
  });
  const { data: unassignedData } = useQuery({
    queryKey: ['endpoints', 'unassigned'],
    queryFn: () => endpointsApi.list({ customerId: 'null' }).then((r) => r.data?.data),
  });

  const [selectedUnassigned, setSelectedUnassigned] = useState('');

  const assignMutation = useMutation({
    mutationFn: (epId: string) => endpointsApi.update(epId, { customerId: id }),
    onSuccess: () => {
      toast({ title: 'Endpoint assigned' });
      setSelectedUnassigned('');
      qc.invalidateQueries({ queryKey: ['endpoints', 'customer', id] });
      qc.invalidateQueries({ queryKey: ['endpoints', 'unassigned'] });
    },
    onError: () => toast({ title: 'Failed to assign endpoint', variant: 'destructive' }),
  });

  const unassignMutation = useMutation({
    mutationFn: (epId: string) => endpointsApi.update(epId, { customerId: null }),
    onSuccess: () => {
      toast({ title: 'Endpoint removed from customer' });
      qc.invalidateQueries({ queryKey: ['endpoints', 'customer', id] });
      qc.invalidateQueries({ queryKey: ['endpoints', 'unassigned'] });
    },
    onError: () => toast({ title: 'Failed to remove endpoint', variant: 'destructive' }),
  });

  const { data: portalUsers } = useQuery({
    queryKey: ['customer-portal-users', id],
    queryFn: () => customersApi.listPortalUsers(id).then((r) => r.data?.data ?? []),
  });

  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteFirstName, setInviteFirstName] = useState('');
  const [inviteLastName, setInviteLastName] = useState('');

  const togglePortalMutation = useMutation({
    mutationFn: (enabled: boolean) => customersApi.togglePortal(id, enabled),
    onSuccess: () => {
      toast({ title: 'Portal access updated' });
      qc.invalidateQueries({ queryKey: ['customer', id] });
    },
    onError: () => toast({ title: 'Error updating portal access', variant: 'destructive' }),
  });

  const inviteMutation = useMutation({
    mutationFn: () => customersApi.invitePortalUser(id, {
      email: inviteEmail,
      firstName: inviteFirstName,
      lastName: inviteLastName,
    }),
    onSuccess: () => {
      toast({ title: 'Portal user invited successfully' });
      setInviteEmail('');
      setInviteFirstName('');
      setInviteLastName('');
      qc.invalidateQueries({ queryKey: ['customer-portal-users', id] });
    },
    onError: () => toast({ title: 'Failed to invite portal user', variant: 'destructive' }),
  });

  if (isLoading) return <div className="p-6 text-muted-foreground text-sm">Loading…</div>;
  if (!customer) return <div className="p-6 text-muted-foreground text-sm">Not found</div>;

  const c = customer as Record<string, unknown>;
  const siteList: Record<string, unknown>[] = Array.isArray(sites) ? sites : [];
  const endpointList: Record<string, unknown>[] = Array.isArray(endpointsData?.endpoints) ? endpointsData.endpoints : [];
  const unassignedList: Record<string, unknown>[] = Array.isArray(unassignedData?.endpoints) ? unassignedData.endpoints : [];
  const portalUserList: Record<string, unknown>[] = Array.isArray(portalUsers) ? portalUsers : [];
  void tenantData;
  const portalEnabled = (c.portalEnabled as boolean) ?? false;

  return (
    <div className="p-6 space-y-6">
      <PageHeader title={c.name as string} description={(c.email as string) ?? ''} />

      <Tabs defaultValue="overview">
        <TabsList>
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="sites">Sites ({siteList.length})</TabsTrigger>
          <TabsTrigger value="endpoints">Endpoints ({endpointList.length})</TabsTrigger>
          <TabsTrigger value="portal">Portal Access</TabsTrigger>
        </TabsList>

        <TabsContent value="overview" className="mt-4">
          <Card>
            <CardHeader><CardTitle className="text-sm">Details</CardTitle></CardHeader>
            <CardContent className="space-y-3 text-sm">
              <Row label="Code">
                {c.code ? <Badge variant="outline" className="font-mono">{c.code as string}</Badge> : '—'}
              </Row>
              <Row label="Email">{(c.email as string) ?? '—'}</Row>
              <Row label="Phone">{(c.phone as string) ?? '—'}</Row>
              <Row label="Address">{(c.address as string) ?? '—'}</Row>
              <Row label="Created">{formatDate(c.createdAt as string)}</Row>
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
                  <th className="text-left px-4 py-3 font-medium">Endpoints</th>
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

        <TabsContent value="endpoints" className="mt-4 space-y-4">
          {/* Assign endpoint */}
          {unassignedList.length > 0 && (
            <Card>
              <CardHeader><CardTitle className="text-sm">Assign Endpoint</CardTitle></CardHeader>
              <CardContent>
                <p className="text-xs text-muted-foreground mb-3">
                  Assigning an endpoint to this customer locks portal users to only seeing that machine.
                </p>
                <div className="flex gap-2">
                  <select
                    className="flex-1 rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                    value={selectedUnassigned}
                    onChange={(e) => setSelectedUnassigned(e.target.value)}
                  >
                    <option value="">— Select an unassigned endpoint —</option>
                    {unassignedList.map((ep) => (
                      <option key={ep.id as string} value={ep.id as string}>
                        {ep.name as string}{ep.hostname ? ` (${ep.hostname as string})` : ''}
                      </option>
                    ))}
                  </select>
                  <Button
                    size="sm"
                    disabled={!selectedUnassigned || assignMutation.isPending}
                    onClick={() => selectedUnassigned && assignMutation.mutate(selectedUnassigned)}
                  >
                    <Plus className="h-4 w-4 mr-1" />
                    Assign
                  </Button>
                </div>
              </CardContent>
            </Card>
          )}

          {/* Assigned endpoints table */}
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
                  <tr><td colSpan={5} className="text-center py-6 text-muted-foreground">No endpoints assigned. Use the picker above to assign one.</td></tr>
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
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-7 w-7 p-0 text-muted-foreground hover:text-destructive"
                        title="Remove from customer"
                        onClick={() => unassignMutation.mutate(ep.id as string)}
                        disabled={unassignMutation.isPending}
                      >
                        <X className="h-3.5 w-3.5" />
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </TabsContent>
        <TabsContent value="portal" className="mt-4 space-y-4">
          <Card>
            <CardHeader><CardTitle className="text-sm">Portal Access</CardTitle></CardHeader>
            <CardContent className="space-y-4">
              <p className="text-sm text-muted-foreground">
                Enable portal access for this customer so their users can log in to view devices and request support.
              </p>
              <div className="flex items-center gap-3">
                <input
                  type="checkbox"
                  id="portal-enabled"
                  checked={portalEnabled}
                  onChange={(e) => togglePortalMutation.mutate(e.target.checked)}
                  disabled={togglePortalMutation.isPending}
                  className="h-4 w-4"
                />
                <Label htmlFor="portal-enabled">Enable portal for this customer</Label>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader><CardTitle className="text-sm">Portal Users</CardTitle></CardHeader>
            <CardContent className="space-y-4">
              {portalUserList.length === 0 ? (
                <p className="text-sm text-muted-foreground">No portal users yet.</p>
              ) : (
                <div className="rounded-md border overflow-hidden">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b bg-muted/50">
                        <th className="text-left px-4 py-3 font-medium">Name</th>
                        <th className="text-left px-4 py-3 font-medium">Email</th>
                        <th className="text-left px-4 py-3 font-medium">Status</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y">
                      {portalUserList.map((u) => (
                        <tr key={u.id as string}>
                          <td className="px-4 py-3 font-medium">{`${u.firstName ?? ''} ${u.lastName ?? ''}`.trim() || '—'}</td>
                          <td className="px-4 py-3 text-muted-foreground">{u.email as string}</td>
                          <td className="px-4 py-3">
                            <Badge variant={(u.status as string) === 'ACTIVE' ? 'default' : 'secondary'}>
                              {u.status as string ?? 'INVITED'}
                            </Badge>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader><CardTitle className="text-sm">Invite Portal User</CardTitle></CardHeader>
            <CardContent>
              <form
                onSubmit={(e) => { e.preventDefault(); inviteMutation.mutate(); }}
                className="space-y-4"
              >
                <div className="grid grid-cols-2 gap-4">
                  <div className="space-y-2">
                    <Label htmlFor="invite-first-name">First Name</Label>
                    <Input
                      id="invite-first-name"
                      value={inviteFirstName}
                      onChange={(e) => setInviteFirstName(e.target.value)}
                      placeholder="Jane"
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="invite-last-name">Last Name</Label>
                    <Input
                      id="invite-last-name"
                      value={inviteLastName}
                      onChange={(e) => setInviteLastName(e.target.value)}
                      placeholder="Smith"
                    />
                  </div>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="invite-email">Email</Label>
                  <Input
                    id="invite-email"
                    type="email"
                    value={inviteEmail}
                    onChange={(e) => setInviteEmail(e.target.value)}
                    placeholder="jane@example.com"
                    required
                  />
                </div>
                <Button type="submit" disabled={inviteMutation.isPending}>
                  {inviteMutation.isPending ? 'Inviting…' : 'Send Invite'}
                </Button>
              </form>
            </CardContent>
          </Card>
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
