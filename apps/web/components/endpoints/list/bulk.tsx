'use client';

import * as React from 'react';
import { Download, FolderMinus, FolderPlus, Loader2, Pencil, RefreshCw, ShieldCheck, Trash2, UploadCloud, Wrench, X } from 'lucide-react';
import { Label } from '@/components/ui/label';
import { useToast } from '@/hooks/use-toast';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { BULK_MAX, bulkApi, deviceGroupsApi, refusalMessage } from './api';
import type { BulkAction, BulkResponse, DeviceGroup, SortKey } from './types';

const ACTION_LABEL: Record<BulkAction, string> = {
  'group.add': 'Add to group',
  'group.remove': 'Remove from group',
  'inventory.refresh': 'Refresh inventory',
  'client.update': 'Queue RustDesk client update',
  'agent.update': 'Update agent',
  'agent.migrate': 'Upgrade to signed agent',
};

/**
 * The bar shown while rows are selected (0.33). Every button is a request the
 * server re-checks per computer; the result dialog lists what it refused and
 * why. There is deliberately no bulk connect, archive, delete or approved
 * action.
 */
export function BulkBar({
  selected, groups, isPlatformAdmin, canEdit = false, sort, dir, onClear, onDone,
}: {
  selected: Map<string, string>;
  groups: DeviceGroup[];
  isPlatformAdmin: boolean;
  /** computers:edit: the agent actions (0.34). The server re-checks per computer. */
  canEdit?: boolean;
  sort: SortKey;
  dir: 'asc' | 'desc';
  onClear: () => void;
  onDone: (r: BulkResponse) => void;
}) {
  const { toast } = useToast();
  const [busy, setBusy] = React.useState<string | null>(null);
  const [groupId, setGroupId] = React.useState('');
  const [migrateOpen, setMigrateOpen] = React.useState(false);
  const [reason, setReason] = React.useState('');
  const ids = [...selected.keys()];
  const manageable = groups.filter((g) => g.may.manage);

  async function run(action: BulkAction) {
    setBusy(action);
    try {
      onDone(await bulkApi.run(action, ids, action.startsWith('group.') ? groupId : undefined, action === 'agent.migrate' ? reason.trim() : undefined));
      if (action === 'agent.migrate') { setMigrateOpen(false); setReason(''); }
    } catch (e) {
      toast({ title: `${ACTION_LABEL[action]} refused`, description: await refusalMessage(e, 'The request failed.'), variant: 'destructive' });
    } finally {
      setBusy(null);
    }
  }

  async function exportSelection() {
    setBusy('export');
    try {
      const { blob, filename, rows, notExported } = await bulkApi.exportCsv(ids, sort, dir);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = filename; document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
      toast({
        title: `Exported ${rows} device${rows === 1 ? '' : 's'}`,
        description: `${notExported ? `${notExported} selected device${notExported === 1 ? ' is' : 's are'} no longer visible to you and ${notExported === 1 ? 'was' : 'were'} left out. ` : ''}The export is recorded in the audit log.`,
      });
    } catch (e) {
      toast({ title: 'Export refused', description: await refusalMessage(e, 'The export failed.'), variant: 'destructive' });
    } finally {
      setBusy(null);
    }
  }

  const spin = (k: string) => (busy === k ? <Loader2 className="h-4 w-4 mr-1.5 animate-spin" /> : null);
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-md border border-primary/40 bg-primary/5 px-3 py-2 text-sm" role="region" aria-label="Bulk actions">
      <span className="font-medium">{selected.size} selected</span>
      {selected.size >= BULK_MAX && <span className="text-xs text-muted-foreground">(the most one request can act on)</span>}
      <span className="mx-1 h-5 w-px bg-border" aria-hidden />
      {manageable.length > 0 && (
        <>
          <Select value={groupId || '__none__'} onValueChange={(v) => setGroupId(v === '__none__' ? '' : v)}>
            <SelectTrigger className="h-8 w-[180px]" aria-label="Group for the bulk action"><SelectValue placeholder="Pick a group" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="__none__">Pick a group…</SelectItem>
              {manageable.map((g) => <SelectItem key={g.id} value={g.id}>{g.name}{g.business?.name ? ` · ${g.business.name}` : ''}</SelectItem>)}
            </SelectContent>
          </Select>
          <Button size="sm" variant="outline" className="h-8" disabled={!groupId || !!busy} onClick={() => run('group.add')}>
            {spin('group.add') ?? <FolderPlus className="h-4 w-4 mr-1.5" />}Add
          </Button>
          <Button size="sm" variant="outline" className="h-8" disabled={!groupId || !!busy} onClick={() => run('group.remove')}>
            {spin('group.remove') ?? <FolderMinus className="h-4 w-4 mr-1.5" />}Remove
          </Button>
          <span className="mx-1 h-5 w-px bg-border" aria-hidden />
        </>
      )}
      <Button size="sm" variant="outline" className="h-8" disabled={!!busy} onClick={() => run('inventory.refresh')}
        title="Asks each computer to re-collect its inventory and re-check Windows Update on its next heartbeat (up to three minutes). Counts toward your limit on distinct computers.">
        {spin('inventory.refresh') ?? <RefreshCw className="h-4 w-4 mr-1.5" />}Refresh inventory
      </Button>
      {isPlatformAdmin && (
        <Button size="sm" variant="outline" className="h-8" disabled={!!busy} onClick={() => run('client.update')}
          title="Queues a RustDesk client update for each computer that is behind, on its next heartbeat. Archived, Linux and contained computers are refused.">
          {spin('client.update') ?? <UploadCloud className="h-4 w-4 mr-1.5" />}Queue client update
        </Button>
      )}
      {canEdit && (
        <>
          <Button size="sm" variant="outline" className="h-8" disabled={!!busy} onClick={() => run('agent.update')}
            title="Re-runs the current standard installer on each standard Windows computer (signed agents: checks the signed repository now). Keeps the enrolment and RustDesk settings. Linux and macOS are refused: re-run their installer on the computer.">
            {spin('agent.update') ?? <Wrench className="h-4 w-4 mr-1.5" />}Update agent
          </Button>
          <Button size="sm" variant="outline" className="h-8" disabled={!!busy} onClick={() => setMigrateOpen(true)}
            title="Moves each standard Windows computer to the signed agent. Needs a fresh sign-in and a reason; each computer is checked on its own.">
            <ShieldCheck className="h-4 w-4 mr-1.5" />Upgrade to signed…
          </Button>
        </>
      )}
      <Dialog open={migrateOpen} onOpenChange={(o) => { if (!o && busy !== 'agent.migrate') setMigrateOpen(false); }}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Upgrade {selected.size} device{selected.size === 1 ? '' : 's'} to the signed agent?</DialogTitle>
            <DialogDescription>
              Each standard Windows computer is handed, once, the portal’s migration script. It downloads the signed agent,
              checks it against the digest the signed repository publishes, and runs <code>migrate</code>, which keeps the
              enrolment, device secret and RustDesk configuration. After that the computer runs only signed code. Computers
              that cannot be moved are refused one by one with the reason. You will be asked to confirm it is you.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-1.5">
            <Label htmlFor="bulk-migrate-reason" className="text-xs">Reason (recorded in the audit log)</Label>
            <Input id="bulk-migrate-reason" maxLength={400} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. moving the Acme fleet to signed updates" />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setMigrateOpen(false)} disabled={busy === 'agent.migrate'}>Cancel</Button>
            <Button onClick={() => run('agent.migrate')} disabled={reason.trim().length < 3 || !!busy}>
              {spin('agent.migrate')}Request upgrade
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Button size="sm" variant="outline" className="h-8" disabled={!!busy} onClick={exportSelection} title="Download the selected devices as CSV. Recorded in the audit log.">
        {spin('export') ?? <Download className="h-4 w-4 mr-1.5" />}Export selection
      </Button>
      <Button size="sm" variant="ghost" className="h-8 sm:ml-auto" onClick={onClear}><X className="h-4 w-4 mr-1" />Clear selection</Button>
    </div>
  );
}

