'use client';

/**
 * Admin → Security (rewritten in 0.74). Platform Admin only.
 *
 * Every panel shows three states apart: what was read and is fine, what was
 * read and is not, and what could not be read. "Could not be read" is always
 * Unknown, in grey with a question mark, and never green: before 0.74 a
 * loading or failed fail2ban read showed "Stopped", a failed apt read "System
 * up to date", no certificates a green dot, and an ESLint run that linted
 * nothing "no issues".
 *
 * Settings that live elsewhere are linked, not repeated: Confirm it is you
 * (Settings), audit integrity (Containment), signed releases (Update
 * signing), SSO and break-glass (Admin → SSO), API keys.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  AlertTriangle, CheckCircle2, CircleHelp, Info, Loader2, Lock, Package, RefreshCw, ShieldAlert, ShieldCheck, XCircle,
} from 'lucide-react';
import { securityApi } from '@/lib/api-client';
import { PageHeader } from '@/components/common/page-header';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { SecurityFeaturesTab } from '@/components/security-controls/security-features';
import { apiError, Chip, CHIP } from '@/components/security-controls/shared';
import { cn } from '@/lib/utils';

// ─── Shapes (apps/api/src/admin/security.service.ts) ─────────────────────────

type FindingStatus = 'pass' | 'fail' | 'unknown' | 'info';
type Severity = 'critical' | 'high' | 'medium' | 'low' | 'info';
interface Finding {
  id: string; area: 'host' | 'network' | 'web' | 'portal' | 'process'; title: string; status: FindingStatus; severity: Severity;
  evidence: string; checkedAt: string; fix?: string; link?: string;
}
interface Posture {
  generatedAt: string;
  summary: { score: number | null; grade: 'good' | 'fair' | 'poor' | 'unknown'; counts: Record<FindingStatus, number>; failing: Record<Severity, number>; coverage: number };
  findings: Finding[];
}
interface Jail { jail: string; error: string | null; currentFailed?: number | null; totalFailed?: number | null; currentBanned?: number; totalBanned?: number; bannedIps?: string[]; journalMatches?: string | null; fileList?: string | null }
interface Fail2ban { state: 'running' | 'stopped' | 'not_installed' | 'unavailable'; reason: string | null; checkedAt: string; jails: Jail[] }
interface AptPackage { name: string; suites: string[]; version: string; from: string | null; security: boolean }
interface OsUpdates {
  state: 'ok' | 'unavailable'; reason: string | null; checkedAt: string; total: number | null; security: number | null; packages: AptPackage[];
  listsUpdatedAt: string | null; rebootRequired: boolean; rebootPackages: string[]; kernel: string;
  unattended: { configured: { updateLists: boolean; unattended: boolean } | null; serviceActive: boolean | null };
}
interface UpdateJob { running: boolean; phase: string | null; lines: string[]; exitCode: number | null; startedAt: string | null; finishedAt: string | null }
interface Tls { checkedAt: string; caddyActive: boolean | null; caddyfileReadable: boolean; certs: Array<{ domain: string; expiresAt: string | null; daysLeft: number | null; level: string; issuer: string | null; trusted: boolean; nameMatches: boolean; error: string | null }> }
interface DepAudit {
  state: 'ok' | 'unavailable'; reason: string | null; scannedAt: string; scope: string;
  audit: { counts: Record<'critical' | 'high' | 'moderate' | 'low' | 'info', number>; dependencies: number | null; packages: Array<{ name: string; severity: string; direct: boolean; fixAvailable: boolean; titles: string[] }> } | null;
}
interface Config {
  maxLoginAttempts: number; lockoutMinutes: number;
  unenforced: { geoipBlockEnabled: boolean; ipAllowlistEnabled: boolean; blockedCountries: string[]; blockedIpRanges: string[]; allowedIpRanges: string[] };
}

// ─── Small pieces ────────────────────────────────────────────────────────────

const data = <T,>(p: Promise<{ data?: { data?: T } }>) => p.then((r) => r.data?.data as T);
const when = (iso: string | null | undefined) => (iso ? new Date(iso).toLocaleString() : 'never');

/** One status vocabulary for the whole page. Unknown is grey with a question mark, never green. */
const STATUS_UI: Record<FindingStatus, { label: string; chip: string; Icon: typeof CheckCircle2 }> = {
  pass: { label: 'OK', chip: CHIP.on, Icon: CheckCircle2 },
  fail: { label: 'Needs attention', chip: CHIP.bad, Icon: XCircle },
  unknown: { label: 'Unknown', chip: CHIP.off, Icon: CircleHelp },
  info: { label: 'Info', chip: CHIP.request, Icon: Info },
};
const SEV_CHIP: Record<Severity, string> = { critical: CHIP.bad, high: CHIP.bad, medium: CHIP.warn, low: CHIP.request, info: CHIP.off };

function StatusChip({ status, label }: { status: FindingStatus; label?: string }) {
  const s = STATUS_UI[status];
  return <Chip className={s.chip}><s.Icon className="h-3 w-3" aria-hidden />{label ?? s.label}</Chip>;
}

function ErrorCard({ what, error, onRetry }: { what: string; error: unknown; onRetry?: () => void }) {
  return (
    <Card role="alert" data-testid="security-error">
      <CardContent className="flex flex-col gap-3 py-6 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-start gap-2 text-sm">
          <CircleHelp className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
          <span><span className="font-medium">Could not load {what}.</span> <span className="text-muted-foreground">{apiError(error).message}</span> Nothing here is shown as fine until it loads.</span>
        </div>
        {onRetry && <Button size="sm" variant="outline" onClick={onRetry}>Try again</Button>}
      </CardContent>
    </Card>
  );
}

