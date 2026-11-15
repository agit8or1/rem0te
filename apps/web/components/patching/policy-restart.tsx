'use client';

/**
 * 0.54: a patch policy's restart window and rule, for per-business policies
 * and company-wide series. It is part of what the approvers sign. Inside the
 * restart window the portal's sweep asks the signer for a
 * windows.reboot.schedule plan under the policy, and the signer signs it
 * only within the policy's bounds (its window, its rule, the fixed
 * 15-minute warning, the RustDesk exception only if the policy has it).
 *
 * - Never: no restart window (the install window's rule still applies).
 * - If required: a computer Windows says needs a restart (the agent checks
 *   again, onlyIfRequired) restarts in the restart window.
 * - Always: a maintenance restart of every computer in the policy, once per
 *   restart window.
 */
import { Label } from '@/components/ui/label';
import { WindowEditor, defaultWindowDraft, draftReady, windowFromDraft, type WindowDraft } from '@/components/patching/window-editor';
import { IGNORE_REMOTE_SESSION_LABEL, SIGNED_IN_USER_NOTE } from '@/components/endpoints/restart-options';
import type { PolicyWindowInput } from '@/lib/patching';

export type RestartRuleChoice = 'none' | 'if_required' | 'always';
export type PolicyRestartDraft = { rule: RestartRuleChoice; window: WindowDraft; ignoreRemoteSession: boolean };

export function defaultPolicyRestart(): PolicyRestartDraft {
  const w = defaultWindowDraft();
  return { rule: 'none', window: { ...w, days: new Set(['sun']), start: '02:00', end: '04:00' }, ignoreRemoteSession: false };
}

export const policyRestartReady = (d: PolicyRestartDraft) => d.rule === 'none' || draftReady(d.window);

/** The policy body's fields: `restart` only with a rule, `ignoreRemoteSession` only when ticked and something restarts. */
export function policyRestartBody(d: PolicyRestartDraft, reboot: string): { restart?: { rule: 'if_required' | 'always'; window: PolicyWindowInput }; ignoreRemoteSession?: true } {
  const restarts = d.rule !== 'none' || reboot === 'if_required_in_window';
  return {
    ...(d.rule !== 'none' ? { restart: { rule: d.rule, window: windowFromDraft(d.window) } } : {}),
    ...(d.ignoreRemoteSession && restarts ? { ignoreRemoteSession: true as const } : {}),
  };
}

export const RESTART_RULE_LABEL: Record<RestartRuleChoice, string> = {
  none: 'No restart window',
  if_required: 'Restart if required, in a restart window',
  always: 'Restart every computer in a restart window (maintenance restart)',
};

export function PolicyRestartEditor({ id, value, onChange, reboot, expiresInDays }: {
  id: string; value: PolicyRestartDraft; onChange: (v: PolicyRestartDraft) => void; reboot: string; expiresInDays?: number;
}) {
  const restarts = value.rule !== 'none' || reboot === 'if_required_in_window';
  return (
    <div className="space-y-2" data-testid={`${id}-restart`}>
      <div className="space-y-1 max-w-xl">
        <Label htmlFor={`${id}-restart-rule`} className="text-xs">Restart window</Label>
        <select id={`${id}-restart-rule`} data-testid={`${id}-restart-rule`} className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
          value={value.rule} onChange={(e) => onChange({ ...value, rule: e.target.value as RestartRuleChoice })}>
          {(Object.keys(RESTART_RULE_LABEL) as RestartRuleChoice[]).map((r) => <option key={r} value={r}>{RESTART_RULE_LABEL[r]}</option>)}
        </select>
      </div>
      {value.rule !== 'none' && (
        <>
          <WindowEditor id={`${id}-rw`} title="Restart window" value={value.window} onChange={(w) => onChange({ ...value, window: w })} expiresInDays={expiresInDays} />
          <p className="text-xs text-muted-foreground" data-testid={`${id}-restart-explained`}>
            {value.rule === 'if_required'
              ? 'Inside the restart window, each computer in the policy that Windows says needs a restart is asked to restart. The computer checks again when the plan runs and does nothing if no restart is pending.'
              : 'Inside the restart window, every computer in the policy is restarted once, whether or not Windows asks for it.'}{' '}
            It warns for 15 minutes first. If a technician is connected through RustDesk the restart is deferred and asked for again 15 minutes later (at most three times in a window), and in the next restart window.
            The signer signs a restart only inside this window. Tested against a simulated agent only; it has not run on a real Windows computer.
          </p>
        </>
      )}
      {restarts && (
        <>
          <label className="flex items-start gap-2 text-xs max-w-xl">
            <input type="checkbox" className="mt-0.5" checked={value.ignoreRemoteSession} data-testid={`${id}-ignore-remote-session`}
              onChange={(e) => onChange({ ...value, ignoreRemoteSession: e.target.checked })} />
            <span>{IGNORE_REMOTE_SESSION_LABEL}. Applies to this policy&apos;s restarts in the install window and the restart window; the approvers see it. Needs the 0.54 agent.</span>
          </label>
          <p className="text-xs text-muted-foreground" data-testid={`${id}-signed-in-note`}>{SIGNED_IN_USER_NOTE}</p>
        </>
      )}
    </div>
  );
}
