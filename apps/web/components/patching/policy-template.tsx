'use client';

/**
 * Optional policy templates (0.94, UX P1-8; directive §14). Choosing one
 * shows what it would fill in; only "Fill in the form" changes the form, and
 * then only its classes, severities, staging, soak and window. It never picks
 * a device, never sets a reboot or restart rule, and never proposes or
 * creates the policy: the form's own button does that, with its approval.
 */

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { CLASS_NAMES } from '@/lib/patching';
import { POLICY_TEMPLATES, templatePreview, type PolicyTemplate } from '@/lib/patch-lifecycle';
import type { WindowDraft } from '@/components/patching/window-editor';

/** The template's window on top of the form's draft, keeping the form's time zone. */
export function templateWindow(t: PolicyTemplate, cur: WindowDraft): WindowDraft {
  const w = t.window;
  if (w.kind === 'weekly') return { ...cur, kind: 'weekly', days: new Set(w.days), start: w.start, end: w.end };
  return { ...cur, kind: 'monthly', monthly: 'weekday', week: w.week, weekday: w.weekday, offsetDays: w.offsetDays, start: w.start, end: w.end };
}

export function PolicyTemplatePicker({ id, onApply }: { id: string; onApply: (t: PolicyTemplate) => void }) {
  const [chosen, setChosen] = useState<PolicyTemplate['id'] | ''>('');
  const [applied, setApplied] = useState<PolicyTemplate['id'] | ''>('');
  const t = POLICY_TEMPLATES.find((x) => x.id === chosen) ?? null;
  return (
    <fieldset className="space-y-2 rounded-md border p-3 text-xs" data-testid={`${id}-template`}>
      <legend className="px-1 font-medium">Start from a template (optional)</legend>
      <div className="flex flex-wrap gap-3" role="radiogroup" aria-label="Policy template">
        {[{ id: '' as const, label: 'No template' }, ...POLICY_TEMPLATES].map((x) => (
          <label key={x.id || 'none'} className="flex items-center gap-1.5">
            <input type="radio" name={`${id}-template`} value={x.id} checked={chosen === x.id} onChange={() => setChosen(x.id)} data-testid={`${id}-template-${x.id || 'none'}`} />
            {x.label}
          </label>
        ))}
      </div>
      {t && (
        <div className="space-y-2" data-testid={`${id}-template-preview`}>
          <p className="text-muted-foreground">{t.why}</p>
          <ul className="list-disc space-y-0.5 pl-5">
            {templatePreview(t, (c) => CLASS_NAMES[c] ?? c).map((l) => <li key={l}>{l}</li>)}
          </ul>
          <p className="text-muted-foreground">Filling in the form changes only the settings listed above. You can change any of them afterwards, and nothing is created, approved or installed until you use the button at the bottom of the form.</p>
          <Button type="button" size="sm" variant="outline" data-testid={`${id}-template-apply`} onClick={() => { onApply(t); setApplied(t.id); }}>Fill in the form</Button>
          {applied === t.id && <p className="text-muted-foreground" data-testid={`${id}-template-applied`}>Filled in from {t.label}. Review it, then choose restarts yourself if you want them.</p>}
        </div>
      )}
    </fieldset>
  );
}
