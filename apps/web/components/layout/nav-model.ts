/**
 * The navigation, in one place (0.31; regrouped in 0.87 Compass).
 *
 * 0.87 replaced the eight jobs plus a twenty-item Settings group with nine
 * groups (docs/NAVIGATION_ARCHITECTURE.md; every old entry's new place is in
 * docs/NAVIGATION_MIGRATION.md): Dashboard, Devices, Remote support,
 * Monitoring, Patching, Automation, Reports, Security and Administration.
 * Customers moved out of Settings into Devices; "Security" is one group
 * instead of three places. No route changed: every page keeps its URL.
 *
 * Each entry declares:
 *
 *   show   who may see it. Hiding an entry is a convenience, never the
 *          control: each route and API call checks permissions itself.
 *   tier   'standard' entries are drawn in the sidebar in both modes;
 *          'advanced' ones only in Advanced mode. Standard never makes a
 *          page unreachable: an advanced entry is always also a tab of its
 *          hub (drawn above the hub's pages, from this same model), and it is
 *          always in the Ctrl+K palette's Pages. unit-nav-model.mjs checks
 *          both for every entry.
 *   hub    entries sharing a hub are drawn as tabs of each other's pages
 *          (<SectionTabs>), so the sidebar and the tabs can never disagree
 *          about where a page lives.
 *
 * 0.64's "Add device" link under Devices is now an ordinary Devices entry
 * (it keeps its test id).
 */
import type { LucideIcon } from 'lucide-react';
import {
  Activity, AppWindow, Archive, ArrowRightLeft, BadgeCheck, BarChart3, BellRing, BookMarked, Building2, CalendarClock, CalendarRange, ClipboardCheck, Cog,
  Cpu, Fingerprint, FileCode2, FileText, Gauge, HardDriveDownload, Headset, Inbox, KeyRound, LayoutDashboard, LayoutGrid, ListChecks, Lock, Mail,
  Monitor, MonitorCheck, MonitorPlay, MonitorX, Package, PackageCheck, Palette, PlayCircle, Plus, RefreshCw, ScrollText, Server, Settings, Shield,
  ShieldAlert, ShieldCheck, ShieldHalf, ShieldQuestion, Siren, SlidersHorizontal, Smartphone, Sparkles, Ticket, TimerReset, UserCheck, UserCog, UserMinus, Users,
  WifiOff, Workflow, Wrench, Zap, PenLine, Download,
} from 'lucide-react';
import { CAP, type Capability } from '@/lib/auth';
import { inWorkspace, workspaceOf } from '@/lib/workspace-modes';

export type NavCtx = {
  can: (cap: Capability) => boolean;
  isPlatformAdmin: boolean;
  isBusinessOwner: boolean;
  /** Reached through a technician assignment rather than membership. */
  technician: boolean;
  hasAssignments: boolean;
  canManageTechnicians: boolean;
  /** Platform Admin or `approvals:review`: reviews global scripts. */
  isIndependentReviewer: boolean;
};

export type NavTier = 'standard' | 'advanced';

export type NavLeaf = {
  href: string;
  label: string;
  icon: LucideIcon;
  show: (c: NavCtx) => boolean;
  tier: NavTier;
  /** Entries with the same hub are tabs of each other's pages. */
  hub?: string;
  /** Extra words the palette's Pages group matches on. */
  keywords?: string;
  /** A stable test id, kept from before 0.87 where one existed. */
  testId?: string;
};

export type NavSection = {
  /** Stable: stored in a person's pinned groups (navigation/model.ts GROUP_IDS, 0104's CHECK). */
  id: string;
  label: string;
  icon: LucideIcon;
  /** `link`: one destination, drawn as a row. `group`: a collapsible list. */
  kind: 'link' | 'group';
  items: NavLeaf[];
  /** Routes that belong here without being an entry (detail pages, landings). */
  also?: string[];
};

const all = () => true;
const S: NavTier = 'standard';
const A: NavTier = 'advanced';


