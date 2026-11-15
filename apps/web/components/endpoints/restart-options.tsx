'use client';

/**
 * 0.54: the options of a restart (windows.reboot.schedule), shared by the
 * Actions tab, the Patches tab's restart banner and the device list's bulk
 * "Schedule restart". The server decides everything again; this only builds
 * the request.
 *
 * - When: after the warning, or at a date and time in a named zone (up to 14
 *   days ahead; the API makes it the signed plan's notBefore).
 * - Only if a restart is required: the agent decides from Windows' own
 *   pending-restart state when the plan runs, and changes nothing otherwise.
 * - The RustDesk exception: never ticked by default. A signed-in user never
 *   stops a restart; only a technician's RustDesk session does, and this
 *   lets the restart go ahead anyway.
 *
 * Both flags are closed, present only when ticked, and need a 0.54 agent: an
 * older agent refuses a plan that carries them (params_not_allowed), so the
 * portal refuses the request first (ENDPOINT_NOT_READY).
 */
import { Label } from '@/components/ui/label';
import { ScheduleChoice, defaultSchedule, type ScheduleValue, type Zones } from '@/components/patching/schedule-choice';

/** The same words as apps/api/src/actions/catalog.ts (§67 checks they agree). */
export const SIGNED_IN_USER_NOTE = 'A signed-in user does not stop the restart. They see the 15-minute warning, and unsaved work is lost.';
export const IGNORE_REMOTE_SESSION_LABEL = 'Restart even if a technician is connected through RustDesk (their session is dropped)';
export const RESTART_DELAYS = [5, 15, 30, 60, 120, 240];

export type RestartValue = { delayMinutes: number; when: ScheduleValue; onlyIfRequired: boolean; ignoreRemoteSession: boolean };

export const defaultRestart = (zones: Zones, delayMinutes = 15): RestartValue =>
  ({ delayMinutes, when: defaultSchedule(zones), onlyIfRequired: false, ignoreRemoteSession: false });

/** The signed params: each flag only when ticked, exactly `true`. */
export function restartParams(v: RestartValue): Record<string, unknown> {
  return { delayMinutes: v.delayMinutes, ...(v.onlyIfRequired ? { onlyIfRequired: true } : {}), ...(v.ignoreRemoteSession ? { ignoreRemoteSession: true } : {}) };
}
export const restartAtBody = (v: RestartValue) => (v.when.mode === 'schedule' ? { restartAt: { local: v.when.local, timeZone: v.when.timeZone } } : {});

const delayLabel = (m: number) => (m < 60 ? `${m} minutes` : m === 60 ? '1 hour' : `${m / 60} hours`);

export function RestartOptions({ id, value, onChange, zones, delays = RESTART_DELAYS, showOnlyIfRequired = true }: {
  id: string; value: RestartValue; onChange: (v: RestartValue) => void; zones: Zones; delays?: number[]; showOnlyIfRequired?: boolean;
}) {
  return (
    <div className="space-y-2 text-xs" data-testid="restart-options">
      <div className="space-y-1">
        <Label htmlFor={`${id}-delay`} className="text-xs">Warning before the restart</Label>
        <select id={`${id}-delay`} value={value.delayMinutes} data-testid="restart-delay"
          onChange={(e) => onChange({ ...value, delayMinutes: Number(e.target.value) })}
          className="flex h-8 rounded-md border border-input bg-background px-2 text-xs">
          {delays.map((m) => <option key={m} value={m}>{delayLabel(m)}</option>)}
        </select>
      </div>
      <ScheduleChoice id={`${id}-when`} value={value.when} onChange={(when) => onChange({ ...value, when })} zones={zones} nowLabel="At the next check-in" />
      {value.when.mode === 'schedule' && (
        <p className="text-muted-foreground" data-testid="restart-when-note">The warning starts at that time, so the computer restarts {delayLabel(value.delayMinutes)} after it.</p>
      )}
      {showOnlyIfRequired && (
        <label className="flex items-start gap-2">
          <input type="checkbox" className="mt-0.5" checked={value.onlyIfRequired} data-testid="restart-only-if-required"
            onChange={(e) => onChange({ ...value, onlyIfRequired: e.target.checked })} />
          <span>Only if Windows reports a restart is required. The computer checks when the plan runs, and does nothing if none is pending.</span>
        </label>
      )}
      <label className="flex items-start gap-2">
        <input type="checkbox" className="mt-0.5" checked={value.ignoreRemoteSession} data-testid="restart-ignore-remote-session"
          onChange={(e) => onChange({ ...value, ignoreRemoteSession: e.target.checked })} />
        <span>{IGNORE_REMOTE_SESSION_LABEL}</span>
      </label>
      <p className="text-muted-foreground" data-testid="restart-signed-in-note">
        {SIGNED_IN_USER_NOTE} {value.ignoreRemoteSession
          ? 'With the exception ticked, a technician’s RustDesk session does not stop it either; the warning still shows.'
          : 'Only a technician connected through RustDesk stops it; it is then reported as deferred.'}
        {(value.onlyIfRequired || value.ignoreRemoteSession) && ' These options need the 0.54 agent or later.'}
      </p>
    </div>
  );
}