function Loading({ what }: { what: string }) {
  return <p className="flex items-center gap-2 text-sm text-muted-foreground" data-testid="security-loading"><Loader2 className="h-4 w-4 animate-spin" aria-hidden />Reading {what}…</p>;
}

function Checked({ at, onRefresh, busy }: { at?: string | null; onRefresh?: () => void; busy?: boolean }) {
  return (
    <div className="flex items-center gap-2 text-xs text-muted-foreground">
      <span>Read {when(at)}</span>
      {onRefresh && (
        <Button variant="outline" size="sm" className="h-7 px-2" onClick={onRefresh} disabled={busy} aria-label="Read again">
          <RefreshCw className={cn('h-3.5 w-3.5', busy && 'animate-spin')} aria-hidden />
        </Button>
      )}
    </div>
  );
}

function Mutation({ m, ok }: { m: { isError: boolean; isSuccess: boolean; error: unknown }; ok?: string }) {
  if (m.isError) return <p className="text-sm text-destructive" role="alert">{apiError(m.error).message}</p>;
  if (m.isSuccess && ok) return <p className="text-sm text-green-700 dark:text-green-400">{ok}</p>;
  return null;
}

/** The command for a check the portal is deliberately unable to make (§56: the API never names the release host's keys or commands). */
const MANUAL: Record<string, string> = {
  'portal.release_root_keys': 'sudo rem0te-signed-status',
};

// ─── Overview ────────────────────────────────────────────────────────────────

const AREAS: Array<[Finding['area'], string]> = [['host', 'This server'], ['network', 'Network'], ['web', 'Web and TLS'], ['portal', 'Rem0te'], ['process', 'API process']];

function OverviewTab() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['security-posture'], queryFn: () => data<Posture>(securityApi.getPosture()), staleTime: 60_000 });
  const refresh = useMutation({
    mutationFn: () => data<Posture>(securityApi.getPosture(true)),
    onSuccess: (d) => qc.setQueryData(['security-posture'], d),
  });
  const [filter, setFilter] = useState<'attention' | 'all'>('attention');

  if (q.isLoading) return <Loading what="this server's security posture" />;
  if (q.isError || !q.data) return <ErrorCard what="the security posture" error={q.error} onRetry={() => q.refetch()} />;
  const { summary, findings } = q.data;
  const shown = filter === 'all' ? findings : findings.filter((f) => f.status === 'fail' || f.status === 'unknown');
  const grade = summary.grade;
  const gradeChip = grade === 'good' ? CHIP.on : grade === 'fair' ? CHIP.warn : grade === 'poor' ? CHIP.bad : CHIP.off;

  return (
    <div className="space-y-4">
      <Card data-testid="security-score" data-grade={grade}>
        <CardContent className="flex flex-col gap-4 py-5 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center gap-4">
            <div className={cn('flex h-16 w-16 shrink-0 items-center justify-center rounded-full text-xl font-semibold', gradeChip)} aria-label="Security score">
              {summary.score ?? '?'}
            </div>
            <div className="min-w-0 space-y-1">
              <p className="text-sm font-medium">
                {grade === 'unknown' ? 'Not enough could be read to score this server' : `Posture: ${grade}`}
              </p>
              <p className="text-xs text-muted-foreground">
                {summary.counts.fail} need attention · {summary.counts.unknown} unknown · {summary.counts.pass} OK.
                {' '}The score counts only what could be read ({summary.coverage}% of the checks); unknown is never counted as OK.
              </p>
              {summary.failing.critical > 0 && <p className="text-xs font-medium text-red-700 dark:text-red-400">{summary.failing.critical} critical finding{summary.failing.critical === 1 ? '' : 's'}.</p>}
            </div>
          </div>
          <Checked at={q.data.generatedAt} onRefresh={() => refresh.mutate()} busy={refresh.isPending} />
        </CardContent>
      </Card>
      {refresh.isError && <ErrorCard what="a fresh reading" error={refresh.error} />}

      <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Show">
        <Button size="sm" variant={filter === 'attention' ? 'default' : 'outline'} onClick={() => setFilter('attention')} data-testid="findings-attention">Needs attention or unknown ({summary.counts.fail + summary.counts.unknown})</Button>
        <Button size="sm" variant={filter === 'all' ? 'default' : 'outline'} onClick={() => setFilter('all')} data-testid="findings-all">All checks ({findings.length})</Button>
      </div>

      {AREAS.map(([area, label]) => {
        const rows = shown.filter((f) => f.area === area);
        if (!rows.length) return null;
        return (
          <Card key={area}>
            <CardHeader className="pb-2"><CardTitle className="text-sm">{label}</CardTitle></CardHeader>
            <CardContent className="divide-y p-0">
              {rows.map((f) => <FindingRow key={f.id} f={f} />)}
            </CardContent>
          </Card>
        );
      })}
      {!shown.length && <Card><CardContent className="py-6 text-sm text-muted-foreground">Nothing needs attention and nothing is unknown. Choose All checks to see what was checked.</CardContent></Card>}

      <Card>
        <CardContent className="space-y-1 py-4 text-xs text-muted-foreground">
          <p className="font-medium text-foreground">Kept elsewhere, not repeated here</p>
          <p>
            Which actions ask you to confirm it is you: <Link className="underline" href="/settings">Settings → Confirm it is you</Link>.
            {' '}Audit integrity and containment: <Link className="underline" href="/settings/security/containment">Settings → Security → Containment</Link>.
            {' '}Signed agent releases: <Link className="underline" href="/settings/security/update-signing">Update signing</Link>.
            {' '}Single sign-on and break-glass accounts: <Link className="underline" href="/admin/sso">Admin → SSO</Link>.
            {' '}API keys: <Link className="underline" href="/settings/api-keys">Settings → API keys</Link>.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}

