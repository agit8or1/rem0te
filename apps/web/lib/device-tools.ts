/**
 * The device page's Tools panel (0.75): which existing flow each tool opens,
 * and whether it can work on this computer for this person — with a reason.
 *
 * Pure: no imports, no fetching, no clock of its own (`now` is passed in), so
 * apps/web/scripts/unit-device-tools.mjs runs it as it is. Everything it
 * reads is data the console already has: the computer (GET /endpoints/:id),
 * the action catalog (GET /actions/catalog?endpointId=), the diagnostics
 * catalog (GET /endpoints/:id/diagnostics/catalog), the patch summary, the
 * containment banner and the signed-in person (GET /auth/me).
 *
 * This decides only what the panel shows. It is not a control: every tool
 * opens an existing tab or page, whose route checks scope, capability, fresh
 * sign-in, containment and the approval signer again, and whose agent checks
 * the signed plan again. Nothing here adds a route, an action or a parameter.
 *
 * States, in the order they are decided (the first that applies wins):
 *
 *   coming_later      no flow behind it yet — said plainly, never faked
 *   unsupported       this OS or agent has nothing to run it (Linux, macOS,
 *                     RustDesk only)
 *   inactive          archived, not enrolled, or in the unassigned pool
 *   not_permitted     the person's role does not allow it (the button would 403;
 *                     for a check, the diagnostics catalog's `allowed`, 0.76)
 *   not_configured    the server has no approval signer, so no action can be
 *                     approved
 *   needs_newer_agent the agent does not report the action (or is older than
 *                     the release that added it, or the diagnostics catalog
 *                     says it predates the check), or it is the standard
 *                     agent and the action needs the full (signed) agent
 *   contained         a containment pause stops it for this business
 *                     (`actions` for an action, `remote` for the terminal
 *                     and file transfer)
 *   offline           not reporting; the request waits for a check-in
 *                     (a terminal or a transfer is refused: it needs a
 *                     reporting computer)
 *   needs_approval    a signed action: two approvers authorize it first
 *   available         opens and can be used now
 *
 * `offline`, `needs_approval` and `available` open their flow; the rest are
 * shown disabled with their reason. Unknown is never reported as healthy:
 * the restart-pending tool says "unknown" until a scan has answered.
 */

export type ToolGroup =
  | 'diagnostics' | 'remote' | 'scripts' | 'services' | 'software' | 'updates' | 'networking' | 'security' | 'maintenance';

export const TOOL_GROUPS: readonly { id: ToolGroup; label: string }[] = [
  { id: 'diagnostics', label: 'Diagnostics' },
  { id: 'remote', label: 'Terminal and files' },
  { id: 'scripts', label: 'PowerShell / Scripts' },
  { id: 'services', label: 'Services & processes' },
  { id: 'software', label: 'Software' },
  { id: 'updates', label: 'Windows Updates' },
  { id: 'networking', label: 'Networking' },
  { id: 'security', label: 'Security' },
  { id: 'maintenance', label: 'Maintenance' },
];

export type ToolState =
  | 'available' | 'needs_approval' | 'needs_newer_agent' | 'unsupported' | 'contained' | 'offline'
  | 'not_permitted' | 'not_configured' | 'inactive' | 'coming_later' | 'checking';

export const TOOL_STATES: readonly ToolState[] = [
  'available', 'needs_approval', 'needs_newer_agent', 'unsupported', 'contained', 'offline',
  'not_permitted', 'not_configured', 'inactive', 'coming_later', 'checking',
];

export const STATE_LABEL: Record<ToolState, string> = {
  available: 'Available',
  needs_approval: 'Needs approval',
  needs_newer_agent: 'Needs a newer agent',
  unsupported: 'Unsupported here',
  contained: 'Paused',
  offline: 'Not reporting',
  not_permitted: 'Not permitted',
  not_configured: 'Not set up',
  inactive: 'Unavailable',
  coming_later: 'Coming later',
  checking: 'Checking…',
};

/** The states whose tool opens its flow when picked. */
export const OPENS: readonly ToolState[] = ['available', 'needs_approval', 'offline'];
export const opens = (s: ToolState) => OPENS.includes(s);

/** The workspace tabs a tool can open (device-model.ts WorkspaceTab, the ones used here). */
export type ToolTab = 'diagnostics' | 'actions' | 'processes' | 'services' | 'network' | 'software' | 'patches' | 'events' | 'terminal' | 'files';

