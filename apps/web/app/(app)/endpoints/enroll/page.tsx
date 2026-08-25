'use client';

import { useState } from 'react';
import { useQuery, useMutation } from '@tanstack/react-query';
import { businessesApi, enrollmentApi, usersApi } from '@/lib/api-client';
import { PageHeader } from '@/components/common/page-header';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useToast } from '@/hooks/use-toast';
import { Copy, Check } from 'lucide-react';

type Business = { id: string; name: string };
type Member = {
  userId: string;
  user: { id: string; email: string; firstName: string; lastName: string };
};

export default function AddComputerPage() {
  const { toast } = useToast();

  const [businessId, setBusinessId] = useState('');
  const [accessMode, setAccessMode] = useState<'ASSIGNED_USERS' | 'COMPANY_WIDE'>('ASSIGNED_USERS');
  const [assignedUserIds, setAssignedUserIds] = useState<string[]>([]);
  const [platform, setPlatform] = useState<'windows' | 'linux' | 'macos'>('windows');
  const [generated, setGenerated] = useState<{ token: string; url: string; command: string } | null>(null);
  const [copied, setCopied] = useState(false);

  const { data: businessesData } = useQuery({
    queryKey: ['businesses', ''],
    queryFn: () => businessesApi.list().then((r) => {
      const body = r.data as unknown;
      if (body && typeof body === 'object' && Array.isArray((body as { data?: unknown }).data)) {
        return (body as { data: Business[] }).data;
      }
      return [];
    }),
  });
  const businesses: Business[] = businessesData ?? [];

  // Only people in the chosen business can be pre-assigned to the computer;
  // the server rejects anyone else at token-mint time regardless.
  const { data: membersData } = useQuery({
    queryKey: ['members-for-token', businessId],
    queryFn: () => usersApi.list(businessId || undefined).then((r) => {
      const body = r.data as unknown;
      if (Array.isArray(body)) return body;
      if (body && typeof body === 'object' && Array.isArray((body as { data?: unknown }).data)) {
        return (body as { data: Member[] }).data;
      }
      return [];
    }),
  });
  const members: Member[] = membersData ?? [];

  const createToken = useMutation({
    mutationFn: () =>
      enrollmentApi.createToken({
        businessId: businessId || undefined,
        accessMode,
        assignedUserIds: accessMode === 'ASSIGNED_USERS' ? assignedUserIds : [],
        description: `Managed ${platform} install (${accessMode === 'COMPANY_WIDE' ? 'company-wide' : assignedUserIds.length + ' user(s)'})`,
      }),
    onSuccess: (res) => {
      const token: string = res.data?.data?.token;
      const base = typeof window !== 'undefined' ? window.location.origin : '';
      const paths: Record<string, { path: string; cmd: (u: string) => string; label: string }> = {
        windows: { path: `/api/v1/public/install/win/${token}`,   cmd: (u) => `irm ${u} | iex`,              label: 'PowerShell (Administrator)' },
        linux:   { path: `/api/v1/public/install/linux/${token}`, cmd: (u) => `curl -fsSL ${u} | sudo bash`, label: 'Bash (root)' },
        macos:   { path: `/api/v1/public/install/mac/${token}`,   cmd: (u) => `curl -fsSL ${u} | sudo bash`, label: 'Bash (sudo)' },
      };
      const info = paths[platform];
      const url = `${base}${info.path}`;
      setGenerated({ token, url, command: info.cmd(url) });
    },
    onError: (err: unknown) => {
      const msg = (err as { response?: { data?: { message?: string } } })?.response?.data?.message ?? 'Failed to create installer';
      toast({ title: 'Error', description: msg, variant: 'destructive' });
    },
  });

  function copy(text: string) {
    void navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }

  function toggleUser(userId: string) {
    setAssignedUserIds((cur) =>
      cur.includes(userId) ? cur.filter((u) => u !== userId) : [...cur, userId],
    );
  }

  const canGenerate =
    (accessMode === 'COMPANY_WIDE' || assignedUserIds.length > 0) &&
    !!businessId;

  return (
    <div className="p-6 space-y-6 max-w-3xl">
      <PageHeader
        title="Downloads"
        description="Generate a one-time Managed Device Installer. Any computer that runs it is enrolled as a permanent managed computer belonging to the business you choose here."
      />

      <Card>
        <CardHeader>
          <CardTitle>1. Business</CardTitle>
          <CardDescription>
            Which business does this computer belong to? The binding is fixed when the link is
            created — the machine that runs it cannot choose a different business.
          </CardDescription>
        </CardHeader>
        <CardContent className="max-w-md">
          <Label>Business</Label>
          <Select value={businessId} onValueChange={setBusinessId}>
            <SelectTrigger><SelectValue placeholder="Select a business…" /></SelectTrigger>
            <SelectContent>
              {businesses.map((b) => (
                <SelectItem key={b.id} value={b.id}>{b.name}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          {businesses.length === 0 && (
            <p className="mt-2 text-xs text-muted-foreground">
              No businesses yet. Create one under <strong>Businesses</strong>.
            </p>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>2. Access</CardTitle>
          <CardDescription>Who will be able to connect to this computer once it's enrolled?</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <label className="flex items-start gap-2 cursor-pointer">
              <input
                type="radio"
                name="am"
                value="ASSIGNED_USERS"
                checked={accessMode === 'ASSIGNED_USERS'}
                onChange={() => setAccessMode('ASSIGNED_USERS')}
                className="mt-1"
              />
              <span className="text-sm">
                <strong>Specific users</strong>
                <br />
                <span className="text-xs text-muted-foreground">Only the users you pick below will see this computer under "My Computers".</span>
              </span>
            </label>
            <label className="flex items-start gap-2 cursor-pointer">
              <input
                type="radio"
                name="am"
                value="COMPANY_WIDE"
                checked={accessMode === 'COMPANY_WIDE'}
                onChange={() => setAccessMode('COMPANY_WIDE')}
                className="mt-1"
              />
              <span className="text-sm">
                <strong>Company-wide</strong>
                <br />
                <span className="text-xs text-muted-foreground">Every active user in this company can connect (still subject to GeoIP / MFA).</span>
              </span>
            </label>
          </div>

          {accessMode === 'ASSIGNED_USERS' && (
            <div className="border rounded-md p-3 max-h-64 overflow-y-auto space-y-1">
              {members.length === 0 && <p className="text-sm text-muted-foreground">No users in this business yet.</p>}
              {members.map((m) => (
                <label key={m.userId} className="flex items-center gap-2 py-1 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={assignedUserIds.includes(m.userId)}
                    onChange={() => toggleUser(m.userId)}
                  />
                  <span className="text-sm">
                    {m.user.firstName} {m.user.lastName}
                    <span className="text-muted-foreground ml-2">{m.user.email}</span>
                  </span>
                </label>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>3. Platform</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex gap-6">
            {(['windows', 'linux', 'macos'] as const).map((p) => (
              <label key={p} className="flex items-center gap-2 cursor-pointer">
                <input type="radio" name="platform" checked={platform === p} onChange={() => setPlatform(p)} />
                <span className="capitalize text-sm">{p}</span>
              </label>
            ))}
          </div>
        </CardContent>
      </Card>

      <Button disabled={!canGenerate || createToken.isPending} onClick={() => createToken.mutate()}>
        {createToken.isPending ? 'Generating…' : 'Generate Installer'}
      </Button>

      {generated && (
        <Card className="border-green-500/40 bg-green-500/5">
          <CardHeader>
            <CardTitle>Installer command</CardTitle>
            <CardDescription>
              Run this once on the target computer as Administrator / root. The token expires in 24 hours and is single-use.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="bg-background border rounded p-3 font-mono text-sm break-all flex items-start gap-2">
              <span className="flex-1">{generated.command}</span>
              <Button size="sm" variant="ghost" onClick={() => copy(generated.command)}>
                {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">
              Once the installer runs the computer will appear online in this dashboard automatically and the users you selected will see it under <strong>My Computers</strong>.
            </p>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
