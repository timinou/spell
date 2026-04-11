import { Settings } from "../../../../packages/coding-agent/src/config/settings";
import { createCavemanExtension } from "../../../../packages/coding-agent/src/extensibility/extensions/caveman";
import { initTheme } from "../../../../packages/coding-agent/src/modes/theme/theme";
import { buildSystemPrompt } from "../../../../packages/coding-agent/src/system-prompt";

const mockTheme = {
	fg: (_color: string, text: string) => text,
	bold: (text: string) => text,
};

type Handler = (event: unknown, ctx: MockContext) => Promise<void> | void;

type CommandHandler = (args: string, ctx: MockCommandContext) => Promise<void>;

interface MockEntry {
	type: "custom";
	customType: string;
	data: unknown;
}

interface MockContext {
	ui: {
		notify: (message: string, type?: "info" | "warning" | "error") => void;
		setStatus: (key: string, text: string | undefined) => void;
		custom: <T>(
			factory: (tui: unknown, currentTheme: typeof mockTheme, keybindings: unknown, done: (result: T) => void) => unknown,
		) => Promise<T | undefined>;
		theme: typeof mockTheme;
	};
	hasUI: boolean;
	sessionManager: {
		getEntries: () => MockEntry[];
	};
	refreshBaseSystemPrompt: () => Promise<void>;
}

interface MockCommandContext extends MockContext {}

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) {
		throw new Error(message);
	}
}

async function main(): Promise<void> {
	await initTheme(false);
	const promptSettings = Settings.isolated({
		"caveman.defaultLevel": "full",
		"caveman.thinkingMode": "caveman",
		"caveman.affectSubagents": true,
	});
	const promptBlocks = await buildSystemPrompt({
		cwd: process.cwd(),
		settings: promptSettings,
		toolNames: ["read"],
	});
	const promptText = promptBlocks.map(block => block.text).join("\n");
	assert(promptText.includes("IMPORTANT: You are in CAVEMAN MODE."), "main prompt missing caveman instructions");
	assert(promptText.includes("THINKING MODE — PhD-CAVEMAN:"), "main prompt missing PhD-caveman thinking section");

	const subagentOffBlocks = await buildSystemPrompt({
		cwd: process.cwd(),
		settings: Settings.isolated({
			"caveman.defaultLevel": "full",
			"caveman.thinkingMode": "caveman",
			"caveman.affectSubagents": false,
		}),
		toolNames: ["read"],
		isSubagent: true,
	});
	const subagentOffText = subagentOffBlocks.map(block => block.text).join("\n");
	assert(!subagentOffText.includes("IMPORTANT: You are in CAVEMAN MODE."), "subagent prompt should omit caveman when affectSubagents=false");

	const subagentOnBlocks = await buildSystemPrompt({
		cwd: process.cwd(),
		settings: Settings.isolated({
			"caveman.defaultLevel": "full",
			"caveman.thinkingMode": "caveman",
			"caveman.affectSubagents": true,
		}),
		toolNames: ["read"],
		isSubagent: true,
	});
	const subagentOnText = subagentOnBlocks.map(block => block.text).join("\n");
	assert(subagentOnText.includes("IMPORTANT: You are in CAVEMAN MODE."), "subagent prompt should include caveman when affectSubagents=true");

	const settings = Settings.isolated({
		"caveman.defaultLevel": "off",
		"caveman.showStatus": true,
		"caveman.thinkingMode": "caveman",
		"caveman.affectSubagents": true,
	});
	const handlers = new Map<string, Handler[]>();
	const commands = new Map<string, CommandHandler>();
	const appendedEntries: MockEntry[] = [];
	const notifications: string[] = [];
	const statusTexts: Array<string | undefined> = [];
	let refreshCount = 0;
	let customOpened = 0;
	let customRender = "";
	let customComponent: { render?: (width: number) => unknown; handleInput?: (data: string) => void } | undefined;

	createCavemanExtension(settings)({
		on(event: string, handler: Handler) {
			const current = handlers.get(event) ?? [];
			current.push(handler);
			handlers.set(event, current);
		},
		registerCommand(name: string, options: { handler: CommandHandler }) {
			commands.set(name, options.handler);
		},
		appendEntry(customType: string, data?: unknown) {
			appendedEntries.push({ type: "custom", customType, data });
		},
	} as never);

	const ctx: MockCommandContext = {
		hasUI: true,
		sessionManager: {
			getEntries: () => appendedEntries,
		},
		refreshBaseSystemPrompt: async () => {
			refreshCount += 1;
		},
		ui: {
			notify: (message, type = "info") => {
				notifications.push(`${type}:${message}`);
			},
			setStatus: (_key, text) => {
				statusTexts.push(text);
			},
			custom: async factory => {
				customOpened += 1;
				let doneValue: unknown;
				customComponent = (await factory({}, mockTheme, {}, value => {
					doneValue = value;
				})) as { render?: (width: number) => unknown; handleInput?: (data: string) => void };
				const rendered = customComponent.render?.(100);
				customRender = Array.isArray(rendered) ? rendered.join("\n") : String(rendered ?? "");
				customComponent.handleInput?.("\x1b[C");
				return doneValue as undefined;
			},
			theme: mockTheme,
		},
	};

	const sessionStart = handlers.get("session_start")?.[0];
	assert(sessionStart, "session_start handler missing");
	await sessionStart({}, ctx);
	assert(refreshCount >= 1, "session_start should refresh prompt");

	const cavemanCommand = commands.get("caveman");
	assert(cavemanCommand, "/caveman command missing");

	await cavemanCommand("", ctx);
	assert(settings.get("caveman.defaultLevel") === "full", "/caveman should toggle off -> full");
	assert(appendedEntries.at(-1)?.customType === "caveman-level", "/caveman should append session entry");
	assert(statusTexts.some(text => text?.includes("CAVEMAN")), "status bar should include CAVEMAN label when active");
	assert(notifications.some(item => item.includes("Caveman mode: CAVEMAN")), "toggle should notify active level");

	await cavemanCommand("config", ctx);
	assert(customOpened === 1, "/caveman config should open custom UI");
	assert(customRender.includes("Default level for new sessions"), "config UI missing default level row");
	assert(customRender.includes("Show animated status bar"), "config UI missing show status row");
	assert(customRender.includes("Thinking mode"), "config UI missing thinking mode row");
	assert(customRender.includes("Apply to subagents"), "config UI missing affect subagents row");
	assert(settings.get("caveman.defaultLevel") === "full", "config open should not disturb active runtime override");

	settings.clearOverride("caveman.defaultLevel");
	appendedEntries.push({ type: "custom", customType: "caveman-level", data: { level: "ultra" } });
	await sessionStart({}, ctx);
	assert(settings.get("caveman.defaultLevel") === "ultra", "session_start should restore most recent caveman level");
	assert(statusTexts.some(text => text?.includes("ULTRA")), "restored status should include ULTRA label");

	const sessionShutdown = handlers.get("session_shutdown")?.[0];
	if (sessionShutdown) {
		await sessionShutdown({}, ctx);
	}

	console.log("Verified caveman prompt injection, subagent gating, command toggle, config dialog rendering, and session restore.");
}

await main();
