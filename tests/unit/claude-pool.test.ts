import { describe, expect, it } from "vitest";
import { ClaudePool, parseClaudePool } from "../../src/upstream/claude-pool.js";

describe("Claude account pool", () => {
  it("spreads one-at-a-time sessions across accounts in proportion to weight", () => {
    const pool = new ClaudePool([{ id: "personal", weight: 10 }, { id: "pro", weight: 5 }, { id: "std", weight: 1 }]);
    const picks = Array.from({ length: 32 }, () => pool.pick());
    const count = (id: string) => picks.filter((pick) => pick === id).length;
    expect([count("personal"), count("pro"), count("std")]).toEqual([20, 10, 2]);
    // Interleaved rather than ten personal picks in a row.
    expect(picks.slice(0, 4)).toContain("pro");
  });

  it("skips cooling accounts and reports the next recovery instead of sending more work", () => {
    let clock = 0;
    const pool = new ClaudePool([{ id: "personal", weight: 10 }, { id: "pro", weight: 1 }], () => clock);
    pool.cool("personal", 600);
    expect(Array.from({ length: 5 }, () => pool.pick())).toEqual(["pro", "pro", "pro", "pro", "pro"]);
    pool.cool("pro", 60);
    expect(() => pool.pick()).toThrow("All configured accounts are cooling");
    expect(pool.status()).toEqual([{ id: "personal", weight: 10, coolingUntil: new Date(600_000).toISOString() }, { id: "pro", weight: 1, coolingUntil: new Date(60_000).toISOString() }]);
    clock = 600_001;
    expect(pool.isCooling("personal")).toBe(false);
    expect(new Set(Array.from({ length: 11 }, () => pool.pick()))).toEqual(new Set(["personal", "pro"]));
  });

  it("accepts only personal or configured profiles with whole-number weights", () => {
    expect(parseClaudePool("personal=10, team1-pro=5", ["team1-pro"])).toEqual([{ id: "personal", weight: 10 }, { id: "team1-pro", weight: 5 }]);
    for (const bad of ["team9=1", "personal=0", "personal=1.5", "personal=2,personal=3", ""]) {
      expect(() => parseClaudePool(bad, ["team1-pro"])).toThrow(/Claude pool/);
    }
  });
});
