// Model aliases: a bare name (no provider prefix) that routes to exactly one
// `provider/model`. Shared by the alias API (authoritative) and the dashboard
// editor (early feedback), so both reject the same names.

export const MODEL_ALIAS_MAX_LENGTH = 100;

// A slash would make the router parse the name as `provider/model` and never
// consult the alias map, so it is excluded along with whitespace and anything
// that needs escaping in a URL or a config file.
const MODEL_ALIAS_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@-]*$/;

/**
 * @returns {string|null} a user-facing error, or null when the name is usable
 */
export function validateModelAliasName(alias) {
  if (typeof alias !== "string" || !alias.trim()) return "Alias is required";
  const name = alias.trim();
  if (name.length > MODEL_ALIAS_MAX_LENGTH) return `Alias must be at most ${MODEL_ALIAS_MAX_LENGTH} characters`;
  if (name.includes("/")) return "Alias cannot contain \"/\" — it must be a bare name";
  if (!MODEL_ALIAS_PATTERN.test(name)) return "Alias may only contain letters, digits and . _ : @ - and must start with a letter or digit";
  return null;
}

/**
 * Alias names that point at `modelId` under any of the given provider prefixes
 * (storage id, registry alias, node display prefix — they all route the same).
 */
export function getAliasesForModel(modelAliases, modelId, prefixes = []) {
  const targets = new Set(prefixes.filter(Boolean).map((prefix) => `${prefix}/${modelId}`));
  return Object.entries(modelAliases || {})
    .filter(([, target]) => typeof target === "string" && targets.has(target))
    .map(([alias]) => alias)
    .sort((a, b) => a.localeCompare(b));
}
