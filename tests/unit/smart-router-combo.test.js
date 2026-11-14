// A smart-routed chat combo can name a router combo (a combo of kind "systemone") as its
// router. resolveSmartChoice then asks the combo's System One models in order:
//   - the next router is tried only when one cannot be reached (quota, balance, timeout,
//     unreadable answer); a low-confidence answer is still the decision and is returned;
//   - all attempts share one time budget, split so a hanging router cannot starve the next;
//   - 402/429 put the router's account on the usual cooldown, a timeout or 5xx does not.
// Before this, a combo name as router model ended as "router_model_unknown".
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getComboByName: vi.fn(),
  getModelInfo: vi.fn(),
  getProviderCredentials: vi.fn(),
  markAccountUnavailable: vi.fn(),
  clearAccountError: vi.fn(),
  checkAndRefreshToken: vi.fn(),
  handleSystemoneCore: vi.fn(),
}));

vi.mock("@/lib/localDb", () => ({ getComboByName: mocks.getComboByName }));
vi.mock("@/sse/services/model.js", () => ({ getModelInfo: mocks.getModelInfo }));
vi.mock("@/sse/services/auth.js", () => ({
  getProviderCredentials: mocks.getProviderCredentials,
  markAccountUnavailable: mocks.markAccountUnavailable,
  clearAccountError: mocks.clearAccountError,
}));
vi.mock("@/sse/services/tokenRefresh.js", () => ({ checkAndRefreshToken: mocks.checkAndRefreshToken }));
vi.mock("open-sse/handlers/systemoneCore.js", () => ({ handleSystemoneCore: mocks.handleSystemoneCore }));

import { resolveSmartChoice, resolveRouterChain } from "@/sse/services/systemoneRouter.js";

const CF = "cf/@cf/cloudflare/clef";
const OC = "oc/jev-1.13-free";
const body = { messages: [{ role: "user", content: "Trace the goroutine leak and fix it." }] };
const models = ["oca-fast", "oca-deep"];

const ok = (choice, confidence) => ({
  success: true,
  response: new Response(JSON.stringify({ answers: { route: { type: "choice", choice, confidence, probabilities: { [choice]: confidence } } } })),
});
const fail = (status, error) => ({ success: false, status, error, response: new Response("{}", { status }) });
const asked = () => mocks.handleSystemoneCore.mock.calls.map(([arg]) => `${arg.modelInfo.provider}/${arg.modelInfo.model}`);

function logger() {
  const lines = [];
  return { lines, info: (_t, m) => lines.push(m), warn: (_t, m) => lines.push(m), debug: () => {} };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getComboByName.mockImplementation(async (name) => {
    if (name === "oca-router") return { id: "1", name, kind: "systemone", models: [CF, OC] };
    if (name === "empty-router") return { id: "2", name, kind: "systemone", models: [] };
    if (name === "chat-combo") return { id: "3", name, kind: null, models: ["cc/claude-opus-5-5"] };
    return null;
  });
  mocks.getModelInfo.mockImplementation(async (m) => {
    if (m === CF) return { provider: "cloudflare-ai", model: "@cf/cloudflare/clef" };
    if (m === OC) return { provider: "opencode", model: "jev-1.13-free" };
    return { provider: null, model: m };
  });
  mocks.getProviderCredentials.mockImplementation(async (provider) => ({ connectionId: `conn-${provider}`, apiKey: "k" }));
  mocks.checkAndRefreshToken.mockImplementation(async (_p, c) => c);
  mocks.markAccountUnavailable.mockResolvedValue({ shouldFallback: true, cooldownMs: 2000 });
  mocks.clearAccountError.mockResolvedValue();
});

describe("resolveRouterChain", () => {
  it("expands a router combo to its models", async () => {
    expect(await resolveRouterChain("oca-router")).toEqual({ name: "oca-router", models: [CF, OC] });
  });
  it("treats a model, and a chat combo, as a single router", async () => {
    expect(await resolveRouterChain(CF)).toEqual({ name: null, models: [CF] });
    expect(await resolveRouterChain("chat-combo")).toEqual({ name: null, models: ["chat-combo"] });
  });
});

