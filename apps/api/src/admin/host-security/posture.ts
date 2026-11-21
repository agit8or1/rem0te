/**
 * Server security posture (0.74): findings and the score on Admin → Security
 * → Overview. Pure: it imports only the pure parsers' types.
 *
 * A finding is one check with a status, a severity, the evidence it was
 * decided on, when that evidence was read, and what to do about it. The rule
 * that matters most here: a check whose source could not be read is
 * `unknown`, and unknown is never counted as passing — it lowers the
 * coverage, not the score, and the page shows it as Unknown in its own
 * colour. Before 0.74 the page painted an unreadable fail2ban, an unparsed
 * apt answer and an ESLint run that linted nothing as green.
 */

export type FindingStatus = 'pass' | 'fail' | 'unknown' | 'info';
export type Severity = 'critical' | 'high' | 'medium' | 'low' | 'info';
export type Area = 'host' | 'network' | 'web' | 'portal' | 'process';

export interface Finding {
  id: string;
  area: Area;
  title: string;
  status: FindingStatus;
  /** What a failure costs. A passing or unknown check keeps the severity it would have. */
  severity: Severity;
  /** What was read, in one line. Plain text; the page never renders it as HTML. */
  evidence: string;
  /** When the evidence was read (ISO). */
  checkedAt: string;
  /** What to do, in one line, when it is not passing. */
  fix?: string;
  /** A console page that holds the setting, when there is one. */
  link?: string;
  /**
   * The facts the check was decided on, for its fingerprint (acceptance.ts).
   * Never the wording or the time it was read. Not sent to the page.
   */
  basis?: unknown;
  /** sha256 of id, status and basis (0.75.1): what an acceptance is bound to. */
  fingerprint?: string;
  /** Whether a Platform Admin may accept it, and if not, why not. */
  acceptable?: boolean;
  notAcceptableWhy?: string;
  /** Set when an acceptance holds against this reading (0.75.1). The status is unchanged. */
  acceptance?: FindingAcceptance;
}

export interface FindingAcceptance {
  id: string;
  reason: string;
  acceptedAt: string;
  acceptedBy: string | null;
  expiresAt: string | null;
  /** The evidence as it read when it was accepted. */
  evidence: string;
}

export const SEVERITY_WEIGHT: Record<Severity, number> = { critical: 25, high: 12, medium: 6, low: 2, info: 0 };

export interface Score {
  /** 0–100 over the checks that could be decided, or null when none could. */
  score: number | null;
  grade: 'good' | 'fair' | 'poor' | 'unknown';
  /**
   * fail and unknown count only findings nobody accepted; `accepted` counts
   * the accepted ones (fail or unknown underneath), never as pass (0.75.1).
   */
  counts: Record<FindingStatus | 'accepted', number>;
  failing: Record<Severity, number>;
  /** Decided checks over all scored checks: how much of the score is evidence. */
  coverage: number;
}

/**
 * 100 minus the weight of every failing check, over the checks that were
 * decided. Unknown checks are excluded from the score and reported through
 * `coverage`, so an unreadable source can neither raise nor hide the score.
 * Any failing critical caps the grade at poor.
 *
 * An accepted finding (0.75.1) carries no penalty and is counted as
 * `accepted`, not as fail or unknown. Coverage is unchanged by acceptance: an
 * accepted unknown was still not read, so it stays outside `decided`.
 */
export function scoreOf(findings: Finding[]): Score {
  const counts: Record<FindingStatus | 'accepted', number> = { pass: 0, fail: 0, unknown: 0, info: 0, accepted: 0 };
  const failing: Record<Severity, number> = { critical: 0, high: 0, medium: 0, low: 0, info: 0 };
  let penalty = 0, acceptedFail = 0, acceptedUnknown = 0;
  for (const f of findings) {
    if (f.acceptance && (f.status === 'fail' || f.status === 'unknown')) {
      counts.accepted++;
      if (f.status === 'fail') acceptedFail++; else acceptedUnknown++;
      continue;
    }
    counts[f.status]++;
    if (f.status === 'fail') { failing[f.severity]++; penalty += SEVERITY_WEIGHT[f.severity]; }
  }
  const scored = counts.pass + counts.fail + counts.unknown + acceptedFail + acceptedUnknown;
  const decided = counts.pass + counts.fail + acceptedFail;
  const coverage = scored ? Math.round((decided / scored) * 100) : 0;
  if (!decided) return { score: null, grade: 'unknown', counts, failing, coverage };
  const score = Math.max(0, 100 - penalty);
  const grade = failing.critical > 0 || score < 60 ? 'poor' : score < 85 || failing.high > 0 ? 'fair' : 'good';
  return { score, grade, counts, failing, coverage };
}

