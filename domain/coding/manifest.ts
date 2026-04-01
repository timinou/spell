import type { SpellDomain } from "../growth/src/types";

/**
 * Default domain manifest for the coding domain.
 *
 * Tools are unrestricted (empty config = all BUILTIN_TOOLS visible).
 * Panels and workspaces are empty — the TUI manages layout for this domain.
 * No systemPromptPath — the agent's built-in system prompt applies as-is.
 */
const manifest: SpellDomain = {
  name: "coding",
  description: "Software development",
  tools: {},
  panels: [],
  workspaces: [],
};

export default manifest;
