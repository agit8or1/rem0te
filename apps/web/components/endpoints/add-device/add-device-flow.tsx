'use client';
import { shownAgentVersion, type AgentVersionView } from '@/lib/agent-version';

import { useEffect, useMemo, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, CheckCircle2, Circle, Copy, Download, Loader2, Terminal, XCircle } from 'lucide-react';
import { businessesApi, endpointsApi, enrollmentApi, sitesApi, usersApi } from '@/lib/api-client';
import { CAP, usePermissions } from '@/lib/auth';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { apiError } from '@/components/security-controls/shared';
import { agentType, ago, describeMonitor } from '@/components/endpoints/workspace/device-model';
import { useMonitoringView } from '@/components/endpoints/workspace/use-device-data';
import { formatDate } from '@/lib/utils';
import { connectivityLabel, connectivityOf } from '@/lib/connectivity';
import { useAsks } from '@/lib/confirm-policy';

/**
 * Add device (0.32): one guided flow instead of three entry points.
 *
 *   1. business, then site (or none), and who may connect;
 *   2. the operating system;
 *   3. the install command — an existing single-use, 24-hour enrolment token
 *      and the existing install scripts;
 *   4. wait for the device: GET /enrollment/tokens/:id/status, polled;
 *   5. its first health, as the server has it — online, agent, inventory;
 *   6. where to go next: the device, and the business's monitoring.
 *
 * Everything shown in steps 4–6 is what the server reports, never a guess:
 * "waiting" stays "waiting" until a row says otherwise. The raw token exists
 * only in this component's memory, once, as the creation response returns it.
 * The URL carries the token's id (not the token) so a reload keeps waiting.
 *
 * 0.64: step 3 offers each platform's choices as two tabs, "Download
 * installer" and "Command". Windows downloads the one-click .exe (the same
 * GET /public/install/windows.exe?token=… link 0.32 offered only as text to
 * copy, now also a real download button). Linux and macOS download the same
 * script the command pipes into bash, from the same path-token URL, so no new
 * route carries the token and the token rules are unchanged: made once,
 * single use, 24 hours. There is no .pkg (see docs/setup.md).
 *
 * 0.65: Windows also offers a Download .msi button (GET
 * /public/install/windows.msi?token=…, the same token rules: read, never
 * consumed) and the silent msiexec line for Group Policy or Intune. The .msi
 * is fetched rather than linked, so a server that cannot build one (no
 * signed agent, no msitools) says so here instead of downloading an error.
 *
 * Making the link needs a fresh re-authentication (0.33). The server answers
 * STEP_UP_REQUIRED; the api-client interceptor opens the step-up dialog and
 * retries the same request, so every choice made here is still in state and
 * still in the retried body. Cancelling the dialog creates nothing and keeps
 * the choices: the button simply works again.
 */

type Os = 'windows' | 'linux' | 'macos';
type Business = { id: string; name: string };
type Site = { id: string; name: string };
type Member = { userId: string; user: { id: string; email: string; firstName: string; lastName: string } };

type Status = {
  token: {
    id: string; businessId: string | null; businessName: string | null; siteId: string | null; siteName: string | null;
    accessMode: string; description: string | null; createdAt: string; expiresAt: string; claimedAt: string | null;
  };
  state: 'waiting' | 'expired' | 'claiming' | 'enrolled';
  deviceVisible: boolean;
  device: null | {
    id: string; name: string; hostname: string | null; platform: string | null; osVersion: string | null; status: string;
    isOnline: boolean; lastSeenAt: string | null; createdAt: string; agentVersion: string | null; agentVersionView?: AgentVersionView; updateChannel: string | null;
    customerId: string | null; customer: { id: string; name: string } | null; site: { id: string; name: string } | null;
    agentType: 'signed' | 'standard' | 'none'; agentBound: boolean; agentBoundAt: string | null;
    inventoryCollectedAt: string | null; liveSampledAt: string | null; updatesCheckedAt: string | null; osCaption: string | null;
    /** 0.68: the automatic inventory pass, while none has arrived. */
    inventoryAsk?: { status: string; error: string | null; dispatchedAt: string | null; completedAt: string | null } | null;
  };
};

/**
 * Where the first inventory is (0.68). It used to say "not received yet"
 * whatever had happened, including after the request had failed.
 */
