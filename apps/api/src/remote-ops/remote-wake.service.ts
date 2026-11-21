import { Injectable, OnModuleDestroy } from '@nestjs/common';

type Waiter = { wake: (why: 'work' | 'superseded' | 'shutdown') => void };

/**
 * The remote worker's held polls, in this process (0.77): one per computer.
 * Opening a terminal, a technician's input or an end wakes the computer's
 * held poll at once; a held poll also re-reads the database every
 * REMOTE_POLL_RECHECK_MS, for news that reached another API process.
 */
@Injectable()
export class RemoteWakeService implements OnModuleDestroy {
  private readonly waiters = new Map<string, Waiter>();

  onModuleDestroy() {
    for (const w of [...this.waiters.values()]) w.wake('shutdown');
  }

  get held(): number { return this.waiters.size; }

  has(endpointId: string): boolean { return this.waiters.has(endpointId); }

  wake(endpointId: string) { this.waiters.get(endpointId)?.wake('work'); }

  /**
   * Hold until woken, superseded by a newer poll from the same computer, the
   * server stops, `recheck` says there is work, or `holdMs` passes.
   */
  hold(endpointId: string, holdMs: number, recheckMs: number, recheck: () => Promise<boolean>): Promise<'work' | 'superseded' | 'shutdown' | 'timeout'> {
    this.waiters.get(endpointId)?.wake('superseded');
    return new Promise((resolve) => {
      let done = false;
      const finish = (w: 'work' | 'superseded' | 'shutdown' | 'timeout') => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        clearInterval(again);
        if (this.waiters.get(endpointId) === me) this.waiters.delete(endpointId);
        resolve(w);
      };
      const me: Waiter = { wake: finish };
      const timer = setTimeout(() => finish('timeout'), holdMs);
      const again = setInterval(() => {
        void recheck().then((yes) => { if (yes) finish('work'); }).catch(() => undefined);
      }, recheckMs);
      this.waiters.set(endpointId, me);
    });
  }
}
