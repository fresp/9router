// Cloudflare Workers AI serves TypeSafe's Jev as `typesafe/jev` on /ai/run/{model}. That endpoint
// wraps the model output as { success, result: {...} }, while the smart router reads `answers`
// at the top level, so the envelope has to be removed before the response is handed back.
import { afterEach, describe, expect, it, vi } from "vitest";
import REGISTRY from "../../open-sse/providers/registry/index.js";
import { handleSystemoneCore } from "../../open-sse/handlers/systemoneCore.js";
import { parseSystemOneRouteAnswer } from "../../open-sse/services/systemoneRouter.js";

const credentials = { apiKey: "token", providerSpecificData: { accountId: "acc123" } };
const body = { model: "typesafe/jev", state: "s", questions: { route: { type: "choice", instructions: "i", criteria: { a: null, b: null } } } };
const answers = { route: { type: "choice", choice: "b", confidence: 0.97, probabilities: { a: 0.03, b: 0.97 } } };

async function call(upstreamJson) {
  const fetchMock = vi.fn(async () => new Response(JSON.stringify(upstreamJson), { status: 200 }));
  vi.stubGlobal("fetch", fetchMock);
  const result = await handleSystemoneCore({ body, modelInfo: { provider: "cloudflare-ai", model: "typesafe/jev" }, credentials });
  const [url, init] = fetchMock.mock.calls[0];
  return { result, url, sent: JSON.parse(init.body), json: await result.response.json() };
}

describe("Cloudflare System One — typesafe/jev", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("is listed as a System One model", () => {
    const models = REGISTRY.find((e) => e.id === "cloudflare-ai").models;
    expect(models.find((m) => m.id === "typesafe/jev")?.kind).toBe("systemone");
  });

  it("posts to the account's /ai/run/typesafe/jev", async () => {
    const r = await call({ success: true, result: { answers } });
    expect(r.url).toBe("https://api.cloudflare.com/client/v4/accounts/acc123/ai/run/typesafe/jev");
    // The body carries only what the model's input schema defines; the model is in the path.
    expect(r.sent).toEqual({ state: "s", questions: body.questions });
  });

  it("unwraps the Cloudflare result envelope so the router can read the choice", async () => {
    const r = await call({ success: true, errors: [], result: { answers, usage: { input_tokens: 40, output_tokens: 0 } } });
    expect(parseSystemOneRouteAnswer(r.json)).toMatchObject({ choice: "b", confidence: 0.97 });
    expect(r.result.usage).toEqual({ prompt_tokens: 40, completion_tokens: 0 });
  });

  it("still sends the short model selector for Clef Flash", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ answers }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    await handleSystemoneCore({ body, modelInfo: { provider: "cloudflare-ai", model: "@cf/cloudflare/clef-flash" }, credentials });
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).model).toBe("clef-flash");
  });

  it("leaves an unwrapped response as it is", async () => {
    const r = await call({ answers });
    expect(parseSystemOneRouteAnswer(r.json)).toMatchObject({ choice: "b" });
  });
});
