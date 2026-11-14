'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useMutation } from '@tanstack/react-query';
import { AlertTriangle, Loader2, Search } from 'lucide-react';
import { softwareApi, type SoftwareDetection, type SoftwareEntryInput, type SoftwareHash } from '@/lib/api-client';
import { useToast } from '@/hooks/use-toast';
import { formatDate } from '@/lib/utils';
import { DEPLOYMENT_STATUS } from '@/lib/patching';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';

/**
 * Shared pieces of the software catalog pages (0.34, docs/software-deployment.md).
 *
 * The regular expressions below mirror the server's and the agent's
 * (apps/api/src/actions/catalog.ts, the agent's internal/action). They only
 * let the form say what is wrong before sending it; the server decides, and
 * every refusal it gives is shown as it is, with its fix.
 */

export const selectClass = 'flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm';
export const PACKAGE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9+_-]{0,63}(\.[A-Za-z0-9+_-]{1,64}){1,7}$/;
export const VERSION_RE = /^[0-9A-Za-z][0-9A-Za-z.+_-]{0,63}$/;
export const SHA256_RE = /^[0-9a-f]{64}$/;
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9 ._()+&,'-]{0,119}$/;
const KEY_RE = /^[A-Za-z0-9{}][A-Za-z0-9{}._+ -]{0,127}$/;
const SEGMENT_RE = /^[A-Za-z0-9 ._()+-]{1,64}$/;

export interface Entry {
  id: string; scope: 'global' | 'business'; businessId: string | null; businessName: string | null;
  packageId: string; name: string; publisher: string | null; version: string; installerSha256: string;
  hashSource: 'winget_pkgs' | 'admin_pasted'; manifestUrl: string | null; manifestSha256: string | null;
  installerUrl: string | null; architecture: string | null; detection: SoftwareDetection; notes: string | null; revision: number;
  archivedAt: string | null; createdAt: string; updatedAt: string; canEdit: boolean;
}
export interface DeploymentSummary {
  id: string; name: string; operation: 'install' | 'uninstall'; status: string; pausedReason: string | null; single: boolean; businessId: string;
  entryId: string | null; display: { name?: string; publisher?: string | null; hashSource?: string } | null; rings: number[];
  lastRing: number | null; lastRingStatus: string | null; createdAt: string;
}

/** A refusal's message and, when the server gives one, its fix. */
export function refusal(e: unknown, fallback: string): { message: string; fix: string | null; code: string | null; data: Record<string, unknown> } {
  const d = ((e as { response?: { data?: Record<string, unknown> } })?.response?.data ?? {}) as Record<string, unknown>;
  const m = d.message;
  const message = typeof m === 'string' ? m : Array.isArray(m) ? m.join('; ') : typeof (m as { message?: unknown })?.message === 'string' ? String((m as { message: string }).message) : fallback;
  return { message, fix: typeof d.fix === 'string' ? d.fix : null, code: typeof d.code === 'string' ? d.code : null, data: d };
}
export const refusalText = (e: unknown, fallback: string) => { const r = refusal(e, fallback); return r.fix ? `${r.message} ${r.fix}` : r.message; };

export const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;

/** The server's copy of the winget index (WingetIndexState), as GET software/winget/packages reports it. */
/** Two missed daily reads. */
const INDEX_STALE_MS = 48 * 3_600_000;

export interface WingetIndex {
  refreshedAt: string | null; attemptedAt: string | null; packages: number; lastError: string | null;
  sweep: 'on' | 'off'; refreshing: boolean; nextReadAt?: string | null;
}

/**
 * Where the winget index stands (0.42), wherever it is searched: when it was
 * last read, how many packages, the last error, and when it is next read —
 * with "Read the index now" for a Platform Admin. An empty index is said to
 * be empty, never shown as a search that found nothing.
 */
