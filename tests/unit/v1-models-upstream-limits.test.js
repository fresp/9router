import { describe, expect, it, vi } from "vitest";
import { extractUpstreamLimits, sanitizeLimits } from "../../src/shared/utils/modelLimits.js";

const db = vi.hoisted(() => ({
  getProviderConnections: vi.fn(),
  getCombos: vi.fn(async () => []),
  getCustomModels: vi.fn(async () => []),
  getModelAliases: vi.fn(async () => ({})),
}));

vi.mock("@/lib/localDb", () => db);
vi.mock("@/lib/disabledModelsDb", () => ({
  getDisabledModels: vi.fn(async () => ({})),
}));

const { buildModelsList } = await import("../../src/app/api/v1/models/route.js");

const PROVIDER_ID = "openai-compatible-chat-test";
const MODEL_ID = "deepseek-4.1-flash-shared";

function connection() {
  return {
    id: 1,
    provider: PROVIDER_ID,
    isActive: true,
    apiKey: "sk-test",
    providerSpecificData: { prefix: "nbl", baseUrl: "https://upstream.invalid/v1" },
  };
}

describe("extractUpstreamLimits", () => {
  it("reads OpenRouter-style snake_case limits", () => {
    expect(extractUpstreamLimits({
      id: MODEL_ID,
      context_length: 1000000,
      max_input_tokens: 872000,
      max_output_tokens: 50000,
    })).toEqual({ contextWindow: 1000000, maxOutput: 50000 });
  });

  it("falls back to max_input_tokens and the camelCase capabilities block", () => {
    expect(extractUpstreamLimits({ max_input_tokens: 872000 })).toEqual({ contextWindow: 872000 });
    expect(extractUpstreamLimits({ capabilities: { contextWindow: 400000, maxOutput: 32000 } }))
      .toEqual({ contextWindow: 400000, maxOutput: 32000 });
  });

  it("returns null when the upstream declares nothing usable", () => {
    expect(extractUpstreamLimits({ id: MODEL_ID })).toBeNull();
    expect(extractUpstreamLimits({ context_length: "lots", max_output_tokens: -1 })).toBeNull();
    expect(sanitizeLimits({ contextWindow: 1e12, maxOutput: { $gt: 0 } })).toBeNull();
  });
});

describe("/v1/models upstream-declared limits", () => {
  it("keeps the name-pattern floor when no limits were stored", async () => {
    db.getProviderConnections.mockResolvedValue([connection()]);
    db.getCustomModels.mockResolvedValue([{ providerAlias: PROVIDER_ID, id: MODEL_ID, type: "llm" }]);

    const models = await buildModelsList(["llm"], { skipDynamicFetch: true });
    const published = models.find((model) => model.id === `nbl/${MODEL_ID}`);

    expect(published.context_length).toBe(128000);
  });

  it("publishes the limits stored with an imported compatible model", async () => {
    db.getProviderConnections.mockResolvedValue([connection()]);
    db.getCustomModels.mockResolvedValue([{
      providerAlias: PROVIDER_ID,
      id: MODEL_ID,
      type: "llm",
      limits: { contextWindow: 1000000, maxOutput: 50000 },
    }]);

    const models = await buildModelsList(["llm"], { skipDynamicFetch: true });
    const published = models.find((model) => model.id === `nbl/${MODEL_ID}`);

    expect(published).toMatchObject({
      context_length: 1000000,
      max_completion_tokens: 50000,
      capabilities: { contextWindow: 1000000, maxOutput: 50000, thinkingFormat: "deepseek" },
    });
  });

  it("applies the stored limits to a combo seat addressed by the connection prefix", async () => {
    db.getProviderConnections.mockResolvedValue([connection()]);
    db.getCustomModels.mockResolvedValue([{
      providerAlias: PROVIDER_ID,
      id: MODEL_ID,
      type: "llm",
      limits: { contextWindow: 1000000, maxOutput: 50000 },
    }]);
    db.getCombos.mockResolvedValueOnce([{ name: "flash-combo", models: [`nbl/${MODEL_ID}`] }]);

    const models = await buildModelsList(["llm"], { skipDynamicFetch: true });
    const combo = models.find((model) => model.id === "flash-combo");

    expect(combo).toMatchObject({
      context_length: 1000000,
      max_completion_tokens: 50000,
      capabilities: { contextWindow: 1000000 },
    });
  });
});
