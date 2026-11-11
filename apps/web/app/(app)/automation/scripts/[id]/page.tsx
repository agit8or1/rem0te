'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, ArrowLeft, Check, GitCompare, Pencil, Send, Undo2, X } from 'lucide-react';
import { scriptsApi, type ScriptParameter, type ScriptRisk } from '@/lib/api-client';
import { useToast } from '@/hooks/use-toast';
import { formatDate } from '@/lib/utils';
import { PageHeader } from '@/components/common/page-header';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { NotRunnableNotice, RiskBadge, StatusBadge, VersionEditor, apiMessage, selectClass, shortHash } from '@/components/scripts/script-ui';

/**
 * One script: its versions, the selected version's content, parameters and
 * static-check warnings, a diff between any two versions, and the review
 * controls the API says this person may use. No Run button: see the notice.
 */

type Person = { id: string; name: string } | null;
interface ScriptData {
  id: string; name: string; scope: 'global' | 'business'; businessName: string | null; createdAt: string; createdBy: Person; view: 'full' | 'approved_only';
  versions: { version: number; basedOn: number | null; status: string; risk: string; description: string; contentSha256: string; author: Person; createdAt: string; decidedBy: Person; decidedAt: string | null }[];
  you: { canAuthor: boolean; canReview: boolean };
}
interface Finding { rule: string; severity: 'caution' | 'danger'; title: string; why: string; line: number; excerpt: string }
interface VersionData {
  version: number; status: string; basedOn: number | null; description: string; language: string; targetOs: string; risk: ScriptRisk; parameters: ScriptParameter[];
  content: string; contentBytes: number; contentSha256: string; definitionSha256: string; author: Person; createdAt: string; submittedAt: string | null;
  contributors?: Person[];
  decision: { by: Person; at: string; note: string; approvedSha256: string | null } | null;
  staticChecks: { checkerVersion: number; findings: Finding[]; truncated: boolean; disclaimer: string };
  you: { canSubmit: boolean; canWithdraw: boolean; canReview: boolean; cannotReviewBecause: string | null; canEdit: boolean };
}
interface DiffData { changed: string[]; added: number; removed: number; tooLarge: boolean; lines: { op: ' ' | '+' | '-'; text: string; a?: number; b?: number }[] }

