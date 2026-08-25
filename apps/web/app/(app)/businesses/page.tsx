'use client';

import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { businessesApi } from '@/lib/api-client';
import { PageHeader } from '@/components/common/page-header';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { useToast } from '@/hooks/use-toast';
import { Plus, Search } from 'lucide-react';
import { usePermissions } from '@/lib/auth';
import { formatDate } from '@/lib/utils';

interface Business {
  id: string;
  name: string;
  code: string | null;
  email: string | null;
  city: string | null;
  isActive: boolean;
  quickConnectEnabled: boolean;
  createdAt: string;
  _count?: { endpoints?: number; sites?: number; portalUsers?: number };
}

export default function BusinessesPage() {
  const { toast } = useToast();
  const qc = useQueryClient();
  const { isPlatformAdmin } = usePermissions();
  const [search, setSearch] = useState('');
  const [showCreate, setShowCreate] = useState(false);
  const [form, setForm] = useState({ name: '', code: '', email: '', phone: '' });

  const { data, isLoading } = useQuery<Business[]>({
    queryKey: ['businesses', search],
    queryFn: () =>
      businessesApi.list(search ? { search } : undefined).then((r) => r.data?.data ?? []),
  });

  const createMutation = useMutation({
    mutationFn: () =>
      businessesApi.create({
        name: form.name,
        code: form.code || undefined,
        email: form.email || undefined,
        phone: form.phone || undefined,
      }),
    onSuccess: () => {
      toast({ title: 'Business created' });
      qc.invalidateQueries({ queryKey: ['businesses'] });
      setShowCreate(false);
      setForm({ name: '', code: '', email: '', phone: '' });
    },
    onError: (e: { response?: { data?: { message?: string } } }) =>
      toast({
        title: 'Could not create business',
        description: e.response?.data?.message,
        variant: 'destructive',
      }),
  });

  const businesses = data ?? [];

  return (
    <div className="p-6 space-y-6">
      <PageHeader
        title="Businesses"
        description={isPlatformAdmin
          ? 'Customer organisations you manage. Each one owns its own computers, people and history.'
          : 'Your business.'}
      >
        {isPlatformAdmin && (
          <Button size="sm" onClick={() => setShowCreate(true)}>
            <Plus className="h-4 w-4 mr-2" />
            Add Business
          </Button>
        )}
      </PageHeader>

      <div className="flex items-center gap-2">
        <div className="relative flex-1 max-w-sm">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Search businesses…"
            className="pl-9"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
      </div>

      {isLoading ? (
        <div className="text-sm text-muted-foreground">Loading…</div>
      ) : (
        <div className="rounded-md border bg-background overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b bg-muted/50">
                <th className="text-left px-4 py-3 font-medium">Name</th>
                <th className="text-left px-4 py-3 font-medium">Code</th>
                <th className="text-left px-4 py-3 font-medium">Email</th>
                <th className="text-left px-4 py-3 font-medium">Computers</th>
                <th className="text-left px-4 py-3 font-medium">People</th>
                <th className="text-left px-4 py-3 font-medium">Status</th>
                <th className="text-left px-4 py-3 font-medium">Created</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {businesses.length === 0 ? (
                <tr>
                  <td colSpan={7} className="text-center py-8 text-muted-foreground">
                    No businesses found.
                  </td>
                </tr>
              ) : (
                businesses.map((b) => (
                  <tr key={b.id} className="hover:bg-muted/30">
                    <td className="px-4 py-3">
                      <Link href={`/businesses/${b.id}`} className="font-medium hover:underline">
                        {b.name}
                      </Link>
                    </td>
                    <td className="px-4 py-3">
                      {b.code ? (
                        <Badge variant="outline" className="font-mono text-xs">{b.code}</Badge>
                      ) : '—'}
                    </td>
                    <td className="px-4 py-3 text-muted-foreground">{b.email ?? '—'}</td>
                    <td className="px-4 py-3 text-muted-foreground">{b._count?.endpoints ?? 0}</td>
                    <td className="px-4 py-3 text-muted-foreground">{b._count?.portalUsers ?? 0}</td>
                    <td className="px-4 py-3">
                      <Badge variant={b.isActive ? 'default' : 'secondary'}>
                        {b.isActive ? 'Active' : 'Disabled'}
                      </Badge>
                    </td>
                    <td className="px-4 py-3 text-muted-foreground text-xs">
                      {formatDate(b.createdAt)}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      )}

      <Dialog open={showCreate} onOpenChange={setShowCreate}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Add Business</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="b-name">Business Name *</Label>
              <Input
                id="b-name"
                value={form.name}
                onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                placeholder="Acme Corp"
                required
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="b-code">Short Code</Label>
              <Input
                id="b-code"
                value={form.code}
                onChange={(e) => setForm((f) => ({ ...f, code: e.target.value.toUpperCase() }))}
                placeholder="ACME"
                maxLength={20}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="b-email">Email</Label>
              <Input
                id="b-email"
                type="email"
                value={form.email}
                onChange={(e) => setForm((f) => ({ ...f, email: e.target.value }))}
                placeholder="it@example.com"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="b-phone">Phone</Label>
              <Input
                id="b-phone"
                value={form.phone}
                onChange={(e) => setForm((f) => ({ ...f, phone: e.target.value }))}
                placeholder="+1-555-0100"
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowCreate(false)}>Cancel</Button>
            <Button
              onClick={() => createMutation.mutate()}
              disabled={!form.name || createMutation.isPending}
            >
              {createMutation.isPending ? 'Creating…' : 'Create'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
