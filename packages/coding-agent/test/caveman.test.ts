import { afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import { Settings } from "../src/config/settings";
import { createCavemanExtension } from "../src/extensibility/extensions/caveman";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	RegisteredCommand,
} from "../src/extensibility/extensions/types";
import { initTheme, type Theme } from "../src/modes/theme/theme";
import { SessionManager } from "../src/session/session-manager";
import { buildSystemPrompt } from "../src/system-prompt";

type ContextHandler = (event: unknown, ctx: ExtensionContext) => Promise<void> | void;
type CustomFactory = Parameters<ExtensionCommandContext["ui"]["custom"]>[0];

interface Harness {
	appendEntries: Array<{ customType: string; data: unknown }>;
	commandHandler: RegisteredCommand["handler"];
	events: Map<string, ContextHandler>;
	settings: Settings;
}

interface ContextOptions {
	custom?: ExtensionCommandContext["ui"]["custom"];
	hasUI?: boolean;
	refreshBaseSystemPrompt?: () => Promise<void>;
	sessionManager?: SessionManager;
	notify?: (message: string, type?: "info" | "warning" | "error") => void;
	setStatus?: (key: string, text: string | undefined) => void;
	theme?: Theme;
}

function createHarness(settings: Settings = Settings.isolated()): Harness {
	const events = new Map<string, ContextHandler>();
	const appendEntries: Array<{ customType: string; data: unknown }> = [];
	let commandHandler: RegisteredCommand["handler"] | undefined;

	const api = {
		logger: {} as never,
		typebox: {} as never,
		pi: {} as never,
		on(event: string, handler: ContextHandler): void {
			events.set(event, handler);
		},
		registerCommand(
			_name: string,
			options: {
				description?: string;
				getArgumentCompletions?: RegisteredCommand["getArgumentCompletions"];
				handler: RegisteredCommand["handler"];
			},
		): void {
			commandHandler = options.handler;
		},
		appendEntry(customType: string, data?: unknown): void {
			appendEntries.push({ customType, data });
		},
	} as unknown as ExtensionAPI;

	createCavemanExtension(settings)(api);
	if (!commandHandler) {
		throw new Error("Expected caveman extension to register /caveman command");
	}

	return { appendEntries, commandHandler, events, settings };
}

function createThemeSpy(): Theme {
	return {
		bold: vi.fn((text: string) => `bold(${text})`),
		fg: vi.fn((_color: string, text: string) => `fg(${text})`),
		nav: { cursor: ">" },
	} as unknown as Theme;
}

function createCommandContext(options: ContextOptions = {}): ExtensionCommandContext {
	const theme = options.theme ?? createThemeSpy();
	const custom =
		options.custom ??
		(async () => {
			return undefined;
		});

	const ui = {
		confirm: async () => false,
		custom,
		editor: async () => undefined,
		getAllThemes: async () => [],
		getEditorText: () => "",
		getTheme: async () => undefined,
		getToolsExpanded: () => false,
		input: async () => undefined,
		notify: options.notify ?? (() => {}),
		onTerminalInput: () => () => {},
		pasteToEditor: () => {},
		select: async () => undefined,
		setEditorComponent: () => {},
		setEditorText: () => {},
		setFooter: () => {},
		setHeader: () => {},
		setStatus: options.setStatus ?? (() => {}),
		setTheme: async () => ({ success: true }),
		setTitle: () => {},
		setToolsExpanded: () => {},
		setWidget: () => {},
		setWorkingMessage: () => {},
		theme,
	} as unknown as ExtensionCommandContext["ui"];

	return {
		abort: () => {},
		branch: async () => ({ cancelled: false }),
		compact: async () => {},
		cwd: "/tmp",
		getContextUsage: () => undefined,
		getFirstUserMessage: () => undefined,
		getSystemPrompt: () => "",
		hasPendingMessages: () => false,
		hasQueuedMessages: () => false,
		hasUI: options.hasUI ?? false,
		isIdle: () => true,
		model: undefined,
		modelRegistry: {} as never,
		navigateTree: async () => ({ cancelled: false }),
		newSession: async () => ({ cancelled: false }),
		reload: async () => {},
		refreshBaseSystemPrompt: options.refreshBaseSystemPrompt ?? (async () => {}),
		sessionManager: options.sessionManager ?? SessionManager.inMemory(),
		shutdown: () => {},
		switchSession: async () => ({ cancelled: false }),
		ui,
		waitForIdle: async () => {},
	} as unknown as ExtensionCommandContext;
}

