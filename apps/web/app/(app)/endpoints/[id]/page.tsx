'use client';

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useParams, useRouter } from 'next/navigation';
import { endpointsApi, launcherApi, notesApi } from '@/lib/api-client';
import { PageHeader } from '@/components/common/page-header';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { StatusIndicator } from '@/components/common/status-indicator';
import { useToast } from '@/hooks/use-toast';
import { formatDate } from '@/lib/utils';
import { PlayCircle, Archive } from 'lucide-react';

export default function EndpointDetailPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const { toast } = useToast();
  const qc = useQueryClient();

  const { data: endpoint, isLoading } = useQuery({
    queryKey: ['endpoint', id],
    queryFn: () => endpointsApi.get(id).then((r) => r.data?.data),
  });

  const { data: notes } = useQuery({
    queryKey: ['notes', 'endpoint', id],
    queryFn: () =>
      notesApi.list({ endpointId: id }).then((r) => r.data?.data ?? []),
  });

  const launchMutation = useMutation({
    mutationFn: () => launcherApi.issueToken({ endpointId: id }),
    onSuccess: (res) => {
      const deepLink = res.data?.data?.deepLink;
      if (deepLink) window.location.href = deepLink;
      toast({ title: 'Launcher token issued', description: 'Opening RustDesk…' });
    },
    onError: () => toast({ title: 'Error', description: 'Failed to launch session', variant: 'destructive' }),
  });

  const archiveMutation = useMutation({
    mutationFn: () => endpointsApi.archive(id),
    onSuccess: () => {
      toast({ title: 'Endpoint archived' });
      router.push('/endpoints');
    },
  });

  if (isLoading) return <div className="p-6 text-muted-foreground text-sm">Loading…</div>;
  if (!endpoint) return <div className="p-6 text-muted-foreground text-sm">Not found</div>;

  const ep = endpoint as Record<string, unknown>;
  const customer = ep.customer as { id: string; name: string } | null;
  const site = ep.site as { id: string; name: string } | null;
  const aliases = (ep.aliases as { id: string; alias: string }[]) ?? [];
  const tags = (ep.tags as { id: string; tag: string }[]) ?? [];

  return (
    <div className="p-6 space-y-6">
      <PageHeader
        title={ep.name as string}
        description={(ep.hostname as string) ?? 'No hostname'}
      >
        <div className="flex gap-2">
          <Button
            size="sm"
            onClick={() => launchMutation.mutate()}
            disabled={launchMutation.isPending || !ep.rustdeskId}
          >
            <PlayCircle className="h-4 w-4 mr-2" />
            Launch Session
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => archiveMutation.mutate()}
            disabled={archiveMutation.isPending}
          >
            <Archive className="h-4 w-4 mr-2" />
            Archive
          </Button>
        </div>
      </PageHeader>

      <Tabs defaultValue="overview">
        <TabsList>
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="notes">Notes</TabsTrigger>
        </TabsList>

        <TabsContent value="overview" className="space-y-4 mt-4">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <Card>
              <CardHeader>
                <CardTitle className="text-sm">System Info</CardTitle>
              </CardHeader>
              <CardContent className="space-y-3 text-sm">
                <Row label="Status">
                  <StatusIndicator status={(ep.isOnline as boolean) ? 'online' : 'offline'} />
                </Row>
                <Row label="Platform">
                  {ep.platform ? <Badge variant="secondary">{ep.platform as string}</Badge> : '—'}
                </Row>
                <Row label="OS">{(ep.osVersion as string) ?? '—'}</Row>
                <Row label="RustDesk ID">
                  <span className="font-mono text-xs">{(ep.rustdeskId as string) ?? 'Not enrolled'}</span>
                </Row>
                <Row label="Agent">{(ep.agentVersion as string) ?? '—'}</Row>
                <Row label="Last Seen">{formatDate(ep.lastSeenAt as string)}</Row>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle className="text-sm">Assignment</CardTitle>
              </CardHeader>
              <CardContent className="space-y-3 text-sm">
                <Row label="Customer">{customer?.name ?? '—'}</Row>
                <Row label="Site">{site?.name ?? '—'}</Row>
                <Row label="Tags">
                  <div className="flex flex-wrap gap-1">
                    {tags.length ? tags.map((t) => (
                      <Badge key={t.id} variant="secondary" className="text-xs">{t.tag}</Badge>
                    )) : '—'}
                  </div>
                </Row>
                <Row label="Aliases">
                  <div className="flex flex-wrap gap-1">
                    {aliases.length ? aliases.map((a) => (
                      <Badge key={a.id} variant="outline" className="text-xs font-mono">{a.alias}</Badge>
                    )) : '—'}
                  </div>
                </Row>
                <Row label="Created">{formatDate(ep.createdAt as string)}</Row>
              </CardContent>
            </Card>
          </div>
        </TabsContent>

        <TabsContent value="notes" className="mt-4">
          <Card>
            <CardContent className="pt-4">
              {Array.isArray(notes) && notes.length > 0 ? (
                <div className="space-y-4">
                  {notes.map((note: Record<string, unknown>) => (
                    <div key={note.id as string} className="border rounded-md p-3 text-sm">
                      <p className="whitespace-pre-wrap">{note.content as string}</p>
                      <p className="text-xs text-muted-foreground mt-2">
                        {((note.author as { email?: string }) ?? {})?.email} · {formatDate(note.createdAt as string)}
                      </p>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="text-sm text-muted-foreground">No notes yet.</p>
              )}
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-4">
      <span className="text-muted-foreground shrink-0">{label}</span>
      <span className="text-right">{children}</span>
    </div>
  );
}
