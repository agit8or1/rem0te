/**
 * Moving one computer from the standard agent to the signed agent (0.34):
 * the rules, as pure functions, so the unit script, the Agent card, the
 * Patches tab and the request route all give the same answer.
 *
 * ── Why one computer at a time needs no independent review ─────────────────
 *
 * A standard (legacy) agent already trusts the portal completely: whenever the
 * portal sets the reinstall flag, its heartbeat pipes the portal's windows.ps1
 * into a SYSTEM PowerShell. Any single person who can press "Reinstall agent"
 * (computers:edit on that computer) can already make the portal run its
 * installer there. A per-computer migration run is one more such run, of a
 * fixed script whose only inputs are the portal's address and the signed
 * agent's digest from the offline-signed repository. It grants a compromised
 * portal nothing it did not already have over that machine — and afterwards
 * the machine runs only code signed by keys the portal never holds, so the
 * portal has LESS power over it. That is why it needs a fresh sign-in, a
 * reason and the audit trail, and not the second person that flipping the
 * platform-wide mode needs: the mode decides what EVERY legacy agent may be
 * handed, including ones nobody asked about.
 *
 * ── The mode boundary ──────────────────────────────────────────────────────
 *
 * The reasoning above holds only where the portal can already push that
 * machine a reinstall, so a per-computer migration is allowed exactly there:
 *
 *   legacy_allowed                  allowed: the portal can push any reinstall
 *   signed_only + portal migration  allowed: every legacy agent is already
 *                                   being handed this same script
 *   signed_only                     REFUSED: the operator contained legacy
 *                                   agents — the portal hands them nothing to
 *                                   run. A per-computer migration is a portal-
 *                                   served script run on a legacy agent, which
 *                                   is precisely what that mode withholds and
 *                                   what turning portal migration on puts to
 *                                   review. Allowing it would let one person
 *                                   reopen, machine by machine, the path the
 *                                   mode closed. Migrate those locally or
 *                                   through GPO/Intune, or ask for portal
 *                                   migration (reviewed).
 *
 * The script being "signed-only compatible" does not change this: in
 * signed_only the risk being contained is the legacy agent running whatever
 * the portal serves, not the content of today's script. The heartbeat
 * re-applies the same boundary (a request made in legacy_allowed is held, not
 * dispatched, once the mode is tightened), and nothing here ever writes the
 * mode (check-security-invariants §43).
 */
import { BadRequestException } from '@nestjs/common';
import { randomBytes } from 'crypto';

export type TrustMode = 'legacy_allowed' | 'signed_only';

const HOSTNAME_RE = /^[a-zA-Z0-9._-]{1,253}$/;

/** host or host:port, matching what the signed agent accepts (agent.ValidPortal). */
export function validPortalHost(h: string): boolean {
  const [host, port, extra] = h.split(':');
  if (extra !== undefined || !HOSTNAME_RE.test(host) || host.includes('..')) return false;
  return port === undefined || /^[1-9][0-9]{0,4}$/.test(port);
}

/**
 * One-time migration of a legacy agent to the signed chain. This run trusts
 * the portal, exactly as every legacy run does: the digest is pinned here, by
 * the portal, from the signed targets it serves. Everything after it — the
 * agent binary re-verifying itself in stage 2, the installer, RustDesk, every
 * later update — is verified against the offline-signed root compiled into
 * that binary. Served by windows.ps1 in "Signed only + portal migration" mode
 * and, from 0.34, for one computer's migration nonce.
 */
export function buildMigrationScript(portalHost: string, agentSha256: string): string {
  if (!validPortalHost(portalHost) || !/^[0-9a-f]{64}$/.test(agentSha256)) {
    throw new BadRequestException('Cannot build a migration script from these values');
  }
  return `# Rem0te: migrate this machine to the signed update chain (one time).
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
# A fresh directory with a name nobody can predict, locked to SYSTEM and
# Administrators before anything is written into it, so no local user can
# have pre-created it or swap the binary between the digest check and the run.
$dir = Join-Path $env:ProgramData ('Rem0te-migrate-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $dir | Out-Null
icacls $dir /inheritance:r /grant:r '*S-1-5-18:(OI)(CI)F' '*S-1-5-32-544:(OI)(CI)F' *>$null
$exe = Join-Path $dir 'rem0te-agent.exe'
Invoke-WebRequest -UseBasicParsing -Uri 'https://${portalHost}/api/v1/public/updates/targets/windows/${agentSha256}.rem0te-agent.exe' -OutFile $exe
if ((Get-FileHash -Algorithm SHA256 -LiteralPath $exe).Hash.ToLower() -ne '${agentSha256}') { Remove-Item -LiteralPath $exe -Force; exit 12 }
& $exe migrate --portal '${portalHost}'
exit $LASTEXITCODE
`;
}

