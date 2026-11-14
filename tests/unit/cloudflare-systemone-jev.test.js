// Cloudflare Workers AI serves TypeSafe's Jev as the third-party model `typesafe/jev`. Per the
// Cloudflare docs it is called on the generic run endpoint, with the model named in the body and
// the System One payload under `input`:
//   POST /accounts/{id}/ai/run   { "model": "typesafe/jev", "input": { "state", "questions" } }
// The reply is the plain System One shape ({ model, answers, usage }). Sending the payload at the
// top level of /ai/run/{model} was rejected with 400.
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

  it("posts to the account's /ai/run with the model and an input envelope", async () => {
    const r = await call({ model: "jev-1.13.0", answers, usage: { input_tokens: 40, output_tokens: 7 } });
    expect(r.url).toBe("https://api.cloudflare.com/client/v4/accounts/acc123/ai/run");
    expect(r.sent).toEqual({ model: "typesafe/jev", input: { state: "s", questions: body.questions } });
    expect(parseSystemOneRouteAnswer(r.json)).toMatchObject({ choice: "b", confidence: 0.97 });
    expect(r.result.usage).toEqual({ prompt_tokens: 40, completion_tokens: 7 });
  });

  it("unwraps the Cloudflare result envelope so the router can read the choice", async () => {
    const r = await call({ success: true, errors: [], result: { answers, usage: { input_tokens: 40, output_tokens: 0 } } });
    expect(parseSystemOneRouteAnswer(r.json)).toMatchObject({ choice: "b", confidence: 0.97 });
    expect(r.result.usage).toEqual({ prompt_tokens: 40, completion_tokens: 0 });
  });

  it("calls Clef on its own path with the short model selector", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ success: true, result: { answers } }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const result = await handleSystemoneCore({ body, modelInfo: { provider: "cloudflare-ai", model: "@cf/cloudflare/clef" }, credentials });
    expect(fetchMock.mock.calls[0][0]).toBe("https://api.cloudflare.com/client/v4/accounts/acc123/ai/run/@cf/cloudflare/clef");
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ ...body, model: "clef" });
    expect(parseSystemOneRouteAnswer(await result.response.json())).toMatchObject({ choice: "b" });
  });

  it("still sends the short model selector for Clef Flash", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ answers }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    await handleSystemoneCore({ body, modelInfo: { provider: "cloudflare-ai", model: "@cf/cloudflare/clef-flash" }, credentials });
    expect(fetchMock.mock.calls[0][0]).toBe("https://api.cloudflare.com/client/v4/accounts/acc123/ai/run/@cf/cloudflare/clef-flash");
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ ...body, model: "clef-flash" });
  });

  it("leaves an unwrapped response as it is", async () => {
    const r = await call({ answers });
    expect(parseSystemOneRouteAnswer(r.json)).toMatchObject({ choice: "b" });
  });
});
