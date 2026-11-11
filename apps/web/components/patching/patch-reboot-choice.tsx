'use client';

import { Label } from '@/components/ui/label';

/**
 * The restart rule for an update install (0.34). Two values, the same two the
 * portal, the approval signer and the agent each accept and nothing else
 * (windows.update.install's closed `reboot` parameter). The default is never.
 */
export type RebootRule = 'never' | 'if_required_in_window';

/** The fixed warning the agent gives before an update restart (UPDATE_RESTART_WARNING_MINUTES). */
export const RESTART_WARNING_MINUTES = 15;

export const REBOOT_LABEL: Record<RebootRule, string> = {
  never: 'Never restart (someone restarts it later)',
  if_required_in_window: 'Restart if required, inside the window',
};

/** Said wherever the rule is offered. Kept in step with REBOOT_UNPROVEN in apps/api/src/actions/catalog.ts. */
export const REBOOT_UNPROVEN = 'The in-window restart has been tested against a simulated Windows only; it has not yet run on a real Windows computer.';

export function rebootSummary(rule: RebootRule | string | undefined): string {
  return rule === 'if_required_in_window'
    ? `Restarts if Windows requires it, after a ${RESTART_WARNING_MINUTES}-minute warning, inside the window, never with a RustDesk session open`
    : 'Never restarts';
}

export function RebootChoice({ id, value, onChange, scope }: { id: string; value: RebootRule; onChange: (v: RebootRule) => void; scope: 'plan' | 'policy' }) {
  return (
    <div className="space-y-1" data-testid="reboot-choice">
      <Label htmlFor={id} className="text-xs">Restart</Label>
      <select id={id} className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm" value={value}
        onChange={(e) => onChange(e.target.value === 'if_required_in_window' ? 'if_required_in_window' : 'never')}>
        <option value="never">{REBOOT_LABEL.never}</option>
        <option value="if_required_in_window">{REBOOT_LABEL.if_required_in_window}</option>
      </select>
      {value === 'if_required_in_window' && (
        <p className="text-xs text-muted-foreground" data-testid="reboot-explained">
          After installing, a computer that Windows says needs a restart shows a fixed warning and restarts {RESTART_WARNING_MINUTES} minutes later;
          programs still open are closed without saving. It skips the restart — and reports it deferred — if a RustDesk session is open or it cannot tell,
          or if the restart would fall after {scope === 'policy' ? 'the maintenance window (and that ring plan\'s window) ends' : 'the window ends'}. The approvers see this rule and approve it with the plan.{' '}
          <strong>{REBOOT_UNPROVEN}</strong>
        </p>
      )}
    </div>
  );
}