describe("resolveSmartChoice with a router combo", () => {
  it("returns the first router's answer and does not ask the second", async () => {
    mocks.handleSystemoneCore.mockResolvedValueOnce(ok("oca-deep", 0.95));
    const r = await resolveSmartChoice({ body, models, routerModel: "oca-router" });
    expect(r).toMatchObject({ choice: "oca-deep", confidence: 0.95, router: CF });
    expect(asked()).toEqual(["cloudflare-ai/@cf/cloudflare/clef"]);
  });

  it("keeps a low-confidence answer instead of asking the next router", async () => {
    mocks.handleSystemoneCore.mockResolvedValueOnce(ok("oca-fast", 0.41));
    const r = await resolveSmartChoice({ body, models, routerModel: "oca-router" });
    expect(r).toMatchObject({ choice: "oca-fast", confidence: 0.41, router: CF });
    expect(mocks.handleSystemoneCore).toHaveBeenCalledTimes(1);
  });

  it("moves to the next router on 429 and puts the failed one on cooldown", async () => {
    mocks.handleSystemoneCore
      .mockResolvedValueOnce(fail(429, "daily neuron allocation exceeded"))
      .mockResolvedValueOnce(ok("oca-deep", 0.97));
    const log = logger();
    const r = await resolveSmartChoice({ body, models, routerModel: "oca-router", log });
    expect(r).toMatchObject({ choice: "oca-deep", router: OC });
    expect(mocks.markAccountUnavailable).toHaveBeenCalledWith("conn-cloudflare-ai", 429, "daily neuron allocation exceeded", "cloudflare-ai", "@cf/cloudflare/clef");
    expect(log.lines.some((l) => l.includes("oca-router 1/2") && l.includes("(429): daily neuron allocation exceeded"))).toBe(true);
  });

  it("puts 402 on cooldown too, but not a 5xx", async () => {
    mocks.handleSystemoneCore.mockResolvedValueOnce(fail(402, "Insufficient balance")).mockResolvedValueOnce(ok("oca-deep", 0.9));
    await resolveSmartChoice({ body, models, routerModel: "oca-router" });
    expect(mocks.markAccountUnavailable).toHaveBeenCalledTimes(1);

    vi.clearAllMocks();
    mocks.markAccountUnavailable.mockResolvedValue({});
    mocks.handleSystemoneCore.mockResolvedValueOnce(fail(503, "down")).mockResolvedValueOnce(ok("oca-deep", 0.9));
    const r = await resolveSmartChoice({ body, models, routerModel: "oca-router" });
    expect(r.router).toBe(OC);
    expect(mocks.markAccountUnavailable).not.toHaveBeenCalled();
  });

  it("skips a router whose accounts are all on cooldown without calling it", async () => {
    mocks.getProviderCredentials.mockImplementation(async (provider) =>
      provider === "cloudflare-ai" ? { allRateLimited: true } : { connectionId: "noauth" });
    mocks.handleSystemoneCore.mockResolvedValueOnce(ok("oca-deep", 0.97));
    const r = await resolveSmartChoice({ body, models, routerModel: "oca-router" });
    expect(r.router).toBe(OC);
    expect(asked()).toEqual(["opencode/jev-1.13-free"]);
  });

  it("gives a hanging router only its share of the budget", async () => {
    mocks.handleSystemoneCore
      .mockImplementationOnce(() => new Promise(() => {}))
      .mockResolvedValueOnce(ok("oca-deep", 0.97));
    const started = Date.now();
    const r = await resolveSmartChoice({ body, models, routerModel: "oca-router", timeoutMs: 400 });
    expect(r.router).toBe(OC);
    expect(Date.now() - started).toBeLessThan(400);
    expect(mocks.markAccountUnavailable).not.toHaveBeenCalled();
  });

  it("returns no decision with the last failure when every router fails", async () => {
    mocks.handleSystemoneCore.mockResolvedValueOnce(fail(429, "limit")).mockResolvedValueOnce(fail(503, "down"));
    const r = await resolveSmartChoice({ body, models, routerModel: "oca-router" });
    expect(r).toMatchObject({ choice: null, failure: "http_503" });
  });

  it("treats an unreadable answer as a failure and moves on", async () => {
    mocks.handleSystemoneCore
      .mockResolvedValueOnce({ success: true, response: new Response(JSON.stringify({ answers: {} })) })
      .mockResolvedValueOnce(ok("oca-fast", 0.9));
    const r = await resolveSmartChoice({ body, models, routerModel: "oca-router" });
    expect(r).toMatchObject({ choice: "oca-fast", router: OC });
  });

  it("reports an empty router combo as an unknown router", async () => {
    const r = await resolveSmartChoice({ body, models, routerModel: "empty-router" });
    expect(r).toMatchObject({ choice: null, failure: "router_model_unknown" });
    expect(mocks.handleSystemoneCore).not.toHaveBeenCalled();
  });
});

describe("resolveSmartChoice with a single router model", () => {
  it("behaves as before and keeps the whole budget", async () => {
    mocks.handleSystemoneCore.mockResolvedValueOnce(ok("oca-fast", 0.9));
    const r = await resolveSmartChoice({ body, models, routerModel: OC });
    expect(r).toMatchObject({ choice: "oca-fast", router: OC });
    expect(mocks.getComboByName).not.toHaveBeenCalled();
  });

  it("still fails open for a chat combo named as router", async () => {
    const r = await resolveSmartChoice({ body, models, routerModel: "chat-combo" });
    expect(r).toMatchObject({ choice: null, failure: "router_model_unknown" });
  });
});
