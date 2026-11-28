'use client';

/**
 * Shared presentation for the device's background tools (0.93, UX P1-7;
 * directive §13): who and what an operation targets, its reference and audit
 * link, errors in plain words, and a search over output already on screen.
 * Display only. Nothing here starts, extends or widens an operation.
 */

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { Copy, FileSearch, Search } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { useToast } from '@/hooks/use-toast';
import { auditHref, findLines, shortRef, toolError } from '@/lib/tool-ops';

/** The device, its customer and hostname, repeated inside the tool, and who the tool runs as. */
export function ToolTarget({ ep, runsAs }: { ep: Record<string, unknown>; runsAs?: string }) {
  const customer = (ep.customer as { name?: string } | null)?.name ?? null;
  const name = typeof ep.name === 'string' ? ep.name : '—';
  const host = typeof ep.hostname === 'string' && ep.hostname && ep.hostname !== name ? ep.hostname : null;
  return (
    <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground" data-testid="tool-target">
      <span>Device <strong className="text-foreground">{name}</strong></span>
      <span>Customer <strong className="text-foreground">{customer ?? 'none'}</strong></span>
      {host && <span>Hostname <span className="font-mono text-foreground">{host}</span></span>}
      {runsAs && <span>Runs as <strong className="text-foreground">{runsAs}</strong></span>}
    </p>
  );
}

/**
 * An operation's reference: its id (shortened, copyable in full) and a link
 * to its own rows in the audit log. The audit page applies the filter inside
 * the reader's scope; someone without Audit view gets that page's own answer.
 */
export function OperationRef({ id, resource, resourceId, action, label = 'Reference' }: { id: string; resource: string; resourceId?: string; action?: string; label?: string }) {
  const { toast } = useToast();
  const copy = async () => {
    try { await navigator.clipboard.writeText(id); toast({ title: 'Reference copied', description: id }); } catch { /* clipboard refused */ }
  };
  return (
    <span className="inline-flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground" data-testid="op-ref" data-ref={id}>
      <span>{label} <code className="text-xs text-foreground" title={id}>{shortRef(id)}</code></span>
      <button type="button" onClick={() => void copy()} className="inline-flex items-center gap-0.5 text-primary hover:underline" aria-label={`Copy ${label.toLowerCase()} ${id}`}>
        <Copy className="h-3 w-3" aria-hidden="true" />Copy
      </button>
      <Link href={auditHref({ resource, resourceId: resourceId ?? id, action })} className="inline-flex items-center gap-0.5 text-primary hover:underline" data-testid="op-audit">
        <FileSearch className="h-3 w-3" aria-hidden="true" />Audit log
      </Link>
    </span>
  );
}

/** An axios-style error as the code and message the API answered with. */
export function apiErr(e: unknown): { code: string | null; message: string | null } {
  const d = (e as { response?: { data?: { code?: string; message?: string | string[] } } })?.response?.data;
  const m = Array.isArray(d?.message) ? d?.message.join(' ') : d?.message;
  // Only the server's own words: axios's "Request failed with status code …" is never shown; the caller's fallback is.
  return { code: d?.code ?? null, message: m ?? null };
}

/** One line for a toast: the server's own words, then what to do when it is known. */
export function errorLine(e: unknown, fallback: string): string {
  const x = apiErr(e);
  const t = toolError({ code: x.code, message: x.message ?? fallback });
  return t.fix ? `${t.words} ${t.fix}` : t.words;
}

/** Find text in output already on screen: the matching lines with their numbers. Nothing is fetched. */
export function OutputSearch({ text, label = 'Find in output', testId = 'output-search' }: { text: string; label?: string; testId?: string }) {
  const [q, setQ] = useState('');
  const hits = useMemo(() => findLines(text, q), [text, q]);
  return (
    <div className="space-y-1" data-testid={testId}>
      <div className="relative max-w-sm">
        <Search className="pointer-events-none absolute left-2 top-2.5 h-4 w-4 text-muted-foreground" aria-hidden="true" />
        <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder={label} aria-label={label} className="h-9 pl-8" data-testid={`${testId}-input`} />
      </div>
      {q.trim() && (
        hits.length === 0
          ? <p className="text-xs text-muted-foreground" data-testid={`${testId}-none`}>No line contains “{q.trim()}”.</p>
          : (
            <ol className="max-h-40 overflow-auto rounded-md border bg-muted/40 p-2 font-mono text-xs" data-testid={`${testId}-hits`}>
              {hits.map((h) => <li key={h.n} className="whitespace-pre-wrap break-words"><span className="select-none text-muted-foreground">{h.n}: </span>{h.line}</li>)}
            </ol>
          )
      )}
    </div>
  );
}
