import { getModelInfo } from "../services/model.js";
import { getProviderCredentials } from "../services/auth.js";
import { checkAndRefreshToken } from "../services/tokenRefresh.js";
import { handleSystemoneCore } from "open-sse/handlers/systemoneCore.js";
import {
  DEFAULT_SYSTEMONE_ROUTER_MODEL,
  DEFAULT_SYSTEMONE_TIMEOUT_MS,
  extractPromptState,
  buildChoiceCriteria,
  resolveRouteInstructions,
  parseSystemOneRouteAnswer,
} from "open-sse/services/systemoneRouter.js";

/**
 * Dispatch an in-process System One decision evaluation for a combo request.
 * Resolves the configured router model's provider and credentials, sends the choice
 * query with a short timeout, and returns the parsed routing decision.
 *
 * Never throws: on missing credentials, timeout, or upstream failure, returns a result
 * without a choice (and a `failure` code) so combo dispatch fails open to standard model ordering.
 *
 * @param {object} opts
 * @param {object} opts.body - Client request body
 * @param {string[]} opts.models - Combo model candidate array
 * @param {string} [opts.routerModel] - System One router model (defaults to oc/jev-1.13-free)
 * @param {string} [opts.routerInstructions] - Per-combo question/rubric (defaults to the generic question)
 * @param {Record<string, string>} [opts.memberDescriptions] - Per-member "when to pick" descriptions
 * @param {object} [opts.log] - Logger
 * @param {number} [opts.timeoutMs=DEFAULT_SYSTEMONE_TIMEOUT_MS] - Hard ceiling for router evaluation
 * @returns {Promise<{ choice: string|null, confidence: number|null, probabilities: Record<string, number>|null, failure?: string } | null>}
 */
// No routing decision: the combo falls back to its configured order. `failure` says why,
// for the per-combo usage statistics.
function noDecision(failure) {
  return { choice: null, confidence: null, probabilities: null, failure };
}

export async function resolveSmartChoice({
  body,
  models,
  routerModel = DEFAULT_SYSTEMONE_ROUTER_MODEL,
  routerInstructions,
  memberDescriptions,
  log,
  timeoutMs = DEFAULT_SYSTEMONE_TIMEOUT_MS,
}) {
  if (!Array.isArray(models) || models.length <= 1) return null;

  const targetModel = (typeof routerModel === "string" && routerModel.trim())
    ? routerModel.trim()
    : DEFAULT_SYSTEMONE_ROUTER_MODEL;

  const state = extractPromptState(body);
  if (!state) {
    log?.debug?.("COMBO", "smart-router: empty prompt state, skipping classification");
    return noDecision("no_prompt");
  }

  const criteria = buildChoiceCriteria(models, memberDescriptions);
  if (Object.keys(criteria).length === 0) return null;

  try {
    const modelInfo = await getModelInfo(targetModel);
    if (!modelInfo?.provider) {
      log?.warn?.("COMBO", `smart-router: unrecognized router model "${targetModel}"`);
      return noDecision("router_model_unknown");
    }

    const { provider, model } = modelInfo;
    const credentials = await getProviderCredentials(provider, new Set(), model);
    if (!credentials || credentials.allRateLimited) {
      log?.warn?.("COMBO", `smart-router: no credentials available for router provider "${provider}"`);
      return noDecision("no_credentials");
    }

    const refreshedCredentials = await checkAndRefreshToken(provider, credentials);
    const systemoneBody = {
      model,
      state,
      questions: {
        route: {
          type: "choice",
          instructions: resolveRouteInstructions(routerInstructions),
          criteria,
        },
      },
    };

    let timeoutId;
    const timeoutPromise = new Promise((_, reject) => {
      timeoutId = setTimeout(() => reject(Object.assign(new Error(`System One router timed out after ${timeoutMs}ms`), { code: "timeout" })), timeoutMs);
    });

    const corePromise = handleSystemoneCore({
      body: systemoneBody,
      modelInfo: { provider, model },
      credentials: refreshedCredentials,
      log,
      onRequestSuccess: () => {},
    });

    let result;
    try {
      result = await Promise.race([corePromise, timeoutPromise]);
    } finally {
      clearTimeout(timeoutId);
    }

    if (!result?.success || !result.response) {
      // The upstream text says which field or permission was rejected; the status alone does not.
      const detail = typeof result?.error === "string" ? result.error.replace(/\s+/g, " ").trim().slice(0, 300) : "";
      log?.warn?.("COMBO", `smart-router: evaluation failed (${result?.status || "error"})${detail ? `: ${detail}` : ""}`);
      return noDecision(Number.isInteger(result?.status) ? `http_${result.status}` : "upstream_error");
    }

    const json = await result.response.json();
    const route = parseSystemOneRouteAnswer(json);
    if (!route || !route.choice) {
      log?.warn?.("COMBO", "smart-router: response missing valid route choice");
      return noDecision("invalid_response");
    }

    return route;
  } catch (err) {
    log?.warn?.("COMBO", `smart-router: evaluation aborted (${err?.message || String(err)})`);
    return noDecision(err?.code === "timeout" ? "timeout" : "error");
  }
}
