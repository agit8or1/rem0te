'use client';

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Copy, Loader2, Pencil, RotateCcw, Trash2 } from 'lucide-react';
import { securityControlsApi } from '@/lib/api-client';
import { ConfirmDialog } from '@/components/common/confirm-dialog';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { useToast } from '@/hooks/use-toast';
import {
  apiError, ControlChip, valueLabel,
  type ControlStatus, type PolicyField, type Preset, type PresetList, type PresetPolicy, type ReviewResult,
} from './shared';

/**
 * The values each control may be set to from this page. Kept to what the
 * server's validatePolicy accepts, so the form never offers a value that is
 * refused outright: standing control and standing elevation are never
 * configurable, and unattended, clipboard and file transfer are off for every
 * tier. Locked controls are not editable at all.
 */
const OPTIONS: Partial<Record<PolicyField, string[]>> = {
  inventoryView: ['off', 'allowed'],
  supportRequests: ['off', 'allowed'],
  eventLogs: ['off', 'allowed'],
  diagnostics: ['off', 'basic', 'advanced'],
  remoteViewOnly: ['off', 'request', 'allowed'],
  remoteControl: ['off', 'request'],
  elevation: ['off', 'request'],
  unattended: ['off'],
  clipboard: ['off'],
  fileTransfer: ['off'],
  patches: ['off', 'request'],
  fixRequests: ['off', 'low_risk', 'higher_risk'],
};

interface Preview {
  widening: string[];
  needsReview: boolean;
  capabilities: { gains: string[]; loses: string[] };
  affectedAssignments: number;
}

export function PresetsPanel() {
  const { data, isLoading, isError, error } = useQuery<PresetList>({
    queryKey: ['security-controls', 'presets'],
    queryFn: () => securityControlsApi.presets().then((r) => r.data?.data),
    retry: false,
  });
  const [editing, setEditing] = useState<Preset | null>(null);
  const [cloning, setCloning] = useState<Preset | null>(null);
  const [resetting, setResetting] = useState<Preset | null>(null);
  const [deleting, setDeleting] = useState<Preset | null>(null);
  const qc = useQueryClient();
  const { toast } = useToast();

  const reset = useMutation({
    mutationFn: (p: Preset) => securityControlsApi.resetPreset(p.id),
    onSuccess: (res) => {
      const d = res.data?.data as ReviewResult<'preset', Preset>;
      toast(d?.pendingReview
        ? { title: 'Sent for independent review', description: 'The shipped definition is wider than the current one, so someone else must approve the reset.' }
        : { title: 'Preset reset to its shipped definition' });
      qc.invalidateQueries({ queryKey: ['security-controls'] });
      setResetting(null);
    },
    onError: (e) => toast({ title: 'Could not reset the preset', description: apiError(e).message, variant: 'destructive' }),
  });

  const remove = useMutation({
    mutationFn: (p: Preset) => securityControlsApi.deletePreset(p.id),
    onSuccess: () => {
      toast({ title: 'Preset deleted' });
      qc.invalidateQueries({ queryKey: ['security-controls'] });
      setDeleting(null);
    },
    onError: (e) => toast({ title: 'Could not delete the preset', description: apiError(e).message, variant: 'destructive' }),
  });

  if (isLoading) return <p className="text-sm text-muted-foreground">Loading presets…</p>;
  if (isError || !data) return <p className="text-sm text-destructive">{apiError(error, 'Could not load presets').message}</p>;

  const fields = Object.keys(data.controlStatus) as PolicyField[];

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        A preset is what a technician assignment grants. Capabilities are derived from the preset on every request, so
        a change here applies to every assignment using it at once. No preset grants Remote connect or credential access;
        interactive control is only ever a temporary, independently approved grant.
      </p>

      {data.presets.map((p) => (
        <Card key={p.id}>
          <CardHeader className="pb-3">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0 space-y-1">
                <CardTitle className="flex flex-wrap items-center gap-2 text-base">
                  {p.name}
                  <Badge variant="outline">{p.tier}</Badge>
                  <Badge variant="secondary">{p.builtIn ? 'Built-in' : 'Custom'}</Badge>
                  <span className="text-xs font-normal text-muted-foreground">
                    v{p.version} · {p._count?.assignments ?? 0} active assignment{(p._count?.assignments ?? 0) === 1 ? '' : 's'}
                  </span>
                </CardTitle>
                {p.description && <CardDescription>{p.description}</CardDescription>}
              </div>
              <div className="flex flex-wrap gap-2">
                <Button size="sm" variant="outline" onClick={() => setCloning(p)}><Copy className="mr-1.5 h-4 w-4" />Clone</Button>
                <Button size="sm" variant="outline" onClick={() => setEditing(p)}><Pencil className="mr-1.5 h-4 w-4" />Edit</Button>
                {p.builtIn ? (
                  <Button size="sm" variant="outline" onClick={() => setResetting(p)}><RotateCcw className="mr-1.5 h-4 w-4" />Reset defaults</Button>
                ) : (
                  <Button
                    size="sm" variant="outline" onClick={() => setDeleting(p)}
                    disabled={(p._count?.assignments ?? 0) > 0}
                    title={(p._count?.assignments ?? 0) > 0 ? 'Revoke or move the assignments using this preset first' : undefined}
                  >
                    <Trash2 className="mr-1.5 h-4 w-4" />Delete
                  </Button>
                )}
              </div>
            </div>
          </CardHeader>
          <CardContent className="pt-0">
            <div className="divide-y rounded-md border">
              {fields.map((f) => (
                <PolicyRow key={f} field={f} value={p.policy?.[f]} status={data.controlStatus[f]} />
              ))}
            </div>
          </CardContent>
        </Card>
      ))}

      <CloneDialog preset={cloning} onClose={() => setCloning(null)} />
      {editing && <EditDialog preset={editing} controlStatus={data.controlStatus} onClose={() => setEditing(null)} />}
      <ConfirmDialog
        open={!!resetting} onOpenChange={(o) => !o && setResetting(null)}
        title={`Reset ${resetting?.name ?? 'preset'}?`}
        description="Puts the preset back to the definition this version shipped with. If that is wider than what it grants today, the reset is sent for independent review rather than applied."
        confirmLabel="Reset" loading={reset.isPending}
        onConfirm={() => resetting && reset.mutate(resetting)}
      />
      <ConfirmDialog
        open={!!deleting} onOpenChange={(o) => !o && setDeleting(null)}
        title={`Delete ${deleting?.name ?? 'preset'}?`}
        description="Removes this custom preset. A preset still used by an active assignment cannot be deleted."
        confirmLabel="Delete" destructive loading={remove.isPending}
        onConfirm={() => deleting && remove.mutate(deleting)}
      />
    </div>
  );
}