/** Where a tool goes: a tab with what to open in it, a page, or a download. */
export type ToolTarget =
  | { kind: 'tab'; tab: ToolTab; action?: string; check?: string; log?: string }
  | { kind: 'href'; href: string }
  | { kind: 'download'; href: string };

/** What a tool needs, as data, so the rule is the same for every tool. */
type Need =
  /** Read-only, server side: works for anyone who can see the computer. */
  | { kind: 'server' }
  /**
   * A read-only diagnostics-catalog key the heartbeat runs (Windows agents).
   * `connect`: the key needs computers:connect (0.76: dns_lookup, tcp_port).
   */
  | { kind: 'diagnostic'; key: string; eventLogs?: boolean; connect?: boolean; minAgent?: string }
  /** A tab that shows what the agent reported (Windows agents). */
  | { kind: 'view'; eventLogs?: boolean; minAgent?: string }
  /** Asks every agent (any OS) to scan or re-collect: POST /endpoints/:id/inventory/refresh. */
  | { kind: 'scan' }
  /** What the last scan said, from any agent: nothing is asked of the computer. */
  | { kind: 'status' }
  /** An approved catalog action, by id@version, on the signed agent. */
  | { kind: 'action'; action: string; version: number; eventLogs?: boolean }
  /**
   * 0.77: the background terminal on the signed Windows agent, from
   * `minAgent`. Not an approved action: the person needs computers:terminal
   * (a Platform Admin only) and confirms it is them when the policy asks.
   */
  | { kind: 'terminal'; minAgent: string }
  /**
   * 0.78: background file transfer on the signed Windows agent, from
   * `minAgent`. Upload needs computers:files_upload, download
   * computers:files_download (both a Platform Admin's only).
   */
  | { kind: 'files'; dir: 'upload' | 'download'; minAgent: string }
  /** Nothing behind it yet. */
  | { kind: 'later' };

export interface ToolDef {
  id: string;
  group: ToolGroup;
  label: string;
  /** What it does, in one line, and which existing flow it opens. */
  description: string;
  need: Need;
  target: ToolTarget | null;
}

/**
 * The tools, by group. Every target is an existing tab, page or link; every
 * action is one of the approved catalog's twelve, by its existing id.
 */