function FindingRow({ f }: { f: Finding }) {
  return (
    <div className="space-y-1 px-4 py-3 sm:px-6" data-testid={`finding-${f.id}`} data-status={f.status}>
      <div className="flex flex-wrap items-center gap-2">
        <StatusChip status={f.status} />
        {(f.status === 'fail' || f.status === 'unknown') && f.severity !== 'info' && <Chip className={SEV_CHIP[f.severity]}>{f.severity}</Chip>}
        <span className="text-sm font-medium break-words">{f.title}</span>
      </div>
      <p className="text-xs text-muted-foreground break-words">{f.evidence}</p>
      {f.fix && f.status !== 'pass' && <p className="text-xs break-words"><span className="font-medium">Fix:</span> {f.fix}</p>}
      {MANUAL[f.id] && (
        <p className="text-xs">Run on the server: <code className="rounded bg-muted px-1 py-0.5 font-mono">{MANUAL[f.id]}</code></p>
      )}
      <div className="flex flex-wrap items-center gap-3 text-[11px] text-muted-foreground">
        <span>Read {when(f.checkedAt)}</span>
        {f.link && <Link href={f.link} className="underline">Open the setting</Link>}
      </div>
    </div>
  );
}

// ─── Access rules ────────────────────────────────────────────────────────────

function AccessRulesTab() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['security-config'], queryFn: () => data<Config>(securityApi.getConfig()) });
  const [max, setMax] = useState('');
  const [minutes, setMinutes] = useState('');
  useEffect(() => { if (q.data) { setMax(String(q.data.maxLoginAttempts)); setMinutes(String(q.data.lockoutMinutes)); } }, [q.data]);
  const done = (d: Config) => { qc.setQueryData(['security-config'], d); qc.invalidateQueries({ queryKey: ['security-posture'] }); };
  const save = useMutation({ mutationFn: () => data<Config>(securityApi.updateConfig({ maxLoginAttempts: Number(max), lockoutMinutes: Number(minutes) })), onSuccess: done });
  const clear = useMutation({ mutationFn: () => data<Config>(securityApi.updateConfig({ clearUnenforced: true })), onSuccess: done });

  if (q.isLoading) return <Loading what="the access rules" />;
  if (q.isError || !q.data) return <ErrorCard what="the access rules" error={q.error} onRetry={() => q.refetch()} />;
  const u = q.data.unenforced;
  const stored = u.geoipBlockEnabled || u.ipAllowlistEnabled || u.blockedCountries.length + u.blockedIpRanges.length + u.allowedIpRanges.length > 0;
  const valid = /^\d+$/.test(max) && Number(max) <= 100 && /^\d+$/.test(minutes) && Number(minutes) >= 1 && Number(minutes) <= 1440;

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader><CardTitle className="text-sm">Sign-in lockout</CardTitle></CardHeader>
        <CardContent className="space-y-4">
          <p className="text-xs text-muted-foreground">
            Enforced by the API for every account, in the database, so a restart forgets nothing. Allowing more attempts,
            a shorter lockout or turning it off (0) may ask you to confirm it is you; tightening never does.
          </p>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div className="space-y-1">
              <Label htmlFor="max-attempts" className="text-xs">Failed attempts before an account locks (0 turns it off)</Label>
              <Input id="max-attempts" inputMode="numeric" value={max} onChange={(e) => setMax(e.target.value.trim())} />
            </div>
            <div className="space-y-1">
              <Label htmlFor="lockout-minutes" className="text-xs">Lockout, in minutes (1–1440)</Label>
              <Input id="lockout-minutes" inputMode="numeric" value={minutes} onChange={(e) => setMinutes(e.target.value.trim())} />
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <Button onClick={() => save.mutate()} disabled={!valid || save.isPending} data-testid="save-lockout">
              {save.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden />}Save
            </Button>
            {!valid && <span className="text-xs text-destructive">Attempts 0–100, minutes 1–1440.</span>}
            <Mutation m={save} ok="Saved." />
          </div>
        </CardContent>
      </Card>

      <Card data-testid="unenforced-rules">
        <CardHeader><CardTitle className="flex items-center gap-2 text-sm"><AlertTriangle className="h-4 w-4 text-amber-600" aria-hidden />GeoIP blocking and IP allow / block lists: not enforced</CardTitle></CardHeader>
        <CardContent className="space-y-3 text-sm">
          <p className="text-muted-foreground">
            Earlier versions of this page let you save country blocks and IP lists. Nothing in Rem0te ever read them, so they
            protected nothing. They cannot be set any more. Block addresses in the server&apos;s firewall (ufw) or in Caddy, or
            ban them in fail2ban, where they are actually refused.
          </p>
          {stored ? (
            <div className="space-y-2">
              <p className="text-xs">
                Stored here and doing nothing: GeoIP blocking {u.geoipBlockEnabled ? 'on' : 'off'}
                {u.blockedCountries.length ? ` (${u.blockedCountries.join(', ')})` : ''}; allowlist {u.ipAllowlistEnabled ? 'on' : 'off'}
                {u.allowedIpRanges.length ? ` (${u.allowedIpRanges.join(', ')})` : ''}{u.blockedIpRanges.length ? `; blocked: ${u.blockedIpRanges.join(', ')}` : ''}.
              </p>
              <div className="flex flex-wrap items-center gap-3">
                <Button size="sm" variant="outline" onClick={() => clear.mutate()} disabled={clear.isPending} data-testid="clear-unenforced">Clear them</Button>
                <Mutation m={clear} ok="Cleared." />
              </div>
            </div>
          ) : <p className="text-xs text-muted-foreground">None are stored.</p>}
        </CardContent>
      </Card>
    </div>
  );
}

