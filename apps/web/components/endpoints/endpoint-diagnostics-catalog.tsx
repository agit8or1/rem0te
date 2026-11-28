'use client';

import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api-client';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { useToast } from '@/hooks/use-toast';
import { formatDate } from '@/lib/utils';
import { DEFAULT_TCP_TIMEOUT, TCP_TIMEOUTS, paramsSummary, parseDiagnosticParams, portFromText, type ParamSchema } from '@/lib/diagnostic-params';
import {
  Stethoscope, Play, Loader2, CheckCircle2, XCircle, Clock, AlertTriangle, ShieldCheck, Lock, FlaskConical, HelpCircle, MinusCircle,
} from 'lucide-react';
import { errorLine, OperationRef } from './workspace/tool-chrome';
import { AUDIT_RESOURCE, deadlineText } from '@/lib/tool-ops';

/**
 * One-click read-only diagnostics (0.31).
 *
 * Each button asks the server to stage a catalog KEY for this computer. The
 * computer collects it on its next heartbeat (up to about three minutes),
 * runs the fixed read-only check its agent has for that key, and posts the
 * result back. Nothing typed here reaches the computer: there is no free
 * text, and the server and the agent both refuse keys outside the catalog.
 *
 * Results are rendered as text, never markup — every field came from a
 * managed computer and is attacker-influenced on a compromised one.
 *
 * 0.76 (the read-only palette): the list is grouped (Security, Networking,
 * Maintenance, General); two keys take typed parameters (a DNS name; a TCP
 * host, port and timeout), checked here by lib/diagnostic-params.ts and again
 * by the server; each palette result carries the server's interpretation —
 * Healthy, Warning, Critical, Unknown or Unsupported, per finding, with the
 * worst as the run's — and Unknown is never drawn as Healthy. The Windows
 * support row is the server's own reading of the inventory and sends nothing.
 */

type RunStatus = 'REQUESTED' | 'DELIVERED' | 'RUNNING' | 'COMPLETED' | 'FAILED' | 'EXPIRED';
const OPEN: RunStatus[] = ['REQUESTED', 'DELIVERED', 'RUNNING'];

interface CatalogItem {
  key: string;
  label: string;
  description: string;
  capability: 'computers:view' | 'computers:event_logs' | 'computers:connect' | string;
  capabilityReason: string;
  supportedOs: string[];
  duration: 'seconds' | 'minute' | 'minutes';
  risk: 'read_only';
  expectedImpact: 'none';
  approvals: string;
  allowed: boolean;
  /** 0.33: shown as a snapshot on that workspace tab instead of in this list. */
  tab?: 'processes' | 'services' | 'network';
  /** 0.76: the group it is listed under. */
  group?: 'general' | 'security' | 'networking' | 'maintenance';
  /** 0.76: the oldest agent that carries it, and whether this computer's is older. */
  minAgent?: string;
  needsNewerAgent?: boolean;
  /** 0.76: the closed parameter schema, for the two keys that take one. */
  params?: ParamSchema;
  /** 0.76: where it has run for real. */
  evidence?: 'lab_windows_server';
}
type HealthState = 'healthy' | 'warning' | 'critical' | 'unknown' | 'unsupported';
interface Finding { id: string; label: string; state: HealthState; detail: string; evidenceAt: string | null }
interface Interpretation { version: number; overall: HealthState; findings: Finding[] }
interface OsSupport extends Finding { build: string | null; channel: string | null; endsOn: string | null; tableReviewed: string }
interface CatalogResponse {
  supported: boolean; agentBound: boolean; isOnline: boolean; lastSeenAt: string | null;
  agentVersion?: string | null;
  /** 0.76: the server's reading of the inventory's Windows build; null off Windows. */
  osSupport?: OsSupport | null;
  items: CatalogItem[];
}
interface Run {
  id: string; key: string; label: string; status: RunStatus;
  requestedAt: string; deliveredAt: string | null; startedAt: string | null; completedAt: string | null; expiresAt: string;
  requestedBy: { id: string | null; name: string | null };
  /** 0.35: an automatic snapshot — the server asked, nobody did. */
  automatic?: boolean;
  error: string | null; truncated: boolean; resultBytes: number | null;
  result: Record<string, unknown> | null; resultWithheld: boolean;
  /** A snapshot run (0.33): its result is on the workspace tab, not in the history. */
  resultOnTab?: boolean;
  /** 0.76: the typed parameters it was asked with (dns_lookup, tcp_port). */
  params?: Record<string, unknown> | null;
  /** 0.76: the server's reading of a completed palette result. */
  interpretation?: Interpretation | null;
}

const GROUPS: { id: NonNullable<CatalogItem['group']>; label: string; blurb: string }[] = [
  { id: 'security', label: 'Security', blurb: 'Antivirus, firewall, disk encryption, boot integrity and who is an administrator.' },
  { id: 'networking', label: 'Networking', blurb: 'Name resolution, reaching a host and port, and the routing table.' },
  { id: 'maintenance', label: 'Maintenance', blurb: 'Updates, restarts, time, activation, crashes, scheduled tasks and who is signed in.' },
  { id: 'general', label: 'General', blurb: 'Inventory, disks, services, errors and processes.' },
];

const CAP_NEEDS: Record<string, string> = { 'computers:event_logs': 'needs “Read event logs”', 'computers:connect': 'needs “Remote connect”' };

const TAB_NAME: Record<string, string> = { process_list: 'Processes', service_list: 'Services', network_adapters: 'Network' };

const DURATION: Record<CatalogItem['duration'], string> = { seconds: 'seconds', minute: 'about a minute', minutes: 'several minutes' };

