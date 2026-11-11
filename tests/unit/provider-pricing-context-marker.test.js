import { describe, it, expect } from "vitest";
import { getPricingForModel, MODEL_PRICING } from "open-sse/providers/pricing.js";

describe("pricing for extended-context model ids", () => {
  it("prices a [1m] id as its base model", () => {
    expect(getPricingForModel("codex", "gpt-6-sol[1m]")).toEqual(MODEL_PRICING["gpt-6-sol"]);
    expect(getPricingForModel("codex", "gpt-6-luna[1m]")).toEqual(MODEL_PRICING["gpt-6-luna"]);
  });

  it("does not fall through to a generic pattern for a [1m] id", () => {
    expect(getPricingForModel("codex", "gpt-5.6-sol[1m]")).toEqual(MODEL_PRICING["gpt-5.6-sol"]);
  });

  it("leaves ids without a marker unchanged", () => {
    expect(getPricingForModel("codex", "gpt-6-sol")).toEqual(MODEL_PRICING["gpt-6-sol"]);
    expect(getPricingForModel("codex", "no-such-model[1m]")).toBeNull();
  });
});