export const NAV: NavSection[] = [
  {
    id: 'dashboard', label: 'Dashboard', icon: LayoutDashboard, kind: 'link',
    items: [{ href: '/dashboard', label: 'Dashboard', icon: LayoutDashboard, show: all, tier: S, keywords: 'home overview start' }],
  },
  {
    id: 'devices', label: 'Devices', icon: MonitorCheck, kind: 'group',
    items: [
      { href: '/endpoints', label: 'All devices', icon: MonitorCheck, show: (c) => c.can(CAP.COMPUTERS_VIEW), tier: S, hub: 'devices', keywords: 'computers endpoints inventory list' },
      { href: '/my-computers', label: 'My devices', icon: Monitor, show: all, tier: S, hub: 'devices', keywords: 'my computers' },
      { href: '/technician', label: 'All assigned', icon: LayoutGrid, show: (c) => c.hasAssignments, tier: S, hub: 'devices', keywords: 'technician assignments' },
      // Customers left Settings in 0.87 (owner decision 4). The pages still say "Business" in places (P1-1).
      { href: '/businesses', label: 'Customers', icon: Building2, show: (c) => c.isPlatformAdmin, tier: S, keywords: 'businesses organizations clients companies sites' },
      { href: '/endpoints/enroll', label: 'Add device', icon: Plus, show: (c) => c.can(CAP.COMPUTERS_ADD), tier: S, hub: 'devices', keywords: 'enroll install agent new computer', testId: 'nav-shortcut-devices' },
      { href: '/mobile-devices', label: 'Mobile devices', icon: Smartphone, show: (c) => c.can(CAP.MOBILE_VIEW), tier: S, hub: 'devices', keywords: 'mdm phones tablets ios android' },
      { href: '/admin/unassigned', label: 'Unassigned', icon: MonitorX, show: (c) => c.isPlatformAdmin, tier: A, hub: 'devices', keywords: 'discovery pool adopt' },
      { href: '/admin/deploy', label: 'Deploy agents', icon: HardDriveDownload, show: (c) => c.isPlatformAdmin, tier: A, hub: 'devices', keywords: 'deployment keys gpo intune rmm rollout' },
      { href: '/endpoints/full-agent', label: 'Full agent', icon: BadgeCheck, show: (c) => c.can(CAP.COMPUTERS_VIEW), tier: A, hub: 'devices', keywords: 'signed agent' },
      { href: '/endpoints/agent-migrations', label: 'Agent migrations', icon: ArrowRightLeft, show: (c) => c.can(CAP.COMPUTERS_EDIT), tier: A, hub: 'devices', keywords: 'signed agent upgrade' },
    ],
    also: ['/endpoints/new', '/trmm', '/quickstart'],
  },
  {
    id: 'remote', label: 'Remote support', icon: Headset, kind: 'group',
    items: [
      { href: '/sessions', label: 'Sessions', icon: PlayCircle, show: (c) => c.can(CAP.SESSIONS_VIEW), tier: S, hub: 'remote', keywords: 'remote control rustdesk history' },
      { href: '/quick-connect', label: 'Quick Connect', icon: Zap, show: (c) => c.can(CAP.QUICK_CONNECT), tier: S, hub: 'remote', keywords: 'ad hoc support code' },
      { href: '/support-requests', label: 'Support requests', icon: Inbox, show: (c) => c.can(CAP.SUPPORT_REQUESTS), tier: S, hub: 'remote', keywords: 'help requests queue' },
      // Moved from Devices in 0.87: both are about remote access.
      { href: '/endpoints/managed-sessions', label: 'Managed sessions', icon: MonitorPlay, show: (c) => c.can(CAP.COMPUTERS_VIEW), tier: A, hub: 'remote', keywords: 'managed secure access msa' },
      { href: '/endpoints/remote-readiness', label: 'Remote access readiness', icon: ShieldQuestion, show: (c) => c.can(CAP.COMPUTERS_VIEW), tier: A, hub: 'remote', keywords: 'managed secure access msa preflight' },
      // The RustDesk client for the technician's own machine: Connect uses it.
      { href: '/downloads', label: 'Technician client', icon: Download, show: all, tier: A, hub: 'remote', keywords: 'rustdesk client download' },
    ],
  },
  {
    id: 'monitoring', label: 'Monitoring', icon: Activity, kind: 'group',
    items: [
      { href: '/alerts', label: 'Alerts', icon: Siren, show: (c) => c.can(CAP.ALERTS_VIEW), tier: S, hub: 'alerts', keywords: 'alarms issues critical warnings' },
      { href: '/alerts/quality', label: 'False positives & rules', icon: ClipboardCheck, show: (c) => c.can(CAP.ALERTS_VIEW), tier: A, hub: 'alerts', keywords: 'alert quality noise suppress' },
      // Was reached only from a Settings tab before 0.87.
      { href: '/settings/monitoring', label: 'Monitoring policies', icon: SlidersHorizontal, show: (c) => c.isBusinessOwner || c.canManageTechnicians, tier: S, keywords: 'monitors notifications escalation maintenance windows thresholds' },
      { href: '/backups', label: 'Backups', icon: Archive, show: (c) => c.can(CAP.BACKUPS_VIEW), tier: S, keywords: 'backup rpo rto restore drills' },
    ],
  },
  {
    id: 'patching', label: 'Patching', icon: ShieldCheck, kind: 'group',
    items: [
      { href: '/patching', label: 'Patch management', icon: ShieldCheck, show: (c) => c.can(CAP.COMPUTERS_VIEW), tier: S, hub: 'patching', keywords: 'windows updates policies deployments' },
      { href: '/settings/client-updates', label: 'Client updates', icon: CalendarClock, show: (c) => c.isBusinessOwner || c.canManageTechnicians || (c.technician && c.can(CAP.COMPUTERS_EDIT)), tier: A, hub: 'patching', keywords: 'rustdesk agent update windows' },
      { href: '/admin/rollouts', label: 'Client rollouts', icon: PackageCheck, show: (c) => c.isPlatformAdmin, tier: A, hub: 'patching', keywords: 'staged rollout rustdesk' },
    ],
  },
  {
    id: 'automation', label: 'Automation', icon: Workflow, kind: 'group',
    items: [
      { href: '/automation/scripts', label: 'Script library', icon: FileCode2, show: (c) => c.can(CAP.SCRIPTS_AUTHOR) || c.can(CAP.SCRIPTS_REVIEW) || c.isIndependentReviewer, tier: S, hub: 'automation', keywords: 'powershell scripts' },
      { href: '/automation/software', label: 'Software catalog', icon: Package, show: (c) => c.can(CAP.COMPUTERS_VIEW), tier: S, hub: 'automation', keywords: 'winget install deploy' },
      { href: '/automation/tasks', label: 'Tasks', icon: ListChecks, show: (c) => c.can(CAP.COMPUTERS_VIEW), tier: S, hub: 'automation', keywords: 'jobs queue progress history' },
      { href: '/automation/schedules', label: 'Schedules', icon: CalendarRange, show: (c) => c.can(CAP.COMPUTERS_VIEW), tier: S, hub: 'automation', keywords: 'automation policies recurring' },
    ],
  },
  {
    id: 'reports', label: 'Reports', icon: BarChart3, kind: 'group',
    items: [
      { href: '/reports/patch-compliance', label: 'Patch compliance', icon: ShieldHalf, show: (c) => c.can(CAP.COMPUTERS_VIEW), tier: S, hub: 'reports', keywords: 'report' },
      { href: '/reports/agent-coverage', label: 'Agent coverage', icon: Cpu, show: (c) => c.can(CAP.COMPUTERS_VIEW), tier: S, hub: 'reports', keywords: 'report' },
      { href: '/reports/alert-frequency', label: 'Alert frequency', icon: BellRing, show: (c) => c.can(CAP.ALERTS_VIEW), tier: S, hub: 'reports', keywords: 'report' },
      { href: '/reports/offline-time', label: 'Offline time', icon: WifiOff, show: (c) => c.can(CAP.ALERTS_VIEW), tier: A, hub: 'reports', keywords: 'report availability' },
      { href: '/reports/software-compliance', label: 'Software compliance', icon: PackageCheck, show: (c) => c.can(CAP.COMPUTERS_VIEW), tier: A, hub: 'reports', keywords: 'report' },
      { href: '/reports/warranty', label: 'Warranty', icon: TimerReset, show: (c) => c.can(CAP.COMPUTERS_VIEW), tier: A, hub: 'reports', keywords: 'report hardware' },
      // The API decides who may set one up (a Business Owner in their own business, or a Platform Admin).
      { href: '/reports/schedules', label: 'Scheduled reports', icon: Mail, show: (c) => c.isPlatformAdmin || (c.isBusinessOwner && !c.technician), tier: A, hub: 'reports', keywords: 'email report schedule' },
    ],
    also: ['/reports'],
  },
  {
    id: 'security', label: 'Security', icon: Shield, kind: 'group',
    items: [
      { href: '/settings/security/containment', label: 'Containment', icon: ShieldAlert, show: (c) => c.isBusinessOwner || c.canManageTechnicians, tier: S, hub: 'security', keywords: 'pause incident stop' },
      { href: '/audit', label: 'Audit log', icon: ScrollText, show: (c) => c.can(CAP.AUDIT_VIEW), tier: S, hub: 'security', keywords: 'activity history events log' },
      // F-13: "Security" was three places; this one is the host.
      { href: '/admin/security', label: 'Server security', icon: Server, show: (c) => c.isPlatformAdmin, tier: S, hub: 'security', keywords: 'host firewall fail2ban ssh tls' },
      { href: '/admin/access', label: 'Access control', icon: Lock, show: (c) => c.isPlatformAdmin, tier: A, hub: 'security', keywords: 'roles permissions presets' },
      { href: '/admin/sso', label: 'Single sign-on', icon: KeyRound, show: (c) => c.isPlatformAdmin, tier: A, hub: 'security', keywords: 'sso keycloak oidc identity' },
      { href: '/settings/security/features', label: 'Security features', icon: Fingerprint, show: (c) => !c.technician && (c.isPlatformAdmin || c.canManageTechnicians || c.isBusinessOwner), tier: A, hub: 'security', keywords: 'mfa passkeys protections' },
      { href: '/settings/security/technician-access', label: 'Technician access', icon: UserCheck, show: (c) => c.isIndependentReviewer, tier: A, hub: 'security', keywords: 'reviews grants' },
      { href: '/settings/security/update-signing', label: 'Update signing', icon: PenLine, show: (c) => c.isPlatformAdmin, tier: A, hub: 'security', keywords: 'signed releases trust' },
    ],
  },
  {
    id: 'admin', label: 'Administration', icon: Settings, kind: 'group',
    items: [
      // A Business Owner configures their business; the operator the platform.
      { href: '/settings', label: 'Settings', icon: Cog, show: (c) => c.isBusinessOwner, tier: S, hub: 'admin', keywords: 'configuration general quick connect rustdesk network confirm' },
      { href: '/users', label: 'Users', icon: Users, show: (c) => c.can(CAP.USERS_VIEW), tier: S, hub: 'admin', keywords: 'people accounts invite' },
      { href: '/admin/technicians', label: 'Technicians', icon: UserCog, show: (c) => c.canManageTechnicians, tier: S, hub: 'admin', keywords: 'msp staff assignments' },
      // An owner's job in their own business, never through an assignment.
      { href: '/technician-approvals', label: 'Technician approvals', icon: UserCheck, show: (c) => c.isBusinessOwner && !c.technician, tier: A, hub: 'admin', keywords: 'approve technicians' },
      { href: '/offboarding', label: 'Offboarding', icon: UserMinus, show: (c) => c.isBusinessOwner && !c.technician, tier: A, hub: 'admin', keywords: 'leaver remove access' },
      { href: '/settings/psa', label: 'PSA / ticketing', icon: Ticket, show: (c) => c.isPlatformAdmin || (c.isBusinessOwner && !c.technician), tier: A, hub: 'admin', keywords: 'integrations tickets clientst0r webhook' },
      { href: '/settings/ai', label: 'AI', icon: Sparkles, show: (c) => c.isPlatformAdmin, tier: A, hub: 'admin', keywords: 'integrations provider' },
      { href: '/settings/email', label: 'Email', icon: Mail, show: (c) => c.isPlatformAdmin, tier: A, hub: 'admin', keywords: 'smtp relay notifications' },
      { href: '/settings/warranty', label: 'Warranty', icon: BadgeCheck, show: (c) => c.isPlatformAdmin, tier: A, hub: 'admin', keywords: 'integrations dell lenovo hp apple' },
      { href: '/settings/backups', label: 'Backup connections', icon: Archive, show: (c) => c.isPlatformAdmin, tier: A, hub: 'admin', keywords: 'integrations st0r comet push' },
      { href: '/settings/mobile-devices', label: 'Mobile device setup', icon: Smartphone, show: (c) => c.isPlatformAdmin, tier: A, hub: 'admin', keywords: 'mdm apple push google android' },
      { href: '/settings/api-keys', label: 'API keys', icon: BookMarked, show: (c) => c.isBusinessOwner, tier: A, hub: 'admin', keywords: 'integrations tokens' },
      { href: '/settings/branding', label: 'Branding', icon: Palette, show: (c) => c.isBusinessOwner, tier: A, hub: 'admin', keywords: 'logo colour accent' },
      { href: '/admin/status', label: 'System status', icon: Gauge, show: (c) => c.isPlatformAdmin, tier: S, hub: 'admin', keywords: 'health services' },
      { href: '/about', label: 'Updates', icon: RefreshCw, show: (c) => c.isPlatformAdmin, tier: S, hub: 'admin', keywords: 'version about release' },
    ],
  },
];

