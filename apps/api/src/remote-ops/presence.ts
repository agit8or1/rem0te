/**
 * Whether a computer's remote worker should run (0.77): the heartbeat's
 * `remotePoll`. Plain Prisma, read-only, so EnrollmentService can ask it
 * without importing the module that acts. True while the computer has a
 * pending or open terminal, or (0.78) a pending or running file transfer.
 */
import type { PrismaClient } from '@prisma/client';

type Db = Pick<PrismaClient, 'terminalSession' | 'fileTransfer'>;

export async function remoteWorkWanted(db: Db, endpointId: string): Promise<boolean> {
  if ((await db.terminalSession.count({ where: { endpointId, state: { in: ['pending', 'open'] } } })) > 0) return true;
  // 0.78: a pending or running file transfer.
  return (await db.fileTransfer.count({ where: { endpointId, state: { in: ['pending', 'transferring'] } } })) > 0;
}
