'use client';

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Check, KeyRound, Loader2, MoreHorizontal, Plus, Search, ShieldOff,
  Trash2, UserCheck, UserCog, UserX,
} from 'lucide-react';
import { businessesApi, usersApi } from '@/lib/api-client';
import { PageHeader } from '@/components/common/page-header';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem,
  DropdownMenuSeparator, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { useToast } from '@/hooks/use-toast';
import { usePermissions } from '@/lib/auth';
import { cn, formatDate } from '@/lib/utils';

interface Membership {
  id: string;
  capabilities: string[];
  isActive: boolean;
  accessLevel: 'Platform Admin' | 'Business Owner' | 'Business User';
  createdAt: string;
  user: {
    id: string; email: string; firstName: string; lastName: string;
    status: string; isPlatformAdmin: boolean; jobTitle: string | null;
    mfaMethods?: { id: string }[];
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
  return `${u.firstName ?? ''} ${u.lastName ?? ''}`.trim() || u.email;
}

export default function UsersPage() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const { isPlatformAdmin, isBusinessOwner, businessId, businessName } = usePermissions();

  const [search, setSearch] = useState('');
  const [businessFilter, setBusinessFilter] = useState<string>('all');
  const [editing, setEditing] = useState<Membership | null>(null);
  const [adding, setAdding] = useState(false);
  const [resetting, setResetting] = useState<Membership | null>(null);
  const [newPassword, setNewPassword] = useState('');
  const [inviteToken, setInviteToken] = useState<string | null>(null);
  const [invite, setInvite] = useState({
    email: '', firstName: '', lastName: '',
    businessId: '', level: 'BUSINESS_USER' as 'BUSINESS_OWNER' | 'BUSINESS_USER',
  });

  const scopeId = isPlatformAdmin
    ? (businessFilter === 'all' ? undefined : businessFilter)
    : businessId ?? undefined;

  const { data: memberships = [], isLoading } = useQuery<Membership[]>({
    queryKey: ['users', scopeId ?? 'all'],
    queryFn: () => usersApi.list(scopeId).then((r) => r.data?.data ?? []),
  });

  const { data: businesses = [] } = useQuery<{ id: string; name: string }[]>({
    queryKey: ['businesses', ''],
    queryFn: () => businessesApi.list().then((r) => r.data?.data ?? []),
  });

  const { data: catalog = [] } = useQuery<CapabilityGroup[]>({
    queryKey: ['capability-catalog'],
    queryFn: () => businessesApi.capabilityCatalog().then((r) => r.data?.data ?? []),
    staleTime: Infinity,
  });

  const invalidate = () => qc.invalidateQueries({ queryKey: ['users'] });
  const onError = (title: string) => (e: { response?: { data?: { message?: string } } }) =>
    toast({ title, description: e.response?.data?.message, variant: 'destructive' });

  const addUser = useMutation({
    mutationFn: () => businessesApi.addUser(invite.businessId, {
      email: invite.email.trim(),
      firstName: invite.firstName.trim() || undefined,
      lastName: invite.lastName.trim() || undefined,
      level: invite.level,
    }),
    onSuccess: (res) => {
      setInviteToken(res.data?.data?.inviteToken ?? null);
      invalidate();
      toast({ title: 'User added' });
    },
    onError: onError('Could not add user'),
  });

  const setActive = useMutation({
    mutationFn: ({ userId, active }: { userId: string; active: boolean }) =>
      active ? usersApi.activate(userId) : usersApi.suspend(userId),
    onSuccess: () => { invalidate(); toast({ title: 'Updated' }); },
    onError: onError('Could not update'),
  });

  const setLevel = useMutation({
    mutationFn: ({ userId, level }: { userId: string; level: 'BUSINESS_OWNER' | 'BUSINESS_USER' }) =>
      usersApi.setLevel(userId, level),
    onSuccess: () => { invalidate(); toast({ title: 'Access level changed' }); },
    onError: onError('Could not change access level'),
  });

  const resetPassword = useMutation({
    mutationFn: () => usersApi.resetPassword(resetting!.user.id, newPassword),
    onSuccess: () => {
      toast({ title: 'Password reset' });
      setResetting(null); setNewPassword('');
    },
    onError: onError('Could not reset password'),
  });

  const resetMfa = useMutation({
    mutationFn: (userId: string) => usersApi.resetMfa(userId),
    onSuccess: () => { invalidate(); toast({ title: 'MFA reset — they will re-enrol at next sign-in' }); },
    onError: onError('Could not reset MFA'),
  });

  const remove = useMutation({
    mutationFn: (userId: string) => usersApi.remove(userId),
    onSuccess: () => { invalidate(); toast({ title: 'User removed' }); },
    onError: onError('Could not remove user'),
  });

