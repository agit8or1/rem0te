'use client';

import { useState, useEffect, useRef } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { securityApi } from '@/lib/api-client';
import { PageHeader } from '@/components/common/page-header';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import {
  ShieldCheck,
  ShieldAlert,
  Globe,
  RefreshCw,
  Lock,
  Package,
  AlertTriangle,
  CheckCircle,
  XCircle,
  Loader2,
} from 'lucide-react';
import { cn } from '@/lib/utils';

// ─── Country list ────────────────────────────────────────────────────────────

const COUNTRIES = [
  { code: 'CN', name: 'China' },
  { code: 'RU', name: 'Russia' },
  { code: 'KP', name: 'North Korea' },
  { code: 'IR', name: 'Iran' },
  { code: 'US', name: 'United States' },
  { code: 'GB', name: 'United Kingdom' },
  { code: 'DE', name: 'Germany' },
  { code: 'FR', name: 'France' },
  { code: 'CA', name: 'Canada' },
  { code: 'AU', name: 'Australia' },
  { code: 'IN', name: 'India' },
  { code: 'BR', name: 'Brazil' },
  { code: 'JP', name: 'Japan' },
  { code: 'KR', name: 'South Korea' },
  { code: 'NL', name: 'Netherlands' },
  { code: 'UA', name: 'Ukraine' },
  { code: 'TR', name: 'Turkey' },
  { code: 'PL', name: 'Poland' },
  { code: 'SE', name: 'Sweden' },
  { code: 'MX', name: 'Mexico' },
  { code: 'NG', name: 'Nigeria' },
  { code: 'PK', name: 'Pakistan' },
  { code: 'BD', name: 'Bangladesh' },
  { code: 'VN', name: 'Vietnam' },
  { code: 'ID', name: 'Indonesia' },
  { code: 'TH', name: 'Thailand' },
  { code: 'ZA', name: 'South Africa' },
  { code: 'EG', name: 'Egypt' },
  { code: 'IT', name: 'Italy' },
  { code: 'ES', name: 'Spain' },
  { code: 'AR', name: 'Argentina' },
  { code: 'RO', name: 'Romania' },
  { code: 'HK', name: 'Hong Kong' },
  { code: 'SG', name: 'Singapore' },
  { code: 'MY', name: 'Malaysia' },
  { code: 'PH', name: 'Philippines' },
];

// ─── Helpers ─────────────────────────────────────────────────────────────────

function StatusDot({ ok }: { ok: boolean }) {
  return (
    <span
      className={cn(
        'inline-block h-2 w-2 rounded-full',
        ok ? 'bg-green-500' : 'bg-red-500',
      )}
    />
  );
}

function SeverityBadge({ level }: { level: string }) {
  const colors: Record<string, string> = {
    critical: 'bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-200',
    high: 'bg-orange-100 text-orange-800 dark:bg-orange-900 dark:text-orange-200',
    moderate: 'bg-yellow-100 text-yellow-800 dark:bg-yellow-900 dark:text-yellow-200',
    low: 'bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200',
    info: 'bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300',
  };
  return (
    <span
      className={cn(
        'text-xs px-2 py-0.5 rounded-full font-medium capitalize',
        colors[level.toLowerCase()] ?? 'bg-gray-100 text-gray-700',
      )}
    >
      {level}
    </span>
  );
}

// ─── Overview Tab ─────────────────────────────────────────────────────────────