// ─── fail2ban ────────────────────────────────────────────────────────────────

const ADDR_RE = /^[0-9A-Fa-f.:/]{2,64}$/;

function JailSettings({ jail, onDone }: { jail: string; onDone: () => void }) {
  const q = useQuery({ queryKey: ['jail-config', jail], queryFn: () => data<{ bantime: number; findtime: number; maxretry: number }>(securityApi.getJailConfig(jail)), staleTime: 0 });
  const [v, setV] = useState({ bantime: '', findtime: '', maxretry: '' });
  useEffect(() => { if (q.data) setV({ bantime: String(q.data.bantime), findtime: String(q.data.findtime), maxretry: String(q.data.maxretry) }); }, [q.data]);
  const save = useMutation({
    mutationFn: () => securityApi.updateJailConfig(jail, Object.fromEntries((['bantime', 'findtime', 'maxretry'] as const).filter((k) => q.data && v[k] !== String(q.data[k])).map((k) => [k, Number(v[k])]))),
    onSuccess: () => { q.refetch(); onDone(); },
  });
  if (q.isLoading) return <Loading what="the jail's settings" />;
  if (q.isError) return <ErrorCard what="the jail's settings" error={q.error} />;
  return (
    <div className="space-y-3 rounded-md bg-muted/40 p-3">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        {([['bantime', 'Ban time (s, 60+)'], ['findtime', 'Find time (s, 60+)'], ['maxretry', 'Max retry (1–100)']] as const).map(([k, label]) => (
          <div key={k} className="space-y-1">
            <Label htmlFor={`${jail}-${k}`} className="text-xs">{label}</Label>
            <Input id={`${jail}-${k}`} inputMode="numeric" className="font-mono" value={v[k]} onChange={(e) => setV({ ...v, [k]: e.target.value.trim() })} />
          </div>
        ))}
      </div>
      <p className="text-xs text-muted-foreground">Applies to the running fail2ban until it restarts. To keep it, set it in /etc/fail2ban/jail.local too.</p>
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" onClick={() => save.mutate()} disabled={save.isPending || !(['bantime', 'findtime', 'maxretry'] as const).every((k) => /^\d+$/.test(v[k]))}>Apply</Button>
        <Mutation m={save} ok="Applied." />
      </div>
    </div>
  );
}

