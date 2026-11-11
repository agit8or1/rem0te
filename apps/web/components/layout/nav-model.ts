/**
 * The navigation, in one place (0.31).
 *
 * The sidebar used to list about thirty routes flat, mixing a person's own
 * computers, daily technician work and platform administration. Now it lists
 * the jobs: Dashboard, Devices, Alerts, Automation, Patching, Remote Support,
 * Reports, and a
 * Settings group that holds the administration. Pages that belong to one job
 * (all devices, add a device, unassigned…) are tabs of that job, drawn by
 * <SectionTabs> from the same model, so the sidebar and the tabs can never
 * disagree about where a page lives.
 *
 * Every entry still declares who may see it. Hiding an entry is a convenience,
 * never the control: each route and API call checks permissions itself.
 *
 * Automation joined with the script library (0.32): write, version and review
 * scripts. It cannot run them yet, and its page says so. Reports joined in 0.32; each report
 * shows only for the capability of the data it summarises (computers:view or
 * monitoring:alerts), the same rule the API applies.
 */
import type { LucideIcon } from 'lucide-react';
import {
  Activity, BarChart3, BellRing, Building2, Cpu, WifiOff, Download, FileCode2, FileText, HardDriveDownload, Inbox, KeyRound, LayoutDashboard, LayoutGrid,
  Monitor, MonitorCheck, MonitorX, PackageCheck, PlayCircle, RefreshCw, Settings, Shield, ShieldCheck, Siren,
  UserCheck, UserCog, UserMinus, Users, Zap, Headset, Cog, CalendarClock,
} from 'lucide-react';
import { CAP, type Capability } from '@/lib/auth';

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

export type NavLeaf = {
  href: string;
  label: string;
  icon: LucideIcon;
  show: (c: NavCtx) => boolean;
};

export type NavSection = {
  id: string;
  label: string;
  icon: LucideIcon;
  /**
   * `link`: one destination. `hub`: several pages shown as tabs, the sidebar
   * opens the first one this person may see. `group`: a collapsible list in
   * the sidebar (Settings).
   */
  kind: 'link' | 'hub' | 'group';
  items: NavLeaf[];
  /** Routes that belong here without being an entry (detail pages, landings). */
  also?: string[];
};

const all = () => true;