function ago(at: string | null | undefined, now: number): string {
  if (!at) return '—';
  const s = Math.max(0, Math.round((now - new Date(at).getTime()) / 1000));
  if (s < 45) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} d ago`;
}
function bytes(n: unknown): string {
  if (typeof n !== 'number' || !Number.isFinite(n)) return '—';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0, v = n;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(v >= 10 || i === 0 ? 0 : 1)} ${u[i]}`;
}
const s = (v: unknown) => (v === null || v === undefined || v === '' ? '—' : String(v));
const arr = (v: unknown) => (Array.isArray(v) ? (v as Record<string, unknown>[]) : []);
// 0.93: the server's own words, then what to do (lib/tool-ops.ts TOOL_FIXES).
const errText = (e: unknown, fallback: string) => errorLine(e, fallback);

function StatusPill({ status }: { status: RunStatus }) {
  const map: Record<RunStatus, { label: string; cls: string; icon: React.ReactNode }> = {
    REQUESTED: { label: 'Waiting for the device', cls: 'bg-muted text-muted-foreground', icon: <Clock className="h-3 w-3" /> },
    DELIVERED: { label: 'Delivered', cls: 'bg-blue-100 text-blue-800 dark:bg-blue-950 dark:text-blue-200', icon: <Loader2 className="h-3 w-3 animate-spin" /> },
    RUNNING: { label: 'Running', cls: 'bg-blue-100 text-blue-800 dark:bg-blue-950 dark:text-blue-200', icon: <Loader2 className="h-3 w-3 animate-spin" /> },
    COMPLETED: { label: 'Completed', cls: 'bg-green-100 text-green-800 dark:bg-green-950 dark:text-green-200', icon: <CheckCircle2 className="h-3 w-3" /> },
    FAILED: { label: 'Failed', cls: 'bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-300', icon: <XCircle className="h-3 w-3" /> },
    EXPIRED: { label: 'Expired', cls: 'bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-200', icon: <AlertTriangle className="h-3 w-3" /> },
  };
  const m = map[status];
  return <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium ${m.cls}`}>{m.icon}{m.label}</span>;
}

const HEALTH: Record<HealthState, { label: string; cls: string; icon: React.ReactNode }> = {
  healthy: { label: 'Healthy', cls: 'bg-green-100 text-green-800 dark:bg-green-950 dark:text-green-200', icon: <CheckCircle2 className="h-3 w-3" /> },
  warning: { label: 'Warning', cls: 'bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-200', icon: <AlertTriangle className="h-3 w-3" /> },
  critical: { label: 'Critical', cls: 'bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-300', icon: <XCircle className="h-3 w-3" /> },
  // Unknown is grey with a question mark, never green: not knowing is not healthy.
  unknown: { label: 'Unknown', cls: 'bg-muted text-muted-foreground', icon: <HelpCircle className="h-3 w-3" /> },
  unsupported: { label: 'Unsupported', cls: 'bg-slate-100 text-slate-700 dark:bg-slate-900 dark:text-slate-300', icon: <MinusCircle className="h-3 w-3" /> },
};

/** One health state. Anything the server did not name is drawn as Unknown. */
function HealthPill({ state }: { state: HealthState | string }) {
  const known = Object.prototype.hasOwnProperty.call(HEALTH, state);
  const key = (known ? state : 'unknown') as HealthState;
  const m = HEALTH[key];
  return <span data-health={key} className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium ${m.cls}`}>{m.icon}{m.label}</span>;
}

function Findings({ interpretation }: { interpretation: Interpretation }) {
  if (!interpretation.findings.length) return null;
  return (
    <ul className="space-y-1" data-findings="">
      {interpretation.findings.map((f) => (
        <li key={f.id} className="flex flex-wrap items-start gap-2 text-xs">
          <HealthPill state={f.state} />
          <span className="font-medium">{f.label}</span>
          <span className="text-muted-foreground">{f.detail}</span>
        </li>
      ))}
    </ul>
  );
}

/** Requested → delivered → running → done, with the time of each step reached. */
function Steps({ run }: { run: Run }) {
  const end = run.status === 'COMPLETED' ? 'Completed' : run.status === 'FAILED' ? 'Failed' : run.status === 'EXPIRED' ? 'Expired' : 'Done';
  const steps: [string, string | null][] = [
    ['Requested', run.requestedAt], ['Delivered', run.deliveredAt], ['Running', run.startedAt], [end, run.completedAt],
  ];
  return (
    <ol className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-muted-foreground">
      {steps.map(([label, at], i) => (
        <li key={label} className="flex items-center gap-1">
          <span className={`h-1.5 w-1.5 rounded-full ${at ? (i === 3 && run.status !== 'COMPLETED' ? 'bg-red-500' : 'bg-green-600') : 'bg-muted-foreground/30'}`} />
          <span className={at ? 'text-foreground' : ''}>{label}</span>
          {at && <span className="font-mono">{new Date(at).toLocaleTimeString()}</span>}
          {i < 3 && <span className="text-muted-foreground/50">›</span>}
        </li>
      ))}
    </ol>
  );
}

function Table({ head, rows }: { head: string[]; rows: (string | React.ReactNode)[][] }) {
  if (!rows.length) return <p className="text-sm text-muted-foreground">Nothing to report.</p>;
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-xs">
        <thead><tr className="text-left text-muted-foreground">{head.map((h) => <th key={h} className="py-1 pr-3 font-medium">{h}</th>)}</tr></thead>
        <tbody>{rows.map((r, i) => <tr key={i} className="border-t align-top">{r.map((c, j) => <td key={j} className="py-1 pr-3 break-words">{c}</td>)}</tr>)}</tbody>
      </table>
    </div>
  );
}

const REBOOT_LABEL: Record<string, string> = {
  component_servicing: 'Component servicing (an update or feature install)',
  windows_update: 'Windows Update',
  pending_file_rename: 'Files waiting to be replaced at restart',
  update_agent: 'The Windows Update agent',
};

