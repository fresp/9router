// API key groups: pure validation helpers (no DB, no request objects), shared
// by the /api/keys/groups routes and the Endpoint page.
//
// A group is only an organizing container for API keys. It carries no access
// rules and is never consulted when a /v1 request is authenticated or routed.

export const KEY_GROUP_NAME_MAX_LENGTH = 40;

/**
 * Validate a group name.
 * @param {unknown} input
 * @returns {{ ok: true, value: string } | { ok: false, error: string }}
 */
export function validateKeyGroupName(input) {
  if (typeof input !== "string") return { ok: false, error: "Group name must be a string." };
  const value = input.trim();
  if (!value) return { ok: false, error: "Enter a group name." };
  if (value.length > KEY_GROUP_NAME_MAX_LENGTH) {
    return { ok: false, error: `Group name must be ${KEY_GROUP_NAME_MAX_LENGTH} characters or fewer.` };
  }
  return { ok: true, value };
}
