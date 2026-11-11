import { describe, it, expect, beforeAll } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Isolated DB: must be set before the db layer is first imported.
process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "9r-recalc-"));

const tokens = { prompt_tokens: 100000, cached_tokens: 90000, completion_tokens: 200 };
// gpt-6-sol rates: $2 input, $0.20 cached, $10 output per 1M tokens.
const SOL_COST_PER_REQUEST = (10000 * 2 + 90000 * 0.2 + 200 * 10) / 1e6;
const daysAgo = (d) => new Date(Date.now() - d * 86400000 - 60000).toISOString();
const findModel = (stats, model) => Object.values(stats.byModel).find((m) => m.rawModel === model);

let repo;
let db;

describe("recalculateUsageCosts", () => {
  beforeAll(async () => {
    repo = await import("../../src/lib/db/repos/usageRepo.js");
    db = await (await import("../../src/lib/db/driver.js")).getAdapter();

    const save = (provider, model, i, d) => repo.saveRequestUsage({
      provider, model, endpoint: "/v1/chat/completions", apiKey: "sk-test-key-0000000000",
      timestamp: daysAgo(d), tokens: { ...tokens, prompt_tokens: tokens.prompt_tokens + i },
    });
    for (let i = 0; i < 6; i++) await save("codex", "gpt-6-sol[1m]", i, i % 3);
    for (let i = 0; i < 2; i++) await save("nabil", "heavy-coding-shared", i, i);
    for (let i = 0; i < 2; i++) await save("codex", "gpt-6-luna", i, i);

    // Recreate the state before [1m] ids were priced: rows at $0 and rollups
    // that carry neither that cost nor a per-rate split.
    db.run(`UPDATE usageHistory SET cost = 0 WHERE model = 'gpt-6-sol[1m]'`);
    for (const d of db.all(`SELECT dateKey, data FROM usageDaily`)) {
      const day = JSON.parse(d.data);
      for (const group of ["byProvider", "byModel", "byAccount", "byApiKey", "byEndpoint", "byCombo"]) {
        for (const v of Object.values(day[group] || {})) {
          if (v.rawModel === "gpt-6-sol[1m]") v.cost = 0;
          delete v.inputCost; delete v.cachedCost; delete v.outputCost;
        }
      }
      db.run(`UPDATE usageDaily SET data = ? WHERE dateKey = ?`, [JSON.stringify(day), d.dateKey]);
    }
  });

  it("prices $0 rows, rebuilds rollups with a per-rate split, and leaves priced rows alone", async () => {
    expect(findModel(await repo.getUsageStats("7d"), "gpt-6-sol[1m]").cost).toBe(0);
    const lunaBefore = db.get(`SELECT SUM(cost) c FROM usageHistory WHERE model = 'gpt-6-luna'`).c;

    const result = await repo.recalculateUsageCosts();
    expect(result).toMatchObject({ rowsScanned: 10, rowsRepriced: 6, daysSkipped: 0 });
    expect(result.costAdded).toBeCloseTo(6 * SOL_COST_PER_REQUEST, 4);

    for (const period of ["7d", "24h"]) {
      const stats = await repo.getUsageStats(period);
      const sol = findModel(stats, "gpt-6-sol[1m]");
      expect(sol.cost).toBeCloseTo(sol.requests * SOL_COST_PER_REQUEST, 4);
      expect(sol.inputCost + sol.cachedCost + sol.outputCost).toBeCloseTo(sol.cost, 8);
      expect(sol.cachedCost).toBeCloseTo(sol.requests * 90000 * 0.2 / 1e6, 6);
      expect(sol.outputCost).toBeCloseTo(sol.requests * 200 * 10 / 1e6, 6);

      const unpriced = findModel(stats, "heavy-coding-shared");
      expect(unpriced.cost).toBe(0);
      expect(unpriced.inputCost).toBeUndefined();
    }

    expect((await repo.getUsageStats("7d")).totalRequests).toBe(10);
    expect(db.get(`SELECT SUM(cost) c FROM usageHistory WHERE model = 'gpt-6-luna'`).c).toBeCloseTo(lunaBefore, 12);
  });

  it("is idempotent", async () => {
    const result = await repo.recalculateUsageCosts();
    expect(result).toMatchObject({ rowsRepriced: 0, costAdded: 0, daysSkipped: 0 });
  });

  it("skips a day whose rollup counts more requests than history holds", async () => {
    const first = db.get(`SELECT dateKey, data FROM usageDaily ORDER BY dateKey ASC LIMIT 1`);
    const day = JSON.parse(first.data);
    day.requests += 50;
    db.run(`UPDATE usageDaily SET data = ? WHERE dateKey = ?`, [JSON.stringify(day), first.dateKey]);

    const result = await repo.recalculateUsageCosts();
    expect(result.daysSkipped).toBe(1);
    const after = JSON.parse(db.get(`SELECT data FROM usageDaily WHERE dateKey = ?`, [first.dateKey]).data);
    expect(after.requests).toBe(day.requests);
  });
});
