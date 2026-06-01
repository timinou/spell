import { Container, type SettingItem, SettingsList, type SettingsListTheme, Spacer, Text } from "@spell/pi-tui";
import { logger } from "@spell/pi-utils";
import type { Settings, SettingValue } from "../../config/settings";
import { DynamicBorder } from "../../modes/components/dynamic-border";
import type { Theme } from "../../modes/theme/theme";
import type { ExtensionCommandContext, ExtensionContext, ExtensionFactory } from "./types";

const LEVELS = ["off", "lite", "full", "ultra", "wenyan-lite", "wenyan", "wenyan-ultra"] as const;

type CavemanLevel = SettingValue<"caveman.defaultLevel">;
type ActiveCavemanLevel = Exclude<CavemanLevel, "off">;

interface FireAnimation {
	label: string;
	intervalMs: number;
}

const RED = "\x1b[38;5;196m";
const ORANGE = "\x1b[38;5;208m";
const YELLOW = "\x1b[38;5;220m";
const WHITE_HOT = "\x1b[38;5;230m";
const EMBER = "\x1b[38;5;52m";
const RESET = "\x1b[0m";
const STATUS_KEY = "caveman";

const FIRE_FRAMES = [
	`${RED}⠠${ORANGE}⠄${RESET}`,
	`${ORANGE}⠔${YELLOW}⠂${RESET}`,
	`${YELLOW}⠊${WHITE_HOT}⠑${RESET}`,
	`${WHITE_HOT}⠑${YELLOW}⠊${RESET}`,
	`${YELLOW}⠂${ORANGE}⠔${RESET}`,
	`${ORANGE}⠄${RED}⠠${RESET}`,
	`${RED}⠠${EMBER}⠄${RESET}`,
	`${EMBER}⠔${RED}⠂${RESET}`,
] as const;

const ANIMATIONS: Record<ActiveCavemanLevel, FireAnimation> = {
	lite: { label: "LITE", intervalMs: 300 },
	full: { label: "CAVEMAN", intervalMs: 200 },
	ultra: { label: "ULTRA", intervalMs: 100 },
	"wenyan-lite": { label: "文言", intervalMs: 300 },
	wenyan: { label: "文言文", intervalMs: 200 },
	"wenyan-ultra": { label: "文言文極", intervalMs: 100 },
};

function buildDialogSettingsListTheme(dialogTheme: Theme): SettingsListTheme {
	return {
		label: (text: string, selected: boolean) => (selected ? dialogTheme.fg("accent", text) : text),
		value: (text: string, selected: boolean) =>
			selected ? dialogTheme.fg("accent", text) : dialogTheme.fg("muted", text),
		description: (text: string) => dialogTheme.fg("dim", text),
		cursor: dialogTheme.fg("accent", `${dialogTheme.nav.cursor} `),
		hint: (text: string) => dialogTheme.fg("dim", text),
	};
}

class CavemanSettingsDialog extends Container {
	#settingsList: SettingsList;

	constructor(
		dialogTheme: Theme,
		items: SettingItem[],
		onChange: (id: string, newValue: string) => void,
		onClose: () => void,
	) {
		super();
		this.addChild(new DynamicBorder());
		this.addChild(new Text(dialogTheme.bold(dialogTheme.fg("accent", "  Caveman Config")), 0, 0));
		this.addChild(new Text(dialogTheme.fg("muted", "  Persisted to spell.kdl"), 0, 0));
		this.addChild(new Spacer(1));
		this.#settingsList = new SettingsList(
			items,
			Math.min(items.length, 10),
			buildDialogSettingsListTheme(dialogTheme),
			onChange,
			onClose,
		);
		this.addChild(this.#settingsList);
		this.addChild(new Spacer(1));
		this.addChild(new Text(dialogTheme.fg("dim", "  ←→ change · Esc close"), 0, 0));
		this.addChild(new DynamicBorder());
	}

	handleInput(data: string): void {
		this.#settingsList.handleInput(data);
	}
}

function isCavemanLevel(value: unknown): value is CavemanLevel {
	return typeof value === "string" && LEVELS.includes(value as CavemanLevel);
}

function getStoredLevel(ctx: ExtensionContext): CavemanLevel | undefined {
	let storedLevel: CavemanLevel | undefined;
	for (const entry of ctx.sessionManager.getEntries()) {
		if (entry.type !== "custom" || entry.customType !== "caveman-level") {
			continue;
		}
		const candidate = (entry.data as { level?: unknown } | undefined)?.level;
		if (isCavemanLevel(candidate)) {
			storedLevel = candidate;
		}
	}
	return storedLevel;
}

function buildSettingItems(settings: Settings): SettingItem[] {
	return [
		{
			id: "caveman.defaultLevel",
			label: "Default level for new sessions",
			description: "Persisted default in spell.kdl",
			currentValue: settings.get("caveman.defaultLevel"),
			values: [...LEVELS],
		},
		{
			id: "caveman.showStatus",
			label: "Show animated status bar",
			description: "Campfire footer indicator while caveman mode active",
			currentValue: settings.get("caveman.showStatus") ? "true" : "false",
			values: ["true", "false"],
		},
		{
			id: "caveman.thinkingMode",
			label: "Thinking mode",
			description: "Symbolic shorthand or verbose thinking",
			currentValue: settings.get("caveman.thinkingMode"),
			values: ["caveman", "normal"],
		},
		{
			id: "caveman.affectSubagents",
			label: "Apply to subagents",
			description: "Whether delegated task subagents inherit caveman mode",
			currentValue: settings.get("caveman.affectSubagents") ? "true" : "false",
			values: ["true", "false"],
		},
	];
}