  const filtered = memberships.filter((m) => {
    if (!search.trim()) return true;
    const q = search.toLowerCase();
    return m.user.email.toLowerCase().includes(q)
      || fullName(m.user).toLowerCase().includes(q)
      || (m.business?.name ?? '').toLowerCase().includes(q);
  });

  const canManage = isBusinessOwner;

  return (
    <div className="p-6 space-y-6">
      <PageHeader
        title="Users"
        description={isPlatformAdmin
          ? 'Everyone across every business.'
          : `People in ${businessName ?? 'your business'}.`}
      >
        {canManage && (
          <Button
            size="sm"
            disabled={businesses.length === 0}
            onClick={() => {
              setInviteToken(null);
              setInvite({
                email: '', firstName: '', lastName: '',
                businessId: scopeId ?? businesses[0]?.id ?? '',
                level: 'BUSINESS_USER',
              });
              setAdding(true);
            }}
          >
            <Plus className="h-4 w-4 mr-2" /> Add person
          </Button>
        )}
      </PageHeader>

      <div className="flex flex-wrap items-center gap-2">
        <div className="relative flex-1 min-w-[220px] max-w-sm">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Search people…"
            className="pl-9"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        {isPlatformAdmin && (
          <Select value={businessFilter} onValueChange={setBusinessFilter}>
            <SelectTrigger className="w-56"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All businesses</SelectItem>
              {businesses.map((b) => <SelectItem key={b.id} value={b.id}>{b.name}</SelectItem>)}
            </SelectContent>
          </Select>
        )}
      </div>

      <Card>
        <CardContent className="p-0">
          {isLoading ? (
            <div className="p-8 text-center text-sm text-muted-foreground">Loading…</div>
          ) : filtered.length === 0 ? (
            <div className="p-8 text-center text-sm text-muted-foreground">No people found.</div>
          ) : (
            <table className="w-full text-sm">
              <thead className="border-b bg-muted/50 text-left text-xs uppercase tracking-wide text-muted-foreground">
                <tr>
                  <th className="px-4 py-3 font-medium">Person</th>
                  {isPlatformAdmin && <th className="px-4 py-3 font-medium">Business</th>}
                  <th className="px-4 py-3 font-medium">Level</th>
                  <th className="px-4 py-3 font-medium">Permissions</th>
                  <th className="px-4 py-3 font-medium">MFA</th>
                  <th className="px-4 py-3 font-medium">Status</th>
                  <th className="px-4 py-3 font-medium">Added</th>
                  <th className="px-4 py-3" />
                </tr>
              </thead>
              <tbody className="divide-y">
                {filtered.map((m) => (
                  <tr key={m.id} className="hover:bg-muted/30">
                    <td className="px-4 py-3">
                      <div className="font-medium">{fullName(m.user)}</div>
                      <div className="text-xs text-muted-foreground">{m.user.email}</div>
                    </td>
                    {isPlatformAdmin && (
                      <td className="px-4 py-3 text-muted-foreground">
                        {m.business?.name ?? '—'}
                      </td>
                    )}
                    <td className="px-4 py-3">
                      <Badge className={LEVEL_STYLE[m.accessLevel]}>{m.accessLevel}</Badge>
                    </td>
                    <td className="px-4 py-3 text-xs text-muted-foreground">
                      {m.accessLevel === 'Business User'
                        ? `${m.capabilities.length} granted`
                        : 'All'}
                    </td>
                    <td className="px-4 py-3">
                      {m.user.mfaMethods && m.user.mfaMethods.length > 0
                        ? <Badge variant="default">On</Badge>
                        : <Badge variant="secondary">Off</Badge>}
                    </td>
                    <td className="px-4 py-3">
                      <Badge variant={m.user.status === 'ACTIVE' ? 'default' : 'secondary'}>
                        {m.user.status}
                      </Badge>
                    </td>
                    <td className="px-4 py-3 text-xs text-muted-foreground">
                      {formatDate(m.createdAt)}
                    </td>
                    <td className="px-4 py-3 text-right">
                      {canManage && (
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <Button variant="ghost" size="sm" className="h-7 w-7 p-0">
                              <MoreHorizontal className="h-4 w-4" />
                            </Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end" className="w-56">
                            {m.accessLevel === 'Business User' && (
                              <DropdownMenuItem onClick={() => setEditing(m)}>
                                <UserCog className="mr-2 h-4 w-4" /> Permissions
                              </DropdownMenuItem>
                            )}
                            {isPlatformAdmin && !m.user.isPlatformAdmin && (
                              <DropdownMenuItem
                                onClick={() => setLevel.mutate({
                                  userId: m.user.id,
                                  level: m.accessLevel === 'Business Owner' ? 'BUSINESS_USER' : 'BUSINESS_OWNER',
                                })}
                              >
                                <UserCog className="mr-2 h-4 w-4" />
                                {m.accessLevel === 'Business Owner' ? 'Make Business User' : 'Make Business Owner'}
                              </DropdownMenuItem>
                            )}
                            <DropdownMenuSeparator />
                            <DropdownMenuItem onClick={() => { setResetting(m); setNewPassword(''); }}>
                              <KeyRound className="mr-2 h-4 w-4" /> Reset password
                            </DropdownMenuItem>
                            <DropdownMenuItem onClick={() => resetMfa.mutate(m.user.id)}>
                              <ShieldOff className="mr-2 h-4 w-4" /> Reset MFA
                            </DropdownMenuItem>
                            <DropdownMenuSeparator />
                            {m.user.status === 'ACTIVE' ? (
                              <DropdownMenuItem onClick={() => setActive.mutate({ userId: m.user.id, active: false })}>
                                <UserX className="mr-2 h-4 w-4" /> Disable access
                              </DropdownMenuItem>
                            ) : (
                              <DropdownMenuItem onClick={() => setActive.mutate({ userId: m.user.id, active: true })}>
                                <UserCheck className="mr-2 h-4 w-4" /> Restore access
                              </DropdownMenuItem>
                            )}
                            <DropdownMenuItem
                              className="text-destructive"
                              onClick={() => {
                                if (confirm(`Remove ${fullName(m.user)}?`)) remove.mutate(m.user.id);
                              }}
                            >
                              <Trash2 className="mr-2 h-4 w-4" /> Remove
                            </DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>

      {/* Permissions */}
      <PermissionsDialog
        membership={editing}
        catalog={catalog}
        open={!!editing}
        onClose={() => setEditing(null)}
        onSaved={invalidate}
      />

      {/* Reset password */}
      <Dialog open={!!resetting} onOpenChange={(o) => !o && setResetting(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Reset password</DialogTitle>
            <DialogDescription>
              {resetting ? `Set a new password for ${fullName(resetting.user)}.` : ''}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor="np">New password</Label>
            <Input
              id="np"
              type="text"
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              placeholder="At least 12 characters"
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setResetting(null)}>Cancel</Button>
            <Button
              disabled={newPassword.length < 12 || resetPassword.isPending}
              onClick={() => resetPassword.mutate()}
            >
              {resetPassword.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Reset
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Add person */}
      <Dialog open={adding} onOpenChange={(o) => { if (!o) { setAdding(false); setInviteToken(null); } }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Add a person</DialogTitle>
            <DialogDescription>
              Business Users start with <em>View computers</em> and <em>Remote connect</em>. Adjust
              their permissions right afterwards.
            </DialogDescription>
          </DialogHeader>

          {inviteToken ? (
            <div className="space-y-3">
              <p className="text-sm text-muted-foreground">
                Send this one-time setup link. It expires in 7 days.
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
                <Label htmlFor="ne">Email</Label>
                <Input id="ne" type="email" value={invite.email}
                  onChange={(e) => setInvite({ ...invite, email: e.target.value })} />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <Label htmlFor="nf">First name</Label>
                  <Input id="nf" value={invite.firstName}
                    onChange={(e) => setInvite({ ...invite, firstName: e.target.value })} />
                </div>
                <div>
                  <Label htmlFor="nl">Last name</Label>
                  <Input id="nl" value={invite.lastName}
                    onChange={(e) => setInvite({ ...invite, lastName: e.target.value })} />
                </div>
              </div>
              {isPlatformAdmin && (
                <div>
                  <Label>Business</Label>
                  <Select value={invite.businessId} onValueChange={(v) => setInvite({ ...invite, businessId: v })}>
                    <SelectTrigger><SelectValue placeholder="Choose a business" /></SelectTrigger>
                    <SelectContent>
                      {businesses.map((b) => <SelectItem key={b.id} value={b.id}>{b.name}</SelectItem>)}
                    </SelectContent>
                  </Select>
                </div>
              )}
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
                {!isPlatformAdmin && (
                  <p className="mt-1 text-xs text-muted-foreground">
                    Only a Platform Admin can create a Business Owner.
                  </p>
                )}
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

// ─── Permission editor ───────────────────────────────────────────────────────

function PermissionsDialog({
  membership, catalog, open, onClose, onSaved,
}: {
  membership: Membership | null;
  catalog: CapabilityGroup[];
  open: boolean;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { toast } = useToast();
  const [selected, setSelected] = useState<string[]>([]);
  const [seeded, setSeeded] = useState<string | null>(null);

  if (membership && seeded !== membership.id) {
    setSelected(membership.capabilities ?? []);
    setSeeded(membership.id);
  }

  const save = useMutation({
    mutationFn: () => usersApi.setCapabilities(membership!.user.id, selected),
    onSuccess: () => { toast({ title: 'Permissions updated' }); onSaved(); onClose(); },
    onError: (e: { response?: { data?: { message?: string } } }) =>
      toast({ title: 'Could not save', description: e.response?.data?.message, variant: 'destructive' }),
  });

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

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button disabled={save.isPending} onClick={() => save.mutate()}>
            {save.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            Save permissions
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
