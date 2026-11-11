'use client';

import { useMutation } from '@tanstack/react-query';
import Link from 'next/link';
import { enrollmentApi } from '@/lib/api-client';
import { PageHeader } from '@/components/common/page-header';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Plus, Link2, Copy, X } from 'lucide-react';
import { useState } from 'react';
import { useToast } from '@/hooks/use-toast';
import { DeviceList } from '@/components/endpoints/list/device-list';

export default function EndpointsPage() {
  const [showLinkModal, setShowLinkModal] = useState(false);
  const [linkDescription, setLinkDescription] = useState('');
  const [linkCustomerName, setLinkCustomerName] = useState('');
  const [generatedToken, setGeneratedToken] = useState<string | null>(null);
  const { toast } = useToast();

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
        windowsExe: `${window.location.origin}/api/v1/public/install/windows.exe?token=${generatedToken}`,
        windows: `${window.location.origin}/api/v1/public/install/windows.ps1?token=${generatedToken}`,
        linux: `${window.location.origin}/api/v1/public/install/linux.sh?token=${generatedToken}`,
        macos: `${window.location.origin}/api/v1/public/install/macos.sh?token=${generatedToken}`,
      }
    : null;

  return (
    <div className="p-6 space-y-4">
      <PageHeader title="Devices" description="Every enrolled device in the businesses you can see.">
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

      <DeviceList />

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
                  Generate a one-time enrollment link. Any computer that uses it is enrolled as a managed computer belonging to the business you choose.
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
                    <label className="text-sm font-medium">Business name (optional label)</label>
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
                  Share one of these with the device. The token is valid for 24 hours and single-use.
                </p>
                <div className="space-y-3">
                  <div className="rounded-lg border-2 border-primary/20 bg-primary/5 p-3 space-y-1.5">
                    <p className="text-xs font-semibold">Windows — One-click installer (recommended)</p>
                    <p className="text-xs text-muted-foreground">Send this URL — user downloads and double-clicks, no PowerShell needed.</p>
                    <div className="flex items-center gap-2">
                      <code className="flex-1 text-xs bg-muted rounded px-2 py-1.5 break-all">{scriptUrls!.windowsExe}</code>
                      <Button size="sm" variant="outline" onClick={() => copyToClipboard(scriptUrls!.windowsExe)}>
                        <Copy className="h-3 w-3" />
                      </Button>
                    </div>
                  </div>
                  {[
                    { label: 'Windows (PowerShell fallback)', url: scriptUrls!.windows },
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
