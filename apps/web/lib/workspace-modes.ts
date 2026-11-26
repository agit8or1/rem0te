/**
 * Technician workspaces (0.90, UX P1-4; directive §11 "Simplified technician
 * workspaces").
 *
 * A workspace is a presentation preference: it decides which pages the
 * sidebar puts in front and the order of the device page's tab groups. It
 * never grants or removes anything. A page outside the workspace is still in
 * Ctrl+K, still a tab of its hub, still opens from a link or a typed URL, and
 * every page and route still checks the person's permissions itself; an entry
 * the person may not see (`show` in nav-model.ts) stays hidden in every
 * workspace. Changing workspace changes one stored preference
 * (navigation/model.ts WORKSPACES, 0105's CHECK) and nothing else.
 *
 * Pure: no imports. unit-workspace-modes.mjs checks every href against the
 * menu (nav-model.ts) and every tab group against the device page
 * (device-model.ts), and that the lists match the API's and the migration's.
 */

export type WorkspaceId = 'all' | 'l1' | 'l2' | 'l3';

export interface Workspace {
  id: WorkspaceId;
  label: string;
  /** One sentence for the menu. */
  description: string;
  /** The sidebar's pages, as menu hrefs; null is every page the menu offers. */
  pages: readonly string[] | null;
  /** The device page's tab groups, in order (device-model.ts TabGroup ids); null keeps the page's own order. */
  deviceGroups: readonly string[] | null;
}

/** L1: find the device, see what is wrong, support the person, follow up. */
const L1_PAGES = [
  '/dashboard',
  '/endpoints', '/my-computers', '/technician', '/businesses',
  '/alerts',
  '/sessions', '/quick-connect', '/support-requests', '/downloads',
  '/automation/tasks',
] as const;

/** L2 adds the work that changes a device: patching, software, scripts. */
const L2_PAGES = [
  ...L1_PAGES,
  '/patching',
  '/automation/software', '/automation/scripts',
  '/reports/patch-compliance', '/reports/software-compliance',
] as const;

/** L3 adds the fleet: automation, rings and policies, agents, security configuration. */
const L3_PAGES = [
  ...L2_PAGES,
  '/automation/schedules',
  '/settings/client-updates', '/admin/rollouts',
  '/settings/monitoring', '/alerts/quality', '/backups',
  '/admin/unassigned', '/admin/deploy', '/endpoints/full-agent', '/endpoints/agent-migrations', '/mobile-devices',
  '/endpoints/managed-sessions', '/endpoints/remote-readiness',
  '/settings/security/containment', '/audit', '/admin/security', '/admin/access', '/admin/sso',
  '/settings/security/features', '/settings/security/technician-access', '/settings/security/update-signing',
  '/reports/agent-coverage', '/reports/alert-frequency', '/reports/offline-time',
] as const;

export const WORKSPACES: readonly Workspace[] = [
  {
    id: 'all', label: 'All pages',
    description: 'Every page you can open, in every group.',
    pages: null, deviceGroups: null,
  },
  {
    id: 'l1', label: 'L1 support',
    description: 'Devices, alerts, remote support, support requests and task status.',
    pages: L1_PAGES,
    deviceGroups: ['overview', 'health', 'tools', 'remote', 'history', 'software', 'system'],
  },
  {
    id: 'l2', label: 'L2 support',
    description: 'L1, plus patching, software, scripts, services and processes.',
    pages: L2_PAGES,
    deviceGroups: ['overview', 'health', 'tools', 'system', 'software', 'remote', 'history'],
  },
  {
    id: 'l3', label: 'L3 / administration of the fleet',
    description: 'L2, plus schedules, rollouts, agents, monitoring policies and security configuration.',
    pages: L3_PAGES,
    deviceGroups: ['overview', 'tools', 'system', 'software', 'health', 'remote', 'history'],
  },
];

/** The ids, in order: navigation/model.ts WORKSPACES and 0105's CHECK must agree. */
export const WORKSPACE_IDS = WORKSPACES.map((w) => w.id);

/**
 * Parts of §11 that no page of this console answers on its own, and why.
 * Shown in the menu as text, never approximated by another page.
 */
export const NOT_A_PAGE: readonly { label: string; why: string }[] = [
  { label: 'Escalation', why: 'alerts escalate through the notification steps of a monitoring policy; there is no separate queue' },
  { label: 'Related PSA tickets', why: 'shown on the alert and the device when a PSA is configured; there is no tickets page' },
  { label: 'Read-only diagnostics, services and processes', why: 'these are tabs of each device, put first in the workspace’s order' },
];

export function workspaceOf(id: string | null | undefined): Workspace {
  return WORKSPACES.find((w) => w.id === id) ?? WORKSPACES[0];
}

/** Is this page in the workspace's sidebar? Every page is in "All pages". */
export function inWorkspace(id: string | null | undefined, href: string): boolean {
  const w = workspaceOf(id);
  return w.pages === null || w.pages.includes(href);
}

/** The device page's tab groups in the workspace's order; a group the list leaves out keeps its place at the end. */
export function orderGroups<T extends { id: string }>(id: string | null | undefined, groups: readonly T[]): T[] {
  const order = workspaceOf(id).deviceGroups;
  if (!order) return [...groups];
  const rank = (g: T) => { const i = order.indexOf(g.id); return i === -1 ? order.length : i; };
  return [...groups].sort((a, b) => rank(a) - rank(b));
}