export function toolCatalog(endpointId: string): ToolDef[] {
  const e = encodeURIComponent(endpointId);
  const diag = (check: string): ToolTarget => ({ kind: 'tab', tab: 'diagnostics', check });
  const act = (action: string): ToolTarget => ({ kind: 'tab', tab: 'actions', action });
  /** The release that added the read-only palette (catalog.ts PALETTE_MIN_AGENT). */
  const PALETTE = '0.76.0';
  return [
    // ── Diagnostics ──
    { id: 'test-connection', group: 'diagnostics', label: 'Test connection', description: 'The server checks RustDesk, the relay and this device’s last check-in. Diagnostics tab.', need: { kind: 'server' }, target: { kind: 'tab', tab: 'diagnostics', check: 'test-connection' } },
    { id: 'refresh-inventory', group: 'diagnostics', label: 'Refresh inventory', description: 'Re-collect hardware, disks, adapters and installed software. Read-only.', need: { kind: 'diagnostic', key: 'refresh_inventory' }, target: diag('refresh_inventory') },
    { id: 'disk-space', group: 'diagnostics', label: 'Disk space', description: 'Size and free space of every fixed volume. Read-only.', need: { kind: 'diagnostic', key: 'disk_space' }, target: diag('disk_space') },
    { id: 'service-health', group: 'diagnostics', label: 'Service health', description: 'Automatic services that are not running. Read-only.', need: { kind: 'diagnostic', key: 'service_health' }, target: diag('service_health') },
    { id: 'top-processes', group: 'diagnostics', label: 'Top processes', description: 'The ten processes using the most processor time and memory. Read-only.', need: { kind: 'diagnostic', key: 'top_processes' }, target: diag('top_processes') },
    { id: 'recent-errors', group: 'diagnostics', label: 'Recent system errors', description: 'Critical and Error events from the last 24 hours, grouped. Read-only.', need: { kind: 'diagnostic', key: 'recent_system_errors', eventLogs: true }, target: diag('recent_system_errors') },
    { id: 'diagnostics-report', group: 'diagnostics', label: 'Download diagnostics report', description: 'The connection checks and what the device last reported, as one file.', need: { kind: 'server' }, target: { kind: 'download', href: `/api/v1/endpoints/${e}/diagnostics/report` } },

    // ── Terminal (0.77) ──
    { id: 'terminal', group: 'remote', label: 'Open a terminal (cmd or PowerShell)', description: 'A background shell as SYSTEM — full control of this device — with no screen sharing. Needs a reason; ends after 15 minutes idle or 60 in all. Terminal tab.', need: { kind: 'terminal', minAgent: '0.77.0' }, target: { kind: 'tab', tab: 'terminal' } },
    // ── Files (0.78) ──
    { id: 'files-upload', group: 'remote', label: 'Send a file to the device', description: 'Written by the agent as SYSTEM to an absolute local path, checked by SHA-256, never over an existing file unless you say so. Files tab.', need: { kind: 'files', dir: 'upload', minAgent: '0.78.0' }, target: { kind: 'tab', tab: 'files' } },
    { id: 'files-download', group: 'remote', label: 'Fetch a file from the device', description: 'Read by the agent as SYSTEM from an absolute local path and checked by SHA-256 in your browser. Files tab.', need: { kind: 'files', dir: 'download', minAgent: '0.78.0' }, target: { kind: 'tab', tab: 'files' } },

    // ── PowerShell / Scripts ──
    { id: 'run-script', group: 'scripts', label: 'Run an approved script', description: 'An approved version from the script library, with its typed arguments. Opens Automation → Scripts.', need: { kind: 'action', action: 'windows.script.run', version: 1 }, target: { kind: 'href', href: '/automation/scripts' } },

    // ── Services & Processes ──
    { id: 'services', group: 'services', label: 'Services', description: 'Every Windows service with its state and start mode; start, stop, restart or change its startup type from a row.', need: { kind: 'view', minAgent: '0.33.0' }, target: { kind: 'tab', tab: 'services' } },
    { id: 'service-control', group: 'services', label: 'Start, stop or restart a service', description: 'From its row on the Services tab. Protected services are refused.', need: { kind: 'action', action: 'windows.service.control', version: 1 }, target: { kind: 'tab', tab: 'services' } },
    { id: 'service-restart', group: 'services', label: 'Restart an allowlisted service', description: 'Windows Update, BITS, the spooler and the other services on the restart list. Actions tab.', need: { kind: 'action', action: 'windows.service.restart', version: 1 }, target: act('windows.service.restart') },
    { id: 'spooler-start', group: 'services', label: 'Start the Print Spooler', description: 'Starts the spooler when it has stopped. Actions tab.', need: { kind: 'action', action: 'windows.service.start', version: 1 }, target: act('windows.service.start') },
    { id: 'processes', group: 'services', label: 'Processes', description: 'Every running process with its owner and start time.', need: { kind: 'view', minAgent: '0.33.0' }, target: { kind: 'tab', tab: 'processes' } },
    { id: 'process-stop', group: 'services', label: 'End a process', description: 'From its row on the Processes tab, checked against its start time.', need: { kind: 'action', action: 'windows.process.stop', version: 1 }, target: { kind: 'tab', tab: 'processes' } },

    // ── Software ──
    { id: 'software-list', group: 'software', label: 'Installed software', description: 'What the inventory lists, with versions and changes.', need: { kind: 'view' }, target: { kind: 'tab', tab: 'software' } },
    { id: 'software-install', group: 'software', label: 'Install software', description: 'A catalog or winget package, as a one-device deployment. Software tab.', need: { kind: 'action', action: 'windows.software.install', version: 1 }, target: { kind: 'tab', tab: 'software' } },
    { id: 'software-remove', group: 'software', label: 'Remove a program', description: 'A program from the installed list, by its own silent uninstaller. Software tab.', need: { kind: 'action', action: 'windows.software.remove', version: 1 }, target: { kind: 'tab', tab: 'software' } },

    // ── Windows Updates ──
    { id: 'patch-scan', group: 'updates', label: 'Check for updates now', description: 'Asks the agent to scan and report pending updates at its next check-in. Patches tab.', need: { kind: 'scan' }, target: { kind: 'tab', tab: 'patches' } },
    { id: 'restart-pending', group: 'updates', label: 'Restart pending?', description: 'What the last update scan said. Patches tab.', need: { kind: 'status' }, target: { kind: 'tab', tab: 'patches' } },
    { id: 'reboot-status', group: 'updates', label: 'Restart signals', description: 'Which Windows signals say a restart is pending, and the last boot time. Read-only.', need: { kind: 'diagnostic', key: 'reboot_status' }, target: diag('reboot_status') },
    { id: 'install-updates', group: 'updates', label: 'Install updates', description: 'Pick updates and install them on this device as a one-device deployment. Patches tab.', need: { kind: 'action', action: 'windows.update.install', version: 1 }, target: { kind: 'tab', tab: 'patches' } },

    // ── Networking ──
    { id: 'network', group: 'networking', label: 'Network adapters', description: 'Addresses, gateways, DNS servers and DHCP for every adapter.', need: { kind: 'view', minAgent: '0.33.0' }, target: { kind: 'tab', tab: 'network' } },
    { id: 'network-connectivity', group: 'networking', label: 'Network connectivity', description: 'Whether the device can reach this server, and which adapters are up. Read-only.', need: { kind: 'diagnostic', key: 'network_connectivity' }, target: diag('network_connectivity') },
    { id: 'dns-resolution', group: 'networking', label: 'DNS resolution', description: 'Resolve this server’s name and one fixed public name, with timings. Read-only.', need: { kind: 'diagnostic', key: 'dns_resolution' }, target: diag('dns_resolution') },
    // 0.76: the read-only palette's networking checks.
    { id: 'dns-lookup', group: 'networking', label: 'DNS lookup', description: 'Resolve a host name you give through this device’s resolver. Read-only.', need: { kind: 'diagnostic', key: 'dns_lookup', connect: true, minAgent: PALETTE }, target: diag('dns_lookup') },
    { id: 'tcp-port', group: 'networking', label: 'TCP port test', description: 'Whether this device can connect to a host and port you give. Connects and closes; sends nothing.', need: { kind: 'diagnostic', key: 'tcp_port', connect: true, minAgent: PALETTE }, target: diag('tcp_port') },
    { id: 'route-table', group: 'networking', label: 'Routes', description: 'The routing table: destinations, next hops and metrics. Read-only.', need: { kind: 'diagnostic', key: 'route_table', minAgent: PALETTE }, target: diag('route_table') },
    { id: 'flush-dns', group: 'networking', label: 'Flush DNS / renew DHCP', description: 'No approved action does this yet.', need: { kind: 'later' }, target: null },

    // ── Security ──
    { id: 'security-log', group: 'security', label: 'Security event log', description: 'Sign-ins, account changes and audit entries from the Security log. Event logs tab.', need: { kind: 'view', eventLogs: true }, target: { kind: 'tab', tab: 'events', log: 'Security' } },
    // 0.76: the read-only palette's security checks, and the server's own OS support check.
    { id: 'defender', group: 'security', label: 'Microsoft Defender', description: 'Real-time and tamper protection, signature age and the last scan. Read-only.', need: { kind: 'diagnostic', key: 'defender_status', minAgent: PALETTE }, target: diag('defender_status') },
    { id: 'firewall', group: 'security', label: 'Windows Firewall', description: 'Each profile on or off, and its default inbound and outbound action. Read-only.', need: { kind: 'diagnostic', key: 'firewall_status', minAgent: PALETTE }, target: diag('firewall_status') },
    { id: 'bitlocker', group: 'security', label: 'BitLocker', description: 'Protection and encryption of every volume. Recovery keys are never read.', need: { kind: 'diagnostic', key: 'bitlocker_status', minAgent: PALETTE }, target: diag('bitlocker_status') },
    { id: 'secure-boot-tpm', group: 'security', label: 'Secure Boot and TPM', description: 'Whether Secure Boot is on and a TPM is present and ready. Read-only.', need: { kind: 'diagnostic', key: 'secure_boot_tpm', minAgent: PALETTE }, target: diag('secure_boot_tpm') },
    { id: 'local-admins', group: 'security', label: 'Local administrators', description: 'Who is in the local Administrators group. Read-only.', need: { kind: 'diagnostic', key: 'local_admins', minAgent: PALETTE }, target: diag('local_admins') },
    { id: 'os-support', group: 'security', label: 'Windows support', description: 'Whether this Windows build still gets security updates, from the inventory and a table on the server. Nothing is sent to the device.', need: { kind: 'server' }, target: { kind: 'tab', tab: 'diagnostics', check: 'os_support' } },

    // ── Maintenance ──
    { id: 'restart-schedule', group: 'maintenance', label: 'Schedule a restart', description: 'With a 15-minute warning on screen; waits for an open RustDesk session. Actions tab.', need: { kind: 'action', action: 'windows.reboot.schedule', version: 1 }, target: act('windows.reboot.schedule') },
    { id: 'restart-cancel', group: 'maintenance', label: 'Cancel a scheduled restart', description: 'Asks Windows to cancel a pending shutdown. Actions tab.', need: { kind: 'action', action: 'windows.reboot.cancel', version: 1 }, target: act('windows.reboot.cancel') },
    { id: 'logs-collect', group: 'maintenance', label: 'Collect diagnostic logs', description: 'System and Application errors, the agent’s journal and the RustDesk log, redacted. Actions tab.', need: { kind: 'action', action: 'windows.logs.collect', version: 1, eventLogs: true }, target: act('windows.logs.collect') },
    // 0.76: the read-only palette's maintenance checks.
    { id: 'time-sync', group: 'maintenance', label: 'Time sync', description: 'The Windows Time service and its last successful sync. Read-only.', need: { kind: 'diagnostic', key: 'time_sync', minAgent: PALETTE }, target: diag('time_sync') },
    { id: 'activation', group: 'maintenance', label: 'Windows activation', description: 'Activated, in a grace period or unlicensed. The product key is never read.', need: { kind: 'diagnostic', key: 'windows_activation', minAgent: PALETTE }, target: diag('windows_activation') },
    { id: 'unexpected-shutdowns', group: 'maintenance', label: 'Unexpected shutdowns', description: 'Restarts without a clean shutdown, and blue screens, in the last 30 days. Read-only.', need: { kind: 'diagnostic', key: 'unexpected_shutdowns', minAgent: PALETTE }, target: diag('unexpected_shutdowns') },
    { id: 'scheduled-tasks', group: 'maintenance', label: 'Scheduled tasks', description: 'Tasks outside Windows’ own folder, with their last result. What they run is never read.', need: { kind: 'diagnostic', key: 'scheduled_tasks', minAgent: PALETTE }, target: diag('scheduled_tasks') },
    { id: 'signed-in', group: 'maintenance', label: 'Signed-in users', description: 'Who is signed in to Windows now. Read-only.', need: { kind: 'diagnostic', key: 'signed_in_sessions', minAgent: PALETTE }, target: diag('signed_in_sessions') },
  ];
}

