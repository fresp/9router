/**
 * Pure System One router utilities for intelligent combo model selection.
 * Used by the "smart" combo strategy to pick the best model for a request
 * before generation begins, with session stickiness for prompt-cache retention.
 */

import crypto from "crypto";
import { OPENAI_BLOCK, RESPONSES_ITEM } from "../translator/schema/blocks.js";
import { ROLE } from "../translator/schema/roles.js";

export const DEFAULT_SYSTEMONE_ROUTER_MODEL = "oc/jev-1.13-free";
export const DEFAULT_SYSTEMONE_TIMEOUT_MS = 8000;
export const MAX_STATE_CHARS = 2000;
export const MAX_STICKY_SESSIONS = 5000;
export const STICKY_SESSION_TTL_MS = 2 * 60 * 60 * 1000; // 2 hours
export const DEFAULT_ROUTE_INSTRUCTIONS = "Which of these configured models is the most appropriate for this request?";
export const MAX_ROUTE_INSTRUCTIONS_CHARS = 4000;
export const MAX_MEMBER_DESCRIPTION_CHARS = 1000;

/**
 * In-memory session stickiness store for smart-routed combos.
 * Key: `${comboName}:${sessionId}` -> Value: { model, lastUsed }
 */
const comboSessionModelStore = new Map();

/**
 * Extract prompt text from the request body for System One classification.
 * Takes the last user turn (or prompt) and truncates to avoid token waste.
 *
 * @param {object} body - Request body
 * @param {number} [maxChars=MAX_STATE_CHARS] - Max character cap
 * @returns {string} Clean prompt state
 */
export function extractPromptState(body, maxChars = MAX_STATE_CHARS) {
  if (!body || typeof body !== "object") return "";

  const messages = requestTurns(body);

  if (messages && messages.length > 0) {
    // Find the latest user message
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      if (isUserTurn(msg)) {
        const text = turnText(msg);
        if (text && text.trim().length > 0) {
          return text.trim().slice(0, maxChars);
        }
      }
    }
    // Fallback: latest message of any role
    const text = turnText(messages[messages.length - 1]);
    if (text) return text.trim().slice(0, maxChars);
  }

  // String prompt / input
  if (typeof body.prompt === "string" && body.prompt.trim()) {
    return body.prompt.trim().slice(0, maxChars);
  }
  if (typeof body.input === "string" && body.input.trim()) {
    return body.input.trim().slice(0, maxChars);
  }

  return "";
}

// Text part types across client formats: chat/Claude "text", Responses "input_text"/"output_text".
// Gemini parts carry text without a type.
const TEXT_PART_TYPES = new Set([OPENAI_BLOCK.TEXT, RESPONSES_ITEM.INPUT_TEXT, RESPONSES_ITEM.OUTPUT_TEXT]);

function extractTextFromContent(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") return part;
        if (typeof part?.text === "string" && (part.type === undefined || TEXT_PART_TYPES.has(part.type))) return part.text;
        return "";
      })
      .filter(Boolean)
      .join(" ");
  }
  return "";
}

// Conversation turns of the client request: chat/Claude messages[], Responses input[], Gemini contents[].
function requestTurns(body) {
  if (Array.isArray(body?.messages)) return body.messages;
  if (Array.isArray(body?.input)) return body.input;
  if (Array.isArray(body?.contents)) return body.contents;
  return null;
}

// A user turn, or a role-less item that still carries content (legacy shapes).
function isUserTurn(msg) {
  if (!msg || typeof msg !== "object") return false;
  if (msg.role === ROLE.USER) return true;
  return !msg.role && (msg.type === RESPONSES_ITEM.MESSAGE || !!msg.content);
}

function turnText(msg) {
  return extractTextFromContent(msg?.content ?? msg?.text ?? msg?.parts);
}