function Fail2banTab() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['security-fail2ban'], queryFn: () => data<Fail2ban>(securityApi.getFail2ban()), staleTime: 30_000 });
  const running = q.data?.state === 'running';
  const ig = useQuery({ queryKey: ['security-fail2ban-ignore'], queryFn: () => data<{ ips: string[]; unreadable: string[]; checkedAt: string }>(securityApi.getIgnoreList()), enabled: running });
  const [banIp, setBanIp] = useState<Record<string, string>>({});
  const [ignoreIp, setIgnoreIp] = useState('');
  const [editing, setEditing] = useState<string | null>(null);
  const reread = async () => {
    const d = await data<Fail2ban>(securityApi.getFail2ban(true));
    qc.setQueryData(['security-fail2ban'], d);
    qc.invalidateQueries({ queryKey: ['security-fail2ban-ignore'] });
    qc.invalidateQueries({ queryKey: ['security-posture'] });
  };
  const ban = useMutation({ mutationFn: ({ jail, ip }: { jail: string; ip: string }) => securityApi.banIp(jail, ip), onSuccess: (_d, v) => { setBanIp((s) => ({ ...s, [v.jail]: '' })); void reread(); } });
  const unban = useMutation({ mutationFn: ({ jail, ip }: { jail: string; ip: string }) => securityApi.unbanIp(jail, ip), onSuccess: () => void reread() });
  const addIg = useMutation({ mutationFn: () => securityApi.addIgnoreIp(ignoreIp), onSuccess: () => { setIgnoreIp(''); void reread(); } });
  const delIg = useMutation({ mutationFn: (ip: string) => securityApi.removeIgnoreIp(ip), onSuccess: () => void reread() });
  const install = useMutation({ mutationFn: () => securityApi.installFail2ban(), onSuccess: () => void reread() });

  if (q.isLoading) return <Loading what="fail2ban" />;
  if (q.isError || !q.data) return <ErrorCard what="fail2ban's status" error={q.error} onRetry={() => q.refetch()} />;
  const d = q.data;

  if (d.state !== 'running') {
    return (
      <Card data-testid="fail2ban-state" data-state={d.state}>
        <CardContent className="space-y-3 py-6">
          <div className="flex items-center gap-2">
            <StatusChip status={d.state === 'unavailable' ? 'unknown' : 'fail'} label={d.state === 'unavailable' ? 'Unknown' : d.state === 'stopped' ? 'Stopped' : 'Not installed'} />
            <span className="text-sm font-medium">fail2ban</span>
          </div>
          {d.reason && <p className="text-sm text-muted-foreground break-words">{d.reason}</p>}
          {d.state !== 'unavailable' && (
            <div className="flex flex-wrap items-center gap-3">
              <Button onClick={() => install.mutate()} disabled={install.isPending}>
                {install.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden />}
                {d.state === 'stopped' ? 'Enable and start fail2ban' : 'Install, enable and start fail2ban'}
              </Button>
              <Mutation m={install} ok="fail2ban is installed and started." />
            </div>
          )}
          <Checked at={d.checkedAt} onRefresh={() => void reread()} />
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2" data-testid="fail2ban-state" data-state={d.state}>
        <div className="flex items-center gap-2"><StatusChip status="pass" label="Running" /><span className="text-sm">{d.jails.length} jail{d.jails.length === 1 ? '' : 's'}</span></div>
        <Checked at={d.checkedAt} onRefresh={() => void reread()} />
      </div>
      <p className="text-xs text-muted-foreground">Bans, never-ban entries and jail settings made here apply to the running fail2ban and last until it restarts. Each one is audited.</p>
      <Mutation m={ban} /><Mutation m={unban} />
      {d.jails.length === 0 && <Card><CardContent className="py-6 text-sm text-muted-foreground">fail2ban is running with no jails, so it bans nothing.</CardContent></Card>}
      {d.jails.map((j) => (
        <Card key={j.jail} data-testid={`jail-${j.jail}`}>
          <CardHeader className="pb-2">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <CardTitle className="font-mono text-sm">{j.jail}</CardTitle>
              <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                {j.error ? <StatusChip status="unknown" /> : <span>{j.currentBanned} banned now · {j.totalBanned} total · {j.totalFailed ?? '?'} failures seen</span>}
                <Button variant="ghost" size="sm" className="h-7 px-2 text-xs" onClick={() => setEditing(editing === j.jail ? null : j.jail)}>Settings</Button>
              </div>
            </div>
          </CardHeader>
          <CardContent className="space-y-3 pt-0">
            {j.error && <p className="text-xs text-muted-foreground break-words">{j.error}</p>}
            {(j.journalMatches || j.fileList) && <p className="text-[11px] text-muted-foreground break-all">Reads: {j.journalMatches ? `journal ${j.journalMatches}` : j.fileList}</p>}
            {editing === j.jail && <JailSettings jail={j.jail} onDone={() => void reread()} />}
            <form className="flex flex-col gap-2 sm:flex-row" onSubmit={(e) => { e.preventDefault(); ban.mutate({ jail: j.jail, ip: banIp[j.jail] ?? '' }); }}>
              <Input aria-label={`Address to ban in ${j.jail}`} className="font-mono" placeholder="Address to ban, e.g. 203.0.113.9" value={banIp[j.jail] ?? ''} onChange={(e) => setBanIp((s) => ({ ...s, [j.jail]: e.target.value.trim() }))} />
              <Button type="submit" size="sm" variant="destructive" disabled={ban.isPending || !ADDR_RE.test(banIp[j.jail] ?? '')}>Ban</Button>
            </form>
            {(j.bannedIps ?? []).length > 0 ? (
              <ul className="space-y-1">
                {(j.bannedIps ?? []).map((ip) => (
                  <li key={ip} className="flex items-center justify-between gap-2 rounded bg-muted/50 px-2 py-1">
                    <span className="font-mono text-xs break-all">{ip}</span>
                    <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={() => unban.mutate({ jail: j.jail, ip })} disabled={unban.isPending}>Unban</Button>
                  </li>
                ))}
              </ul>
            ) : !j.error && <p className="text-xs italic text-muted-foreground">Nothing banned in this jail now.</p>}
          </CardContent>
        </Card>
      ))}

      <Card>
        <CardHeader className="pb-2"><CardTitle className="text-sm">Never ban (every jail)</CardTitle></CardHeader>
        <CardContent className="space-y-3">
          <form className="flex flex-col gap-2 sm:flex-row" onSubmit={(e) => { e.preventDefault(); addIg.mutate(); }}>
            <Input aria-label="Address or range never to ban" className="font-mono" placeholder="Address or CIDR, e.g. 192.0.2.0/24" value={ignoreIp} onChange={(e) => setIgnoreIp(e.target.value.trim())} />
            <Button type="submit" size="sm" disabled={addIg.isPending || !ADDR_RE.test(ignoreIp)}>Add</Button>
          </form>
          <Mutation m={addIg} /><Mutation m={delIg} />
          {ig.isLoading ? <Loading what="the never-ban list" /> : ig.isError ? <ErrorCard what="the never-ban list" error={ig.error} /> : (
            <>
              {(ig.data?.unreadable ?? []).length > 0 && <p className="text-xs text-muted-foreground">Could not read the list of: {ig.data?.unreadable.join(', ')}.</p>}
              {(ig.data?.ips ?? []).length ? (
                <ul className="space-y-1">
                  {ig.data!.ips.map((ip) => (
                    <li key={ip} className="flex items-center justify-between gap-2 rounded bg-muted/50 px-2 py-1">
                      <span className="font-mono text-xs break-all">{ip}</span>
                      <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={() => delIg.mutate(ip)} disabled={delIg.isPending}>Remove</Button>
                    </li>
                  ))}
                </ul>
              ) : <p className="text-xs italic text-muted-foreground">No addresses are exempt.</p>}
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

// ─── TLS and web ─────────────────────────────────────────────────────────────

const CERT_LABEL: Record<string, { label: string; status: FindingStatus }> = {
  ok: { label: 'Valid', status: 'pass' }, renewal_failing: { label: 'Renewal failing', status: 'fail' },
  urgent: { label: 'Expires within a week', status: 'fail' }, expired: { label: 'Expired', status: 'fail' }, unknown: { label: 'Unknown', status: 'unknown' },
};

function TlsTab() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['security-tls'], queryFn: () => data<Tls>(securityApi.getTls()) });
  const posture = useQuery({ queryKey: ['security-posture'], queryFn: () => data<Posture>(securityApi.getPosture()), staleTime: 60_000 });
  const reread = useMutation({ mutationFn: () => data<Tls>(securityApi.getTls(true)), onSuccess: (d) => qc.setQueryData(['security-tls'], d) });
  if (q.isLoading) return <Loading what="the certificates" />;
  if (q.isError || !q.data) return <ErrorCard what="the certificates" error={q.error} onRetry={() => q.refetch()} />;
  const d = q.data;
  const web = (posture.data?.findings ?? []).filter((f) => f.id.startsWith('web.header.') || f.id === 'web.http_redirect' || f.id === 'web.public_https');

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <StatusChip status={d.caddyActive === null ? 'unknown' : d.caddyActive ? 'pass' : 'fail'} label={d.caddyActive === null ? 'Unknown' : d.caddyActive ? 'Caddy active' : 'Caddy not active'} />
          {!d.caddyfileReadable && <span className="text-xs text-muted-foreground">The Caddyfile is not readable by the API user, so its sites are unknown.</span>}
        </div>
        <Checked at={d.checkedAt} onRefresh={() => reread.mutate()} busy={reread.isPending} />
      </div>
      <Card>
        <CardHeader><CardTitle className="text-sm">Certificates Caddy serves</CardTitle></CardHeader>
        <CardContent className="space-y-3">
          <p className="text-xs text-muted-foreground">
            Read over loopback with each site&apos;s name, as a browser would see it. Caddy renews a Let&apos;s Encrypt
            certificate about 30 days before it expires, so fewer than 20 days left means renewal has been failing:
            check <code className="font-mono">journalctl -u caddy | grep -i acme</code>. There is no renew button: Caddy ignores a
            reload that changes nothing, and renews on its own once the cause is fixed.
          </p>
          {d.certs.length === 0 ? (
            <p className="text-sm text-muted-foreground" data-testid="no-certs"><StatusChip status="unknown" /> No certificate could be read.</p>
          ) : (
            <ul className="divide-y">
              {d.certs.map((c) => {
                const l = CERT_LABEL[c.level] ?? CERT_LABEL.unknown;
                const status: FindingStatus = c.daysLeft === null ? 'unknown' : !c.trusted || !c.nameMatches ? 'fail' : l.status;
                return (
                  <li key={c.domain} className="space-y-1 py-2" data-testid={`cert-${c.domain}`} data-status={status}>
                    <div className="flex flex-wrap items-center gap-2">
                      <StatusChip status={status} label={c.daysLeft === null ? 'Unknown' : !c.trusted ? 'Not trusted' : !c.nameMatches ? 'Wrong name' : l.label} />
                      <span className="font-mono text-sm break-all">{c.domain}</span>
                    </div>
                    <p className="text-xs text-muted-foreground break-words">
                      {c.expiresAt ? `Expires ${new Date(c.expiresAt).toLocaleDateString()} (${c.daysLeft} days)` : 'No expiry read'}{c.issuer ? ` · ${c.issuer}` : ''}{c.error ? ` · ${c.error}` : ''}
                    </p>
                  </li>
                );
              })}
            </ul>
          )}
        </CardContent>
      </Card>
      <Card>
        <CardHeader><CardTitle className="text-sm">The console&apos;s security headers</CardTitle></CardHeader>
        <CardContent className="p-0">
          {posture.isLoading ? <div className="px-6 pb-4"><Loading what="the headers" /></div>
            : posture.isError ? <div className="px-6 pb-4"><ErrorCard what="the headers" error={posture.error} /></div>
            : web.length ? <div className="divide-y">{web.map((f) => <FindingRow key={f.id} f={f} />)}</div>
            : <p className="px-6 pb-4 text-sm text-muted-foreground">No header checks were made.</p>}
        </CardContent>
      </Card>
    </div>
  );
}