// ── The facts the decision is made from ─────────────────────────────────────

export type AgentKind = 'signed' | 'standard' | 'rustdesk-only' | 'unknown';

export interface ToolFacts {
  /** device-model.ts agentType(): which agent, and the read-only OS when there is one. */
  agentKind: AgentKind;
  readOnlyOs: 'Linux' | 'macOS' | null;
  /** The label the computer reports, e.g. '0.69.0'; null when it never said. */
  agentVersion: string | null;
  /** What the agent reports it can run, as id@version (Endpoint.agentActions). */
  agentActions: string[];
  status: string;
  /** tenantId or customerId null: the unassigned pool (§70). */
  pooled: boolean;
  /** The diagnostics catalog's agentBound; null while it has not been read. */
  agentBound: boolean | null;
  /**
   * 0.76: the diagnostics catalog's per-key `allowed` (the person holds the
   * key's capability) and `needsNewerAgent` (the server knows this agent
   * predates the key); null while it has not been read.
   */
  diagAllowed: Record<string, boolean> | null;
  diagNeedsNewer: Record<string, boolean> | null;
  /** lib/connectivity.ts. */
  connectivity: 'online' | 'agent_silent' | 'offline';
  /** Already worded, e.g. "Offline since 3d ago". */
  connectivityText: string;
  signer: {
    /** GET /actions/catalog: configured; null while it has not been read. */
    configured: boolean | null;
    /** The business's approval mode on the signer, or null when it did not answer. */
    approval: 'direct' | 'signed' | null;
  };
  /** Containment kinds paused for this computer's business (or globally). */
  paused: string[];
  perms: {
    view: boolean;
    eventLogs: boolean;
    /** 0.77: holds computers:terminal (a Platform Admin only). */
    terminal: boolean;
    /** 0.78: holds computers:files_upload / computers:files_download (a Platform Admin only). */
    filesUpload: boolean;
    filesDownload: boolean;
    /** May request approved actions of this risk on this computer (mayRequestActions()). */
    requestLow: boolean;
    requestHigh: boolean;
  };
  /**
   * Each action's risk on this computer: the catalog's workstationRisk on a
   * standard workstation, high on anything else (ActionsService). An action
   * not listed counts as high.
   */
  actionRisk: Record<string, 'low' | 'high'>;
  /** The last update scan's restart flag, and when it was taken; null when unknown. */
  restartPending: boolean | null;
  /**
   * 0.79: each catalog action's rollback and repeatability, as GET
   * /actions/catalog serves them (actions/catalog.ts is the one copy; the
   * web holds none). Absent while the catalog has not been read.
   */
  actionNotes?: Record<string, ActionNote>;
}

