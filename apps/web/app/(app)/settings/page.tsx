'use client';

import { useState, useEffect, useRef, FormEvent } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { authApi, platformApi } from '@/lib/api-client';
import { PageHeader } from '@/components/common/page-header';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Badge } from '@/components/ui/badge';
import { useToast } from '@/hooks/use-toast';
import Link from 'next/link';
import { useRouter } from 'next/navigation';

const REQUIRED_PORTS = [
  { port: '80', proto: 'TCP', service: 'HTTP / Caddy', note: 'Web UI + API (redirects to HTTPS)' },
  { port: '443', proto: 'TCP', service: 'HTTPS / Caddy', note: 'Web UI + API (TLS)' },
  { port: '21115', proto: 'TCP', service: 'RustDesk hbbs', note: 'NAT type test' },
  { port: '21116', proto: 'TCP/UDP', service: 'RustDesk hbbs', note: 'ID registration & heartbeat' },
  { port: '21117', proto: 'TCP', service: 'RustDesk hbbr', note: 'Relay traffic' },
  { port: '21118', proto: 'TCP', service: 'RustDesk hbbs', note: 'WebSocket (browser clients)' },
  { port: '21119', proto: 'TCP', service: 'RustDesk hbbr', note: 'WebSocket relay' },
];

export default function SettingsPage() {
  const { toast } = useToast();
  const qc = useQueryClient();
  const router = useRouter();

  const { data: me } = useQuery({
    queryKey: ['me'],
    queryFn: () => authApi.me().then((r) => r.data?.data),
  });

  const tenantId: string = me?.tenantId ?? '';

  const { data: tenant } = useQuery({
    queryKey: ['tenant', tenantId],
    queryFn: () => platformApi.get(tenantId).then((r) => r.data?.data),
    enabled: !!tenantId,
  });

  const [name, setName] = useState('');
  const [requireMfa, setRequireMfa] = useState(false);
  const [sessionTimeout, setSessionTimeout] = useState(480);
  const [passwordMinLength, setPasswordMinLength] = useState(12);
  const [rustdeskRelayHost, setRustdeskRelayHost] = useState('');
  const [rustdeskPublicKey, setRustdeskPublicKey] = useState('');
  const [showDownloadPage, setShowDownloadPage] = useState(true);
  // Quick Connect master switch — platform level, independent of the
  // per-business switch and the per-user permission.
  const [quickConnect, setQuickConnect] = useState({
    quickConnectEnabled: false,
    quickConnectWindows: true,
    quickConnectMacos: false,
    quickConnectLinux: false,
  });

  const [branding, setBranding] = useState({
    portalTitle: '',
    logoUrl: '',
    accentColor: '#3B82F6',
    supportEmail: '',
    supportPhone: '',
    footerText: '',
  });
  const [logoUploading, setLogoUploading] = useState(false);
  const logoInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (tenant) {
      const t = tenant as Record<string, unknown>;
      setName((t.name as string) ?? '');
      const settings = t.settings as Record<string, unknown> | null;
      if (settings) {
        setRequireMfa((settings.requireMfa as boolean) ?? false);
        setSessionTimeout((settings.sessionTimeoutMinutes as number) ?? 480);
        setPasswordMinLength((settings.passwordMinLength as number) ?? 12);
        setRustdeskRelayHost((settings.rustdeskRelayHost as string) ?? '');
        setRustdeskPublicKey((settings.rustdeskPublicKey as string) ?? '');
        setShowDownloadPage((settings.showDownloadPage as boolean) ?? true);

      }
      const b = t.branding as Record<string, unknown> | null;
      if (b) {
        setBranding({
          portalTitle: (b.portalTitle as string) ?? '',
          logoUrl: (b.logoUrl as string) ?? '',
          accentColor: (b.accentColor as string) ?? '#3B82F6',
          supportEmail: (b.supportEmail as string) ?? '',
          supportPhone: (b.supportPhone as string) ?? '',
          footerText: (b.footerText as string) ?? '',
        });
      }
    }
  }, [tenant]);

  const { data: platformSettings } = useQuery({
    queryKey: ['platform-settings'],
    queryFn: () => platformApi.getSettings().then((r) => r.data?.data),
  });

  useEffect(() => {
    if (platformSettings) {
      const p = platformSettings as Record<string, boolean>;
      setQuickConnect({
        quickConnectEnabled: !!p.quickConnectEnabled,
        quickConnectWindows: p.quickConnectWindows !== false,
        quickConnectMacos: !!p.quickConnectMacos,
        quickConnectLinux: !!p.quickConnectLinux,
      });
    }
  }, [platformSettings]);

  const saveQuickConnect = useMutation({
    mutationFn: () => platformApi.saveSettings(quickConnect),
    onSuccess: () => {
      toast({ title: 'Quick Connect settings saved' });
      qc.invalidateQueries({ queryKey: ['platform-settings'] });
      qc.invalidateQueries({ queryKey: ['quick-connect'] });
    },
    onError: (e: { response?: { data?: { message?: string } } }) =>
      toast({ title: 'Could not save', description: e.response?.data?.message, variant: 'destructive' }),
  });

  const updateNameMutation = useMutation({
    mutationFn: () => platformApi.update(tenantId, { name }),
    onSuccess: () => {
      toast({ title: 'Platform name updated' });
      qc.invalidateQueries({ queryKey: ['tenant'] });
    },
    onError: () => toast({ title: 'Error', variant: 'destructive' }),
  });

  const updateSettingsMutation = useMutation({
    mutationFn: (extra?: Record<string, unknown>) =>
      platformApi.updateSettings(tenantId, {
        requireMfa,
        sessionTimeoutMinutes: sessionTimeout,
        passwordMinLength,
        rustdeskRelayHost: rustdeskRelayHost || null,
        rustdeskPublicKey: rustdeskPublicKey || null,
        showDownloadPage,
        ...extra,
      }),
    onSuccess: () => {
      toast({ title: 'Settings saved' });
      qc.invalidateQueries({ queryKey: ['tenant'] });
    },
    onError: () => toast({ title: 'Error', variant: 'destructive' }),
  });

  async function handleLogoUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file || !tenantId) return;
    setLogoUploading(true);
    try {
      const res = await platformApi.uploadLogo(tenantId, file);
      const url: string = res.data?.data?.url;
      if (url) setBranding((b) => ({ ...b, logoUrl: url }));
      toast({ title: 'Logo uploaded' });
    } catch {
      toast({ title: 'Upload failed', variant: 'destructive' });
    } finally {
      setLogoUploading(false);
      if (logoInputRef.current) logoInputRef.current.value = '';
    }
  }

  const updateBrandingMutation = useMutation({
    mutationFn: () =>
      platformApi.updateBranding(tenantId, {
        portalTitle: branding.portalTitle || undefined,
        logoUrl: branding.logoUrl || null,
        accentColor: branding.accentColor || undefined,
        supportEmail: branding.supportEmail || null,
        supportPhone: branding.supportPhone || null,
        footerText: branding.footerText || null,
      }),
    onSuccess: () => {
      toast({ title: 'Branding saved' });
      qc.invalidateQueries({ queryKey: ['tenant'] });
    },
    onError: () => toast({ title: 'Error', variant: 'destructive' }),
  });

  return (
    <div className="p-6 space-y-6 max-w-4xl">
      <PageHeader title="Settings" description="Platform configuration" />

      <Tabs defaultValue="general">
        <TabsList>
          <TabsTrigger value="general">General</TabsTrigger>
          <TabsTrigger value="security">Security</TabsTrigger>
          <TabsTrigger value="quick-connect">Quick Connect</TabsTrigger>
          <TabsTrigger value="rustdesk">RustDesk</TabsTrigger>
          <TabsTrigger value="branding">Branding</TabsTrigger>
          <TabsTrigger value="network">Network / Ports</TabsTrigger>
          <TabsTrigger value="access" onClick={() => router.push('/admin/access')}>Access Control</TabsTrigger>
        </TabsList>

        <TabsContent value="general" className="mt-4 space-y-4">
          <Card>
            <CardHeader><CardTitle className="text-sm">General</CardTitle></CardHeader>
            <CardContent>
              <form onSubmit={(e: FormEvent) => { e.preventDefault(); updateNameMutation.mutate(); }} className="space-y-4">
                <div className="space-y-2">
                  <Label htmlFor="tenant-name">Platform Name</Label>
                  <Input
                    id="tenant-name"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    required
                  />
                </div>
                <Button type="submit" disabled={updateNameMutation.isPending}>
                  {updateNameMutation.isPending ? 'Saving…' : 'Save'}
                </Button>
              </form>
            </CardContent>
          </Card>

          <Card>
            <CardHeader><CardTitle className="text-sm">Download Page</CardTitle></CardHeader>
            <CardContent className="space-y-4">
              <p className="text-sm text-muted-foreground">
                The public download page (<code className="text-xs bg-muted px-1 py-0.5 rounded">/download</code>) allows
                end users to download the RustDesk client with your server pre-configured. It is accessible without
                logging in.
              </p>
              <div className="flex items-center gap-3">
                <input
                  type="checkbox"
                  id="show-download"
                  checked={showDownloadPage}
                  onChange={(e) => setShowDownloadPage(e.target.checked)}
                  className="h-4 w-4"
                />
                <Label htmlFor="show-download">Show Download Client link in navigation</Label>
              </div>
              <Button
                onClick={() => updateSettingsMutation.mutate({ showDownloadPage })}
                disabled={updateSettingsMutation.isPending}
              >
                {updateSettingsMutation.isPending ? 'Saving…' : 'Save'}
              </Button>
            </CardContent>
          </Card>

        </TabsContent>

        <TabsContent value="quick-connect" className="mt-4 space-y-4">
          <Card>
            <CardHeader><CardTitle className="text-sm">Quick Connect</CardTitle></CardHeader>
            <CardContent className="space-y-4">
              <p className="text-sm text-muted-foreground">
                Allows users to download a temporary support client and provide its ID and password
                to an authorized Rem0te user.
              </p>
              <div className="flex items-center gap-3">
                <input
                  type="checkbox"
                  id="qc-master"
                  className="h-4 w-4"
                  checked={quickConnect.quickConnectEnabled}
                  onChange={(e) => setQuickConnect((q) => ({ ...q, quickConnectEnabled: e.target.checked }))}
                />
                <Label htmlFor="qc-master">
                  Quick Connect {quickConnect.quickConnectEnabled ? 'ON' : 'OFF'} (master switch)
                </Label>
              </div>
              <p className="rounded-md border bg-muted/40 p-3 text-xs text-muted-foreground">
                This is the master switch. With it off, Quick Connect is unavailable everywhere,
                whatever individual businesses or users are set to. With it on, each business can
                still be enabled or disabled separately, and each Business User additionally needs
                the <strong>Use Quick Connect</strong> permission.
              </p>

              <div className="space-y-2">
                <Label>Client builds to offer</Label>
                {([
                  ['quickConnectWindows', 'Windows', true],
                  ['quickConnectMacos', 'macOS', false],
                  ['quickConnectLinux', 'Linux', false],
                ] as const).map(([key, label, available]) => (
                  <div key={key} className="flex items-center gap-3">
                    <input
                      type="checkbox"
                      id={key}
                      className="h-4 w-4"
                      disabled={!available}
                      checked={quickConnect[key]}
                      onChange={(e) => setQuickConnect((q) => ({ ...q, [key]: e.target.checked }))}
                    />
                    <Label htmlFor={key} className={available ? '' : 'text-muted-foreground'}>
                      {label}{available ? '' : ' — no preconfigured build yet'}
                    </Label>
                  </div>
                ))}
                <p className="text-xs text-muted-foreground">
                  Only platforms with a working preconfigured build are offered on{' '}
                  <code className="rounded bg-muted px-1 py-0.5 text-xs">/quick</code>. The client is
                  delivered already pointed at this server, so the person downloading it never enters
                  a relay host, ID server or key.
                </p>
              </div>

              <Button
                onClick={() => saveQuickConnect.mutate()}
                disabled={saveQuickConnect.isPending}
              >
                {saveQuickConnect.isPending ? 'Saving…' : 'Save'}
              </Button>
            </CardContent>
          </Card>

          <Card>
            <CardHeader><CardTitle className="text-sm">Public page</CardTitle></CardHeader>
            <CardContent className="space-y-2">
              <p className="text-sm text-muted-foreground">
                Send anyone who needs help to this page. It does not expose the Rem0te console and
                does not ask them to create an account.
              </p>
              <a href="/quick" target="_blank" rel="noopener noreferrer" className="text-sm font-mono underline">
                /quick
              </a>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="security" className="mt-4">
          <Card>
            <CardHeader><CardTitle className="text-sm">Security Policy</CardTitle></CardHeader>
            <CardContent>
              <form
                onSubmit={(e: FormEvent) => { e.preventDefault(); updateSettingsMutation.mutate({}); }}
                className="space-y-4"
              >
                <div className="flex items-center gap-3">
                  <input
                    type="checkbox"
                    id="require-mfa"
                    checked={requireMfa}
                    onChange={(e) => setRequireMfa(e.target.checked)}
                    className="h-4 w-4"
                  />
                  <Label htmlFor="require-mfa">Require MFA for all users</Label>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="session-timeout">Session Timeout (minutes)</Label>
                  <Input
                    id="session-timeout"
                    type="number"
                    min={5}
                    max={10080}
                    value={sessionTimeout}
                    onChange={(e) => setSessionTimeout(parseInt(e.target.value, 10))}
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="password-min">Minimum Password Length</Label>
                  <Input
                    id="password-min"
                    type="number"
                    min={8}
                    max={64}
                    value={passwordMinLength}
                    onChange={(e) => setPasswordMinLength(parseInt(e.target.value, 10))}
                  />
                </div>
                <Button type="submit" disabled={updateSettingsMutation.isPending}>
                  {updateSettingsMutation.isPending ? 'Saving…' : 'Save Security Settings'}
                </Button>
              </form>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="rustdesk" className="mt-4">
          <Card>
            <CardHeader><CardTitle className="text-sm">RustDesk Integration</CardTitle></CardHeader>
            <CardContent>
              <form
                onSubmit={(e: FormEvent) => { e.preventDefault(); updateSettingsMutation.mutate({}); }}
                className="space-y-4"
              >
                <div className="space-y-2">
                  <Label htmlFor="relay-host">Relay Host</Label>
                  <Input
                    id="relay-host"
                    placeholder="relay.example.com or IP address"
                    value={rustdeskRelayHost}
                    onChange={(e) => setRustdeskRelayHost(e.target.value)}
                  />
                  <p className="text-xs text-muted-foreground">
                    The hostname or IP address of this server (used by RustDesk clients to connect).
                  </p>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="public-key">Public Key</Label>
                  <Input
                    id="public-key"
                    placeholder="Base64-encoded public key from /var/lib/rustdesk-server/id_ed25519.pub"
                    value={rustdeskPublicKey}
                    onChange={(e) => setRustdeskPublicKey(e.target.value)}
                  />
                </div>
                <Button type="submit" disabled={updateSettingsMutation.isPending}>
                  {updateSettingsMutation.isPending ? 'Saving…' : 'Save RustDesk Settings'}
                </Button>
              </form>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="branding" className="mt-4">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            <Card>
              <CardHeader><CardTitle className="text-sm">Brand Settings</CardTitle></CardHeader>
              <CardContent>
                <form
                  onSubmit={(e: FormEvent) => { e.preventDefault(); updateBrandingMutation.mutate(); }}
                  className="space-y-4"
                >
                  <div className="space-y-2">
                    <Label htmlFor="portal-title">Portal Title</Label>
                    <Input
                      id="portal-title"
                      value={branding.portalTitle}
                      onChange={(e) => setBranding((b) => ({ ...b, portalTitle: e.target.value }))}
                      placeholder="My Support Portal"
                    />
                  </div>
                  <div className="space-y-2">
                    <Label>Logo</Label>
                    <div className="flex items-center gap-3">
                      {branding.logoUrl && (
                        <img
                          src={branding.logoUrl}
                          alt="Current logo"
                          className="h-10 w-auto max-w-[80px] object-contain rounded border bg-muted p-1"
                          onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }}
                        />
                      )}
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        disabled={logoUploading}
                        onClick={() => logoInputRef.current?.click()}
                      >
                        {logoUploading ? 'Uploading…' : branding.logoUrl ? 'Replace logo' : 'Upload logo'}
                      </Button>
                      {branding.logoUrl && (
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          className="text-muted-foreground"
                          onClick={() => setBranding((b) => ({ ...b, logoUrl: '' }))}
                        >
                          Remove
                        </Button>
                      )}
                    </div>
                    <input
                      ref={logoInputRef}
                      type="file"
                      accept="image/jpeg,image/png,image/gif,image/webp,image/svg+xml"
                      className="hidden"
                      onChange={handleLogoUpload}
                    />
                    <p className="text-xs text-muted-foreground">JPEG, PNG, GIF, WebP or SVG — max 2 MB. Will be resized as needed.</p>
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="accent-color">Accent Color</Label>
                    <div className="flex gap-2">
                      <input
                        type="color"
                        value={branding.accentColor}
                        onChange={(e) => setBranding((b) => ({ ...b, accentColor: e.target.value }))}
                        className="h-10 w-12 rounded border cursor-pointer"
                      />
                      <Input
                        value={branding.accentColor}
                        onChange={(e) => setBranding((b) => ({ ...b, accentColor: e.target.value }))}
                        placeholder="#3B82F6"
                        maxLength={7}
                      />
                    </div>
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="support-email">Support Email</Label>
                    <Input
                      id="support-email"
                      type="email"
                      value={branding.supportEmail}
                      onChange={(e) => setBranding((b) => ({ ...b, supportEmail: e.target.value }))}
                      placeholder="support@example.com"
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="support-phone">Support Phone</Label>
                    <Input
                      id="support-phone"
                      value={branding.supportPhone}
                      onChange={(e) => setBranding((b) => ({ ...b, supportPhone: e.target.value }))}
                      placeholder="+1-555-0100"
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="footer-text">Footer Text</Label>
                    <Input
                      id="footer-text"
                      value={branding.footerText}
                      onChange={(e) => setBranding((b) => ({ ...b, footerText: e.target.value }))}
                      placeholder="© 2025 My MSP. All rights reserved."
                    />
                  </div>
                  <Button type="submit" disabled={updateBrandingMutation.isPending}>
                    {updateBrandingMutation.isPending ? 'Saving…' : 'Save Branding'}
                  </Button>
                </form>
              </CardContent>
            </Card>

            <Card>
              <CardHeader><CardTitle className="text-sm">Preview</CardTitle></CardHeader>
              <CardContent>
                <div className="rounded-lg border overflow-hidden">
                  <div
                    className="px-4 py-3 flex items-center gap-3"
                    style={{ backgroundColor: branding.accentColor }}
                  >
                    {branding.logoUrl && (
                      <img
                        src={branding.logoUrl}
                        alt="Logo"
                        className="h-8 w-auto object-contain"
                        onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }}
                      />
                    )}
                    <span className="text-white font-semibold text-sm">
                      {branding.portalTitle || 'Support Portal'}
                    </span>
                  </div>
                  <div className="p-4 bg-background">
                    <p className="text-sm text-muted-foreground">Portal content preview</p>
                    {branding.supportEmail && (
                      <p className="text-xs text-muted-foreground mt-2">
                        Support: {branding.supportEmail}
                      </p>
                    )}
                  </div>
                  {branding.footerText && (
                    <div className="px-4 py-2 bg-muted text-xs text-muted-foreground border-t">
                      {branding.footerText}
                    </div>
                  )}
                </div>
              </CardContent>
            </Card>
          </div>
        </TabsContent>

        <TabsContent value="network" className="mt-4 space-y-4">
          <Card>
            <CardHeader>
              <CardTitle className="text-sm">Required Open Ports</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <p className="text-sm text-muted-foreground">
                The following ports must be open on your server&apos;s firewall / security group for Rem0te
                to function correctly.
              </p>
              <div className="overflow-auto rounded-lg border">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b bg-muted/50">
                      <th className="px-4 py-2 text-left font-medium text-muted-foreground">Port</th>
                      <th className="px-4 py-2 text-left font-medium text-muted-foreground">Protocol</th>
                      <th className="px-4 py-2 text-left font-medium text-muted-foreground">Service</th>
                      <th className="px-4 py-2 text-left font-medium text-muted-foreground">Purpose</th>
                    </tr>
                  </thead>
                  <tbody>
                    {REQUIRED_PORTS.map((row) => (
                      <tr key={`${row.port}-${row.proto}`} className="border-b last:border-0">
                        <td className="px-4 py-3">
                          <code className="font-mono font-semibold">{row.port}</code>
                        </td>
                        <td className="px-4 py-3">
                          <Badge variant="secondary" className="text-xs font-mono">{row.proto}</Badge>
                        </td>
                        <td className="px-4 py-3 font-medium">{row.service}</td>
                        <td className="px-4 py-3 text-muted-foreground">{row.note}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="text-xs text-muted-foreground">
                Ports 80 and 443 are handled by Caddy. RustDesk ports (21115–21119) are handled by the
                hbbs/hbbr services installed on this server.
              </p>
            </CardContent>
          </Card>
        </TabsContent>

      </Tabs>
    </div>
  );
}
