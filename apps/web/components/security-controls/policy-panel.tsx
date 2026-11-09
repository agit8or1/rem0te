'use client';

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Info, Lock, Plus, Trash2 } from 'lucide-react';
import { securityControlsApi } from '@/lib/api-client';
import { usePermissions } from '@/lib/auth';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { useToast } from '@/hooks/use-toast';
import { apiError, CHIP, Chip, type ReviewResult, type TrustChange } from './shared';

// ─── Shapes (presets.ts AccessControls, redacted) ────────────────────────────

const TIERS = ['L1', 'L2', 'L3', 'custom', 'member', 'platformAdmin', 'integration'] as const;
type TierKey = (typeof TIERS)[number];
const TIER_LABEL: Record<TierKey, string> = {
  L1: 'L1 Help Desk', L2: 'L2 Technician', L3: 'L3 Senior', custom: 'Custom (pre-0.23 assignments)',
  member: 'Business members', platformAdmin: 'Platform Admins', integration: 'Integrations',
};
const LIMITS = ['devices', 'businesses', 'launches', 'writes'] as const;
type LimitKey = (typeof LIMITS)[number];
type Thresholds = Record<LimitKey, number>;

const MANDATORY_CLASSES = ['DOMAIN_CONTROLLER', 'HYPERVISOR', 'BACKUP_SERVER', 'RMM_HOST'] as const;
const OPTIONAL_CLASSES = ['SERVER'] as const;
const CLASS_LABEL: Record<string, string> = {
  DOMAIN_CONTROLLER: 'Domain controllers', HYPERVISOR: 'Hypervisors', BACKUP_SERVER: 'Backup servers',
  RMM_HOST: 'RMM hosts', SERVER: 'Other servers',
};

interface RedactedDestination { kind: 'webhook'; label: string; origin: string; ref: string }
interface NewDestination { kind: 'webhook'; label: string; url: string }
type Destination = RedactedDestination | NewDestination;

interface Controls {
  attendedConsent: 'required' | 'not_required';
  unattendedAccess: 'off' | 'request';
  clipboard: 'off' | 'request';
  fileTransfer: 'off' | 'request';
  trustedWorkstations: 'required_for_protected' | 'required_for_all';
  protectedClasses: string[];
  maxSessionMinutes: number;
  windowMinutes: number;
  thresholds: Record<TierKey, Thresholds>;
  maintenanceExceptions: 'off' | 'request';
  alertDestinations: Destination[];
}

const CHOICES: { key: 'attendedConsent' | 'unattendedAccess' | 'clipboard' | 'fileTransfer' | 'trustedWorkstations' | 'maintenanceExceptions'; label: string; help: string; options: [string, string][] }[] = [
  { key: 'attendedConsent', label: 'Customer consent at the endpoint', help: 'Whether an interactive session needs the person at the computer to accept it.',
    options: [['required', 'Required'], ['not_required', 'Not required']] },
  { key: 'unattendedAccess', label: 'Unattended access', help: 'Sessions with nobody at the computer.',
    options: [['off', 'Off'], ['request', 'Request time-limited']] },
  { key: 'clipboard', label: 'Clipboard', help: 'Controlled on the technician’s RustDesk client; the endpoint cannot enforce it per session.',
    options: [['off', 'Off'], ['request', 'Request time-limited']] },
  { key: 'fileTransfer', label: 'File transfer', help: 'Controlled on the technician’s RustDesk client; the endpoint cannot enforce it per session.',
    options: [['off', 'Off'], ['request', 'Request time-limited']] },
  { key: 'trustedWorkstations', label: 'Managed admin workstations', help: 'Where a session must start from a designated managed workstation through the launcher.',
    options: [['required_for_protected', 'Required for protected computers'], ['required_for_all', 'Required for every session']] },
  { key: 'maintenanceExceptions', label: 'Maintenance exceptions', help: 'Time-boxed, reviewed exceptions to the activity limits for planned work.',
    options: [['off', 'Off'], ['request', 'Request time-limited']] },
];

export function PolicyPanel() {
  const { isPlatformAdmin } = usePermissions();
  const { data, isLoading, isError, error } = useQuery<{ platform: Controls; pending: TrustChange[] }>({
    queryKey: ['security-controls', 'policy'],
    queryFn: () => securityControlsApi.policy().then((r) => r.data?.data),
    retry: false,
  });

  if (isLoading) return <p className="text-sm text-muted-foreground">Loading policy…</p>;
  if (isError || !data) return <p className="text-sm text-destructive">{apiError(error, 'Could not load the policy').message}</p>;
  // Keyed on the loaded policy so a save (or someone else's) resets the form.
  return <PolicyForm key={JSON.stringify(data.platform)} initial={data.platform} pending={data.pending ?? []} canSave={isPlatformAdmin} />;
}

