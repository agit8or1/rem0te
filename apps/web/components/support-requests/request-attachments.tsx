'use client';

import { useEffect, useState } from 'react';
import { api } from '@/lib/api-client';

/**
 * What a support request sent from the tray carries (0.36): a screenshot and
 * a resource-usage sample, each only if the person ticked its box. Both are
 * listed only to someone who can see the computer as well as the queue; the
 * screenshot is fetched with the session (never a public URL) and shown from
 * a blob URL that is revoked when the dialog closes.
 */

export type Attachment = {
  id: string; kind: 'screenshot' | 'usage'; contentType: string; sizeBytes: number; width: number | null; height: number | null;
  createdAt: string;
  data?: {
    sampledAt: string; cpuPercent: number | null; memoryTotalMb: number | null; memoryUsedMb: number | null;
    diskTotalMb: number | null; diskFreeMb: number | null; uptimeSeconds: number | null;
    topProcesses: { name: string; cpuPercent: number | null; memoryMb: number | null }[];
  } | null;
};

function Screenshot({ requestId, a }: { requestId: string; a: Attachment }) {
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let live = true;
    let made: string | null = null;
    api.get(`/support-requests/${requestId}/attachments/${a.id}`, { responseType: 'blob' })
      .then((r) => { if (!live) return; made = URL.createObjectURL(r.data as Blob); setUrl(made); })
      .catch(() => { if (live) setFailed(true); });
    return () => { live = false; if (made) URL.revokeObjectURL(made); };
  }, [requestId, a.id]);
  return (
    <div className="space-y-1" data-testid="request-screenshot">
      <p className="text-xs text-muted-foreground">
        Screenshot · {a.width}×{a.height} · {Math.ceil(a.sizeBytes / 1024)} KB. The person saw it before sending and could remove it.
      </p>
      {failed ? <p className="text-xs text-destructive">The screenshot could not be loaded.</p>
        : url ? <a href={url} target="_blank" rel="noreferrer"><img src={url} alt="Screenshot sent with the request" className="max-h-72 rounded border" /></a>
          : <p className="text-xs text-muted-foreground">Loading…</p>}
    </div>
  );
}

const n = (v: number | null | undefined, unit = '') => (v === null || v === undefined ? '—' : `${Math.round(v * 10) / 10}${unit}`);
const gb = (mb: number | null | undefined) => (mb === null || mb === undefined ? '—' : `${(mb / 1024).toFixed(1)} GB`);

function Usage({ a }: { a: Attachment }) {
  const d = a.data;
  if (!d) return null;
  const up = d.uptimeSeconds ? `${Math.floor(d.uptimeSeconds / 86400)} d ${Math.floor((d.uptimeSeconds % 86400) / 3600)} h` : '—';
  return (
    <div className="space-y-2" data-testid="request-usage">
      <p className="text-xs text-muted-foreground">Resource usage at {new Date(d.sampledAt).toLocaleString()}</p>
      <div className="grid grid-cols-2 gap-x-6 gap-y-1 text-xs sm:grid-cols-4">
        <div><span className="text-muted-foreground">CPU</span> {n(d.cpuPercent, '%')}</div>
        <div><span className="text-muted-foreground">Memory</span> {gb(d.memoryUsedMb)} of {gb(d.memoryTotalMb)}</div>
        <div><span className="text-muted-foreground">System disk free</span> {gb(d.diskFreeMb)} of {gb(d.diskTotalMb)}</div>
        <div><span className="text-muted-foreground">Up</span> {up}</div>
      </div>
      {d.topProcesses.length > 0 && (
        <table className="w-full text-xs">
          <thead><tr className="text-left text-muted-foreground"><th className="font-normal">Program</th><th className="font-normal">CPU</th><th className="font-normal">Memory</th></tr></thead>
          <tbody>
            {d.topProcesses.map((p, i) => (
              <tr key={`${p.name}-${i}`}><td className="font-mono">{p.name}</td><td>{n(p.cpuPercent, '%')}</td><td>{n(p.memoryMb, ' MB')}</td></tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

export function RequestAttachments({ requestId, attachments, hidden }: { requestId: string; attachments: Attachment[]; hidden: number }) {
  if (!attachments.length && !hidden) return null;
  return (
    <div className="space-y-2" data-testid="request-attachments">
      <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Sent from the computer</p>
      {attachments.map((a) => (a.kind === 'screenshot' ? <Screenshot key={a.id} requestId={requestId} a={a} /> : <Usage key={a.id} a={a} />))}
      {hidden > 0 && (
        <p className="text-xs text-muted-foreground" data-testid="request-attachments-hidden">
          This request carries {hidden === 1 ? 'an attachment' : `${hidden} attachments`} from the computer, shown only to people who can see that computer.
        </p>
      )}
    </div>
  );
}
