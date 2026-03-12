'use client';

import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { authApi, tenantsApi, usersApi, customersApi, endpointsApi } from '@/lib/api-client';
import { PageHeader } from '@/components/common/page-header';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useToast } from '@/hooks/use-toast';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem,
  DropdownMenuSeparator, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  ChevronDown, ChevronRight, Shield, Users, Building2, Plus, Search, Pencil,
  ShieldCheck, Trash2, MoreHorizontal, KeyRound, ShieldOff, UserX, UserCheck,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { formatDate } from '@/lib/utils';

// ─── Shared ───────────────────────────────────────────────────────────────────

const ROLE_COLORS: Record<string, string> = {
  TENANT_OWNER: 'bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200',
  TENANT_ADMIN: 'bg-purple-100 text-purple-800 dark:bg-purple-900 dark:text-purple-200',
  TECHNICIAN: 'bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200',
  BILLING_ADMIN: 'bg-yellow-100 text-yellow-800 dark:bg-yellow-900 dark:text-yellow-200',
  READ_ONLY: 'bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300',
  CUSTOMER: 'bg-orange-100 text-orange-800 dark:bg-orange-900 dark:text-orange-200',
};

// ─── Overview Tab ─────────────────────────────────────────────────────────────

const HIERARCHY_LEVELS = [
  { label: 'Platform Admin', desc: 'Full system access', color: 'border-red-400 bg-red-50 dark:bg-red-950/30' },
  { label: 'Tenant Owner', desc: 'Full tenant control', color: 'border-blue-400 bg-blue-50 dark:bg-blue-950/30' },
  { label: 'Tenant Admin', desc: 'Manage users & settings', color: 'border-purple-400 bg-purple-50 dark:bg-purple-950/30' },
  { label: 'Technician', desc: 'Connect & manage endpoints', color: 'border-green-400 bg-green-50 dark:bg-green-950/30' },
  { label: 'Billing Admin', desc: 'View billing & audit', color: 'border-yellow-400 bg-yellow-50 dark:bg-yellow-950/30' },
  { label: 'Read Only', desc: 'View-only access', color: 'border-gray-400 bg-gray-50 dark:bg-gray-950/30' },
  { label: 'Customer Portal', desc: 'Own devices + request support', color: 'border-orange-400 bg-orange-50 dark:bg-orange-950/30' },
];

