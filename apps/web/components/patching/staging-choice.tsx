'use client';

/**
 * 0.62, at the owner's request: how a patch policy or deployment rolls out.
 *
 * By default "all at once": you tick the computers and every one installs in
 * the window together. "Test on one computer first" (off by default) is the
 * canary staging every policy had before 0.62: one computer first, then rings
 * that each wait for the one before to be confirmed.
 *
 * The staging is signed into a policy's document (`staging`) and checked by
 * the approval signer, which refuses anything it does not know. This file only
 * words the choice and splits the ticked computers into plans.
 */

/** One signed plan names at most this many computers (MAX_RING_TARGETS in the API). */
export const MAX_PER_PLAN = 25;
/** Rings a policy may have (MAX_POLICY_RINGS in the API). */
export const MAX_RINGS = 5;
/** All at once: five plans of 25 (the API's MAX_ALL_AT_ONCE_COMPUTERS). */
export const MAX_ALL_AT_ONCE = MAX_PER_PLAN * MAX_RINGS;

/**
 * Ticked computers as plans of at most 25, as even as they can be, in the
 * order given: 26 computers are two plans of 13. None of them waits for
 * another — they exist only because one plan names at most 25 computers.
 */
export function chunkRings(ids: string[], per = MAX_PER_PLAN): string[][] {
  if (!ids.length) return [];
  const n = Math.ceil(ids.length / per);
  const out: string[][] = [];
  let at = 0;
  for (let i = 0; i < n; i++) {
    const size = Math.floor(ids.length / n) + (i < ids.length % n ? 1 : 0);
    out.push(ids.slice(at, at + size));
    at += size;
  }
  return out;
}

export function StagingChoice({ id, value, onChange, what = 'policy' }: { id: string; value: boolean; onChange: (testFirst: boolean) => void; what?: 'policy' | 'deployment' }) {
  return (
    <div className="space-y-1" data-testid={`${id}-staging`}>
      <label className="flex items-start gap-2 text-xs">
        <input id={`${id}-test-first`} type="checkbox" className="mt-0.5" checked={value} onChange={(e) => onChange(e.target.checked)} data-testid={`${id}-test-first`} />
        <span>
          <strong>Test on one device first</strong>
          <span className="block text-muted-foreground">
            {value
              ? `One device installs first. The others follow in rings of up to ${MAX_PER_PLAN}, each only after the ring before it has confirmed every update took effect (a restart if one is needed, a new scan, and the soak time).`
              : `Off: every device you tick installs together, in the ${what === 'policy' ? 'maintenance window' : 'same window'}. Nothing waits for a test device. Up to ${MAX_ALL_AT_ONCE} devices, sent as plans of up to ${MAX_PER_PLAN}.`}
          </span>
        </span>
      </label>
    </div>
  );
}