/** What the server did with each selected computer, refusals first. */
export function BulkResultDialog({ result, onClose }: { result: BulkResponse | null; onClose: () => void }) {
  const refused = result?.results.filter((r) => !r.ok) ?? [];
  const unchanged = result?.results.filter((r) => r.ok && r.unchanged) ?? [];
  return (
    <Dialog open={!!result} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>{result ? ACTION_LABEL[result.action] : ''}{result?.group ? ` · ${result.group.name}` : ''}</DialogTitle>
          <DialogDescription>
            {result ? `${result.succeeded} of ${result.requested} done${unchanged.length ? ` (${unchanged.length} needed nothing)` : ''}; ${result.refused} refused.` : ''}
            {result?.action === 'inventory.refresh' && result.succeeded ? ' Each one collects on its next heartbeat, up to three minutes away.' : ''}
            {result?.action === 'client.update' && result.succeeded ? ' Each queued update goes on that computer’s next heartbeat.' : ''}
            {result?.action === 'agent.update' && result.succeeded ? ' Each one runs on that computer’s next heartbeat.' : ''}
            {result?.action === 'agent.migrate' && result.succeeded ? ' Follow them on Devices → Agent migrations.' : ''}
          </DialogDescription>
        </DialogHeader>
        {refused.length > 0 ? (
          <div className="max-h-[50vh] overflow-y-auto rounded-md border">
            <table className="w-full text-sm">
              <thead><tr className="border-b bg-muted/50"><th className="text-left px-3 py-2 font-medium">Device</th><th className="text-left px-3 py-2 font-medium">Why not</th></tr></thead>
              <tbody className="divide-y">
                {refused.map((r) => (
                  <tr key={r.endpointId}>
                    <td className="px-3 py-2 align-top whitespace-nowrap">{r.name ?? <span className="text-muted-foreground">Not visible to you</span>}</td>
                    <td className="px-3 py-2 align-top text-muted-foreground">{r.reason ?? r.code}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : <p className="text-sm text-muted-foreground">Nothing was refused.</p>}
        <DialogFooter><Button onClick={onClose}>Close</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Create, rename and delete a business's device groups. The server decides who may (owner, whole-business technician, MSP). */
export function GroupsDialog({
  open, onOpenChange, groups, businessId, businessLabel, canCreate, onChanged,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  groups: DeviceGroup[];
  /** The business new groups go into; undefined = the caller's own (the server pins it). */
  businessId?: string;
  businessLabel: string | null;
  canCreate: boolean;
  onChanged: () => void;
}) {
  const { toast } = useToast();
  const [name, setName] = React.useState('');
  const [editing, setEditing] = React.useState<{ id: string; name: string } | null>(null);
  const [busy, setBusy] = React.useState(false);

  async function act(fn: () => Promise<unknown>, done: string) {
    setBusy(true);
    try { await fn(); toast({ title: done }); onChanged(); } catch (e) {
      toast({ title: 'Refused', description: await refusalMessage(e, 'The change failed.'), variant: 'destructive' });
    } finally { setBusy(false); }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>Device groups</DialogTitle>
          <DialogDescription>
            Static groups of one business’s computers, for filtering the list and acting on them together. A computer is in
            one group at a time. Groups grant no access to anything. Changes are recorded in the audit log.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-2 max-h-[45vh] overflow-y-auto">
          {groups.length === 0 && <p className="text-sm text-muted-foreground">No groups yet.</p>}
          {groups.map((g) => (
            <div key={g.id} className="flex items-center gap-2 rounded-md border px-3 py-2 text-sm">
              {editing?.id === g.id ? (
                <Input className="h-8" autoFocus maxLength={60} value={editing.name} onChange={(e) => setEditing({ id: g.id, name: e.target.value })}
                  onKeyDown={(e) => { if (e.key === 'Enter' && editing.name.trim()) act(() => deviceGroupsApi.update(g.id, { name: editing.name.trim() }), 'Group renamed').then(() => setEditing(null)); }} />
              ) : (
                <div className="min-w-0 flex-1">
                  <p className="font-medium truncate">{g.name}</p>
                  <p className="text-xs text-muted-foreground">
                    {g.members} visible member{g.members === 1 ? '' : 's'}{g.business?.name ? ` · ${g.business.name}` : ''}{g.legacy ? ' · made before 0.33, not editable here' : ''}
                  </p>
                </div>
              )}
              {g.may.manage && (editing?.id === g.id ? (
                <Button size="sm" variant="ghost" onClick={() => setEditing(null)}>Cancel</Button>
              ) : (
                <>
                  <Button size="sm" variant="ghost" aria-label={`Rename ${g.name}`} disabled={busy} onClick={() => setEditing({ id: g.id, name: g.name })}><Pencil className="h-3.5 w-3.5" /></Button>
                  <Button size="sm" variant="ghost" aria-label={`Delete ${g.name}`} disabled={busy}
                    onClick={() => { if (window.confirm(`Delete the group “${g.name}”? Its computers stay where they are; they just leave the group.`)) act(() => deviceGroupsApi.remove(g.id), 'Group deleted'); }}>
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </>
              ))}
            </div>
          ))}
        </div>
        {canCreate ? (
          <div className="flex gap-2">
            <Input placeholder={`New group${businessLabel ? ` in ${businessLabel}` : ''}, e.g. Front desk`} maxLength={60} value={name} onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && name.trim()) act(() => deviceGroupsApi.create({ name: name.trim(), businessId }), 'Group created').then(() => setName('')); }} />
            <Button disabled={!name.trim() || busy} onClick={() => act(() => deviceGroupsApi.create({ name: name.trim(), businessId }), 'Group created').then(() => setName(''))}>Create</Button>
          </div>
        ) : (
          <p className="text-xs text-muted-foreground">
            {businessId === undefined && businessLabel === null
              ? 'Pick a business filter first: a group belongs to one business.'
              : 'Groups are managed by a Business Owner, a technician with computers:edit over the whole business, or the MSP.'}
          </p>
        )}
        <DialogFooter><Button variant="outline" onClick={() => onOpenChange(false)}>Close</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
