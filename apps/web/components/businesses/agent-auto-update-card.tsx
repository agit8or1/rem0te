'use client';

import Link from 'next/link';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { RefreshCw } from 'lucide-react';
import { clientUpdatesApi } from '@/lib/api-client';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { useToast } from '@/hooks/use-toast';
import { useAsks } from '@/lib/confirm-policy';

type Mode = 'ANY_TIME' | 'WINDOW' | 'OFF';
interface PolicyRead {
  policy: null | { agentMode: Mode | null; description: string | null; valid: boolean };
  may: { edit: boolean; reason: string | null };
  agentAuto?: { platformEnabled: boolean; processOn: boolean };
}

/**
 * 0.46: a business's "Automatic agent updates" selector, on the business's
 * own page. It writes only the business policy's agent mode (PUT
 * /client-updates/policy/agent-mode), never the RustDesk client checkbox.
 * Who may change it, and when a step-up is asked, are the server's
 * decisions: anything but Off asks the person to confirm it is them. Windows,
 * site overrides and device groups stay on Patching → Client updates.
 */
export function AgentAutoUpdateCard({ businessId }: { businessId: string }) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const { data, isError } = useQuery<PolicyRead>({
    queryKey: ['client-update-policy', businessId],
    queryFn: () => clientUpdatesApi.policy(businessId).then((r) => r.data?.data),
    retry: false,
  });
  const set = useMutation({
    mutationFn: (m: Mode | null) => clientUpdatesApi.setAgentMode(businessId, m),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['client-update-policy'] });
      qc.invalidateQueries({ queryKey: ['endpoint-agent'] });
      toast({ title: 'Saved', description: 'Automatic agent updates for this customer are changed. A device set to On or Off on its own Agent card keeps its own setting.' });
    },
    onError: (e) => toast({ title: 'Not saved', description: (e as { response?: { data?: { message?: string } } })?.response?.data?.message ?? 'The request failed.', variant: 'destructive' }),
  });
  const askMode = useAsks('agent.autoupdate.business');
  // Without computers:view there is nothing to show (and nothing to change).
  if (isError || !data) return null;
  const platformOn = (data.agentAuto?.platformEnabled ?? true) && (data.agentAuto?.processOn ?? true);
  const value = data.policy?.agentMode ?? '';
  const effective = value === '' ? (platformOn ? 'On' : 'Off') : value === 'OFF' || !platformOn ? 'Off' : value === 'WINDOW' ? 'In maintenance window' : 'On';
  return (
    <Card data-testid="business-agent-auto-update">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-sm"><RefreshCw className="h-4 w-4" /> Automatic agent updates</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        <p className="text-muted-foreground">
          When a device’s agent is older than this server’s, its next check-in updates it — never during a remote session, a
          few attempts per release at most, paced across the platform. <span className="font-medium text-foreground">On by default</span>:
          with nothing set here or on a device, every device updates its agent.
        </p>
        <div className="space-y-1 md:w-[28rem]">
          <label htmlFor="biz-agent-auto-update" className="text-sm font-medium">For this customer</label>
          <select id="biz-agent-auto-update" data-testid="business-agent-auto-update-select" className="w-full rounded-md border bg-background p-2 text-sm"
            value={value} disabled={!data.may.edit || set.isPending} onChange={(e) => set.mutate(e.target.value === '' ? null : (e.target.value as Mode))}>
            <option value="">Inherit global ({platformOn ? 'On' : 'Off'})</option>
            <option value="ANY_TIME">On — any time, paced</option>
            <option value="OFF">Off — never update agents automatically</option>
            <option value="WINDOW">In maintenance window{data.policy?.description ? ` (${data.policy.description})` : ''}</option>
          </select>
          <p className="text-xs text-muted-foreground" data-testid="business-agent-auto-update-effective">
            Effective for this customer: <span className="font-medium text-foreground">{effective}</span>.
            {!platformOn && ' Automatic agent updates are off for the whole platform, which wins over every customer and device.'}
          </p>
        </div>
        <p className="text-xs text-muted-foreground">
          A site or device group with its own setting, and a device set to On or Off on its Agent card, win over this one
          (device → device group → site → customer → global). The maintenance window, site overrides and device groups are set on{' '}
          <Link className="underline" href="/settings/client-updates">Patching → Client updates</Link>. This does not change the
          RustDesk client update setting there. {askMode ? 'Off takes effect at once; anything else asks you to confirm it is you.' : 'A change takes effect at once.'}
        </p>
        {!data.may.edit && data.may.reason && <p className="text-xs text-muted-foreground">{data.may.reason}</p>}
      </CardContent>
    </Card>
  );
}
