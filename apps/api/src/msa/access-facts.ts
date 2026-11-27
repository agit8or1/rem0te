/**
 * Managed Secure Access, item by item (0.91, UX P1-5; directive §12 "For
 * Managed Secure Access, clearly display").
 *
 * Twelve facts about one computer, each from what the server already knows:
 * the switch (MSA_GRANTS), the readiness decision, the managed row and the
 * agent version, plus the constants that bound every grant. It is display
 * only and pure: it decides nothing, enables nothing and is never consulted
 * by a route that acts. Where the endpoint cannot do something the answer is
 * "no" with the reason, never a control that looks like it could.
 */

import { compareVersion, MIN_ENFORCING_AGENT, MIN_REPORTING_AGENT } from './readiness';
import { MAX_MINUTES_MAX } from './grant';
import { CONNECT_APPLY_TIMEOUT_MS, LOCKED_KEYS, MANAGED_CEILING, MIN_SESSION_AGENT } from './managed';

export const FACT_KEYS = [
  'support', 'readiness', 'enabled', 'agent', 'enforcement', 'credential',
  'consent', 'clipboard', 'files', 'expiration', 'revocation', 'termination',
] as const;
export type FactKey = (typeof FACT_KEYS)[number];
export type FactAnswer = 'yes' | 'no' | 'partial' | 'unknown';

export interface AccessFact { key: FactKey; label: string; answer: FactAnswer; text: string }

export interface AccessFactInput {
  /** MSA_GRANTS on this server. */
  switchOn: boolean;
  /** The readiness decision (msa/readiness.ts) and its label. */
  readiness: { state: string; label: string };
  /** The computer's managed row, if a Platform Admin moved it. */
  managed: { state: string; verifiedAt: Date | string | null } | null;
  /** The agent version the console shows (null: not reported). */
  agentVersion: string | null;
  windows: boolean;
  signedAgent: boolean;
}

const LABEL: Record<FactKey, string> = {
  support: 'Endpoint support',
  readiness: 'Readiness',
  enabled: 'Enabled',
  agent: 'Agent compatibility',
  enforcement: 'Endpoint enforcement',
  credential: 'Temporary credential',
  consent: 'Consent',
  clipboard: 'Clipboard',
  files: 'File transfer',
  expiration: 'Session expiration',
  revocation: 'Revocation',
  termination: 'Termination',
};

const atLeast = (v: string | null, min: string) => (compareVersion(v, min) ?? -1) >= 0;

export function accessFacts(f: AccessFactInput): AccessFact[] {
  const verified = f.managed?.state === 'verified' && !!f.managed.verifiedAt;
  const failed = f.managed?.state === 'enforcement_failure';
  const sessions = atLeast(f.agentVersion, MIN_SESSION_AGENT);
  const enforces = atLeast(f.agentVersion, MIN_ENFORCING_AGENT);
  const out: Record<FactKey, Omit<AccessFact, 'key' | 'label'>> = {
    support: !f.windows
      ? { answer: 'no', text: 'Windows only: Linux and macOS agents cannot enforce RustDesk settings.' }
      : !f.signedAgent
        ? { answer: 'no', text: 'Needs the signed agent; this device runs the standard one.' }
        : { answer: 'yes', text: 'A Windows device running the signed agent.' },
    readiness: { answer: ['compatible', 'managed', 'managed_verified'].includes(f.readiness.state) ? 'yes' : f.readiness.state === 'unknown' ? 'unknown' : f.readiness.state === 'enforcement_failure' ? 'no' : 'partial', text: `${f.readiness.label}, from the agent's read-only RustDesk check; the reasons are listed above.` },
    enabled: !f.switchOn
      ? { answer: 'no', text: 'Not switched on on this server (MSA_GRANTS). Connect uses the RustDesk password, with its usual protections.' }
      : !f.managed
        ? { answer: 'no', text: 'Switched on for testing on this server; this device is not managed. Only a Platform Admin can move it in, one device at a time.' }
        : verified
          ? { answer: 'yes', text: 'Managed and verified: Connect goes through one-time grants.' }
          : { answer: 'partial', text: failed ? 'Managed, but enforcement failed: Connect is refused until it is fixed or rolled back.' : `Managed, not yet verified (${f.managed.state}).` },
    agent: !f.agentVersion
      ? { answer: 'unknown', text: 'No agent version reported.' }
      : { answer: sessions ? 'yes' : enforces ? 'partial' : 'no', text: `Agent ${f.agentVersion}. Readiness needs ${MIN_REPORTING_AGENT}, enforcement ${MIN_ENFORCING_AGENT}, managed sessions ${MIN_SESSION_AGENT}.` },
    enforcement: failed
      ? { answer: 'no', text: 'The last apply did not read back as set, so no grant is accepted.' }
      : verified
        ? { answer: 'yes', text: `The agent sets RustDesk's permissions for each grant and reads them back; ${LOCKED_KEYS.length} (terminal, camera, printer, input blocking, privacy mode, recording) are always off.` }
        : { answer: enforces && f.windows && f.signedAgent ? 'partial' : 'no', text: enforces ? 'The agent can enforce, but nothing is enforced until the device is managed and verified.' : `Needs agent ${MIN_ENFORCING_AGENT} or later.` },
    credential: verified
      ? { answer: 'yes', text: 'A one-time password per session, released once to that session\'s technician; the permanent RustDesk password is never revealed, launched or rotated while verified.' }
      : { answer: 'no', text: 'Not managed: the permanent RustDesk password and its protections (step-up, rotation, never shown in full) apply.' },
    consent: { answer: verified ? 'partial' : 'no', text: verified
      ? 'Attended or unattended per the access controls for each Connect. The agent cannot see whether the person accepted RustDesk\'s prompt.'
      : 'Set by RustDesk on the device; Rem0te cannot require it here.' },
    clipboard: { answer: verified ? 'partial' : 'no', text: verified
      ? `Off unless the access controls allow it for that Connect${MANAGED_CEILING.permissions.clipboard ? '' : ' (never: above the ceiling)'}.`
      : 'Not enforced by Rem0te on an unmanaged device: RustDesk\'s own setting applies.' },
    files: { answer: verified ? 'partial' : 'no', text: verified
      ? `Off unless the access controls allow it for that Connect${MANAGED_CEILING.permissions.files ? '' : ' (never: above the ceiling)'}. Tunnels and remote restart are never allowed.`
      : 'Not enforced by Rem0te on an unmanaged device: RustDesk\'s own setting applies.' },
    expiration: { answer: verified ? 'yes' : 'no', text: verified
      ? `Each grant must be applied within ${CONNECT_APPLY_TIMEOUT_MS / 1000} s of Connect and ends at its own time limit (at most ${MAX_MINUTES_MAX / 60} hours), ended by the agent.`
      : 'No grant, so nothing expires: an unmanaged session lasts until RustDesk ends it.' },
    revocation: { answer: verified ? 'yes' : 'no', text: verified
      ? 'Disconnect sends a signed revocation; the agent ends the session when it receives it. Offline, the session ends at its time limit.'
      : 'Nothing to revoke: an unmanaged session can be ended only in RustDesk or by changing the password.' },
    termination: { answer: verified && sessions ? 'yes' : 'no', text: verified && sessions
      ? 'The agent ends the session on revocation and at the time limit. It cannot see who is connected or what happens inside the session.'
      : `Needs a verified managed device and agent ${MIN_SESSION_AGENT} or later.` },
  };
  return FACT_KEYS.map((key) => ({ key, label: LABEL[key], ...out[key] }));
}
