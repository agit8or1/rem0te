'use client';

import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { customersApi } from '@/lib/api-client';
import { PageHeader } from '@/components/common/page-header';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { useToast } from '@/hooks/use-toast';
import { Plus, Search } from 'lucide-react';
import { formatDate } from '@/lib/utils';

export default function CustomersPage() {
  const { toast } = useToast();
  const qc = useQueryClient();
  const [search, setSearch] = useState('');
  const [showCreate, setShowCreate] = useState(false);
  const [form, setForm] = useState({ name: '', code: '', email: '', phone: '' });

  const { data, isLoading } = useQuery({
    queryKey: ['customers', search],
    queryFn: () =>
      customersApi.list(search ? { search } : undefined).then((r) => r.data?.data),
  });

  const createMutation = useMutation({
    mutationFn: () =>
      customersApi.create({
        name: form.name,
        code: form.code || undefined,
        email: form.email || undefined,
        phone: form.phone || undefined,
      }),
    onSuccess: () => {
      toast({ title: 'Customer created' });
      qc.invalidateQueries({ queryKey: ['customers'] });
      setShowCreate(false);
      setForm({ name: '', code: '', email: '', phone: '' });
    },
    onError: () => toast({ title: 'Error', description: 'Failed to create customer', variant: 'destructive' }),
  });

  const customers: Record<string, unknown>[] = Array.isArray(data) ? data : [];

  return (
    <div className="p-6 space-y-6">
      <PageHeader title="Customers" description="Manage customer accounts">
        <Button size="sm" onClick={() => setShowCreate(true)}>
          <Plus className="h-4 w-4 mr-2" />
          Add Customer
        </Button>
      </PageHeader>

      <div className="flex items-center gap-2">
        <div className="relative flex-1 max-w-sm">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Search customers…"
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
                <th className="text-left px-4 py-3 font-medium">Endpoints</th>
                <th className="text-left px-4 py-3 font-medium">Created</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {customers.length === 0 ? (
                <tr>
                  <td colSpan={5} className="text-center py-8 text-muted-foreground">
                    No customers found.
                  </td>
                </tr>
              ) : (
                customers.map((c) => {
                  const counts = c._count as { endpoints?: number; sites?: number } | null;
                  return (
                    <tr key={c.id as string} className="hover:bg-muted/30">
                      <td className="px-4 py-3">
                        <Link href={`/customers/${c.id as string}`} className="font-medium hover:underline">
                          {c.name as string}
                        </Link>
                      </td>
                      <td className="px-4 py-3">
                        {c.code ? (
                          <Badge variant="outline" className="font-mono text-xs">{c.code as string}</Badge>
                        ) : '—'}
                      </td>
                      <td className="px-4 py-3 text-muted-foreground">{(c.email as string) ?? '—'}</td>
                      <td className="px-4 py-3 text-muted-foreground">{counts?.endpoints ?? 0}</td>
                      <td className="px-4 py-3 text-muted-foreground text-xs">
                        {formatDate(c.createdAt as string)}
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      )}

      <Dialog open={showCreate} onOpenChange={setShowCreate}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Add Customer</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="cust-name">Company Name *</Label>
              <Input
                id="cust-name"
                value={form.name}
                onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                placeholder="Acme Corp"
                required
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="cust-code">Short Code</Label>
              <Input
                id="cust-code"
                value={form.code}
                onChange={(e) => setForm((f) => ({ ...f, code: e.target.value.toUpperCase() }))}
                placeholder="ACME"
                maxLength={20}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="cust-email">Email</Label>
              <Input
                id="cust-email"
                type="email"
                value={form.email}
                onChange={(e) => setForm((f) => ({ ...f, email: e.target.value }))}
                placeholder="it@example.com"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="cust-phone">Phone</Label>
              <Input
                id="cust-phone"
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
