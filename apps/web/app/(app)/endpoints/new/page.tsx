'use client';

import { useState, FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { useQuery, useMutation } from '@tanstack/react-query';
import { endpointsApi, customersApi, sitesApi } from '@/lib/api-client';
import { PageHeader } from '@/components/common/page-header';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useToast } from '@/hooks/use-toast';

export default function NewEndpointPage() {
  const router = useRouter();
  const { toast } = useToast();

  const [form, setForm] = useState({
    name: '',
    hostname: '',
    rustdeskId: '',
    platform: '',
    osVersion: '',
    customerId: '',
    siteId: '',
    description: '',
  });

  const { data: customersData } = useQuery({
    queryKey: ['customers-list'],
    queryFn: () => customersApi.list().then((r) => r.data?.data?.customers ?? []),
  });

  const { data: sitesData } = useQuery({
    queryKey: ['sites-for-customer', form.customerId],
    queryFn: () =>
      form.customerId
        ? sitesApi.list(form.customerId).then((r) => r.data?.data ?? [])
        : Promise.resolve([]),
    enabled: !!form.customerId,
  });

  const createMutation = useMutation({
    mutationFn: (data: Record<string, unknown>) => endpointsApi.create(data),
    onSuccess: (res) => {
      toast({ title: 'Endpoint created' });
      router.push(`/endpoints/${res.data?.data?.id}`);
    },
    onError: (err: unknown) => {
      const msg =
        (err as { response?: { data?: { message?: string } } })?.response?.data?.message ??
        'Failed to create endpoint';
      toast({ title: 'Error', description: msg, variant: 'destructive' });
    },
  });

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    const payload: Record<string, unknown> = {
      name: form.name,
      ...(form.hostname && { hostname: form.hostname }),
      ...(form.rustdeskId && { rustdeskId: form.rustdeskId }),
      ...(form.platform && { platform: form.platform }),
      ...(form.osVersion && { osVersion: form.osVersion }),
      ...(form.customerId && { customerId: form.customerId }),
      ...(form.siteId && { siteId: form.siteId }),
      ...(form.description && { description: form.description }),
    };
    createMutation.mutate(payload);
  }

  const customers: { id: string; name: string }[] = customersData ?? [];
  const sites: { id: string; name: string }[] = sitesData ?? [];

  return (
    <div className="p-6 space-y-6 max-w-2xl">
      <PageHeader title="Add Endpoint" description="Register a new device" />

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Endpoint Details</CardTitle>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="name">Name *</Label>
                <Input
                  id="name"
                  value={form.name}
                  onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                  placeholder="ACME-WS-001"
                  required
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="hostname">Hostname</Label>
                <Input
                  id="hostname"
                  value={form.hostname}
                  onChange={(e) => setForm((f) => ({ ...f, hostname: e.target.value }))}
                  placeholder="ws-001.corp.local"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="rustdeskId">RustDesk ID</Label>
                <Input
                  id="rustdeskId"
                  value={form.rustdeskId}
                  onChange={(e) => setForm((f) => ({ ...f, rustdeskId: e.target.value }))}
                  placeholder="123456789"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="platform">Platform</Label>
                <Select
                  value={form.platform}
                  onValueChange={(v) => setForm((f) => ({ ...f, platform: v }))}
                >
                  <SelectTrigger id="platform">
                    <SelectValue placeholder="Select platform" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="Windows">Windows</SelectItem>
                    <SelectItem value="macOS">macOS</SelectItem>
                    <SelectItem value="Linux">Linux</SelectItem>
                    <SelectItem value="Android">Android</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label htmlFor="osVersion">OS Version</Label>
                <Input
                  id="osVersion"
                  value={form.osVersion}
                  onChange={(e) => setForm((f) => ({ ...f, osVersion: e.target.value }))}
                  placeholder="Windows 11 Pro"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="customer">Customer</Label>
                <Select
                  value={form.customerId}
                  onValueChange={(v) => setForm((f) => ({ ...f, customerId: v, siteId: '' }))}
                >
                  <SelectTrigger id="customer">
                    <SelectValue placeholder="Select customer" />
                  </SelectTrigger>
                  <SelectContent>
                    {customers.map((c) => (
                      <SelectItem key={c.id} value={c.id}>
                        {c.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              {form.customerId && (
                <div className="space-y-2">
                  <Label htmlFor="site">Site</Label>
                  <Select
                    value={form.siteId}
                    onValueChange={(v) => setForm((f) => ({ ...f, siteId: v }))}
                  >
                    <SelectTrigger id="site">
                      <SelectValue placeholder="Select site" />
                    </SelectTrigger>
                    <SelectContent>
                      {sites.map((s) => (
                        <SelectItem key={s.id} value={s.id}>
                          {s.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              )}
            </div>

            <div className="flex gap-3 pt-2">
              <Button type="submit" disabled={createMutation.isPending}>
                {createMutation.isPending ? 'Creating…' : 'Create Endpoint'}
              </Button>
              <Button type="button" variant="outline" onClick={() => router.back()}>
                Cancel
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