async function renderPrompt(settings: Settings, isSubagent = false): Promise<string> {
	const blocks = await buildSystemPrompt({
		contextFiles: [],
		cwd: import.meta.dir,
		isSubagent,
		rules: [],
		settings,
		skills: [],
		toolNames: [],
	});
	return blocks.map(block => block.text).join("\n");
}

describe("caveman extension", () => {
	beforeAll(async () => {
		await initTheme(false);
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("renders caveman prompt sections only when the active level enables them", async () => {
		const fullCaveman = await renderPrompt(
			Settings.isolated({
				"caveman.defaultLevel": "full",
				"caveman.thinkingMode": "caveman",
			}),
		);
		expect(fullCaveman).toContain("Terse mode active");
		expect(fullCaveman).toContain("Level: FULL");
		expect(fullCaveman).toContain("Think in notation");

		const fullNormalThinking = await renderPrompt(
			Settings.isolated({
				"caveman.defaultLevel": "full",
				"caveman.thinkingMode": "normal",
			}),
		);
		expect(fullNormalThinking).toContain("Terse mode active");
		expect(fullNormalThinking).toContain("Level: FULL");
		// Think in notation is always in system prompt (not caveman-specific)
		expect(fullNormalThinking).toContain("Think in notation");

		const offPrompt = await renderPrompt(
			Settings.isolated({
				"caveman.defaultLevel": "off",
				"caveman.thinkingMode": "caveman",
			}),
		);
		expect(offPrompt).not.toContain("Terse mode active");
		// Think in notation is always in the system prompt unconditionally
		expect(offPrompt).toContain("Think in notation");
	});

	it("gates caveman prompt injection for subagents based on settings", async () => {
		const subagentSuppressed = await renderPrompt(
			Settings.isolated({
				"caveman.affectSubagents": false,
				"caveman.defaultLevel": "full",
			}),
			true,
		);
		expect(subagentSuppressed).not.toContain("Terse mode active");

		const subagentEnabled = await renderPrompt(
			Settings.isolated({
				"caveman.affectSubagents": true,
				"caveman.defaultLevel": "full",
			}),
			true,
		);
		expect(subagentEnabled).toContain("Terse mode active");

		const rootSession = await renderPrompt(
			Settings.isolated({
				"caveman.affectSubagents": false,
				"caveman.defaultLevel": "full",
			}),
			false,
		);
		expect(rootSession).toContain("Terse mode active");
	});

	it("toggles levels, accepts explicit levels, opens config, and rejects invalid levels", async () => {
		const harness = createHarness(Settings.isolated({ "caveman.defaultLevel": "off" }));
		const notify = vi.fn();
		const customSpy = vi.fn(async (factory: CustomFactory) => {
			await factory({} as never, createThemeSpy(), {} as never, () => {});
			return undefined;
		});
		const ctx = createCommandContext({
			custom: customSpy as unknown as ExtensionCommandContext["ui"]["custom"],
			hasUI: true,
			notify,
		});

		await harness.commandHandler("", ctx);
		expect(harness.settings.get("caveman.defaultLevel")).toBe("full");
		expect(notify.mock.calls.at(-1)).toEqual(["Caveman mode: CAVEMAN", "info"]);

		await harness.commandHandler("", ctx);
		expect(harness.settings.get("caveman.defaultLevel")).toBe("off");
		expect(notify.mock.calls.at(-1)).toEqual(["Caveman mode off.", "info"]);

		await harness.commandHandler("ultra", ctx);
		expect(harness.settings.get("caveman.defaultLevel")).toBe("ultra");
		expect(notify.mock.calls.at(-1)).toEqual(["Caveman mode: ULTRA", "info"]);

		await harness.commandHandler("config", ctx);
		expect(customSpy).toHaveBeenCalledTimes(1);

		await harness.commandHandler("invalid", ctx);
		expect(notify.mock.calls.at(-1)).toEqual(["Unknown caveman level: invalid", "error"]);

		expect(harness.appendEntries).toEqual([
			{ customType: "caveman-level", data: { level: "full" } },
			{ customType: "caveman-level", data: { level: "off" } },
			{ customType: "caveman-level", data: { level: "ultra" } },
		]);
	});

	it("restores a stored caveman session level on session_start", async () => {
		const harness = createHarness(Settings.isolated({ "caveman.defaultLevel": "off" }));
		const sessionStart = harness.events.get("session_start");
		if (!sessionStart) {
			throw new Error("Expected caveman extension to register session_start handler");
		}

		const sessionManager = SessionManager.inMemory();
		sessionManager.appendCustomEntry("caveman-level", { level: "ultra" });

		await sessionStart(
			{},
			createCommandContext({
				hasUI: false,
				refreshBaseSystemPrompt: async () => {},
				sessionManager,
			}),
		);

		expect(harness.settings.get("caveman.defaultLevel")).toBe("ultra");
	});

	it("clears a stale caveman override when no stored session level exists", async () => {
		const settings = Settings.isolated({ "caveman.defaultLevel": "off" });
		settings.override("caveman.defaultLevel", "full");
		const harness = createHarness(settings);
		const sessionStart = harness.events.get("session_start");
		if (!sessionStart) {
			throw new Error("Expected caveman extension to register session_start handler");
		}

		await sessionStart(
			{},
			createCommandContext({
				hasUI: false,
				refreshBaseSystemPrompt: async () => {},
				sessionManager: SessionManager.inMemory(),
			}),
		);

		expect(harness.settings.get("caveman.defaultLevel")).toBe("off");
	});

	it("warns instead of reporting success when prompt refresh fails", async () => {
		const settings = Settings.isolated({ "caveman.defaultLevel": "off" });
		const harness = createHarness(settings);
		const notify = vi.fn();
		const ctx = createCommandContext({
			hasUI: false,
			notify,
			refreshBaseSystemPrompt: async () => {
				throw new Error("refresh failed");
			},
		});

		await harness.commandHandler("", ctx);

		expect(settings.get("caveman.defaultLevel")).toBe("full");
		expect(harness.appendEntries).toEqual([{ customType: "caveman-level", data: { level: "full" } }]);
		expect(notify).toHaveBeenCalledTimes(1);
		expect(notify.mock.calls[0]?.[0]).toContain("prompt refresh failed");
		expect(notify.mock.calls[0]?.[1]).toBe("warning");
		expect(notify.mock.calls.some(([, type]) => type === "info")).toBe(false);
	});

	it("does not start status animation timers in non-interactive sessions", async () => {
		const harness = createHarness(
			Settings.isolated({
				"caveman.defaultLevel": "full",
				"caveman.showStatus": true,
			}),
		);
		const setIntervalSpy = vi.spyOn(globalThis, "setInterval");
		const setStatus = vi.fn();
		const sessionStart = harness.events.get("session_start");
		if (!sessionStart) {
			throw new Error("Expected caveman extension to register session_start handler");
		}

		await sessionStart(
			{},
			createCommandContext({
				hasUI: false,
				refreshBaseSystemPrompt: async () => {},
				setStatus,
			}),
		);

		expect(setIntervalSpy).not.toHaveBeenCalled();
		expect(setStatus).toHaveBeenCalledWith("caveman", undefined);
	});

	it("uses the ui.custom theme for the caveman config dialog", async () => {
		const harness = createHarness();
		const dialogTheme = createThemeSpy();
		const customSpy = vi.fn(async (factory: CustomFactory) => {
			await factory({} as never, dialogTheme, {} as never, () => {});
			return undefined;
		});
		const ctx = createCommandContext({
			custom: customSpy as unknown as ExtensionCommandContext["ui"]["custom"],
			hasUI: true,
		});

		await harness.commandHandler("config", ctx);

		expect(customSpy).toHaveBeenCalledTimes(1);
		expect(dialogTheme.fg).toHaveBeenCalledWith("accent", "  Caveman Config");
		expect(dialogTheme.bold).toHaveBeenCalled();
		expect(dialogTheme.fg).toHaveBeenCalledWith("muted", "  Persisted to spell.kdl");
		expect(dialogTheme.fg).toHaveBeenCalledWith("dim", "  ←→ change · Esc close");
	});
});
