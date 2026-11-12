'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { chatRecordingApi } from '@/lib/api-client';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { useToast } from '@/hooks/use-toast';

/**
 * Whether chats with the person at a computer are recorded (0.36): the
 * platform default and, per business, an override. Recorded: the transcript
 * is kept for the retention window. Not recorded: each message is deleted
 * once both sides have it, and whatever is left when the chat ends. A chat
 * keeps the setting it started with. Changing either needs a fresh sign-in
 * (the request interceptor asks) and is in the audit log.
 */

type Settings = {
  platformDefault: boolean;
  canChangePlatform: boolean;
  business: { id: string; name: string; setting: boolean | null; effective: boolean; canChange: boolean } | null;
};

function apiError(e: unknown) {
  const m = (e as { response?: { data?: { message?: unknown } } })?.response?.data?.message;
  return typeof m === 'string' ? m : 'The setting was not saved.';
}

export function ChatRecordingCard() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const { data, isLoading, isError } = useQuery<Settings>({
    queryKey: ['chat-recording'],
    queryFn: () => chatRecordingApi.get().then((r) => r.data?.data),
    retry: false,
  });
  const done = (res: { data?: { data?: Settings } }) => { qc.setQueryData(['chat-recording'], res.data?.data); toast({ title: 'Saved' }); };
  const setBiz = useMutation({
    mutationFn: (v: boolean | null) => chatRecordingApi.setBusiness(data!.business!.id, v),
    onSuccess: done,
    onError: (e) => toast({ title: 'Not saved', description: apiError(e), variant: 'destructive' }),
  });
  const setPlatform = useMutation({
    mutationFn: (v: boolean) => chatRecordingApi.setPlatform(v),
    onSuccess: done,
    onError: (e) => toast({ title: 'Not saved', description: apiError(e), variant: 'destructive' }),
  });
  if (isError) return null;
  const word = (v: boolean) => (v ? 'recorded' : 'not recorded');
  return (
    <Card data-testid="chat-recording-card">
      <CardHeader><CardTitle className="text-sm">Chat recording</CardTitle></CardHeader>
      <CardContent className="space-y-4 text-sm">
        <p className="text-muted-foreground">
          Recorded chats keep their transcript on the computer&apos;s Chat tab for 400 days after they end. Chats that are not
          recorded are relayed only: each message is deleted once both sides have it, and anything left when the chat ends.
          Both the technician and the person at the computer are told which it is. A chat keeps the setting it started with.
        </p>
        {isLoading || !data ? <p className="text-muted-foreground">Loading…</p> : (
          <>
            {data.business && (
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <p className="font-medium">{data.business.name}</p>
                  <p className="text-xs text-muted-foreground" data-testid="chat-recording-business" data-effective={data.business.effective ? 'on' : 'off'}>
                    New chats are {word(data.business.effective)}
                    {data.business.setting === null ? ' (the platform default)' : ' (set for this business)'}.
                  </p>
                </div>
                {data.business.canChange && (
                  <div className="flex flex-wrap gap-2">
                    <Button size="sm" variant={data.business.setting === true ? 'default' : 'outline'} disabled={setBiz.isPending} onClick={() => setBiz.mutate(true)}>Record</Button>
                    <Button size="sm" variant={data.business.setting === false ? 'default' : 'outline'} disabled={setBiz.isPending} onClick={() => setBiz.mutate(false)} data-testid="chat-recording-off">Do not record</Button>
                    <Button size="sm" variant={data.business.setting === null ? 'default' : 'outline'} disabled={setBiz.isPending} onClick={() => setBiz.mutate(null)}>Use platform default</Button>
                  </div>
                )}
              </div>
            )}
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <p className="font-medium">Platform default</p>
                <p className="text-xs text-muted-foreground">Businesses without their own setting: chats are {word(data.platformDefault)}.</p>
              </div>
              {data.canChangePlatform && (
                <Button size="sm" variant="outline" disabled={setPlatform.isPending} onClick={() => setPlatform.mutate(!data.platformDefault)}>
                  {data.platformDefault ? 'Stop recording by default' : 'Record by default'}
                </Button>
              )}
            </div>
            {!data.canChangePlatform && !data.business?.canChange && (
              <p className="text-xs text-muted-foreground">A Business Owner changes this for their business; a Platform Admin sets the default.</p>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}
