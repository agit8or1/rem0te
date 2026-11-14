/** Badge variants for a patch deployment's status (v0.27). */
export const DEPLOYMENT_STATUS: Record<string, 'success' | 'warning' | 'outline' | 'secondary'> = {
  ACTIVE: 'secondary', PAUSED: 'warning', COMPLETED: 'success', CANCELED: 'outline',
};

/** Badge variants for a patch policy's status (0.32). */
export const POLICY_STATUS: Record<string, 'success' | 'warning' | 'outline' | 'secondary' | 'destructive'> = {
  AWAITING_APPROVAL: 'warning', ACTIVE: 'success', REJECTED: 'destructive', REVOKED: 'outline', EXPIRED: 'outline',
};

/** The classes a plan may install, as Windows Update names them (apps/api/src/patching/posture.ts). */
export const CLASS_NAMES: Record<string, string> = {
  '0fa1201d-4330-4fa8-8ae9-b877473b6441': 'Security Updates',
  'e6cf1350-c01b-414d-a61f-263d14d133b4': 'Critical Updates',
  '28bc880e-0592-4cbf-8f95-c79b17911d5f': 'Update Rollups',
  'cd5ffd1e-e932-4e3a-bf74-18bf0b1bbd83': 'Updates',
  // 0.42. Never ticked by default: a policy installs drivers only if someone chose to.
  'ebfc1fc5-71a4-4f7b-9aca-3b9a503104a0': 'Drivers',
  'e0789628-ce08-4437-be74-2495b842f43b': 'Definition Updates',
};
/** Classes a new policy starts with (Security Updates only); drivers are never pre-selected. */
export const DEFAULT_POLICY_CLASSES = ['0fa1201d-4330-4fa8-8ae9-b877473b6441'];
export const DRIVERS_CLASS = 'ebfc1fc5-71a4-4f7b-9aca-3b9a503104a0';

export const SEVERITIES = ['Critical', 'Important', 'Moderate', 'Low', 'Unrated'] as const;

export const WEEKDAYS = [
  { id: 'mon', label: 'Mon' }, { id: 'tue', label: 'Tue' }, { id: 'wed', label: 'Wed' }, { id: 'thu', label: 'Thu' },
  { id: 'fri', label: 'Fri' }, { id: 'sat', label: 'Sat' }, { id: 'sun', label: 'Sun' },
] as const;

export function describeWindow(w: { days: string[]; start: string; end: string; timezone: string }) {
  const days = w.days.length === 7 ? 'every day' : WEEKDAYS.filter((d) => w.days.includes(d.id)).map((d) => d.label).join(', ');
  return `${days} ${w.start}–${w.end}${w.end <= w.start ? ' (next day)' : ''} ${w.timezone}`;
}