function PolicyRow({ field, value, status }: { field: string; value: unknown; status?: ControlStatus }) {
  const why = status?.locked ?? status?.unavailable;
  return (
    <div className="flex items-start justify-between gap-4 px-3 py-2 text-sm">
      <div className="min-w-0">
        <div className="font-medium">{status?.label ?? field}</div>
        {why && <div className="text-xs text-muted-foreground">{why}</div>}
        {status?.unavailable && value !== undefined && value !== 'off' && (
          <div className="text-xs text-muted-foreground">Configured: {valueLabel(field, value)} — the launch decision still refuses what cannot be enforced.</div>
        )}
      </div>
      <ControlChip field={field} value={value} status={status} />
    </div>
  );
}

function CloneDialog({ preset, onClose }: { preset: Preset | null; onClose: () => void }) {
  const [name, setName] = useState('');
  const [forId, setForId] = useState<string | null>(null);
  if (preset && forId !== preset.id) { setForId(preset.id); setName(`${preset.name} (copy)`); }
  if (!preset && forId !== null) setForId(null);
  const qc = useQueryClient();
  const { toast } = useToast();
  const clone = useMutation({
    mutationFn: () => securityControlsApi.clonePreset(preset!.id, name.trim()),
    onSuccess: () => {
      toast({ title: 'Preset cloned', description: 'The copy starts with the same policy and tier. Edit it to adjust.' });
      qc.invalidateQueries({ queryKey: ['security-controls'] });
      onClose();
    },
    onError: (e) => toast({ title: 'Could not clone the preset', description: apiError(e).message, variant: 'destructive' }),
  });
  return (
    <Dialog open={!!preset} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Clone preset</DialogTitle>
          <DialogDescription>A custom copy of {preset?.name}, with the same tier and policy.</DialogDescription>
        </DialogHeader>
        <div className="space-y-1.5">
          <Label htmlFor="clone-name">Name</Label>
          <Input id="clone-name" maxLength={100} value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button onClick={() => clone.mutate()} disabled={!name.trim() || clone.isPending}>
            {clone.isPending ? 'Cloning…' : 'Clone'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function EditDialog({ preset, controlStatus, onClose }: { preset: Preset; controlStatus: Record<string, ControlStatus>; onClose: () => void }) {
  const [name, setName] = useState(preset.name);
  const [description, setDescription] = useState(preset.description ?? '');
  const [policy, setPolicy] = useState<PresetPolicy>({ ...preset.policy });
  const [preview, setPreview] = useState<Preview | null>(null);
  const qc = useQueryClient();
  const { toast } = useToast();

  const set = <K extends PolicyField>(k: K, v: PresetPolicy[K]) => { setPolicy({ ...policy, [k]: v }); setPreview(null); };

  const runPreview = useMutation({
    mutationFn: () => securityControlsApi.previewPreset(preset.id, policy as unknown as Record<string, unknown>),
    onSuccess: (res) => setPreview(res.data?.data as Preview),
    onError: (e) => toast({ title: 'That policy was refused', description: apiError(e).message, variant: 'destructive' }),
  });

  const save = useMutation({
    mutationFn: () => securityControlsApi.updatePreset(preset.id, {
      ...(name.trim() && name.trim() !== preset.name ? { name: name.trim() } : {}),
      ...(description !== (preset.description ?? '') ? { description } : {}),
      policy: policy as unknown as Record<string, unknown>,
    }),
    onSuccess: (res) => {
      const d = res.data?.data as ReviewResult<'preset', Preset>;
      toast(d?.pendingReview
        ? { title: 'Sent for independent review', description: `This change widens the tier (${d.request.widening.join('; ')}). It applies once someone other than you approves it.` }
        : { title: 'Preset saved', description: 'It applies to every assignment using this preset on their next request.' });
      qc.invalidateQueries({ queryKey: ['security-controls'] });
      onClose();
    },
    onError: (e) => toast({ title: 'Could not save the preset', description: apiError(e).message, variant: 'destructive' }),
  });

  const fields = Object.keys(controlStatus) as PolicyField[];

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Edit {preset.name}</DialogTitle>
          <DialogDescription>
            Locked controls cannot be changed. A change that widens what the tier may do is sent for independent review;
            a tightening applies at once.
          </DialogDescription>
        </DialogHeader>
        <div className="max-h-[60vh] space-y-4 overflow-y-auto pr-1">
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="pe-name">Name</Label>
              <Input id="pe-name" maxLength={100} value={name} onChange={(e) => setName(e.target.value)} />
            </div>
            <div className="space-y-1.5 sm:col-span-2">
              <Label htmlFor="pe-desc">Description</Label>
              <Textarea id="pe-desc" rows={2} maxLength={500} value={description} onChange={(e) => setDescription(e.target.value)} />
            </div>
          </div>

          <div className="divide-y rounded-md border">
            {fields.map((f) => {
              const st = controlStatus[f];
              const v = policy[f];
              return (
                <div key={f} className="flex items-start justify-between gap-4 px-3 py-2 text-sm">
                  <div className="min-w-0">
                    <div className="font-medium">{st?.label ?? f}</div>
                    {(st?.locked || st?.unavailable) && <div className="text-xs text-muted-foreground">{st.locked ?? st.unavailable}</div>}
                  </div>
                  <div className="shrink-0">
                    {st?.locked ? (
                      <ControlChip field={f} value={v} status={st} />
                    ) : f === 'standardWorkstationsOnly' ? (
                      <label className="flex items-center gap-2 text-sm">
                        <input type="checkbox" className="h-4 w-4" checked={!!v} onChange={(e) => set('standardWorkstationsOnly', e.target.checked)} />
                        {v ? 'Yes' : 'No'}
                      </label>
                    ) : f === 'maxSessionMinutes' ? (
                      <Input
                        type="number" min={5} max={480} className="h-8 w-24"
                        value={String(v)} onChange={(e) => set('maxSessionMinutes', parseInt(e.target.value, 10) || 0)}
                      />
                    ) : (
                      <Select value={String(v)} onValueChange={(nv) => set(f, nv as PresetPolicy[typeof f])}>
                        <SelectTrigger className="h-8 w-48"><SelectValue /></SelectTrigger>
                        <SelectContent>
                          {[...new Set([...(OPTIONS[f] ?? []), String(v)])].map((o) => (
                            <SelectItem key={o} value={o}>{valueLabel(f, o)}</SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    )}
                  </div>
                </div>
              );
            })}
          </div>

          {preview && (
            <div className="space-y-2 rounded-md border bg-muted/40 p-3 text-sm">
              <div className="font-medium">
                {preview.needsReview ? 'This change widens the tier and needs independent review' : 'This change does not widen the tier and applies at once'}
              </div>
              {preview.widening.length > 0 && (
                <ul className="list-disc pl-5 text-xs">
                  {preview.widening.map((w) => <li key={w} className="font-mono">{w}</li>)}
                </ul>
              )}
              <div className="text-xs text-muted-foreground">
                Capabilities gained: {preview.capabilities.gains.length ? preview.capabilities.gains.join(', ') : 'none'} ·
                lost: {preview.capabilities.loses.length ? preview.capabilities.loses.join(', ') : 'none'} ·
                {' '}{preview.affectedAssignments} active assignment{preview.affectedAssignments === 1 ? '' : 's'} affected
              </div>
            </div>
          )}
        </div>
        <DialogFooter className="gap-2 sm:gap-2">
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          {!preview ? (
            <Button onClick={() => runPreview.mutate()} disabled={runPreview.isPending}>
              {runPreview.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}Review changes
            </Button>
          ) : (
            <Button onClick={() => save.mutate()} disabled={save.isPending}>
              {save.isPending ? 'Saving…' : preview.needsReview ? 'Send for review' : 'Save'}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
