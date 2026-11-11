// User-defined API key validation: pure helpers (no DB, no request objects),
// shared by the /api/keys route and the Create API Key modal so both apply the
// same rules.

export const CUSTOM_KEY_PREFIX = "sk-";
export const CUSTOM_KEY_MIN_LENGTH = 8;
export const CUSTOM_KEY_MAX_LENGTH = 128;
// Below this length a key is accepted but flagged as easy to guess.
export const CUSTOM_KEY_WEAK_LENGTH = 24;

const CUSTOM_KEY_CHARSET = /^[A-Za-z0-9_-]+$/;

/**
 * Validate a user-supplied API key.
 * @param {unknown} input
 * @returns {{ ok: true, value: string, weak: boolean } | { ok: false, error: string }}
 */
export function validateCustomApiKey(input) {
  if (typeof input !== "string") return { ok: false, error: "Key must be a string." };
  const value = input.trim();
  if (!value.startsWith(CUSTOM_KEY_PREFIX)) {
    return { ok: false, error: `Key must start with ${CUSTOM_KEY_PREFIX}` };
  }
  if (!CUSTOM_KEY_CHARSET.test(value)) {
    return { ok: false, error: "Use letters, numbers, - and _ only." };
  }
  if (value.length < CUSTOM_KEY_MIN_LENGTH) {
    return { ok: false, error: `Key must be at least ${CUSTOM_KEY_MIN_LENGTH} characters.` };
  }
  if (value.length > CUSTOM_KEY_MAX_LENGTH) {
    return { ok: false, error: `Key must be ${CUSTOM_KEY_MAX_LENGTH} characters or fewer.` };
  }
  return { ok: true, value, weak: value.length < CUSTOM_KEY_WEAK_LENGTH };
}
