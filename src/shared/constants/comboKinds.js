// Combo kinds with behaviour of their own. A combo without a kind (or kind "llm") is a chat combo.

// A router combo: an ordered list of System One models that a smart-routed chat combo names
// as its router. Its members are asked in order until one returns a readable decision.
export const COMBO_KIND_SYSTEMONE = "systemone";

export const isRouterCombo = (combo) => combo?.kind === COMBO_KIND_SYSTEMONE;

export const routerComboAsChatMessage = (name) =>
  `"${name}" is a System One router combo. Use it as a combo's router model or on /v1/systemone, not as a chat model.`;