function OverviewTab({ me }: { me: Record<string, unknown> }) {
  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle className="text-sm flex items-center gap-2">
            <Shield className="h-4 w-4" />
            Platform Admins
          </CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">
            Platform Admins have the{' '}
            <code className="text-xs bg-muted px-1 py-0.5 rounded">isPlatformAdmin</code> flag and
            full access to all tenants and admin APIs. Currently logged in as{' '}
            <strong>{me.email as string}</strong>.
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-sm">Permission Hierarchy</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex flex-col items-center gap-1">
            {HIERARCHY_LEVELS.map((level, i) => (
              <div key={level.label} className="flex flex-col items-center w-full">
                <div className={cn('rounded-lg border-2 px-4 py-2 text-center w-full max-w-xs', level.color)}>
                  <div className="font-semibold text-sm">{level.label}</div>
                  <div className="text-xs text-muted-foreground">{level.desc}</div>
                </div>
                {i < HIERARCHY_LEVELS.length - 1 && <div className="h-4 w-px bg-border" />}
              </div>
            ))}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

// ─── Tenants Tab ──────────────────────────────────────────────────────────────

function TenantCard({ tenant }: { tenant: Record<string, unknown> }) {
  const { toast } = useToast();
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [showEdit, setShowEdit] = useState(false);
  const [editName, setEditName] = useState('');
  const tenantId = tenant.id as string;

  const { data: membersData, isLoading } = useQuery({
    queryKey: ['tenant-members', tenantId],
    queryFn: () => tenantsApi.listMembers(tenantId).then((r) => r.data?.data ?? []),
    enabled: open,
  });
  const members = Array.isArray(membersData) ? membersData : [];

  const editMutation = useMutation({
    mutationFn: () => tenantsApi.update(tenantId, { name: editName }),
    onSuccess: () => {
      toast({ title: 'Tenant updated' });
      qc.invalidateQueries({ queryKey: ['all-tenants'] });
      setShowEdit(false);
    },
    onError: () => toast({ title: 'Error updating tenant', variant: 'destructive' }),
  });

  function openEdit(e: React.MouseEvent) {
    e.stopPropagation();
    setEditName(tenant.name as string);
    setShowEdit(true);
  }

  return (
    <>
    <Card>
      <CardHeader className="pb-3 cursor-pointer" onClick={() => setOpen((o) => !o)}>
        <CardTitle className="flex items-center justify-between text-sm">
          <div className="flex items-center gap-2">
            <Building2 className="h-4 w-4 text-muted-foreground" />
            {tenant.name as string}
            <span className="text-xs text-muted-foreground font-normal">/{tenant.slug as string}</span>
          </div>
          <div className="flex items-center gap-2">
            <Button variant="ghost" size="sm" className="h-7 w-7 p-0" onClick={openEdit}>
              <Pencil className="h-3.5 w-3.5" />
            </Button>
            {open ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
          </div>
        </CardTitle>
      </CardHeader>
      {open && (
        <CardContent className="pt-0">
          {isLoading ? (
            <p className="text-sm text-muted-foreground">Loading members…</p>
          ) : members.length === 0 ? (
            <p className="text-sm text-muted-foreground">No members</p>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b">
                  <th className="py-2 text-left text-xs text-muted-foreground font-medium">User</th>
                  <th className="py-2 text-left text-xs text-muted-foreground font-medium">Role</th>
                  <th className="py-2 text-left text-xs text-muted-foreground font-medium">Status</th>
                </tr>
              </thead>
              <tbody>
                {members.map((m: Record<string, unknown>) => {
                  const u = m.user as Record<string, unknown>;
                  const r = m.role as Record<string, unknown>;
                  return (
                    <tr key={m.id as string} className="border-b last:border-0">
                      <td className="py-2 pr-4">
                        <div className="font-medium">{u?.firstName as string} {u?.lastName as string}</div>
                        <div className="text-xs text-muted-foreground">{u?.email as string}</div>
                      </td>
                      <td className="py-2 pr-4">
                        <span className={cn('text-xs px-2 py-1 rounded-full font-medium', ROLE_COLORS[r?.type as string] ?? 'bg-gray-100')}>
                          {r?.name as string}
                        </span>
                      </td>
                      <td className="py-2">
                        <Badge variant={u?.status === 'ACTIVE' ? 'default' : 'secondary'} className="text-xs">
                          {u?.status as string}
                        </Badge>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </CardContent>
      )}
    </Card>

    <Dialog open={showEdit} onOpenChange={setShowEdit}>
      <DialogContent aria-describedby={undefined}>
        <DialogHeader><DialogTitle>Edit Tenant</DialogTitle></DialogHeader>
        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="edit-tenant-name">Name *</Label>
            <Input
              id="edit-tenant-name"
              value={editName}
              onChange={(e) => setEditName(e.target.value)}
              placeholder="Acme Inc."
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => setShowEdit(false)}>Cancel</Button>
          <Button onClick={() => editMutation.mutate()} disabled={!editName.trim() || editMutation.isPending}>
            {editMutation.isPending ? 'Saving…' : 'Save'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
    </>
  );
}

function slugify(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function TenantsTab({ isPlatformAdmin }: { isPlatformAdmin: boolean }) {
  const { toast } = useToast();
  const qc = useQueryClient();
  const [showCreate, setShowCreate] = useState(false);
  const [tenantName, setTenantName] = useState('');
  const [tenantSlug, setTenantSlug] = useState('');
  const [slugEdited, setSlugEdited] = useState(false);

  const { data: tenantsData } = useQuery({
    queryKey: ['all-tenants'],
    queryFn: () => tenantsApi.list().then((r) => r.data?.data ?? []),
    enabled: isPlatformAdmin,
  });
  const tenants = Array.isArray(tenantsData) ? tenantsData : [];

  const createMutation = useMutation({
    mutationFn: () => tenantsApi.create({ name: tenantName, slug: tenantSlug }),
    onSuccess: () => {
      toast({ title: 'Tenant created' });
      qc.invalidateQueries({ queryKey: ['all-tenants'] });
      setShowCreate(false);
      setTenantName('');
      setTenantSlug('');
      setSlugEdited(false);
    },
    onError: () => toast({ title: 'Error', description: 'Failed to create tenant', variant: 'destructive' }),
  });

  function handleNameChange(value: string) {
    setTenantName(value);
    if (!slugEdited) {
      setTenantSlug(slugify(value));
    }
  }

  function handleSlugChange(value: string) {
    setTenantSlug(value);
    setSlugEdited(true);
  }

  const slugValid = /^[a-z0-9-]+$/.test(tenantSlug);
  const canSubmit = tenantName.trim() !== '' && tenantSlug.trim() !== '' && slugValid && !createMutation.isPending;

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">
          {tenants.length} tenant{tenants.length !== 1 ? 's' : ''} on this platform. Click a tenant to expand its members.
        </p>
        <Button size="sm" onClick={() => setShowCreate(true)}>
          <Plus className="h-4 w-4 mr-2" />
          Create Tenant
        </Button>
      </div>

      {tenants.length === 0 ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : (
        tenants.map((t: Record<string, unknown>) => (
          <TenantCard key={t.id as string} tenant={t} />
        ))
      )}

      <Dialog open={showCreate} onOpenChange={(open) => {
        setShowCreate(open);
        if (!open) {
          setTenantName('');
          setTenantSlug('');
          setSlugEdited(false);
        }
      }}>
        <DialogContent aria-describedby={undefined}>
          <DialogHeader><DialogTitle>Create Tenant</DialogTitle></DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="tenant-name">Name *</Label>
              <Input
                id="tenant-name"
                value={tenantName}
                onChange={(e) => handleNameChange(e.target.value)}
                placeholder="Acme Inc."
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="tenant-slug">Slug *</Label>
              <Input
                id="tenant-slug"
                value={tenantSlug}
                onChange={(e) => handleSlugChange(e.target.value)}
                placeholder="acme-inc"
              />
              {tenantSlug && !slugValid && (
                <p className="text-xs text-destructive">Slug may only contain lowercase letters, numbers, and hyphens.</p>
              )}
              <p className="text-xs text-muted-foreground">Auto-generated from name. Only lowercase letters, numbers, and hyphens.</p>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowCreate(false)}>Cancel</Button>
            <Button onClick={() => createMutation.mutate()} disabled={!canSubmit}>
              {createMutation.isPending ? 'Creating…' : 'Create Tenant'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ─── Technicians Tab ──────────────────────────────────────────────────────────

const ROLE_PRIORITY_ACCESS: Record<string, number> = {
  PLATFORM_ADMIN: 100, TENANT_OWNER: 90, TENANT_ADMIN: 80,
  BILLING_ADMIN: 60, TECHNICIAN: 50, READ_ONLY: 40, CUSTOMER: 10,
};

type AccessMember = {
  id: string;
  user: { id: string; email: string; firstName: string; lastName: string; status: string; mfaMethods: unknown[] };
  role: { id: string; name: string; type: string } | null;
  createdAt: string;
};

function EditUserDialog({ member, onClose }: { member: AccessMember; onClose: () => void }) {
  const { toast } = useToast();
  const qc = useQueryClient();
  const [firstName, setFirstName] = useState(member.user.firstName);
  const [lastName,  setLastName]  = useState(member.user.lastName);
  const [email,     setEmail]     = useState(member.user.email);

  const mutation = useMutation({
    mutationFn: () => usersApi.updateProfile(member.user.id, { firstName, lastName, email }),
    onSuccess: () => {
      toast({ title: 'User updated' });
      qc.invalidateQueries({ queryKey: ['members'] });
      onClose();
    },
    onError: (e: unknown) => {
      const msg = (e as { response?: { data?: { message?: string } } })?.response?.data?.message ?? 'Update failed';
      toast({ title: 'Error', description: msg, variant: 'destructive' });
    },
  });

  return (
    <Dialog open onOpenChange={onClose}>
      <DialogContent aria-describedby={undefined}>
        <DialogHeader><DialogTitle>Edit User</DialogTitle></DialogHeader>
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <Label>First Name</Label>
              <Input value={firstName} onChange={e => setFirstName(e.target.value)} />
            </div>
            <div className="space-y-1">
              <Label>Last Name</Label>
              <Input value={lastName} onChange={e => setLastName(e.target.value)} />
            </div>
          </div>
          <div className="space-y-1">
            <Label>Email</Label>
            <Input type="email" value={email} onChange={e => setEmail(e.target.value)} />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button onClick={() => mutation.mutate()} disabled={mutation.isPending}>
            {mutation.isPending ? 'Saving…' : 'Save Changes'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ResetPasswordDialog({ member, onClose }: { member: AccessMember; onClose: () => void }) {
  const { toast } = useToast();
  const [password, setPassword] = useState('');
  const [confirm,  setConfirm]  = useState('');

  const mutation = useMutation({
    mutationFn: () => usersApi.resetPassword(member.user.id, password),
    onSuccess: () => { toast({ title: 'Password reset' }); onClose(); },
    onError: (e: unknown) => {
      const msg = (e as { response?: { data?: { message?: string } } })?.response?.data?.message ?? 'Failed';
      toast({ title: 'Error', description: msg, variant: 'destructive' });
    },
  });

  const mismatch = password !== confirm && confirm.length > 0;
  const valid = password.length >= 8 && password === confirm;

  return (
    <Dialog open onOpenChange={onClose}>
      <DialogContent aria-describedby={undefined}>
        <DialogHeader><DialogTitle>Reset Password</DialogTitle></DialogHeader>
        <p className="text-sm text-muted-foreground">Set a new password for <span className="font-medium">{member.user.email}</span>.</p>
        <div className="space-y-3">
          <div className="space-y-1">
            <Label>New Password</Label>
            <Input type="password" value={password} onChange={e => setPassword(e.target.value)} placeholder="Minimum 8 characters" />
          </div>
          <div className="space-y-1">
            <Label>Confirm Password</Label>
            <Input type="password" value={confirm} onChange={e => setConfirm(e.target.value)} />
            {mismatch && <p className="text-xs text-destructive">Passwords do not match</p>}
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button onClick={() => mutation.mutate()} disabled={!valid || mutation.isPending}>
            {mutation.isPending ? 'Resetting…' : 'Reset Password'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ChangeRoleDialog({ member, roles, myRoleType, onClose }: {
  member: AccessMember; roles: { id: string; name: string; type: string }[]; myRoleType: string; onClose: () => void;
}) {
  const { toast } = useToast();
  const qc = useQueryClient();
  const [roleId, setRoleId] = useState(member.role?.id ?? '');

  const myPriority = ROLE_PRIORITY_ACCESS[myRoleType] ?? 0;
  const assignableRoles = roles.filter(r => (ROLE_PRIORITY_ACCESS[r.type] ?? 0) < myPriority);

  const mutation = useMutation({
    mutationFn: () => usersApi.changeRole(member.user.id, roleId),
    onSuccess: () => {
      toast({ title: 'Role updated' });
      qc.invalidateQueries({ queryKey: ['members'] });
      onClose();
    },
    onError: (e: unknown) => {
      const msg = (e as { response?: { data?: { message?: string } } })?.response?.data?.message ?? 'Failed';
      toast({ title: 'Error', description: msg, variant: 'destructive' });
    },
  });

  return (
    <Dialog open onOpenChange={onClose}>
      <DialogContent aria-describedby={undefined}>
        <DialogHeader><DialogTitle>Change Role</DialogTitle></DialogHeader>
        <p className="text-sm text-muted-foreground">{member.user.email}</p>
        <div className="space-y-1">
          <Label>Role</Label>
          <Select value={roleId} onValueChange={setRoleId}>
            <SelectTrigger><SelectValue placeholder="Select role" /></SelectTrigger>
            <SelectContent>
              {assignableRoles.map(r => <SelectItem key={r.id} value={r.id}>{r.name}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button onClick={() => mutation.mutate()} disabled={!roleId || mutation.isPending}>
            {mutation.isPending ? 'Saving…' : 'Update Role'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function TechniciansTab({ tenantId, myUserId, myRoleType, isPlatformAdmin }: {
  tenantId: string; myUserId: string; myRoleType: string; isPlatformAdmin: boolean;
}) {
  const { toast } = useToast();
  const qc = useQueryClient();
  const [showInvite,    setShowInvite]    = useState(false);
  const [inviteEmail,   setInviteEmail]   = useState('');
  const [inviteRoleId,  setInviteRoleId]  = useState('');
  const [editingMember, setEditingMember] = useState<AccessMember | null>(null);
  const [resetPwMember, setResetPwMember] = useState<AccessMember | null>(null);
  const [changeRoleMbr, setChangeRoleMbr] = useState<AccessMember | null>(null);

  const { data: members, isLoading } = useQuery({
    queryKey: ['members', tenantId],
    queryFn: () => usersApi.listMembers(tenantId).then((r) => r.data?.data ?? []),
    enabled: !!tenantId,
  });

  const { data: roles } = useQuery({
    queryKey: ['roles', tenantId],
    queryFn: () => usersApi.listRoles(tenantId).then((r) => r.data?.data ?? []),
    enabled: !!tenantId,
  });

  const inviteMutation = useMutation({
    mutationFn: () => usersApi.invite(tenantId, { email: inviteEmail, roleId: inviteRoleId }),
    onSuccess: () => {
      toast({ title: 'Invitation sent' });
      qc.invalidateQueries({ queryKey: ['members'] });
      setShowInvite(false); setInviteEmail(''); setInviteRoleId('');
    },
    onError: (e: unknown) => {
      const msg = (e as { response?: { data?: { message?: string } } })?.response?.data?.message ?? 'Failed';
      toast({ title: 'Error', description: msg, variant: 'destructive' });
    },
  });

  const suspendMutation = useMutation({
    mutationFn: (userId: string) => usersApi.suspend(tenantId, userId),
    onSuccess: () => { toast({ title: 'User suspended' }); qc.invalidateQueries({ queryKey: ['members'] }); },
    onError: (e: unknown) => {
      const msg = (e as { response?: { data?: { message?: string } } })?.response?.data?.message ?? 'Failed';
      toast({ title: 'Error', description: msg, variant: 'destructive' });
    },
  });

  const activateMutation = useMutation({
    mutationFn: (userId: string) => usersApi.activate(tenantId, userId),
    onSuccess: () => { toast({ title: 'User activated' }); qc.invalidateQueries({ queryKey: ['members'] }); },
    onError: (e: unknown) => {
      const msg = (e as { response?: { data?: { message?: string } } })?.response?.data?.message ?? 'Failed';
      toast({ title: 'Error', description: msg, variant: 'destructive' });
    },
  });

  const removeMutation = useMutation({
    mutationFn: (userId: string) => usersApi.remove(userId),
    onSuccess: () => { toast({ title: 'User removed' }); qc.invalidateQueries({ queryKey: ['members'] }); },
    onError: (e: unknown) => {
      const msg = (e as { response?: { data?: { message?: string } } })?.response?.data?.message ?? 'Failed';
      toast({ title: 'Error', description: msg, variant: 'destructive' });
    },
  });

  const resetMfaMutation = useMutation({
    mutationFn: (userId: string) => usersApi.resetMfa(userId),
    onSuccess: () => { toast({ title: 'MFA reset' }); qc.invalidateQueries({ queryKey: ['members'] }); },
    onError: (e: unknown) => {
      const msg = (e as { response?: { data?: { message?: string } } })?.response?.data?.message ?? 'Failed';
      toast({ title: 'Error', description: msg, variant: 'destructive' });
    },
  });

  const memberList: AccessMember[] = Array.isArray(members) ? (members as AccessMember[]) : [];
  const roleList: { id: string; name: string; type: string }[] = Array.isArray(roles) ? roles : [];
  const myPriority = ROLE_PRIORITY_ACCESS[myRoleType] ?? 0;

  function canActOn(m: AccessMember) {
    if (m.user.id === myUserId) return false;
    if (isPlatformAdmin) return true;
    const targetP = ROLE_PRIORITY_ACCESS[m.role?.type ?? ''] ?? 0;
    return myPriority > 0 && targetP < myPriority;
  }

  function statusBadge(status: string) {
    const cls: Record<string, string> = {
      ACTIVE: 'bg-green-100 text-green-700', SUSPENDED: 'bg-red-100 text-red-700',
      INVITED: 'bg-yellow-100 text-yellow-700', DELETED: 'bg-gray-100 text-gray-500',
    };
    return (
      <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${cls[status] ?? 'bg-muted text-muted-foreground'}`}>
        {status}
      </span>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex justify-end">
        <Button size="sm" onClick={() => setShowInvite(true)}>
          <Plus className="h-4 w-4 mr-2" />
          Invite User
        </Button>
      </div>

      {isLoading ? (
        <div className="text-sm text-muted-foreground">Loading…</div>
      ) : (
        <div className="rounded-md border bg-background overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b bg-muted/50">
                <th className="text-left px-4 py-3 font-medium">User</th>
                <th className="text-left px-4 py-3 font-medium">Role</th>
                <th className="text-left px-4 py-3 font-medium">MFA</th>
                <th className="text-left px-4 py-3 font-medium">Status</th>
                <th className="text-left px-4 py-3 font-medium">Joined</th>
                <th className="px-4 py-3" />
              </tr>
            </thead>
            <tbody className="divide-y">
              {memberList.length === 0 ? (
                <tr><td colSpan={6} className="text-center py-8 text-muted-foreground">No members yet.</td></tr>
              ) : memberList.map((m) => {
                const hasMfa = (m.user.mfaMethods?.length ?? 0) > 0;
                const isSelf = m.user.id === myUserId;
                return (
                  <tr key={m.id} className="hover:bg-muted/30">
                    <td className="px-4 py-3">
                      <p className="font-medium">
                        {m.user.firstName || m.user.lastName
                          ? `${m.user.firstName} ${m.user.lastName}`.trim()
                          : <span className="text-muted-foreground italic">No name</span>}
                        {isSelf && <span className="ml-1.5 text-xs text-muted-foreground">(you)</span>}
                      </p>
                      <p className="text-xs text-muted-foreground">{m.user.email}</p>
                    </td>
                    <td className="px-4 py-3"><Badge variant="secondary">{m.role?.name ?? '—'}</Badge></td>
                    <td className="px-4 py-3">
                      {hasMfa
                        ? <span className="text-green-600 text-xs font-medium">Enabled</span>
                        : <span className="text-muted-foreground text-xs">—</span>}
                    </td>
                    <td className="px-4 py-3">{statusBadge(m.user.status)}</td>
                    <td className="px-4 py-3 text-muted-foreground text-xs">{formatDate(m.createdAt)}</td>
                    <td className="px-4 py-3 text-right">
                      {canActOn(m) && (
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <Button variant="ghost" size="sm" className="h-7 w-7 p-0">
                              <MoreHorizontal className="h-4 w-4" />
                            </Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end">
                            <DropdownMenuItem onClick={() => setEditingMember(m)}>
                              <Pencil className="h-3.5 w-3.5 mr-2" /> Edit Profile
                            </DropdownMenuItem>
                            <DropdownMenuItem onClick={() => setResetPwMember(m)}>
                              <KeyRound className="h-3.5 w-3.5 mr-2" /> Reset Password
                            </DropdownMenuItem>
                            <DropdownMenuItem onClick={() => setChangeRoleMbr(m)}>
                              <Shield className="h-3.5 w-3.5 mr-2" /> Change Role
                            </DropdownMenuItem>
                            {hasMfa && (
                              <DropdownMenuItem
                                onClick={() => resetMfaMutation.mutate(m.user.id)}
                                className="text-orange-600 focus:text-orange-600">
                                <ShieldOff className="h-3.5 w-3.5 mr-2" /> Reset MFA
                              </DropdownMenuItem>
                            )}
                            <DropdownMenuSeparator />
                            {m.user.status === 'SUSPENDED' ? (
                              <DropdownMenuItem onClick={() => activateMutation.mutate(m.user.id)}>
                                <UserCheck className="h-3.5 w-3.5 mr-2" /> Activate
                              </DropdownMenuItem>
                            ) : m.user.status !== 'DELETED' && (
                              <DropdownMenuItem
                                onClick={() => suspendMutation.mutate(m.user.id)}
                                className="text-destructive focus:text-destructive">
                                <UserX className="h-3.5 w-3.5 mr-2" /> Suspend
                              </DropdownMenuItem>
                            )}
                            <DropdownMenuItem
                              onClick={() => { if (confirm(`Remove ${m.user.email} from this tenant?`)) removeMutation.mutate(m.user.id); }}
                              className="text-destructive focus:text-destructive">
                              <UserX className="h-3.5 w-3.5 mr-2" /> Remove from Tenant
                            </DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* Invite dialog */}
      <Dialog open={showInvite} onOpenChange={setShowInvite}>
        <DialogContent aria-describedby={undefined}>
          <DialogHeader><DialogTitle>Invite Team Member</DialogTitle></DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="invite-email">Email *</Label>
              <Input id="invite-email" type="email" value={inviteEmail}
                onChange={(e) => setInviteEmail(e.target.value)} placeholder="colleague@example.com" />
            </div>
            <div className="space-y-2">
              <Label htmlFor="invite-role">Role *</Label>
              <Select value={inviteRoleId} onValueChange={setInviteRoleId}>
                <SelectTrigger id="invite-role"><SelectValue placeholder="Select role" /></SelectTrigger>
                <SelectContent>
                  {roleList
                    .filter(r => isPlatformAdmin || (ROLE_PRIORITY_ACCESS[r.type] ?? 0) < myPriority)
                    .map(r => <SelectItem key={r.id} value={r.id}>{r.name}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowInvite(false)}>Cancel</Button>
            <Button onClick={() => inviteMutation.mutate()} disabled={!inviteEmail || !inviteRoleId || inviteMutation.isPending}>
              {inviteMutation.isPending ? 'Sending…' : 'Send Invite'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {editingMember  && <EditUserDialog    member={editingMember}  onClose={() => setEditingMember(null)} />}
      {resetPwMember  && <ResetPasswordDialog member={resetPwMember} onClose={() => setResetPwMember(null)} />}
      {changeRoleMbr  && <ChangeRoleDialog member={changeRoleMbr} roles={roleList} myRoleType={myRoleType} onClose={() => setChangeRoleMbr(null)} />}
    </div>
  );
}

// ─── Customers Tab ────────────────────────────────────────────────────────────

interface Endpoint {
  id: string;
  name: string;
  hostname: string;
  isOnline: boolean;
  customerId: string | null | undefined;
}

function CustomerRow({ customer }: { customer: Record<string, unknown> }) {
  const { toast } = useToast();
  const qc = useQueryClient();
  const [expanded, setExpanded] = useState(false);
  const [showEdit, setShowEdit] = useState(false);
  const [editForm, setEditForm] = useState({ name: '', code: '', email: '', phone: '' });
  const customerId = customer.id as string;

  const editMutation = useMutation({
    mutationFn: () => customersApi.update(customerId, {
      name: editForm.name,
      code: editForm.code || undefined,
      email: editForm.email || undefined,
      phone: editForm.phone || undefined,
    }),
    onSuccess: () => {
      toast({ title: 'Customer updated' });
      qc.invalidateQueries({ queryKey: ['customers'] });
      setShowEdit(false);
    },
    onError: () => toast({ title: 'Error updating customer', variant: 'destructive' }),
  });

  function openEdit(e: React.MouseEvent) {
    e.stopPropagation();
    setEditForm({
      name: (customer.name as string) ?? '',
      code: (customer.code as string) ?? '',
      email: (customer.email as string) ?? '',
      phone: (customer.phone as string) ?? '',
    });
    setShowEdit(true);
  }

  const { data: assignedData, isLoading: loadingAssigned } = useQuery({
    queryKey: ['customer-endpoints', customerId],
    queryFn: () => endpointsApi.list({ customerId }).then((r) => (r.data?.data?.endpoints ?? []) as Endpoint[]),
    enabled: expanded,
  });

  const { data: allEndpointsData } = useQuery({
    queryKey: ['all-endpoints'],
    queryFn: () => endpointsApi.list({}).then((r) => (r.data?.data?.endpoints ?? []) as Endpoint[]),
    enabled: expanded,
  });

  const assignedEndpoints: Endpoint[] = Array.isArray(assignedData) ? assignedData : [];
  const allEndpoints: Endpoint[] = Array.isArray(allEndpointsData) ? allEndpointsData : [];

  const assignedIds = new Set(assignedEndpoints.map((ep) => ep.id));
  const unassignedEndpoints = allEndpoints.filter(
    (ep) => (ep.customerId == null) && !assignedIds.has(ep.id),
  );

  const assignMutation = useMutation({
    mutationFn: (endpointId: string) =>
      endpointsApi.update(endpointId, { customerId }),
    onSuccess: () => {
      toast({ title: 'Endpoint assigned' });
      qc.invalidateQueries({ queryKey: ['customer-endpoints', customerId] });
      qc.invalidateQueries({ queryKey: ['all-endpoints'] });
    },
    onError: () => toast({ title: 'Error', description: 'Failed to assign endpoint', variant: 'destructive' }),
  });

  const counts = customer._count as { endpoints?: number } | null;

  return (
    <>
      <tr
        className="hover:bg-muted/30 cursor-pointer select-none"
        onClick={() => setExpanded((o) => !o)}
      >
        <td className="px-4 py-3">
          <div className="flex items-center gap-2">
            {expanded ? <ChevronDown className="h-3.5 w-3.5 text-muted-foreground shrink-0" /> : <ChevronRight className="h-3.5 w-3.5 text-muted-foreground shrink-0" />}
            <span className="font-medium">{customer.name as string}</span>
            <Button variant="ghost" size="sm" className="h-6 w-6 p-0 ml-1" onClick={openEdit}>
              <Pencil className="h-3 w-3" />
            </Button>
          </div>
        </td>
        <td className="px-4 py-3">
          {customer.code
            ? <Badge variant="outline" className="font-mono text-xs">{customer.code as string}</Badge>
            : '—'}
        </td>
        <td className="px-4 py-3 text-muted-foreground">{(customer.email as string) ?? '—'}</td>
        <td className="px-4 py-3 text-muted-foreground">{counts?.endpoints ?? 0}</td>
        <td className="px-4 py-3 text-muted-foreground text-xs">{formatDate(customer.createdAt as string)}</td>
      </tr>

      {expanded && (
        <tr>
          <td colSpan={5} className="px-4 pb-4 bg-muted/20">
            <div className="pt-3 space-y-4">
              {/* Assigned endpoints */}
              <div>
                <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-2">Assigned Endpoints</p>
                {loadingAssigned ? (
                  <p className="text-sm text-muted-foreground">Loading…</p>
                ) : assignedEndpoints.length === 0 ? (
                  <p className="text-sm text-muted-foreground">No endpoints assigned.</p>
                ) : (
                  <div className="rounded-md border bg-background overflow-hidden">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="border-b bg-muted/50">
                          <th className="text-left px-3 py-2 text-xs font-medium">Name</th>
                          <th className="text-left px-3 py-2 text-xs font-medium">Hostname</th>
                          <th className="text-left px-3 py-2 text-xs font-medium">Status</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y">
                        {assignedEndpoints.map((ep) => (
                          <tr key={ep.id} className="hover:bg-muted/30">
                            <td className="px-3 py-2 font-medium">{ep.name}</td>
                            <td className="px-3 py-2 text-muted-foreground font-mono text-xs">{ep.hostname}</td>
                            <td className="px-3 py-2">
                              <span className={cn(
                                'inline-flex items-center gap-1 text-xs font-medium',
                                ep.isOnline ? 'text-green-600' : 'text-muted-foreground',
                              )}>
                                <span className={cn('h-1.5 w-1.5 rounded-full', ep.isOnline ? 'bg-green-500' : 'bg-gray-400')} />
                                {ep.isOnline ? 'Online' : 'Offline'}
                              </span>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
                <p className="text-xs text-muted-foreground mt-2">
                  Customers can only access endpoints assigned to their account.
                </p>
              </div>

              {/* Assign endpoint */}
              <div>
                <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-2">Assign Endpoint</p>
                {unassignedEndpoints.length === 0 ? (
                  <p className="text-sm text-muted-foreground">No unassigned endpoints available.</p>
                ) : (
                  <Select
                    onValueChange={(endpointId) => assignMutation.mutate(endpointId)}
                    disabled={assignMutation.isPending}
                  >
                    <SelectTrigger className="w-full max-w-sm">
                      <SelectValue placeholder="Select an endpoint to assign…" />
                    </SelectTrigger>
                    <SelectContent>
                      {unassignedEndpoints.map((ep) => (
                        <SelectItem key={ep.id} value={ep.id}>
                          {ep.name} — <span className="text-muted-foreground font-mono">{ep.hostname}</span>
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
              </div>

              {/* Manage link */}
              <div>
                <Link
                  href={`/customers/${customerId}`}
                  className="text-sm font-medium text-primary hover:underline"
                  onClick={(e) => e.stopPropagation()}
                >
                  Manage customer →
                </Link>
              </div>
            </div>
          </td>
        </tr>
      )}

      {/* Edit customer dialog */}
      <Dialog open={showEdit} onOpenChange={(o) => { if (!o) setShowEdit(false); }}>
        <DialogContent aria-describedby={undefined} onClick={(e) => e.stopPropagation()}>
          <DialogHeader><DialogTitle>Edit Customer</DialogTitle></DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="edit-cust-name">Company Name *</Label>
              <Input
                id="edit-cust-name"
                value={editForm.name}
                onChange={(e) => setEditForm((f) => ({ ...f, name: e.target.value }))}
                placeholder="Acme Corp"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="edit-cust-code">Short Code</Label>
              <Input
                id="edit-cust-code"
                value={editForm.code}
                onChange={(e) => setEditForm((f) => ({ ...f, code: e.target.value.toUpperCase() }))}
                placeholder="ACME"
                maxLength={20}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="edit-cust-email">Email</Label>
              <Input
                id="edit-cust-email"
                type="email"
                value={editForm.email}
                onChange={(e) => setEditForm((f) => ({ ...f, email: e.target.value }))}
                placeholder="it@example.com"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="edit-cust-phone">Phone</Label>
              <Input
                id="edit-cust-phone"
                value={editForm.phone}
                onChange={(e) => setEditForm((f) => ({ ...f, phone: e.target.value }))}
                placeholder="+1-555-0100"
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowEdit(false)}>Cancel</Button>
            <Button
              onClick={() => editMutation.mutate()}
              disabled={!editForm.name || editMutation.isPending}
            >
              {editMutation.isPending ? 'Saving…' : 'Save'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

function CustomersTab() {
  const { toast } = useToast();
  const qc = useQueryClient();
  const [search, setSearch] = useState('');
  const [showCreate, setShowCreate] = useState(false);
  const [form, setForm] = useState({ name: '', code: '', email: '', phone: '' });

  const { data, isLoading } = useQuery({
    queryKey: ['customers', search],
    queryFn: () => customersApi.list(search ? { search } : undefined).then((r) => r.data?.data),
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
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-4">
        <div className="relative flex-1 max-w-sm">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Search customers…"
            className="pl-9"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        <Button size="sm" onClick={() => setShowCreate(true)}>
          <Plus className="h-4 w-4 mr-2" />
          Add Customer
        </Button>
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
                  <td colSpan={5} className="text-center py-8 text-muted-foreground">No customers found.</td>
                </tr>
              ) : (
                customers.map((c) => (
                  <CustomerRow key={c.id as string} customer={c} />
                ))
              )}
            </tbody>
          </table>
        </div>
      )}

      <Dialog open={showCreate} onOpenChange={setShowCreate}>
        <DialogContent aria-describedby={undefined}>
          <DialogHeader><DialogTitle>Add Customer</DialogTitle></DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="cust-name">Company Name *</Label>
              <Input
                id="cust-name"
                value={form.name}
                onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                placeholder="Acme Corp"
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

// ─── Platform Admins Tab ──────────────────────────────────────────────────────

function PlatformAdminsTab({ myUserId }: { myUserId: string }) {
  const { toast } = useToast();
  const qc = useQueryClient();
  const [searchEmail, setSearchEmail] = useState('');
  const [foundUser, setFoundUser] = useState<Record<string, unknown> | null>(null);
  const [searching, setSearching] = useState(false);

  const { data: adminsData, isLoading } = useQuery({
    queryKey: ['platform-admins'],
    queryFn: () => usersApi.listPlatformAdmins().then((r) => r.data?.data ?? []),
  });
  const admins: Record<string, unknown>[] = Array.isArray(adminsData) ? adminsData : [];

  const promoteMutation = useMutation({
    mutationFn: (userId: string) => usersApi.setPlatformAdmin(userId, true),
    onSuccess: () => {
      toast({ title: 'Platform admin granted' });
      qc.invalidateQueries({ queryKey: ['platform-admins'] });
      setFoundUser(null);
      setSearchEmail('');
    },
    onError: (e: unknown) => {
      const msg = (e as { response?: { data?: { message?: string } } })?.response?.data?.message ?? 'Failed';
      toast({ title: 'Error', description: msg, variant: 'destructive' });
    },
  });

  const revokeMutation = useMutation({
    mutationFn: (userId: string) => usersApi.setPlatformAdmin(userId, false),
    onSuccess: () => {
      toast({ title: 'Platform admin revoked' });
      qc.invalidateQueries({ queryKey: ['platform-admins'] });
    },
    onError: (e: unknown) => {
      const msg = (e as { response?: { data?: { message?: string } } })?.response?.data?.message ?? 'Failed';
      toast({ title: 'Error', description: msg, variant: 'destructive' });
    },
  });

  async function handleSearch() {
    if (!searchEmail.trim()) return;
    setSearching(true);
    setFoundUser(null);
    try {
      const res = await usersApi.findByEmail(searchEmail.trim());
      const user = res.data?.data;
      if (!user) {
        toast({ title: 'User not found', variant: 'destructive' });
      } else {
        setFoundUser(user);
      }
    } catch {
      toast({ title: 'User not found', variant: 'destructive' });
    } finally {
      setSearching(false);
    }
  }

  return (
    <div className="space-y-6 max-w-2xl">
      <Card>
        <CardHeader>
          <CardTitle className="text-sm flex items-center gap-2">
            <ShieldCheck className="h-4 w-4 text-orange-600" />
            Current Platform Admins
          </CardTitle>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <p className="text-sm text-muted-foreground">Loading…</p>
          ) : admins.length === 0 ? (
            <p className="text-sm text-muted-foreground">No platform admins found.</p>
          ) : (
            <div className="space-y-2">
              {admins.map((u) => (
                <div key={u.id as string} className="flex items-center justify-between rounded-lg border px-3 py-2">
                  <div>
                    <p className="text-sm font-medium">{u.firstName as string} {u.lastName as string}</p>
                    <p className="text-xs text-muted-foreground">{u.email as string}</p>
                  </div>
                  {(u.id as string) !== myUserId ? (
                    <Button
                      variant="ghost"
                      size="sm"
                      className="text-destructive hover:text-destructive h-8 px-2"
                      onClick={() => revokeMutation.mutate(u.id as string)}
                      disabled={revokeMutation.isPending}
                    >
                      <Trash2 className="h-3.5 w-3.5 mr-1" />
                      Revoke
                    </Button>
                  ) : (
                    <span className="text-xs text-muted-foreground px-2">(you)</span>
                  )}
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-sm flex items-center gap-2">
            <Plus className="h-4 w-4" />
            Grant Platform Admin
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex gap-2">
            <Input
              placeholder="Search by email address…"
              value={searchEmail}
              onChange={(e) => { setSearchEmail(e.target.value); setFoundUser(null); }}
              onKeyDown={(e) => e.key === 'Enter' && handleSearch()}
              className="flex-1"
            />
            <Button variant="outline" onClick={handleSearch} disabled={searching}>
              <Search className="h-4 w-4" />
            </Button>
          </div>

          {foundUser && (
            <div className="flex items-center justify-between rounded-lg border bg-muted/30 px-3 py-2">
              <div>
                <p className="text-sm font-medium">{foundUser.firstName as string} {foundUser.lastName as string}</p>
                <p className="text-xs text-muted-foreground">{foundUser.email as string}</p>
                {!!foundUser.isPlatformAdmin && (
                  <p className="text-xs text-orange-600 font-medium mt-0.5">Already a platform admin</p>
                )}
              </div>
              {!foundUser.isPlatformAdmin as boolean && (
                <Button
                  size="sm"
                  onClick={() => promoteMutation.mutate(foundUser.id as string)}
                  disabled={promoteMutation.isPending}
                >
                  {promoteMutation.isPending ? 'Granting…' : 'Grant Admin'}
                </Button>
              )}
            </div>
          )}

          <p className="text-xs text-muted-foreground">
            Platform admins bypass all tenant-level permission checks and have full access to every tenant and admin API.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}

// ─── Main Page ────────────────────────────────────────────────────────────────

export default function AccessControlPage() {
  const [activeTab, setActiveTab] = useState('overview');

  const { data: me } = useQuery({
    queryKey: ['me'],
    queryFn: () => authApi.me().then((r) => r.data?.data),
  });

  if (!me) return <div className="p-6 text-sm text-muted-foreground">Loading…</div>;

  if (!me.isPlatformAdmin) {
    return (
      <div className="p-6">
        <p className="text-sm text-destructive">Access denied. Platform admin privileges required.</p>
      </div>
    );
  }

  const tenantId: string = me.tenantId ?? '';

  return (
    <div className="p-6 space-y-6 max-w-5xl">
      <PageHeader
        title="Access Control"
        description="Manage the permissions hierarchy — tenants, technicians, and customers"
      />

      <Tabs value={activeTab} onValueChange={setActiveTab}>
        <TabsList>
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="tenants" className="flex items-center gap-1.5">
            <Building2 className="h-3.5 w-3.5" /> Tenants
          </TabsTrigger>
          <TabsTrigger value="technicians" className="flex items-center gap-1.5">
            <Users className="h-3.5 w-3.5" /> Technicians
          </TabsTrigger>
          <TabsTrigger value="customers" className="flex items-center gap-1.5">
            <Shield className="h-3.5 w-3.5" /> Customers
          </TabsTrigger>
          <TabsTrigger value="platform-admins" className="flex items-center gap-1.5">
            <ShieldCheck className="h-3.5 w-3.5" /> Platform Admins
          </TabsTrigger>
        </TabsList>

        <TabsContent value="overview" className="mt-6">
          <OverviewTab me={me as Record<string, unknown>} />
        </TabsContent>

        <TabsContent value="tenants" className="mt-6">
          {activeTab === 'tenants' && <TenantsTab isPlatformAdmin={!!me.isPlatformAdmin} />}
        </TabsContent>

        <TabsContent value="technicians" className="mt-6">
          {activeTab === 'technicians' && (
            <TechniciansTab
              tenantId={tenantId}
              myUserId={me.sub as string}
              myRoleType={(me.roleType as string) ?? ''}
              isPlatformAdmin={!!me.isPlatformAdmin}
            />
          )}
        </TabsContent>

        <TabsContent value="customers" className="mt-6">
          {activeTab === 'customers' && <CustomersTab />}
        </TabsContent>

        <TabsContent value="platform-admins" className="mt-6">
          {activeTab === 'platform-admins' && <PlatformAdminsTab myUserId={me.sub as string} />}
        </TabsContent>
      </Tabs>
    </div>
  );
}