// ─── OS updates ──────────────────────────────────────────────────────────────

function OsUpdatesTab() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['security-os-updates'], queryFn: () => data<OsUpdates>(securityApi.getOsUpdates()) });
  const job = useQuery({
    queryKey: ['security-os-update-job'], queryFn: () => data<UpdateJob>(securityApi.getOsUpdateStatus()),
    refetchInterval: (query) => ((query.state.data as UpdateJob | undefined)?.running ? 1500 : false),
  });
  const [confirm, setConfirm] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const out = useRef<HTMLDivElement>(null);
  const run = useMutation({ mutationFn: () => securityApi.runOsUpdate(), onSuccess: () => { setConfirm(false); job.refetch(); } });
  const reread = useMutation({ mutationFn: () => data<OsUpdates>(securityApi.getOsUpdates(true)), onSuccess: (d) => qc.setQueryData(['security-os-updates'], d) });
  const wasRunning = useRef(false);
  useEffect(() => {
    if (out.current) out.current.scrollTop = out.current.scrollHeight;
    if (wasRunning.current && job.data && !job.data.running) { reread.mutate(); qc.invalidateQueries({ queryKey: ['security-posture'] }); }
    wasRunning.current = !!job.data?.running;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [job.data]);

  if (q.isLoading) return <Loading what="pending updates" />;
  if (q.isError || !q.data) return <ErrorCard what="pending updates" error={q.error} onRetry={() => q.refetch()} />;
  const d = q.data;
  const j = job.data;
  const pkgs = showAll ? d.packages : d.packages.slice(0, 25);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2" data-testid="os-updates-state" data-state={d.state}>
          {d.state !== 'ok' ? <StatusChip status="unknown" />
            : d.total === 0 ? <StatusChip status="pass" label="No updates pending" />
            : <StatusChip status="fail" label={`${d.total} pending${d.security ? `, ${d.security} security` : ''}`} />}
          {d.rebootRequired && <Chip className={CHIP.warn}>Restart pending</Chip>}
        </div>
        <Checked at={d.checkedAt} onRefresh={() => reread.mutate()} busy={reread.isPending || !!j?.running} />
      </div>
      {d.reason && <p className="text-sm text-muted-foreground break-words">{d.reason}</p>}
      <Card>
        <CardContent className="grid grid-cols-1 gap-2 py-4 text-xs sm:grid-cols-2">
          <p><span className="text-muted-foreground">Package lists last refreshed:</span> {when(d.listsUpdatedAt)}</p>
          <p><span className="text-muted-foreground">Running kernel:</span> <span className="font-mono">{d.kernel}</span></p>
          <p><span className="text-muted-foreground">Unattended upgrades:</span>{' '}
            {d.unattended.configured === null || d.unattended.serviceActive === null ? 'unknown'
              : d.unattended.configured.unattended && d.unattended.serviceActive ? 'on' : 'off'}
          </p>
          <p><span className="text-muted-foreground">Restart pending for:</span> {d.rebootRequired ? (d.rebootPackages.join(', ') || 'unspecified packages') : 'nothing'}</p>
        </CardContent>
      </Card>

      {!j?.running && d.state === 'ok' && (d.total ?? 0) > 0 && !confirm && (
        <Button variant="destructive" size="sm" onClick={() => setConfirm(true)} data-testid="run-os-update">Run apt-get update and upgrade</Button>
      )}
      {confirm && !j?.running && (
        <Card className="border-destructive">
          <CardContent className="space-y-3 py-4">
            <p className="text-sm font-medium">Upgrade this server now?</p>
            <p className="text-xs text-muted-foreground">
              Runs <code className="font-mono">apt-get update</code>, then <code className="font-mono">apt-get upgrade -y</code> keeping existing
              configuration files. Services may restart; a new kernel needs a server restart afterwards. It is audited and may ask you to confirm it is you.
            </p>
            <div className="flex flex-wrap gap-2">
              <Button size="sm" variant="destructive" onClick={() => run.mutate()} disabled={run.isPending}>{run.isPending && <Loader2 className="mr-2 h-3 w-3 animate-spin" aria-hidden />}Upgrade</Button>
              <Button size="sm" variant="outline" onClick={() => setConfirm(false)}>Cancel</Button>
            </div>
            <Mutation m={run} />
          </CardContent>
        </Card>
      )}
      {j && (j.running || j.lines.length > 0) && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-sm">
              {j.running ? <><Loader2 className="h-4 w-4 animate-spin" aria-hidden />Running {j.phase}…</>
                : j.exitCode === 0 ? <><CheckCircle2 className="h-4 w-4 text-green-600" aria-hidden />Finished {when(j.finishedAt)}</>
                : <><XCircle className="h-4 w-4 text-destructive" aria-hidden />{j.phase} failed (exit {j.exitCode})</>}
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div ref={out} className="h-64 overflow-y-auto rounded bg-slate-950 p-3 font-mono text-xs text-slate-100">
              {j.lines.map((l, i) => <div key={i} className="whitespace-pre-wrap break-all">{l}</div>)}
            </div>
          </CardContent>
        </Card>
      )}
      {d.packages.length > 0 && (
        <Card>
          <CardHeader><CardTitle className="text-sm">Upgradable packages ({d.total})</CardTitle></CardHeader>
          <CardContent>
            <ul className="divide-y">
              {pkgs.map((p) => (
                <li key={p.name} className="flex flex-wrap items-center justify-between gap-2 py-2">
                  <span className="flex items-center gap-2 font-mono text-sm break-all">{p.name}{p.security && <Chip className={CHIP.bad}>security</Chip>}</span>
                  <span className="text-xs text-muted-foreground break-all">{p.from ? `${p.from} → ` : ''}{p.version}</span>
                </li>
              ))}
            </ul>
            {d.packages.length > 25 && <Button variant="link" size="sm" className="px-0" onClick={() => setShowAll(!showAll)}>{showAll ? 'Show fewer' : `Show all ${d.packages.length}`}</Button>}
          </CardContent>
        </Card>
      )}
    </div>
  );
}