export default function ScriptPage() {
  const { id } = useParams<{ id: string }>();
  const qc = useQueryClient();
  const { toast } = useToast();
  const { data: s, isLoading, error } = useQuery({ queryKey: ['script', id], queryFn: () => scriptsApi.get(id).then((r) => r.data.data as ScriptData), retry: false });
  const [selected, setSelected] = useState<number | null>(null);
  const [editing, setEditing] = useState(false);
  const [diff, setDiff] = useState<{ from: number; to: number } | null>(null);
  useEffect(() => { if (s && (selected === null || !s.versions.some((v) => v.version === selected))) setSelected(s.versions[0]?.version ?? null); }, [s, selected]);
  const n = selected;
  const { data: v } = useQuery({ queryKey: ['script', id, 'v', n], enabled: !!n, queryFn: () => scriptsApi.version(id, n!).then((r) => r.data.data as VersionData) });
  const refresh = () => qc.invalidateQueries({ queryKey: ['script', id] });

  const edit = useMutation({
    mutationFn: (body: Parameters<typeof scriptsApi.newVersion>[1]) => scriptsApi.newVersion(id, body),
    onSuccess: (r) => { toast({ title: `Version ${r.data.data.version} saved as a draft`, description: 'It needs its own review; earlier approvals do not carry over.' }); setEditing(false); setSelected(r.data.data.version); refresh(); },
    onError: (e) => toast({ title: 'Not saved', description: apiMessage(e, 'The new version was refused.'), variant: 'destructive' }),
  });

  if (isLoading) return <p className="text-sm text-muted-foreground">Loading…</p>;
  if (error || !s) return <div><BackLink /><p className="text-sm text-muted-foreground">{apiMessage(error, 'Script not found.')}</p></div>;

  return (
    <div>
      <BackLink />
      <PageHeader title={s.name} description={`${s.scope === 'global' ? 'Global script' : `Script for ${s.businessName ?? 'this business'}`} · added ${formatDate(s.createdAt)}${s.createdBy ? ` by ${s.createdBy.name}` : ''}`}>
        {v?.you.canEdit && !editing && <Button size="sm" variant="outline" onClick={() => setEditing(true)}><Pencil className="h-4 w-4 mr-1" />Edit as a new version</Button>}
      </PageHeader>
      <NotRunnableNotice />
      {s.view === 'approved_only' && <p className="mb-4 text-xs text-muted-foreground">This is a global script. You see its approved versions only, read-only.</p>}

      {editing && v && (
        <Card className="mb-4">
          <CardHeader className="pb-3"><CardTitle className="text-sm">New version, edited from version {v.version}</CardTitle></CardHeader>
          <CardContent>
            <VersionEditor initial={v} submitLabel="Save as a new draft" busy={edit.isPending} onCancel={() => setEditing(false)}
              onSubmit={(x) => edit.mutate({ ...x, basedOnVersion: v.version })} />
          </CardContent>
        </Card>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-[18rem_minmax(0,1fr)] gap-4">
        <Card className="self-start">
          <CardHeader className="pb-3"><CardTitle className="text-sm">Versions</CardTitle></CardHeader>
          <CardContent className="space-y-1 text-sm">
            {s.versions.map((x) => (
              <button key={x.version} type="button" onClick={() => { setSelected(x.version); setDiff(null); }} data-version={x.version}
                className={`w-full text-left rounded-md border p-2 ${x.version === n ? 'border-primary bg-muted/50' : 'hover:bg-muted/30'}`}>
                <div className="flex flex-wrap items-center gap-2"><strong>v{x.version}</strong><StatusBadge status={x.status} /></div>
                <p className="text-xs text-muted-foreground mt-0.5">{x.author?.name ?? 'unknown'} · {formatDate(x.createdAt)}{x.basedOn ? ` · from v${x.basedOn}` : ''}</p>
              </button>
            ))}
            {s.versions.length > 1 && <DiffPicker versions={s.versions.map((x) => x.version)} onPick={setDiff} />}
          </CardContent>
        </Card>

        <div className="space-y-4 min-w-0">
          {diff ? <DiffView id={id} from={diff.from} to={diff.to} onClose={() => setDiff(null)} />
            : v ? <VersionView id={id} v={v} onChanged={refresh} /> : <p className="text-sm text-muted-foreground">Loading the version…</p>}
        </div>
      </div>
    </div>
  );
}

function BackLink() {
  return <Link href="/automation/scripts" className="mb-3 inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"><ArrowLeft className="h-3.5 w-3.5" />Script library</Link>;
}

function DiffPicker({ versions, onPick }: { versions: number[]; onPick: (d: { from: number; to: number }) => void }) {
  const [from, setFrom] = useState(versions[1]);
  const [to, setTo] = useState(versions[0]);
  return (
    <div className="pt-3 space-y-2 border-t mt-3">
      <p className="text-xs font-medium flex items-center gap-1"><GitCompare className="h-3.5 w-3.5" />Compare</p>
      <div className="grid grid-cols-2 gap-2">
        <select aria-label="From version" className={selectClass} value={from} onChange={(e) => setFrom(Number(e.target.value))}>{versions.map((x) => <option key={x} value={x}>v{x}</option>)}</select>
        <select aria-label="To version" className={selectClass} value={to} onChange={(e) => setTo(Number(e.target.value))}>{versions.map((x) => <option key={x} value={x}>v{x}</option>)}</select>
      </div>
      <Button size="sm" variant="outline" className="w-full" disabled={from === to} onClick={() => onPick({ from, to })}>Show the differences</Button>
    </div>
  );
}

function DiffView({ id, from, to, onClose }: { id: string; from: number; to: number; onClose: () => void }) {
  const { data: d, error } = useQuery({ queryKey: ['script', id, 'diff', from, to], queryFn: () => scriptsApi.diff(id, from, to).then((r) => r.data.data as DiffData) });
  return (
    <Card>
      <CardHeader className="pb-3 flex flex-row items-center justify-between gap-2 space-y-0">
        <CardTitle className="text-sm">v{from} → v{to}</CardTitle>
        <Button size="sm" variant="ghost" onClick={onClose}>Close</Button>
      </CardHeader>
      <CardContent className="space-y-2 text-sm">
        {error ? <p className="text-muted-foreground">{apiMessage(error, 'The diff could not be loaded.')}</p> : !d ? <p className="text-muted-foreground">Loading…</p> : (
          <>
            <p className="text-xs text-muted-foreground">{d.added} line{d.added === 1 ? '' : 's'} added, {d.removed} removed{d.changed.length ? ` · also changed: ${d.changed.join(', ')}` : ''}</p>
            {d.tooLarge ? <p className="text-xs">The versions differ too much to show line by line. Read each version in full.</p> : (
              <pre className="overflow-x-auto rounded-md border bg-muted/30 p-2 text-xs leading-5" data-diff>
                {d.lines.map((l, i) => (
                  <div key={i} className={l.op === '+' ? 'bg-green-100 text-green-900 dark:bg-green-950 dark:text-green-100' : l.op === '-' ? 'bg-red-100 text-red-900 dark:bg-red-950 dark:text-red-100' : ''}>
                    <span className="select-none text-muted-foreground inline-block w-6">{l.op}</span>{l.text || ' '}
                  </div>
                ))}
              </pre>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}

function describeParam(p: ScriptParameter) {
  if (p.type === 'string') return `string, ${p.charset.replace('_', ' ')}, up to ${p.maxLength}`;
  if (p.type === 'integer') return `integer, ${p.min} to ${p.max}`;
  if (p.type === 'choice') return `one of ${p.choices.join(', ')}`;
  return 'boolean';
}

function VersionView({ id, v, onChanged }: { id: string; v: VersionData; onChanged: () => void }) {
  const { toast } = useToast();
  const [note, setNote] = useState('');
  const [ack, setAck] = useState(false);
  useEffect(() => { setNote(''); setAck(false); }, [v.version]);
  const fail = (title: string) => (e: unknown) => toast({ title, description: apiMessage(e, 'Refused.'), variant: 'destructive' });
  const submit = useMutation({ mutationFn: () => scriptsApi.submit(id, v.version), onSuccess: () => { toast({ title: 'Submitted for review' }); onChanged(); }, onError: fail('Not submitted') });
  const withdraw = useMutation({ mutationFn: () => scriptsApi.withdraw(id, v.version), onSuccess: () => { toast({ title: 'Withdrawn to draft' }); onChanged(); }, onError: fail('Not withdrawn') });
  const review = useMutation({
    mutationFn: (decision: 'approve' | 'reject') => scriptsApi.review(id, v.version, { decision, expectedSha256: v.contentSha256, note: note.trim() }),
    onSuccess: (r) => { toast({ title: r.data.data.status === 'APPROVED' ? 'Approved' : 'Rejected', description: r.data.data.status === 'APPROVED' ? 'Recorded against this exact content hash. Nothing has been run.' : undefined }); onChanged(); },
    onError: fail('Not recorded'),
  });
  const danger = v.staticChecks.findings.filter((f) => f.severity === 'danger').length;
  const lines = v.content.split(/\r?\n/);
  const flagged = new Set(v.staticChecks.findings.map((f) => f.line));

  return (
    <>
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm flex flex-wrap items-center gap-2">Version {v.version}<StatusBadge status={v.status} /><RiskBadge risk={v.risk} /></CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          <p className="whitespace-pre-wrap">{v.description}</p>
          <dl className="grid grid-cols-1 sm:grid-cols-[10rem_minmax(0,1fr)] gap-x-3 gap-y-1 text-xs">
            <dt className="text-muted-foreground">Written by</dt><dd>{v.author?.name ?? 'unknown'}, {formatDate(v.createdAt)}{v.basedOn ? ` (edited from v${v.basedOn})` : ''}</dd>
            {v.contributors && v.contributors.length > 1 && (<><dt className="text-muted-foreground">Contributors</dt><dd>{v.contributors.map((c) => c?.name).join(', ')} (none of them can approve it)</dd></>)}
            <dt className="text-muted-foreground">Language · runs on</dt><dd>PowerShell · Windows</dd>
            <dt className="text-muted-foreground">Content SHA-256</dt><dd className="font-mono break-all" data-content-sha256>{v.contentSha256}</dd>
            <dt className="text-muted-foreground">Definition SHA-256</dt><dd className="font-mono break-all">{v.definitionSha256}</dd>
            <dt className="text-muted-foreground">Size</dt><dd>{v.contentBytes.toLocaleString()} bytes</dd>
            {v.submittedAt && (<><dt className="text-muted-foreground">Submitted</dt><dd>{formatDate(v.submittedAt)}</dd></>)}
            {v.decision && (<><dt className="text-muted-foreground">{v.status === 'APPROVED' ? 'Approved' : 'Rejected'}</dt>
              <dd>by {v.decision.by?.name ?? 'unknown'}, {formatDate(v.decision.at)}: &ldquo;{v.decision.note}&rdquo;{v.decision.approvedSha256 ? ` · over ${shortHash(v.decision.approvedSha256)}` : ''}</dd></>)}
          </dl>
          <div>
            <p className="text-xs font-medium mb-1">Parameters</p>
            {v.parameters.length === 0 ? <p className="text-xs text-muted-foreground">None.</p> : (
              <ul className="text-xs space-y-0.5">{v.parameters.map((p) => <li key={p.name}><code>-{p.name}</code> {describeParam(p)}{p.required ? ', required' : ''}{p.description ? ` · ${p.description}` : ''}</li>)}</ul>
            )}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3"><CardTitle className="text-sm flex items-center gap-2"><AlertTriangle className="h-4 w-4 text-yellow-600" />Static checks{v.staticChecks.findings.length ? ` · ${v.staticChecks.findings.length} warning${v.staticChecks.findings.length === 1 ? '' : 's'}${danger ? `, ${danger} serious` : ''}` : ''}</CardTitle></CardHeader>
        <CardContent className="space-y-2 text-sm" data-static-checks>
          <p className="text-xs text-muted-foreground">Warnings, not a verdict. These are pattern matches: they point at lines worth reading. A script with no warnings isn&apos;t thereby safe, and nothing here is blocked by a warning. Read the script.</p>
          {v.staticChecks.findings.length === 0 ? <p className="text-xs">No patterns matched.</p> : (
            <ul className="space-y-1.5">{v.staticChecks.findings.map((f, i) => (
              <li key={i} className="rounded-md border p-2 text-xs">
                <div className="flex flex-wrap items-center gap-2"><Badge variant={f.severity === 'danger' ? 'destructive' : 'warning'}>{f.severity}</Badge><strong>{f.title}</strong>{f.line > 0 && <span className="text-muted-foreground">line {f.line}</span>}</div>
                <p className="mt-1 text-muted-foreground">{f.why}</p>
                {f.excerpt && <code className="mt-1 block break-all">{f.excerpt}</code>}
              </li>
            ))}</ul>
          )}
          {v.staticChecks.truncated && <p className="text-xs">More warnings than shown.</p>}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3"><CardTitle className="text-sm">Script</CardTitle></CardHeader>
        <CardContent>
          <pre className="overflow-x-auto rounded-md border bg-muted/30 p-2 text-xs leading-5" data-script-content>
            {lines.map((l, i) => (
              <div key={i} className={flagged.has(i + 1) ? 'bg-yellow-100 dark:bg-yellow-950' : ''}>
                <span className="select-none text-muted-foreground inline-block w-10 text-right pr-3">{i + 1}</span>{l || ' '}
              </div>
            ))}
          </pre>
        </CardContent>
      </Card>

      {(v.you.canSubmit || v.you.canWithdraw || v.you.canReview || (v.status === 'IN_REVIEW' && v.you.cannotReviewBecause)) && (
        <Card>
          <CardHeader className="pb-3"><CardTitle className="text-sm">Review</CardTitle></CardHeader>
          <CardContent className="space-y-3 text-sm">
            {v.you.canSubmit && (
              <div className="flex flex-wrap items-center gap-2">
                <Button size="sm" disabled={submit.isPending} onClick={() => submit.mutate()}><Send className="h-4 w-4 mr-1" />Submit for review</Button>
                <span className="text-xs text-muted-foreground">Someone with the review permission, other than you, decides it.</span>
              </div>
            )}
            {v.you.canWithdraw && (
              <Button size="sm" variant="outline" disabled={withdraw.isPending} onClick={() => withdraw.mutate()}><Undo2 className="h-4 w-4 mr-1" />Withdraw to draft</Button>
            )}
            {v.status === 'IN_REVIEW' && !v.you.canReview && v.you.cannotReviewBecause && !v.you.canWithdraw && <p className="text-xs text-muted-foreground">{v.you.cannotReviewBecause}</p>}
            {v.status === 'IN_REVIEW' && !v.you.canReview && v.you.canWithdraw && <p className="text-xs text-muted-foreground">You wrote this version, so someone else must review it.</p>}
            {v.you.canReview && (
              <div className="space-y-2" data-review>
                <p className="text-xs">You are reviewing content <code className="font-mono">{shortHash(v.contentSha256)}</code>. An approval records that exact hash; any later edit is a new version that needs its own review. Approving asks you to confirm it is you, and runs nothing.</p>
                <div className="space-y-1">
                  <Label htmlFor="rv-note" className="text-xs">Note (what you checked, or why not)</Label>
                  <Textarea id="rv-note" rows={2} maxLength={1000} value={note} onChange={(e) => setNote(e.target.value)} />
                </div>
                {danger > 0 && (
                  <label className="flex items-start gap-2 text-xs"><input type="checkbox" className="mt-0.5" checked={ack} onChange={(e) => setAck(e.target.checked)} />
                    I have read the {danger} serious warning{danger === 1 ? '' : 's'} above and the lines they point at.</label>
                )}
                <div className="flex flex-wrap gap-2">
                  <Button size="sm" disabled={note.trim().length < 3 || (danger > 0 && !ack) || review.isPending} onClick={() => review.mutate('approve')}><Check className="h-4 w-4 mr-1" />Approve</Button>
                  <Button size="sm" variant="destructive" disabled={note.trim().length < 3 || review.isPending} onClick={() => review.mutate('reject')}><X className="h-4 w-4 mr-1" />Reject</Button>
                </div>
              </div>
            )}
          </CardContent>
        </Card>
      )}
    </>
  );
}