/**
 * Every process switch that turns off a background job, and what it costs in
 * production. §84 checks this list holds every `*_SWEEP` / `*_SEALER` the API
 * reads (found from the source, as §44 does for the browser suite), so a
 * new sweep cannot be switched off unseen.
 */
export const OFF_SWITCHES: ReadonlyArray<{ name: string; severity: Severity; cost: string }> = [
  { name: 'STALE_SWEEP', severity: 'critical', cost: 'No computer is ever marked offline again.' },
  { name: 'SSO_SESSION_SWEEP', severity: 'critical', cost: 'A session ended at the identity provider without back-channel logout never ends here.' },
  { name: 'TERMINAL_SWEEP', severity: 'high', cost: 'A terminal or file transfer nobody is reading is not ended at its idle, stall or 60-minute limit (it ends when next read, polled or written), opt-in transcripts are never pruned, and a finished download\'s chunks stay until it is read.' },
  { name: 'AUDIT_SEALER', severity: 'critical', cost: 'New audit entries are not sealed into the tamper-evident chain or exported.' },
  { name: 'MONITOR_SWEEP', severity: 'high', cost: 'Alerts are not raised, resolved, notified or ticketed, and quality rules do not expire.' },
  { name: 'SNAPSHOT_SWEEP', severity: 'medium', cost: 'Automatic Processes, Services and Network snapshots stop.' },
  { name: 'RETENTION_SWEEP', severity: 'medium', cost: 'Old command, diagnostic and history rows are never pruned.' },
  { name: 'CHAT_RETENTION_SWEEP', severity: 'medium', cost: 'Finished chats and their files are never pruned.' },
  { name: 'SCRIPT_OUTPUT_SWEEP', severity: 'medium', cost: 'Script output is kept past its 90 days.' },
  { name: 'PATCH_POLICY_SWEEP', severity: 'medium', cost: 'Patch policies stop proposing rings and company-wide revisions.' },
  { name: 'AUTOMATION_SWEEP', severity: 'medium', cost: 'Automation schedules never run.' },
  { name: 'RESTART_WINDOW_SWEEP', severity: 'medium', cost: 'Restart windows never restart anything.' },
  { name: 'CLIENT_UPDATE_SWEEP', severity: 'medium', cost: 'Scheduled RustDesk client updates never queue.' },
  { name: 'REPORT_SCHEDULE_SWEEP', severity: 'low', cost: 'Scheduled reports are not sent.' },
  { name: 'TRAY_SWEEP', severity: 'low', cost: 'Expired /assist codes and sessions are not deleted, and stuck self-help runs are never closed.' },
  { name: 'AUTO_MIGRATION_SWEEP', severity: 'low', cost: 'Automatic migration to the signed agent stops.' },
  { name: 'METRIC_SWEEP', severity: 'low', cost: 'Metric history is not rolled up or pruned (recording continues).' },
  { name: 'WINGET_INDEX_SWEEP', severity: 'low', cost: 'The winget catalog index is not refreshed.' },
  { name: 'WARRANTY_SWEEP', severity: 'low', cost: 'Warranty dates are not looked up.' },
  { name: 'MDM_SWEEP', severity: 'low', cost: 'Mobile devices are not read from their MDM provider: inventory, compliance and command history stop updating, and unfinished commands are not expired.' },
  { name: 'BACKUP_SYNC_SWEEP', severity: 'low', cost: 'Backup providers that Rem0te reads are not read (a St0r push still arrives).' },
  { name: 'AGENT_AUTO_UPDATE', severity: 'medium', cost: 'Outdated agents are never handed an update (a test switch; the setting belongs in Settings → Client updates).' },
  { name: 'SNAPSHOT_QUIET', severity: 'low', cost: 'Every heartbeat reads the snapshot schedule again (about three transactions each, for nothing).' },
];

/** The switches that are exactly 'off' in this process. */
export function offSwitches(env: Record<string, string | undefined>): typeof OFF_SWITCHES[number][] {
  return OFF_SWITCHES.filter((s) => env[s.name] === 'off');
}

/** NODE_ENV=test lets loopback test endpoints through (testLoopbackAllowed) and a fixture stand in for this host. */
export function nodeEnvFinding(env: Record<string, string | undefined>, checkedAt: string): Finding {
  const v = env.NODE_ENV ?? '(unset)';
  const test = v === 'test';
  return {
    id: 'process.node_env', area: 'process', title: 'API runs in production mode', checkedAt,
    status: v === 'production' ? 'pass' : 'fail', severity: test ? 'critical' : 'medium',
    evidence: `NODE_ENV=${v}`,
    fix: test ? 'NODE_ENV=test admits loopback test endpoints for AI, warranty and host checks. Set NODE_ENV=production in /etc/reboot-remote/api.env and restart the API.'
      : 'Set NODE_ENV=production in /etc/reboot-remote/api.env and restart the API.',
  };
}