export const NAV: NavSection[] = [
  {
    id: 'dashboard', label: 'Dashboard', icon: LayoutDashboard, kind: 'link',
    items: [{ href: '/dashboard', label: 'Dashboard', icon: LayoutDashboard, show: all }],
  },
  {
    id: 'devices', label: 'Devices', icon: MonitorCheck, kind: 'hub',
    items: [
      { href: '/endpoints', label: 'All devices', icon: MonitorCheck, show: (c) => c.can(CAP.COMPUTERS_VIEW) },
      { href: '/my-computers', label: 'My devices', icon: Monitor, show: all },
      { href: '/technician', label: 'All assigned', icon: LayoutGrid, show: (c) => c.hasAssignments },
      { href: '/endpoints/enroll', label: 'Add device', icon: Download, show: (c) => c.can(CAP.COMPUTERS_ADD) },
      { href: '/admin/unassigned', label: 'Unassigned', icon: MonitorX, show: (c) => c.isPlatformAdmin },
    ],
    also: ['/endpoints/new', '/trmm', '/quickstart'],
  },
  {
    id: 'alerts', label: 'Alerts', icon: Siren, kind: 'link',
    items: [{ href: '/alerts', label: 'Alerts', icon: Siren, show: (c) => c.can(CAP.ALERTS_VIEW) }],
  },
  {
    id: 'automation', label: 'Automation', icon: FileCode2, kind: 'link',
    items: [{
      href: '/automation/scripts', label: 'Script library', icon: FileCode2,
      show: (c) => c.can(CAP.SCRIPTS_AUTHOR) || c.can(CAP.SCRIPTS_REVIEW) || c.isIndependentReviewer,
    }],
  },
  {
    id: 'patching', label: 'Patching', icon: ShieldCheck, kind: 'link',
    items: [{ href: '/patching', label: 'Patching', icon: ShieldCheck, show: (c) => c.can(CAP.COMPUTERS_VIEW) }],
  },
  {
    id: 'remote', label: 'Remote Support', icon: Headset, kind: 'hub',
    items: [
      { href: '/sessions', label: 'Sessions', icon: PlayCircle, show: (c) => c.can(CAP.SESSIONS_VIEW) },
      { href: '/quick-connect', label: 'Quick Connect', icon: Zap, show: (c) => c.can(CAP.QUICK_CONNECT) },
      { href: '/support-requests', label: 'Support requests', icon: Inbox, show: (c) => c.can(CAP.SUPPORT_REQUESTS) },
      // The RustDesk client for the technician's own machine: Connect uses it.
      { href: '/downloads', label: 'Technician client', icon: HardDriveDownload, show: all },
    ],
  },
  {
    id: 'reports', label: 'Reports', icon: BarChart3, kind: 'hub',
    items: [
      { href: '/reports/patch-compliance', label: 'Patch compliance', icon: ShieldCheck, show: (c) => c.can(CAP.COMPUTERS_VIEW) },
      { href: '/reports/agent-coverage', label: 'Agent coverage', icon: Cpu, show: (c) => c.can(CAP.COMPUTERS_VIEW) },
      { href: '/reports/alert-frequency', label: 'Alert frequency', icon: BellRing, show: (c) => c.can(CAP.ALERTS_VIEW) },
      { href: '/reports/offline-time', label: 'Offline time', icon: WifiOff, show: (c) => c.can(CAP.ALERTS_VIEW) },
    ],
    also: ['/reports'],
  },
  {
    id: 'settings', label: 'Settings', icon: Settings, kind: 'group',
    items: [
      // A Business Owner configures their business; the operator the platform.
      { href: '/settings', label: 'Configuration', icon: Cog, show: (c) => c.isBusinessOwner },
      { href: '/users', label: 'Users', icon: Users, show: (c) => c.can(CAP.USERS_VIEW) },
      // An owner's job in their own business, never through an assignment.
      { href: '/offboarding', label: 'Offboarding', icon: UserMinus, show: (c) => c.isBusinessOwner && !c.technician },
      { href: '/technician-approvals', label: 'Technician approvals', icon: UserCheck, show: (c) => c.isBusinessOwner && !c.technician },
      { href: '/audit', label: 'Audit log', icon: FileText, show: (c) => c.can(CAP.AUDIT_VIEW) },
      { href: '/businesses', label: 'Businesses', icon: Building2, show: (c) => c.isPlatformAdmin },
      { href: '/admin/technicians', label: 'Technicians', icon: UserCog, show: (c) => c.canManageTechnicians },
      { href: '/admin/access', label: 'Access control', icon: ShieldCheck, show: (c) => c.isPlatformAdmin },
      { href: '/admin/sso', label: 'Single sign-on', icon: KeyRound, show: (c) => c.isPlatformAdmin },
      // 0.32: who may change it is decided by the API (owner, a whole-business
      // technician with computers:edit, the MSP); this only decides who sees the entry.
      { href: '/settings/client-updates', label: 'Client updates', icon: CalendarClock, show: (c) => c.isBusinessOwner || c.canManageTechnicians || (c.technician && c.can(CAP.COMPUTERS_EDIT)) },
      { href: '/admin/rollouts', label: 'Client rollouts', icon: PackageCheck, show: (c) => c.isPlatformAdmin },
      { href: '/admin/security', label: 'Security', icon: Shield, show: (c) => c.isPlatformAdmin },
      { href: '/admin/status', label: 'System status', icon: Activity, show: (c) => c.isPlatformAdmin },
      { href: '/about', label: 'Updates', icon: RefreshCw, show: (c) => c.isPlatformAdmin },
    ],
  },
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
