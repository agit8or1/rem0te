'use client';

import { useParams } from 'next/navigation';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { publicSupportApi } from '@/lib/api-client';
import { Button } from '@/components/ui/button';
import { LifeBuoy, Loader2, Shield } from 'lucide-react';

type ApiError = { response?: { status?: number; data?: { message?: string | string[] } } };

/** What GET /public/support/status/:token returns, and nothing more. */
interface PublicStatus {
  businessName: string;
  status: 'WAITING' | 'CLAIMED' | 'CONNECTING' | 'COMPLETED' | 'CANCELED' | 'EXPIRED';
  statusText: string;
  technician: string | null;
  submittedAt: string;
  updatedAt: string;
  open: boolean;
}

/** The API accepts a customer cancel only in these states. */
const CANCELABLE = ['WAITING', 'CLAIMED'];

function when(iso: string) {
  try { return new Date(iso).toLocaleString(); } catch { return iso; }
}

export default function SupportStatusPage() {
  const { token } = useParams<{ token: string }>();
  const qc = useQueryClient();

  const status = useQuery<PublicStatus>({
    queryKey: ['public-support-status', token],
    queryFn: () => publicSupportApi.status(token).then((r) => r.data?.data),
    retry: false,
    enabled: !!token,
    refetchInterval: (q) => (q.state.data?.open ? 10_000 : false),
  });

  const cancel = useMutation({
    mutationFn: () => publicSupportApi.cancel(token).then((r) => r.data?.data as PublicStatus),
    onSuccess: (data) => qc.setQueryData(['public-support-status', token], data),
    onSettled: () => qc.invalidateQueries({ queryKey: ['public-support-status', token] }),
  });

  if (status.isLoading) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-muted/30">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </main>
    );
  }

  if (status.isError || !status.data) {
    const rateLimited = (status.error as ApiError)?.response?.status === 429;
    return (
      <main className="flex min-h-screen items-center justify-center bg-muted/30 p-6">
        <div className="w-full max-w-md rounded-lg border bg-card p-8 text-center shadow-sm">
          <Shield className="mx-auto mb-3 h-8 w-8 text-muted-foreground/50" />
          <h1 className="text-lg font-semibold">{rateLimited ? 'Too many requests' : 'This status link is not valid'}</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            {rateLimited ? 'Please try again in a minute.' : 'It may have expired.'}
          </p>
        </div>
      </main>
    );
  }

  const s = status.data;
  const cancelError = cancel.error as ApiError | null;

  return (
    <main className="min-h-screen bg-muted/30 py-10 px-4 sm:px-6">
      <div className="mx-auto w-full max-w-xl space-y-6">
        <header className="flex items-center gap-3">
          <LifeBuoy className="h-7 w-7 text-primary" aria-hidden="true" />
          <span className="text-lg font-semibold">{s.businessName}</span>
        </header>

        <section className="rounded-lg border bg-card p-6 sm:p-8 shadow-sm space-y-4" aria-live="polite">
          <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Your support request</p>
          <h1 className="text-xl font-semibold">{s.statusText}</h1>
          {s.technician && (
            <p className="text-sm">Technician: <span className="font-medium">{s.technician}</span></p>
          )}
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm text-muted-foreground">
            <dt>Submitted</dt><dd>{when(s.submittedAt)}</dd>
            <dt>Last change</dt><dd>{when(s.updatedAt)}</dd>
          </dl>
          {s.open && (
            <p className="text-xs text-muted-foreground">This page updates by itself.</p>
          )}

          {CANCELABLE.includes(s.status) && (
            <div className="pt-2 space-y-2">
              <Button
                variant="outline"
                onClick={() => { if (confirm('Cancel this support request?')) cancel.mutate(); }}
                disabled={cancel.isPending}
              >
                {cancel.isPending ? 'Canceling…' : 'Cancel request'}
              </Button>
              {cancelError && (
                <p className="text-sm text-destructive" role="alert">
                  {cancelError.response?.status === 429
                    ? 'Too many requests. Please try again in a minute.'
                    : cancelError.response?.data?.message?.toString() ?? 'Could not cancel the request.'}
                </p>
              )}
            </div>
          )}
        </section>
      </div>
    </main>
  );
}
