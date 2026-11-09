'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, ArrowLeft, CheckCircle2, ShieldCheck } from 'lucide-react';
import { updateTrustApi } from '@/lib/api-client';
import { usePermissions } from '@/lib/auth';
import { PageHeader } from '@/components/common/page-header';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { apiError } from '@/components/security-controls/shared';

/**
 * Settings → Security → Update Signing (v0.24).
 *
 * Read-mostly. The repository is signed offline with rem0te-release; this
 * portal only mirrors it, so everything under "Repository" is what the portal
 * is serving, not something it vouches for — the agents verify. The one
 * control is the trust mode: tightening applies at once, loosening goes to an
 * independent reviewer (Technician Access → Reviews).
 */

type Role = { version: number; expires: string };
type Agent = {
  id: string; hostname: string | null; business: { id: string; name: string } | null; agentVersion: string | null;
  channel: string; trustRootVersion: number | null; targetsVersion: number | null; reportedAt: string | null; lastSeenAt: string | null; online: boolean;
};
type Status = {
  mirror: {
    configured: boolean; reason?: string; warnings: string[];
    roles?: { root: Role & { threshold: number; keys: number }; targets: Role; snapshot: Role; timestamp: Role };
    targets?: { name: string; length: number; sha256: string; custom?: Record<string, unknown> }[];
  };
  mode: 'legacy_allowed' | 'signed_only';
  legacyPortalMigration: boolean;
  inventory: { counts: { signed: number; legacy: number; signedBehindRoot: number }; currentRootVersion: number | null; legacy: Agent[]; behindRoot: Agent[] };
};

