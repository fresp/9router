import { describe, it, expect } from "vitest";
import { splitCostByRate, calculateCostFromTokens, MODEL_PRICING } from "open-sse/providers/pricing.js";

const pricing = MODEL_PRICING["gpt-6-sol"];
const tokens = { prompt_tokens: 1_000_000, cached_tokens: 900_000, completion_tokens: 10_000 };

describe("splitCostByRate", () => {
  it("splits by rate and sums to the total", () => {
    const cost = calculateCostFromTokens(tokens, pricing);
    const parts = splitCostByRate(cost, tokens, pricing);
    expect(parts.inputCost).toBeCloseTo(100_000 * pricing.input / 1e6, 10);
    expect(parts.cachedCost).toBeCloseTo(900_000 * pricing.cached / 1e6, 10);
    expect(parts.outputCost).toBeCloseTo(10_000 * pricing.output / 1e6, 10);
    expect(parts.inputCost + parts.cachedCost + parts.outputCost).toBeCloseTo(cost, 10);
  });

  it("scales to a stored cost that differs from current rates", () => {
    const parts = splitCostByRate(1, tokens, pricing);
    expect(parts.inputCost + parts.cachedCost + parts.outputCost).toBeCloseTo(1, 10);
  });

  it("returns null without a cost or usable pricing", () => {
    expect(splitCostByRate(0, tokens, pricing)).toBeNull();
    expect(splitCostByRate(1, tokens, null)).toBeNull();
    expect(splitCostByRate(1, tokens, { input: 0, output: 0, cached: 0 })).toBeNull();
  });
});