/** 0.79 (§89): how an action is undone, and whether a second run is harmless. */
export interface ActionNote {
  rollback: { kind: 'none' | 'inverse' | 'read_only'; via?: string; how: string };
  repeat: { safe: boolean; why: string };
}

export interface ToolView extends ToolDef {
  state: ToolState;
  reason: string;
  /** 0.79: an action tool's rollback and repeatability; null for every other tool, or before the catalog is read. */
  note: ActionNote | null;
}

/** 0.79: the short label for each rollback kind. */
export const ROLLBACK_LABEL: Record<ActionNote['rollback']['kind'], string> = {
  inverse: 'Can be undone',
  none: 'No undo from here',
  read_only: 'Read-only',
};

/** 0.79: one line, e.g. "Can be undone: Cancel a scheduled restart · Not safe to repeat". `titles` names the via action. */
export function noteLine(n: ActionNote, titles: Record<string, string> = {}): string {
  const via = n.rollback.kind === 'inverse' && n.rollback.via ? `: ${titles[n.rollback.via] ?? n.rollback.via}` : '';
  return `${ROLLBACK_LABEL[n.rollback.kind]}${via} · ${n.repeat.safe ? 'Safe to repeat' : 'Not safe to repeat'}`;
}

/** The note for an action tool, or null. */
export function toolNote(def: ToolDef, f: ToolFacts): ActionNote | null {
  return def.need.kind === 'action' ? f.actionNotes?.[def.need.action] ?? null : null;
}