/**
 * Session key for smart-router stickiness. The first user message of a conversation
 * is the same on every turn, so the key is stable from turn 1 and does not depend on
 * client headers (some clients send a new request id on every call). Scoped by
 * `namespace` (the caller's API key) so different callers never share a session.
 *
 * @param {object} body - Client request body
 * @param {string} [namespace=""] - Caller scope, e.g. the API key
 * @returns {string|null} Session key, or null when the request has no user text
 */
export function deriveRoutingSessionId(body, namespace = "") {
  if (!body || typeof body !== "object") return null;
  let first = "";
  const turns = requestTurns(body);
  if (turns) {
    for (const msg of turns) {
      if (!isUserTurn(msg)) continue;
      first = turnText(msg).trim();
      if (first) break;
    }
  } else if (typeof body.input === "string") {
    first = body.input.trim();
  } else if (typeof body.prompt === "string") {
    first = body.prompt.trim();
  }
  if (!first) return null;
  return "conv:" + crypto.createHash("sha256").update(`${namespace || ""}\u0000${first}`).digest("hex").slice(0, 32);
}

/**
 * Build choice criteria dictionary for System One from an array of models.
 * Criteria keys are the model names. A value is the member's routing description
 * when one is configured, otherwise null so System One uses its native knowledge
 * of the model.
 *
 * @param {string[]} models - Array of model IDs in the combo
 * @param {Record<string, string>} [descriptions] - Optional per-member "when to pick" text
 * @returns {Record<string, string|null>} Criteria map
 */
export function buildChoiceCriteria(models, descriptions) {
  const criteria = {};
  if (!Array.isArray(models)) return criteria;
  const hasDescriptions = descriptions && typeof descriptions === "object" && !Array.isArray(descriptions);
  for (const m of models) {
    if (typeof m === "string" && m.trim().length > 0) {
      const key = m.trim();
      const raw = hasDescriptions && Object.prototype.hasOwnProperty.call(descriptions, key)
        ? descriptions[key]
        : null;
      const text = typeof raw === "string" ? raw.trim().slice(0, MAX_MEMBER_DESCRIPTION_CHARS) : "";
      criteria[key] = text || null;
    }
  }
  return criteria;
}

/**
 * Resolve the question System One answers for a combo: the custom routing
 * instructions when configured, otherwise the default question.
 *
 * @param {string} [instructions] - Per-combo router instructions
 * @returns {string} Instructions text
 */
export function resolveRouteInstructions(instructions) {
  const text = typeof instructions === "string" ? instructions.trim().slice(0, MAX_ROUTE_INSTRUCTIONS_CHARS) : "";
  return text || DEFAULT_ROUTE_INSTRUCTIONS;
}

/**
 * Parse a System One route response JSON.
 *
 * @param {object} json - Upstream response payload
 * @returns {{ choice: string, confidence: number|null, probabilities: Record<string, number>|null } | null}
 */
export function parseSystemOneRouteAnswer(json) {
  if (!json || typeof json !== "object") return null;

  const route = json.answers?.route;
  if (!route || typeof route !== "object") return null;

  const rawChoice = typeof route.choice === "string" ? route.choice.trim() : "";
  if (!rawChoice) return null;

  const confidence = typeof route.confidence === "number" && Number.isFinite(route.confidence)
    ? route.confidence
    : null;

  let probabilities = null;
  if (route.probabilities && typeof route.probabilities === "object" && !Array.isArray(route.probabilities)) {
    probabilities = {};
    for (const [k, v] of Object.entries(route.probabilities)) {
      const num = typeof v === "number" ? v : Number(v);
      if (Number.isFinite(num)) {
        probabilities[k] = num;
      }
    }
  }

  return {
    choice: rawChoice,
    confidence,
    probabilities,
  };
}

/**
 * Order combo models based on System One choice result:
 * 1. The selected choice is placed at index 0.
 * 2. Remaining models are ordered by probabilities descending.
 * 3. Models without probabilities retain their relative order at the end.
 *
 * @param {string[]} models - Original models array
 * @param {object} choiceResult - Parsed System One choice
 * @returns {string[]} Reordered models array
 */
