/**
 * Which operating system a computer reported (Endpoint.platform), for the few
 * decisions that depend on it. The value is self-reported by the installer and
 * heartbeat ("Windows", "linux", "macos"), so it decides what the server
 * *offers*, never what it trusts.
 */
export function isLinuxPlatform(platform: string | null | undefined): boolean {
  return !!platform && /^linux/i.test(platform.trim());
}

/** macOS, under any of the names installers have reported it by (0.33). */
export function isMacPlatform(platform: string | null | undefined): boolean {
  return !!platform && /^(macos|mac|darwin|osx|os x)\b/i.test(platform.trim());
}

/**
 * The platforms whose agent is the read-only POSIX agent (posix-agent.ts):
 * Linux from 0.32, macOS from 0.33. Both report heartbeat, inventory and
 * pending updates and act on nothing the server sends, so the console must
 * not stage a rotation, a reinstall, a client update or an event-log query
 * for them — it would look accepted and never happen.
 *
 * Returns the label used in messages, or null for every other platform.
 */
export function readOnlyAgentOs(platform: string | null | undefined): 'Linux' | 'macOS' | null {
  if (isLinuxPlatform(platform)) return 'Linux';
  if (isMacPlatform(platform)) return 'macOS';
  return null;
}

/**
 * Why a request that only a Windows agent can act on is refused for a Linux
 * (0.32) or macOS (0.33) computer. One code per platform, so the Linux code a
 * client may already key on is unchanged.
 */
export function readOnlyAgentRefusal(platform: string | null | undefined, what: string): { code: string; message: string } | null {
  const os = readOnlyAgentOs(platform);
  if (!os) return null;
  return {
    code: os === 'Linux' ? 'LINUX_AGENT_READ_ONLY' : 'MACOS_AGENT_READ_ONLY',
    message: `${what} is not available on ${os}: the ${os} agent only reports, and acts on nothing the server sends. ` +
      'Do it on the computer itself (re-run the installer to reinstall or change the password).',
  };
}
