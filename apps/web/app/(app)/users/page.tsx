'use client';

import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { authApi, usersApi } from '@/lib/api-client';
import { PageHeader } from '@/components/common/page-header';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem,
  DropdownMenuSeparator, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { useToast } from '@/hooks/use-toast';
import { Plus, MoreHorizontal, Pencil, KeyRound, ShieldOff, UserX, UserCheck, Shield } from 'lucide-react';
import { formatDate } from '@/lib/utils';

// Role priority — mirrors the API's ROLE_PRIORITY map
const ROLE_PRIORITY: Record<string, number> = {
  PLATFORM_ADMIN: 100, TENANT_OWNER: 90, TENANT_ADMIN: 80,
  BILLING_ADMIN: 60, TECHNICIAN: 50, READ_ONLY: 40, CUSTOMER: 10,
};

type Member = {
  id: string;
  userId?: string;
  user: { id: string; email: string; firstName: string; lastName: string; status: string; mfaMethods: unknown[] };
  role: { id: string; name: string; type: string } | null;
  createdAt: string;
};

type Role = { id: string; name: string; type: string };

// ─── Edit Profile Dialog ────────────────────────────────────────────────────

function EditUserDialog({
  member, onClose,
}: { member: Member; onClose: () => void }) {
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
      <DialogContent>
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

// ─── Reset Password Dialog ──────────────────────────────────────────────────

function ResetPasswordDialog({
  member, onClose,
}: { member: Member; onClose: () => void }) {
  const { toast } = useToast();
  const [password, setPassword]   = useState('');
  const [confirm,  setConfirm]    = useState('');

  const mutation = useMutation({
    mutationFn: () => usersApi.resetPassword(member.user.id, password),
    onSuccess: () => {
      toast({ title: 'Password reset successfully' });
      onClose();
    },
    onError: (e: unknown) => {
      const msg = (e as { response?: { data?: { message?: string } } })?.response?.data?.message ?? 'Reset failed';
      toast({ title: 'Error', description: msg, variant: 'destructive' });
    },
  });

  const mismatch = password !== confirm && confirm.length > 0;
  const valid = password.length >= 8 && password === confirm;

  return (
    <Dialog open onOpenChange={onClose}>
      <DialogContent>
        <DialogHeader><DialogTitle>Reset Password</DialogTitle></DialogHeader>
        <p className="text-sm text-muted-foreground">
          Set a new password for <span className="font-medium">{member.user.email}</span>.
        </p>
        <div className="space-y-3">
          <div className="space-y-1">
            <Label>New Password</Label>
            <Input type="password" value={password} onChange={e => setPassword(e.target.value)}
              placeholder="Minimum 8 characters" />
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

// ─── Change Role Dialog ─────────────────────────────────────────────────────

function ChangeRoleDialog({
  member, roles, myRoleType, onClose,
}: { member: Member; roles: Role[]; myRoleType: string; onClose: () => void }) {
  const { toast } = useToast();
  const qc = useQueryClient();
  const [roleId, setRoleId] = useState(member.role?.id ?? '');

  // Only show roles at strictly lower priority than the current user's role
  const myPriority = ROLE_PRIORITY[myRoleType] ?? 0;
  const assignableRoles = roles.filter(r => (ROLE_PRIORITY[r.type] ?? 0) < myPriority);

  const mutation = useMutation({
    mutationFn: () => usersApi.changeRole(member.user.id, roleId),
    onSuccess: () => {
      toast({ title: 'Role updated' });
      qc.invalidateQueries({ queryKey: ['members'] });
      onClose();
    },
    onError: (e: unknown) => {
      const msg = (e as { response?: { data?: { message?: string } } })?.response?.data?.message ?? 'Failed to change role';
      toast({ title: 'Error', description: msg, variant: 'destructive' });
    },
  });

  return (
    <Dialog open onOpenChange={onClose}>
      <DialogContent>
        <DialogHeader><DialogTitle>Change Role</DialogTitle></DialogHeader>
        <p className="text-sm text-muted-foreground">
          Change role for <span className="font-medium">{member.user.email}</span>.
        </p>
        <div className="space-y-1">
          <Label>Role</Label>
          <Select value={roleId} onValueChange={setRoleId}>
            <SelectTrigger><SelectValue placeholder="Select role" /></SelectTrigger>
            <SelectContent>
              {assignableRoles.map(r => (
                <SelectItem key={r.id} value={r.id}>{r.name}</SelectItem>
              ))}
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

// ─── Main Page ──────────────────────────────────────────────────────────────

export default function UsersPage() {
  const { toast } = useToast();
  const qc = useQueryClient();

  const [showInvite,    setShowInvite]    = useState(false);
  const [inviteEmail,   setInviteEmail]   = useState('');
  const [inviteRoleId,  setInviteRoleId]  = useState('');
  const [editingMember, setEditingMember] = useState<Member | null>(null);
  const [resetPwMember, setResetPwMember] = useState<Member | null>(null);
  const [changeRoleMbr, setChangeRoleMbr] = useState<Member | null>(null);

  const { data: me } = useQuery({
    queryKey: ['me'],
    queryFn: () => authApi.me().then((r) => r.data?.data),
  });

  const tenantId: string   = me?.tenantId    ?? '';
  const myUserId: string   = me?.sub         ?? '';
  const myRoleType: string = me?.roleType    ?? '';
  const isPlatformAdmin    = !!me?.isPlatformAdmin;
  // canWrite: any role with users:write permission. The backend enforces role hierarchy.
  const canWrite           = isPlatformAdmin ||
    ['PLATFORM_ADMIN','TENANT_OWNER','TENANT_ADMIN'].includes(myRoleType);

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
      const msg = (e as { response?: { data?: { message?: string } } })?.response?.data?.message ?? 'Failed to send invite';
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
    onSuccess: () => { toast({ title: 'MFA reset — user must re-enroll' }); qc.invalidateQueries({ queryKey: ['members'] }); },
    onError: (e: unknown) => {
      const msg = (e as { response?: { data?: { message?: string } } })?.response?.data?.message ?? 'Failed';
      toast({ title: 'Error', description: msg, variant: 'destructive' });
    },
  });

  const memberList: Member[]  = Array.isArray(members) ? (members as Member[]) : [];
  const roleList:   Role[]    = Array.isArray(roles)   ? (roles as Role[])     : [];
  const myPriority            = ROLE_PRIORITY[myRoleType] ?? 0;

  function canActOn(targetMember: Member): boolean {
    if (!canWrite) return false;
    if (targetMember.user.id === myUserId) return false; // can't act on self
    // Backend enforces role hierarchy; frontend just hides menu for same/higher roles
    // to avoid misleading the user, but backend is the real gatekeeper.
    if (!isPlatformAdmin && myRoleType) {
      const myP     = ROLE_PRIORITY[myRoleType] ?? 0;
      const targetP = ROLE_PRIORITY[targetMember.role?.type ?? ''] ?? 0;
      if (myP === 0) return true; // unknown role — let backend decide
      if (targetP >= myP) return false;
    }
    return true;
  }

  function statusBadge(status: string) {
    const cls: Record<string, string> = {
      ACTIVE:      'bg-green-100 text-green-700',
      SUSPENDED:   'bg-red-100 text-red-700',
      INVITED:     'bg-yellow-100 text-yellow-700',
      PENDING_MFA: 'bg-blue-100 text-blue-700',
      DELETED:     'bg-gray-100 text-gray-500',
    };
    return (
      <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${cls[status] ?? 'bg-muted text-muted-foreground'}`}>
        {status}
      </span>
    );
  }

  return (
    <div className="p-6 space-y-6">
      <PageHeader title="Users" description="Manage team members">
        {canWrite && (
          <Button size="sm" onClick={() => setShowInvite(true)}>
            <Plus className="h-4 w-4 mr-2" />
            Invite User
          </Button>
        )}
      </PageHeader>

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
                <tr>
                  <td colSpan={6} className="text-center py-8 text-muted-foreground">
                    No members yet.
                  </td>
                </tr>
              ) : (
                memberList.map((m) => {
                  const hasMfa   = (m.user.mfaMethods?.length ?? 0) > 0;
                  const isSelf   = m.user.id === myUserId;
                  const canAct   = canActOn(m);

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
                      <td className="px-4 py-3">
                        <Badge variant="secondary">{m.role?.name ?? '—'}</Badge>
                      </td>
                      <td className="px-4 py-3">
                        {hasMfa
                          ? <span className="text-green-600 text-xs font-medium">Enabled</span>
                          : <span className="text-muted-foreground text-xs">—</span>}
                      </td>
                      <td className="px-4 py-3">{statusBadge(m.user.status)}</td>
                      <td className="px-4 py-3 text-muted-foreground text-xs">
                        {formatDate(m.createdAt)}
                      </td>
                      <td className="px-4 py-3 text-right">
                        {canAct && (
                          <DropdownMenu>
                            <DropdownMenuTrigger asChild>
                              <Button variant="ghost" size="sm" className="h-7 w-7 p-0">
                                <MoreHorizontal className="h-4 w-4" />
                              </Button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="end">
                              <DropdownMenuItem onClick={() => setEditingMember(m)}>
                                <Pencil className="h-3.5 w-3.5 mr-2" />
                                Edit Profile
                              </DropdownMenuItem>
                              <DropdownMenuItem onClick={() => setResetPwMember(m)}>
                                <KeyRound className="h-3.5 w-3.5 mr-2" />
                                Reset Password
                              </DropdownMenuItem>
                              <DropdownMenuItem onClick={() => setChangeRoleMbr(m)}>
                                <Shield className="h-3.5 w-3.5 mr-2" />
                                Change Role
                              </DropdownMenuItem>
                              {hasMfa && (
                                <DropdownMenuItem
                                  onClick={() => resetMfaMutation.mutate(m.user.id)}
                                  className="text-orange-600 focus:text-orange-600">
                                  <ShieldOff className="h-3.5 w-3.5 mr-2" />
                                  Reset MFA
                                </DropdownMenuItem>
                              )}
                              <DropdownMenuSeparator />
                              {m.user.status === 'SUSPENDED' ? (
                                <DropdownMenuItem onClick={() => activateMutation.mutate(m.user.id)}>
                                  <UserCheck className="h-3.5 w-3.5 mr-2" />
                                  Activate
                                </DropdownMenuItem>
                              ) : m.user.status !== 'DELETED' && (
                                <DropdownMenuItem
                                  onClick={() => suspendMutation.mutate(m.user.id)}
                                  className="text-destructive focus:text-destructive">
                                  <UserX className="h-3.5 w-3.5 mr-2" />
                                  Suspend
                                </DropdownMenuItem>
                              )}
                              <DropdownMenuItem
                                onClick={() => {
                                  if (confirm(`Remove ${m.user.email} from this tenant?`)) {
                                    removeMutation.mutate(m.user.id);
                                  }
                                }}
                                className="text-destructive focus:text-destructive">
                                <UserX className="h-3.5 w-3.5 mr-2" />
                                Remove from Tenant
                              </DropdownMenuItem>
                            </DropdownMenuContent>
                          </DropdownMenu>
                        )}
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      )}

      {/* Invite Dialog */}
      <Dialog open={showInvite} onOpenChange={setShowInvite}>
        <DialogContent>
          <DialogHeader><DialogTitle>Invite Team Member</DialogTitle></DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="invite-email">Email *</Label>
              <Input id="invite-email" type="email" value={inviteEmail}
                onChange={e => setInviteEmail(e.target.value)}
                placeholder="colleague@example.com" />
            </div>
            <div className="space-y-2">
              <Label htmlFor="invite-role">Role *</Label>
              <Select value={inviteRoleId} onValueChange={setInviteRoleId}>
                <SelectTrigger id="invite-role"><SelectValue placeholder="Select role" /></SelectTrigger>
                <SelectContent>
                  {roleList
                    .filter(r => isPlatformAdmin || (ROLE_PRIORITY[r.type] ?? 0) < myPriority)
                    .map(r => <SelectItem key={r.id} value={r.id}>{r.name}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowInvite(false)}>Cancel</Button>
            <Button
              onClick={() => inviteMutation.mutate()}
              disabled={!inviteEmail || !inviteRoleId || inviteMutation.isPending}>
              {inviteMutation.isPending ? 'Sending…' : 'Send Invite'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Modals */}
      {editingMember  && <EditUserDialog    member={editingMember}  onClose={() => setEditingMember(null)} />}
      {resetPwMember  && <ResetPasswordDialog member={resetPwMember} onClose={() => setResetPwMember(null)} />}
      {changeRoleMbr  && (
        <ChangeRoleDialog
          member={changeRoleMbr}
          roles={roleList}
          myRoleType={myRoleType}
          onClose={() => setChangeRoleMbr(null)}
        />
      )}
    </div>
  );
}
