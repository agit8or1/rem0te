/**
 * Words for one computer's own state, by the operating system it reported
 * (Endpoint.platform) — 0.35. A Linux server's pending updates come from its
 * package manager, not "Windows Update", and its restart flag is the
 * package manager's, not Windows'.
 *
 * The same prefixes as apps/api/src/common/platform.ts, which words the
 * dashboard's reason lines the same way. Unknown platforms get neutral words
 * ("the computer", "updates") rather than a guess.
 */
export type OsName = 'Windows' | 'Linux' | 'macOS';

export function osName(platform: unknown): OsName | null {
  const p = typeof platform === 'string' ? platform.trim() : '';
  if (/^win/i.test(p)) return 'Windows';
  if (/^linux/i.test(p)) return 'Linux';
  if (/^(macos|mac|darwin|osx|os x)\b/i.test(p)) return 'macOS';
  return null;
}

/** What reported the pending updates: the row label on the Updates card and the Patches tab's card title. */
export function updateSourceLabel(platform: unknown): string {
  switch (osName(platform)) {
    case 'Windows': return 'Windows Update';
    case 'Linux': return 'Package updates';
    case 'macOS': return 'Software Update';
    default: return 'Updates';
  }
}

/** The same, inside a sentence: "checks Windows Update", "checks its package manager". */
export function updateSourcePhrase(platform: unknown): string {
  switch (osName(platform)) {
    case 'Windows': return 'Windows Update';
    case 'Linux': return 'its package manager (apt, dnf or zypper)';
    case 'macOS': return 'Software Update';
    default: return 'for pending updates';
  }
}

/** "Windows is waiting for a restart" / "Linux is …" / "This computer is …". */
export function restartPendingSentence(platform: unknown): string {
  const os = osName(platform);
  return os ? `${os} is waiting for a restart` : 'This computer is waiting for a restart';
}
