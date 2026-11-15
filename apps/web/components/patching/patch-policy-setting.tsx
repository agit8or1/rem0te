'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { patchingApi, type PatchPolicySettingInput } from '@/lib/api-client';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { useToast } from '@/hooks/use-toast';
import { CalendarClock, Loader2 } from 'lucide-react';
import { describeOccurrence } from '@/lib/tasks';

/**
 * One computer's Patch policy setting (0.50), on its Patches tab and in the
 * business's policy view: Inherit (the company-wide policy), Exclude (no
 * automatic patching) or Use policy X (an assignable policy of the same
 * business). A change applies by revision of the policies involved, under
 * their bounds; Exclude also stops the sweep from planning the computer at
 * once. Saving needs Edit computers and a fresh sign-in.
 */

export interface EffectivePolicy {
  setting: { mode: 'inherit' | 'exclude' | 'policy'; seriesId: string | null; seriesName: string | null };
  effective: { state: 'covered' | 'pending' | 'left_out' | 'excluded' | 'none'; why: string; policy: { id: string; name: string; revision: number | null; ring: number } | null; series: { id: string; name: string; scope: string } | null;
    /** 0.52: the covering policy's weekly window, and when it next opens. */
    window?: { days: string[]; start: string; end: string; timezone: string } | null; nextWindow?: { start: string; end: string } | null };
  choices: { id: string; name: string }[];
  companyWide: { id: string; name: string } | null;
  mayEdit: boolean;
}

export const EFFECTIVE_LABEL: Record<EffectivePolicy['effective']['state'], { label: string; variant: 'success' | 'warning' | 'outline' | 'secondary' | 'destructive' }> = {
  covered: { label: 'Patched automatically', variant: 'success' },
  pending: { label: 'Pending a revision', variant: 'warning' },
  left_out: { label: 'Left out', variant: 'destructive' },
  excluded: { label: 'Excluded', variant: 'outline' },
  none: { label: 'No automatic patching', variant: 'outline' },
};

const selectClass = 'h-9 rounded-md border border-input bg-background px-2 text-sm';
const encode = (s: EffectivePolicy['setting']) => (s.mode === 'policy' ? `policy:${s.seriesId}` : s.mode);
const decode = (v: string): PatchPolicySettingInput => (v.startsWith('policy:') ? { mode: 'policy', seriesId: v.slice(7) } : { mode: v as 'inherit' | 'exclude' });

function apiMessage(e: unknown, fallback: string) {
  return (e as { response?: { data?: { message?: string | string[] } } })?.response?.data?.message?.toString() ?? fallback;
}

export function PatchPolicySetting({ endpointId }: { endpointId: string }) {
  const { toast } = useToast();
  const qc = useQueryClient();
  const { data: p } = useQuery({
    queryKey: ['endpoint-patch-policy', endpointId],
    queryFn: () => patchingApi.endpointPolicy(endpointId).then((r) => r.data.data as EffectivePolicy),
  });
  const [value, setValue] = useState('');
  useEffect(() => { if (p) setValue(encode(p.setting)); }, [p]);
  const save = useMutation({
    mutationFn: () => patchingApi.setEndpointPolicy(endpointId, decode(value)),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['endpoint-patch-policy', endpointId] }); qc.invalidateQueries({ queryKey: ['patch-series'] }); toast({ title: 'Patch policy saved', description: 'It applies by revision of the policies involved; this card shows where that stands.' }); },
    onError: (e) => toast({ title: 'Not saved', description: apiMessage(e, 'The setting was refused.'), variant: 'destructive' }),
  });
  if (!p) return null;
  const st = EFFECTIVE_LABEL[p.effective.state];
  return (
    <Card data-testid="patch-policy-setting">
      <CardHeader className="pb-3"><CardTitle className="text-sm flex items-center gap-2"><CalendarClock className="h-4 w-4" />Patch policy</CardTitle></CardHeader>
      <CardContent className="space-y-3 text-sm">
        <div className="flex flex-wrap items-center gap-2"><Badge variant={st.variant}>{st.label}</Badge><span className="text-xs">{p.effective.why}</span></div>
        {p.effective.policy && <p className="text-xs"><Link className="underline" href={`/patching/policies/${p.effective.policy.id}`}>Open the policy</Link></p>}
        {p.effective.window && (
          <p className="text-xs" data-testid="policy-next-window">
            {p.effective.nextWindow ? <>Next install window: <strong>{describeOccurrence(p.effective.nextWindow, p.effective.window.timezone)}</strong></> : <span className="text-muted-foreground">No install window coming up for this computer.</span>}
          </p>
        )}
        <div className="flex flex-wrap items-center gap-2">
          <select aria-label="Patch policy" className={selectClass} value={value} disabled={!p.mayEdit} onChange={(e) => setValue(e.target.value)}>
            <option value="inherit">Inherit{p.companyWide ? ` — the company-wide policy "${p.companyWide.name}"` : ' (this business has no company-wide policy)'}</option>
            <option value="exclude">Exclude — no automatic patching</option>
            {p.choices.map((c) => <option key={c.id} value={`policy:${c.id}`}>Use policy &quot;{c.name}&quot;</option>)}
            {p.setting.mode === 'policy' && !p.choices.some((c) => c.id === p.setting.seriesId) && <option value={encode(p.setting)}>Use policy &quot;{p.setting.seriesName ?? 'retired'}&quot; (retired)</option>}
          </select>
          <Button size="sm" disabled={!p.mayEdit || save.isPending || value === encode(p.setting)} onClick={() => save.mutate()}>{save.isPending && <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />}Save</Button>
        </div>
        <p className="text-xs text-muted-foreground">
          The computer&apos;s own setting comes first, then the business&apos;s company-wide policy. A computer is in one policy at a time. A change reaches the signed policy by revision — after it has held a few minutes, at most once an hour per business, and never in the middle of a deployment — and, in signed mode, after two approvals. Exclude stops automatic patching at once.
          {!p.mayEdit && ' Changing it needs Edit computers.'} <Link className="underline" href="/docs/staged-patching">Staged patching</Link>
        </p>
      </CardContent>
    </Card>
  );
}
