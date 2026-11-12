// Token limits an upstream declares for its own models on GET /models.
//
// Name-pattern capabilities only know public model families. A compatible
// provider is free to name its models anything ("daily-coding-shared",
// "deepseek-4.1-flash-shared"), so the pattern table either misses or matches a
// stale family floor, and the gateway republishes a window far below what the
// upstream actually serves. What the upstream says about itself wins.

const MAX_TOKENS = 100_000_000;

function positiveInt(value) {
  const n = typeof value === "string" ? Number(value) : value;
  if (!Number.isFinite(n) || n <= 0 || n > MAX_TOKENS) return null;
  return Math.floor(n);
}

function firstPositive(...values) {
  for (const value of values) {
    const n = positiveInt(value);
    if (n) return n;
  }
  return null;
}

/**
 * Keep only well-formed limits. Returns null when nothing usable is left.
 * @param {unknown} limits
 * @returns {{ contextWindow?: number, maxOutput?: number } | null}
 */
export function sanitizeLimits(limits) {
  if (!limits || typeof limits !== "object") return null;
  const clean = {};
  const contextWindow = positiveInt(limits.contextWindow);
  const maxOutput = positiveInt(limits.maxOutput);
  if (contextWindow) clean.contextWindow = contextWindow;
  if (maxOutput) clean.maxOutput = maxOutput;
  return Object.keys(clean).length ? clean : null;
}

/**
 * Read limits off one entry of an upstream /models response. Covers the
 * OpenRouter-style snake_case names, LiteLLM's max_input_tokens, and the
 * camelCase `capabilities` block another 9router instance publishes.
 * @param {object} model
 * @returns {{ contextWindow?: number, maxOutput?: number } | null}
 */
export function extractUpstreamLimits(model) {
  if (!model || typeof model !== "object") return null;
  return sanitizeLimits({
    contextWindow: firstPositive(
      model.context_length,
      model.context_window,
      model.max_context_length,
      model.capabilities?.contextWindow,
      model.max_input_tokens,
    ),
    maxOutput: firstPositive(
      model.max_output_tokens,
      model.max_completion_tokens,
      model.top_provider?.max_completion_tokens,
      model.capabilities?.maxOutput,
    ),
  });
}
