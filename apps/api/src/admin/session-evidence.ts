import type { PrismaService } from '../prisma/prisma.service';

/** A launch younger than this that has not been confirmed or closed counts as possibly open. */
export const UNCONFIRMED_LAUNCH_MS = 2 * 3600_000;

/**
 * Is a remote session open on this computer, as far as the server can tell?
 * Returns the reason, or null.
 *
 * One definition, shared by staged rollouts (0.20) and the client-update
 * policy (0.32): two copies of "is someone connected" is how one path installs
 * into a session the other would have waited for.
 *
 *   reportedSessions  the endpoint's own count of RustDesk connection
 *                     managers on this heartbeat (the strongest evidence);
 *   SESSION_STARTED   a session the console confirmed;
 *   a recent launch   requested, acknowledged or opened in the last two hours
 *                     and never confirmed or closed — only with
 *                     `includeUnconfirmed`, because it may be a session the
 *                     endpoint cannot see (an agent that does not report).
 */
export async function openSessionReason(
  prisma: PrismaService,
  endpointId: string,
  reportedSessions: number | null | undefined,
  now: Date,
  includeUnconfirmed: boolean,
): Promise<string | null> {
  if ((reportedSessions ?? 0) > 0) return 'active_session_reported_by_endpoint';
  const sessions = await prisma.supportSession.findMany({
    where: {
      endpointId,
      status: { in: ['SESSION_STARTED', 'LAUNCH_REQUESTED', 'LAUNCHER_ACKNOWLEDGED', 'CLIENT_OPENED'] },
    },
    select: { status: true, createdAt: true },
  });
  if (sessions.some((s) => s.status === 'SESSION_STARTED')) return 'active_session_confirmed';
  if (includeUnconfirmed && sessions.some((s) => now.getTime() - s.createdAt.getTime() < UNCONFIRMED_LAUNCH_MS)) {
    return 'session_state_unknown (a recent launch has not been confirmed or closed)';
  }
  return null;
}