// ─── Dependencies ────────────────────────────────────────────────────────────

const SEV_ORDER = ['critical', 'high', 'moderate', 'low', 'info'] as const;

function DependenciesTab() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['security-deps'], queryFn: () => data<DepAudit>(securityApi.getDependencyAudit()), staleTime: 900_000 });
  const rescan = useMutation({ mutationFn: () => data<DepAudit>(securityApi.getDependencyAudit(true)), onSuccess: (d) => { qc.setQueryData(['security-deps'], d); qc.invalidateQueries({ queryKey: ['security-posture'] }); } });
  const sevChip = (s: string) => (s === 'critical' || s === 'high' ? CHIP.bad : s === 'moderate' ? CHIP.warn : CHIP.off);

  return (
    <div className="space-y-4">
      <Card>
        <CardContent className="space-y-2 py-4 text-xs text-muted-foreground">
          <p>
            <span className="font-medium text-foreground">npm audit</span> of the API&apos;s production dependencies: the manifest and lock the
            server installs from. Fixing one is a dependency bump in the repository and a deploy with the manifest regenerated, never
            <code className="mx-1 font-mono">npm audit fix</code> on the server, which would change production&apos;s libraries outside that manifest.
          </p>
          <p>
            Source scanning (ESLint and the security invariants) runs in CI on every push, against the source. Earlier versions ran ESLint
            and semgrep here: on the server ESLint linted nothing and semgrep could not start, and both were shown as &quot;no issues&quot;.
          </p>
        </CardContent>
      </Card>
      {q.isLoading ? <Loading what="the dependency audit (up to a minute)" /> : q.isError || !q.data ? <ErrorCard what="the dependency audit" error={q.error} onRetry={() => q.refetch()} /> : (
        <>
          <div className="flex flex-wrap items-center justify-between gap-2" data-testid="deps-state" data-state={q.data.state}>
            <div className="flex flex-wrap items-center gap-2">
              {q.data.state !== 'ok' || !q.data.audit ? <StatusChip status="unknown" />
                : q.data.audit.counts.critical + q.data.audit.counts.high > 0 ? <StatusChip status="fail" label={`${q.data.audit.counts.critical + q.data.audit.counts.high} critical or high`} />
                : <StatusChip status="pass" label="No critical or high advisories" />}
              <span className="text-xs text-muted-foreground break-all">{q.data.scope}</span>
            </div>
            <Checked at={q.data.scannedAt} onRefresh={() => rescan.mutate()} busy={rescan.isPending} />
          </div>
          {q.data.reason && <p className="text-sm text-muted-foreground break-words">{q.data.reason}</p>}
          {q.data.audit && (
            <Card>
              <CardHeader>
                <CardTitle className="flex flex-wrap items-center gap-2 text-sm">
                  {SEV_ORDER.map((s) => <Chip key={s} className={sevChip(s)}>{s}: {q.data!.audit!.counts[s]}</Chip>)}
                  <span className="text-xs font-normal text-muted-foreground">over {q.data.audit.dependencies ?? '?'} packages</span>
                </CardTitle>
              </CardHeader>
              <CardContent>
                {q.data.audit.packages.length ? (
                  <ul className="divide-y">
                    {q.data.audit.packages.map((p) => (
                      <li key={p.name} className="space-y-1 py-2">
                        <div className="flex flex-wrap items-center gap-2">
                          <Chip className={sevChip(p.severity)}>{p.severity}</Chip>
                          <span className="font-mono text-sm break-all">{p.name}</span>
                          <span className="text-xs text-muted-foreground">{p.direct ? 'direct' : 'transitive'}{p.fixAvailable ? ' · fix available' : ''}</span>
                        </div>
                        {p.titles.map((t) => <p key={t} className="text-xs text-muted-foreground">{t}</p>)}
                      </li>
                    ))}
                  </ul>
                ) : <p className="text-sm text-muted-foreground">No advisories.</p>}
              </CardContent>
            </Card>
          )}
        </>
      )}
    </div>
  );
}

