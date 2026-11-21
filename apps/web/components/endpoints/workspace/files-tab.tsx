'use client';

import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, ArrowDownToLine, ArrowUpFromLine, CheckCircle2, Loader2, ShieldAlert, X } from 'lucide-react';
import { filesApi } from '@/lib/api-client';
import { CAP, usePermissions } from '@/lib/auth';
import { Sha256, fromBase64, toBase64 } from '@/lib/sha256';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useToast } from '@/hooks/use-toast';
import { compareVersions } from '@/lib/device-tools';
import { agentType, ago } from './device-model';

/**
 * Files (0.78 Courier, docs/file-transfer.md). Send a file to a Windows
 * computer running the signed agent, or fetch one from it, with no screen
 * sharing. The agent reads and writes as SYSTEM, and the panel says so.
 *
 * Every decision is the server's and the agent's:
 *   - who may (a Platform Admin, upload and download separately);
 *   - the path rule;
 *   - the size limit;
 *   - the clocks;
 *   - who may cancel.
 *
 * This panel moves the bytes in 512 KiB chunks and hashes the whole file
 * itself (lib/sha256.ts, in slices):
 *   - Upload: the hash is declared up front, and the agent checks it
 *     before putting the file in place.
 *   - Download: the agent declares its hash, and the panel checks it before
 *     offering the file.
 *
 * A transfer starts at the computer's next check-in, which can take up to
 * about three minutes.
 */

type Transfer = {
  id: string; direction: 'to_computer' | 'from_computer'; path: string; overwrite: boolean; reason: string;
  state: 'pending' | 'transferring' | 'completed' | 'failed' | 'cancelled'; size: number | null; sha256: string | null;
  maxBytes: number; chunks: number; inSeq: number; ackSeq: number; bytesDone: number;
  createdAt: string; endedAt: string | null; endReason: string | null;
  technicianEmail: string | null; mine: boolean; canCancel: boolean;
};
type ListView = { transfers: Transfer[]; limits: { maxBytes: number; chunkBytes: number; maxMinutes: number; stallMinutes: number; minAgent: string } };

const END_TEXT: Record<string, string> = {
  completed: 'Completed',
  cancelled: 'Cancelled by its technician',
  revoked: 'Cancelled',
  expired: 'Ended: the 60-minute limit',
  stalled: 'Ended: nothing moved for 10 minutes',
  paused: 'Ended: remote access was paused by containment',
  endpoint_unavailable: 'Ended: the computer is no longer available',
  agent_error: 'The computer lost the transfer',
  exists: 'Refused: a file is already there (tick Overwrite to replace it)',
  not_found: 'Refused: no such file',
  not_a_file: 'Refused: that is not a regular file',
  no_folder: 'Refused: the folder does not exist',
  reparse_point: 'Refused: a link or junction is on the path',
  path_refused: 'Refused: that path is not allowed',
  path_changed: 'Refused: the path changed while it was being used',
  too_large: 'Refused: larger than this business allows',
  hash_mismatch: 'Failed: the SHA-256 did not match',
  size_mismatch: 'Failed: the size did not match',
  file_changed: 'Failed: the file changed while it was being read',
  write_failed: 'Failed: the computer could not write the file',
  read_failed: 'Failed: the computer could not read the file',
};

const MB = 1024 * 1024;
const fmtBytes = (n: number | null) => (n === null ? '—' : n >= MB ? `${(n / MB).toFixed(1)} MB` : n >= 1024 ? `${(n / 1024).toFixed(1)} KB` : `${n} B`);
const errText = (e: unknown, fallback: string) =>
  (e as { response?: { data?: { message?: string | string[] } } })?.response?.data?.message?.toString() ?? fallback;
const errCode = (e: unknown) => (e as { response?: { data?: { code?: string } } })?.response?.data?.code;
const errStatus = (e: unknown) => (e as { response?: { status?: number } })?.response?.status;
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const stateText = (t: Transfer) => (t.state === 'pending' ? 'Waiting for the computer'
  : t.state === 'transferring' ? 'Transferring' : END_TEXT[t.endReason ?? ''] ?? t.endReason ?? t.state);