const fmt = (d: string | null | undefined) => (d ? new Date(d).toLocaleString() : '—');
const left = (d: string) => {
  const h = (new Date(d).getTime() - Date.now()) / 3600_000;
  if (h <= 0) return 'expired';
  return h < 48 ? `${Math.round(h)} h` : `${Math.round(h / 24)} d`;
};
const kb = (n: number) => (n > 1 << 20 ? `${(n / (1 << 20)).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

export default function UpdateSigningPage() {
  const { user } = usePermissions();
  const qc = useQueryClient();
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null);
  const { data, isLoading, error } = useQuery<Status>({
    queryKey: ['update-trust'],
    queryFn: () => updateTrustApi.get().then((r) => r.data.data),
    enabled: !!user?.isPlatformAdmin,
    retry: false,
  });
  const setMode = useMutation({
    mutationFn: (v: { mode: Status['mode']; legacyPortalMigration: boolean }) => updateTrustApi.setMode(v.mode, v.legacyPortalMigration).then((r) => r.data.data),
    onSuccess: (r: { pendingReview?: boolean }) => {
      setNotice(r?.pendingReview
        ? { ok: true, text: 'This loosens update trust, so it was sent to an independent reviewer (Technician Access → Reviews). Nothing has changed yet.' }
        : { ok: true, text: 'Applied.' });
      qc.invalidateQueries({ queryKey: ['update-trust'] });
    },
    onError: (e) => setNotice({ ok: false, text: apiError(e).message }),
  });

  if (!user?.isPlatformAdmin) {
    return <div className="p-6 text-sm text-muted-foreground">Update signing is managed by Platform Admins.</div>;
  }

  const m = data?.mirror;
  const inv = data?.inventory;
  return (
    <div className="space-y-4 p-4 md:p-6">
      <Link href="/settings" className="inline-flex items-center text-sm text-muted-foreground hover:underline">
        <ArrowLeft className="mr-1 h-4 w-4" />Settings
      </Link>
      <PageHeader title="Update Signing" description="What agents verify before they run anything, and how legacy agents are contained." />
      {isLoading && <p className="text-sm text-muted-foreground">Loading…</p>}
      {error && <p className="text-sm text-destructive">{apiError(error).message}</p>}
      {notice && (
        <div className={`rounded-md border p-3 text-sm ${notice.ok ? 'border-emerald-300 bg-emerald-50 text-emerald-900 dark:bg-emerald-950 dark:text-emerald-100' : 'border-destructive/40 bg-destructive/10 text-destructive'}`}>{notice.text}</div>
      )}

      {data && (
        <>
          <Card>
            <CardHeader><CardTitle className="text-sm">Repository (as served by this portal)</CardTitle></CardHeader>
            <CardContent className="space-y-3 text-sm">
              {!m?.configured ? (
                <p className="text-muted-foreground">
                  Not configured: {m?.reason} Agents built with a trust root cannot install or update until a repository
                  signed with <code>rem0te-release</code> is copied here and <code>UPDATE_REPO_DIR</code> points at it. See{' '}
                  <Link className="underline" href="/docs/update-signing">Update signing</Link>.
                </p>
              ) : (
                <>
                  <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
                    {(['root', 'targets', 'snapshot', 'timestamp'] as const).map((r) => {
                      const role = m.roles![r];
                      const exp = left(role.expires);
                      return (
                        <div key={r} className="rounded-md border p-2">
                          <div className="text-xs uppercase text-muted-foreground">{r}</div>
                          <div className="font-medium">v{role.version}{r === 'root' ? ` · ${m.roles!.root.threshold} of ${m.roles!.root.keys}` : ''}</div>
                          <div className={`text-xs ${exp === 'expired' || exp.endsWith(' h') ? 'text-destructive' : 'text-muted-foreground'}`}>expires in {exp}</div>
                        </div>
                      );
                    })}
                  </div>
                  {m.warnings.length > 0 && (
                    <ul className="space-y-1">
                      {m.warnings.map((w) => (
                        <li key={w} className="flex items-start gap-2 text-amber-700 dark:text-amber-300"><AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />{w}</li>
                      ))}
                    </ul>
                  )}
                  <div className="overflow-x-auto">
                    <table className="w-full text-xs">
                      <thead className="text-left text-muted-foreground"><tr><th className="py-1 pr-3">Target</th><th className="pr-3">Size</th><th>SHA-256</th></tr></thead>
                      <tbody>
                        {m.targets!.map((t) => (
                          <tr key={t.name} className="border-t"><td className="py-1 pr-3 font-mono">{t.name}</td><td className="pr-3">{kb(t.length)}</td><td className="font-mono">{t.sha256.slice(0, 16)}…</td></tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    This portal holds no signing key. These values are read from the files it serves and are not verified here — each agent verifies them against the root compiled into it.
                  </p>
                </>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader><CardTitle className="text-sm">Legacy update path</CardTitle></CardHeader>
            <CardContent className="space-y-3 text-sm">
              <p className="text-muted-foreground">
                Agents installed before 0.24 update by running whatever installer this portal serves, as SYSTEM. In{' '}
                <strong>signed only</strong> the portal hands them nothing to run. Moving away from signed only, or allowing
                portal-mediated migration, is reviewed by a second person.
              </p>
              <div className="flex flex-wrap items-center gap-2">
                <span>Mode:</span>
                <Badge variant={data.mode === 'signed_only' ? 'default' : 'secondary'}>{data.mode === 'signed_only' ? 'Signed only' : 'Legacy allowed'}</Badge>
                {data.mode === 'signed_only' && <Badge variant="outline">Portal migration {data.legacyPortalMigration ? 'on' : 'off'}</Badge>}
              </div>
              <div className="flex flex-wrap gap-2">
                {data.mode === 'legacy_allowed' ? (
                  <Button size="sm" disabled={!m?.configured || setMode.isPending} onClick={() => setMode.mutate({ mode: 'signed_only', legacyPortalMigration: false })}>
                    <ShieldCheck className="mr-2 h-4 w-4" />Switch to signed only
                  </Button>
                ) : (
                  <>
                    <Button size="sm" variant="outline" disabled={setMode.isPending} onClick={() => setMode.mutate({ mode: 'signed_only', legacyPortalMigration: !data.legacyPortalMigration })}>
                      {data.legacyPortalMigration ? 'Turn portal migration off' : 'Allow portal migration (reviewed)'}
                    </Button>
                    <Button size="sm" variant="outline" disabled={setMode.isPending} onClick={() => setMode.mutate({ mode: 'legacy_allowed', legacyPortalMigration: false })}>
                      Allow legacy again (reviewed)
                    </Button>
                  </>
                )}
              </div>
              {!m?.configured && data.mode === 'legacy_allowed' && <p className="text-xs text-muted-foreground">Signed only needs a configured repository.</p>}
            </CardContent>
          </Card>

          <Card>
            <CardHeader><CardTitle className="text-sm">Windows agents</CardTitle></CardHeader>
            <CardContent className="space-y-3 text-sm">
              <div className="flex flex-wrap gap-4">
                <span className="flex items-center gap-1"><CheckCircle2 className="h-4 w-4 text-emerald-600" />{inv?.counts.signed ?? 0} signed</span>
                <span className="flex items-center gap-1"><AlertTriangle className="h-4 w-4 text-amber-600" />{inv?.counts.legacy ?? 0} legacy</span>
                {!!inv?.counts.signedBehindRoot && <span>{inv.counts.signedBehindRoot} signed but behind root v{inv.currentRootVersion}</span>}
              </div>
              <p className="text-xs text-muted-foreground">
                Self-reported by each agent&apos;s heartbeat. It decides only what the portal withholds: an agent claiming to be signed gets less from the portal, never more.
              </p>
              {(inv?.legacy.length ?? 0) > 0 && (
                <div className="overflow-x-auto">
                  <table className="w-full text-xs">
                    <thead className="text-left text-muted-foreground"><tr><th className="py-1 pr-3">Computer</th><th className="pr-3">Business</th><th className="pr-3">Agent</th><th>Last seen</th></tr></thead>
                    <tbody>
                      {inv!.legacy.map((a) => (
                        <tr key={a.id} className="border-t">
                          <td className="py-1 pr-3"><Link className="underline" href={`/endpoints/${a.id}`}>{a.hostname ?? a.id}</Link></td>
                          <td className="pr-3">{a.business?.name ?? '—'}</td>
                          <td className="pr-3">{a.agentVersion ?? '—'}</td>
                          <td>{fmt(a.lastSeenAt)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              <p className="text-xs text-muted-foreground">
                Migrate legacy agents with <code>rem0te-agent.exe migrate --portal &lt;host&gt;</code> from an official release, through GPO, Intune or locally. It keeps enrolment, the device secret and RustDesk settings. See{' '}
                <Link className="underline" href="/docs/update-signing">Update signing</Link>.
              </p>
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}