/** Pages outside the sidebar that the header and the palette still name. */
export const EXTRA_PAGES: NavLeaf[] = [
  { href: '/account', label: 'My account', icon: Users, show: all, tier: S, keywords: 'profile password mfa passkey' },
  { href: '/help', label: 'Help', icon: AppWindow, show: all, tier: S, keywords: 'guide documentation' },
  { href: '/docs', label: 'Documentation', icon: FileText, show: all, tier: S, keywords: 'docs guide' },
  { href: '/about', label: 'About', icon: Wrench, show: (c) => !c.isPlatformAdmin, tier: S, keywords: 'version' },
];


/** Does `path` fall under `href` (the page itself or one below it)? */
export function under(path: string, href: string): boolean {
  return path === href || path.startsWith(`${href}/`);
}

/**
 * Where a route lives: its section and the entry that owns it, chosen by the
 * longest matching href, so /endpoints/enroll is "Add device" and
 * /endpoints/abc is "All devices". Hidden entries still own their routes.
 */
export function locate(path: string): { section: NavSection; leaf: NavLeaf | null } | null {
  let best: { section: NavSection; leaf: NavLeaf | null; len: number } | null = null;
  for (const section of NAV) {
    for (const leaf of section.items) {
      if (under(path, leaf.href) && (!best || leaf.href.length > best.len)) best = { section, leaf, len: leaf.href.length };
    }
    for (const extra of section.also ?? []) {
      if (under(path, extra) && (!best || extra.length > best.len)) best = { section, leaf: null, len: extra.length };
    }
  }
  return best ? { section: best.section, leaf: best.leaf } : null;
}

