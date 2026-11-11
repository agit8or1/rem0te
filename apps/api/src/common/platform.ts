/**
 * Which operating system a computer reported (Endpoint.platform), for the few
 * decisions that depend on it. The value is self-reported by the installer and
 * heartbeat ("Windows", "linux", "macos"), so it decides what the server
 * *offers*, never what it trusts.
 */
export function isLinuxPlatform(platform: string | null | undefined): boolean {
  return !!platform && /^linux/i.test(platform.trim());
}

/**
 * Why a request that only a Windows agent can act on is refused for a Linux
 * computer (0.32). The Linux agent is read-only: it ignores rotations,
 * reinstalls, client updates and event-log queries, so staging one would look
 * accepted and never happen.
 */
export const LINUX_READ_ONLY = {
  code: 'LINUX_AGENT_READ_ONLY',
  message: (what: string) =>
    `${what} is not available on Linux: the Linux agent only reports, and acts on nothing the server sends. ` +
    'Do it on the computer itself (re-run the installer to reinstall or change the password).',
};
