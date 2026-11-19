/**
 * What the console shows as an agent's version (0.70.1). The API computes it
 * (apps/api/src/common/agent-version-view.ts); this file only reads it.
 *
 * The signed agent's binary is reproducible and carries no version, so
 * several releases publish the same bytes. A signed computer whose build hash
 * is the published one is current and shows the published release, whatever
 * label it recorded at its last daily update check (`recorded`).
 */
export interface AgentVersionView {
  label: string | null;
  recorded: string | null;
  current: boolean | null;
  reason: 'same_build' | 'different_build' | 'no_published_build' | 'no_build_reported' | 'not_signed';
  detail: string | null;
}

/** The version to show: the view's label, else the recorded label (an older API). */
export function shownAgentVersion(view: AgentVersionView | null | undefined, recorded: string | null | undefined): string | null {
  return view ? view.label : recorded ?? null;
}

/** A tooltip for a version cell: the view's sentence, or nothing. */
export function agentVersionTitle(view: AgentVersionView | null | undefined): string | undefined {
  return view?.detail ?? undefined;
}