export function orderModelsByChoice(models, choiceResult) {
  if (!Array.isArray(models) || models.length <= 1) return models || [];
  if (!choiceResult?.choice || !models.includes(choiceResult.choice)) return [...models];

  const { choice, probabilities } = choiceResult;
  const others = models.filter((m) => m !== choice);

  if (probabilities && typeof probabilities === "object") {
    others.sort((a, b) => {
      const pA = probabilities[a] ?? 0;
      const pB = probabilities[b] ?? 0;
      return pB - pA;
    });
  }

  return [choice, ...others];
}

/**
 * Check if a session already has a sticky model assigned for this combo.
 *
 * @param {string} comboName - Combo name
 * @param {string|null} sessionId - Client session identifier
 * @param {string[]} models - Currently available combo models
 * @returns {string|null} Model to use, or null if no sticky model
 */
export function getStickyComboModel(comboName, sessionId, models) {
  if (!sessionId || !comboName || !Array.isArray(models)) return null;

  const key = `${comboName}:${sessionId}`;
  const entry = comboSessionModelStore.get(key);
  if (!entry) return null;

  // Check TTL (2 hours)
  if (Date.now() - entry.lastUsed > STICKY_SESSION_TTL_MS) {
    comboSessionModelStore.delete(key);
    return null;
  }

  // Ensure stored model still belongs to combo
  if (!models.includes(entry.model)) {
    comboSessionModelStore.delete(key);
    return null;
  }

  entry.lastUsed = Date.now();
  return entry.model;
}

/**
 * Record sticky model for this session so subsequent turns keep prompt-cache warm.
 *
 * @param {string} comboName - Combo name
 * @param {string|null} sessionId - Client session identifier
 * @param {string} model - Selected model
 */
export function setStickyComboModel(comboName, sessionId, model) {
  if (!sessionId || !comboName || !model) return;

  pruneStickyComboSessions();
  const key = `${comboName}:${sessionId}`;
  comboSessionModelStore.set(key, { model, lastUsed: Date.now() });
}

/**
 * Clear a sticky session mapping (e.g. after a model fails or resets).
 *
 * @param {string} comboName - Combo name
 * @param {string|null} [sessionId] - Specific session ID; omit to clear all for combo
 */
export function clearStickyComboSession(comboName, sessionId = null) {
  if (!comboName) {
    comboSessionModelStore.clear();
    return;
  }
  if (sessionId) {
    comboSessionModelStore.delete(`${comboName}:${sessionId}`);
    return;
  }
  // Clear all for this combo
  const prefix = `${comboName}:`;
  for (const k of comboSessionModelStore.keys()) {
    if (k.startsWith(prefix)) comboSessionModelStore.delete(k);
  }
}

/**
 * Prune old or excess sticky sessions to prevent unbounded memory growth.
 */
export function pruneStickyComboSessions() {
  if (comboSessionModelStore.size < MAX_STICKY_SESSIONS) return;

  const now = Date.now();
  // Remove expired
  for (const [k, v] of comboSessionModelStore.entries()) {
    if (now - v.lastUsed > STICKY_SESSION_TTL_MS) {
      comboSessionModelStore.delete(k);
    }
  }

  // If still above ceiling, drop oldest entries
  if (comboSessionModelStore.size >= MAX_STICKY_SESSIONS) {
    const sorted = [...comboSessionModelStore.entries()].sort((a, b) => a[1].lastUsed - b[1].lastUsed);
    const toDrop = sorted.slice(0, Math.floor(MAX_STICKY_SESSIONS / 4));
    for (const [k] of toDrop) {
      comboSessionModelStore.delete(k);
    }
  }
}

/**
 * Reset sticky store (for testing).
 */
export function resetStickyComboStore() {
  comboSessionModelStore.clear();
}
