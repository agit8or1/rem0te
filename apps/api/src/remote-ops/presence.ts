/**
 * Whether a computer's remote worker should run (0.77): the heartbeat's
 * `remotePoll`. Plain Prisma, read-only, so EnrollmentService can ask it
 * without importing the module that acts. True while the computer has a
 * pending or open terminal.
 */
import type { PrismaClient } from '@prisma/client';

type Db = Pick<PrismaClient, 'terminalSession'>;

export async function remoteWorkWanted(db: Db, endpointId: string): Promise<boolean> {
  return (await db.terminalSession.count({ where: { endpointId, state: { in: ['pending', 'open'] } } })) > 0;
}