function OverviewTab() {
  const { data: fail2banData } = useQuery({
    queryKey: ['security-fail2ban'],
    queryFn: () => securityApi.getFail2ban().then((r) => r.data?.data),
    staleTime: 30_000,
  });
  const { data: tlsData } = useQuery({
    queryKey: ['security-tls'],
    queryFn: () => securityApi.getTls().then((r) => r.data?.data),
    staleTime: 120_000,
  });
  const { data: osData } = useQuery({
    queryKey: ['security-os-updates'],
    queryFn: () => securityApi.getOsUpdates().then((r) => r.data?.data),
    staleTime: 600_000,
  });
  const queryClient = useQueryClient();
  // Audit is expensive (~9s) — only show cached result, don't auto-fetch on page load
  const auditData = queryClient.getQueryData<Record<string, unknown>>(['security-audit']);

  const installMutation = useMutation({
    mutationFn: () => securityApi.installFail2ban(),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['security-fail2ban'] }),
  });

  const f2bRunning = fail2banData?.running ?? false;
  const secUpdateCount = osData?.securityUpdates ?? 0;
  const totalUpdateCount = osData?.total ?? 0;

  // Find soonest-expiring cert
  const certs = Array.isArray(tlsData?.certs) ? (tlsData.certs as Array<{ domain: string; daysLeft: number; expiresAt: string }>) : [];
  const soonestCert = certs.length > 0 ? certs.reduce((a, b) => (a.daysLeft < b.daysLeft ? a : b)) : null;
  const certOk = soonestCert ? soonestCert.daysLeft > 14 : tlsData !== undefined;

  // Audit summary
  const auditPackages = Array.isArray(auditData?.packages) ? auditData.packages : [];
  const critCount = auditPackages.filter((p: Record<string, unknown>) =>
    (p.summary as string)?.toLowerCase().includes('critical'),
  ).length;

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        {/* fail2ban card */}
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-xs text-muted-foreground flex items-center gap-1">
              <ShieldCheck className="h-3 w-3" /> fail2ban
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            <div className="flex items-center gap-2">
              <StatusDot ok={f2bRunning} />
              <span className="text-sm font-medium">{f2bRunning ? 'Running' : 'Stopped'}</span>
            </div>
            {!f2bRunning && (
              <Button
                size="sm"
                variant="outline"
                onClick={() => installMutation.mutate()}
                disabled={installMutation.isPending}
                className="w-full text-xs"
              >
                {installMutation.isPending ? (
                  <Loader2 className="h-3 w-3 animate-spin mr-1" />
                ) : null}
                Install fail2ban
              </Button>
            )}
            {f2bRunning && (
              <p className="text-xs text-muted-foreground">
                {Array.isArray(fail2banData?.jails) ? fail2banData.jails.length : 0} active jail(s)
              </p>
            )}
          </CardContent>
        </Card>

        {/* TLS card */}
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-xs text-muted-foreground flex items-center gap-1">
              <Lock className="h-3 w-3" /> TLS Certificates
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-1">
            <div className="flex items-center gap-2">
              <StatusDot ok={certOk} />
              <span className="text-sm font-medium">
                {certs.length === 0 ? 'No certs' : certOk ? 'Valid' : 'Expiring soon'}
              </span>
            </div>
            {soonestCert && (
              <p className="text-xs text-muted-foreground">
                Soonest: {(soonestCert as { domain: string; daysLeft: number }).domain} ({(soonestCert as { domain: string; daysLeft: number }).daysLeft}d)
              </p>
            )}
            {!tlsData?.caddyActive && (
              <p className="text-xs text-muted-foreground">Caddy not active</p>
            )}
          </CardContent>
        </Card>

        {/* OS Updates card */}
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-xs text-muted-foreground flex items-center gap-1">
              <Package className="h-3 w-3" /> OS Updates
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-1">
            <div className="flex items-center gap-2">
              <StatusDot ok={totalUpdateCount === 0} />
              <span className="text-sm font-medium">
                {totalUpdateCount === 0 ? 'Up to date' : `${totalUpdateCount} pending`}
              </span>
            </div>
            {secUpdateCount > 0 && (
              <p className="text-xs text-orange-600 dark:text-orange-400">
                {secUpdateCount} security update{secUpdateCount !== 1 ? 's' : ''}
              </p>
            )}
          </CardContent>
        </Card>

        {/* Code Audit card */}
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-xs text-muted-foreground flex items-center gap-1">
              <ShieldAlert className="h-3 w-3" /> Code Audit
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-1">
            <div className="flex items-center gap-2">
              <StatusDot ok={critCount === 0} />
              <span className="text-sm font-medium">
                {auditData ? (critCount === 0 ? 'No critical' : `${critCount} critical`) : 'Not run'}
              </span>
            </div>
            {!!auditData?.scannedAt && (
              <p className="text-xs text-muted-foreground">
                Scanned: {new Date(auditData!.scannedAt as string).toLocaleDateString()}
              </p>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

// ─── Access Rules Tab ─────────────────────────────────────────────────────────

function AccessRulesTab() {
  const queryClient = useQueryClient();

  const { data: config, isLoading } = useQuery({
    queryKey: ['security-config'],
    queryFn: () => securityApi.getConfig().then((r) => r.data?.data),
  });

  const [geoipEnabled, setGeoipEnabled] = useState<boolean>(false);
  const [ipAllowlistEnabled, setIpAllowlistEnabled] = useState<boolean>(false);
  const [blockedCountries, setBlockedCountries] = useState<string[]>([]);
  const [blockedIpRanges, setBlockedIpRanges] = useState<string>('');
  const [allowedIpRanges, setAllowedIpRanges] = useState<string>('');
  const [maxLoginAttempts, setMaxLoginAttempts] = useState<number>(5);
  const [lockoutMinutes, setLockoutMinutes] = useState<number>(15);
  const [initialized, setInitialized] = useState(false);

  if (config && !initialized) {
    setGeoipEnabled(config.geoipBlockEnabled ?? false);
    setIpAllowlistEnabled(config.ipAllowlistEnabled ?? false);
    setBlockedCountries(Array.isArray(config.blockedCountries) ? config.blockedCountries : []);
    setBlockedIpRanges(Array.isArray(config.blockedIpRanges) ? config.blockedIpRanges.join('\n') : '');
    setAllowedIpRanges(Array.isArray(config.allowedIpRanges) ? config.allowedIpRanges.join('\n') : '');
    setMaxLoginAttempts(config.maxLoginAttempts ?? 5);
    setLockoutMinutes(config.lockoutMinutes ?? 15);
    setInitialized(true);
  }

  const saveMutation = useMutation({
    mutationFn: () =>
      securityApi.updateConfig({
        geoipBlockEnabled: geoipEnabled,
        ipAllowlistEnabled,
        blockedCountries,
        blockedIpRanges: blockedIpRanges
          .split('\n')
          .map((s) => s.trim())
          .filter(Boolean),
        allowedIpRanges: allowedIpRanges
          .split('\n')
          .map((s) => s.trim())
          .filter(Boolean),
        maxLoginAttempts,
        lockoutMinutes,
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['security-config'] });
    },
  });

  function toggleCountry(code: string) {
    setBlockedCountries((prev) =>
      prev.includes(code) ? prev.filter((c) => c !== code) : [...prev, code],
    );
  }

  if (isLoading) {
    return <p className="text-sm text-muted-foreground">Loading config…</p>;
  }

  return (
    <div className="space-y-6">
      {/* Login protection */}
      <Card>
        <CardHeader>
          <CardTitle className="text-sm">Login Rate Limiting</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1">
              <Label className="text-xs">Max Login Attempts</Label>
              <input
                type="number"
                min={1}
                max={100}
                value={maxLoginAttempts}
                onChange={(e) => setMaxLoginAttempts(Number(e.target.value))}
                className="flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Lockout Duration (minutes)</Label>
              <input
                type="number"
                min={1}
                max={1440}
                value={lockoutMinutes}
                onChange={(e) => setLockoutMinutes(Number(e.target.value))}
                className="flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              />
            </div>
          </div>
        </CardContent>
      </Card>

      {/* GeoIP blocking */}
      <Card>
        <CardHeader>
          <CardTitle className="text-sm flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Globe className="h-4 w-4" />
              GeoIP Country Blocking
            </div>
            <label className="flex items-center gap-2 cursor-pointer">
              <span className="text-xs text-muted-foreground font-normal">
                {geoipEnabled ? 'Enabled' : 'Disabled'}
              </span>
              <input
                type="checkbox"
                checked={geoipEnabled}
                onChange={(e) => setGeoipEnabled(e.target.checked)}
                className="h-4 w-4"
              />
            </label>
          </CardTitle>
        </CardHeader>
        {geoipEnabled && (
          <CardContent>
            <p className="text-xs text-muted-foreground mb-3">
              Select countries to block. Requests from these countries will be rejected.
            </p>
            <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-2">
              {COUNTRIES.map((country) => {
                const selected = blockedCountries.includes(country.code);
                return (
                  <label
                    key={country.code}
                    className={cn(
                      'flex items-center gap-2 rounded border px-2 py-1.5 text-xs cursor-pointer transition-colors',
                      selected
                        ? 'border-destructive bg-destructive/10 text-destructive'
                        : 'border-border hover:bg-accent',
                    )}
                  >
                    <input
                      type="checkbox"
                      checked={selected}
                      onChange={() => toggleCountry(country.code)}
                      className="h-3 w-3"
                    />
                    <span className="font-mono text-xs text-muted-foreground">{country.code}</span>
                    {country.name}
                  </label>
                );
              })}
            </div>
          </CardContent>
        )}
      </Card>

      {/* IP Allowlist */}
      <Card>
        <CardHeader>
          <CardTitle className="text-sm flex items-center justify-between">
            IP Allowlist
            <label className="flex items-center gap-2 cursor-pointer">
              <span className="text-xs text-muted-foreground font-normal">
                {ipAllowlistEnabled ? 'Enabled' : 'Disabled'}
              </span>
              <input
                type="checkbox"
                checked={ipAllowlistEnabled}
                onChange={(e) => setIpAllowlistEnabled(e.target.checked)}
                className="h-4 w-4"
              />
            </label>
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-1.5">
            <Label className="text-xs">Allowed IP Ranges (one CIDR per line)</Label>
            <Textarea
              value={allowedIpRanges}
              onChange={(e) => setAllowedIpRanges(e.target.value)}
              placeholder="192.168.1.0/24&#10;10.0.0.0/8"
              rows={4}
              className="font-mono text-xs"
            />
            <p className="text-xs text-muted-foreground">
              When allowlist is enabled, only these ranges can access the system.
            </p>
          </div>

          <div className="space-y-1.5">
            <Label className="text-xs">Blocked IP Ranges (one CIDR per line)</Label>
            <Textarea
              value={blockedIpRanges}
              onChange={(e) => setBlockedIpRanges(e.target.value)}
              placeholder="203.0.113.0/24"
              rows={4}
              className="font-mono text-xs"
            />
            <p className="text-xs text-muted-foreground">
              These ranges are always blocked regardless of allowlist status.
            </p>
          </div>
        </CardContent>
      </Card>

      <div className="flex justify-end">
        <Button
          onClick={() => saveMutation.mutate()}
          disabled={saveMutation.isPending}
          className="gap-2"
        >
          {saveMutation.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
          Save Access Rules
        </Button>
      </div>

      {saveMutation.isSuccess && (
        <p className="text-sm text-green-600 dark:text-green-400 flex items-center gap-1">
          <CheckCircle className="h-4 w-4" />
          Configuration saved.
        </p>
      )}
      {saveMutation.isError && (
        <p className="text-sm text-destructive flex items-center gap-1">
          <XCircle className="h-4 w-4" />
          Failed to save configuration.
        </p>
      )}
    </div>
  );
}

// ─── fail2ban Tab ──────────────────────────────────────────────────────────────

interface Fail2banJail {
  jail: string;
  totalBanned: number;
  currentBanned: number;
  bannedIps: string[];
}

function JailConfigPanel({ jail, onClose }: { jail: string; onClose: () => void }) {
  const queryClient = useQueryClient();
  const { data, isLoading } = useQuery({
    queryKey: ['jail-config', jail],
    queryFn: () => securityApi.getJailConfig(jail).then((r) => r.data?.data?.config),
  });
  const [bantime, setBantime] = useState('');
  const [findtime, setFindtime] = useState('');
  const [maxretry, setMaxretry] = useState('');

  useEffect(() => {
    if (data) {
      setBantime(data.bantime ?? '');
      setFindtime(data.findtime ?? '');
      setMaxretry(data.maxretry ?? '');
    }
  }, [data]);

  const saveMutation = useMutation({
    mutationFn: () => securityApi.updateJailConfig(jail, {
      bantime: bantime ? Number(bantime) : undefined,
      findtime: findtime ? Number(findtime) : undefined,
      maxretry: maxretry ? Number(maxretry) : undefined,
    }),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ['security-fail2ban'] }); onClose(); },
  });

  if (isLoading) return <div className="text-xs text-muted-foreground p-3">Loading config…</div>;

  return (
    <div className="p-3 bg-muted/30 rounded-md space-y-3">
      <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Edit jail: {jail}</p>
      <div className="grid grid-cols-3 gap-3">
        {[
          { label: 'Ban Time (s)', value: bantime, set: setBantime, hint: 'e.g. 3600' },
          { label: 'Find Time (s)', value: findtime, set: setFindtime, hint: 'e.g. 300' },
          { label: 'Max Retry', value: maxretry, set: setMaxretry, hint: 'e.g. 5' },
        ].map(({ label, value, set, hint }) => (
          <div key={label} className="space-y-1">
            <label className="text-xs text-muted-foreground">{label}</label>
            <input
              className="w-full text-sm border rounded px-2 py-1 bg-background font-mono"
              value={value}
              onChange={e => set(e.target.value)}
              placeholder={hint}
            />
          </div>
        ))}
      </div>
      <div className="flex gap-2">
        <Button size="sm" onClick={() => saveMutation.mutate()} disabled={saveMutation.isPending} className="gap-1.5">
          {saveMutation.isPending && <Loader2 className="h-3 w-3 animate-spin" />}
          Save
        </Button>
        <Button size="sm" variant="outline" onClick={onClose}>Cancel</Button>
        {saveMutation.isSuccess && <span className="text-xs text-green-600 self-center">Saved</span>}
      </div>
    </div>
  );
}

