'use client';

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Pencil, Plus, StickyNote, X } from 'lucide-react';
import { endpointsApi, notesApi } from '@/lib/api-client';
import { CAP, usePermissions } from '@/lib/auth';
import { apiError } from '@/components/security-controls/shared';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { CardHeading } from '@/components/endpoints/card-heading';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { useToast } from '@/hooks/use-toast';
import { ago } from './device-model';

/**
 * Naming a computer (0.68): a nickname, a description, aliases and notes.
 * The API has taken all of them for a long time; the console only showed
 * them. The nickname is the computer's name in Rem0te: the agent never
 * overwrites it, and the hostname stays its own field (the header shows it
 * whenever the two differ). Changing any of it needs Edit computers.
 */

export const NAME_MAX = 100;
export const DESCRIPTION_MAX = 2000;
export const ALIAS_MAX = 64;

export function RenameDevice({ endpointId, ep }: { endpointId: string; ep: Record<string, unknown> }) {
  const { can } = usePermissions();
  const qc = useQueryClient();
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const hostname = typeof ep.hostname === 'string' ? ep.hostname : '';

  const save = useMutation({
    mutationFn: () => endpointsApi.update(endpointId, { name: name.trim(), description: description.trim() }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['endpoint', endpointId] });
      qc.invalidateQueries({ queryKey: ['device-list'] });
      setOpen(false);
      toast({ title: 'Saved' });
    },
  });

  if (!can(CAP.COMPUTERS_EDIT)) return null;
  return (
    <>
      <Button type="button" size="sm" variant="ghost" className="h-8 px-2" data-testid="rename-device"
        aria-label="Rename this computer or edit its description"
        onClick={() => { setName(String(ep.name ?? '')); setDescription(String(ep.description ?? '')); save.reset(); setOpen(true); }}>
        <Pencil className="h-4 w-4" /><span className="ml-1 text-xs">Rename</span>
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent data-testid="rename-dialog">
          <DialogHeader>
            <DialogTitle>Name and description</DialogTitle>
            <DialogDescription>
              The name is how this computer appears everywhere in Rem0te. Its hostname{hostname ? <> (<span className="font-mono">{hostname}</span>)</> : null} is
              unchanged and still searchable.
            </DialogDescription>
          </DialogHeader>
          <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); if (name.trim()) save.mutate(); }}>
            <div className="space-y-1">
              <Label htmlFor="device-name">Name</Label>
              <div className="flex gap-2">
                <Input id="device-name" value={name} maxLength={NAME_MAX} onChange={(e) => setName(e.target.value)} autoFocus data-testid="rename-name" />
                {hostname && name.trim() !== hostname && (
                  <Button type="button" variant="outline" size="sm" onClick={() => setName(hostname)}>Use hostname</Button>
                )}
              </div>
            </div>
            <div className="space-y-1">
              <Label htmlFor="device-description">Description <span className="font-normal text-muted-foreground">(optional)</span></Label>
              <Textarea id="device-description" value={description} maxLength={DESCRIPTION_MAX} rows={3} className="resize-none"
                placeholder="Who uses it, where it is, what it is for" onChange={(e) => setDescription(e.target.value)} data-testid="rename-description" />
            </div>
            {save.error && <p className="text-sm text-destructive">{apiError(save.error).message}</p>}
            <DialogFooter>
              <Button type="button" variant="ghost" onClick={() => setOpen(false)}>Cancel</Button>
              <Button type="submit" disabled={!name.trim() || save.isPending} data-testid="rename-save">Save</Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}

