'use client';

import { useState } from 'react';
import { Info, Plus, Trash2 } from 'lucide-react';
import type { ScriptParameter, ScriptRisk, ScriptVersionInput } from '@/lib/api-client';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';

/**
 * Shared pieces of the script library pages. There is deliberately no run
 * control in here or anywhere else: the portal cannot run a script
 * (docs/script-library.md), so offering one would be a fake button.
 */

export const selectClass = 'flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm';
export const MAX_CONTENT_BYTES = 65_536;

export function apiMessage(e: unknown, fallback: string) {
  const d = (e as { response?: { data?: { message?: string | string[] | { message?: string } } } })?.response?.data;
  const m = d?.message;
  if (typeof m === 'string') return m;
  if (Array.isArray(m)) return m.join('; ');
  return m?.message ?? fallback;
}

/** Said plainly on every library page: what is missing and why. */
export function NotRunnableNotice() {
  return (
    <div role="note" className="mb-4 flex gap-3 rounded-md border border-blue-300 bg-blue-50 p-3 text-sm text-blue-900 dark:border-blue-800 dark:bg-blue-950 dark:text-blue-100" data-not-runnable>
      <Info className="h-4 w-4 shrink-0 mt-0.5" />
      <div>
        <p className="font-medium">Running scripts isn&apos;t available yet.</p>
        <p className="mt-0.5">
          You can write, version and review scripts here, but you can&apos;t run them. A script will only ever run on the signed
          agent, as an approved action signed by people on the approval roster, and the agent will check the script&apos;s exact
          SHA-256 before it runs. That path hasn&apos;t been validated on real Windows yet, so nothing here sends a script to a computer.
        </p>
      </div>
    </div>
  );
}

const STATUS: Record<string, { label: string; variant: 'success' | 'warning' | 'outline' | 'secondary' | 'destructive' }> = {
  DRAFT: { label: 'Draft', variant: 'outline' },
  IN_REVIEW: { label: 'In review', variant: 'warning' },
  APPROVED: { label: 'Approved', variant: 'success' },
  REJECTED: { label: 'Rejected', variant: 'destructive' },
};
export function StatusBadge({ status }: { status: string }) {
  const s = STATUS[status] ?? { label: status, variant: 'outline' as const };
  return <Badge variant={s.variant}>{s.label}</Badge>;
}

export function RiskBadge({ risk }: { risk: string }) {
  return <Badge variant={risk === 'high' ? 'destructive' : risk === 'medium' ? 'warning' : 'secondary'}>{risk} risk</Badge>;
}

export const shortHash = (h: string) => `${h.slice(0, 12)}…${h.slice(-6)}`;

const CHARSETS: { id: string; label: string }[] = [
  { id: 'identifier', label: 'identifier: letters, digits, _ . -' },
  { id: 'alphanumeric', label: 'alphanumeric: letters and digits' },
  { id: 'hostname', label: 'hostname: letters, digits, . -' },
  { id: 'safe_text', label: 'safe text: letters, digits, space, _ . , : @ -' },
];

function blank(type: ScriptParameter['type'], name: string, required: boolean, description?: string): ScriptParameter {
  const base = { name, required, ...(description ? { description } : {}) };
  if (type === 'string') return { ...base, type, charset: 'identifier', maxLength: 64 };
  if (type === 'integer') return { ...base, type, min: 0, max: 100 };
  if (type === 'choice') return { ...base, type, choices: ['option1'] };
  return { ...base, type: 'boolean' };
}