export function inventoryDetail(d: NonNullable<Status['device']>): { text: string; failed: boolean } {
  if (d.inventoryCollectedAt) {
    return { text: `received ${ago(d.inventoryCollectedAt)}${d.osCaption ? ` · ${d.osCaption}` : ''}`, failed: false };
  }
  const ask = d.inventoryAsk;
  if (ask && (ask.status === 'FAILED' || ask.status === 'EXPIRED')) {
    return {
      text: `the agent could not collect it${ask.error ? `: ${ask.error}` : ''}. It is asked again within the hour; Refresh inventory on the device's Software tab asks now.`,
      failed: true,
    };
  }
  if (ask?.dispatchedAt) return { text: `asked for ${ago(ask.dispatchedAt)}; it arrives with the agent's next check-in (every 3 minutes)`, failed: false };
  return { text: 'asked for at the agent\u2019s first check-in, which starts as soon as the installer finishes', failed: false };
}

const OS: Record<Os, {
  label: string; shell: string; path: (t: string) => string; cmd: (u: string) => string; agent: string;
  /** 0.64: what the downloaded file is called (the server's Content-Disposition) and how to run it. */
  file: string; runFile: string;
}> = {
  windows: {
    label: 'Windows', shell: 'PowerShell, as Administrator',
    file: 'install-reboot-remote.exe', runFile: 'Run it on the computer and accept the administrator prompt. Nothing else to type.',
    path: (t) => `/api/v1/public/install/win/${t}`, cmd: (u) => `irm ${u} | iex`,
    agent: 'Installs RustDesk and the full Rem0te agent: heartbeat, inventory, monitoring, update scans, and installs, restarts and scripts from the dashboard. (Before this server publishes a signed agent, the standard agent, which can be upgraded later.)',
  },
  linux: {
    label: 'Linux', shell: 'a root shell',
    file: 'install-rustdesk.sh', runFile: 'Copy it to the computer and run: sudo bash install-rustdesk.sh',
    path: (t) => `/api/v1/public/install/linux/${t}`, cmd: (u) => `curl -fsSL ${u} | sudo bash`,
    agent: 'Installs RustDesk and the read-only Linux agent: heartbeat, inventory and pending package updates every 3 minutes. It runs nothing the console sends.',
  },
  macos: {
    label: 'macOS', shell: 'Terminal, with sudo',
    file: 'install-rustdesk-macos.sh', runFile: 'Copy it to the Mac and run in Terminal: sudo bash install-rustdesk-macos.sh',
    path: (t) => `/api/v1/public/install/mac/${t}`, cmd: (u) => `curl -fsSL ${u} | sudo bash`,
    agent: 'Installs RustDesk and, with sudo, the read-only macOS agent: heartbeat, inventory and the updates macOS last found, every 3 minutes. It runs nothing the console sends.',
  },
};

const ID_RE = /^[a-z0-9]{10,40}$/;
/** How long to keep polling for first health after the device appears. */
const HEALTH_WINDOW_MS = 20 * 60_000;

function unwrapList<T>(body: unknown): T[] {
  if (Array.isArray(body)) return body as T[];
  if (body && typeof body === 'object' && Array.isArray((body as { data?: unknown }).data)) return (body as { data: T[] }).data;
  return [];
}

function StepCard({ n, title, done, active, description, children, testId }: {
  n: number; title: string; done: boolean; active: boolean; description?: string; children?: ReactNode; testId: string;
}) {
  return (
    <Card data-testid={testId} data-step-state={done ? 'done' : active ? 'active' : 'pending'} className={active || done ? '' : 'opacity-60'}>
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-base">
          {done ? <CheckCircle2 className="h-5 w-5 text-green-600" aria-label="done" /> : <Circle className={`h-5 w-5 ${active ? 'text-primary' : 'text-muted-foreground'}`} aria-hidden />}
          <span>{n}. {title}</span>
        </CardTitle>
        {description && <CardDescription>{description}</CardDescription>}
      </CardHeader>
      {(active || done) && children && <CardContent className="space-y-4">{children}</CardContent>}
    </Card>
  );
}

/** Why the server would not build the .msi, in words, by its error code. */
const MSI_REFUSED: Record<string, string> = {
  MSI_NEEDS_SIGNED_AGENT: 'This server does not publish the signed agent yet, and the .msi installs only the signed agent. Use the .exe, or the command.',
  MSI_BUILDER_UNAVAILABLE: 'This server cannot build an .msi: the msitools package (wixl, msibuild) is not installed on it. Use the .exe, or the command.',
  MSI_BUSY: 'Other .msi downloads are being built. Try again in a moment.',
  ENROLLMENT_TOKEN_UNUSABLE: 'This link has been used, has expired or was revoked. Make a new one.',
};

/**
 * Download .msi (0.65). Fetched, then saved from memory, so a refusal is shown
 * here rather than saved as a file. Nothing is kept: the object URL is revoked
 * once the browser has it.
 */
