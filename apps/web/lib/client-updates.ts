/**
 * Scheduled RustDesk client updates (0.32): the labels the pages share. The
 * reasons themselves are decided by the API (client-updates/policy.ts); these
 * only put them into words, so the Updates page, the device page and
 * Settings → Client updates say the same thing.
 */
export const HOLD_LABEL: Record<string, string> = {
  policy_off: 'the update policy that queued it is now off',
  outside_window: 'outside the update window',
  session_open: 'a remote session is open',
  user_logged_on: 'someone is logged on',
  user_unknown: 'its agent does not report who is logged on',
};

export const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;

export type WindowSpec = { days: number[]; start: string; end: string };

export type PolicyView = {
  id: string;
  siteId: string | null;
  /** 0.35: a device group's policy, with its priority (1 first). */
  groupId?: string | null;
  priority?: number | null;
  enabled: boolean;
  timeZone: string;
  windows: WindowSpec[];
  skipActiveSession: boolean;
  skipLoggedOnUser: boolean;
  description: string | null;
  valid: boolean;
  window: { open: boolean; opensAt: string | null; closesAt: string | null };
  updatedAt: string;
  updatedById: string | null;
};

export type PolicyPayload = {
  business: { id: string; name: string };
  policy: PolicyView | null;
  sites: { id: string; name: string; timezone: string | null; override: PolicyView | null }[];
  /** 0.35: every device group of the business, in precedence order; members counted over what the reader sees. */
  groups: { id: string; name: string; kind: 'static' | 'rule'; policy: PolicyView | null; members: number | null; use: 'ok' | 'unreadable' | 'reads_alerts' | null }[];
  precedence: string;
  target: { version: string | null; pinned: boolean };
  containment: { paused: boolean; scope?: string; reason?: string };
  may: { edit: boolean; reason: string | null };
  sweep: { enabled: boolean };
  now: string;
};

export type ComputerRow = {
  id: string;
  name: string;
  site: { id: string; name: string } | null;
  platform: string | null;
  isOnline: boolean;
  lastSeenAt: string | null;
  version: string | null;
  policy: {
    id: string; scope: 'business' | 'site' | 'group'; enabled: boolean; window: { open: boolean; opensAt: string | null; closesAt: string | null };
    /** 0.35 */
    group: { id: string; name: string; priority: number | null } | null;
    why: string;
    alsoIn: { id: string; name: string; priority: number | null }[];
  } | null;
  state: 'current' | 'blocked' | 'manual_only' | 'eligible' | 'queued_manual' | 'queued_auto' | 'queued_auto_waiting';
  text: string;
  blocker?: { code: string; permanent: boolean };
  queued?: {
    at: string; targetVersion: string | null; source: 'manual' | 'policy';
    by: { id: string; name: string } | null;
    hold: { reason: string; text: string; since: string | null } | null;
  };
};

/** The browser's own zone, as a starting suggestion for a new policy. */
export function browserTimeZone(): string {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; } catch { return 'UTC'; }
}

/** Every IANA zone the browser knows, when it can list them. */
export function knownTimeZones(): string[] {
  try {
    const f = (Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf;
    return f ? f('timeZone') : [];
  } catch { return []; }
}

/** GET /client-updates/computers/:id/policy (0.35): the device page's "effective policy". */
export type EndpointPolicy = {
  policy: (PolicyView & { scope: 'business' | 'site' | 'group'; group?: { id: string; name: string }; site?: { id: string; name: string } | null }) | null;
  considered: { id: string; scope: 'business' | 'site' | 'group'; group?: { id: string; name: string }; site?: { id: string; name: string } | null; priority: number | null; enabled: boolean; outcome: 'won' | 'more_specific' | 'priority' | 'tie_id' }[];
  text: string;
};
