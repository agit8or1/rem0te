'use client';

import { useQuery, useMutation } from '@tanstack/react-query';
import Link from 'next/link';
import { endpointsApi, enrollmentApi } from '@/lib/api-client';
import { PageHeader } from '@/components/common/page-header';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { StatusIndicator } from '@/components/common/status-indicator';
import { Plus, Search, Link2, Copy, X } from 'lucide-react';
import { useState } from 'react';
import { formatDate } from '@/lib/utils';
import { useToast } from '@/hooks/use-toast';

export default function EndpointsPage() {
  const [search, setSearch] = useState('');
  const [showLinkModal, setShowLinkModal] = useState(false);
  const [linkDescription, setLinkDescription] = useState('');
  const [linkCustomerName, setLinkCustomerName] = useState('');
  const [generatedToken, setGeneratedToken] = useState<string | null>(null);
  const { toast } = useToast();

  const { data, isLoading } = useQuery({
    queryKey: ['endpoints', search],
    queryFn: () =>
      endpointsApi.list(search ? { search } : undefined).then((r) => r.data?.data),
    refetchInterval: 30_000,
  });

  const endpoints: Record<string, unknown>[] = data?.endpoints ?? [];

  const createTokenMutation = useMutation({
    mutationFn: () =>
      enrollmentApi
        .createToken({ description: linkDescription || undefined, customerName: linkCustomerName || undefined })
        .then((r) => r.data?.data),
    onSuccess: (data) => {
      setGeneratedToken(data?.token ?? null);
    },
    onError: () => {
      toast({ title: 'Failed to generate link', variant: 'destructive' });
    },
  });

  function closeModal() {
    setShowLinkModal(false);
    setLinkDescription('');
    setLinkCustomerName('');
    setGeneratedToken(null);
  }

  function copyToClipboard(text: string) {
    navigator.clipboard.writeText(text).then(() => {
      toast({ title: 'Copied to clipboard' });
    });
  }

  const scriptUrls = generatedToken
    ? {
        windows: `${window.location.origin}/api/v1/public/install/windows.ps1?token=${generatedToken}`,
        linux: `${window.location.origin}/api/v1/public/install/linux.sh?token=${generatedToken}`,
        macos: `${window.location.origin}/api/v1/public/install/macos.sh?token=${generatedToken}`,
      }
    : null;

  return (
    <div className="p-6 space-y-6">
      <PageHeader title="Enrolled Clients" description="Permanently enrolled remote devices — installed via the enrollment script">
        <Button size="sm" variant="outline" onClick={() => setShowLinkModal(true)}>
          <Link2 className="h-4 w-4 mr-2" />
          Generate Enrollment Link
        </Button>
        <Link href="/endpoints/new">
          <Button size="sm">
            <Plus className="h-4 w-4 mr-2" />
            Enroll Client
          </Button>
        </Link>
      </PageHeader>

      <div className="flex items-center gap-2">
        <div className="relative flex-1 max-w-sm">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Search endpoints…"
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
                <th className="text-left px-4 py-3 font-medium">Customer</th>
                <th className="text-left px-4 py-3 font-medium">Platform</th>
                <th className="text-left px-4 py-3 font-medium">RustDesk ID</th>
                <th className="text-left px-4 py-3 font-medium">Last Seen</th>
                <th className="text-left px-4 py-3 font-medium">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {endpoints.length === 0 ? (
                <tr>
                  <td colSpan={6} className="text-center py-8 text-muted-foreground">
                    No endpoints found.
                  </td>
                </tr>
              ) : (
                endpoints.map((ep) => {
                  const customer = ep.customer as { name?: string } | null;
                  return (
                    <tr key={ep.id as string} className="hover:bg-muted/30">
                      <td className="px-4 py-3">
                        <Link
                          href={`/endpoints/${ep.id as string}`}
                          className="font-medium hover:underline"
                        >
                          {ep.name as string}
                        </Link>
                        {ep.hostname ? (
                          <p className="text-xs text-muted-foreground">{ep.hostname as string}</p>
                        ) : null}
                      </td>
                      <td className="px-4 py-3 text-muted-foreground">
                        {customer?.name ?? '—'}
                      </td>
                      <td className="px-4 py-3">
                        {ep.platform ? (
                          <Badge variant="secondary">{ep.platform as string}</Badge>
                        ) : (
                          <span className="text-muted-foreground">—</span>
                        )}
                      </td>
                      <td className="px-4 py-3 font-mono text-xs text-muted-foreground">
                        {(ep.rustdeskId as string) ?? '—'}
                      </td>
                      <td className="px-4 py-3 text-muted-foreground text-xs">
                        {formatDate(ep.lastSeenAt as string)}
                      </td>
                      <td className="px-4 py-3">
                        <StatusIndicator status={(ep.isOnline as boolean) ? 'online' : 'offline'} />
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      )}

      {/* Enrollment Link Modal */}
      {showLinkModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
          <div className="bg-background rounded-lg border shadow-lg w-full max-w-lg p-6 space-y-4">
            <div className="flex items-center justify-between">
              <h2 className="text-lg font-semibold">Generate Enrollment Link</h2>
              <button onClick={closeModal} className="text-muted-foreground hover:text-foreground">
                <X className="h-5 w-5" />
              </button>
            </div>

            {!generatedToken ? (
              <>
                <p className="text-sm text-muted-foreground">
                  Generate a one-time enrollment link. Devices that use this link will be automatically assigned to your tenant.
                </p>
                <div className="space-y-3">
                  <div>
                    <label className="text-sm font-medium">Description (optional)</label>
                    <Input
                      className="mt-1"
                      placeholder="e.g. Acme Corp deployment"
                      value={linkDescription}
                      onChange={(e) => setLinkDescription(e.target.value)}
                    />
                  </div>
                  <div>
                    <label className="text-sm font-medium">Customer Name (optional)</label>
                    <Input
                      className="mt-1"
                      placeholder="Pre-assign customer name"
                      value={linkCustomerName}
                      onChange={(e) => setLinkCustomerName(e.target.value)}
                    />
                  </div>
                </div>
                <div className="flex justify-end gap-2 pt-2">
                  <Button variant="outline" onClick={closeModal}>Cancel</Button>
                  <Button
                    onClick={() => createTokenMutation.mutate()}
                    disabled={createTokenMutation.isPending}
                  >
                    Generate
                  </Button>
                </div>
              </>
            ) : (
              <>
                <p className="text-sm text-muted-foreground">
                  Share one of these script URLs with the device. The token is valid for 24 hours and single-use.
                </p>
                <div className="space-y-3">
                  {[
                    { label: 'Windows (PowerShell)', url: scriptUrls!.windows },
                    { label: 'Linux (Bash)', url: scriptUrls!.linux },
                    { label: 'macOS (Bash)', url: scriptUrls!.macos },
                  ].map(({ label, url }) => (
                    <div key={label}>
                      <p className="text-xs font-medium text-muted-foreground mb-1">{label}</p>
                      <div className="flex items-center gap-2">
                        <code className="flex-1 text-xs bg-muted rounded px-2 py-1.5 break-all">{url}</code>
                        <Button size="sm" variant="outline" onClick={() => copyToClipboard(url)}>
                          <Copy className="h-3 w-3" />
                        </Button>
                      </div>
                    </div>
                  ))}
                </div>
                <div className="flex justify-end pt-2">
                  <Button onClick={closeModal}>Done</Button>
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