function Fail2banTab() {
  const queryClient = useQueryClient();
  const [manualBanJail, setManualBanJail] = useState('');
  const [manualBanIp, setManualBanIp] = useState('');
  const [ignoreIpInput, setIgnoreIpInput] = useState('');
  const [editingJail, setEditingJail] = useState<string | null>(null);

  const { data, isLoading, refetch } = useQuery({
    queryKey: ['security-fail2ban'],
    queryFn: () => securityApi.getFail2ban().then((r) => r.data?.data),
    staleTime: 30_000,
  });

  const { data: ignoreData, refetch: refetchIgnore } = useQuery({
    queryKey: ['security-fail2ban-ignore'],
    queryFn: () => securityApi.getIgnoreList().then((r) => r.data?.data),
    enabled: !!data?.running,
    staleTime: 30_000,
  });

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ['security-fail2ban'] });
    queryClient.invalidateQueries({ queryKey: ['security-fail2ban-ignore'] });
  };

  const unbanMutation = useMutation({
    mutationFn: ({ jail, ip }: { jail: string; ip: string }) => securityApi.unbanIp(jail, ip),
    onSuccess: invalidate,
  });

  const banMutation = useMutation({
    mutationFn: () => securityApi.banIp(manualBanJail, manualBanIp),
    onSuccess: () => { setManualBanIp(''); invalidate(); },
  });

  const addIgnoreMutation = useMutation({
    mutationFn: () => securityApi.addIgnoreIp(ignoreIpInput),
    onSuccess: () => { setIgnoreIpInput(''); refetchIgnore(); },
  });

  const removeIgnoreMutation = useMutation({
    mutationFn: (ip: string) => securityApi.removeIgnoreIp(ip),
    onSuccess: () => refetchIgnore(),
  });

  const installMutation = useMutation({
    mutationFn: () => securityApi.installFail2ban(),
    onSuccess: invalidate,
  });

  if (isLoading) return <p className="text-sm text-muted-foreground">Loading fail2ban status…</p>;

  if (!data?.running) {
    return (
      <Card>
        <CardContent className="py-8 flex flex-col items-center gap-4">
          <ShieldAlert className="h-10 w-10 text-muted-foreground" />
          <div className="text-center">
            <p className="font-medium">fail2ban is not running</p>
            <p className="text-sm text-muted-foreground mt-1">Install fail2ban to protect against brute-force attacks.</p>
          </div>
          <Button onClick={() => installMutation.mutate()} disabled={installMutation.isPending} className="gap-2">
            {installMutation.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
            Install fail2ban
          </Button>
          {installMutation.isError && <p className="text-sm text-destructive">Installation failed.</p>}
        </CardContent>
      </Card>
    );
  }

  const jails: Fail2banJail[] = Array.isArray(data.jails) ? data.jails : [];
  const ignoreIps: string[] = Array.isArray(ignoreData?.ips) ? ignoreData.ips : [];

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <StatusDot ok={true} />
          <span className="text-sm font-medium">fail2ban running</span>
          <span className="text-xs text-muted-foreground">({jails.length} jail{jails.length !== 1 ? 's' : ''})</span>
        </div>
        <Button variant="outline" size="sm" onClick={() => { refetch(); refetchIgnore(); }}>
          <RefreshCw className="h-4 w-4" />
        </Button>
      </div>

      {/* Jails */}
      {jails.length === 0 ? (
        <p className="text-sm text-muted-foreground">No active jails.</p>
      ) : (
        jails.map((jail) => (
          <Card key={jail.jail}>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm flex items-center justify-between">
                <span className="font-mono">{jail.jail}</span>
                <div className="flex items-center gap-2">
                  <span className="text-xs text-muted-foreground font-normal">
                    {jail.currentBanned} banned · {jail.totalBanned} total
                  </span>
                  <Button variant="ghost" size="sm" className="h-6 text-xs px-2"
                    onClick={() => setEditingJail(editingJail === jail.jail ? null : jail.jail)}>
                    Settings
                  </Button>
                </div>
              </CardTitle>
            </CardHeader>
            <CardContent className="pt-0 space-y-2">
              {editingJail === jail.jail && (
                <JailConfigPanel jail={jail.jail} onClose={() => setEditingJail(null)} />
              )}
              {/* Manual ban for this jail */}
              <div className="flex gap-2">
                <input
                  className="flex-1 text-sm border rounded px-2 py-1 bg-background font-mono"
                  placeholder="IP to ban (e.g. 1.2.3.4)"
                  value={manualBanJail === jail.jail ? manualBanIp : ''}
                  onChange={e => { setManualBanJail(jail.jail); setManualBanIp(e.target.value); }}
                />
                <Button size="sm" variant="destructive"
                  onClick={() => { setManualBanJail(jail.jail); banMutation.mutate(); }}
                  disabled={banMutation.isPending || !manualBanIp || manualBanJail !== jail.jail}>
                  Ban IP
                </Button>
              </div>
              {/* Banned IPs */}
              {jail.bannedIps.length > 0 ? (
                <div className="space-y-1">
                  {jail.bannedIps.map((ip) => (
                    <div key={ip} className="flex items-center justify-between py-1 px-2 rounded bg-muted/50">
                      <span className="font-mono text-xs">{ip}</span>
                      <Button variant="ghost" size="sm" className="h-6 text-xs text-destructive hover:text-destructive"
                        onClick={() => unbanMutation.mutate({ jail: jail.jail, ip })}
                        disabled={unbanMutation.isPending}>
                        Unban
                      </Button>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="text-xs text-muted-foreground italic">No IPs currently banned in this jail.</p>
              )}
            </CardContent>
          </Card>
        ))
      )}

      {/* IP Whitelist (ignore list) */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm">IP Whitelist (Never Ban)</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex gap-2">
            <input
              className="flex-1 text-sm border rounded px-2 py-1 bg-background font-mono"
              placeholder="IP or CIDR to whitelist (e.g. 192.168.1.0/24)"
              value={ignoreIpInput}
              onChange={e => setIgnoreIpInput(e.target.value)}
            />
            <Button size="sm" onClick={() => addIgnoreMutation.mutate()}
              disabled={addIgnoreMutation.isPending || !ignoreIpInput}>
              {addIgnoreMutation.isPending ? <Loader2 className="h-3 w-3 animate-spin" /> : 'Add'}
            </Button>
          </div>
          {ignoreIps.length > 0 ? (
            <div className="space-y-1">
              {ignoreIps.map((ip) => (
                <div key={ip} className="flex items-center justify-between py-1 px-2 rounded bg-muted/50">
                  <span className="font-mono text-xs">{ip}</span>
                  <Button variant="ghost" size="sm" className="h-6 text-xs text-destructive hover:text-destructive"
                    onClick={() => removeIgnoreMutation.mutate(ip)}
                    disabled={removeIgnoreMutation.isPending}>
                    Remove
                  </Button>
                </div>
              ))}
            </div>
          ) : (
            <p className="text-xs text-muted-foreground italic">No whitelisted IPs.</p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

// ─── TLS Tab ──────────────────────────────────────────────────────────────────

interface TlsCert {
  domain: string;
  expiresAt: string;
  daysLeft: number;
}

function TlsTab() {
  const { data, isLoading, refetch } = useQuery({
    queryKey: ['security-tls'],
    queryFn: () => securityApi.getTls().then((r) => r.data?.data),
  });

  // After renewal: poll every 3s until cert appears (up to 90s)
  const [polling, setPolling] = useState(false);
  const [pollSeconds, setPollSeconds] = useState(0);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const stopPolling = () => {
    if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
    setPolling(false);
    setPollSeconds(0);
  };

  const startPolling = () => {
    setPolling(true);
    setPollSeconds(0);
    let elapsed = 0;
    pollRef.current = setInterval(async () => {
      elapsed += 3;
      setPollSeconds(elapsed);
      const res = await securityApi.getTls().catch(() => null);
      const tlsData = res?.data?.data;
      if (tlsData?.hasTls || elapsed >= 90) { refetch(); stopPolling(); }
    }, 3000);
  };

  useEffect(() => () => stopPolling(), []);

  const renewMutation = useMutation({
    mutationFn: () => securityApi.renewTls(),
    onSuccess: () => startPolling(),
  });

  if (isLoading) return <p className="text-sm text-muted-foreground">Loading TLS info…</p>;

  const certs: TlsCert[] = Array.isArray(data?.certs) ? data.certs : [];

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3 text-sm">
          <div className="flex items-center gap-1.5">
            <StatusDot ok={!!data?.caddyActive} />
            <span className="text-muted-foreground">Caddy:</span>
            <span className="font-medium">{data?.caddyActive ? 'Active' : 'Inactive'}</span>
          </div>
          <div className="flex items-center gap-1.5">
            <StatusDot ok={!!data?.hasTls} />
            <span className="text-muted-foreground">TLS:</span>
            <span className="font-medium">{data?.hasTls ? 'Enabled' : 'Disabled'}</span>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => renewMutation.mutate()}
            disabled={renewMutation.isPending || polling || !data?.caddyActive}
            className="gap-1.5"
          >
            {renewMutation.isPending ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <RefreshCw className="h-3.5 w-3.5" />
            )}
            {certs.length === 0 ? 'Request Certificate' : 'Renew Certificate'}
          </Button>
          <Button variant="outline" size="sm" onClick={() => refetch()} disabled={polling}>
            <RefreshCw className="h-4 w-4" />
          </Button>
        </div>
      </div>

      {polling && (
        <div className="flex items-center gap-2 text-sm text-muted-foreground bg-muted/50 rounded-md px-3 py-2">
          <Loader2 className="h-4 w-4 animate-spin shrink-0" />
          <span>Waiting for certificate from Let&apos;s Encrypt… ({pollSeconds}s)</span>
          <span className="text-xs opacity-60">This can take up to 90 seconds</span>
        </div>
      )}
      {!polling && renewMutation.isSuccess && data?.hasTls && (
        <p className="text-sm text-green-600 dark:text-green-400 flex items-center gap-1">
          <CheckCircle className="h-4 w-4" />
          Certificate provisioned successfully.
        </p>
      )}
      {!polling && renewMutation.isSuccess && !data?.hasTls && pollSeconds >= 90 && (
        <p className="text-sm text-amber-600 dark:text-amber-400 flex items-center gap-1">
          <AlertTriangle className="h-4 w-4" />
          Certificate not yet visible. Check DNS points to this server, then try again.
        </p>
      )}
      {renewMutation.isError && (
        <p className="text-sm text-destructive flex items-center gap-1">
          <XCircle className="h-4 w-4" />
          Failed to renew certificate.
        </p>
      )}

      {certs.length === 0 ? (
        <Card>
          <CardContent className="py-8 text-center space-y-2">
            <p className="text-sm text-muted-foreground">No TLS certificates found.</p>
            {data?.caddyActive && (
              <p className="text-xs text-muted-foreground">
                Caddy automatically provisions Let&apos;s Encrypt certificates when accessed via a public domain name.
                Make sure your domain&apos;s DNS points to this server, then click <strong>Request Certificate</strong>.
              </p>
            )}
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">Certificates ({certs.length})</CardTitle>
          </CardHeader>
          <CardContent>
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b">
                  <th className="py-2 text-left text-xs text-muted-foreground font-medium">Domain</th>
                  <th className="py-2 text-left text-xs text-muted-foreground font-medium">Expires</th>
                  <th className="py-2 text-left text-xs text-muted-foreground font-medium">Status</th>
                </tr>
              </thead>
              <tbody>
                {certs.map((cert) => {
                  const expiring = cert.daysLeft <= 30;
                  const expired = cert.daysLeft <= 0;
                  return (
                    <tr key={cert.domain} className="border-b last:border-0">
                      <td className="py-2 pr-4 font-mono text-xs">{cert.domain}</td>
                      <td className="py-2 pr-4 text-xs text-muted-foreground">
                        {new Date(cert.expiresAt).toLocaleDateString()} ({cert.daysLeft}d)
                      </td>
                      <td className="py-2">
                        {expired ? (
                          <Badge variant="destructive" className="text-xs">Expired</Badge>
                        ) : expiring ? (
                          <Badge variant="secondary" className="text-xs bg-orange-100 text-orange-800 dark:bg-orange-900 dark:text-orange-200">
                            Expiring soon
                          </Badge>
                        ) : (
                          <Badge variant="default" className="text-xs">Valid</Badge>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

// ─── OS Updates Tab ───────────────────────────────────────────────────────────

function OsUpdatesTab() {
  const queryClient = useQueryClient();
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [jobRunning, setJobRunning] = useState(false);
  const [jobLines, setJobLines] = useState<string[]>([]);
  const [jobExitCode, setJobExitCode] = useState<number | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const outputRef = useRef<HTMLDivElement>(null);

  const { data, isLoading, refetch } = useQuery({
    queryKey: ['security-os-updates'],
    queryFn: () => securityApi.getOsUpdates().then((r) => r.data?.data),
  });

  const stopJobPolling = () => {
    if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
  };

  const startJobPolling = () => {
    stopJobPolling();
    pollRef.current = setInterval(async () => {
      const res = await securityApi.getOsUpdateStatus().catch(() => null);
      const status = res?.data?.data;
      if (!status) return;
      setJobLines(status.lines ?? []);
      if (!status.running) {
        setJobRunning(false);
        setJobExitCode(status.exitCode ?? null);
        stopJobPolling();
        queryClient.invalidateQueries({ queryKey: ['security-os-updates'] });
        refetch();
      }
    }, 1500);
  };

  useEffect(() => {
    if (outputRef.current) outputRef.current.scrollTop = outputRef.current.scrollHeight;
  }, [jobLines]);

  useEffect(() => () => stopJobPolling(), []);

  const runUpdateMutation = useMutation({
    mutationFn: () => securityApi.runOsUpdate(),
    onSuccess: () => {
      setConfirmOpen(false);
      setJobRunning(true);
      setJobLines([]);
      setJobExitCode(null);
      startJobPolling();
    },
  });

  if (isLoading) return <p className="text-sm text-muted-foreground">Loading OS updates…</p>;

  const packages: Array<{ name: string; version: string }> = Array.isArray(data?.packages)
    ? data.packages
    : [];
  const total = data?.total ?? 0;
  const securityUpdates = data?.securityUpdates ?? 0;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-1.5">
            <StatusDot ok={total === 0} />
            <span className="text-sm font-medium">
              {total === 0 ? 'System up to date' : `${total} package${total !== 1 ? 's' : ''} upgradable`}
            </span>
          </div>
          {securityUpdates > 0 && (
            <Badge variant="destructive" className="text-xs">
              {securityUpdates} security
            </Badge>
          )}
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={() => refetch()} disabled={jobRunning}>
            <RefreshCw className="h-4 w-4" />
          </Button>
          {total > 0 && (
            <Button
              size="sm"
              variant="destructive"
              onClick={() => setConfirmOpen(true)}
              disabled={jobRunning}
            >
              Run System Update
            </Button>
          )}
        </div>
      </div>

      {/* Confirmation */}
      {confirmOpen && !jobRunning && (
        <Card className="border-destructive">
          <CardContent className="py-4 space-y-3">
            <div className="flex items-start gap-3">
              <AlertTriangle className="h-5 w-5 text-destructive shrink-0 mt-0.5" />
              <div>
                <p className="text-sm font-medium">Are you sure you want to run system updates?</p>
                <p className="text-xs text-muted-foreground mt-1">
                  This will run <code className="bg-muted px-1 rounded">apt upgrade</code> on the
                  server. Some services may restart. This cannot be undone.
                </p>
              </div>
            </div>
            <div className="flex gap-2">
              <Button
                size="sm"
                variant="destructive"
                onClick={() => runUpdateMutation.mutate()}
                disabled={runUpdateMutation.isPending}
                className="gap-2"
              >
                {runUpdateMutation.isPending && <Loader2 className="h-3 w-3 animate-spin" />}
                Yes, run updates
              </Button>
              <Button size="sm" variant="outline" onClick={() => setConfirmOpen(false)}>
                Cancel
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Live output */}
      {(jobRunning || jobLines.length > 0) && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm flex items-center gap-2">
              {jobRunning ? (
                <><Loader2 className="h-4 w-4 animate-spin" /> Running system update…</>
              ) : jobExitCode === 0 ? (
                <><CheckCircle className="h-4 w-4 text-green-500" /> Update completed successfully</>
              ) : (
                <><XCircle className="h-4 w-4 text-destructive" /> Update finished (exit code {jobExitCode})</>
              )}
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div
              ref={outputRef}
              className="bg-black text-green-400 font-mono text-xs rounded p-3 h-64 overflow-y-auto"
            >
              {jobLines.length === 0 ? (
                <span className="text-green-600">Starting…</span>
              ) : (
                jobLines.map((line, i) => <div key={i}>{line}</div>)
              )}
              {jobRunning && <span className="animate-pulse">▋</span>}
            </div>
          </CardContent>
        </Card>
      )}

      {packages.length > 0 && !jobRunning && (
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">
              Upgradable Packages (showing {Math.min(packages.length, 20)} of {total})
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="divide-y">
              {packages.slice(0, 20).map((pkg) => (
                <div key={pkg.name} className="py-2 flex items-center justify-between">
                  <span className="text-sm font-mono">{pkg.name}</span>
                  <span className="text-xs text-muted-foreground">{pkg.version}</span>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

// ─── Code Audit Tab ───────────────────────────────────────────────────────────

interface AuditPackage {
  label: string;
  total: number;
  summary: string;
  vulnerabilities: Array<{ severity: string; title?: string }>;
}

interface StaticIssue { file: string; line: number; rule: string; severity: string; message: string; }

function StaticIssueTable({ issues }: { issues: StaticIssue[] }) {
  const errors = issues.filter((i) => i.severity === 'error');
  const warnings = issues.filter((i) => i.severity !== 'error');
  const sorted = [...errors, ...warnings];
  return (
    <div className="divide-y text-xs">
      {sorted.map((issue, i) => (
        <div key={i} className="py-2.5 flex items-start gap-3">
          <span className={`shrink-0 font-semibold uppercase text-[10px] px-1.5 py-0.5 rounded ${issue.severity === 'error' ? 'bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-300' : 'bg-yellow-100 text-yellow-700 dark:bg-yellow-950 dark:text-yellow-300'}`}>
            {issue.severity}
          </span>
          <div className="min-w-0 flex-1">
            <p className="font-medium text-foreground">{issue.message}</p>
            <p className="text-muted-foreground font-mono truncate mt-0.5">{issue.file}:{issue.line} <span className="opacity-60">({issue.rule})</span></p>
          </div>
        </div>
      ))}
    </div>
  );
}

// Fix guidance for known ESLint security rules
const ESLINT_FIX_GUIDANCE: Record<string, string> = {
  'security/detect-non-literal-fs-filename': 'Validate or whitelist the filename value before passing to fs methods. Avoid user-controlled paths.',
  'security/detect-non-literal-regexp': 'Use a literal regex or validate the pattern string before passing to new RegExp().',
  'security/detect-unsafe-regex': 'Rewrite the regex to avoid catastrophic backtracking. Use tools like safe-regex or recheck.',
  'security/detect-eval-with-expression': 'Replace eval() with safer alternatives — JSON.parse for data, or Function constructor is still risky. Avoid dynamic code evaluation.',
  'security/detect-new-buffer': 'Replace new Buffer() with Buffer.alloc() or Buffer.from() to avoid uninitialized memory.',
  'security/detect-no-csrf-before-method-override': 'Ensure CSRF middleware runs before method-override middleware.',
  'security/detect-possible-timing-attacks': 'Use a constant-time comparison function like crypto.timingSafeEqual() instead of === for secrets.',
  'security/detect-child-process': 'Sanitize all arguments before passing to child_process. Avoid passing user input directly.',
  'security/detect-object-injection': "Validate the key before using obj[key] — check it's in a known set with Object.prototype.hasOwnProperty or a Map.",
  'security/detect-pseudoRandomBytes': 'Replace Math.random() or pseudoRandomBytes with crypto.randomBytes() for security-sensitive randomness.',
  'security/detect-disable-mustache-escape': 'Do not disable Mustache escaping — this prevents XSS.',
  'security/detect-buffer-noassert': 'Remove the noAssert parameter from Buffer read operations.',
};

// Fix guidance for known semgrep rules
const SEMGREP_FIX_GUIDANCE: Record<string, string> = {
  'no-eval': 'Remove eval(). Parse JSON with JSON.parse(), execute known operations via a whitelist, or restructure the code.',
  'no-new-function': 'Replace new Function() with a proper function definition or a safe expression evaluator.',
  'child-process-exec-dynamic': 'Use execFile() with an argument array instead of exec() with a string, or sanitize all inputs strictly.',
  'hardcoded-password': 'Move the credential to an environment variable or a secrets manager. Never commit credentials.',
  'hardcoded-secret': 'Move the secret to an environment variable or secrets manager (e.g. HashiCorp Vault, AWS Secrets Manager).',
  'weak-crypto-md5': 'Replace MD5 with SHA-256 or better (crypto.createHash("sha256")). MD5 is broken for security use.',
  'weak-crypto-sha1': 'Replace SHA-1 with SHA-256 or better. SHA-1 is deprecated for security use.',
  'no-disable-tls-validation': 'Remove rejectUnauthorized: false. Fix the certificate instead of disabling validation.',
  'prototype-pollution': 'Validate that user-supplied keys are not __proto__, constructor, or prototype before assigning.',
  'regex-dos': 'Rewrite the regex to avoid nested quantifiers on overlapping patterns. Use a linear-time regex engine or input length limits.',
};

function RemediationGuidance({ rule, type }: { rule: string; type: 'eslint' | 'semgrep' }) {
  const [open, setOpen] = useState(false);
  const guidance = type === 'eslint' ? ESLINT_FIX_GUIDANCE[rule] : SEMGREP_FIX_GUIDANCE[rule];
  if (!guidance) return null;
  return (
    <div className="mt-1">
      <button
        onClick={() => setOpen((o) => !o)}
        className="text-xs text-primary hover:underline flex items-center gap-1"
      >
        {open ? '▾' : '▸'} How to fix
      </button>
      {open && (
        <p className="mt-1 text-xs text-muted-foreground bg-muted/50 rounded p-2 border-l-2 border-primary/30">
          {guidance}
        </p>
      )}
    </div>
  );
}

function StaticIssueTableWithGuidance({ issues, type }: { issues: StaticIssue[]; type: 'eslint' | 'semgrep' }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-xs">
        <thead>
          <tr className="border-b">
            <th className="text-left py-2 pr-3 font-medium text-muted-foreground">File</th>
            <th className="text-left py-2 pr-3 font-medium text-muted-foreground">Rule</th>
            <th className="text-left py-2 pr-3 font-medium text-muted-foreground">Severity</th>
            <th className="text-left py-2 font-medium text-muted-foreground">Message</th>
          </tr>
        </thead>
        <tbody className="divide-y">
          {issues.map((issue, i) => (
            <tr key={i} className="align-top">
              <td className="py-2 pr-3 font-mono text-muted-foreground whitespace-nowrap">
                {issue.file}{issue.line ? `:${issue.line}` : ''}
              </td>
              <td className="py-2 pr-3">
                <div className="font-mono">{issue.rule}</div>
                <RemediationGuidance rule={issue.rule} type={type} />
              </td>
              <td className="py-2 pr-3"><SeverityBadge level={issue.severity} /></td>
              <td className="py-2 text-muted-foreground">{issue.message}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function CodeAuditTab() {
  const queryClient = useQueryClient();
  const [fixOutput, setFixOutput] = useState<string | null>(null);
  const [showForceWarning, setShowForceWarning] = useState(false);

  const { data, isLoading, refetch } = useQuery({
    queryKey: ['security-audit'],
    queryFn: () => securityApi.runAudit().then((r) => r.data?.data),
    staleTime: 900_000, // 15 min — audit is expensive, don't re-run on every tab visit
  });

  const runMutation = useMutation({
    mutationFn: () => securityApi.runAudit(),
    onSuccess: (res) => {
      queryClient.setQueryData(['security-audit'], res.data?.data);
    },
  });

  const fixMutation = useMutation({
    mutationFn: (force: boolean) => securityApi.runAuditFix(force),
    onSuccess: (res) => {
      setFixOutput(res.data?.data?.output ?? '');
      setShowForceWarning(false);
      runMutation.mutate(); // re-run audit after fix
    },
  });

  const packages: AuditPackage[] = Array.isArray(data?.packages) ? data.packages : [];
  const outdated: string[] = Array.isArray(data?.outdated) ? data.outdated : [];
  const eslintIssues: StaticIssue[] = Array.isArray(data?.eslint?.issues) ? data.eslint.issues : [];
  const semgrepIssues: StaticIssue[] = Array.isArray(data?.semgrep?.issues) ? data.semgrep.issues : [];

  const severityCounts: Record<string, number> = {};
  packages.forEach((pkg) => {
    if (Array.isArray(pkg.vulnerabilities)) {
      pkg.vulnerabilities.forEach((v) => {
        const sev = (v.severity ?? 'unknown').toLowerCase();
        severityCounts[sev] = (severityCounts[sev] ?? 0) + 1;
      });
    }
  });

  const severityOrder = ['critical', 'high', 'moderate', 'low', 'info'];

  return (
    <div className="space-y-4">
      {/* What this runs */}
      <Card>
        <CardContent className="pt-4 pb-4 space-y-2">
          <p className="text-sm font-medium">Three tools run in parallel:</p>
          <div className="space-y-1.5">
            <div className="flex items-start gap-2">
              <code className="text-xs bg-muted px-2 py-1 rounded font-mono shrink-0">npm audit</code>
              <span className="text-xs text-muted-foreground">Checks installed packages against the npm CVE advisory database</span>
            </div>
            <div className="flex items-start gap-2">
              <code className="text-xs bg-muted px-2 py-1 rounded font-mono shrink-0">eslint-plugin-security</code>
              <span className="text-xs text-muted-foreground">Static analysis of source code — detects unsafe regex, non-literal fs paths, eval, timing attacks, and more</span>
            </div>
            <div className="flex items-start gap-2">
              <code className="text-xs bg-muted px-2 py-1 rounded font-mono shrink-0">semgrep</code>
              <span className="text-xs text-muted-foreground">Pattern-based source code scanning — detects hardcoded secrets, weak crypto, command injection, prototype pollution, and ReDoS</span>
            </div>
          </div>
        </CardContent>
      </Card>

      <div className="flex items-center justify-between">
        <div className="text-sm text-muted-foreground">
          {data?.scannedAt
            ? `Last scanned: ${new Date(data.scannedAt as string).toLocaleString()}`
            : 'Not yet scanned'}
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={() => { runMutation.mutate(); refetch(); }}
          disabled={isLoading || runMutation.isPending}
          className="gap-2"
        >
          {(isLoading || runMutation.isPending) && <Loader2 className="h-3 w-3 animate-spin" />}
          Run Audit
        </Button>
      </div>

      {/* npm audit — severity summary */}
      {Object.keys(severityCounts).length > 0 && (
        <Card>
          <CardHeader><CardTitle className="text-sm">npm audit — Vulnerability Summary</CardTitle></CardHeader>
          <CardContent>
            <div className="flex flex-wrap gap-3">
              {severityOrder.filter((s) => severityCounts[s]).map((sev) => (
                <div key={sev} className="flex items-center gap-2">
                  <SeverityBadge level={sev} />
                  <span className="text-sm font-semibold">{severityCounts[sev]}</span>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {/* npm audit — affected packages + remediation */}
      {packages.length > 0 && (
        <Card>
          <CardHeader>
            <div className="flex items-center justify-between">
              <CardTitle className="text-sm">npm audit — Affected Packages ({packages.length})</CardTitle>
              <div className="flex items-center gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  className="h-7 text-xs gap-1"
                  onClick={() => fixMutation.mutate(false)}
                  disabled={fixMutation.isPending}
                >
                  {fixMutation.isPending && !showForceWarning && <Loader2 className="h-3 w-3 animate-spin" />}
                  npm audit fix
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  className="h-7 text-xs gap-1 text-destructive border-destructive/30 hover:bg-destructive/10"
                  onClick={() => setShowForceWarning(true)}
                  disabled={fixMutation.isPending}
                >
                  npm audit fix --force
                </Button>
              </div>
            </div>
          </CardHeader>
          <CardContent className="space-y-3">
            {showForceWarning && (
              <div className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm space-y-2">
                <p className="font-medium text-destructive">Warning: --force may introduce breaking changes</p>
                <p className="text-xs text-muted-foreground">This will install the latest semver-major updates which may break compatibility. Only use if you understand the impact.</p>
                <div className="flex gap-2">
                  <Button size="sm" variant="destructive" className="h-7 text-xs" onClick={() => fixMutation.mutate(true)} disabled={fixMutation.isPending}>
                    {fixMutation.isPending && <Loader2 className="h-3 w-3 animate-spin mr-1" />}
                    Run --force anyway
                  </Button>
                  <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => setShowForceWarning(false)}>Cancel</Button>
                </div>
              </div>
            )}
            {fixOutput !== null && (
              <div className="rounded-md bg-muted p-3">
                <p className="text-xs font-medium mb-1">Fix output:</p>
                <pre className="text-xs text-muted-foreground whitespace-pre-wrap max-h-48 overflow-y-auto">{fixOutput || '(no output)'}</pre>
              </div>
            )}
            <div className="divide-y">
              {packages.map((pkg) => (
                <div key={pkg.label} className="py-3">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="text-sm font-mono font-medium truncate">{pkg.label}</p>
                      {pkg.summary && <p className="text-xs text-muted-foreground mt-0.5">{pkg.summary}</p>}
                    </div>
                    <span className="text-xs text-muted-foreground shrink-0">{pkg.total} issue{pkg.total !== 1 ? 's' : ''}</span>
                  </div>
                  {Array.isArray(pkg.vulnerabilities) && pkg.vulnerabilities.length > 0 && (
                    <div className="mt-2 flex flex-wrap gap-1.5">
                      {pkg.vulnerabilities.map((v, i) => (
                        <div key={i} className="flex items-center gap-1">
                          <SeverityBadge level={v.severity ?? 'unknown'} />
                          {v.title && <span className="text-xs text-muted-foreground">{v.title}</span>}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Outdated packages */}
      {outdated.length > 0 && (
        <Card>
          <CardHeader><CardTitle className="text-sm">npm outdated — {outdated.length} package{outdated.length !== 1 ? 's' : ''} behind</CardTitle></CardHeader>
          <CardContent>
            <div className="flex flex-wrap gap-2">
              {outdated.map((pkg) => (
                <span key={pkg} className="text-xs font-mono bg-muted px-2 py-1 rounded">{pkg}</span>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {/* ESLint results */}
      {data?.eslint && (
        <Card>
          <CardHeader>
            <CardTitle className="text-sm flex items-center gap-2">
              eslint-plugin-security
              {eslintIssues.length > 0
                ? <span className="text-xs font-normal text-muted-foreground">— {eslintIssues.length} issue{eslintIssues.length !== 1 ? 's' : ''}</span>
                : data?.eslint?.error
                ? <span className="text-xs font-normal text-destructive">— {data.eslint.error as string}</span>
                : <span className="text-xs font-normal text-green-600 dark:text-green-400">— no issues</span>
              }
            </CardTitle>
          </CardHeader>
          {eslintIssues.length > 0 && (
            <CardContent>
              <StaticIssueTableWithGuidance issues={eslintIssues} type="eslint" />
            </CardContent>
          )}
        </Card>
      )}

      {/* Semgrep results */}
      {data?.semgrep && (
        <Card>
          <CardHeader>
            <CardTitle className="text-sm flex items-center gap-2">
              semgrep
              {semgrepIssues.length > 0
                ? <span className="text-xs font-normal text-muted-foreground">— {semgrepIssues.length} issue{semgrepIssues.length !== 1 ? 's' : ''}</span>
                : data?.semgrep?.error
                ? <span className="text-xs font-normal text-destructive">— {data.semgrep.error as string}</span>
                : <span className="text-xs font-normal text-green-600 dark:text-green-400">— no issues</span>
              }
            </CardTitle>
          </CardHeader>
          {semgrepIssues.length > 0 && (
            <CardContent>
              <StaticIssueTableWithGuidance issues={semgrepIssues} type="semgrep" />
            </CardContent>
          )}
        </Card>
      )}

      {!data && !isLoading && (
        <Card>
          <CardContent className="py-8 text-center text-sm text-muted-foreground">
            Click &quot;Run Audit&quot; to scan for vulnerabilities.
          </CardContent>
        </Card>
      )}
    </div>
  );
}

// ─── Main Page ────────────────────────────────────────────────────────────────

export default function SecurityPage() {
  return (
    <div className="p-6 space-y-6 max-w-5xl">
      <PageHeader
        title="Security"
        description="Access rules, brute-force protection, TLS certificates, and vulnerability management"
      />

      <Tabs defaultValue="overview">
        <TabsList className="mb-4">
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="access-rules">Access Rules</TabsTrigger>
          <TabsTrigger value="fail2ban">fail2ban</TabsTrigger>
          <TabsTrigger value="tls">TLS / Certs</TabsTrigger>
          <TabsTrigger value="os-updates">OS Updates</TabsTrigger>
          <TabsTrigger value="code-audit">Code Audit</TabsTrigger>
        </TabsList>

        <TabsContent value="overview">
          <OverviewTab />
        </TabsContent>

        <TabsContent value="access-rules">
          <AccessRulesTab />
        </TabsContent>

        <TabsContent value="fail2ban">
          <Fail2banTab />
        </TabsContent>

        <TabsContent value="tls">
          <TlsTab />
        </TabsContent>

        <TabsContent value="os-updates">
          <OsUpdatesTab />
        </TabsContent>

        <TabsContent value="code-audit">
          <CodeAuditTab />
        </TabsContent>
      </Tabs>
    </div>
  );
}