// ─── Page ────────────────────────────────────────────────────────────────────

const TABS = [
  ['overview', 'Overview', ShieldCheck], ['access-rules', 'Access rules', Lock], ['fail2ban', 'fail2ban', ShieldAlert],
  ['tls', 'TLS & web', Lock], ['os-updates', 'OS updates', Package], ['dependencies', 'Dependencies', Package], ['features', 'Security features', ShieldCheck],
] as const;

export default function SecurityPage() {
  const [tab, setTab] = useState<string>('overview');
  useEffect(() => {
    try { const h = window.location.hash.slice(1); if (TABS.some(([v]) => v === h)) setTab(h); } catch { /* ignore */ }
  }, []);
  const change = (v: string) => { setTab(v); try { window.history.replaceState(null, '', `#${v}`); } catch { /* ignore */ } };
  const tabs = useMemo(() => TABS, []);
  return (
    <div className="max-w-5xl space-y-6 p-4 sm:p-6">
      <PageHeader title="Security" description="This server's security posture: SSH, firewall, updates, fail2ban, certificates and headers, sign-in lockout, and Rem0te's own safeguards." />
      <Tabs value={tab} onValueChange={change}>
        <TabsList className="mb-4 h-auto flex-wrap justify-start">
          {tabs.map(([v, label]) => <TabsTrigger key={v} value={v} data-testid={`security-tab-${v}`}>{label}</TabsTrigger>)}
        </TabsList>
        <TabsContent value="overview"><OverviewTab /></TabsContent>
        <TabsContent value="access-rules"><AccessRulesTab /></TabsContent>
        <TabsContent value="fail2ban"><Fail2banTab /></TabsContent>
        <TabsContent value="tls"><TlsTab /></TabsContent>
        <TabsContent value="os-updates"><OsUpdatesTab /></TabsContent>
        <TabsContent value="dependencies"><DependenciesTab /></TabsContent>
        <TabsContent value="features"><SecurityFeaturesTab /></TabsContent>
      </Tabs>
    </div>
  );
}
