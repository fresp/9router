import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, afterEach, vi } from "vitest";
import { validateModelAliasName, getAliasesForModel } from "@/shared/utils/modelAlias.js";

const originalDataDir = process.env.DATA_DIR;
const NODE_ID = "openai-compatible-chat-alias-test";

async function setup() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-model-alias-"));
  process.env.DATA_DIR = tempDir;
  vi.resetModules();
  const models = await import("@/models/index.js");
  const { getModelInfo } = await import("@/sse/services/model.js");
  const route = await import("@/app/api/models/alias/route.js");
  await models.createProviderNode({
    id: NODE_ID,
    type: "openai-compatible",
    name: "AI Proxy",
    prefix: "ai-proxy",
    apiType: "chat",
    baseUrl: "https://compatible.test/v1",
  });
  const put = (body) => route.PUT(new Request("http://localhost/api/models/alias", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }));
  return { models, getModelInfo, put, cleanup: () => fs.rmSync(tempDir, { recursive: true, force: true }) };
}

describe("model alias", () => {
  let cleanup = () => {};

  afterEach(() => {
    vi.resetModules();
    cleanup();
    cleanup = () => {};
    if (originalDataDir === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = originalDataDir;
  });

  it("validates alias names", () => {
    expect(validateModelAliasName("heavy")).toBeNull();
    expect(validateModelAliasName("gpt-4o.mini:v2")).toBeNull();
    expect(validateModelAliasName("")).toBeTruthy();
    expect(validateModelAliasName("a/b")).toBeTruthy();
    expect(validateModelAliasName("has space")).toBeTruthy();
    expect(validateModelAliasName("-leading")).toBeTruthy();
    expect(validateModelAliasName("x".repeat(101))).toBeTruthy();
  });

  it("collects aliases of a model across provider prefixes", () => {
    const aliases = { b: "ai-proxy/m", a: `${NODE_ID}/m`, other: `${NODE_ID}/n` };
    expect(getAliasesForModel(aliases, "m", [NODE_ID, "ai-proxy"])).toEqual(["a", "b"]);
  });

  it("routes an alias to a provider node by node id or by prefix", async () => {
    const ctx = await setup();
    cleanup = ctx.cleanup;

    expect((await ctx.put({ alias: "heavy", model: `${NODE_ID}/heavy-coding-shared` })).status).toBe(200);
    expect((await ctx.put({ alias: "daily", model: "ai-proxy/daily-coding-shared" })).status).toBe(200);

    await expect(ctx.getModelInfo("heavy")).resolves.toEqual({ provider: NODE_ID, model: "heavy-coding-shared" });
    await expect(ctx.getModelInfo("daily")).resolves.toEqual({ provider: NODE_ID, model: "daily-coding-shared" });
  });

  it("rejects invalid, reserved, combo-shadowing and re-pointed aliases", async () => {
    const ctx = await setup();
    cleanup = ctx.cleanup;
    await ctx.models.createCombo({ name: "main", models: ["openai/gpt-4o"] });

    expect((await ctx.put({ alias: "a/b", model: "openai/gpt-4o" })).status).toBe(400);
    expect((await ctx.put({ alias: "ok", model: "bare-model" })).status).toBe(400);
    expect((await ctx.put({ alias: "openai", model: "openai/gpt-4o" })).status).toBe(409);
    expect((await ctx.put({ alias: "main", model: "openai/gpt-4o" })).status).toBe(409);

    expect((await ctx.put({ alias: "fast", model: "openai/gpt-4o" })).status).toBe(200);
    expect((await ctx.put({ alias: "fast", model: "openai/gpt-4o" })).status).toBe(200);
    expect((await ctx.put({ alias: "fast", model: "openai/gpt-4o-mini" })).status).toBe(409);
    expect((await ctx.models.getModelAliases()).fast).toBe("openai/gpt-4o");
  });
});
