'use client';

/**
 * Patching, guided (0.94, UX P1-8; directive §14): one device's update
 * lifecycle as the eleven stages, and who owns its updates in plain English.
 * Display only, from the Patches tab's own read; nothing here requests,
 * approves, installs or restarts anything.
 */

import { useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import { CardHeading } from '@/components/endpoints/card-heading';
import { ListChecks, ShieldQuestion } from 'lucide-react';
import { deviceLifecycle, ownershipSummary, type DeviceFacts, type StageStatus } from '@/lib/patch-lifecycle';

const STATUS: Record<StageStatus, { label: string; variant: 'success' | 'destructive' | 'warning' | 'outline' | 'secondary' }> = {
  done: { label: 'Done', variant: 'success' },
  now: { label: 'Now', variant: 'secondary' },
  failed: { label: 'Failed', variant: 'destructive' },
  not_seen: { label: 'Not yet', variant: 'outline' },
  not_reported: { label: 'Not reported', variant: 'outline' },
};

export function PatchLifecycleCard({ facts }: { facts: DeviceFacts }) {
  const [open, setOpen] = useState<string | null>(null);
  const rows = deviceLifecycle(facts);
  return (
    <Card data-testid="patch-lifecycle">
      <CardHeading title="Update lifecycle" icon={ListChecks} />
      <CardContent className="space-y-2 text-xs">
        <p className="text-muted-foreground">Each stage is marked only from what the device and the approval signer reported. &ldquo;Not reported&rdquo; means Rem0te cannot see that stage, not that it went wrong.</p>
        <ol className="divide-y rounded-md border">
          {rows.map((r) => {
            const s = STATUS[r.status];
            return (
              <li key={r.stage.id} className="px-2 py-1.5" data-testid={`lifecycle-${r.stage.id}`} data-status={r.status}>
                <div className="flex flex-wrap items-center gap-2">
                  <span className="min-w-[11rem] font-medium">{r.stage.label}</span>
                  <Badge variant={s.variant} className="text-xs">{s.label}</Badge>
                  <span className="min-w-0 flex-1 break-words text-muted-foreground">{r.note}</span>
                  <button type="button" className="text-primary hover:underline" aria-expanded={open === r.stage.id} onClick={() => setOpen(open === r.stage.id ? null : r.stage.id)}>
                    {open === r.stage.id ? 'Hide' : 'What is this?'}
                  </button>
                </div>
                {open === r.stage.id && (
                  <p className="mt-1 text-muted-foreground" data-testid={`lifecycle-${r.stage.id}-means`}>{r.stage.means} <span className="text-foreground">Evidence:</span> {r.stage.evidence}</p>
                )}
              </li>
            );
          })}
        </ol>
      </CardContent>
    </Card>
  );
}

/** Who owns updates on this device, why Rem0te steps back, and where to change it. */
export function UpdateOwnership({ state, managers }: { state: 'rem0te_or_windows_update' | 'external' | 'unknown'; managers: { id: string; label?: string }[] }) {
  const o = ownershipSummary(state, managers);
  return (
    <div className="space-y-2 rounded-md border p-3 text-xs" data-testid="update-ownership" data-state={state}>
      <p className="flex items-center gap-2 font-medium"><ShieldQuestion className="h-4 w-4 shrink-0" aria-hidden="true" />Who manages updates: {o.headline}</p>
      <p className="text-muted-foreground">{o.detail}</p>
      {o.owners.map((m) => (
        <dl key={m.id} className="space-y-1 border-t pt-2" data-testid={`ownership-${m.id}`}>
          <div><dt className="inline font-medium">What it is: </dt><dd className="inline">{m.whatItIs}</dd></div>
          <div><dt className="inline font-medium">What Rem0te does: </dt><dd className="inline">{m.whatRem0teDoes}</dd></div>
          <div><dt className="inline font-medium">To change it: </dt><dd className="inline">{m.whereToChange}</dd></div>
        </dl>
      ))}
    </div>
  );
}