/** What windows.ps1 serves for a migration nonce it cannot honour right now. Runs nothing. */
export const MIGRATION_UNAVAILABLE = `# Rem0te: this computer's migration to the signed agent cannot run right now
# (no signed agent is published, the portal address is not configured, or the
# portal's update policy holds it). Nothing was changed.
Write-Output 'Migration unavailable. Nothing was changed.'
exit 1
`;

export const MIGRATION_NONCE_RE = /^mig_[A-Za-z0-9_-]{40}$/;
export function newMigrationNonce(): string {
  return `mig_${randomBytes(30).toString('base64url')}`;
}

// ── Preconditions ───────────────────────────────────────────────────────────

export interface MigrationFacts {
  platform: string | null;
  updateChannel: string | null;
  status: string;
  /** A RustDesk node with a device secret: the heartbeat hands work only to an authenticated agent. */
  hasSecret: boolean;
  repoConfigured: boolean;
  signedAgentPublished: boolean;
  portalHost: string | null;
  mode: TrustMode;
  legacyPortalMigration: boolean;
  /** The containment message when an `updates` pause applies to this computer, else null. */
  updatesPause: string | null;
  inRollout: boolean;
}

export interface MigrationBlock {
  code: string;
  reason: string;
  /** What to do about it, in a sentence; null when nothing on this portal can fix it. */
  fix: string | null;
  link?: { href: string; label: string };
}

export const ROLES_AND_KEYS = { href: '/docs/update-signing#roles-and-keys', label: 'Update signing → Roles and keys' };
const MOVING = { href: '/docs/update-signing#moving-existing-agents', label: 'Update signing → Moving existing agents' };

export const isWindows = (p: string | null | undefined) => !!p && /^windows/i.test(p.trim());
const readOnlyOs = (p: string | null | undefined): 'Linux' | 'macOS' | null =>
  !p ? null : /^linux/i.test(p.trim()) ? 'Linux' : /^(macos|mac|darwin|osx|os x)\b/i.test(p.trim()) ? 'macOS' : null;

/**
 * Why this computer cannot be moved to the signed agent from the console, or
 * null when it can. The first unmet precondition wins, in the order a person
 * would have to fix them.
 */
