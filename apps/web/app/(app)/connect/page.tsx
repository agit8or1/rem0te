'use client';

import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { endpointsApi, sessionsApi, customersApi } from '@/lib/api-client';
import { PageHeader } from '@/components/common/page-header';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useToast } from '@/hooks/use-toast';
import {
  MonitorPlay, Wifi, UserPlus, Monitor, Search, ExternalLink, Loader2,
  ChevronDown, Clock, Infinity, KeyRound, X,
} from 'lucide-react';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { formatDate, cn } from '@/lib/utils';

// ─── My Devices Tab ───────────────────────────────────────────────────────────

function MyDevicesTab() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [search, setSearch] = useState('');
  const [connecting, setConnecting] = useState<string | null>(null);
  const [passwordModal, setPasswordModal] = useState<{ id: string; name: string } | null>(null);
  const [passwordInput, setPasswordInput] = useState('');
  const [savingPassword, setSavingPassword] = useState(false);

  const { data, isLoading, refetch } = useQuery({
    queryKey: ['endpoints-devices', search],
    queryFn: () => endpointsApi.list(search ? { search } : undefined).then((r) => r.data?.data),
    refetchInterval: 15_000,
  });

  const allEndpoints: Record<string, unknown>[] = data?.endpoints ?? [];
  const endpoints = [...allEndpoints].sort((a, b) => {
    if ((a.isOnline as boolean) && !(b.isOnline as boolean)) return -1;
    if (!(a.isOnline as boolean) && (b.isOnline as boolean)) return 1;
    return ((a.name as string) ?? '').localeCompare((b.name as string) ?? '');
  });

  async function handleConnect(ep: Record<string, unknown>, oneTime = false) {
    const rustdeskId = (ep.rustdeskNode as Record<string, unknown> | undefined)?.rustdeskId as string | undefined;
    if (!rustdeskId) {
      toast({ title: 'No RustDesk ID', description: 'This device has no RustDesk ID linked yet.', variant: 'destructive' });
      return;
    }
    setConnecting(ep.id as string);
    try {
      await sessionsApi.create({ endpointId: ep.id as string });
      queryClient.invalidateQueries({ queryKey: ['sessions'] });
      if (oneTime) {
        endpointsApi.archive(ep.id as string).catch(() => null);
      }
      // If endpoint has a stored password, copy it to clipboard before launching
      const hasPassword = !!(ep.rustdeskNode as Record<string, unknown> | undefined)?.permanentPassword;
      if (hasPassword) {
        try {
          const res = await endpointsApi.getPassword(ep.id as string);
          const pw: string | null = res.data?.data?.password;
          if (pw) {
            await navigator.clipboard.writeText(pw);
            toast({ title: 'Password copied', description: 'Paste it in RustDesk when prompted.' });
          }
        } catch { /* clipboard may not be available */ }
      }
      window.location.href = `rustdesk://connection/new/${rustdeskId}`;
    } catch {
      toast({ title: 'Failed to start session', variant: 'destructive' });
    } finally {
      setConnecting(null);
    }
  }

  async function savePassword() {
    if (!passwordModal) return;
    setSavingPassword(true);
    try {
      await endpointsApi.setPassword(passwordModal.id, passwordInput || null);
      toast({ title: passwordInput ? 'Password saved' : 'Password removed' });
      queryClient.invalidateQueries({ queryKey: ['endpoints-devices'] });
      setPasswordModal(null);
      setPasswordInput('');
    } catch {
      toast({ title: 'Failed to save password', variant: 'destructive' });
    } finally {
      setSavingPassword(false);
    }
  }

  async function openPasswordModal(ep: Record<string, unknown>) {
    setPasswordInput('');
    setPasswordModal({ id: ep.id as string, name: ep.name as string });
    // Pre-fill with existing password if set
    try {
      const res = await endpointsApi.getPassword(ep.id as string);
      if (res.data?.data?.password) setPasswordInput(res.data.data.password);
    } catch { /* ignore */ }
  }

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-16 gap-2 text-muted-foreground">
        <Loader2 className="h-5 w-5 animate-spin" />
        <span className="text-sm">Loading devices…</span>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <div className="relative flex-1 max-w-sm">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Search devices…"
            className="pl-9"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        <Button variant="ghost" size="sm" onClick={() => refetch()} className="text-muted-foreground">
          Refresh
        </Button>
      </div>

      {endpoints.length === 0 ? (
        <div className="rounded-lg border border-dashed bg-muted/30 p-12 text-center space-y-3">
          <Monitor className="h-10 w-10 mx-auto text-muted-foreground/50" />
          <p className="font-medium">No devices added yet</p>
          <p className="text-sm text-muted-foreground">
            Use the <strong>Add Device</strong> tab to add a permanent connection.
          </p>
        </div>
      ) : (
        <div className="rounded-md border bg-background overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b bg-muted/50">
                <th className="text-left px-4 py-3 font-medium">Device</th>
                <th className="text-left px-4 py-3 font-medium">Customer</th>
                <th className="text-left px-4 py-3 font-medium">Platform</th>
                <th className="text-left px-4 py-3 font-medium">Last Seen</th>
                <th className="text-left px-4 py-3 font-medium">Status</th>
                <th className="px-4 py-3" />
              </tr>
            </thead>
            <tbody className="divide-y">
              {endpoints.map((ep) => {
                const isOnline = ep.isOnline as boolean;
                const rustdeskNode = ep.rustdeskNode as Record<string, unknown> | undefined;
                const rustdeskId = rustdeskNode?.rustdeskId as string | undefined;
                const hasPassword = !!rustdeskNode?.permanentPassword;
                const customer = ep.customer as { name?: string } | null;
                const isConnecting = connecting === (ep.id as string);
                return (
                  <tr key={ep.id as string} className={cn('hover:bg-muted/30', !isOnline && 'opacity-60')}>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-1.5">
                        <Link href={`/endpoints/${ep.id as string}`} className="font-medium hover:underline">
                          {ep.name as string}
                        </Link>
                        {hasPassword && (
                          <KeyRound className="h-3 w-3 text-muted-foreground" />
                        )}
                      </div>
                      {ep.hostname ? (
                        <p className="text-xs text-muted-foreground">{ep.hostname as string}</p>
                      ) : null}
                    </td>
                    <td className="px-4 py-3 text-muted-foreground">{customer?.name ?? '—'}</td>
                    <td className="px-4 py-3">
                      {ep.platform
                        ? <Badge variant="secondary" className="text-xs">{ep.platform as string}</Badge>
                        : <span className="text-muted-foreground">—</span>}
                    </td>
                    <td className="px-4 py-3 text-muted-foreground text-xs">
                      {formatDate(ep.lastSeenAt as string)}
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-1.5">
                        <span className={cn('h-2 w-2 rounded-full', isOnline ? 'bg-green-500' : 'bg-muted-foreground/40')} />
                        <span className="text-xs text-muted-foreground">{isOnline ? 'Online' : 'Offline'}</span>
                      </div>
                    </td>
                    <td className="px-4 py-3 text-right">
                      {rustdeskId ? (
                        <div className="flex items-center justify-end">
                          <Button
                            size="sm"
                            onClick={() => handleConnect(ep)}
                            disabled={isConnecting}
                            variant={isOnline ? 'default' : 'secondary'}
                            className="rounded-r-none border-r-0"
                          >
                            {isConnecting
                              ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
                              : <><MonitorPlay className="h-3.5 w-3.5 mr-1.5" />Connect</>}
                          </Button>
                          <DropdownMenu>
                            <DropdownMenuTrigger asChild>
                              <Button
                                size="sm"
                                variant={isOnline ? 'default' : 'secondary'}
                                className="rounded-l-none px-2"
                                disabled={isConnecting}
                              >
                                <ChevronDown className="h-3.5 w-3.5" />
                              </Button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="end">
                              <DropdownMenuItem onClick={() => handleConnect(ep)}>
                                <Infinity className="h-3.5 w-3.5 mr-2" />
                                Connect (permanent)
                              </DropdownMenuItem>
                              <DropdownMenuItem onClick={() => handleConnect(ep, true)}>
                                <Clock className="h-3.5 w-3.5 mr-2" />
                                Connect once (remove after)
                              </DropdownMenuItem>
                              <DropdownMenuItem onClick={() => openPasswordModal(ep)}>
                                <KeyRound className="h-3.5 w-3.5 mr-2" />
                                {hasPassword ? 'Change password' : 'Set password'}
                              </DropdownMenuItem>
                            </DropdownMenuContent>
                          </DropdownMenu>
                        </div>
                      ) : (
                        <span className="text-xs text-muted-foreground">No ID</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* Password modal */}
      {passwordModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
          <div className="bg-background rounded-lg border shadow-xl w-full max-w-sm p-6 space-y-4">
            <div className="flex items-center justify-between">
              <h3 className="font-semibold text-sm flex items-center gap-2">
                <KeyRound className="h-4 w-4" />
                RustDesk Password — {passwordModal.name}
              </h3>
              <button onClick={() => setPasswordModal(null)} className="text-muted-foreground hover:text-foreground">
                <X className="h-4 w-4" />
              </button>
            </div>
            <p className="text-xs text-muted-foreground">
              Store the permanent password set on this device in RustDesk. It will be copied to your clipboard automatically when you connect.
            </p>
            <Input
              type="password"
              placeholder="Enter RustDesk password…"
              value={passwordInput}
              onChange={(e) => setPasswordInput(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && savePassword()}
              autoFocus
            />
            <div className="flex gap-2 justify-end">
              {passwordInput === '' && (
                <Button variant="destructive" size="sm" onClick={() => { setPasswordInput(''); savePassword(); }} disabled={savingPassword}>
                  Remove password
                </Button>
              )}
              <Button variant="ghost" size="sm" onClick={() => setPasswordModal(null)}>Cancel</Button>
              <Button size="sm" onClick={savePassword} disabled={savingPassword}>
                {savingPassword ? 'Saving…' : 'Save'}
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Add Device Tab ───────────────────────────────────────────────────────────

function AddDeviceTab() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [name, setName] = useState('');
  const [rustdeskId, setRustdeskId] = useState('');
  const [hostname, setHostname] = useState('');
  const [platform, setPlatform] = useState('');
  const [customerId, setCustomerId] = useState('');

  const { data: customersData } = useQuery({
    queryKey: ['customers-list'],
    queryFn: () => customersApi.list().then((r) => r.data?.data?.customers ?? []),
  });
  const customers: Record<string, unknown>[] = customersData ?? [];

  const createMutation = useMutation({
    mutationFn: () =>
      endpointsApi.create({
        name,
        rustdeskId: rustdeskId.replace(/\s/g, '') || undefined,
        hostname: hostname || undefined,
        platform: platform || undefined,
        customerId: customerId || undefined,
      }).then((r) => r.data?.data),
    onSuccess: () => {
      toast({ title: 'Device added', description: `${name} is now in My Devices.` });
      queryClient.invalidateQueries({ queryKey: ['endpoints-devices'] });
      setName(''); setRustdeskId(''); setHostname(''); setPlatform(''); setCustomerId('');
    },
    onError: () => toast({ title: 'Failed to add device', variant: 'destructive' }),
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm flex items-center gap-2">
          <UserPlus className="h-4 w-4" />
          Add a Permanent Connection
        </CardTitle>
        <CardDescription>
          Have the customer run the install script from the{' '}
          <Link href="/download" className="underline">Downloads page</Link> — their RustDesk ID
          will be displayed once it&apos;s running. Enter it here to add the device permanently.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-2">
            <Label htmlFor="dev-name">Device name <span className="text-destructive">*</span></Label>
            <Input id="dev-name" placeholder="Reception PC" value={name} onChange={(e) => setName(e.target.value)} />
          </div>
          <div className="space-y-2">
            <Label htmlFor="dev-rdid">RustDesk ID <span className="text-destructive">*</span></Label>
            <Input
              id="dev-rdid"
              placeholder="123456789"
              value={rustdeskId}
              onChange={(e) => setRustdeskId(e.target.value)}
              className="font-mono"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="dev-host">Hostname (optional)</Label>
            <Input id="dev-host" placeholder="DESKTOP-ABC123" value={hostname} onChange={(e) => setHostname(e.target.value)} />
          </div>
          <div className="space-y-2">
            <Label htmlFor="dev-platform">Platform (optional)</Label>
            <Select value={platform} onValueChange={setPlatform}>
              <SelectTrigger id="dev-platform">
                <SelectValue placeholder="Select…" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="windows">Windows</SelectItem>
                <SelectItem value="macos">macOS</SelectItem>
                <SelectItem value="linux">Linux</SelectItem>
              </SelectContent>
            </Select>
          </div>
          {customers.length > 0 && (
            <div className="space-y-2 col-span-2">
              <Label htmlFor="dev-customer">Customer (optional)</Label>
              <Select value={customerId} onValueChange={setCustomerId}>
                <SelectTrigger id="dev-customer">
                  <SelectValue placeholder="Assign to customer…" />
                </SelectTrigger>
                <SelectContent>
                  {customers.map((c) => (
                    <SelectItem key={c.id as string} value={c.id as string}>{c.name as string}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}
        </div>
        <Button
          onClick={() => createMutation.mutate()}
          disabled={!name.trim() || !rustdeskId.trim() || createMutation.isPending}
        >
          <UserPlus className="h-4 w-4 mr-2" />
          {createMutation.isPending ? 'Adding…' : 'Add Device'}
        </Button>
      </CardContent>
    </Card>
  );
}

// ─── Ad-hoc Tab ───────────────────────────────────────────────────────────────

function AdHocTab() {
  const { toast } = useToast();
  const [adHocId, setAdHocId] = useState('');
  const [contactName, setContactName] = useState('');
  const [issueDescription, setIssueDescription] = useState('');
  const [launchId, setLaunchId] = useState('');

  const mutation = useMutation({
    mutationFn: (rustdeskId: string) =>
      sessionsApi.create({
        isAdHoc: true,
        adHocRustdeskId: rustdeskId,
        contactName: contactName || undefined,
        issueDescription: issueDescription || undefined,
      }).then((r) => r.data?.data),
    onSuccess: (_data, rustdeskId) => setLaunchId(rustdeskId),
    onError: () => toast({ title: 'Failed to create session', variant: 'destructive' }),
  });

  function handleConnect() {
    const clean = adHocId.replace(/\D/g, '');
    if (!clean) return;
    mutation.mutate(clean);
  }

  if (launchId) {
    return (
      <Card className="border-primary/50 bg-primary/5">
        <CardHeader>
          <CardTitle className="text-sm flex items-center gap-2">
            <MonitorPlay className="h-4 w-4 text-primary" />
            Session Ready
          </CardTitle>
          <CardDescription>
            Click below to connect to ID <span className="font-mono font-semibold">{launchId}</span>.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <Button asChild size="lg">
            <a href={`rustdesk://connection/new/${launchId}`}>
              <ExternalLink className="h-4 w-4 mr-2" />
              Open in RustDesk
            </a>
          </Button>
          <div>
            <Button variant="ghost" size="sm" className="text-muted-foreground" onClick={() => { setLaunchId(''); setAdHocId(''); }}>
              ← New connection
            </Button>
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm flex items-center gap-2">
          <Wifi className="h-4 w-4" />
          Ad-hoc Connection
        </CardTitle>
        <CardDescription>
          Ask the user to open RustDesk and read you their 9-digit ID. Enter it below to connect.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="space-y-2">
          <Label htmlFor="rustdesk-id">User&apos;s RustDesk ID</Label>
          <Input
            id="rustdesk-id"
            placeholder="123 456 789"
            value={adHocId}
            onChange={(e) => setAdHocId(e.target.value)}
            className="font-mono text-lg tracking-widest max-w-xs"
            onKeyDown={(e) => e.key === 'Enter' && handleConnect()}
          />
        </div>
        <div className="grid grid-cols-2 gap-3 max-w-sm">
          <div className="space-y-2">
            <Label htmlFor="contact-name">Contact name (optional)</Label>
            <Input id="contact-name" placeholder="John Smith" value={contactName} onChange={(e) => setContactName(e.target.value)} />
          </div>
          <div className="space-y-2">
            <Label htmlFor="issue">Issue (optional)</Label>
            <Input id="issue" placeholder="Can't open email" value={issueDescription} onChange={(e) => setIssueDescription(e.target.value)} />
          </div>
        </div>
        <Button onClick={handleConnect} disabled={!adHocId.trim() || mutation.isPending}>
          <MonitorPlay className="h-4 w-4 mr-2" />
          {mutation.isPending ? 'Starting…' : 'Connect'}
        </Button>
      </CardContent>
    </Card>
  );
}

// ─── Connect Page ─────────────────────────────────────────────────────────────

export default function ConnectPage() {
  return (
    <div className="p-6 space-y-6 max-w-5xl">
      <PageHeader title="Connect" description="Connect to enrolled devices or start an ad-hoc session" />

      <Tabs defaultValue="devices">
        <TabsList>
          <TabsTrigger value="devices">
            <Monitor className="h-3.5 w-3.5 mr-1.5" />
            My Devices
          </TabsTrigger>
          <TabsTrigger value="add">
            <UserPlus className="h-3.5 w-3.5 mr-1.5" />
            Add Device
          </TabsTrigger>
          <TabsTrigger value="adhoc">
            <Wifi className="h-3.5 w-3.5 mr-1.5" />
            Ad-hoc
          </TabsTrigger>
        </TabsList>

        <TabsContent value="devices" className="mt-4">
          <MyDevicesTab />
        </TabsContent>

        <TabsContent value="add" className="mt-4">
          <AddDeviceTab />
        </TabsContent>

        <TabsContent value="adhoc" className="mt-4">
          <AdHocTab />
        </TabsContent>
      </Tabs>
    </div>
  );
}