export function visibleItems(section: NavSection, ctx: NavCtx): NavLeaf[] {
  return section.items.filter((i) => i.show(ctx));
}

/**
 * What the sidebar lists under a group. Standard leaves out advanced entries
 * (still tabs and palette pages). A technician workspace (0.90,
 * lib/workspace-modes.ts) instead lists exactly its own pages, of those this
 * person may see: it never adds an entry `show` hides.
 */
export function sidebarItems(section: NavSection, ctx: NavCtx, mode: 'standard' | 'advanced', workspace: string = 'all'): NavLeaf[] {
  const items = visibleItems(section, ctx);
  if (workspaceOf(workspace).pages) return items.filter((i) => inWorkspace(workspace, i.href));
  return mode === 'advanced' ? items : items.filter((i) => i.tier === 'standard');
}

/** The tabs drawn above a page: its hub's visible entries (only on the entry's own page). */
export function hubTabs(path: string, ctx: NavCtx): { hub: string; label: string; items: NavLeaf[]; current: NavLeaf } | null {
  const here = locate(path);
  if (!here?.leaf?.hub || here.leaf.href !== path) return null;
  const hub = here.leaf.hub;
  const items = here.section.items.filter((i) => i.hub === hub && i.show(ctx));
  if (items.length < 2) return null;
  return { hub, label: here.section.label, items, current: here.leaf };
}

/** Every page this person may open from the menu, for the palette's Pages group. */
export function allPages(ctx: NavCtx): (NavLeaf & { group: string })[] {
  const seen = new Set<string>();
  const out: (NavLeaf & { group: string })[] = [];
  for (const s of NAV) for (const i of s.items) if (i.show(ctx) && !seen.has(i.href)) { seen.add(i.href); out.push({ ...i, group: s.label }); }
  for (const i of EXTRA_PAGES) if (i.show(ctx) && !seen.has(i.href)) { seen.add(i.href); out.push({ ...i, group: 'Account & help' }); }
  return out;
}

/** The label a stored page favourite is shown with, or null for a page the menu does not know. */
export function pageLabel(href: string): { label: string; group: string; icon: LucideIcon } | null {
  for (const s of NAV) for (const i of s.items) if (i.href === href) return { label: i.label, group: s.label, icon: i.icon };
  for (const i of EXTRA_PAGES) if (i.href === href) return { label: i.label, group: 'Account & help', icon: i.icon };
  return null;
}

/** The ids NAV uses, in order: navigation/model.ts GROUP_IDS and 0104's CHECK must agree (§96). */
export const GROUP_IDS = NAV.map((s) => s.id);
