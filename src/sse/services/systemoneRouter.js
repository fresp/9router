import { getModelInfo } from "../services/model.js";
import { getProviderCredentials, markAccountUnavailable, clearAccountError } from "../services/auth.js";
import { checkAndRefreshToken } from "../services/tokenRefresh.js";
import { getComboByName } from "@/lib/localDb";
import { isRouterCombo } from "@/shared/constants/comboKinds.js";
import { handleSystemoneCore } from "open-sse/handlers/systemoneCore.js";
import {
  DEFAULT_SYSTEMONE_ROUTER_MODEL,
  DEFAULT_SYSTEMONE_TIMEOUT_MS,
  extractPromptState,
  buildChoiceCriteria,
  resolveRouteInstructions,
  parseSystemOneRouteAnswer,
} from "open-sse/services/systemoneRouter.js";

// Statuses that mean "this router stays down for a while" (quota, balance). They put the
// account on the usual cooldown so the next request skips it instead of failing again.
// A timeout or a 5xx is not in the list: one network blip must not bench a healthy router.
const COOLDOWN_STATUSES = new Set([402, 429]);
// Below this much budget a further router is not worth starting.
const MIN_ROUTER_ATTEMPT_MS = 250;

// No routing decision: the combo falls back to its configured order. `failure` says why,
// for the per-combo usage statistics.
function noDecision(failure) {
  return { choice: null, confidence: null, probabilities: null, failure };
}

/**
 * The System One models to ask, in order. A router combo (a combo of kind "systemone")
 * expands to its members; anything else is a single model.
 *
 * @param {string} routerModel
 * @returns {Promise<{ name: string|null, models: string[] }>} `name` is the router combo, if any
 */
export async function resolveRouterChain(routerModel) {
  if (!routerModel.includes("/")) {
    const combo = await getComboByName(routerModel);
    if (isRouterCombo(combo)) {
      const models = (combo.models || []).filter((m) => typeof m === "string" && m.trim()).map((m) => m.trim());
      return { name: combo.name, models };
    }
  }
  return { name: null, models: [routerModel] };
}

/**
 * Ask one System One model for the routing decision.
 * Never throws: returns `{ route }` or `{ failure }`.
 */
async function askRouter(targetModel, { state, criteria, routerInstructions, log, timeoutMs, label }) {
  try {
    const modelInfo = await getModelInfo(targetModel);
    if (!modelInfo?.provider) {
      log?.warn?.("COMBO", `smart-router${label}: unrecognized router model "${targetModel}"`);
      return { failure: "router_model_unknown" };
    }

    const { provider, model } = modelInfo;
    const credentials = await getProviderCredentials(provider, new Set(), model);
    if (!credentials || credentials.allRateLimited) {
      log?.warn?.("COMBO", `smart-router${label}: no credentials available for router provider "${provider}"`);
      return { failure: "no_credentials" };
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
      onRequestSuccess: async () => {
        await clearAccountError(credentials.connectionId, credentials, model);
      },
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
      log?.warn?.("COMBO", `smart-router${label}: evaluation failed (${result?.status || "error"})${detail ? `: ${detail}` : ""}`);
      if (COOLDOWN_STATUSES.has(result?.status)) {
        await markAccountUnavailable(credentials.connectionId, result.status, result.error, provider, model).catch(() => {});
      }
      return { failure: Number.isInteger(result?.status) ? `http_${result.status}` : "upstream_error" };
    }

    const json = await result.response.json();
    const route = parseSystemOneRouteAnswer(json);
    if (!route || !route.choice) {
      log?.warn?.("COMBO", `smart-router${label}: response missing valid route choice`);
      return { failure: "invalid_response" };
    }

    return { route };
  } catch (err) {
    log?.warn?.("COMBO", `smart-router${label}: evaluation aborted (${err?.message || String(err)})`);
    return { failure: err?.code === "timeout" ? "timeout" : "error" };
  }
}

/**
 * Dispatch an in-process System One decision evaluation for a combo request.
 * Resolves the configured router model's provider and credentials, sends the choice
 * query with a short timeout, and returns the parsed routing decision.
 *
 * The router model may be a router combo (kind "systemone"): its members are asked in
 * order and the first one that returns a readable decision wins. A member is skipped only
 * when it cannot be reached (quota, balance, timeout, bad response); a decision with low
 * confidence is still a decision and is returned as is. All attempts share `timeoutMs`.
 *
 * Never throws: on missing credentials, timeout, or upstream failure, returns a result
 * without a choice (and a `failure` code) so combo dispatch fails open to standard model ordering.
 *
 * @param {object} opts
 * @param {object} opts.body - Client request body
 * @param {string[]} opts.models - Combo model candidate array
 * @param {string} [opts.routerModel] - System One router model or router combo (defaults to oc/jev-1.13-free)
 * @param {string} [opts.routerInstructions] - Per-combo question/rubric (defaults to the generic question)
 * @param {Record<string, string>} [opts.memberDescriptions] - Per-member "when to pick" descriptions
 * @param {object} [opts.log] - Logger
 * @param {number} [opts.timeoutMs=DEFAULT_SYSTEMONE_TIMEOUT_MS] - Hard ceiling for router evaluation, all attempts together
 * @returns {Promise<{ choice: string|null, confidence: number|null, probabilities: Record<string, number>|null, failure?: string, router?: string } | null>}
 */
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

  let chain;
  try {
    chain = await resolveRouterChain(targetModel);
  } catch (err) {
    log?.warn?.("COMBO", `smart-router: could not resolve router "${targetModel}" (${err?.message || String(err)})`);
    return noDecision("error");
  }
  if (chain.models.length === 0) {
    log?.warn?.("COMBO", `smart-router: router combo "${chain.name}" has no models`);
    return noDecision("router_model_unknown");
  }

  const deadline = Date.now() + timeoutMs;
  let failure = "error";
  for (let i = 0; i < chain.models.length; i++) {
    const remaining = deadline - Date.now();
    if (i > 0 && remaining < MIN_ROUTER_ATTEMPT_MS) {
      log?.warn?.("COMBO", `smart-router ${chain.name}: routing budget spent after ${i}/${chain.models.length} routers`);
      break;
    }
    const member = chain.models[i];
    const label = chain.name ? ` ${chain.name} ${i + 1}/${chain.models.length} ${member}` : "";
    // Split what is left evenly over the routers still to try, so one that hangs cannot use
    // up the turn of the next. A single router keeps the whole budget, as before.
    const attemptMs = Math.max(Math.floor(remaining / (chain.models.length - i)), 1);
    const answer = await askRouter(member, { state, criteria, routerInstructions, log, timeoutMs: attemptMs, label });
    if (answer.route) {
      if (chain.name) log?.info?.("COMBO", `smart-router${label} answered`);
      return { ...answer.route, router: member };
    }
    failure = answer.failure;
  }
  return noDecision(failure);
}