/** A Windows file name from a browser's file name. */
const baseName = (n: string) => n.split(/[\\/]/).pop() || 'file';

/** The whole file's SHA-256, read in slices. */
async function hashFile(f: File, chunk: number, onProgress: (p: number) => void, stopped: () => boolean): Promise<string | null> {
  const h = new Sha256();
  for (let off = 0; off < f.size; off += chunk) {
    if (stopped()) return null;
    h.update(new Uint8Array(await f.slice(off, off + chunk).arrayBuffer()));
    onProgress(Math.min(1, (off + chunk) / Math.max(1, f.size)));
  }
  return h.hex();
}

type Job = { tid: string; kind: 'upload'; file: File } | { tid: string; kind: 'download' };

export function DeviceFilesTab({ endpointId, ep }: { endpointId: string; ep: Record<string, unknown> }) {
  const { can } = usePermissions();
  const canUpload = can(CAP.COMPUTERS_FILES_UPLOAD);
  const canDownload = can(CAP.COMPUTERS_FILES_DOWNLOAD);
  const qc = useQueryClient();
  const { toast } = useToast();
  const agent = agentType(ep);
  const windowsSigned = agent.kind === 'signed' && !agent.readOnlyOs;

  const list = useQuery<ListView>({
    queryKey: ['files', endpointId],
    queryFn: () => filesApi.list(endpointId).then((r) => r.data.data as ListView),
    refetchInterval: 5_000,
    retry: false,
  });
  const limits = list.data?.limits;
  const minAgent = limits?.minAgent ?? '0.78.0';
  const versionOk = typeof ep.agentVersion === 'string' && (compareVersions(ep.agentVersion, minAgent) ?? -1) >= 0;
  const ready = windowsSigned && versionOk;
  const refresh = () => void qc.invalidateQueries({ queryKey: ['files', endpointId] });

  const [jobs, setJobs] = useState<Job[]>([]);

  // ── Send ──
  const [file, setFile] = useState<File | null>(null);
  const [upPath, setUpPath] = useState('');
  const [overwrite, setOverwrite] = useState(false);
  const [upReason, setUpReason] = useState('');
  const [hashing, setHashing] = useState<number | null>(null);
  const tooBig = !!(file && limits && file.size > limits.maxBytes);
  const startUpload = async () => {
    if (!file || !limits) return;
    let stop = false;
    setHashing(0);
    try {
      const sum = await hashFile(file, limits.chunkBytes, setHashing, () => stop);
      if (!sum) return;
      const r = await filesApi.upload(endpointId, { path: upPath.trim(), size: file.size, sha256: sum, overwrite, reason: upReason.trim() });
      const t = r.data.data as Transfer;
      setJobs((j) => [{ tid: t.id, kind: 'upload', file }, ...j]);
      setFile(null); setUpPath(''); setUpReason(''); setOverwrite(false);
      refresh();
    } catch (e) {
      toast({ title: 'Not sent', description: errText(e, 'The transfer could not be started.'), variant: 'destructive' });
    } finally {
      stop = true;
      setHashing(null);
    }
  };

  // ── Fetch ──
  const [downPath, setDownPath] = useState('');
  const [downReason, setDownReason] = useState('');
  const downM = useMutation({
    mutationFn: () => filesApi.download(endpointId, { path: downPath.trim(), reason: downReason.trim() }).then((r) => r.data.data as Transfer),
    onSuccess: (t) => { setJobs((j) => [{ tid: t.id, kind: 'download' }, ...j]); setDownPath(''); setDownReason(''); refresh(); },
    onError: (e) => toast({ title: 'Not fetched', description: errText(e, 'The transfer could not be started.'), variant: 'destructive' }),
  });
  const cancelM = useMutation({
    mutationFn: (tid: string) => filesApi.cancel(endpointId, tid),
    onSuccess: refresh,
    onError: (e) => toast({ title: 'Not cancelled', description: errText(e, 'The transfer could not be cancelled.'), variant: 'destructive' }),
  });

  const transfers = list.data?.transfers ?? [];
  const mineLive = new Set(jobs.map((j) => j.tid));

  return (
    <div className="space-y-4" data-testid="files-tab">
      <div className="flex items-start gap-2 rounded-md border border-red-300 bg-red-50 p-3 text-sm text-red-900 dark:border-red-900 dark:bg-red-950/40 dark:text-red-200" role="note" data-testid="files-identity">
        <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
        <p><strong>SYSTEM — full control of this computer.</strong> The agent reads and writes files as SYSTEM, anywhere on a local drive, with nothing shown to the person at the computer. Every transfer is recorded in the audit log with its path, reason and SHA-256; the server keeps no copy of the file.</p>
      </div>

      {!windowsSigned ? (
        <Card><CardContent className="pt-6 text-sm text-muted-foreground" data-testid="files-unsupported">
          File transfer needs a Windows computer running the full (signed) agent {minAgent} or later. {agent.explanation}
        </CardContent></Card>
      ) : !versionOk ? (
        <Card><CardContent className="pt-6 text-sm text-muted-foreground" data-testid="files-unsupported">
          This computer’s agent ({String(ep.agentVersion ?? 'unknown')}) is older than {minAgent}, which first transferred files. Let it update first.
        </CardContent></Card>
      ) : null}

      {jobs.map((j) => (
        <TransferProgress key={j.tid} endpointId={endpointId} job={j} onDone={refresh}
          onDismiss={() => setJobs((all) => all.filter((x) => x.tid !== j.tid))} />
      ))}

      {ready && (canUpload || canDownload) && (
        <div className="grid gap-4 lg:grid-cols-2">
          {canUpload && (
            <Card data-testid="files-upload">
              <CardHeader className="pb-2"><CardTitle className="flex items-center gap-2 text-base"><ArrowUpFromLine className="h-4 w-4" />Send a file to the computer</CardTitle></CardHeader>
              <CardContent>
                <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); void startUpload(); }}>
                  <div className="space-y-1">
                    <Label htmlFor="files-upload-file">File</Label>
                    <Input id="files-upload-file" type="file" data-testid="files-upload-file"
                      onChange={(e) => {
                        const f = e.target.files?.[0] ?? null;
                        setFile(f);
                        if (f && !upPath) setUpPath(`C:\\Windows\\Temp\\${baseName(f.name)}`);
                      }} />
                    {file && <p className={`text-xs ${tooBig ? 'text-destructive' : 'text-muted-foreground'}`}>{fmtBytes(file.size)}{tooBig && limits ? ` — this business allows up to ${fmtBytes(limits.maxBytes)}` : ''}</p>}
                  </div>
                  <div className="space-y-1">
                    <Label htmlFor="files-upload-path">Save as (an absolute local path on the computer)</Label>
                    <Input id="files-upload-path" value={upPath} onChange={(e) => setUpPath(e.target.value)} maxLength={1024} placeholder="C:\Windows\Temp\setup.msi" className="font-mono" data-testid="files-upload-path" spellCheck={false} />
                  </div>
                  <label className="flex items-center gap-2 text-sm">
                    <input type="checkbox" checked={overwrite} onChange={(e) => setOverwrite(e.target.checked)} data-testid="files-upload-overwrite" />
                    Replace the file if one is already there
                  </label>
                  <div className="space-y-1">
                    <Label htmlFor="files-upload-reason">Reason (recorded in the audit log)</Label>
                    <Input id="files-upload-reason" value={upReason} onChange={(e) => setUpReason(e.target.value)} maxLength={500} placeholder="e.g. Ticket 4812: vendor driver" data-testid="files-upload-reason" />
                  </div>
                  <Button type="submit" disabled={!file || tooBig || hashing !== null || upPath.trim().length < 4 || upReason.trim().length < 3} data-testid="files-upload-button">
                    {hashing !== null && <Loader2 className="mr-1 h-4 w-4 animate-spin" />}
                    {hashing !== null ? `Hashing… ${Math.round(hashing * 100)}%` : 'Send as SYSTEM'}
                  </Button>
                </form>
              </CardContent>
            </Card>
          )}
          {canDownload && (
            <Card data-testid="files-download">
              <CardHeader className="pb-2"><CardTitle className="flex items-center gap-2 text-base"><ArrowDownToLine className="h-4 w-4" />Fetch a file from the computer</CardTitle></CardHeader>
              <CardContent>
                <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); downM.mutate(); }}>
                  <div className="space-y-1">
                    <Label htmlFor="files-download-path">File (an absolute local path on the computer)</Label>
                    <Input id="files-download-path" value={downPath} onChange={(e) => setDownPath(e.target.value)} maxLength={1024} placeholder="C:\Windows\Logs\CBS\CBS.log" className="font-mono" data-testid="files-download-path" spellCheck={false} />
                  </div>
                  <div className="space-y-1">
                    <Label htmlFor="files-download-reason">Reason (recorded in the audit log)</Label>
                    <Input id="files-download-reason" value={downReason} onChange={(e) => setDownReason(e.target.value)} maxLength={500} placeholder="e.g. Ticket 4812: setup log" data-testid="files-download-reason" />
                  </div>
                  <Button type="submit" disabled={downM.isPending || downPath.trim().length < 4 || downReason.trim().length < 3} data-testid="files-download-button">
                    {downM.isPending && <Loader2 className="mr-1 h-4 w-4 animate-spin" />}Fetch as SYSTEM
                  </Button>
                </form>
              </CardContent>
            </Card>
          )}
        </div>
      )}
      {ready && (
        <p className="text-xs text-muted-foreground">
          A transfer starts at the computer’s next check-in (up to about three minutes) and keeps this tab busy while it runs: leave it open.
          {limits ? ` Up to ${fmtBytes(limits.maxBytes)} for this business; it ends after ${limits.stallMinutes} minutes without progress and ${limits.maxMinutes} minutes in all.` : ''}
          {' '}Paths are absolute and local (C:\…): no network paths, “..”, links or junctions. An existing file is never replaced unless you tick it.
        </p>
      )}
      {!canUpload && !canDownload && (
        <p className="text-sm text-muted-foreground" data-testid="files-not-permitted">Only a Platform Admin can transfer files. You can see what was transferred here, and cancel a transfer if you may edit this computer.</p>
      )}

      <Card>
        <CardHeader className="pb-2"><CardTitle className="text-base">Recent transfers</CardTitle></CardHeader>
        <CardContent>
          {list.isLoading ? <p className="text-sm text-muted-foreground">Loading…</p>
            : list.isError ? <p className="text-sm text-muted-foreground">{errText(list.error, 'Could not read the transfers.')}</p>
              : transfers.length === 0 ? <p className="text-sm text-muted-foreground" data-testid="files-none">No file has been transferred with this computer.</p>
                : (
                  <ul className="divide-y text-sm" data-testid="files-transfers">
                    {transfers.map((t) => (
                      <li key={t.id} className="flex flex-wrap items-center justify-between gap-2 py-2" data-testid="files-row" data-state={t.state}>
                        <div className="min-w-0">
                          <div className="flex items-center gap-1 font-medium">
                            {t.direction === 'to_computer' ? <ArrowUpFromLine className="h-3 w-3" aria-label="Sent to the computer" /> : <ArrowDownToLine className="h-3 w-3" aria-label="Fetched from the computer" />}
                            <span className="break-all font-mono text-xs">{t.path}</span>
                          </div>
                          <div className="break-words text-xs text-muted-foreground">
                            {t.direction === 'to_computer' ? 'Sent' : 'Fetched'} by {t.technicianEmail ?? 'a technician'} · {stateText(t)} · {fmtBytes(t.size)} · “{t.reason}” · {ago(t.createdAt)}
                            {t.sha256 && <> · <span className="font-mono" title={t.sha256}>SHA-256 {t.sha256.slice(0, 12)}…</span></>}
                          </div>
                        </div>
                        {t.canCancel && !mineLive.has(t.id) && (
                          <Button size="sm" variant="destructive" onClick={() => cancelM.mutate(t.id)} disabled={cancelM.isPending} data-testid="files-revoke">Cancel</Button>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
        </CardContent>
      </Card>
    </div>
  );
}

/** One transfer this browser started: it moves the bytes, shows progress, and offers Cancel. */
function TransferProgress({ endpointId, job, onDone, onDismiss }: { endpointId: string; job: Job; onDone: () => void; onDismiss: () => void }) {
  const { toast } = useToast();
  const [t, setT] = useState<Transfer | null>(null);
  const [moved, setMoved] = useState(0);
  const [note, setNote] = useState<string | null>(null);
  const [verified, setVerified] = useState<boolean | null>(null);
  const [saveUrl, setSaveUrl] = useState<{ url: string; name: string } | null>(null);
  const stopped = useRef(false);
  // The parent's callback changes every render; the transfer must not restart with it.
  const doneRef = useRef(onDone);
  doneRef.current = onDone;

  useEffect(() => {
    const onDone = () => doneRef.current();
    stopped.current = false;
    const status = async () => {
      const r = await filesApi.get(endpointId, job.tid);
      const v = r.data.data as Transfer;
      setT(v);
      return v;
    };
    const finished = (v: Transfer) => v.state === 'completed' || v.state === 'failed' || v.state === 'cancelled';

    const upload = async (file: File) => {
      let v = await status();
      const chunk = 512 * 1024;
      const total = Math.ceil(file.size / chunk);
      let seq = 1;
      while (!stopped.current && seq <= total) {
        const bytes = new Uint8Array(await file.slice((seq - 1) * chunk, seq * chunk).arrayBuffer());
        try {
          await filesApi.putChunk(endpointId, job.tid, { seq, data: toBase64(bytes), sha256: new Sha256().update(bytes).hex() });
          setMoved(Math.min(file.size, seq * chunk));
          seq++;
        } catch (e) {
          if (errCode(e) === 'FILES_WINDOW_FULL' || errCode(e) === 'FILES_BUSY') { await wait(700); continue; }
          if (errCode(e) === 'FILES_CHUNK_ORDER') {
            const s = (e as { response?: { data?: { inSeq?: number } } }).response?.data?.inSeq;
            if (typeof s === 'number') { seq = s + 1; continue; }
          }
          if (errCode(e) === 'FILES_ENDED') break;
          setNote(errText(e, 'A chunk could not be sent.'));
          await wait(2000);
          v = await status().catch(() => v);
          if (finished(v)) break;
        }
      }
      while (!stopped.current) {
        v = await status().catch(() => v);
        if (finished(v)) break;
        await wait(1500);
      }
      onDone();
    };

    const download = async () => {
      const parts: Uint8Array[] = [];
      const h = new Sha256();
      let seq = 1;
      let v = await status();
      while (!stopped.current) {
        if (v.state === 'failed' || v.state === 'cancelled') break;
        const all = v.state === 'completed' && seq > v.chunks;
        if (all) break;
        if (seq <= v.inSeq) {
          try {
            const r = await filesApi.getChunk(endpointId, job.tid, seq);
            const c = r.data.data as { seq: number; data: string; sha256: string };
            const bytes = fromBase64(c.data);
            if (new Sha256().update(bytes).hex() !== c.sha256) { setNote('A chunk arrived damaged. Start the download again.'); break; }
            parts.push(bytes);
            h.update(bytes);
            setMoved((m) => m + bytes.length);
            seq++;
            continue;
          } catch (e) {
            if (errStatus(e) === 410) { setNote(errText(e, 'That chunk is no longer held.')); break; }
            await wait(1000);
          }
        } else {
          await wait(v.state === 'pending' ? 1500 : 500);
        }
        v = await status().catch(() => v);
      }
      if (!stopped.current && v.state === 'completed' && seq > v.chunks) {
        const sum = h.hex();
        const ok = sum === v.sha256;
        setVerified(ok);
        await filesApi.received(endpointId, job.tid, sum).catch(() => undefined);
        if (ok) {
          const url = URL.createObjectURL(new Blob(parts as BlobPart[], { type: 'application/octet-stream' }));
          setSaveUrl({ url, name: v.path.split('\\').pop() || 'download.bin' });
        }
      }
      onDone();
    };

    void (job.kind === 'upload' ? upload(job.file) : download()).catch((e) => {
      if (!stopped.current) setNote(errText(e, 'The transfer stopped.'));
    });
    return () => { stopped.current = true; };
  }, [endpointId, job]);

  useEffect(() => () => { if (saveUrl) URL.revokeObjectURL(saveUrl.url); }, [saveUrl]);

  const cancel = async () => {
    try {
      await filesApi.cancel(endpointId, job.tid);
      stopped.current = true;
      const r = await filesApi.get(endpointId, job.tid);
      setT(r.data.data as Transfer);
      doneRef.current();
    } catch (e) {
      toast({ title: 'Not cancelled', description: errText(e, 'The transfer could not be cancelled.'), variant: 'destructive' });
    }
  };

  const size = job.kind === 'upload' ? job.file.size : t?.size ?? null;
  const pct = size ? Math.min(100, Math.round((moved / size) * 100)) : t?.state === 'completed' ? 100 : 0;
  const live = !t || t.state === 'pending' || t.state === 'transferring' || (job.kind === 'download' && t.state === 'completed' && verified === null && !note);
  const failed = t && (t.state === 'failed' || t.state === 'cancelled');
  const text = !t ? 'Starting…'
    : t.state === 'pending' ? 'Waiting for the computer (its next check-in)…'
      : t.state === 'transferring' ? (job.kind === 'upload' ? (moved >= (size ?? 0) ? 'Sent; the computer is writing and checking it…' : 'Sending…') : 'Receiving…')
        : t.state === 'completed' ? (job.kind === 'download' ? (verified === null ? 'Receiving…' : verified ? 'Received and verified' : 'Received, but the SHA-256 does not match: not saved') : 'Written on the computer and verified')
          : END_TEXT[t.endReason ?? ''] ?? t.endReason ?? t.state;

  return (
    <Card data-testid="files-progress" data-state={t?.state ?? 'loading'} data-direction={job.kind}>
      <CardContent className="space-y-2 pt-4">
        <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
          <span className="flex min-w-0 items-center gap-2">
            {job.kind === 'upload' ? <ArrowUpFromLine className="h-4 w-4 shrink-0" /> : <ArrowDownToLine className="h-4 w-4 shrink-0" />}
            <span className="font-medium">{job.kind === 'upload' ? 'Sending to the computer' : 'Fetching from the computer'}</span>
            <span className="break-all font-mono text-xs text-muted-foreground">{t?.path ?? ''}</span>
          </span>
          <span className="flex items-center gap-1 text-xs" data-testid="files-progress-state">
            {live && !failed && <Loader2 className="h-3 w-3 animate-spin" />}
            {failed && <AlertTriangle className="h-3 w-3 text-destructive" />}
            {t?.state === 'completed' && (job.kind === 'upload' || verified) && <CheckCircle2 className="h-3 w-3 text-green-600 dark:text-green-400" />}
            {text}
          </span>
        </div>
        <div className="h-2 w-full overflow-hidden rounded bg-muted" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct} data-testid="files-progress-bar">
          <div className={`h-full ${failed ? 'bg-destructive' : 'bg-primary'}`} style={{ width: `${pct}%` }} />
        </div>
        <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
          <span>{fmtBytes(moved)} of {fmtBytes(size)}{t?.sha256 ? <> · <span className="font-mono" title={t.sha256}>SHA-256 {t.sha256.slice(0, 16)}…</span></> : null}</span>
          <span className="flex gap-2">
            {saveUrl && <a className="underline text-foreground" href={saveUrl.url} download={saveUrl.name} data-testid="files-save">Save {saveUrl.name}</a>}
            {t && (t.state === 'pending' || t.state === 'transferring') && (
              <Button size="sm" variant="destructive" onClick={() => void cancel()} data-testid="files-cancel"><X className="mr-1 h-3 w-3" />Cancel</Button>
            )}
            {t && !live && <Button size="sm" variant="outline" onClick={onDismiss}>Close</Button>}
          </span>
        </div>
        {note && <p className="text-xs text-destructive" data-testid="files-note">{note}</p>}
      </CardContent>
    </Card>
  );
}
