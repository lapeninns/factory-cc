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

  pick(): string {
    const at = this.now();
    const ready = this.members.filter((member) => (this.coolUntil.get(member.id) ?? 0) <= at);
    // Every account is cooling: use the one that recovers first rather than refuse work.
    if (!ready.length) return [...this.members].sort((a, b) => this.coolUntil.get(a.id)! - this.coolUntil.get(b.id)!)[0]!.id;
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

  status(): Array<PoolMember & { coolingUntil?: string }> {
    const at = this.now();
    return this.members.map((member) => {
      const until = this.coolUntil.get(member.id) ?? 0;
      return until > at ? { ...member, coolingUntil: new Date(until).toISOString() } : { ...member };
    });
  }
}
