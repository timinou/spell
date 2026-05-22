import type { Document } from "@bgotink/kdl";

import { getDocumentNode, getStringArgument } from "./kdl-helpers";

export type KeybindingConfigAction = string;

const APP_ACTION_CONFIG_TO_RUNTIME = {
	interrupt: "interrupt",
	clear: "clear",
	exit: "exit",
	suspend: "suspend",
	"cycle-thinking-level": "cycleThinkingLevel",
	"cycle-model-forward": "cycleModelForward",
	"cycle-model-backward": "cycleModelBackward",
	"select-model": "selectModel",
	"toggle-plan-mode": "togglePlanMode",
	"history-search": "historySearch",
	"expand-tools": "expandTools",
	"toggle-thinking": "toggleThinking",
	"toggle-session-named-filter": "toggleSessionNamedFilter",
	"external-editor": "externalEditor",
	"follow-up": "followUp",
	dequeue: "dequeue",
	"paste-image": "pasteImage",
	"copy-line": "copyLine",
	"copy-prompt": "copyPrompt",
	"new-session": "newSession",
	tree: "tree",
	fork: "fork",
	resume: "resume",
	"toggle-stt": "toggleSTT",
	"toggle-user-pause": "toggleUserPause",
	"subagent-viewer": "subagentViewer",
	"open-memory-browser": "openMemoryBrowser",
} as const;

const APP_ACTION_RUNTIME_TO_CONFIG = Object.fromEntries(
	Object.entries(APP_ACTION_CONFIG_TO_RUNTIME).map(([configAction, runtimeAction]) => [runtimeAction, configAction]),
) as Record<string, string>;

const LEGACY_KEYBINDING_ALIASES: Record<string, string> = {
	"cycle-thinking": "cycle-thinking-level",
	"cycle-model": "cycle-model-forward",
	"toggle-plan": "toggle-plan-mode",
};

export function normalizeKeybindingAction(action: string): { action: string; canonical: boolean } {
	if (APP_ACTION_RUNTIME_TO_CONFIG[action]) {
		return { action: APP_ACTION_RUNTIME_TO_CONFIG[action], canonical: true };
	}
	const canonical = LEGACY_KEYBINDING_ALIASES[action] ?? action;
	return { action: canonical, canonical: canonical === action };
}

export function resolveKeybindingRuntimeAction(action: string): string | undefined {
	if (APP_ACTION_RUNTIME_TO_CONFIG[action]) return action;
	const canonical = normalizeKeybindingAction(action).action;
	return APP_ACTION_CONFIG_TO_RUNTIME[canonical as keyof typeof APP_ACTION_CONFIG_TO_RUNTIME];
}

export function serializeKeybindingAction(action: string): string {
	return APP_ACTION_RUNTIME_TO_CONFIG[action] ?? normalizeKeybindingAction(action).action;
}

export function parseKeybindingsBlock(doc: Document): Record<string, string> {
	const keybindingsNode = getDocumentNode(doc, "keybindings");
	if (!keybindingsNode) return {};

	const bindings: Record<string, string> = {};
	for (const child of keybindingsNode.children?.nodes ?? []) {
		const action = child.getName();
		const key = getStringArgument(child);
		if (!key) continue;
		bindings[normalizeKeybindingAction(action).action] = key;
	}

	return bindings;
}