function MsiDownload({ url }: { url: string }) {
  const [state, setState] = useState<{ busy: boolean; error: string | null }>({ busy: false, error: null });
  async function download() {
    setState({ busy: true, error: null });
    try {
      const res = await fetch(url, { credentials: 'omit', cache: 'no-store' });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { code?: string; message?: string } | null;
        setState({ busy: false, error: (body?.code && MSI_REFUSED[body.code]) ?? body?.message ?? `The .msi could not be downloaded (HTTP ${res.status}).` });
        return;
      }
      const href = URL.createObjectURL(await res.blob());
      const a = document.createElement('a');
      a.href = href; a.download = 'rem0te.msi'; a.rel = 'noreferrer';
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(href), 10_000);
      setState({ busy: false, error: null });
    } catch {
      setState({ busy: false, error: 'The .msi could not be downloaded. Check the connection and try again.' });
    }
  }
  return (
    <>
      <Button variant="outline" onClick={() => void download()} disabled={state.busy} data-testid="download-msi">
        {state.busy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Download className="mr-2 h-4 w-4" />}
        {state.busy ? 'Building the .msi…' : 'Download .msi'}
      </Button>
      {state.error && <p className="basis-full text-sm text-destructive" role="alert" data-testid="msi-error">{state.error}</p>}
    </>
  );
}