function ParametersEditor({ value, onChange }: { value: ScriptParameter[]; onChange: (p: ScriptParameter[]) => void }) {
  const set = (i: number, p: ScriptParameter) => onChange(value.map((x, j) => (j === i ? p : x)));
  return (
    <div className="space-y-2">
      {value.length === 0 && <p className="text-xs text-muted-foreground">No parameters. A parameter is bound by name when the script runs, never pasted into its text.</p>}
      {value.map((p, i) => (
        <div key={i} className="rounded-md border p-2 grid grid-cols-1 sm:grid-cols-6 gap-2 items-end text-xs">
          <div className="space-y-1 sm:col-span-1"><Label className="text-xs">Name</Label>
            <Input className="h-8 text-xs" value={p.name} maxLength={32} onChange={(e) => set(i, { ...p, name: e.target.value })} /></div>
          <div className="space-y-1 sm:col-span-1"><Label className="text-xs">Type</Label>
            <select className="h-8 w-full rounded-md border border-input bg-background px-2 text-xs" value={p.type}
              onChange={(e) => set(i, blank(e.target.value as ScriptParameter['type'], p.name, p.required, p.description))}>
              <option value="string">string</option><option value="integer">integer</option><option value="boolean">boolean</option><option value="choice">choice</option>
            </select></div>
          <div className="space-y-1 sm:col-span-3">
            {p.type === 'string' && (
              <div className="grid grid-cols-3 gap-2">
                <div className="col-span-2 space-y-1"><Label className="text-xs">Allowed characters</Label>
                  <select className="h-8 w-full rounded-md border border-input bg-background px-2 text-xs" value={p.charset} onChange={(e) => set(i, { ...p, charset: e.target.value as typeof p.charset })}>
                    {CHARSETS.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
                  </select></div>
                <div className="space-y-1"><Label className="text-xs">Max length</Label>
                  <Input className="h-8 text-xs" type="number" min={1} max={256} value={p.maxLength} onChange={(e) => set(i, { ...p, maxLength: Number(e.target.value) })} /></div>
              </div>
            )}
            {p.type === 'integer' && (
              <div className="grid grid-cols-2 gap-2">
                <div className="space-y-1"><Label className="text-xs">Min</Label><Input className="h-8 text-xs" type="number" value={p.min} onChange={(e) => set(i, { ...p, min: Number(e.target.value) })} /></div>
                <div className="space-y-1"><Label className="text-xs">Max</Label><Input className="h-8 text-xs" type="number" value={p.max} onChange={(e) => set(i, { ...p, max: Number(e.target.value) })} /></div>
              </div>
            )}
            {p.type === 'choice' && (
              <div className="space-y-1"><Label className="text-xs">Choices (comma-separated identifiers)</Label>
                <Input className="h-8 text-xs" value={p.choices.join(',')} onChange={(e) => set(i, { ...p, choices: e.target.value.split(',').map((s) => s.trim()).filter(Boolean) })} /></div>
            )}
            {p.type === 'boolean' && <p className="text-muted-foreground pb-2">true or false</p>}
          </div>
          <div className="flex items-center gap-2 sm:col-span-1 pb-1">
            <label className="flex items-center gap-1"><input type="checkbox" checked={p.required} onChange={(e) => set(i, { ...p, required: e.target.checked })} />required</label>
            <Button type="button" size="sm" variant="ghost" aria-label={`Remove parameter ${p.name}`} onClick={() => onChange(value.filter((_, j) => j !== i))}><Trash2 className="h-3.5 w-3.5" /></Button>
          </div>
        </div>
      ))}
      {value.length < 10 && (
        <Button type="button" size="sm" variant="outline" onClick={() => onChange([...value, blank('string', `Param${value.length + 1}`, false)])}>
          <Plus className="h-3.5 w-3.5 mr-1" />Add parameter
        </Button>
      )}
    </div>
  );
}

const utf8Bytes = (s: string) => new TextEncoder().encode(s).length;

/**
 * The fields of one version. Used to create a script and to edit one; an
 * edit is always a new version, so nothing here changes an existing one.
 */
export function VersionEditor({ initial, submitLabel, busy, onSubmit, onCancel, children }: {
  initial?: Partial<ScriptVersionInput>;
  submitLabel: string;
  busy: boolean;
  onSubmit: (v: ScriptVersionInput) => void;
  onCancel: () => void;
  children?: React.ReactNode;
}) {
  const [description, setDescription] = useState(initial?.description ?? '');
  const [risk, setRisk] = useState<ScriptRisk>(initial?.risk ?? 'medium');
  const [parameters, setParameters] = useState<ScriptParameter[]>(initial?.parameters ?? []);
  const [content, setContent] = useState(initial?.content ?? '');
  const bytes = utf8Bytes(content);
  const ok = description.trim().length >= 3 && content.trim().length > 0 && bytes <= MAX_CONTENT_BYTES;
  return (
    <div className="space-y-4 text-sm">
      {children}
      <div className="space-y-1">
        <Label htmlFor="sv-desc" className="text-xs">What it does, and anything a reviewer should know</Label>
        <Textarea id="sv-desc" rows={3} maxLength={2000} value={description} onChange={(e) => setDescription(e.target.value)} />
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 max-w-2xl">
        <div className="space-y-1"><Label className="text-xs">Language</Label><Input value="PowerShell" disabled /></div>
        <div className="space-y-1"><Label className="text-xs">Runs on</Label><Input value="Windows" disabled /></div>
        <div className="space-y-1"><Label htmlFor="sv-risk" className="text-xs">Risk</Label>
          <select id="sv-risk" className={selectClass} value={risk} onChange={(e) => setRisk(e.target.value as ScriptRisk)}>
            <option value="low">Low: reads, or changes nothing that matters</option>
            <option value="medium">Medium: changes settings or services</option>
            <option value="high">High: could disrupt the computer or its user</option>
          </select></div>
      </div>
      <div className="space-y-1">
        <p className="text-xs font-medium">Parameters</p>
        <ParametersEditor value={parameters} onChange={setParameters} />
      </div>
      <div className="space-y-1">
        <Label htmlFor="sv-content" className="text-xs">Script</Label>
        <Textarea id="sv-content" rows={16} spellCheck={false} className="font-mono text-xs" value={content} onChange={(e) => setContent(e.target.value)} />
        <p className={`text-xs ${bytes > MAX_CONTENT_BYTES ? 'text-destructive' : 'text-muted-foreground'}`}>
          {bytes.toLocaleString()} of {MAX_CONTENT_BYTES.toLocaleString()} bytes. Hashed exactly as written, line endings included.
        </p>
      </div>
      <div className="flex gap-2">
        <Button size="sm" disabled={!ok || busy} onClick={() => onSubmit({ description: description.trim(), risk, parameters, content })}>{submitLabel}</Button>
        <Button size="sm" variant="ghost" onClick={onCancel}>Cancel</Button>
      </div>
    </div>
  );
}