export function migrationBlock(f: MigrationFacts): MigrationBlock | null {
  const os = readOnlyOs(f.platform);
  if (os) {
    return { code: os === 'Linux' ? 'LINUX_AGENT_READ_ONLY' : 'MACOS_AGENT_READ_ONLY', reason: `There is no signed agent for ${os}: the ${os} agent only reports and acts on nothing the server sends.`, fix: 'To update it, re-run the installer on the computer.' };
  }
  if (!isWindows(f.platform)) return { code: 'NOT_WINDOWS', reason: 'Only a Windows computer can run the signed agent, and this one has not reported Windows.', fix: null };
  if (f.updateChannel === 'signed') return { code: 'ALREADY_SIGNED', reason: 'This computer already runs the signed agent.', fix: null };
  if (f.status === 'ARCHIVED') return { code: 'ARCHIVED', reason: 'This computer is archived; nothing is sent to an archived computer.', fix: 'Restore it first.' };
  if (!f.hasSecret) {
    return { code: 'NO_DEVICE_SECRET', reason: 'This computer has never authenticated with a device secret, so the server cannot ask it to do anything.', fix: 'Re-run the installer on the computer once; after that it can be upgraded from here.' };
  }
  if (!f.repoConfigured) {
    return {
      code: 'NO_SIGNED_RELEASE',
      reason: 'No signed release is published: this portal has no signed update repository (UPDATE_REPO_DIR is not set). Publishing one needs the offline signing keys only you hold.',
      fix: 'Create the repository and publish a release on your release machine, then set UPDATE_REPO_DIR.', link: ROLES_AND_KEYS,
    };
  }
  if (!f.signedAgentPublished) {
    return {
      code: 'NO_SIGNED_RELEASE',
      reason: 'No signed release is published: the signed repository has no windows/rem0te-agent.exe. Publishing one needs the offline signing keys only you hold.',
      fix: 'Sign and publish a release with the agent on your release machine.', link: ROLES_AND_KEYS,
    };
  }
  if (!f.portalHost) {
    return { code: 'NO_PORTAL_ADDRESS', reason: 'The portal has no https public address or relay host to put in the migration script.', fix: 'Set the public address in Settings.' };
  }
  if (f.mode === 'signed_only' && !f.legacyPortalMigration) {
    return {
      code: 'SIGNED_ONLY',
      reason: 'This portal is in Signed only: standard agents are handed nothing to run, and a migration from the console would hand this one a portal-served script.',
      fix: 'Migrate it locally or through GPO/Intune (rem0te-agent.exe migrate), or turn on portal migration in Update signing, which needs an independent reviewer.', link: MOVING,
    };
  }
  if (f.updatesPause) return { code: 'CONTAINED', reason: f.updatesPause, fix: 'It can be requested once the pause is lifted.' };
  if (f.inRollout) {
    return { code: 'IN_ROLLOUT', reason: 'A staged rollout is updating this computer; it owns its updates until its job finishes.', fix: 'Wait for the rollout job to finish, or cancel it on the Updates page.' };
  }
  return null;
}

// ── Status of one request, for the Agent card and the Migration status view ──

export interface MigrationRow {
  requestedAt: Date; dispatchedAt: Date | null; lastDispatchedAt: Date | null; fetchedAt: Date | null;
  holdReason: string | null; holdAt: Date | null; completedAt: Date | null; cancelledAt: Date | null;
}

export type MigrationState = 'pending' | 'held' | 'dispatched' | 'downloaded' | 'not_confirmed' | 'completed' | 'cancelled';

/** Handed out (or downloaded) this long ago with the computer still on the standard agent: it failed, or did not run. */
export const NOT_CONFIRMED_AFTER_MS = 2 * 3600_000;

export const HOLD_TEXT: Record<string, string> = {
  contained: 'held by an updates containment pause',
  signed_only: 'held: the portal is in Signed only, which hands standard agents nothing to run',
  rollout: 'held while a staged rollout owns this computer\'s updates',
  no_release: 'held: no signed agent is published',
};

export function migrationState(r: MigrationRow, now = Date.now()): { state: MigrationState; text: string } {
  if (r.completedAt) return { state: 'completed', text: 'Completed: the computer reports the signed agent.' };
  if (r.cancelledAt) return { state: 'cancelled', text: 'Cancelled.' };
  const last = r.fetchedAt ?? r.lastDispatchedAt ?? r.dispatchedAt;
  if (last && now - last.getTime() > NOT_CONFIRMED_AFTER_MS) {
    return { state: 'not_confirmed', text: 'Not confirmed: handed out over 2 hours ago and the computer still reports the standard agent. The migration failed or did not run; the standard agent does not report the script\'s exit code, so check its last update result or run rem0te-agent.exe status on the computer.' };
  }
  if (r.holdReason && (!r.lastDispatchedAt || (r.holdAt && r.holdAt > r.lastDispatchedAt))) {
    return { state: 'held', text: `Waiting: ${HOLD_TEXT[r.holdReason] ?? r.holdReason}.` };
  }
  if (r.fetchedAt) return { state: 'downloaded', text: 'The computer downloaded the migration script; waiting for it to report the signed agent.' };
  if (r.dispatchedAt) return { state: 'dispatched', text: 'Handed to the computer at its last check-in; it runs within 30 minutes of its previous update attempt.' };
  return { state: 'pending', text: 'Waiting for the computer\'s next check-in (about every 3 minutes).' };
}

export const MIGRATION_STATES: MigrationState[] = ['pending', 'held', 'dispatched', 'downloaded', 'not_confirmed', 'completed', 'cancelled'];
