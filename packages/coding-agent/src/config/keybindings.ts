import { parse } from "@bgotink/kdl";

import {
	DEFAULT_EDITOR_KEYBINDINGS,
	type EditorAction,
	type EditorKeybindingsConfig,
	EditorKeybindingsManager,
	type KeyId,
	matchesKey,
	setEditorKeybindings,
} from "@oh-my-pi/pi-tui";

import { isEnoent, logger } from "@oh-my-pi/pi-utils";

import { parseKeybindingsBlock, resolveKeybindingRuntimeAction } from "./kdl-keybindings";

/**
 * Application-level actions (coding agent specific).
 */
export type AppAction =
	| "interrupt"
	| "clear"
	| "exit"
	| "suspend"
	| "cycleThinkingLevel"
	| "cycleModelForward"
	| "cycleModelBackward"
	| "selectModel"
	| "togglePlanMode"
	| "expandTools"
	| "toggleThinking"
	| "toggleSessionNamedFilter"
	| "externalEditor"
	| "historySearch"
	| "followUp"
	| "dequeue"
	| "pasteImage"
	| "copyLine"
	| "copyPrompt"
	| "newSession"
	| "tree"
	| "fork"
	| "resume"
	| "toggleSTT"
	| "toggleUserPause"
	| "subagentViewer";

/**
 * All configurable actions.
 */
export type KeyAction = AppAction | EditorAction;

/**
 * Full keybindings configuration (app + editor actions).
 */
export type KeybindingsConfig = {
	[K in KeyAction]?: KeyId | KeyId[];
};

/**
 * Default application keybindings.
 */
export const DEFAULT_APP_KEYBINDINGS: Record<AppAction, KeyId | KeyId[]> = {
	interrupt: "escape",
	clear: "ctrl+c",
	exit: "ctrl+d",
	suspend: "ctrl+z",
	cycleThinkingLevel: "shift+tab",
	cycleModelForward: "ctrl+p",
	cycleModelBackward: "shift+ctrl+p",
	selectModel: "ctrl+l",
	togglePlanMode: "alt+shift+p",
	historySearch: "ctrl+r",
	expandTools: "ctrl+o",
	toggleThinking: "ctrl+t",
	toggleSessionNamedFilter: "ctrl+n",
	externalEditor: "ctrl+g",
	followUp: "ctrl+enter",
	dequeue: "alt+up",
	pasteImage: "ctrl+v",
	copyLine: "alt+shift+l",
	copyPrompt: "alt+shift+c",
	newSession: [],
	tree: [],
	fork: [],
	resume: [],
	toggleSTT: "alt+h",
	toggleUserPause: "alt+shift+u",
	// alt+j chosen because ctrl+tab is captured by Ghostty (and many other
	// terminals) for built-in tab cycling, so the kitty CSI-u sequence never
	// reaches Spell. alt+j stays free across mainstream terminals.
	subagentViewer: "alt+j",
};

/**
 * All default keybindings (app + editor).
 */
export const DEFAULT_KEYBINDINGS: Required<KeybindingsConfig> = {
	...DEFAULT_EDITOR_KEYBINDINGS,
	...DEFAULT_APP_KEYBINDINGS,
};

const APP_ACTIONS: AppAction[] = [
	"interrupt",
	"clear",
	"exit",
	"suspend",
	"cycleThinkingLevel",
	"cycleModelForward",
	"cycleModelBackward",
	"selectModel",
	"togglePlanMode",
	"historySearch",
	"expandTools",
	"toggleThinking",
	"toggleSessionNamedFilter",
	"externalEditor",
	"followUp",
	"dequeue",
	"pasteImage",
	"copyLine",
	"copyPrompt",
	"newSession",
	"tree",
	"fork",
	"resume",
	"toggleSTT",
	"toggleUserPause",
	"subagentViewer",
];

function isAppAction(action: string): action is AppAction {
	return APP_ACTIONS.includes(action as AppAction);
}

/**
 * Key hint formatting utilities for UI labels.
 */
const MODIFIER_LABELS: Record<string, string> = {
	ctrl: "Ctrl",
	shift: "Shift",
	alt: "Alt",
};

const KEY_LABELS: Record<string, string> = {
	esc: "Esc",
	escape: "Esc",
	enter: "Enter",
	return: "Enter",
	space: "Space",
	tab: "Tab",
	backspace: "Backspace",
	delete: "Delete",
	home: "Home",
	end: "End",
	pageup: "PgUp",
	pagedown: "PgDn",
	up: "Up",
	down: "Down",
	left: "Left",
	right: "Right",
};