function CopyLine({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex items-start gap-2 rounded border bg-background p-3 font-mono text-sm">
      <span className="min-w-0 flex-1 break-all" data-testid={`copy-${label}`}>{text}</span>
      <Button size="sm" variant="ghost" aria-label={`Copy ${label}`} onClick={() => {
        void navigator.clipboard?.writeText(text).then(() => { setCopied(true); setTimeout(() => setCopied(false), 2000); }).catch(() => {});
      }}>
        {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
      </Button>
    </div>
  );
}

/** One line of first health: done, waiting, or not applicable — never assumed. */
function HealthRow({ ok, waiting, label, detail, testId }: { ok: boolean; waiting?: boolean; label: string; detail: string; testId: string }) {
  return (
    <li className="flex items-start gap-2" data-testid={testId} data-ok={ok ? 'true' : 'false'}>
      {ok ? <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-green-600" />
        : waiting ? <Loader2 className="mt-0.5 h-4 w-4 shrink-0 animate-spin text-muted-foreground" />
          : <Circle className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />}
      <span><strong className="font-medium">{label}</strong> <span className="text-muted-foreground">— {detail}</span></span>
    </li>
  );
}

export function AddDeviceFlow() {
  const qc = useQueryClient();
  const { user, can, isPlatformAdmin, businessId: ownBusinessId } = usePermissions();

  // From the URL, read after mount so the page still prerenders:
  //   endpointId + businessId — re-enrol that computer (from its page);
  //   token + os               — resume waiting for a link made earlier.
  const [endpointId, setEndpointId] = useState<string | null>(null);
  const [businessId, setBusinessId] = useState('');
  const [siteId, setSiteId] = useState('');
  const [accessMode, setAccessMode] = useState<'ASSIGNED_USERS' | 'COMPANY_WIDE'>('ASSIGNED_USERS');
  const [assignedUserIds, setAssignedUserIds] = useState<string[]>([]);
  const [os, setOs] = useState<Os | null>(null);
  const [tokenId, setTokenId] = useState<string | null>(null);
  /** The raw token: in memory only, and only for the link made in this visit. */
  const [rawToken, setRawToken] = useState<string | null>(null);
  const [placeConfirmed, setPlaceConfirmed] = useState(false);
  const askEnrol = useAsks('enrollment.create');

  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    const ep = q.get('endpointId'); if (ep && ID_RE.test(ep)) setEndpointId(ep);
    const biz = q.get('businessId'); if (biz && ID_RE.test(biz)) setBusinessId(biz);
    const tok = q.get('token'); if (tok && ID_RE.test(tok)) { setTokenId(tok); setPlaceConfirmed(true); }
    const o = q.get('os'); if (o === 'windows' || o === 'linux' || o === 'macos') setOs(o);
  }, []);

  // 0.48.2: reinstalling an existing computer. The claim applies the link's
  // access mode and people to the computer, so start from what the computer
  // has now: a reinstall should not quietly change who may connect.
  const existing = useQuery({
    queryKey: ['reinstall-target', endpointId],
    enabled: !!endpointId,
    queryFn: async () => {
      const [ep, acc] = await Promise.all([
        endpointsApi.get(endpointId!).then((r) => r.data?.data as { name?: string; accessMode?: string } | undefined),
        endpointsApi.listAccess(endpointId!).then((r) => (r.data?.data ?? []) as { userId: string }[]).catch(() => [] as { userId: string }[]),
      ]);
      return { name: ep?.name ?? null, accessMode: ep?.accessMode === 'COMPANY_WIDE' ? 'COMPANY_WIDE' as const : 'ASSIGNED_USERS' as const, userIds: acc.map((a) => a.userId) };
    },
  });
  const [prefilled, setPrefilled] = useState(false);
  useEffect(() => {
    if (prefilled || !existing.data) return;
    setAccessMode(existing.data.accessMode);
    setAssignedUserIds(existing.data.userIds);
    setPrefilled(true);
  }, [existing.data, prefilled]);

  // A person pinned to one business (owner, user, technician acting in one) has no choice to make.
  useEffect(() => { if (!businessId && ownBusinessId) setBusinessId(ownBusinessId); }, [ownBusinessId, businessId]);

  const { data: businesses = [] } = useQuery({
    queryKey: ['businesses', ''],
    queryFn: () => businessesApi.list().then((r) => unwrapList<Business>(r.data)),
  });
  const { data: sites = [] } = useQuery({
    queryKey: ['sites-for-business', businessId],
    queryFn: () => sitesApi.list(businessId).then((r) => unwrapList<Site>(r.data)),
    enabled: !!businessId,
  });
  // Only members of the chosen business can be pre-assigned; the server rejects anyone else regardless.
  const { data: members = [] } = useQuery({
    queryKey: ['members-for-token', businessId],
    queryFn: () => usersApi.list(businessId).then((r) => unwrapList<Member>(r.data)),
    enabled: !!businessId && accessMode === 'ASSIGNED_USERS',
  });

  const business = businesses.find((b) => b.id === businessId) ?? null;
  const site = sites.find((s) => s.id === siteId) ?? null;
  const placeReady = !!businessId && (accessMode === 'COMPANY_WIDE' || assignedUserIds.length > 0);
  const step1Done = placeConfirmed;
  const step2Done = step1Done && !!os && !!tokenId;

  const create = useMutation({
    mutationFn: () => enrollmentApi.createToken({
      businessId,
      ...(endpointId ? { endpointId } : {}),
      ...(siteId && !endpointId ? { siteId } : {}),
      accessMode,
      assignedUserIds: accessMode === 'ASSIGNED_USERS' ? assignedUserIds : [],
      description: `Add device: ${OS[os!].label}${endpointId ? ' (re-enrol)' : ''}`,
    }).then((r) => r.data?.data as { id: string; token: string; expiresAt: string }),
    onSuccess: (t) => {
      setRawToken(t.token);
      setTokenId(t.id);
      const q = new URLSearchParams({ token: t.id, os: os! });
      window.history.replaceState(null, '', `${window.location.pathname}?${q}`);
    },
  });

  const statusQ = useQuery<Status>({
    queryKey: ['enrol-token-status', tokenId],
    queryFn: () => enrollmentApi.tokenStatus(tokenId!).then((r) => r.data.data as Status),
    enabled: !!tokenId,
    retry: false,
    refetchInterval: (query) => {
      const s = query.state.data;
      if (query.state.error) return false;
      if (!s) return 4000;
      if (s.state === 'waiting' || s.state === 'claiming') return 4000;
      if (s.state === 'expired' || !s.device) return false;
      // Enrolled: keep checking until the first health is in, for a while.
      const since = Date.now() - new Date(s.token.claimedAt ?? s.device.createdAt).getTime();
      if (since > HEALTH_WINDOW_MS) return false;
      const isWindows = String(s.device.platform ?? '').toLowerCase() === 'windows';
      const complete = s.device.isOnline && (!isWindows || (s.device.agentType !== 'none' && !!s.device.inventoryCollectedAt));
      return complete ? false : 10_000;
    },
  });
  const status = statusQ.data ?? null;
  const statusErr = statusQ.error ? apiError(statusQ.error) : null;

  // On resume, the business and site come from the token itself.
  useEffect(() => {
    if (status?.token.businessId && !businessId) setBusinessId(status.token.businessId);
  }, [status, businessId]);

  const revoke = useMutation({
    mutationFn: () => enrollmentApi.revokeToken(tokenId!),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['enrol-token-status', tokenId] }),
  });

  const device = status?.device ?? null;
  const enrolled = status?.state === 'enrolled';
  const isWindows = device ? String(device.platform ?? '').toLowerCase() === 'windows' : os === 'windows';
  // Platforms whose installer adds an agent that heartbeats: Windows, Linux
  // (0.32) and macOS (0.33, when run with sudo). The others register once.
  const devicePlatform = device ? String(device.platform ?? '').toLowerCase() : (os ?? '');
  const heartbeats = isWindows || /^(linux|macos|mac|darwin)/.test(devicePlatform);
  const agent = device ? agentType(device as unknown as Record<string, unknown>) : null;
  const monitoring = useMonitoringView(device?.id ?? '', !!device && can(CAP.COMPUTERS_VIEW));

  const commands = useMemo(() => {
    if (!rawToken || !os) return null;
    const base = window.location.origin;
    const url = `${base}${OS[os].path(rawToken)}`;
    return {
      command: OS[os].cmd(url),
      // 0.64: what the Download button fetches. Windows: the one-click .exe
      // (its existing route and query). Linux and macOS: the very script the
      // command fetches, from the same path-token URL; the server already
      // sends it as an attachment.
      download: os === 'windows' ? `${base}/api/v1/public/install/windows.exe?token=${encodeURIComponent(rawToken)}` : url,
      // 0.65: the .msi with this link's token in it, and the silent line that
      // passes the token itself (for the generic package, or as written).
      msi: `${base}/api/v1/public/install/windows.msi?token=${encodeURIComponent(rawToken)}`,
      msiexec: `msiexec /i rem0te.msi TOKEN=${rawToken} /qn`,
    };
  }, [rawToken, os]);

  function startOver() {
    setTokenId(null); setRawToken(null); setPlaceConfirmed(false); setOs(null); setSiteId('');
    create.reset(); revoke.reset();
    window.history.replaceState(null, '', window.location.pathname);
  }

  if (!user) return null;
  if (!can(CAP.COMPUTERS_ADD)) {
    return <p className="text-sm text-muted-foreground">Adding a device needs the Add computers permission.</p>;
  }

  const lockedBusiness = !!ownBusinessId || !!endpointId;
  const businessLabel = business?.name ?? status?.token.businessName ?? (businessId ? 'the selected business' : '—');

  return (
    <div className="space-y-4" data-testid="add-device-flow">
      {endpointId && (
        <div className="rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm space-y-1" data-testid="reinstall-banner">
          <p className="font-medium">Reinstalling the agent on {existing.data?.name ?? 'an existing computer'}</p>
          <p>
            The link below is made for this one computer. Download and run it on that computer only, as an administrator.
            It replaces the agent, gives the machine a new device secret, and re-attaches it to the same record: its history,
            site, groups and settings are kept, and no duplicate appears in the device list. Who may connect is filled in from
            the computer&rsquo;s current access below; change it only if you mean to. The link works once and expires after 24 hours.
          </p>
        </div>
      )}

      {/* 1 — where it lands */}
      <StepCard n={1} testId="step-place" title="Business and site" active={!step1Done} done={step1Done}
        description="Fixed when the link is made: the computer that runs it cannot choose a different business or site.">
        {step1Done ? (
          <p className="text-sm" data-testid="place-summary">
            <strong>{businessLabel}</strong>
            {' · '}{endpointId ? 'site unchanged' : (site?.name ?? status?.token.siteName ?? 'no site')}
            {' · '}{(status?.token.accessMode ?? accessMode) === 'COMPANY_WIDE' ? 'everyone in the business may connect' : 'only the chosen people may connect'}
          </p>
        ) : (
          <>
            <div className="grid gap-4 md:grid-cols-2">
              <div className="space-y-1">
                <Label htmlFor="ad-business">Business</Label>
                <select id="ad-business" className="w-full rounded-md border bg-background p-2 text-sm" value={businessId} disabled={lockedBusiness}
                  onChange={(e) => { setBusinessId(e.target.value); setSiteId(''); setAssignedUserIds([]); }}>
                  <option value="">Choose a business…</option>
                  {businesses.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
                  {businessId && !business && <option value={businessId}>{status?.token.businessName ?? 'Current business'}</option>}
                </select>
                {businesses.length === 0 && <p className="text-xs text-muted-foreground">No businesses yet. Create one under Settings › Businesses.</p>}
              </div>
              {!endpointId && (
                <div className="space-y-1">
                  <Label htmlFor="ad-site">Site</Label>
                  <select id="ad-site" className="w-full rounded-md border bg-background p-2 text-sm" value={siteId} disabled={!businessId} onChange={(e) => setSiteId(e.target.value)}>
                    <option value="">No site</option>
                    {sites.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                  </select>
                  {businessId && sites.length === 0 && <p className="text-xs text-muted-foreground">This business has no sites. The device can be given one later from its page.</p>}
                </div>
              )}
            </div>

            <fieldset className="space-y-2">
              <legend className="text-sm font-medium">Who may connect</legend>
              <label className="flex cursor-pointer items-start gap-2 text-sm">
                <input type="radio" name="ad-access" className="mt-1" checked={accessMode === 'ASSIGNED_USERS'} onChange={() => setAccessMode('ASSIGNED_USERS')} />
                <span><strong>Specific people</strong><br /><span className="text-xs text-muted-foreground">Only the people chosen below see it under My devices. Owners and technicians are unaffected.</span></span>
              </label>
              <label className="flex cursor-pointer items-start gap-2 text-sm">
                <input type="radio" name="ad-access" className="mt-1" checked={accessMode === 'COMPANY_WIDE'} onChange={() => setAccessMode('COMPANY_WIDE')} />
                <span><strong>Everyone in the business</strong><br /><span className="text-xs text-muted-foreground">Every active user of the business can connect (still subject to their sign-in rules).</span></span>
              </label>
              {accessMode === 'ASSIGNED_USERS' && (
                <div className="max-h-56 space-y-1 overflow-y-auto rounded-md border p-3">
                  {members.length === 0 && <p className="text-sm text-muted-foreground">{businessId ? 'No users in this business yet.' : 'Choose a business first.'}</p>}
                  {members.map((m) => (
                    <label key={m.userId} className="flex cursor-pointer items-center gap-2 py-1 text-sm">
                      <input type="checkbox" checked={assignedUserIds.includes(m.userId)}
                        onChange={() => setAssignedUserIds((cur) => (cur.includes(m.userId) ? cur.filter((u) => u !== m.userId) : [...cur, m.userId]))} />
                      <span>{m.user.firstName} {m.user.lastName}<span className="ml-2 text-muted-foreground">{m.user.email}</span></span>
                    </label>
                  ))}
                </div>
              )}
            </fieldset>
            <Button disabled={!placeReady} onClick={() => setPlaceConfirmed(true)} data-testid="place-next">Continue</Button>
          </>
        )}
      </StepCard>

      {/* 2 — operating system, and 3 — the command */}
      <StepCard n={2} testId="step-os" title="Operating system" active={step1Done && !tokenId} done={step2Done}>
        {tokenId ? (
          <p className="text-sm">{os ? OS[os].label : 'Not recorded'} — {os ? OS[os].agent : ''}</p>
        ) : (
          <>
            <div className="grid gap-2 sm:grid-cols-3" role="radiogroup" aria-label="Operating system">
              {(Object.keys(OS) as Os[]).map((o) => (
                <label key={o} className={`cursor-pointer rounded-md border p-3 text-sm ${os === o ? 'border-primary bg-primary/5' : ''}`}>
                  <input type="radio" name="ad-os" className="mr-2" checked={os === o} onChange={() => setOs(o)} />
                  <strong>{OS[o].label}</strong>
                  <span className="mt-1 block text-xs text-muted-foreground">{OS[o].agent}</span>
                </label>
              ))}
            </div>
            {create.error && (apiError(create.error).code === 'STEP_UP_REQUIRED' ? (
              <p className="text-sm text-amber-700 dark:text-amber-400" data-testid="create-stepup-cancelled">
                No link was made: making one needs you to confirm it&apos;s you. Your choices are kept — press the button again when ready.
              </p>
            ) : (
              <p className="text-sm text-destructive" data-testid="create-error">{apiError(create.error, 'Could not make the link').message}</p>
            ))}
            <p className="text-xs text-muted-foreground" data-testid="create-stepup-note">
              {askEnrol ? (
                <>
                  You will be asked to confirm it&apos;s you (password, authenticator code or passkey) unless you did in the last 10 minutes:
                  an install link adds a computer to {businessLabel}.
                </>
              ) : (
                <>An install link adds a computer to {businessLabel}.</>
              )}
            </p>
            <div className="flex flex-wrap gap-2">
              <Button disabled={!os || create.isPending} onClick={() => create.mutate()} data-testid="make-link">
                {create.isPending ? 'Making the link…' : 'Make the install command'}
              </Button>
              <Button variant="outline" onClick={() => setPlaceConfirmed(false)}>Back</Button>
            </div>
          </>
        )}
      </StepCard>

      <StepCard n={3} testId="step-command" title="Run the installer" active={!!tokenId && !enrolled} done={enrolled}
        description={os && !enrolled ? `Download the installer, or copy the command, and run it once on the computer. Single-use; expires ${status ? formatDate(status.token.expiresAt) : 'in 24 hours'}.` : undefined}>
        {enrolled ? (
          <p className="text-sm text-muted-foreground">The link has been used and cannot enrol another computer.</p>
        ) : commands && os ? (
          <>
            <Tabs defaultValue="download" className="space-y-3" data-testid="install-choices">
              <TabsList aria-label="How to install">
                <TabsTrigger value="download" data-testid="tab-download"><Download className="mr-1.5 h-4 w-4" />Download installer</TabsTrigger>
                <TabsTrigger value="command" data-testid="tab-command"><Terminal className="mr-1.5 h-4 w-4" />Command</TabsTrigger>
              </TabsList>
              <TabsContent value="download" className="mt-0 space-y-3">
                <div className="flex flex-wrap items-center gap-3">
                  <Button asChild>
                    {/* A plain same-origin download: the browser fetches it once, nothing is kept here. */}
                    <a href={commands.download} download={OS[os].file} data-testid="download-installer" rel="noreferrer">
                      <Download className="mr-2 h-4 w-4" />
                      {os === 'windows' ? 'Download .exe' : `Download ${OS[os].label} installer (.sh)`}
                    </a>
                  </Button>
                  {os === 'windows' && <MsiDownload url={commands.msi} />}
                  <span className="text-xs text-muted-foreground">{os === 'windows' ? `${OS[os].file} · rem0te.msi` : OS[os].file}</span>
                </div>
                <p className="text-sm">{OS[os].runFile}</p>
                {os === 'windows' && (
                  <div className="space-y-1">
                    <p className="text-xs text-muted-foreground">Or send this link to the person at the computer: it downloads the same installer.</p>
                    <CopyLine text={commands.download} label="link" />
                  </div>
                )}
                {os === 'windows' && (
                  <div className="space-y-1" data-testid="msi-note">
                    <p className="text-xs text-muted-foreground">
                      The .msi installs the same signed agent, silently, as SYSTEM. Run it on this computer with:
                    </p>
                    <CopyLine text={commands.msiexec} label="msiexec" />
                    <p className="text-xs text-muted-foreground">
                      The downloaded .msi already carries this link&rsquo;s token; the line above passes it too. Uninstalling
                      the .msi removes only its own entry in Programs and Features, never the agent: remove a computer from
                      the console. <strong>The .msi has not yet been run on real Windows.</strong> For many computers at once
                      use a deployment key as the TOKEN, from Group Policy, Intune or another RMM
                      {isPlatformAdmin ? <>: <Link href="/admin/deploy" className="underline">Deploy agents</Link>.</> : ' (a Platform Admin makes one under Devices → Deploy agents).'}
                    </p>
                  </div>
                )}
              </TabsContent>
              <TabsContent value="command" className="mt-0 space-y-2">
                <p className="text-xs text-muted-foreground">Paste into {OS[os].shell} on the computer.</p>
                <CopyLine text={commands.command} label="command" />
              </TabsContent>
            </Tabs>
            <p className="text-xs text-muted-foreground">The installer, the link and the command all carry the enrolment token and are shown only now. Anyone holding one can enrol one computer into {businessLabel} until it is used or expires.</p>
          </>
        ) : tokenId ? (
          <p className="text-sm text-muted-foreground">The install command is shown only once, when the link is made. If it was lost, revoke this link and make a new one.</p>
        ) : null}
      </StepCard>

      {/* 4 — wait for it */}
      <StepCard n={4} testId="step-wait" title="Wait for the device" active={!!tokenId && !enrolled} done={enrolled}>
        {statusErr ? (
          <div className="space-y-2 text-sm" data-testid="wait-error">
            <p className="flex items-center gap-2 text-destructive"><XCircle className="h-4 w-4" />{statusErr.status === 404 ? 'This link no longer exists: it was revoked, or it belongs to a business you cannot see.' : statusErr.message}</p>
            <Button size="sm" variant="outline" onClick={startOver}>Make a new link</Button>
          </div>
        ) : !status ? (
          <p className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" />Checking…</p>
        ) : status.state === 'expired' ? (
          <div className="space-y-2 text-sm" data-testid="wait-expired">
            <p className="text-destructive">This link expired at {formatDate(status.token.expiresAt)} without being used. Nothing was enrolled.</p>
            <Button size="sm" variant="outline" onClick={startOver}>Make a new link</Button>
          </div>
        ) : status.state === 'waiting' || status.state === 'claiming' ? (
          <div className="space-y-3 text-sm" data-testid="wait-waiting">
            <p className="flex items-center gap-2"><Loader2 className="h-4 w-4 animate-spin" />
              {status.state === 'claiming' ? 'The installer has used the link; the device is being enrolled…' : 'Waiting for the installer to use this link. This page checks every few seconds.'}
            </p>
            {revoke.error && <p className="text-destructive">{apiError(revoke.error).message}</p>}
            {status.state === 'waiting' && can(CAP.COMPUTERS_REMOVE) && (
              <Button size="sm" variant="outline" disabled={revoke.isPending}
                onClick={() => { if (window.confirm('Revoke this link? Any computer that has not yet run it will be refused.')) revoke.mutate(); }}>
                Revoke this link
              </Button>
            )}
          </div>
        ) : (
          <p className="text-sm" data-testid="wait-enrolled">
            Enrolled {formatDate(status.token.claimedAt)}{device ? <> as <strong>{device.name}</strong></> : null}.
          </p>
        )}
      </StepCard>

      {/* 5 — first health */}
      <StepCard n={5} testId="step-health" title="First health" active={enrolled} done={false}
        description={enrolled ? 'What the server has received from the device so far. It fills in over the first few minutes.' : undefined}>
        {enrolled && !status?.deviceVisible && (
          <p className="text-sm text-muted-foreground" data-testid="health-hidden">
            The device enrolled, but you cannot see it: it was assigned to specific people and you are not one of them.
          </p>
        )}
        {device && (
          <ul className="space-y-2 text-sm" data-testid="health-list">
            <HealthRow testId="health-place" ok={!!device.customer} label="Business and site"
              detail={`${device.customer?.name ?? 'none'} · ${device.site?.name ?? 'no site'}`} />
            <HealthRow testId="health-online" ok={connectivityOf(device.isOnline, device.lastSeenAt) === 'online'} waiting={connectivityOf(device.isOnline, device.lastSeenAt) !== 'online'}
              label={connectivityLabel(connectivityOf(device.isOnline, device.lastSeenAt), device.lastSeenAt)} detail={`last check-in ${ago(device.lastSeenAt)}`} />
            {heartbeats ? (
              <>
                <HealthRow testId="health-agent" ok={device.agentType !== 'none'} waiting={device.agentType === 'none'}
                  label={device.agentType === 'none' ? 'Agent' : (agent?.label ?? 'Agent')}
                  detail={device.agentType === 'none' ? 'waiting for its first heartbeat (every 3 minutes)' : `version ${shownAgentVersion(device.agentVersionView, device.agentVersion) ?? 'unknown'}`} />
                <HealthRow testId="health-identity" ok={device.agentBound} label="Device identity"
                  detail={device.agentBound ? `bound ${ago(device.agentBoundAt)}` : 'not bound — the installer did not send a device secret, so nothing it reports is trusted'} />
                <HealthRow testId="health-inventory" ok={!!device.inventoryCollectedAt} waiting={!device.inventoryCollectedAt && !inventoryDetail(device).failed}
                  label="Inventory" detail={inventoryDetail(device).text} />
              </>
            ) : (
              <HealthRow testId="health-agent" ok={false} label="Agent"
                detail={agent?.explanation ?? 'Remote access only on this platform.'} />
            )}
          </ul>
        )}
      </StepCard>

      {/* 6 — next */}
      <StepCard n={6} testId="step-next" title="Next" active={enrolled} done={false}>
        <div className="space-y-3 text-sm">
          {device && monitoring.data && (
            <p data-testid="next-monitors">
              {monitoring.data.rules.length === 0
                ? 'No monitors apply to this device yet.'
                : `${monitoring.data.rules.length} monitor${monitoring.data.rules.length === 1 ? '' : 's'} apply: ${monitoring.data.rules.slice(0, 4).map((r) => `${r.name} (${describeMonitor(r.kind, r.params)})`).join('; ')}${monitoring.data.rules.length > 4 ? '…' : ''}.`}
              {!isWindows && (heartbeats
                ? ' Service and event-log monitors need the Windows agent; offline, disk, CPU and memory monitors use what this device\u2019s agent reports.'
                : ' Monitoring needs the Windows agent, so none of them report from this device.')}
            </p>
          )}
          <div className="flex flex-wrap gap-2">
            {device && <Button asChild><Link href={`/endpoints/${device.id}`} data-testid="next-device">Open the device</Link></Button>}
            {device && <Button variant="outline" asChild><Link href={`/endpoints/${device.id}?tab=monitoring`}>Its monitoring</Link></Button>}
            {(device?.customerId ?? status?.token.businessId) && (
              <Button variant="outline" asChild>
                <Link href={`/settings/monitoring?businessId=${encodeURIComponent((device?.customerId ?? status?.token.businessId)!)}`} data-testid="next-policies">Business monitoring policies</Link>
              </Button>
            )}
            <Button variant="ghost" onClick={startOver} data-testid="add-another">Add another device</Button>
          </div>
        </div>
      </StepCard>

      <p className="text-xs text-muted-foreground">
        Already running RustDesk and only need it in the list, without an install?{' '}
        <Link href="/endpoints/new" className="underline">Register it by RustDesk ID</Link> instead.
      </p>
    </div>
  );
}
