/**
 * A per-user request budget (0.48), in memory. The route throttler counts per
 * address; this counts per person, so one account cannot run up a provider
 * bill or flood a PSA from many addresses. Lost on restart, which only ever
 * gives a little more, never a bypass of the route limit.
 */
export class UserBudget {
  private readonly hits = new Map<string, number[]>();
  constructor(private readonly limit: number, private readonly windowMs: number) {}

  /** Take one from `userId`'s budget. False when it is spent. */
  take(userId: string, now = Date.now()): boolean {
    const from = now - this.windowMs;
    const list = (this.hits.get(userId) ?? []).filter((t) => t > from);
    if (list.length >= this.limit) { this.hits.set(userId, list); return false; }
    list.push(now);
    this.hits.set(userId, list);
    if (this.hits.size > 10_000) for (const [k, v] of this.hits) if (!v.some((t) => t > from)) this.hits.delete(k);
    return true;
  }
}