const normalizeKeyId = (key: KeyId): KeyId => key.toLowerCase() as KeyId;

function formatKeyPart(part: string): string {
	const lower = part.toLowerCase();
	const modifier = MODIFIER_LABELS[lower];
	if (modifier) return modifier;
	const label = KEY_LABELS[lower];
	if (label) return label;
	if (part.length === 1) return part.toUpperCase();
	return `${part.charAt(0).toUpperCase()}${part.slice(1)}`;
}

export function formatKeyHint(key: KeyId): string {
	return key.split("+").map(formatKeyPart).join("+");
}

export function formatKeyHints(keys: KeyId | KeyId[]): string {
	const list = Array.isArray(keys) ? keys : [keys];
	return list.map(formatKeyHint).join("/");
}

/**
 * Manages all keybindings (app + editor).
 */
export class KeybindingsManager {
	#appActionToKeys: Map<AppAction, KeyId[]>;

	private constructor(private readonly config: KeybindingsConfig) {
		this.#appActionToKeys = new Map();
		this.#buildMaps();
	}

	/**
	 * Create from config file and set up editor keybindings.
	 */
	static async create(userKdlPath?: string, projectKdlPath?: string): Promise<KeybindingsManager> {
		let config: KeybindingsConfig = {};

		if (userKdlPath) {
			try {
				const content = await Bun.file(userKdlPath).text();
				const doc = parse(content);
				const userBindings = parseKeybindingsBlock(doc);
				config = { ...config, ...userBindings };
			} catch (error) {
				if (!isEnoent(error)) logger.warn("keybindings: failed to load user KDL", { error });
			}
		}

		if (projectKdlPath) {
			try {
				const content = await Bun.file(projectKdlPath).text();
				const doc = parse(content);
				const projectBindings = parseKeybindingsBlock(doc);
				config = { ...config, ...projectBindings };
			} catch (error) {
				if (!isEnoent(error)) logger.warn("keybindings: failed to load project KDL", { error });
			}
		}

		const manager = new KeybindingsManager(config);

		const editorConfig: EditorKeybindingsConfig = {};
		for (const [action, keys] of Object.entries(config)) {
			if (resolveKeybindingRuntimeAction(action)) continue;
			if (action in DEFAULT_EDITOR_KEYBINDINGS) {
				editorConfig[action as EditorAction] = keys;
				continue;
			}
			logger.warn("keybindings: unknown configured action", { action });
		}
		setEditorKeybindings(new EditorKeybindingsManager(editorConfig));

		return manager;
	}

	/**
	 * Create in-memory.
	 */
	static inMemory(config: KeybindingsConfig = {}): KeybindingsManager {
		return new KeybindingsManager(config);
	}

	#buildMaps(): void {
		this.#appActionToKeys.clear();

		for (const [action, keys] of Object.entries(DEFAULT_APP_KEYBINDINGS)) {
			const keyArray = Array.isArray(keys) ? keys : [keys];
			this.#appActionToKeys.set(
				action as AppAction,
				keyArray.map(key => normalizeKeyId(key as KeyId)),
			);
		}

		for (const [action, keys] of Object.entries(this.config)) {
			const runtimeAction = resolveKeybindingRuntimeAction(action);
			if (keys === undefined || !runtimeAction || !isAppAction(runtimeAction)) continue;
			const keyArray = Array.isArray(keys) ? keys : [keys];
			this.#appActionToKeys.set(
				runtimeAction,
				keyArray.map(key => normalizeKeyId(key as KeyId)),
			);
		}
	}

	/**
	 * Check if input matches an app action.
	 */
	matches(data: string, action: AppAction): boolean {
		const keys = this.#appActionToKeys.get(action);
		if (!keys) return false;
		for (const key of keys) {
			if (matchesKey(data, key)) return true;
		}
		return false;
	}

	/**
	 * Get keys bound to an app action.
	 */
	getKeys(action: AppAction): KeyId[] {
		return this.#appActionToKeys.get(action) ?? [];
	}

	/**
	 * Get display string for an action.
	 */
	getDisplayString(action: AppAction): string {
		return formatKeyHints(this.getKeys(action));
	}

	/**
	 * Get the full effective config.
	 */
	getEffectiveConfig(): Required<KeybindingsConfig> {
		const result = { ...DEFAULT_KEYBINDINGS };
		for (const [action, keys] of Object.entries(this.config)) {
			if (keys !== undefined) {
				(result as KeybindingsConfig)[action as KeyAction] = keys;
			}
		}
		return result;
	}
}

// Re-export for convenience
export type { EditorAction, KeyId };