/** Each catalog key, rendered for a person. Unknown shapes fall back to nothing rather than raw markup. */
function Result({ run }: { run: Run }) {
  const r = run.result ?? {};
  switch (run.key) {
    case 'disk_space':
      return <Table head={['Drive', 'Label', 'File system', 'Size', 'Free', '% free']} rows={arr(r.disks).map((d) => {
        const pct = typeof d.percentFree === 'number' ? d.percentFree : null;
        return [s(d.drive), s(d.label), s(d.fsType), bytes(d.totalBytes), bytes(d.freeBytes),
          pct === null ? '—' : <span className={pct < 10 ? 'text-red-600 font-medium' : pct < 20 ? 'text-amber-600' : ''}>{pct}%</span>];
      })} />;
    case 'service_health':
      return (
        <div className="space-y-3">
          <p className="text-xs text-muted-foreground">{s(r.totalServices)} services installed.</p>
          <div><h4 className="text-xs font-medium mb-1">Set to start automatically but not running</h4>
            <Table head={['Service', 'Name', 'State', 'Start']} rows={arr(r.stoppedAutomatic).map((v) => [s(v.displayName), <span key="n" className="font-mono">{s(v.name)}</span>, s(v.status), s(v.startType)])} /></div>
          <div><h4 className="text-xs font-medium mb-1">Watched by a monitor</h4>
            <Table head={['Service', 'Name', 'State', 'Start']} rows={arr(r.monitored).map((v) => [s(v.displayName), <span key="n" className="font-mono">{s(v.name)}</span>, s(v.status), s(v.startType)])} /></div>
        </div>
      );
    case 'recent_system_errors':
      return (
        <div className="space-y-2">
          <p className="text-xs text-muted-foreground">Critical and Error events, last 24 hours: {s(r.scanned)} read{r.capped ? ' (capped at 2000 per log)' : ''}, grouped by source and event id.</p>
          <Table head={['Count', 'Log', 'Source', 'Id', 'Last seen', 'Message']} rows={arr(r.groups).map((g) => [
            <span key="c" className="font-mono">{s(g.count)}</span>, s(g.log), s(g.provider), <span key="i" className="font-mono">{s(g.eventId)}</span>,
            <span key="t" title={`First ${formatDate(g.firstAt as string)}`}>{formatDate(g.lastAt as string)}</span>,
            <span key="m" className="whitespace-pre-wrap">{s(g.message)}</span>,
          ])} />
        </div>
      );
    case 'top_processes': {
      const rows = (l: unknown) => arr(l).map((p) => [s(p.name), <span key="p" className="font-mono">{s(p.pid)}</span>, typeof p.cpuSeconds === 'number' ? `${p.cpuSeconds.toFixed(1)} s` : '—', bytes(p.workingSetBytes)]);
      return (
        <div className="grid gap-4 md:grid-cols-2">
          <div><h4 className="text-xs font-medium mb-1">By processor time</h4><Table head={['Process', 'PID', 'CPU', 'Memory']} rows={rows(r.byCpu)} /></div>
          <div><h4 className="text-xs font-medium mb-1">By memory</h4><Table head={['Process', 'PID', 'CPU', 'Memory']} rows={rows(r.byMemory)} /></div>
          <p className="text-xs text-muted-foreground md:col-span-2">{s(r.processCount)} processes running. CPU is total processor time since each process started.</p>
        </div>
      );
    }
    case 'network_connectivity': {
      const t = (r.target ?? {}) as Record<string, unknown>;
      return (
        <div className="space-y-3">
          <p className="text-sm flex items-center gap-2">
            {t.reachable ? <CheckCircle2 className="h-4 w-4 text-green-600" /> : <XCircle className="h-4 w-4 text-red-600" />}
            {t.reachable ? `Reached ${s(t.host)}:${s(t.port)} in ${s(t.latencyMs)} ms` : `Could not reach ${s(t.host)}:${s(t.port)} — ${s(t.error)}`}
          </p>
          <Table head={['Adapter', 'Connection', 'State', 'IPv4', 'IPv6', 'Gateway']} rows={arr(r.adapters).map((a) => [
            s(a.name), s(a.connectionId), <span key="s" className={a.up ? 'text-green-700 dark:text-green-400' : 'text-muted-foreground'}>{s(a.status)}</span>,
            <span key="4" className="font-mono">{arr(a.ipv4).join(', ') || '—'}</span>, <span key="6" className="font-mono">{arr(a.ipv6).join(', ') || '—'}</span>, <span key="g" className="font-mono">{arr(a.gateway).join(', ') || '—'}</span>,
          ])} />
        </div>
      );
    }
    case 'dns_resolution':
      return (
        <div className="space-y-2">
          <p className="text-xs text-muted-foreground">DNS servers: <span className="font-mono">{arr(r.resolvers).join(', ') || 'none reported'}</span>. Answers may come from the device&apos;s cache.</p>
          <Table head={['Name', 'Result', 'Addresses', 'Time']} rows={arr(r.lookups).map((l) => [
            <span key="n" className="font-mono">{s(l.name)}</span>, l.ok ? <span key="r" className="text-green-700 dark:text-green-400">Resolved</span> : <span key="r" className="text-red-600">{s(l.error) === '—' ? 'Failed' : s(l.error)}</span>,
            <span key="a" className="font-mono">{arr(l.addresses).join(', ') || '—'}</span>, `${s(l.latencyMs)} ms`,
          ])} />
        </div>
      );
    case 'pending_updates':
      return (
        <div className="space-y-2">
          <p className="text-sm">{s(r.count)} update(s) available{r.rebootRequired ? '; a restart is required' : ''}. The Patches tab has been updated.</p>
          <Table head={['Update', 'KB', 'Severity', 'Size']} rows={arr(r.pending).map((u) => [s(u.title), <span key="k" className="font-mono">{s(u.kb)}</span>, s(u.severity), bytes(u.sizeBytes)])} />
        </div>
      );
    case 'reboot_status':
      return (
        <div className="space-y-1 text-sm">
          <p className="font-medium">{r.pending ? 'A restart is pending.' : 'No restart is pending.'}</p>
          {arr(r.sources).length > 0 && <ul className="list-disc pl-5 text-xs">{(r.sources as string[]).map((x) => <li key={x}>{REBOOT_LABEL[x] ?? x}</li>)}</ul>}
          <p className="text-xs text-muted-foreground">Last boot {formatDate(r.lastBootAt as string)}{typeof r.uptimeSeconds === 'number' ? ` (up ${Math.round(r.uptimeSeconds / 3600)} h)` : ''}.</p>
        </div>
      );
    case 'refresh_inventory':
      return <p className="text-sm">Inventory collected: {s(r.osCaption)} build {s(r.osBuild)}, {s(r.disks)} disk(s), {s(r.networks)} network adapter(s), {s(r.software)} installed program(s). The Specs tab has been updated.</p>;
    // ── 0.76: the palette ──
    case 'defender_status': {
      if (r.supported === false) return <p className="text-xs text-muted-foreground">{r.reason === 'not_running' ? 'Microsoft Defender did not answer.' : 'Microsoft Defender is not installed.'}{r.error ? ` (${s(r.error)})` : ''}</p>;
      const yn = (v: unknown) => (v === true ? 'On' : v === false ? 'Off' : 'Not reported');
      return (
        <div className="space-y-3">
          <Table head={['Setting', 'Value']} rows={[
            ['Defender service', yn(r.amServiceEnabled)], ['Antivirus', yn(r.antivirusEnabled)], ['Real-time protection', yn(r.realTimeProtectionEnabled)],
            ['Behaviour monitoring', yn(r.behaviorMonitorEnabled)], ['Tamper protection', yn(r.isTamperProtected)], ['Mode', s(r.runningMode)],
            ['Signatures', `${s(r.signatureVersion)}${r.signatureLastUpdated ? ` · ${formatDate(r.signatureLastUpdated as string)}` : ''}`],
            ['Last quick scan', r.quickScanEndAt ? formatDate(r.quickScanEndAt as string) : '—'], ['Last full scan', r.fullScanEndAt ? formatDate(r.fullScanEndAt as string) : '—'],
          ]} />
          {arr(r.registeredAntivirus).length > 0 && (
            <div><h4 className="text-xs font-medium mb-1">Registered with Windows Security</h4>
              <Table head={['Product', 'State']} rows={arr(r.registeredAntivirus).map((a) => [s(a.name), <span key="p" className="font-mono">{s(a.productState)}</span>])} /></div>
          )}
        </div>
      );
    }
    case 'firewall_status':
      return (
        <div className="space-y-2">
          <Table head={['Profile', 'On', 'Inbound', 'Outbound']} rows={arr(r.profiles).map((p) => [s(p.name), p.enabled === true ? 'Yes' : p.enabled === false ? 'No' : '—', s(p.defaultInbound), s(p.defaultOutbound)])} />
          <p className="text-xs text-muted-foreground">Networks in use: {arr(r.activeCategories).join(', ') || 'none reported'}. Service: {s(r.serviceState)}.</p>
        </div>
      );
    case 'bitlocker_status':
      if (r.supported === false) return <p className="text-xs text-muted-foreground">BitLocker is not available here.</p>;
      return <Table head={['Volume', 'Type', 'Protection', 'Status', 'Encrypted', 'Method', 'Protectors']} rows={arr(r.volumes).map((v) => [
        <span key="m" className="font-mono">{s(v.mountPoint)}</span>, s(v.volumeType), s(v.protectionStatus), s(v.volumeStatus),
        typeof v.encryptionPercentage === 'number' ? `${v.encryptionPercentage}%` : '—', s(v.encryptionMethod), arr(v.protectorTypes).join(', ') || '—',
      ])} />;
    case 'secure_boot_tpm': {
      const t = (r.tpm ?? {}) as Record<string, unknown>;
      return <Table head={['Item', 'Value']} rows={[
        ['Secure Boot', s(r.secureBoot)], ['TPM present', t.present === true ? 'Yes' : t.present === false ? 'No' : '—'], ['TPM ready', t.ready === true ? 'Yes' : t.ready === false ? 'No' : '—'],
        ['TPM version', s(t.specVersion)], ['TPM manufacturer', s(t.manufacturer)],
      ]} />;
    }
    case 'local_admins':
      return (
        <div className="space-y-2">
          <Table head={['Member', 'Kind', 'Source', '']} rows={arr(r.members).map((m) => [s(m.name), s(m.kind), s(m.source), m.builtinAdministrator ? 'Built-in Administrator' : ''])} />
          {r.method ? <p className="text-[11px] text-muted-foreground">Read with {s(r.method)}.</p> : null}
        </div>
      );
    case 'dns_lookup': {
      const l = (r.lookup ?? {}) as Record<string, unknown>;
      return (
        <div className="space-y-2">
          <Table head={['Name', 'Result', 'Addresses', 'Time']} rows={[[
            <span key="n" className="font-mono">{s(l.name)}</span>,
            l.ok ? <span key="r" className="text-green-700 dark:text-green-400">Resolved</span> : <span key="r" className="text-red-600">{l.timedOut ? 'Timed out' : s(l.error) === '—' ? 'Failed' : s(l.error)}</span>,
            <span key="a" className="font-mono">{arr(l.addresses).join(', ') || '—'}</span>, `${s(l.latencyMs)} ms`,
          ]]} />
          <p className="text-xs text-muted-foreground">DNS servers: <span className="font-mono">{arr(r.resolvers).join(', ') || 'none reported'}</span>. The answer may come from the device&apos;s cache.</p>
        </div>
      );
    }
    case 'tcp_port':
      return <Table head={['Host', 'Port', 'Outcome', 'Time', 'Address']} rows={[[
        <span key="h" className="font-mono">{s(r.host)}</span>, <span key="p" className="font-mono">{s(r.port)}</span>, s(r.outcome),
        r.latencyMs != null ? `${s(r.latencyMs)} ms` : '—', <span key="a" className="font-mono">{s(r.remoteAddress)}</span>,
      ]]} />;
    case 'route_table':
      return (
        <div className="space-y-2">
          <p className="text-xs text-muted-foreground">{s(r.routeCount)} routes.</p>
          <Table head={['Destination', 'Next hop', 'Interface', 'Metric', 'Family']} rows={arr(r.routes).map((x) => [
            <span key="d" className="font-mono">{s(x.destination)}</span>, <span key="n" className="font-mono">{s(x.nextHop)}</span>, s(x.interfaceAlias), s(x.routeMetric), s(x.addressFamily),
          ])} />
        </div>
      );
    case 'time_sync': {
      const q = (r.status ?? {}) as Record<string, unknown>;
      return <Table head={['Item', 'Value']} rows={[
        ['Type', s(r.type)], ['NTP server', s(r.ntpServer)], ['Service', `${s(r.serviceState)}${r.serviceStart ? ` (${s(r.serviceStart)})` : ''}`],
        ['Source', s(q.source)], ['Stratum', s(q.stratum)], ['Last sync', q.lastSyncAt ? formatDate(q.lastSyncAt as string) : '—'],
      ]} />;
    }
    case 'windows_activation':
      return <Table head={['Product', 'Channel', 'Licence', 'Grace']} rows={arr(r.products).map((x) => [s(x.name), s(x.channel), s(x.licenseStatus),
        typeof x.graceMinutes === 'number' && x.graceMinutes > 0 ? `${Math.round(x.graceMinutes / 1440)} d` : '—'])} />;
    case 'unexpected_shutdowns':
      return <Table head={['When', 'Kind', 'Event', 'Bug check']} rows={arr(r.events).map((e) => [formatDate(e.at as string), s(e.kind),
        <span key="i" className="font-mono">{s(e.eventId)}</span>, <span key="b" className="font-mono">{s(e.bugcheckCode)}</span>])} />;
    case 'scheduled_tasks':
      return (
        <div className="space-y-2">
          <p className="text-xs text-muted-foreground">{s(r.taskCount)} tasks outside {'\\Microsoft\\'} ({s(r.microsoftTasks)} of Windows&apos; own not listed). What a task runs is never read.</p>
          <Table head={['Task', 'State', 'Runs as', 'Last run', 'Result', 'Next run']} rows={arr(r.tasks).map((t) => [
            <span key="p" className="font-mono">{`${s(t.path)}${s(t.name)}`}</span>, s(t.state), s(t.runAs),
            t.lastRunAt ? formatDate(t.lastRunAt as string) : '—', <span key="r" className="font-mono">{s(t.lastResult)}</span>, t.nextRunAt ? formatDate(t.nextRunAt as string) : '—',
          ])} />
        </div>
      );
    case 'signed_in_sessions':
      return <Table head={['Session', 'User', 'Since']} rows={arr(r.sessions).map((x) => [<span key="i" className="font-mono">{s(x.sessionId)}</span>, s(x.user), x.since ? formatDate(x.since as string) : '—'])} />;
    default:
      return <p className="text-sm text-muted-foreground">No viewer for this diagnostic.</p>;
  }
}