export function WingetIndexStatus({ idx, isPlatformAdmin, onRead, compact }: { idx: WingetIndex | undefined; isPlatformAdmin: boolean; onRead?: () => void; compact?: boolean }) {
  const { toast } = useToast();
  const read = useMutation({
    mutationFn: () => softwareApi.wingetRefresh(),
    onSuccess: () => { onRead?.(); toast({ title: 'Winget index read' }); },
    onError: (e) => { onRead?.(); toast({ title: 'Not read', description: refusalText(e, 'The index could not be read.'), variant: 'destructive' }); },
  });
  if (!idx) return null;
  const empty = idx.packages === 0;
  // 0.43: a copy more than two days old (the sweep reads daily) is called out too, not only an empty one.
  const stale = !empty && (!idx.refreshedAt || Date.now() - new Date(idx.refreshedAt).getTime() > INDEX_STALE_MS);
  const when = (s: string) => formatDate(s);
  const next = idx.sweep === 'off'
    ? 'The automatic read is switched off on this server (WINGET_INDEX_SWEEP=off).'
    : idx.nextReadAt ? `It is read automatically ${new Date(idx.nextReadAt).getTime() <= Date.now() + 60_000 ? 'within the next 15 minutes' : `at about ${when(idx.nextReadAt)}`}.` : '';
  return (
    <div className={`text-xs ${empty || stale ? 'rounded-md border border-yellow-300 bg-yellow-50 dark:border-yellow-800 dark:bg-yellow-950/40 p-2' : 'text-muted-foreground'} space-y-1`} data-testid="winget-index-status" data-index-empty={empty ? 'true' : 'false'} data-index-stale={stale ? 'true' : 'false'}>
      <p className="flex flex-wrap items-center gap-x-2 gap-y-1">
        {(empty || stale) && <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-yellow-600" />}
        <span>
          {empty
            ? <><strong>The winget catalog is empty on this server</strong> — its index has not been read{idx.attemptedAt ? ` (last tried ${when(idx.attemptedAt)})` : ' yet'}, so a search finds nothing.</>
            : <>Winget index: {idx.packages.toLocaleString()} packages, read {idx.refreshedAt ? when(idx.refreshedAt) : 'at an unknown time'}.{stale ? <strong> That copy is out of date: packages published to winget since are missing from it.</strong> : null}</>}
        </span>
        {isPlatformAdmin && (empty || stale || !compact) && (
          <Button size="sm" variant="outline" className="h-6 text-[11px]" data-testid="winget-read-now" disabled={read.isPending || idx.refreshing} onClick={() => read.mutate()}>
            {read.isPending || idx.refreshing ? <Loader2 className="h-3 w-3 mr-1 animate-spin" /> : null}Read the index now
          </Button>
        )}
      </p>
      {idx.lastError && <p data-testid="winget-index-error">Last error: {idx.lastError}{empty ? '' : ' (the previous copy is still searched)'}</p>}
      {(empty || stale || !compact) && <p>{next}{!isPlatformAdmin && empty ? ' A Platform Admin can read it now from Automation → Software catalog.' : ''}</p>}
    </div>
  );
}

export function describeDetection(d: SoftwareDetection | null | undefined): string {
  if (!d) return 'No detection rule';
  const cmp = `${d.compare === 'gte' ? 'at least' : 'exactly'} ${d.version}`;
  if (d.kind === 'display_name') return `Programs and Features has an entry whose name ${d.match === 'exact' ? 'is' : 'starts with'} “${d.name}”, version ${cmp}`;
  if (d.kind === 'uninstall_key') return `The uninstall key “${d.key}” exists, with DisplayVersion ${cmp}`;
  return `%${d.base}%\\${d.file} exists, with file version ${cmp}`;
}

export function fileProblem(f: string): string | null {
  if (!f) return 'Name the file.';
  if (f.length > 200) return 'At most 200 characters.';
  if (/^[\\/]|^[A-Za-z]:|\//.test(f)) return 'A path under the base folder, with backslashes: no drive letter, no leading backslash, no forward slash.';
  const segs = f.split('\\');
  if (segs.length > 8) return 'At most 8 folders deep.';
  for (const s of segs) {
    if (!SEGMENT_RE.test(s) || s === '.' || s === '..' || s.startsWith(' ') || s.endsWith(' ')) return `“${s}” is not an allowed folder or file name.`;
  }
  if (!/\.(exe|dll)$/i.test(segs[segs.length - 1])) return 'The file must be an .exe or a .dll.';
  return null;
}

export function detectionProblem(d: SoftwareDetection): string | null {
  if (!VERSION_RE.test(d.version)) return 'The detection version is letters, digits and . + _ - (e.g. 24.08).';
  if (d.kind === 'display_name' && !NAME_RE.test(d.name)) return 'The display name starts with a letter or digit and uses letters, digits, spaces and . _ ( ) + & , \' -';
  if (d.kind === 'uninstall_key' && !KEY_RE.test(d.key)) return 'The key is the subkey name only (e.g. 7-Zip or {GUID}), no backslash.';
  if (d.kind === 'file_version') return fileProblem(d.file);
  return null;
}

export function emptyDetection(kind: SoftwareDetection['kind'], version: string, name = ''): SoftwareDetection {
  if (kind === 'display_name') return { kind, name, match: 'prefix', compare: 'gte', version };
  if (kind === 'uninstall_key') return { kind, key: '', compare: 'gte', version };
  return { kind, base: 'ProgramFiles', file: '', compare: 'gte', version };
}

/** The three closed kinds of detection rule, and nothing else. */
export function DetectionEditor({ value, onChange }: { value: SoftwareDetection; onChange: (d: SoftwareDetection) => void }) {
  const problem = detectionProblem(value);
  return (
    <div className="space-y-2 rounded-md border p-3" data-detection-editor>
      <p className="text-xs font-medium">Detection rule — how a computer tells whether this is installed</p>
      <div className="grid grid-cols-1 sm:grid-cols-4 gap-3">
        <div className="space-y-1 sm:col-span-2">
          <Label htmlFor="det-kind" className="text-xs">Look at</Label>
          <select id="det-kind" className={selectClass} value={value.kind} onChange={(e) => onChange(emptyDetection(e.target.value as SoftwareDetection['kind'], value.version, value.kind === 'display_name' ? value.name : ''))}>
            <option value="display_name">Programs and Features display name</option>
            <option value="uninstall_key">Uninstall registry key</option>
            <option value="file_version">A file&apos;s version</option>
          </select>
        </div>
        <div className="space-y-1">
          <Label htmlFor="det-compare" className="text-xs">Version must be</Label>
          <select id="det-compare" className={selectClass} value={value.compare} onChange={(e) => onChange({ ...value, compare: e.target.value as 'gte' | 'eq' })}>
            <option value="gte">at least</option>
            <option value="eq">exactly</option>
          </select>
        </div>
        <div className="space-y-1">
          <Label htmlFor="det-version" className="text-xs">Version</Label>
          <Input id="det-version" maxLength={64} value={value.version} onChange={(e) => onChange({ ...value, version: e.target.value.trim() })} />
        </div>
        {value.kind === 'display_name' && (
          <>
            <div className="space-y-1 sm:col-span-3">
              <Label htmlFor="det-name" className="text-xs">Display name</Label>
              <Input id="det-name" maxLength={120} value={value.name} onChange={(e) => onChange({ ...value, name: e.target.value })} placeholder="e.g. 7-Zip" />
            </div>
            <div className="space-y-1">
              <Label htmlFor="det-match" className="text-xs">Match</Label>
              <select id="det-match" className={selectClass} value={value.match} onChange={(e) => onChange({ ...value, match: e.target.value as 'exact' | 'prefix' })}>
                <option value="prefix">starts with</option>
                <option value="exact">exactly</option>
              </select>
            </div>
          </>
        )}
        {value.kind === 'uninstall_key' && (
          <div className="space-y-1 sm:col-span-4">
            <Label htmlFor="det-key" className="text-xs">Subkey of HKLM\…\Uninstall (64-bit or WOW6432Node)</Label>
            <Input id="det-key" maxLength={128} value={value.key} onChange={(e) => onChange({ ...value, key: e.target.value })} placeholder="e.g. 7-Zip or {23170F69-40C1-2702-2409-000001000000}" />
          </div>
        )}
        {value.kind === 'file_version' && (
          <>
            <div className="space-y-1">
              <Label htmlFor="det-base" className="text-xs">Under</Label>
              <select id="det-base" className={selectClass} value={value.base} onChange={(e) => onChange({ ...value, base: e.target.value as 'ProgramFiles' | 'ProgramFilesX86' })}>
                <option value="ProgramFiles">Program Files</option>
                <option value="ProgramFilesX86">Program Files (x86)</option>
              </select>
            </div>
            <div className="space-y-1 sm:col-span-3">
              <Label htmlFor="det-file" className="text-xs">File (.exe or .dll)</Label>
              <Input id="det-file" maxLength={200} value={value.file} onChange={(e) => onChange({ ...value, file: e.target.value })} placeholder="e.g. 7-Zip\7z.exe" />
            </div>
          </>
        )}
      </div>
      <p className={`text-xs ${problem ? 'text-destructive' : 'text-muted-foreground'}`}>{problem ?? describeDetection(value)}.</p>
      <p className="text-xs text-muted-foreground">
        The software compliance report can read a display-name rule from the inventory&apos;s installed-software list; the other two kinds are known only once a software plan has run on the computer.
      </p>
    </div>
  );
}

interface Installer { architecture: string | null; scope: string | null; installerType: string | null; installerUrl: string | null; installerSha256: string | null; locale: string | null }
interface Preview { url: string; manifestSha256: string; packageIdentifier: string | null; packageVersion: string | null; installers: Installer[] }

function InstallerList({ installers, picked, onPick }: { installers: Installer[]; picked?: string; onPick?: (sha: string, arch: string | null) => void }) {
  return (
    <ul className="space-y-1">
      {installers.map((i, n) => (
        <li key={`${i.installerSha256}-${n}`} className="rounded border p-2 text-xs">
          <span className="font-medium">{i.architecture ?? 'any architecture'}</span> · scope {i.scope ?? 'unstated'} · {i.installerType ?? 'type unstated'}{i.locale ? ` · ${i.locale}` : ''}
          <span className="block font-mono break-all">{i.installerSha256 ?? 'no SHA-256 in the manifest'}</span>
          {i.installerUrl && <span className="block text-muted-foreground break-all">{i.installerUrl}</span>}
          {onPick && i.installerSha256 && (i.scope === null || i.scope === 'machine') && (
            <Button type="button" size="sm" variant={picked === i.installerSha256 ? 'secondary' : 'outline'} className="h-6 mt-1 text-[11px]" onClick={() => onPick(i.installerSha256!, i.architecture)}>
              {picked === i.installerSha256 ? 'Pinned to this one' : 'Pin this installer'}
            </Button>
          )}
        </li>
      ))}
    </ul>
  );
}

/**
 * Adding or changing a catalog entry. The package (and scope) of an existing
 * entry cannot change; everything else can, and each save is a new revision,
 * audited with what it was before.
 */
export function EntryForm({ entry, you, businesses, onDone }: {
  entry?: Entry;
  you?: { businessId: string | null; canCreateBusiness: boolean; canCreateGlobal: boolean };
  businesses?: { id: string; name: string }[];
  onDone: (e?: Entry) => void;
}) {
  const { toast } = useToast();
  const [scope, setScope] = useState<'business' | 'global'>(entry?.scope ?? (you?.canCreateBusiness ? 'business' : 'global'));
  const [businessId, setBusinessId] = useState(you?.businessId ?? '');
  const [packageId, setPackageId] = useState(entry?.packageId ?? '');
  const [name, setName] = useState(entry?.name ?? '');
  const [publisher, setPublisher] = useState(entry?.publisher ?? '');
  const [version, setVersion] = useState(entry?.version ?? '');
  const [notes, setNotes] = useState(entry?.notes ?? '');
  const [source, setSource] = useState<'winget_pkgs' | 'admin_pasted'>(entry?.hashSource ?? 'winget_pkgs');
  const [arch, setArch] = useState<'x64' | 'x86' | 'arm64' | 'neutral'>((entry?.architecture as 'x64') ?? 'x64');
  const [pickedSha, setPickedSha] = useState<string>('');
  const [pasted, setPasted] = useState(entry?.hashSource === 'admin_pasted' ? entry.installerSha256 : '');
  const [detection, setDetection] = useState<SoftwareDetection>(entry?.detection ?? emptyDetection('display_name', ''));
  const [preview, setPreview] = useState<Preview | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [candidates, setCandidates] = useState<{ message: string; list: Installer[] } | null>(null);

  const read = useMutation({
    mutationFn: () => softwareApi.manifestPreview({ packageId: packageId.trim(), version: version.trim() }).then((r) => r.data.data as Preview),
    onSuccess: (p) => { setPreview(p); setPreviewError(null); },
    onError: (e) => { setPreview(null); setPreviewError(refusalText(e, 'The manifest could not be read.')); },
  });

  const hash: SoftwareHash = source === 'admin_pasted'
    ? { source, installerSha256: pasted.trim().toLowerCase() }
    : { source, architecture: arch, ...(pickedSha ? { installerSha256: pickedSha } : {}) };
  const body: SoftwareEntryInput = {
    name: name.trim(), version: version.trim(), hash, detection,
    ...(publisher.trim() ? { publisher: publisher.trim() } : {}), ...(notes.trim() ? { notes: notes.trim() } : {}),
  };
  const save = useMutation({
    mutationFn: () => (entry
      ? softwareApi.update(entry.id, { ...body, expectedRevision: entry.revision })
      : softwareApi.create({ ...body, scope, packageId: packageId.trim(), ...(scope === 'business' && businessId ? { businessId } : {}) })
    ).then((r) => r.data.data as Entry),
    onSuccess: (e) => { toast({ title: entry ? 'Entry changed' : 'Entry added', description: `${e.name} ${e.version} is pinned to ${e.installerSha256.slice(0, 12)}…` }); onDone(e); },
    onError: (e) => {
      const r = refusal(e, 'The entry was refused.');
      const list = Array.isArray(r.data.candidates) ? (r.data.candidates as Installer[]) : null;
      setCandidates(list ? { message: r.message, list } : null);
      toast({ title: entry ? 'Not changed' : 'Not added', description: r.fix ? `${r.message} ${r.fix}` : r.message, variant: 'destructive' });
    },
  });

  const problems = [
    !entry && !PACKAGE_ID_RE.test(packageId.trim()) ? 'The package id is a winget id such as 7zip.7zip.' : null,
    !name.trim() ? 'Give it a name.' : null,
    !VERSION_RE.test(version.trim()) ? 'The version is the exact winget package version (e.g. 24.08).' : null,
    source === 'admin_pasted' && !SHA256_RE.test(pasted.trim().toLowerCase()) ? 'A pasted SHA-256 is 64 hexadecimal characters.' : null,
    detectionProblem(detection),
    !entry && scope === 'business' && !businessId ? 'Choose the business.' : null,
  ].filter(Boolean) as string[];

  return (
    <form className="space-y-4 text-sm" onSubmit={(e) => { e.preventDefault(); if (!problems.length) save.mutate(); }} data-entry-form>
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 max-w-3xl">
        <div className="space-y-1">
          <Label htmlFor="se-pkg" className="text-xs">winget package id</Label>
          <Input id="se-pkg" maxLength={128} value={packageId} disabled={!!entry} onChange={(e) => { setPackageId(e.target.value); setPreview(null); }} placeholder="e.g. 7zip.7zip" />
        </div>
        <div className="space-y-1">
          <Label htmlFor="se-version" className="text-xs">Version (exact)</Label>
          <Input id="se-version" maxLength={64} value={version} onChange={(e) => { setVersion(e.target.value); setPreview(null); setPickedSha(''); }} placeholder="e.g. 24.08" />
        </div>
        <div className="space-y-1">
          <Label htmlFor="se-name" className="text-xs">Name</Label>
          <Input id="se-name" maxLength={120} value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. 7-Zip" />
        </div>
        <div className="space-y-1">
          <Label htmlFor="se-pub" className="text-xs">Publisher (optional)</Label>
          <Input id="se-pub" maxLength={120} value={publisher} onChange={(e) => setPublisher(e.target.value)} />
        </div>
        {!entry && you?.canCreateGlobal && (
          <div className="space-y-1">
            <Label htmlFor="se-scope" className="text-xs">Catalog</Label>
            <select id="se-scope" className={selectClass} value={scope} onChange={(e) => setScope(e.target.value as 'business' | 'global')}>
              <option value="business">One business</option>
              <option value="global">Global (every business)</option>
            </select>
          </div>
        )}
        {!entry && scope === 'business' && businesses && businesses.length > 0 && (
          <div className="space-y-1">
            <Label htmlFor="se-biz" className="text-xs">Business</Label>
            <select id="se-biz" className={selectClass} value={businessId} onChange={(e) => setBusinessId(e.target.value)}>
              <option value="">Choose…</option>
              {businesses.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
            </select>
          </div>
        )}
      </div>

      <div className="space-y-2 rounded-md border p-3">
        <p className="text-xs font-medium">Installer SHA-256 — what every computer will check the downloaded installer against</p>
        <div className="flex flex-wrap gap-4 text-xs">
          <label className="flex items-center gap-1"><input type="radio" checked={source === 'winget_pkgs'} onChange={() => setSource('winget_pkgs')} />From the winget-pkgs manifest</label>
          <label className="flex items-center gap-1"><input type="radio" checked={source === 'admin_pasted'} onChange={() => setSource('admin_pasted')} />Paste it myself</label>
        </div>
        {source === 'winget_pkgs' ? (
          <div className="space-y-2">
            <div className="flex flex-wrap items-end gap-2">
              <div className="space-y-1 w-40">
                <Label htmlFor="se-arch" className="text-xs">Architecture</Label>
                <select id="se-arch" className={selectClass} value={arch} onChange={(e) => { setArch(e.target.value as 'x64'); setPickedSha(''); }}>
                  {['x64', 'x86', 'arm64', 'neutral'].map((a) => <option key={a} value={a}>{a}</option>)}
                </select>
              </div>
              <Button type="button" size="sm" variant="outline" disabled={read.isPending || !PACKAGE_ID_RE.test(packageId.trim()) || !VERSION_RE.test(version.trim())} onClick={() => read.mutate()}>
                {read.isPending ? <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" /> : <Search className="h-3.5 w-3.5 mr-1" />}Read the manifest
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">
              The server reads the installer manifest for this exact package and version from github.com/microsoft/winget-pkgs (one bounded request) when you save, and pins its machine-scope installer for this architecture. If the manifest lists more than one, pick one below.
            </p>
            {previewError && <p className="text-xs text-destructive">{previewError}</p>}
            {preview && (
              <div className="space-y-1 text-xs" data-manifest-preview>
                <p><span className="text-muted-foreground">Manifest</span> <a className="underline break-all" href={preview.url} target="_blank" rel="noopener noreferrer">{preview.url}</a></p>
                <p><span className="text-muted-foreground">Manifest SHA-256</span> <span className="font-mono break-all">{preview.manifestSha256}</span></p>
                <InstallerList installers={preview.installers} picked={pickedSha} onPick={(sha, a) => { setPickedSha(sha); if (a && ['x64', 'x86', 'arm64', 'neutral'].includes(a)) setArch(a as 'x64'); }} />
              </div>
            )}
            {pickedSha && <p className="text-xs">Pinning <span className="font-mono break-all">{pickedSha}</span> <Button type="button" size="sm" variant="ghost" className="h-6 text-[11px]" onClick={() => setPickedSha('')}>clear</Button></p>}
          </div>
        ) : (
          <div className="space-y-1">
            <Label htmlFor="se-sha" className="text-xs">Installer SHA-256 (64 hex characters)</Label>
            <Input id="se-sha" className="font-mono" maxLength={64} value={pasted} onChange={(e) => setPasted(e.target.value.trim())} />
            <p className="text-xs text-muted-foreground">
              Recorded as pasted by you, with no manifest behind it. Each computer still refuses an installer whose hash differs, and also refuses one whose hash is not in the manifest winget downloads beside it.
            </p>
          </div>
        )}
        {candidates && (
          <div className="space-y-1 text-xs">
            <p className="text-destructive">{candidates.message}</p>
            <InstallerList installers={candidates.list} picked={pickedSha} onPick={(sha, a) => { setPickedSha(sha); setSource('winget_pkgs'); if (a && ['x64', 'x86', 'arm64', 'neutral'].includes(a)) setArch(a as 'x64'); }} />
          </div>
        )}
      </div>

      <DetectionEditor value={detection} onChange={setDetection} />

      <div className="space-y-1 max-w-3xl">
        <Label htmlFor="se-notes" className="text-xs">Notes (optional)</Label>
        <Textarea id="se-notes" rows={2} maxLength={500} value={notes} onChange={(e) => setNotes(e.target.value)} />
      </div>

      {problems.length > 0 && <ul className="text-xs text-muted-foreground list-disc pl-5">{problems.map((p) => <li key={p}>{p}</li>)}</ul>}
      <p className="text-xs text-muted-foreground flex gap-2"><AlertTriangle className="h-3.5 w-3.5 shrink-0 mt-0.5 text-yellow-600" />
        Saving asks you to sign in again, and is recorded in the audit log with the pinned hash and the detection rule. Deployments already made keep the entry as it was and stop at their next ring.
      </p>
      <div className="flex gap-2">
        <Button type="submit" size="sm" disabled={problems.length > 0 || save.isPending}>
          {save.isPending && <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />}{entry ? 'Save as a new revision' : 'Add to the catalog'}
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={() => onDone()}>Cancel</Button>
      </div>
    </form>
  );
}

export function SignerBanner() {
  return (
    <div className="mb-4 rounded-md border border-yellow-500/50 bg-yellow-50 dark:bg-yellow-950/30 p-3 text-sm" data-signer-banner>
      <p className="font-medium flex items-center gap-2"><AlertTriangle className="h-4 w-4 text-yellow-600" />The approval signer is not set up on this server</p>
      <p className="text-xs mt-1">
        The catalog can be kept, but nothing can be deployed: every software plan needs two approvals on the approval signer, and without one nothing can be approved. Install the approval signer and set APPROVAL_SIGNER_INTERNAL_URL (Patching setup, steps 3–5).
      </p>
    </div>
  );
}

export function DeploymentList({ rows, empty }: { rows: DeploymentSummary[]; empty: string }) {
  if (!rows.length) return <p className="text-muted-foreground text-sm">{empty}</p>;
  return (
    <div className="space-y-2 text-sm">
      {rows.map((d) => (
        <Link key={d.id} href={`/automation/software/deployments/${d.id}`} className="block rounded-md border p-3 hover:bg-muted/50" data-deployment-row>
          <div className="flex flex-wrap items-center gap-2">
            <strong className="break-all">{d.name}</strong>
            <Badge variant={DEPLOYMENT_STATUS[d.status] ?? 'outline'}>{d.status.toLowerCase()}</Badge>
            <Badge variant="outline">{d.operation}</Badge>
            {d.single && <Badge variant="outline">one computer</Badge>}
            <span className="text-xs text-muted-foreground">{d.single ? '' : `rings of ${d.rings.join(', ')} · `}{formatDate(d.createdAt)}</span>
          </div>
          {d.lastRing !== null && <p className="text-xs text-muted-foreground mt-1">{d.lastRing === 0 ? (d.single ? 'Plan' : 'Canary') : `Ring ${d.lastRing}`}: {d.lastRingStatus?.toLowerCase().replace(/_/g, ' ')}</p>}
          {d.pausedReason && d.status === 'PAUSED' && <p className="text-xs mt-1">Paused: {d.pausedReason}</p>}
        </Link>
      ))}
    </div>
  );
}
