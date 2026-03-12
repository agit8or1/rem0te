'use client';

import { useState, useEffect, useRef, FormEvent } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { authApi, tenantsApi } from '@/lib/api-client';
import { PageHeader } from '@/components/common/page-header';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Badge } from '@/components/ui/badge';
import { useToast } from '@/hooks/use-toast';
import Link from 'next/link';

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

  const { data: me } = useQuery({
    queryKey: ['me'],
    queryFn: () => authApi.me().then((r) => r.data?.data),
  });

  const tenantId: string = me?.tenantId ?? '';

  const { data: tenant } = useQuery({
    queryKey: ['tenant', tenantId],
    queryFn: () => tenantsApi.get(tenantId).then((r) => r.data?.data),
    enabled: !!tenantId,
  });

  const [name, setName] = useState('');
  const [requireMfa, setRequireMfa] = useState(false);
  const [sessionTimeout, setSessionTimeout] = useState(480);
  const [passwordMinLength, setPasswordMinLength] = useState(12);
  const [rustdeskRelayHost, setRustdeskRelayHost] = useState('');
  const [rustdeskPublicKey, setRustdeskPublicKey] = useState('');
  const [showDownloadPage, setShowDownloadPage] = useState(true);
  const [allowCustomerPortal, setAllowCustomerPortal] = useState(false);

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
        setAllowCustomerPortal((settings.allowCustomerPortal as boolean) ?? false);
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

  const updateNameMutation = useMutation({
    mutationFn: () => tenantsApi.update(tenantId, { name }),
    onSuccess: () => {
      toast({ title: 'Tenant name updated' });
      qc.invalidateQueries({ queryKey: ['tenant'] });
    },
    onError: () => toast({ title: 'Error', variant: 'destructive' }),
  });

  const updateSettingsMutation = useMutation({
    mutationFn: (extra?: Record<string, unknown>) =>
      tenantsApi.updateSettings(tenantId, {
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
      const res = await tenantsApi.uploadLogo(tenantId, file);
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
      tenantsApi.updateBranding(tenantId, {
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
      <PageHeader title="Settings" description="Configure your tenant" />

      <Tabs defaultValue="general">
        <TabsList>
          <TabsTrigger value="general">General</TabsTrigger>
          <TabsTrigger value="security">Security</TabsTrigger>
          <TabsTrigger value="rustdesk">RustDesk</TabsTrigger>
          <TabsTrigger value="branding">Branding</TabsTrigger>
          <TabsTrigger value="network">Network / Ports</TabsTrigger>
          <TabsTrigger value="access">Access Control</TabsTrigger>
        </TabsList>

        <TabsContent value="general" className="mt-4 space-y-4">
          <Card>
            <CardHeader><CardTitle className="text-sm">General</CardTitle></CardHeader>
            <CardContent>
              <form onSubmit={(e: FormEvent) => { e.preventDefault(); updateNameMutation.mutate(); }} className="space-y-4">
                <div className="space-y-2">
                  <Label htmlFor="tenant-name">Tenant Name</Label>
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

          <Card>
            <CardHeader><CardTitle className="text-sm">Customer Portal</CardTitle></CardHeader>
            <CardContent className="space-y-4">
              <p className="text-sm text-muted-foreground">
                Allow customers to log in to a simplified portal where they can view their devices and request support sessions.
                You can invite customer users from each customer&apos;s detail page.
              </p>
              <div className="flex items-center gap-3">
                <input
                  type="checkbox"
                  id="allow-customer-portal"
                  checked={allowCustomerPortal}
                  onChange={(e) => setAllowCustomerPortal(e.target.checked)}
                  className="h-4 w-4"
                />
                <Label htmlFor="allow-customer-portal">Enable customer portal</Label>
              </div>
              <Button
                onClick={() => updateSettingsMutation.mutate({ allowCustomerPortal })}
                disabled={updateSettingsMutation.isPending}
              >
                {updateSettingsMutation.isPending ? 'Saving…' : 'Save'}
              </Button>
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

        <TabsContent value="access" className="mt-4">
          <Card>
            <CardContent className="py-6">
              <p className="text-sm text-muted-foreground mb-4">
                Manage the permissions hierarchy — tenants, technicians, and customers.
              </p>
              <Link href="/admin/access">
                <Button variant="outline" size="sm">Open Access Control</Button>
              </Link>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}