function RunDetail({ run, now, endpointId }: { run: Run; now: number; endpointId: string }) {
  return (
    <div className="space-y-2 rounded-md border p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm font-medium">{run.label}</span>
          {paramsSummary(run.params) && <span className="font-mono text-xs text-muted-foreground" data-run-params="">{paramsSummary(run.params)}</span>}
          <StatusPill status={run.status} />
          {run.interpretation && <HealthPill state={run.interpretation.overall} />}
        </div>
        <span className="text-xs text-muted-foreground">
          {run.automatic ? 'Asked for automatically' : `Asked by ${run.requestedBy.name ?? 'a former user'}`} {ago(run.requestedAt, now)}
          {run.completedAt && run.status === 'COMPLETED' ? ` · result ${ago(run.completedAt, now)}` : ''}
        </span>
      </div>
      <Steps run={run} />
      {run.status === 'REQUESTED' && <p className="text-xs text-muted-foreground" data-testid="diag-expiry">The device collects this on its next check-in, normally within three minutes. If it does not check in, the request {deadlineText(run.expiresAt, now, { future: 'expires', past: 'expired' }) ?? 'expires'}.</p>}
      {run.error && <p className="text-xs text-red-600 dark:text-red-400">{run.error}</p>}
      {!run.automatic && <OperationRef id={run.id} resource={AUDIT_RESOURCE.device} resourceId={endpointId} action="ENDPOINT_DIAGNOSTIC_REQUESTED" label="Run" />}
      {run.status === 'COMPLETED' && run.resultOnTab && <p className="text-xs text-muted-foreground">The result is on the {TAB_NAME[run.key] ?? 'device'} tab.</p>}
      {run.status === 'COMPLETED' && !run.resultOnTab && (run.resultWithheld
        ? <p className="text-xs text-muted-foreground flex items-center gap-1"><Lock className="h-3 w-3" />The result contains event-log text, which needs the &ldquo;Read event logs&rdquo; permission.</p>
        : (
          <div className="space-y-3">
            {run.interpretation && <Findings interpretation={run.interpretation} />}
            <Result run={run} />
          </div>
        ))}
      {run.truncated && <p className="text-[11px] text-amber-700 dark:text-amber-400">Some lists were shortened to fit the result size limit.</p>}
    </div>
  );
}