/** a.b.c compared as numbers; null when either is not a version. */
export function compareVersions(a: string, b: string): number | null {
  const p = (v: string) => (/^\d+\.\d+\.\d+/.test(v) ? v.split(/[.+-]/).slice(0, 3).map(Number) : null);
  const x = p(a), y = p(b);
  if (!x || !y) return null;
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1;
  return 0;
}


function unsupported(f: ToolFacts, need: Need): string | null {
  if (need.kind === 'server' || need.kind === 'later') return null;
  if (f.agentKind === 'rustdesk-only') return 'This device has RustDesk only: no agent reports or runs anything on it.';
  if (need.kind === 'scan' || need.kind === 'status') return null; // every agent scans, Linux and macOS included
  if (f.readOnlyOs) return `The ${f.readOnlyOs} agent is read-only: it reports inventory and pending updates and runs nothing the console sends.`;
  return null;
}

function inactive(f: ToolFacts, need: Need): string | null {
  if (need.kind === 'later' || need.kind === 'server') return null;
  if (f.status === 'ARCHIVED') return 'This device is archived.';
  if (f.status === 'PENDING_ENROLLMENT') return 'This device has not finished enrolment.';
  // Reading what it reported is how a pooled computer is inspected; nothing runs on it (§70).
  if (f.pooled && (need.kind === 'action' || need.kind === 'diagnostic' || need.kind === 'terminal' || need.kind === 'files')) return 'This device is in the unassigned pool: adopt it into a customer first (Devices → Unassigned).';
  if ((need.kind === 'diagnostic' || need.kind === 'terminal' || need.kind === 'files') && f.agentBound === false) return 'This device has never authenticated with a device secret, so it cannot be asked to run anything. Re-run the installer on it once.';
  return null;
}

