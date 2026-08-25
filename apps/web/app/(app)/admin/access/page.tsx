'use client';

import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import {
  ArrowDown, Building2, Check, Loader2, Plus, Search, Shield, ShieldCheck,
  Trash2, UserCog, Users, X,
} from 'lucide-react';
import { businessesApi, usersApi } from '@/lib/api-client';
import { PageHeader } from '@/components/common/page-header';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { useToast } from '@/hooks/use-toast';
import { usePermissions } from '@/lib/auth';
import { cn, formatDate } from '@/lib/utils';

// ─── Types ───────────────────────────────────────────────────────────────────

interface Business {
  id: string;
  name: string;
  code: string | null;
  city: string | null;
  isActive: boolean;
  quickConnectEnabled: boolean;
  _count?: { endpoints: number; portalUsers: number };
}

interface Membership {
  id: string;
  capabilities: string[];
  isActive: boolean;
  accessLevel: 'Platform Admin' | 'Business Owner' | 'Business User';
  user: {
    id: string; email: string; firstName: string; lastName: string;
    status: string; isPlatformAdmin: boolean;
  };
  role: { id: string; name: string; type: string };
  business: { id: string; name: string } | null;
}

interface CapabilityGroup {
  group: string;
  items: { key: string; label: string; description: string }[];
}

const LEVEL_STYLE: Record<string, string> = {
  'Platform Admin': 'bg-purple-100 text-purple-800 dark:bg-purple-900 dark:text-purple-200',
  'Business Owner': 'bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200',
  'Business User': 'bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300',
};

function fullName(u: { firstName: string; lastName: string; email: string }) {
  const n = `${u.firstName ?? ''} ${u.lastName ?? ''}`.trim();
  return n || u.email;
}

// ─── Overview ────────────────────────────────────────────────────────────────

/**
 * The whole model on one screen. Three boxes, top to bottom — anything more
 * elaborate would be describing a hierarchy Rem0te does not have.
 */