/** A parameter form's text, before it is parsed. */
interface FormState { name: string; host: string; port: string; timeout: number }
const EMPTY_FORM: FormState = { name: '', host: '', port: '', timeout: DEFAULT_TCP_TIMEOUT };
const touched = (schema: ParamSchema, f: FormState) => (schema === 'dns_lookup' ? f.name !== '' : f.host !== '' || f.port !== '');
function formParams(schema: ParamSchema, f: FormState): Record<string, unknown> {
  return schema === 'dns_lookup' ? { name: f.name.trim() } : { host: f.host.trim(), port: portFromText(f.port), timeoutSeconds: f.timeout };
}

/** The DNS name, or the TCP host, port and timeout. Plain inputs: nothing typed here is ever drawn as markup. */
function ParamForm({ item, form, onChange, error, disabled, onSubmit }: {
  item: CatalogItem & { params: ParamSchema }; form: FormState; onChange: (f: FormState) => void;
  error: string | null; disabled: boolean; onSubmit: () => void;
}) {
  const id = (f: string) => `diag-${item.key}-${f}`;
  const field = 'h-8 rounded-md border bg-background px-2 text-xs font-mono';
  return (
    <form className="space-y-1" data-diag-form={item.key} onSubmit={(e) => { e.preventDefault(); if (!disabled) onSubmit(); }}>
      <div className="flex flex-wrap items-end gap-2">
        {item.params === 'dns_lookup' ? (
          <label htmlFor={id('name')} className="flex flex-col gap-0.5 text-[11px] text-muted-foreground">
            Name to resolve
            <input id={id('name')} data-diag-param="name" className={`${field} w-64`} maxLength={253} autoComplete="off" spellCheck={false}
              placeholder="intranet.example.com" value={form.name} onChange={(e) => onChange({ ...form, name: e.target.value })} />
          </label>
        ) : (
          <>
            <label htmlFor={id('host')} className="flex flex-col gap-0.5 text-[11px] text-muted-foreground">
              Host
              <input id={id('host')} data-diag-param="host" className={`${field} w-56`} maxLength={253} autoComplete="off" spellCheck={false}
                placeholder="fileserver.example.com" value={form.host} onChange={(e) => onChange({ ...form, host: e.target.value })} />
            </label>
            <label htmlFor={id('port')} className="flex flex-col gap-0.5 text-[11px] text-muted-foreground">
              Port
              <input id={id('port')} data-diag-param="port" className={`${field} w-20`} inputMode="numeric" maxLength={5} autoComplete="off"
                placeholder="445" value={form.port} onChange={(e) => onChange({ ...form, port: e.target.value })} />
            </label>
            <label htmlFor={id('timeout')} className="flex flex-col gap-0.5 text-[11px] text-muted-foreground">
              Timeout
              <select id={id('timeout')} data-diag-param="timeoutSeconds" className="h-8 rounded-md border bg-background px-2 text-xs"
                value={form.timeout} onChange={(e) => onChange({ ...form, timeout: Number(e.target.value) })}>
                {TCP_TIMEOUTS.map((t) => <option key={t} value={t}>{t} s</option>)}
              </select>
            </label>
          </>
        )}
      </div>
      {error && <p className="text-[11px] text-red-600 dark:text-red-400" data-diag-param-error="">{error}</p>}
    </form>
  );
}

