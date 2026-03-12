'use client';

import { useState, useEffect, FormEvent } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { authApi, tenantsApi } from '@/lib/api-client';
import { PageHeader } from '@/components/common/page-header';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { useToast } from '@/hooks/use-toast';

export default function BrandingPage() {
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

  const [form, setForm] = useState({
    portalTitle: '',
    logoUrl: '',
    accentColor: '#3B82F6',
    supportEmail: '',
    supportPhone: '',
    footerText: '',
  });

  useEffect(() => {
    if (tenant) {
      const branding = (tenant as Record<string, unknown>).branding as Record<string, unknown> | null;
      if (branding) {
        setForm({
          portalTitle: (branding.portalTitle as string) ?? '',
          logoUrl: (branding.logoUrl as string) ?? '',
          accentColor: (branding.accentColor as string) ?? '#3B82F6',
          supportEmail: (branding.supportEmail as string) ?? '',
          supportPhone: (branding.supportPhone as string) ?? '',
          footerText: (branding.footerText as string) ?? '',
        });
      }
    }
  }, [tenant]);

  const updateMutation = useMutation({
    mutationFn: () =>
      tenantsApi.updateBranding(tenantId, {
        portalTitle: form.portalTitle || undefined,
        logoUrl: form.logoUrl || null,
        accentColor: form.accentColor || undefined,
        supportEmail: form.supportEmail || null,
        supportPhone: form.supportPhone || null,
        footerText: form.footerText || null,
      }),
    onSuccess: () => {
      toast({ title: 'Branding saved' });
      qc.invalidateQueries({ queryKey: ['tenant'] });
    },
    onError: () => toast({ title: 'Error', variant: 'destructive' }),
  });

  return (
    <div className="p-6 space-y-6 max-w-2xl">
      <PageHeader title="Branding" description="Customize your portal appearance" />

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        {/* Form */}
        <Card>
          <CardHeader><CardTitle className="text-sm">Brand Settings</CardTitle></CardHeader>
          <CardContent>
            <form
              onSubmit={(e: FormEvent) => { e.preventDefault(); updateMutation.mutate(); }}
              className="space-y-4"
            >
              <div className="space-y-2">
                <Label htmlFor="portal-title">Portal Title</Label>
                <Input
                  id="portal-title"
                  value={form.portalTitle}
                  onChange={(e) => setForm((f) => ({ ...f, portalTitle: e.target.value }))}
                  placeholder="My Support Portal"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="logo-url">Logo URL</Label>
                <Input
                  id="logo-url"
                  type="url"
                  value={form.logoUrl}
                  onChange={(e) => setForm((f) => ({ ...f, logoUrl: e.target.value }))}
                  placeholder="https://example.com/logo.png"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="accent-color">Accent Color</Label>
                <div className="flex gap-2">
                  <input
                    type="color"
                    value={form.accentColor}
                    onChange={(e) => setForm((f) => ({ ...f, accentColor: e.target.value }))}
                    className="h-10 w-12 rounded border cursor-pointer"
                  />
                  <Input
                    value={form.accentColor}
                    onChange={(e) => setForm((f) => ({ ...f, accentColor: e.target.value }))}
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
                  value={form.supportEmail}
                  onChange={(e) => setForm((f) => ({ ...f, supportEmail: e.target.value }))}
                  placeholder="support@example.com"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="support-phone">Support Phone</Label>
                <Input
                  id="support-phone"
                  value={form.supportPhone}
                  onChange={(e) => setForm((f) => ({ ...f, supportPhone: e.target.value }))}
                  placeholder="+1-555-0100"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="footer-text">Footer Text</Label>
                <Input
                  id="footer-text"
                  value={form.footerText}
                  onChange={(e) => setForm((f) => ({ ...f, footerText: e.target.value }))}
                  placeholder="© 2025 My MSP. All rights reserved."
                />
              </div>
              <Button type="submit" disabled={updateMutation.isPending}>
                {updateMutation.isPending ? 'Saving…' : 'Save Branding'}
              </Button>
            </form>
          </CardContent>
        </Card>

        {/* Preview */}
        <Card>
          <CardHeader><CardTitle className="text-sm">Preview</CardTitle></CardHeader>
          <CardContent>
            <div
              className="rounded-lg border overflow-hidden"
              style={{ '--preview-accent': form.accentColor } as React.CSSProperties}
            >
              {/* Mock portal header */}
              <div
                className="px-4 py-3 flex items-center gap-3"
                style={{ backgroundColor: form.accentColor }}
              >
                {form.logoUrl && (
                  <img
                    src={form.logoUrl}
                    alt="Logo"
                    className="h-8 w-auto object-contain"
                    onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }}
                  />
                )}
                <span className="text-white font-semibold text-sm">
                  {form.portalTitle || 'Support Portal'}
                </span>
              </div>
              <div className="p-4 bg-background">
                <p className="text-sm text-muted-foreground">Portal content preview</p>
                {form.supportEmail && (
                  <p className="text-xs text-muted-foreground mt-2">
                    Support: {form.supportEmail}
                  </p>
                )}
              </div>
              {form.footerText && (
                <div className="px-4 py-2 bg-muted text-xs text-muted-foreground border-t">
                  {form.footerText}
                </div>
              )}
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