export function AliasEditor({ endpointId, aliases }: { endpointId: string; aliases: { id: string; alias: string }[] }) {
  const { can } = usePermissions();
  const qc = useQueryClient();
  const [adding, setAdding] = useState(false);
  const [value, setValue] = useState('');
  const editable = can(CAP.COMPUTERS_EDIT);
  const done = () => qc.invalidateQueries({ queryKey: ['endpoint', endpointId] });
  const add = useMutation({
    mutationFn: () => endpointsApi.addAlias(endpointId, value.trim()),
    onSuccess: () => { setValue(''); setAdding(false); done(); },
  });
  const remove = useMutation({ mutationFn: (aliasId: string) => endpointsApi.removeAlias(endpointId, aliasId), onSuccess: done });

  return (
    <div className="flex flex-col items-end gap-1" data-testid="device-aliases">
      <div className="flex flex-wrap justify-end gap-1">
        {aliases.map((a) => (
          <Badge key={a.id} variant="outline" className="gap-1 font-mono text-xs">
            {a.alias}
            {editable && (
              <button type="button" aria-label={`Remove alias ${a.alias}`} className="rounded hover:text-destructive" disabled={remove.isPending}
                onClick={() => remove.mutate(a.id)}><X className="h-3 w-3" /></button>
            )}
          </Badge>
        ))}
        {!aliases.length && !adding && <span>—</span>}
        {editable && !adding && (
          <Button type="button" size="sm" variant="ghost" className="h-6 px-1.5 text-xs" onClick={() => { add.reset(); setAdding(true); }} data-testid="alias-add">
            <Plus className="mr-0.5 h-3 w-3" />Add
          </Button>
        )}
      </div>
      {adding && (
        <form className="flex gap-1" onSubmit={(e) => { e.preventDefault(); if (value.trim()) add.mutate(); }}>
          <Input value={value} maxLength={ALIAS_MAX} onChange={(e) => setValue(e.target.value)} placeholder="e.g. Front desk PC" aria-label="New alias"
            className="h-7 w-44 text-xs" autoFocus data-testid="alias-input" />
          <Button type="submit" size="sm" className="h-7 px-2 text-xs" disabled={!value.trim() || add.isPending}>Add</Button>
          <Button type="button" size="sm" variant="ghost" className="h-7 px-2 text-xs" onClick={() => setAdding(false)}>Cancel</Button>
        </form>
      )}
      {add.error && <p className="text-xs text-destructive">{apiError(add.error).message}</p>}
    </div>
  );
}

/** Notes on the Overview: the latest three and a quick add; all of them stay on History. */
export function OverviewNotes({ endpointId, onOpenHistory }: { endpointId: string; onOpenHistory: () => void }) {
  const { can } = usePermissions();
  const qc = useQueryClient();
  const [text, setText] = useState('');
  // Same key as the History tab's notes.
  const { data: notes } = useQuery({
    queryKey: ['notes', 'endpoint', endpointId],
    queryFn: () => notesApi.list({ endpointId }).then((r) => r.data?.data ?? []),
  });
  const create = useMutation({
    mutationFn: () => notesApi.create({ endpointId, content: text.trim() }),
    onSuccess: () => {
      setText('');
      qc.invalidateQueries({ queryKey: ['notes', 'endpoint', endpointId] });
      qc.invalidateQueries({ queryKey: ['endpoint-timeline', endpointId] });
    },
  });
  const list = (Array.isArray(notes) ? notes : []) as { id: string; content: string; createdAt: string; author?: { firstName?: string; lastName?: string } | null }[];

  return (
    <Card data-testid="overview-notes">
      <CardHeading title="Notes" icon={StickyNote}
        aside={<Button size="sm" variant="ghost" className="h-7 px-2 text-xs" onClick={onOpenHistory}>All notes on History</Button>} />
      <CardContent className="space-y-3 text-sm">
        {can(CAP.COMPUTERS_EDIT) && <form className="space-y-2" onSubmit={(e) => { e.preventDefault(); if (text.trim()) create.mutate(); }}>
          <Textarea value={text} onChange={(e) => setText(e.target.value)} rows={2} maxLength={8192} className="resize-none"
            placeholder="Add a note about this computer: a fault, a customer preference, a recent change…" aria-label="New note" data-testid="overview-note-input" />
          <div className="flex items-center justify-end gap-2">
            {create.error && <span className="text-xs text-destructive">{apiError(create.error).message}</span>}
            <Button type="submit" size="sm" disabled={!text.trim() || create.isPending} data-testid="overview-note-add">Add note</Button>
          </div>
        </form>}
        {list.length ? (
          <ul className="space-y-2">
            {list.slice(0, 3).map((n) => (
              <li key={n.id} className="rounded-md border p-2">
                <p className="whitespace-pre-wrap break-words">{n.content.length > 400 ? `${n.content.slice(0, 400)}…` : n.content}</p>
                <p className="mt-1 text-xs text-muted-foreground">
                  {[n.author?.firstName, n.author?.lastName].filter(Boolean).join(' ') || 'Someone'} · {ago(n.createdAt)}
                </p>
              </li>
            ))}
            {list.length > 3 && <li className="text-xs text-muted-foreground">and {list.length - 3} more on History</li>}
          </ul>
        ) : (
          <p className="text-muted-foreground">No notes yet.</p>
        )}
      </CardContent>
    </Card>
  );
}