function PolicyForm({ initial, pending, canSave }: { initial: Controls; pending: TrustChange[]; canSave: boolean }) {
  const [c, setC] = useState<Controls>(() => structuredClone(initial));
  const [newDest, setNewDest] = useState({ label: '', url: '' });
  const qc = useQueryClient();
  const { toast } = useToast();
  const dirty = JSON.stringify(c) !== JSON.stringify(initial);

  const save = useMutation({
    mutationFn: () => securityControlsApi.setPolicy({
      ...c,
      // Existing destinations go back as their ref: the server keeps the
      // stored URL, which is a secret and never leaves it.
      alertDestinations: c.alertDestinations.map((d) => ('ref' in d ? { ref: d.ref, label: d.label } : { kind: 'webhook', url: d.url, label: d.label })),
    }),
    onSuccess: (res) => {
      const d = res.data?.data as ReviewResult<'policy', Controls>;
      toast(d?.pendingReview
        ? { title: 'Sent for independent review', description: `This change widens trust (${d.request.widening.join('; ')}). It applies once someone other than you approves it.` }
        : { title: 'Policy saved', description: 'Tightening applies at once.' });
      qc.invalidateQueries({ queryKey: ['security-controls'] });
    },
    onError: (e) => toast({ title: 'Could not save the policy', description: apiError(e).message, variant: 'destructive' }),
  });

  const setThreshold = (t: TierKey, k: LimitKey, v: number) =>
    setC({ ...c, thresholds: { ...c.thresholds, [t]: { ...c.thresholds[t], [k]: v } } });
  const toggleClass = (cls: string) =>
    setC({ ...c, protectedClasses: c.protectedClasses.includes(cls) ? c.protectedClasses.filter((x) => x !== cls) : [...c.protectedClasses, cls] });

  return (
    <div className="space-y-4">
      <div className="flex items-start gap-2 rounded-md border bg-muted/40 p-3 text-sm text-muted-foreground">
        <Info className="mt-0.5 h-4 w-4 shrink-0" />
        <div>
          A change that <strong className="text-foreground">widens</strong> trust (looser consent, fewer protected computers,
          longer sessions, higher activity limits, different alert contacts) is not applied: it goes to independent review and
          someone other than you must approve it. A change that <strong className="text-foreground">tightens</strong> applies at once.
          Every save needs a fresh confirmation that it is you.
          {!canSave && ' Only a Platform Admin can change the platform policy; it is shown here read-only.'}
        </div>
      </div>

      {pending.length > 0 && (
        <div className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-200">
          {pending.length} change{pending.length === 1 ? ' is' : 's are'} waiting for independent review. See the Reviews tab.
        </div>
      )}

      <Card>
        <CardHeader><CardTitle className="text-sm">Sessions</CardTitle></CardHeader>
        <CardContent className="space-y-4">
          {CHOICES.map((ch) => (
            <div key={ch.key} className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0 max-w-md">
                <Label>{ch.label}</Label>
                <p className="text-xs text-muted-foreground">{ch.help}</p>
              </div>
              <Select value={c[ch.key]} onValueChange={(v) => setC({ ...c, [ch.key]: v })} disabled={!canSave}>
                <SelectTrigger className="h-9 w-64"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {ch.options.map(([v, l]) => <SelectItem key={v} value={v}>{l}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
          ))}
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="pol-max">Maximum session length (minutes)</Label>
              <Input id="pol-max" type="number" min={5} max={480} disabled={!canSave}
                value={c.maxSessionMinutes} onChange={(e) => setC({ ...c, maxSessionMinutes: parseInt(e.target.value, 10) || 0 })} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="pol-win">Activity window (minutes)</Label>
              <Input id="pol-win" type="number" min={5} max={1440} disabled={!canSave}
                value={c.windowMinutes} onChange={(e) => setC({ ...c, windowMinutes: parseInt(e.target.value, 10) || 0 })} />
              <p className="text-xs text-muted-foreground">The limits below count work within this window. A shorter window allows more work per day.</p>
            </div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-sm">Protected computers</CardTitle>
          <CardDescription>
            Interactive access to a protected computer needs an independently approved exception, activated with a passkey,
            from a managed admin workstation.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-2 sm:grid-cols-2">
          {MANDATORY_CLASSES.map((cls) => (
            <div key={cls} className="flex items-center justify-between gap-2 rounded-md border px-3 py-2 text-sm">
              <span>{CLASS_LABEL[cls]}</span>
              <Chip className={CHIP.locked} title="Always protected; cannot be removed."><Lock className="h-3 w-3" />Locked</Chip>
            </div>
          ))}
          {OPTIONAL_CLASSES.map((cls) => (
            <label key={cls} className="flex items-center justify-between gap-2 rounded-md border px-3 py-2 text-sm">
              <span>{CLASS_LABEL[cls]}</span>
              <input type="checkbox" className="h-4 w-4" disabled={!canSave}
                checked={c.protectedClasses.includes(cls)} onChange={() => toggleClass(cls)} />
            </label>
          ))}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-sm">Activity limits per window</CardTitle>
          <CardDescription>
            Reaching a limit pauses that identity&apos;s privileged work and alerts the contacts below. Only someone else can clear the pause.
          </CardDescription>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b text-left text-xs text-muted-foreground">
                <th className="py-2 pr-3 font-medium">Who</th>
                <th className="px-2 py-2 font-medium">Computers</th>
                <th className="px-2 py-2 font-medium">Businesses</th>
                <th className="px-2 py-2 font-medium">Launches</th>
                <th className="px-2 py-2 font-medium">Writes</th>
              </tr>
            </thead>
            <tbody>
              {TIERS.map((t) => (
                <tr key={t} className="border-b last:border-0">
                  <td className="py-1.5 pr-3">{TIER_LABEL[t]}</td>
                  {LIMITS.map((k) => (
                    <td key={k} className="px-2 py-1.5">
                      <Input type="number" min={0} className="h-8 w-24" disabled={!canSave}
                        value={c.thresholds?.[t]?.[k] ?? 0}
                        onChange={(e) => setThreshold(t, k, parseInt(e.target.value, 10) || 0)} />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-sm">Alert contacts</CardTitle>
          <CardDescription>
            Independent webhooks told about pauses, protected-computer exceptions and trust changes. A webhook URL is a
            secret: once saved only its origin is shown. Any change to this list is reviewed by someone else, and the
            previous contacts are told.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {c.alertDestinations.length === 0 && <p className="text-sm text-muted-foreground">No alert contacts. Alerts are recorded but not delivered anywhere.</p>}
          {c.alertDestinations.map((d, i) => (
            <div key={'ref' in d ? d.ref : `new-${i}`} className="flex flex-wrap items-center gap-2 rounded-md border px-3 py-2 text-sm">
              <span className="font-medium">{d.label || '(no label)'}</span>
              <span className="font-mono text-xs text-muted-foreground">{'ref' in d ? d.origin : `${safeOrigin(d.url)} (new)`}</span>
              {canSave && (
                <Button size="sm" variant="ghost" className="ml-auto h-7"
                  onClick={() => setC({ ...c, alertDestinations: c.alertDestinations.filter((_, j) => j !== i) })}>
                  <Trash2 className="h-4 w-4" />
                </Button>
              )}
            </div>
          ))}
          {canSave && c.alertDestinations.length < 5 && (
            <div className="grid gap-2 sm:grid-cols-[1fr_2fr_auto]">
              <Input placeholder="Label" maxLength={64} value={newDest.label} onChange={(e) => setNewDest({ ...newDest, label: e.target.value })} />
              <Input placeholder="https://hooks.example.com/…" maxLength={512} value={newDest.url} onChange={(e) => setNewDest({ ...newDest, url: e.target.value })} />
              <Button variant="outline" disabled={!newDest.url.trim()}
                onClick={() => {
                  setC({ ...c, alertDestinations: [...c.alertDestinations, { kind: 'webhook', label: newDest.label.trim(), url: newDest.url.trim() }] });
                  setNewDest({ label: '', url: '' });
                }}>
                <Plus className="mr-1.5 h-4 w-4" />Add
              </Button>
            </div>
          )}
        </CardContent>
      </Card>

      {canSave && (
        <div className="flex items-center gap-3">
          <Button onClick={() => save.mutate()} disabled={!dirty || save.isPending}>
            {save.isPending ? 'Saving…' : 'Save policy'}
          </Button>
          {dirty && <Button variant="outline" onClick={() => setC(structuredClone(initial))}>Discard changes</Button>}
        </div>
      )}
    </div>
  );
}

function safeOrigin(url: string) {
  try { return new URL(url).origin; } catch { return url; }
}