function notPermitted(f: ToolFacts, need: Need): string | null {
  if (need.kind === 'later') return null;
  if (!f.perms.view) return 'Your role does not include viewing this device’s details.';
  if ('eventLogs' in need && need.eventLogs && !f.perms.eventLogs) return 'Needs the “Read event logs” permission.';
  // 0.76: the diagnostics catalog says whether this person holds the key's capability.
  if (need.kind === 'diagnostic' && f.diagAllowed && f.diagAllowed[need.key] === false) {
    return need.connect ? 'Needs the “Remote connect” permission: this check makes the device reach a host you name.' : need.eventLogs ? 'Needs the “Read event logs” permission.' : 'Your role does not allow this check.';
  }
  if (need.kind === 'terminal' && !f.perms.terminal) return 'Only a Platform Admin can open a terminal: it runs as SYSTEM, with full control of the device.';
  if (need.kind === 'files' && !(need.dir === 'upload' ? f.perms.filesUpload : f.perms.filesDownload)) {
    return `Only a Platform Admin can ${need.dir === 'upload' ? 'send files to' : 'fetch files from'} a device: the agent reads and writes as SYSTEM.`;
  }
  if (need.kind === 'action') {
    const risk = f.actionRisk[need.action] ?? 'high';
    if (!(risk === 'low' ? f.perms.requestLow : f.perms.requestHigh)) {
      return risk === 'high' ? 'Your role does not include requesting higher-risk actions on this device.' : 'Your role does not include requesting actions on this device.';
    }
  }
  return null;
}

function newerAgent(f: ToolFacts, need: Need): string | null {
  if (need.kind === 'terminal' || need.kind === 'files') {
    if (f.agentKind !== 'signed') return 'Needs the full (signed) agent; this device runs the standard agent. Upgrade it from the Agent card.';
    const c = f.agentVersion ? compareVersions(f.agentVersion, need.minAgent) : null;
    if (c === null || c < 0) return `Needs the signed agent ${need.minAgent} or later${f.agentVersion ? ` (this device reports ${f.agentVersion})` : ''}. Let it update first.`;
    return null;
  }
  if (need.kind === 'action') {
    if (f.agentKind !== 'signed') return 'Needs the full (signed) agent; this device runs the standard agent. Upgrade it from the Agent card.';
    if (!f.agentActions.includes(`${need.action}@${need.version}`)) return 'This device’s agent does not report support for this action yet. Let it update first.';
    return null;
  }
  if (need.kind === 'diagnostic' && f.diagNeedsNewer?.[need.key]) {
    return `This device’s agent${f.agentVersion ? ` (${f.agentVersion})` : ''} is older than ${need.minAgent ?? 'the release that added this check'}. Update the agent; a signed agent gets it with the next signed release.`;
  }
  if ((need.kind === 'view' || need.kind === 'diagnostic') && 'minAgent' in need && need.minAgent && f.agentVersion) {
    const c = compareVersions(f.agentVersion, need.minAgent);
    if (c !== null && c < 0) return `This device’s agent (${f.agentVersion}) is older than ${need.minAgent}, which first collected this. Reinstall or update the agent.`;
  }
  return null;
}

export const PAUSE_LABEL: Record<string, string> = {
  actions: 'approved actions', remote: 'remote connections and chat', updates: 'agent updates', integration: 'ClientSt0r jobs', notifications: 'notifications',
};

