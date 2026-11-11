import { BridgeError } from "../types.js";

/** Menu entries `pool/<model>` carry this profile id; each new session is assigned a real account. */
export const POOL_PROFILE = "pool";
/** The default Claude Code login (no extra profile directory). */
export const PERSONAL_ACCOUNT = "personal";

export interface PoolMember { id: string; weight: number }

/** `personal=10,team1-pro=5` -> members; ids must be `personal` or a configured profile. */
export function parseClaudePool(raw: string, profileIds: readonly string[]): PoolMember[] {
  const members = raw.split(",").map((entry) => entry.trim()).filter(Boolean).map((entry) => {
    const [id = "", weight = ""] = entry.split("=").map((part) => part.trim());
    if (!/^[1-9]\d{0,3}$/.test(weight)) throw new Error(`Claude pool weights must be whole numbers from 1 to 9999: ${entry}.`);
    if (id !== PERSONAL_ACCOUNT && !profileIds.includes(id)) throw new Error(`Claude pool member ${id} is not personal or a configured Claude profile.`);
    return { id, weight: Number(weight) };
  });
  if (!members.length) throw new Error("Claude pool is empty.");
  if (new Set(members.map((member) => member.id)).size !== members.length) throw new Error("Claude pool members must be unique.");
  return members;
}

/**
 * Smooth weighted round-robin over accounts, so even one-at-a-time sessions
 * (Mission workers) spread across every account in proportion to its weight.
 * An account that hit a rate or usage limit sits out until its cooldown ends.
 */
export class ClaudePool {
  private readonly current = new Map<string, number>();
  private readonly coolUntil = new Map<string, number>();

  constructor(readonly members: readonly PoolMember[], private readonly now: () => number = Date.now) {}

  pick(eligible?: ReadonlySet<string>): string {
    const at = this.now();
    const ready = this.members.filter((member) => (this.coolUntil.get(member.id) ?? 0) <= at && (!eligible || eligible.has(member.id)));
    if (!ready.length) {
      if (eligible && this.members.some(member => !this.isCooling(member.id))) throw new BridgeError(503, "pool_selection_unavailable", "No eligible configured account can take this assignment.");
      const earliest = Math.min(...this.members.map(member => this.coolUntil.get(member.id) ?? at));
      throw new BridgeError(429, "rate_limit_error", "All configured accounts are cooling. Retry after the earliest recovery.",
        { retry_after: Math.max(1, Math.ceil((earliest - at) / 1000)), usage_limit: true });
    }
    const total = ready.reduce((sum, member) => sum + member.weight, 0);
    let best = ready[0]!;
    for (const member of ready) {
      this.current.set(member.id, (this.current.get(member.id) ?? 0) + member.weight);
      if (this.current.get(member.id)! > this.current.get(best.id)!) best = member;
    }
    this.current.set(best.id, this.current.get(best.id)! - total);
    return best.id;
  }

  isCooling(id: string): boolean {
    return (this.coolUntil.get(id) ?? 0) > this.now();
  }

  cool(id: string, seconds: number): void {
    this.coolUntil.set(id, Math.max(this.coolUntil.get(id) ?? 0, this.now() + seconds * 1000));
  }

  /** Restore an observed deadline without shortening any current provider wait. */
  restoreCooldown(id: string, until: string): void {
    const at = Date.parse(until);
    if (!this.members.some(member => member.id === id) || !Number.isFinite(at)) return;
    this.coolUntil.set(id, Math.max(this.coolUntil.get(id) ?? 0, at));
  }

  status(): Array<PoolMember & { coolingUntil?: string }> {
    const at = this.now();
    return this.members.map((member) => {
      const until = this.coolUntil.get(member.id) ?? 0;
      return until > at ? { ...member, coolingUntil: new Date(until).toISOString() } : { ...member };
    });
  }
}