/** The server's own reading of the inventory's Windows build. Nothing is sent to the computer, so there is no Run. */
function OsSupportRow({ os, focused }: { os: OsSupport; focused: boolean }) {
  return (
    <li data-diag-key="os_support" data-focused={focused ? 'true' : undefined} tabIndex={-1}
      className={`space-y-1 py-3 outline-none ${focused ? '-mx-2 rounded-md bg-primary/5 px-2 ring-1 ring-primary/40' : ''}`}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-medium">{os.label}</span>
        <HealthPill state={os.state} />
        <span className="text-[11px] text-muted-foreground">runs on the server</span>
      </div>
      <p className="text-xs">{os.detail}</p>
      <p className="text-[11px] text-muted-foreground">
        {os.build ? `Build ${os.build}` : 'No build'}{os.channel ? ` · ${os.channel}` : ''}{os.endsOn ? ` · security updates until ${os.endsOn}` : ''}.
        {' '}From the device&apos;s last inventory{os.evidenceAt ? ` (${formatDate(os.evidenceAt)})` : ''} and a table kept on the server, last reviewed {os.tableReviewed}. Nothing is sent to the device.
      </p>
    </li>
  );
}

export function EndpointDiagnosticsCatalog({ endpointId, focusKey }: {
  endpointId: string;
  /** 0.75: the check the Tools panel opened this tab for: its row is marked, brought into view and its Run button focused. Nothing runs until it is clicked. */
  focusKey?: string | null;
}) {
  const { toast } = useToast();
  const qc = useQueryClient();
  const [selected, setSelected] = useState<string | null>(null);
  const [forms, setForms] = useState<Record<string, FormState>>({});
  const [batch, setBatch] = useState<{ done: number; total: number } | null>(null);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 15_000); return () => clearInterval(t); }, []);

  const catalog = useQuery({
    queryKey: ['diagnostics-catalog', endpointId],
    queryFn: () => api.get(`/endpoints/${endpointId}/diagnostics/catalog`).then((r) => r.data?.data as CatalogResponse),
    staleTime: 60_000,
  });
  const runs = useQuery({
    queryKey: ['diagnostics-runs', endpointId],
    queryFn: () => api.get(`/endpoints/${endpointId}/diagnostics/runs`, { params: { limit: 25 } }).then((r) => (r.data?.data ?? []) as Run[]),
    // Polled only while something is still on its way; `false` stops it.
    refetchInterval: (q) => ((q.state.data ?? []).some((r) => OPEN.includes(r.status)) ? 4000 : false),
  });

  const post = (key: string, params?: Record<string, unknown>) =>
    api.post(`/endpoints/${endpointId}/diagnostics/runs`, params ? { key, params } : { key }).then((r) => r.data?.data as { run: Run; deduplicated: boolean });
  const run = useMutation({
    mutationFn: (v: { key: string; params?: Record<string, unknown> }) => post(v.key, v.params),
    onSuccess: (d) => {
      setSelected(d.run.id);
      if (d.deduplicated) toast({ title: 'Already queued', description: `${d.run.label} is already waiting for this device.` });
      qc.invalidateQueries({ queryKey: ['diagnostics-runs', endpointId] });
    },
    onError: (e) => toast({ title: 'Could not run the diagnostic', description: errText(e, 'The request was refused.'), variant: 'destructive' }),
  });

  const ready = !!catalog.data;
  useEffect(() => {
    if (!focusKey || !ready) return;
    const row = document.querySelector<HTMLElement>(`[data-diag-key="${CSS.escape(focusKey)}"]`);
    row?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    // A parameter form's first field, else the Run button, else (the server's own Windows support row) the row itself.
    const target = row?.querySelector<HTMLElement>('[data-diag-param]') ?? row?.querySelector<HTMLButtonElement>('button[data-diag-run]') ?? row;
    target?.focus({ preventScroll: true });
  }, [focusKey, ready]);

  const c = catalog.data;
  const history = runs.data ?? [];
  const latestByKey = new Map<string, Run>();
  for (const r of history) if (!latestByKey.has(r.key)) latestByKey.set(r.key, r);
  const shown = (selected && history.find((r) => r.id === selected)) || null;

  if (catalog.isLoading) return <div className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" />Loading diagnostics…</div>;
  if (catalog.isError || !c) return <p className="text-sm text-red-600">{errText(catalog.error, 'Diagnostics are not available for this device.')}</p>;

  const blocked = !c.supported
    ? 'These diagnostics run on Windows devices with the standard agent.'
    : !c.agentBound
      ? 'This device has never authenticated with a device secret, so it cannot be asked to run anything. Re-run the installer on it once.'
      : null;

  // Snapshot keys have their own tabs (Processes, Services, Network).
  const listed = c.items.filter((item) => !item.tab);
  const groupOf = (item: CatalogItem) => (GROUPS.some((g) => g.id === item.group) ? item.group! : 'general');
  const busyKey = (key: string) => { const last = latestByKey.get(key); return !!last && OPEN.includes(last.status); };
  const runnable = (item: CatalogItem) => item.allowed && !item.needsNewerAgent && !blocked && !busyKey(item.key);
  // "Run all security checks": every security key this person may run now, one request each, in catalog order.
  const security = listed.filter((i) => groupOf(i) === 'security');
  const securityRunnable = security.filter((i) => runnable(i) && !i.params);

  async function runAllSecurity() {
    const keys = securityRunnable;
    if (!keys.length) return;
    setBatch({ done: 0, total: keys.length });
    let queued = 0, already = 0;
    const failed: string[] = [];
    for (const item of keys) {
      try { const d = await post(item.key); if (d.deduplicated) already++; else queued++; } catch (e) { failed.push(`${item.label}: ${errText(e, 'refused')}`); }
      setBatch((b) => (b ? { ...b, done: b.done + 1 } : b));
    }
    setBatch(null);
    qc.invalidateQueries({ queryKey: ['diagnostics-runs', endpointId] });
    toast({
      title: failed.length ? 'Some security checks were not queued' : 'Security checks queued',
      description: [`${queued} queued`, already ? `${already} already waiting` : '', ...failed].filter(Boolean).join('. '),
      variant: failed.length ? 'destructive' : undefined,
    });
  }

  const renderRow = (item: CatalogItem) => {
    const last = latestByKey.get(item.key);
    const busy = busyKey(item.key);
    const pending = run.isPending && run.variables?.key === item.key;
    const form = forms[item.key] ?? EMPTY_FORM;
    const parsed = item.params ? parseDiagnosticParams(item.params, item.label, formParams(item.params, form)) : null;
    const paramError = item.params && parsed && !parsed.ok && touched(item.params, form) ? parsed.error : null;
    const disabled = !item.allowed || !!item.needsNewerAgent || !!blocked || busy || pending || !!batch || (!!parsed && !parsed.ok);
    const title = !item.allowed ? `Needs ${item.capability}` : item.needsNewerAgent ? `Needs agent ${item.minAgent ?? 'a newer release'}` : parsed && !parsed.ok ? parsed.error : undefined;
    const go = () => {
      if (parsed && !parsed.ok) return;
      run.mutate(parsed && parsed.ok && parsed.params ? { key: item.key, params: parsed.params as Record<string, unknown> } : { key: item.key });
    };
    return (
      <li key={item.key} data-diag-key={item.key} data-focused={focusKey === item.key ? 'true' : undefined}
        className={`flex flex-col gap-2 py-3 sm:flex-row sm:items-start sm:justify-between ${focusKey === item.key ? '-mx-2 rounded-md bg-primary/5 px-2 ring-1 ring-primary/40' : ''}`}>
        <div className="min-w-0 space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-medium">{item.label}</span>
            <span className="text-[11px] text-muted-foreground">takes {DURATION[item.duration]}</span>
            {CAP_NEEDS[item.capability] && <span className="text-[11px] text-muted-foreground" title={item.capabilityReason}>{CAP_NEEDS[item.capability]}</span>}
            {item.evidence === 'lab_windows_server' && (
              <span data-lab-only="" className="inline-flex items-center gap-1 rounded-full border px-1.5 py-0.5 text-[10px] text-muted-foreground"
                title="This check has run for real only on GitHub's Windows Server runner (the lab), never on a Windows 10 or 11 desktop or a customer's device. Treat its reading as new.">
                <FlaskConical className="h-3 w-3" />Tested only on GitHub&rsquo;s Windows Server runner
              </span>
            )}
          </div>
          <p className="text-xs text-muted-foreground">{item.description}</p>
          {item.needsNewerAgent && (
            <p className="text-xs text-amber-700 dark:text-amber-400" data-diag-needs-newer="">
              Needs agent {item.minAgent ?? 'a newer release'} or later; this device reports {c.agentVersion ?? 'no version'}. Update the agent from the Agent card (a signed agent gets it with the next signed release).
            </p>
          )}
          {item.params && !item.needsNewerAgent && item.allowed && !blocked && (
            <ParamForm item={item as CatalogItem & { params: ParamSchema }} form={form} error={paramError} disabled={disabled} onSubmit={go}
              onChange={(f) => setForms((m) => ({ ...m, [item.key]: f }))} />
          )}
          {last && (
            <button type="button" onClick={() => setSelected(last.id)} className="flex flex-wrap items-center gap-2 text-xs hover:underline">
              <StatusPill status={last.status} />
              {last.status === 'COMPLETED' && last.interpretation && <HealthPill state={last.interpretation.overall} />}
              {paramsSummary(last.params) && <span className="font-mono text-muted-foreground">{paramsSummary(last.params)}</span>}
              <span className="text-muted-foreground">{last.status === 'COMPLETED' ? `result ${ago(last.completedAt, now)}` : ago(last.requestedAt, now)}</span>
            </button>
          )}
        </div>
        <Button size="sm" variant="outline" className="shrink-0" data-diag-run="" disabled={disabled} title={title} onClick={go}>
          {busy || pending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : !item.allowed ? <Lock className="h-3.5 w-3.5" /> : <Play className="h-3.5 w-3.5" />}
          <span className="ml-1.5">{busy ? 'Waiting' : 'Run'}</span>
        </Button>
      </li>
    );
  };

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm flex items-center gap-2">
            <Stethoscope className="h-4 w-4 text-muted-foreground" />
            Diagnostics
            <Badge variant="outline" className="ml-1 gap-1 font-normal"><ShieldCheck className="h-3 w-3" />Read-only</Badge>
          </CardTitle>
          <p className="text-xs text-muted-foreground">
            Fixed checks the agent already carries. Nothing is changed on the device and no approval is needed; every run is recorded in the audit log.
            {' '}A reading is Healthy, Warning, Critical, Unknown or Unsupported; Unknown means it could not be read, never that it is fine.
            {!c.isOnline && c.supported && ` This device looks offline (last seen ${ago(c.lastSeenAt, now)}); a request waits fifteen minutes for it.`}
          </p>
        </CardHeader>
        <CardContent className="space-y-5">
          {blocked && <p className="text-sm text-amber-700 dark:text-amber-400 flex items-center gap-2"><AlertTriangle className="h-4 w-4" />{blocked}</p>}
          {GROUPS.map((g) => {
            const items = listed.filter((i) => groupOf(i) === g.id);
            const os = g.id === 'security' ? c.osSupport ?? null : null;
            if (!items.length && !os) return null;
            return (
              <section key={g.id} data-diag-group={g.id} aria-labelledby={`diag-group-${g.id}`}>
                <div className="flex flex-wrap items-end justify-between gap-2 border-b pb-2">
                  <div>
                    <h3 id={`diag-group-${g.id}`} className="text-sm font-semibold">{g.label}</h3>
                    <p className="text-[11px] text-muted-foreground">{g.blurb}</p>
                  </div>
                  {g.id === 'security' && security.length > 0 && (
                    <Button size="sm" variant="secondary" data-diag-run-all="security" disabled={!securityRunnable.length || !!batch || run.isPending}
                      title={!securityRunnable.length ? 'None of the security checks can be run now.' : `Queues ${securityRunnable.length} check${securityRunnable.length === 1 ? '' : 's'}, one request each.`}
                      onClick={() => { void runAllSecurity(); }}>
                      {batch ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ShieldCheck className="h-3.5 w-3.5" />}
                      <span className="ml-1.5">{batch ? `Queuing ${batch.done}/${batch.total}…` : 'Run all security checks'}</span>
                    </Button>
                  )}
                </div>
                <ul className="divide-y">
                  {os && <OsSupportRow os={os} focused={focusKey === 'os_support'} />}
                  {items.map(renderRow)}
                </ul>
              </section>
            );
          })}
        </CardContent>
      </Card>

      {shown && <RunDetail run={shown} now={now} endpointId={endpointId} />}

      <Card>
        <CardHeader className="pb-3"><CardTitle className="text-sm">Recent runs</CardTitle></CardHeader>
        <CardContent>
          {history.length === 0
            ? <p className="text-sm text-muted-foreground">No diagnostics have been run on this device yet.</p>
            : (
              <Table head={['Requested', 'Diagnostic', 'By', 'Status', '']} rows={history.map((r) => [
                <span key="t" title={formatDate(r.requestedAt)}>{ago(r.requestedAt, now)}</span>,
                <span key="d" className="flex flex-wrap items-center gap-1.5">
                  {r.label}
                  {paramsSummary(r.params) && <span className="font-mono text-muted-foreground" data-run-params="">{paramsSummary(r.params)}</span>}
                </span>,
                r.automatic ? 'Automatic' : r.requestedBy.name ?? '—',
                <span key="s" className="flex flex-wrap items-center gap-1"><StatusPill status={r.status} />{r.status === 'COMPLETED' && r.interpretation && <HealthPill state={r.interpretation.overall} />}</span>,
                <button key="v" type="button" className="text-xs text-primary hover:underline" onClick={() => setSelected(r.id)}>{selected === r.id ? 'Shown above' : 'View'}</button>,
              ])} />
            )}
        </CardContent>
      </Card>
    </div>
  );
}