/** The one decision, for one tool. */
export function toolState(def: ToolDef, f: ToolFacts): { state: ToolState; reason: string } {
  const need = def.need;
  if (need.kind === 'later') return { state: 'coming_later', reason: def.description };
  const u = unsupported(f, need);
  if (u) return { state: 'unsupported', reason: u };
  const i = inactive(f, need);
  if (i) return { state: 'inactive', reason: i };
  const p = notPermitted(f, need);
  if (p) return { state: 'not_permitted', reason: p };
  if (need.kind === 'action') {
    if (f.signer.configured === null) return { state: 'checking', reason: 'Reading the action catalog…' };
    if (!f.signer.configured) return { state: 'not_configured', reason: 'No approval signer is configured on this server, so no action can be approved.' };
  }
  const n = newerAgent(f, need);
  if (n) return { state: 'needs_newer_agent', reason: n };
  if (need.kind === 'action' && f.paused.includes('actions')) {
    return { state: 'contained', reason: 'Approved actions are paused by containment for this customer (Security → Containment).' };
  }
  if (need.kind === 'terminal' && f.paused.includes('remote')) {
    return { state: 'contained', reason: 'Remote connections and chat are paused by containment for this customer, and a terminal is one of them.' };
  }
  if (need.kind === 'files' && f.paused.includes('remote')) {
    return { state: 'contained', reason: 'Remote connections and chat are paused by containment for this customer, and file transfer is one of them.' };
  }
  const reachesAgent = need.kind !== 'server' && need.kind !== 'status';
  if (reachesAgent && f.connectivity !== 'online') {
    return {
      state: 'offline',
      reason: need.kind === 'view'
        ? `${f.connectivityText}: what is shown is from its last report.`
        : need.kind === 'diagnostic'
          ? `${f.connectivityText}: the request waits fifteen minutes for its next check-in, then expires.`
          : need.kind === 'terminal'
            ? `${f.connectivityText}: a terminal can only be opened on a device that is reporting.`
            : need.kind === 'files'
              ? `${f.connectivityText}: a file can only be transferred with a device that is reporting.`
            : `${f.connectivityText}: the request waits for its next check-in.`,
    };
  }
  if (need.kind === 'terminal') {
    return { state: 'available', reason: 'Asks you to confirm it is you (unless that is turned off), then starts at the device’s next check-in — up to about three minutes.' };
  }
  if (need.kind === 'files') {
    return { state: 'available', reason: 'Starts at the device’s next check-in — up to about three minutes — with a reason in the audit log.' };
  }
  if (need.kind === 'action') {
    if (f.signer.approval === 'direct') return { state: 'available', reason: 'Direct mode: signed when you request it, after a fresh sign-in, and run at its next check-in.' };
    return { state: 'needs_approval', reason: 'Two approvers authorize it on the approval page before the device runs it.' };
  }
  if (def.id === 'restart-pending') {
    return {
      state: 'available',
      reason: f.restartPending === true ? 'Yes — the last scan says a restart is pending.'
        : f.restartPending === false ? 'No — the last scan says no restart is pending.'
          : 'Unknown — no scan has answered yet. Check for updates asks for one.',
    };
  }
  return { state: 'available', reason: need.kind === 'server' ? 'Runs on the server; nothing is sent to the device.' : need.kind === 'diagnostic' ? 'No approval needed; recorded in the audit log.' : 'Ready.' };
}

export function deviceTools(endpointId: string, f: ToolFacts): ToolView[] {
  return toolCatalog(endpointId).map((d) => ({ ...d, ...toolState(d, f), note: toolNote(d, f) }));
}

/** The tools of one group, in catalog order. */
export const toolsIn = (tools: ToolView[], g: ToolGroup) => tools.filter((t) => t.group === g);

// ── Who may request an approved action (mirrors AccessPolicyService) ────────

export interface ToolUser {
  isPlatformAdmin: boolean;
  /** /auth/me capabilities. */
  capabilities: string[];
  roleType: string | null;
  technician?: {
    sources: unknown[];
  } | null;
}

type Source = { capabilities?: unknown; endpointIds?: unknown; presetId?: unknown; presetPolicy?: { fixRequests?: unknown; standardWorkstationsOnly?: unknown } | null };

const OWNER_ROLES = ['BUSINESS_OWNER', 'TENANT_OWNER', 'TENANT_ADMIN'];

/**
 * Whether this person may request a catalog action of this risk on this
 * computer: AccessPolicyService.evaluateActionAccess, as far as /auth/me
 * shows it. A Platform Admin; a member with actions:request or an owner
 * role; a technician whose grant covering this computer is a custom one with
 * actions:request, or a preset whose fix-request level covers the risk. The
 * server also checks protected device classes and identity pauses, which the
 * console cannot see, and says why when it refuses.
 */
export function mayRequestActions(u: ToolUser | null | undefined, endpointId: string, deviceClass: string, risk: 'low' | 'high'): boolean {
  if (!u) return false;
  if (!u.technician) {
    if (u.isPlatformAdmin) return true;
    return u.capabilities.includes('actions:request') || (!!u.roleType && OWNER_ROLES.includes(u.roleType));
  }
  const cover = (u.technician.sources as Source[]).filter((s) => s && (s.endpointIds == null || (Array.isArray(s.endpointIds) && s.endpointIds.includes(endpointId))));
  if (cover.some((s) => !s.presetId && Array.isArray(s.capabilities) && s.capabilities.includes('actions:request'))) return true;
  return cover.some((s) => {
    const p = s.presetPolicy;
    if (!p) return false;
    const ok = p.fixRequests === 'higher_risk' || (risk === 'low' && p.fixRequests === 'low_risk');
    return ok && (!p.standardWorkstationsOnly || deviceClass === 'WORKSTATION');
  });
}