function Overview({ businessCount, userCount, adminCount }: {
  businessCount: number; userCount: number; adminCount: number;
}) {
  const levels = [
    {
      title: 'PLATFORM ADMIN',
      subtitle: 'Full platform access',
      detail: 'The Rem0te operator. Creates and manages every business, every computer and every platform setting.',
      icon: ShieldCheck,
      count: `${adminCount} ${adminCount === 1 ? 'admin' : 'admins'}`,
      ring: 'border-purple-300 dark:border-purple-800 bg-purple-50/60 dark:bg-purple-950/30',
      badge: 'text-purple-700 dark:text-purple-300',
    },
    {
      title: 'BUSINESS OWNER / ADMIN',
      subtitle: 'Full business control',
      detail: 'Complete control of their own business — its computers, its people, its history. Nothing outside it.',
      icon: Building2,
      count: `${businessCount} ${businessCount === 1 ? 'business' : 'businesses'}`,
      ring: 'border-blue-300 dark:border-blue-800 bg-blue-50/60 dark:bg-blue-950/30',
      badge: 'text-blue-700 dark:text-blue-300',
    },
    {
      title: 'BUSINESS USER',
      subtitle: 'Permissions assigned by owner',
      detail: 'Access is determined by permissions assigned by the Business Owner.',
      icon: Users,
      count: `${userCount} ${userCount === 1 ? 'user' : 'users'}`,
      ring: 'border-slate-300 dark:border-slate-700 bg-slate-50/60 dark:bg-slate-900/40',
      badge: 'text-slate-700 dark:text-slate-300',
    },
  ];

  return (
    <div className="space-y-6">
      <div className="mx-auto max-w-2xl">
        {levels.map((lvl, i) => (
          <div key={lvl.title}>
            <div className={cn('rounded-lg border-2 p-5 text-center', lvl.ring)}>
              <lvl.icon className={cn('mx-auto h-7 w-7', lvl.badge)} />
              <h3 className="mt-2 text-sm font-bold tracking-wide">{lvl.title}</h3>
              <p className={cn('text-sm font-medium', lvl.badge)}>{lvl.subtitle}</p>
              <p className="mx-auto mt-2 max-w-md text-xs text-muted-foreground">{lvl.detail}</p>
              <Badge variant="secondary" className="mt-3">{lvl.count}</Badge>
            </div>
            {i < levels.length - 1 && (
              <div className="flex justify-center py-2">
                <ArrowDown className="h-5 w-5 text-muted-foreground/50" />
              </div>
            )}
          </div>
        ))}
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">How it works</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 text-sm text-muted-foreground">
          <p>
            A <strong className="text-foreground">Business</strong> is the security boundary. Its
            computers, users, sessions and audit history belong to it and to nothing else — and
            that is enforced on the server, not by hiding things in this interface.
          </p>
          <p>
            A <strong className="text-foreground">Business Owner</strong> automatically holds every
            permission inside their business. A <strong className="text-foreground">Business User</strong>{' '}
            holds only what the owner has explicitly granted; new users start with{' '}
            <em>View computers</em> and <em>Remote connect</em> and nothing else.
          </p>
          <p>
            Quick Connect is a permission, not a level. It needs three things to line up: the
            platform master switch, the business switch, and the individual&apos;s{' '}
            <em>Use Quick Connect</em> permission.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}

// ─── Businesses tab ──────────────────────────────────────────────────────────

function BusinessesTab() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [search, setSearch] = useState('');
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState({ name: '', code: '', email: '', city: '' });

  const { data: businesses = [], isLoading } = useQuery<Business[]>({
    queryKey: ['businesses', search],
    queryFn: () => businessesApi.list(search ? { search } : undefined).then((r) => r.data?.data ?? []),
  });

  const create = useMutation({
    mutationFn: () => businessesApi.create({
      name: form.name.trim(),
      ...(form.code.trim() ? { code: form.code.trim() } : {}),
      ...(form.email.trim() ? { email: form.email.trim() } : {}),
      ...(form.city.trim() ? { city: form.city.trim() } : {}),
    }),
    onSuccess: () => {
      toast({ title: 'Business created' });
      setCreating(false);
      setForm({ name: '', code: '', email: '', city: '' });
      qc.invalidateQueries({ queryKey: ['businesses'] });
    },
    onError: (e: { response?: { data?: { message?: string } } }) =>
      toast({ title: 'Could not create business', description: e.response?.data?.message, variant: 'destructive' }),
  });

  const setActive = useMutation({
    mutationFn: ({ id, isActive }: { id: string; isActive: boolean }) =>
      businessesApi.update(id, { isActive }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['businesses'] }),
    onError: (e: { response?: { data?: { message?: string } } }) =>
      toast({ title: 'Update failed', description: e.response?.data?.message, variant: 'destructive' }),
  });

  const setQuickConnect = useMutation({
    mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) =>
      businessesApi.update(id, { quickConnectEnabled: enabled }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['businesses'] }),
  });

  const remove = useMutation({
    mutationFn: (id: string) => businessesApi.remove(id),
    onSuccess: () => {
      toast({ title: 'Business deleted' });
      qc.invalidateQueries({ queryKey: ['businesses'] });
    },
    onError: (e: { response?: { data?: { message?: string } } }) =>
      toast({ title: 'Could not delete', description: e.response?.data?.message, variant: 'destructive' }),
  });

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <div className="relative flex-1 max-w-sm">
          <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Search businesses..."
            className="pl-8"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        <Button onClick={() => setCreating(true)}>
          <Plus className="mr-2 h-4 w-4" /> New business
        </Button>
      </div>

      <Card>
        <CardContent className="p-0">
          {isLoading ? (
            <div className="p-8 text-center text-sm text-muted-foreground">Loading…</div>
          ) : businesses.length === 0 ? (
            <div className="p-8 text-center text-sm text-muted-foreground">
              No businesses yet. Create one to start adding computers and people to it.
            </div>
          ) : (
            <table className="w-full text-sm">
              <thead className="border-b text-left text-xs uppercase tracking-wide text-muted-foreground">
                <tr>
                  <th className="px-4 py-3 font-medium">Business</th>
                  <th className="px-4 py-3 font-medium">Computers</th>
                  <th className="px-4 py-3 font-medium">People</th>
                  <th className="px-4 py-3 font-medium">Quick Connect</th>
                  <th className="px-4 py-3 font-medium">Status</th>
                  <th className="px-4 py-3" />
                </tr>
              </thead>
              <tbody className="divide-y">
                {businesses.map((b) => (
                  <tr key={b.id} className="hover:bg-muted/40">
                    <td className="px-4 py-3">
                      <Link href={`/businesses/${b.id}`} className="font-medium hover:underline">
                        {b.name}
                      </Link>
                      <div className="text-xs text-muted-foreground">
                        {[b.code, b.city].filter(Boolean).join(' · ') || '—'}
                      </div>
                    </td>
                    <td className="px-4 py-3">{b._count?.endpoints ?? 0}</td>
                    <td className="px-4 py-3">{b._count?.portalUsers ?? 0}</td>
                    <td className="px-4 py-3">
                      <Button
                        size="sm"
                        variant={b.quickConnectEnabled ? 'default' : 'outline'}
                        onClick={() => setQuickConnect.mutate({ id: b.id, enabled: !b.quickConnectEnabled })}
                      >
                        {b.quickConnectEnabled ? 'Enabled' : 'Disabled'}
                      </Button>
                    </td>
                    <td className="px-4 py-3">
                      <Badge variant={b.isActive ? 'default' : 'secondary'}>
                        {b.isActive ? 'Active' : 'Disabled'}
                      </Badge>
                    </td>
                    <td className="px-4 py-3 text-right">
                      <div className="flex justify-end gap-2">
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => setActive.mutate({ id: b.id, isActive: !b.isActive })}
                        >
                          {b.isActive ? 'Disable' : 'Enable'}
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          title="Delete — only possible when the business is empty"
                          onClick={() => {
                            if (confirm(`Delete ${b.name}? This only works if it has no computers, users or session history.`)) {
                              remove.mutate(b.id);
                            }
                          }}
                        >
                          <Trash2 className="h-4 w-4 text-destructive" />
                        </Button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>

      <Dialog open={creating} onOpenChange={setCreating}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>New business</DialogTitle>
            <DialogDescription>
              A business owns its own computers, people and history. Nothing is shared with any other business.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div>
              <Label htmlFor="b-name">Business name</Label>
              <Input id="b-name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label htmlFor="b-code">Short code (optional)</Label>
                <Input id="b-code" value={form.code} onChange={(e) => setForm({ ...form, code: e.target.value })} />
              </div>
              <div>
                <Label htmlFor="b-city">City (optional)</Label>
                <Input id="b-city" value={form.city} onChange={(e) => setForm({ ...form, city: e.target.value })} />
              </div>
            </div>
            <div>
              <Label htmlFor="b-email">Contact email (optional)</Label>
              <Input id="b-email" type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCreating(false)}>Cancel</Button>
            <Button disabled={!form.name.trim() || create.isPending} onClick={() => create.mutate()}>
              {create.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Create
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ─── Permission editor ───────────────────────────────────────────────────────

function PermissionsDialog({
  membership, catalog, open, onClose,
}: {
  membership: Membership | null;
  catalog: CapabilityGroup[];
  open: boolean;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [selected, setSelected] = useState<string[]>([]);
  const [initialised, setInitialised] = useState<string | null>(null);

  // Seed the checkboxes the first time this membership is opened.
  if (membership && initialised !== membership.id) {
    setSelected(membership.capabilities ?? []);
    setInitialised(membership.id);
  }

  const save = useMutation({
    mutationFn: () => usersApi.setCapabilities(membership!.user.id, selected),
    onSuccess: () => {
      toast({ title: 'Permissions updated' });
      qc.invalidateQueries({ queryKey: ['access-users'] });
      onClose();
    },
    onError: (e: { response?: { data?: { message?: string } } }) =>
      toast({ title: 'Could not save', description: e.response?.data?.message, variant: 'destructive' }),
  });

  const isOwner = membership?.accessLevel === 'Business Owner' || membership?.user.isPlatformAdmin;

  function toggle(key: string) {
    setSelected((cur) => (cur.includes(key) ? cur.filter((k) => k !== key) : [...cur, key]));
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Permissions</DialogTitle>
          <DialogDescription>
            {membership ? `${fullName(membership.user)} · ${membership.business?.name ?? 'No business'}` : ''}
          </DialogDescription>
        </DialogHeader>

        {isOwner ? (
          <p className="rounded-md border bg-muted/40 p-4 text-sm text-muted-foreground">
            This person already holds every permission in their business. Permissions are assigned
            to Business Users; change their level first if you want to restrict them.
          </p>
        ) : (
          <div className="max-h-[55vh] space-y-4 overflow-y-auto pr-1">
            {catalog.map((group) => (
              <div key={group.group}>
                <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  {group.group}
                </div>
                <div className="space-y-1">
                  {group.items.map((item) => {
                    const on = selected.includes(item.key);
                    return (
                      <button
                        key={item.key}
                        type="button"
                        onClick={() => toggle(item.key)}
                        className={cn(
                          'flex w-full items-start gap-3 rounded-md border p-2.5 text-left transition-colors',
                          on ? 'border-primary/40 bg-primary/5' : 'hover:bg-muted/50',
                        )}
                      >
                        <span className={cn(
                          'mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded border',
                          on ? 'border-primary bg-primary text-primary-foreground' : 'border-muted-foreground/40',
                        )}>
                          {on && <Check className="h-3 w-3" />}
                        </span>
                        <span>
                          <span className="block text-sm font-medium">{item.label}</span>
                          <span className="block text-xs text-muted-foreground">{item.description}</span>
                        </span>
                      </button>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          {!isOwner && (
            <Button disabled={save.isPending} onClick={() => save.mutate()}>
              {save.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Save permissions
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ─── Business Users tab ──────────────────────────────────────────────────────

function BusinessUsersTab({ businesses }: { businesses: Business[] }) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const { isPlatformAdmin } = usePermissions();
  const [businessFilter, setBusinessFilter] = useState<string>('all');
  const [editing, setEditing] = useState<Membership | null>(null);
  const [adding, setAdding] = useState(false);
  const [invite, setInvite] = useState({ email: '', firstName: '', lastName: '', businessId: '', level: 'BUSINESS_USER' as 'BUSINESS_OWNER' | 'BUSINESS_USER' });
  const [inviteToken, setInviteToken] = useState<string | null>(null);

  const { data: memberships = [], isLoading } = useQuery<Membership[]>({
    queryKey: ['access-users', businessFilter],
    queryFn: () => usersApi
      .list(businessFilter === 'all' ? undefined : businessFilter)
      .then((r) => r.data?.data ?? []),
  });

  const { data: catalog = [] } = useQuery<CapabilityGroup[]>({
    queryKey: ['capability-catalog'],
    queryFn: () => businessesApi.capabilityCatalog().then((r) => r.data?.data ?? []),
    staleTime: Infinity,
  });

  const addUser = useMutation({
    mutationFn: () => businessesApi.addUser(invite.businessId, {
      email: invite.email.trim(),
      firstName: invite.firstName.trim() || undefined,
      lastName: invite.lastName.trim() || undefined,
      level: invite.level,
    }),
    onSuccess: (res) => {
      setInviteToken(res.data?.data?.inviteToken ?? null);
      qc.invalidateQueries({ queryKey: ['access-users'] });
      toast({ title: 'User added' });
    },
    onError: (e: { response?: { data?: { message?: string } } }) =>
      toast({ title: 'Could not add user', description: e.response?.data?.message, variant: 'destructive' }),
  });

  const setLevel = useMutation({
    mutationFn: ({ userId, level }: { userId: string; level: 'BUSINESS_OWNER' | 'BUSINESS_USER' }) =>
      usersApi.setLevel(userId, level),
    onSuccess: () => {
      toast({ title: 'Access level updated' });
      qc.invalidateQueries({ queryKey: ['access-users'] });
    },
    onError: (e: { response?: { data?: { message?: string } } }) =>
      toast({ title: 'Could not change level', description: e.response?.data?.message, variant: 'destructive' }),
  });

  const toggleActive = useMutation({
    mutationFn: ({ userId, active }: { userId: string; active: boolean }) =>
      active ? usersApi.activate(userId) : usersApi.suspend(userId),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['access-users'] }),
    onError: (e: { response?: { data?: { message?: string } } }) =>
      toast({ title: 'Could not update', description: e.response?.data?.message, variant: 'destructive' }),
  });

  const removeUser = useMutation({
    mutationFn: (userId: string) => usersApi.remove(userId),
    onSuccess: () => {
      toast({ title: 'User removed' });
      qc.invalidateQueries({ queryKey: ['access-users'] });
    },
    onError: (e: { response?: { data?: { message?: string } } }) =>
      toast({ title: 'Could not remove', description: e.response?.data?.message, variant: 'destructive' }),
  });

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        {isPlatformAdmin && (
          <Select value={businessFilter} onValueChange={setBusinessFilter}>
            <SelectTrigger className="w-56">
              <SelectValue placeholder="All businesses" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All businesses</SelectItem>
              {businesses.map((b) => (
                <SelectItem key={b.id} value={b.id}>{b.name}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
        <div className="flex-1" />
        <Button
          disabled={businesses.length === 0}
          onClick={() => {
            setInviteToken(null);
            setInvite({
              email: '', firstName: '', lastName: '',
              businessId: businessFilter !== 'all' ? businessFilter : businesses[0]?.id ?? '',
              level: 'BUSINESS_USER',
            });
            setAdding(true);
          }}
        >
          <Plus className="mr-2 h-4 w-4" /> Add person
        </Button>
      </div>

      <Card>
        <CardContent className="p-0">
          {isLoading ? (
            <div className="p-8 text-center text-sm text-muted-foreground">Loading…</div>
          ) : memberships.length === 0 ? (
            <div className="p-8 text-center text-sm text-muted-foreground">
              No people yet.
            </div>
          ) : (
            <table className="w-full text-sm">
              <thead className="border-b text-left text-xs uppercase tracking-wide text-muted-foreground">
                <tr>
                  <th className="px-4 py-3 font-medium">Person</th>
                  <th className="px-4 py-3 font-medium">Business</th>
                  <th className="px-4 py-3 font-medium">Level</th>
                  <th className="px-4 py-3 font-medium">Permissions</th>
                  <th className="px-4 py-3 font-medium">Status</th>
                  <th className="px-4 py-3" />
                </tr>
              </thead>
              <tbody className="divide-y">
                {memberships.map((m) => (
                  <tr key={m.id} className="hover:bg-muted/40">
                    <td className="px-4 py-3">
                      <div className="font-medium">{fullName(m.user)}</div>
                      <div className="text-xs text-muted-foreground">{m.user.email}</div>
                    </td>
                    <td className="px-4 py-3">{m.business?.name ?? <span className="text-muted-foreground">—</span>}</td>
                    <td className="px-4 py-3">
                      <Badge className={LEVEL_STYLE[m.accessLevel]}>{m.accessLevel}</Badge>
                    </td>
                    <td className="px-4 py-3">
                      {m.accessLevel === 'Business User' ? (
                        <span className="text-xs text-muted-foreground">
                          {m.capabilities.length} granted
                        </span>
                      ) : (
                        <span className="text-xs text-muted-foreground">All</span>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      <Badge variant={m.user.status === 'ACTIVE' ? 'default' : 'secondary'}>
                        {m.user.status}
                      </Badge>
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex justify-end gap-1">
                        {m.accessLevel === 'Business User' && (
                          <Button size="sm" variant="outline" onClick={() => setEditing(m)}>
                            <UserCog className="mr-1.5 h-3.5 w-3.5" /> Permissions
                          </Button>
                        )}
                        {isPlatformAdmin && !m.user.isPlatformAdmin && (
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => setLevel.mutate({
                              userId: m.user.id,
                              level: m.accessLevel === 'Business Owner' ? 'BUSINESS_USER' : 'BUSINESS_OWNER',
                            })}
                          >
                            {m.accessLevel === 'Business Owner' ? 'Make user' : 'Make owner'}
                          </Button>
                        )}
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => toggleActive.mutate({
                            userId: m.user.id,
                            active: m.user.status !== 'ACTIVE',
                          })}
                        >
                          {m.user.status === 'ACTIVE' ? 'Disable' : 'Enable'}
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => {
                            if (confirm(`Remove ${fullName(m.user)} from ${m.business?.name ?? 'this business'}?`)) {
                              removeUser.mutate(m.user.id);
                            }
                          }}
                        >
                          <Trash2 className="h-4 w-4 text-destructive" />
                        </Button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>

      <PermissionsDialog
        membership={editing}
        catalog={catalog}
        open={!!editing}
        onClose={() => setEditing(null)}
      />

      <Dialog open={adding} onOpenChange={(o) => { if (!o) { setAdding(false); setInviteToken(null); } }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Add a person to a business</DialogTitle>
            <DialogDescription>
              Business Users start with <em>View computers</em> and <em>Remote connect</em>. You can
              adjust that immediately afterwards.
            </DialogDescription>
          </DialogHeader>

          {inviteToken ? (
            <div className="space-y-3">
              <p className="text-sm text-muted-foreground">
                Send this one-time setup link to the person. It expires in 7 days.
              </p>
              <Input
                readOnly
                value={`${typeof window !== 'undefined' ? window.location.origin : ''}/accept-invite?token=${inviteToken}`}
                onFocus={(e) => e.currentTarget.select()}
              />
            </div>
          ) : (
            <div className="space-y-3">
              <div>
                <Label htmlFor="u-email">Email</Label>
                <Input id="u-email" type="email" value={invite.email}
                  onChange={(e) => setInvite({ ...invite, email: e.target.value })} />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <Label htmlFor="u-first">First name</Label>
                  <Input id="u-first" value={invite.firstName}
                    onChange={(e) => setInvite({ ...invite, firstName: e.target.value })} />
                </div>
                <div>
                  <Label htmlFor="u-last">Last name</Label>
                  <Input id="u-last" value={invite.lastName}
                    onChange={(e) => setInvite({ ...invite, lastName: e.target.value })} />
                </div>
              </div>
              <div>
                <Label>Business</Label>
                <Select value={invite.businessId} onValueChange={(v) => setInvite({ ...invite, businessId: v })}>
                  <SelectTrigger><SelectValue placeholder="Choose a business" /></SelectTrigger>
                  <SelectContent>
                    {businesses.map((b) => <SelectItem key={b.id} value={b.id}>{b.name}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
              <div>
                <Label>Access level</Label>
                <Select
                  value={invite.level}
                  onValueChange={(v) => setInvite({ ...invite, level: v as 'BUSINESS_OWNER' | 'BUSINESS_USER' })}
                >
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="BUSINESS_USER">Business User</SelectItem>
                    {isPlatformAdmin && <SelectItem value="BUSINESS_OWNER">Business Owner</SelectItem>}
                  </SelectContent>
                </Select>
              </div>
            </div>
          )}

          <DialogFooter>
            <Button variant="outline" onClick={() => { setAdding(false); setInviteToken(null); }}>
              {inviteToken ? 'Done' : 'Cancel'}
            </Button>
            {!inviteToken && (
              <Button
                disabled={!invite.email.trim() || !invite.businessId || addUser.isPending}
                onClick={() => addUser.mutate()}
              >
                {addUser.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                Add
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ─── Platform Admins tab ─────────────────────────────────────────────────────

function PlatformAdminsTab() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const { user } = usePermissions();
  const [email, setEmail] = useState('');
  const [found, setFound] = useState<{ id: string; email: string; firstName: string; lastName: string } | null>(null);
  const [searched, setSearched] = useState(false);

  const { data: admins = [], isLoading } = useQuery({
    queryKey: ['platform-admins'],
    queryFn: () => usersApi.listPlatformAdmins().then((r) => r.data?.data ?? []),
  });

  const lookup = useMutation({
    mutationFn: () => usersApi.findByEmail(email.trim()),
    onSuccess: (r) => { setFound(r.data?.data ?? null); setSearched(true); },
  });

  const setAdmin = useMutation({
    mutationFn: ({ userId, enabled }: { userId: string; enabled: boolean }) =>
      usersApi.setPlatformAdmin(userId, enabled),
    onSuccess: () => {
      toast({ title: 'Platform admins updated' });
      setFound(null); setEmail(''); setSearched(false);
      qc.invalidateQueries({ queryKey: ['platform-admins'] });
    },
    onError: (e: { response?: { data?: { message?: string } } }) =>
      toast({ title: 'Could not update', description: e.response?.data?.message, variant: 'destructive' }),
  });

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Grant Platform Admin</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <p className="text-sm text-muted-foreground">
            Platform Admins can see and change everything, in every business. Keep the list short.
          </p>
          <div className="flex gap-2">
            <Input
              placeholder="person@example.com"
              value={email}
              onChange={(e) => { setEmail(e.target.value); setSearched(false); setFound(null); }}
              onKeyDown={(e) => e.key === 'Enter' && email.trim() && lookup.mutate()}
            />
            <Button variant="outline" disabled={!email.trim() || lookup.isPending} onClick={() => lookup.mutate()}>
              <Search className="mr-2 h-4 w-4" /> Find
            </Button>
          </div>
          {searched && !found && (
            <p className="text-sm text-muted-foreground">
              No Rem0te account with that email. Add them to a business first.
            </p>
          )}
          {found && (
            <div className="flex items-center justify-between rounded-md border p-3">
              <div>
                <div className="text-sm font-medium">{fullName(found)}</div>
                <div className="text-xs text-muted-foreground">{found.email}</div>
              </div>
              <Button size="sm" onClick={() => setAdmin.mutate({ userId: found.id, enabled: true })}>
                <ShieldCheck className="mr-2 h-4 w-4" /> Make Platform Admin
              </Button>
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardContent className="p-0">
          {isLoading ? (
            <div className="p-8 text-center text-sm text-muted-foreground">Loading…</div>
          ) : (
            <table className="w-full text-sm">
              <thead className="border-b text-left text-xs uppercase tracking-wide text-muted-foreground">
                <tr>
                  <th className="px-4 py-3 font-medium">Platform Admin</th>
                  <th className="px-4 py-3 font-medium">MFA</th>
                  <th className="px-4 py-3 font-medium">Since</th>
                  <th className="px-4 py-3" />
                </tr>
              </thead>
              <tbody className="divide-y">
                {admins.map((a: { id: string; email: string; firstName: string; lastName: string; createdAt: string; mfaMethods?: unknown[] }) => (
                  <tr key={a.id} className="hover:bg-muted/40">
                    <td className="px-4 py-3">
                      <div className="font-medium">{fullName(a)}</div>
                      <div className="text-xs text-muted-foreground">{a.email}</div>
                    </td>
                    <td className="px-4 py-3">
                      {a.mfaMethods && a.mfaMethods.length > 0
                        ? <Badge variant="default">Enabled</Badge>
                        : <Badge variant="secondary">Not set up</Badge>}
                    </td>
                    <td className="px-4 py-3 text-muted-foreground">{formatDate(a.createdAt)}</td>
                    <td className="px-4 py-3 text-right">
                      {a.id !== user?.id && (
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => {
                            if (confirm(`Revoke Platform Admin from ${fullName(a)}?`)) {
                              setAdmin.mutate({ userId: a.id, enabled: false });
                            }
                          }}
                        >
                          <X className="mr-1.5 h-3.5 w-3.5" /> Revoke
                        </Button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

// ─── Page ────────────────────────────────────────────────────────────────────

export default function AccessControlPage() {
  const { isPlatformAdmin, isLoading } = usePermissions();

  const { data: businesses = [] } = useQuery<Business[]>({
    queryKey: ['businesses', ''],
    queryFn: () => businessesApi.list().then((r) => r.data?.data ?? []),
  });

  const { data: memberships = [] } = useQuery<Membership[]>({
    queryKey: ['access-users', 'all'],
    queryFn: () => usersApi.list().then((r) => r.data?.data ?? []),
  });

  const { data: admins = [] } = useQuery({
    queryKey: ['platform-admins'],
    queryFn: () => usersApi.listPlatformAdmins().then((r) => r.data?.data ?? []),
    enabled: isPlatformAdmin,
  });

  const businessUserCount = useMemo(
    () => memberships.filter((m) => m.accessLevel === 'Business User').length,
    [memberships],
  );

  if (isLoading) {
    return <div className="p-8 text-sm text-muted-foreground">Loading…</div>;
  }

  if (!isPlatformAdmin) {
    return (
      <div className="space-y-6">
        <PageHeader title="Access Control" description="Who can do what in Rem0te." />
        <Card>
          <CardContent className="p-8 text-center text-sm text-muted-foreground">
            <Shield className="mx-auto mb-3 h-8 w-8 text-muted-foreground/50" />
            Access Control is managed by your Rem0te administrator.
            <div className="mt-2">
              To manage the people in your own business, use <Link href="/users" className="underline">Users</Link>.
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Access Control"
        description="Three levels: Platform Admin, Business Owner, Business User."
      />

      <Tabs defaultValue="overview">
        <TabsList>
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="businesses">Businesses</TabsTrigger>
          <TabsTrigger value="users">Business Users</TabsTrigger>
          <TabsTrigger value="admins">Platform Admins</TabsTrigger>
        </TabsList>

        <TabsContent value="overview" className="mt-6">
          <Overview
            businessCount={businesses.length}
            userCount={businessUserCount}
            adminCount={admins.length}
          />
        </TabsContent>

        <TabsContent value="businesses" className="mt-6">
          <BusinessesTab />
        </TabsContent>

        <TabsContent value="users" className="mt-6">
          <BusinessUsersTab businesses={businesses} />
        </TabsContent>

        <TabsContent value="admins" className="mt-6">
          <PlatformAdminsTab />
        </TabsContent>
      </Tabs>
    </div>
  );
}