export function createCavemanExtension(settings: Settings): ExtensionFactory {
	return api => {
		let level: CavemanLevel = settings.get("caveman.defaultLevel");
		let frameIndex = 0;
		let animationTimer: NodeJS.Timeout | undefined;

		const stopAnimation = (): void => {
			if (animationTimer) {
				clearInterval(animationTimer);
				animationTimer = undefined;
			}
			frameIndex = 0;
		};

		const syncLevelFromSettings = (): CavemanLevel => {
			level = settings.get("caveman.defaultLevel");
			return level;
		};

		const syncStatus = (ctx: Pick<ExtensionContext, "hasUI" | "ui">): void => {
			stopAnimation();
			const nextLevel = syncLevelFromSettings();
			const showStatus = settings.get("caveman.showStatus");
			if (!ctx.hasUI || nextLevel === "off" || !showStatus) {
				ctx.ui.setStatus(STATUS_KEY, undefined);
				return;
			}

			const animation = ANIMATIONS[nextLevel];
			const renderFrame = (): void => {
				const icon = FIRE_FRAMES[frameIndex % FIRE_FRAMES.length] ?? FIRE_FRAMES[0];
				ctx.ui.setStatus(
					STATUS_KEY,
					`${icon} ${ctx.ui.theme.fg("muted", "caveman")}${ctx.ui.theme.fg("text", ` ${animation.label}`)}`,
				);
				frameIndex += 1;
			};

			renderFrame();
			animationTimer = setInterval(renderFrame, animation.intervalMs);
		};

		const refreshPrompt = async (ctx: ExtensionContext): Promise<boolean> => {
			try {
				await ctx.refreshBaseSystemPrompt();
				return true;
			} catch (error) {
				logger.warn("Failed to refresh caveman system prompt", {
					error: error instanceof Error ? error.message : String(error),
				});
				return false;
			}
		};

		const restoreFromSession = async (ctx: ExtensionContext): Promise<void> => {
			const storedLevel = getStoredLevel(ctx);
			if (storedLevel) {
				settings.override("caveman.defaultLevel", storedLevel);
			} else {
				settings.clearOverride("caveman.defaultLevel");
			}
			syncStatus(ctx);
			await refreshPrompt(ctx);
		};

		const applyRuntimeLevel = async (nextLevel: CavemanLevel, ctx: ExtensionCommandContext): Promise<boolean> => {
			settings.override("caveman.defaultLevel", nextLevel);
			level = nextLevel;
			api.appendEntry("caveman-level", { level: nextLevel });
			syncStatus(ctx);
			return await refreshPrompt(ctx);
		};

		const updatePersistedSetting = (id: string, newValue: string, ctx: ExtensionCommandContext): void => {
			switch (id) {
				case "caveman.defaultLevel":
					if (isCavemanLevel(newValue)) {
						settings.set("caveman.defaultLevel", newValue);
					}
					break;
				case "caveman.showStatus":
					settings.set("caveman.showStatus", newValue === "true");
					break;
				case "caveman.thinkingMode":
					if (newValue === "caveman" || newValue === "normal") {
						settings.set("caveman.thinkingMode", newValue);
					}
					break;
				case "caveman.affectSubagents":
					settings.set("caveman.affectSubagents", newValue === "true");
					break;
				default:
					return;
			}

			syncStatus(ctx);
			void refreshPrompt(ctx);
		};

		const openConfig = async (ctx: ExtensionCommandContext): Promise<void> => {
			if (!ctx.hasUI) {
				ctx.ui.notify("Caveman config needs interactive UI", "warning");
				return;
			}

			await ctx.ui.custom<void>((_tui, dialogTheme, _keybindings, done) => {
				return new CavemanSettingsDialog(
					dialogTheme,
					buildSettingItems(settings),
					(id, newValue) => {
						updatePersistedSetting(id, newValue, ctx);
					},
					() => done(undefined),
				);
			});
		};

		api.on("session_start", async (_event, ctx) => {
			await restoreFromSession(ctx);
		});
		api.on("session_switch", async (_event, ctx) => {
			await restoreFromSession(ctx);
		});
		api.on("session_branch", async (_event, ctx) => {
			await restoreFromSession(ctx);
		});
		api.on("session_tree", async (_event, ctx) => {
			await restoreFromSession(ctx);
		});
		api.on("session_shutdown", async () => {
			stopAnimation();
		});

		api.registerCommand("caveman", {
			description: "Toggle caveman mode, set level, or open caveman config",
			handler: async (args, ctx) => {
				const arg = args.trim().toLowerCase();
				if (arg === "config") {
					await openConfig(ctx);
					return;
				}

				const currentLevel = syncLevelFromSettings();
				let nextLevel: CavemanLevel | undefined;
				if (!arg) {
					nextLevel = currentLevel === "off" ? "full" : "off";
				} else if (isCavemanLevel(arg)) {
					nextLevel = arg;
				}

				if (!nextLevel) {
					ctx.ui.notify(`Unknown caveman level: ${arg}`, "error");
					return;
				}

				const promptRefreshed = await applyRuntimeLevel(nextLevel, ctx);
				if (!promptRefreshed) {
					ctx.ui.notify(
						nextLevel === "off"
							? "Caveman mode off, but prompt refresh failed. Change applies after next rebuild."
							: `Caveman mode: ${ANIMATIONS[nextLevel].label}, but prompt refresh failed. Change applies after next rebuild.`,
						"warning",
					);
					return;
				}

				ctx.ui.notify(
					nextLevel === "off" ? "Caveman mode off." : `Caveman mode: ${ANIMATIONS[nextLevel].label}`,
					"info",
				);
			},
		});
	};
}
