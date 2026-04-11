/**
 * Interactive mode for the coding agent.
 * Handles TUI rendering and user interaction, delegating business logic to AgentSession.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { type Agent, type AgentMessage, ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage, ImageContent, Message, Model, UsageReport } from "@oh-my-pi/pi-ai";
import { NiriOverviewController } from "@oh-my-pi/pi-niri";
import { appendItemToFile, extractIdLinks, generateId, orgToMarkdown, resolveCategories } from "@oh-my-pi/pi-org";
import type { Component, OverlayHandle, SlashCommand } from "@oh-my-pi/pi-tui";
import {
	Container,
	Loader,
	Markdown,
	ProcessTerminal,
	padding,
	Spacer,
	Text,
	TUI,
	truncateToWidth,
	visibleWidth,
} from "@oh-my-pi/pi-tui";
import { APP_NAME, getProjectDir, hsvToRgb, isEnoent, logger, postmortem } from "@oh-my-pi/pi-utils";
import chalk from "chalk";
import { KeybindingsManager } from "../config/keybindings";
import { renderPromptTemplate } from "../config/prompt-templates";
import { type Settings, settings } from "../config/settings";
import { loadTaskPolicies, mergePolicies } from "../config/task-policies";
import type { ExtensionUIContext, ExtensionUIDialogOptions } from "../extensibility/extensions";
import type { CompactOptions } from "../extensibility/extensions/types";
import { BUILTIN_SLASH_COMMANDS, loadSlashCommands } from "../extensibility/slash-commands";
import { resolveLocalUrlToPath } from "../internal-urls";
import { type PlanWave, planWavesToTodoGroups } from "../orchestrators/fluid";
import { renameApprovedPlanFile } from "../plan-mode/approved-plan";
import { approvePlanItem, buildOrgConfig, type OrgPlanRef, resolvePlanItem } from "../plan-mode/org-plan";
import type { UserModeState } from "../plan-mode/state";
import planAuditPrompt from "../prompts/system/plan-audit.md" with { type: "text" };
import planModeApprovedPrompt from "../prompts/system/plan-mode-approved.md" with { type: "text" };
import type { AgentSession, AgentSessionEvent } from "../session/agent-session";
import { HistoryStorage } from "../session/history-storage";
import type { SessionContext, SessionManager } from "../session/session-manager";
import { getRecentSessions } from "../session/session-manager";
import { formatExitTokenSummary, formatSubtaskExitSummary } from "../session/token-summary";
import type { SessionBridgeClient } from "../session-bridge/client";
import { raceWithBridge } from "../session-bridge/race";
import { getModeCommandDefs, registerModeCommands } from "../slash-commands/builtin-registry";
import { STTController, type SttState } from "../stt";
import { SubagentTracker } from "../task/subagent-tracker";
import type { SingleResult } from "../task/types";
import type { ExitPlanModeDetails } from "../tools";
import { replaceTabs } from "../tools/render-utils";
import { isDelegatedTask } from "../tools/todo-write";
import type { EventBus } from "../utils/event-bus";
import { setTerminalTitle } from "../utils/title-generator";
import type { AssistantMessageComponent } from "./components/assistant-message";
import { AuditModeOverlay } from "./components/audit-mode-overlay";
import type { BashExecutionComponent } from "./components/bash-execution";
import { CustomEditor } from "./components/custom-editor";
import { DynamicBorder } from "./components/dynamic-border";
import type { HookEditorComponent } from "./components/hook-editor";
import type { HookInputComponent } from "./components/hook-input";
import type { HookSelectorComponent } from "./components/hook-selector";
import { PlanModeOverlay } from "./components/plan-mode-overlay";
import type { PythonExecutionComponent } from "./components/python-execution";
import { StatusLineComponent } from "./components/status-line";
import type { ToolExecutionHandle } from "./components/tool-execution";
import { WelcomeComponent } from "./components/welcome";
import { BtwController } from "./controllers/btw-controller";
import { CommandController } from "./controllers/command-controller";
import { EventController } from "./controllers/event-controller";
import { ExtensionUiController } from "./controllers/extension-ui-controller";
import { InputController } from "./controllers/input-controller";
import { MCPCommandController } from "./controllers/mcp-command-controller";
import { SelectorController } from "./controllers/selector-controller";
import { SSHCommandController } from "./controllers/ssh-command-controller";
import { OAuthManualInputManager } from "./oauth-manual-input";
import { setMermaidRenderCallback } from "./theme/mermaid-cache";
import type { Theme } from "./theme/theme";
import {
	getEditorTheme,
	getMarkdownTheme,
	getSymbolTheme,
	onTerminalAppearanceChange,
	onThemeChange,
	theme,
} from "./theme/theme";
import type { CompactionQueuedMessage, InteractiveModeContext, SubmittedUserInput, TodoGroup, TodoItem } from "./types";
import { UiHelpers } from "./utils/ui-helpers";

/**
 * Extract key design decisions from an approved plan's text for design-history.jsonl.
 * Uses simple regex matching on the structured Design Direction Brief sections.
 */
function extractDesignBriefEntry(planContent: string): {
	ts: string;
	direction: string;
	fonts: string[];
	palette: string;
	memorable: string;
} {
	const direction =
		/aesthetic direction[:\s]+([^\n]+)/i.exec(planContent)?.[1]?.trim() ??
		/direction[:\s]+([^\n]+)/i.exec(planContent)?.[1]?.trim() ??
		"unknown";
	const typographyMatch = /typography[:\s]+([^\n]+)/i.exec(planContent);
	const fonts = typographyMatch
		? typographyMatch[1]
				.split(/[+,]|\band\b/i)
				.map(f => f.trim())
				.filter(Boolean)
		: [];
	const palette =
		/color strategy[:\s]+([^\n]+)/i.exec(planContent)?.[1]?.trim() ??
		/palette[:\s]+([^\n]+)/i.exec(planContent)?.[1]?.trim() ??
		"";
	const memorable =
		/memorability test[:\s]+([^\n]+)/i.exec(planContent)?.[1]?.trim() ??
		/memorable[:\s]+([^\n]+)/i.exec(planContent)?.[1]?.trim() ??
		"";
	return { ts: new Date().toISOString(), direction, fonts, palette, memorable };
}

const EDITOR_MAX_HEIGHT_MIN = 6;
const EDITOR_MAX_HEIGHT_MAX = 18;
const EDITOR_RESERVED_ROWS = 12;
const EDITOR_FALLBACK_ROWS = 24;

class UserPausedFrameContainer extends Container {
	constructor(private readonly isPaused: () => boolean) {
		super();
	}

	render(width: number): string[] {
		if (!this.isPaused()) {
			return super.render(width);
		}

		const frameWidth = Math.max(2, width);
		const innerWidth = Math.max(1, frameWidth - 2);
		const colorize = theme.getUserPausedBorderColor();
		const vertical = colorize("║");
		const top = colorize(`╔${"═".repeat(innerWidth)}╗`);
		const bottom = colorize(`╚${"═".repeat(innerWidth)}╝`);
		const childLines = super.render(innerWidth);
		const maxFrameBodyRows = Math.max(0, (process.stdout.rows ?? 24) - 2);
		const visibleChildLines = childLines.slice(Math.max(0, childLines.length - maxFrameBodyRows));
		const framedLines = visibleChildLines.map(line => {
			const padSize = Math.max(0, innerWidth - visibleWidth(line));
			return `${vertical}${line}${padding(padSize)}${vertical}`;
		});

		return [top, ...framedLines, bottom];
	}
}

/** Options for creating an InteractiveMode instance (for future API use) */
export interface InteractiveModeOptions {
	/** Providers that were migrated during startup */
	migratedProviders?: string[];
	/** Warning message if model fallback occurred */
	modelFallbackMessage?: string;
	/** Initial message to send */
	initialMessage?: string;
	/** Initial images to include with the message */
	initialImages?: ImageContent[];
	/** Additional initial messages to queue */
	initialMessages?: string[];
}

export class InteractiveMode implements InteractiveModeContext {
	session: AgentSession;
	sessionManager: SessionManager;
	settings: Settings;
	keybindings: KeybindingsManager;
	agent: Agent;
	historyStorage?: HistoryStorage;

	ui: TUI;
	chatContainer: Container;
	pendingMessagesContainer: Container;
	statusContainer: Container;
	todoContainer: Container;
	btwContainer: Container;
	editor: CustomEditor;
	editorContainer: Container;
	statusLine: StatusLineComponent;

	isInitialized = false;
	isBackgrounded = false;
	isBashMode = false;
	toolOutputExpanded = false;
	todoExpanded = false;
	planModeEnabled = false;
	planModePaused = false;
	planModePlanFilePath: string | undefined = undefined;
	planModeUltraplan = false;
	planModeFlavor: "design" | undefined = undefined;
	#auditDepth = 0;
	#auditMaxDepth = 2;
	#isAuditEscalation = false;
	todoGroups: TodoGroup[] = [];
	hideThinkingBlock = false;
	pendingImages: ImageContent[] = [];
	compactionQueuedMessages: CompactionQueuedMessage[] = [];
	pendingTools = new Map<string, ToolExecutionHandle>();
	pendingBashComponents: BashExecutionComponent[] = [];
	bashComponent: BashExecutionComponent | undefined = undefined;
	pendingPythonComponents: PythonExecutionComponent[] = [];
	pythonComponent: PythonExecutionComponent | undefined = undefined;
	isPythonMode = false;
	streamingComponent: AssistantMessageComponent | undefined = undefined;
	streamingMessage: AssistantMessage | undefined = undefined;
	loadingAnimation: Loader | undefined = undefined;
	autoCompactionLoader: Loader | undefined = undefined;
	retryLoader: Loader | undefined = undefined;
	#pendingWorkingMessage: string | undefined;
	readonly #defaultWorkingMessage = `Working… (esc to interrupt)`;
	autoCompactionEscapeHandler?: () => void;
	retryEscapeHandler?: () => void;
	unsubscribe?: () => void;
	onInputCallback?: (input: SubmittedUserInput) => void;
	isPendingApproval = false;
	/** Set when user explicitly acknowledged needs_input; silences the actionable indicator. */
	#isUserPaused = false;
	optimisticUserMessageSignature: string | undefined = undefined;
	#pendingSubmittedInput: SubmittedUserInput | undefined;
	lastSigintTime = 0;
	lastEscapeTime = 0;
	shutdownRequested = false;
	#isShuttingDown = false;
	hookSelector: HookSelectorComponent | undefined = undefined;
	hookInput: HookInputComponent | undefined = undefined;
	#userPausedFrame: UserPausedFrameContainer;
	hookEditor: HookEditorComponent | undefined = undefined;
	lastStatusSpacer: Spacer | undefined = undefined;
	lastStatusText: Text | undefined = undefined;
	fileSlashCommands: Set<string> = new Set();
	skillCommands: Map<string, string> = new Map();
	oauthManualInput: OAuthManualInputManager = new OAuthManualInputManager();

	#pendingSlashCommands: SlashCommand[] = [];
	#cleanupUnsubscribe?: () => void;
	readonly #version: string;
	readonly #changelogMarkdown: string | undefined;
	#planModePreviousTools: string[] | undefined;
	#planModePreviousModel: Model | undefined;
	#pendingModelSwitch: Model | undefined;
	#planModeHasEntered = false;
	#planModeOverlay: PlanModeOverlay | undefined;
	#planModeOverlayHandle: OverlayHandle | undefined;
	#auditOverlay: AuditModeOverlay | undefined;
	#auditOverlayHandle: OverlayHandle | undefined;
	readonly lspServers:
		| Array<{ name: string; status: "ready" | "error"; fileTypes: string[]; error?: string }>
		| undefined = undefined;
	mcpManager?: import("../mcp").MCPManager;
	taskManager?: import("../orchestrators/canvas-task-manager").CanvasTaskManager;
	eventBus?: EventBus;
	#subagentTracker?: SubagentTracker;
	sessionBridge?: SessionBridgeClient;
	readonly #toolUiContextSetter: (uiContext: ExtensionUIContext, hasUI: boolean) => void;

	readonly #btwController: BtwController;
	readonly #commandController: CommandController;
	readonly #eventController: EventController;
	readonly #extensionUiController: ExtensionUiController;
	readonly #inputController: InputController;
	readonly #selectorController: SelectorController;
	readonly #uiHelpers: UiHelpers;
	#niriController: NiriOverviewController | undefined = undefined;
	#niriListener: (() => void) | undefined = undefined;
	#sttController: STTController | undefined;
	#voiceAnimationInterval: NodeJS.Timeout | undefined;
	#voiceHue = 0;
	#voicePreviousShowHardwareCursor: boolean | null = null;
	#voicePreviousUseTerminalCursor: boolean | null = null;
	#resizeHandler?: () => void;

	constructor(
		session: AgentSession,
		version: string,
		changelogMarkdown: string | undefined = undefined,
		setToolUIContext: (uiContext: ExtensionUIContext, hasUI: boolean) => void = () => {},
		lspServers:
			| Array<{ name: string; status: "ready" | "error"; fileTypes: string[]; error?: string }>
			| undefined = undefined,
		mcpManager?: import("../mcp").MCPManager,
		taskManager?: import("../orchestrators/canvas-task-manager").CanvasTaskManager,
		eventBus?: EventBus,
		sessionBridge?: SessionBridgeClient,
	) {
		this.session = session;
		this.sessionManager = session.sessionManager;
		this.settings = session.settings;
		this.keybindings = KeybindingsManager.inMemory();
		this.agent = session.agent;
		this.#version = version;
		this.#changelogMarkdown = changelogMarkdown;
		this.#toolUiContextSetter = setToolUIContext;
		this.lspServers = lspServers;
		this.mcpManager = mcpManager;
		this.taskManager = taskManager;
		this.eventBus = eventBus;
		this.sessionBridge = sessionBridge;

		this.ui = new TUI(new ProcessTerminal(), settings.get("showHardwareCursor"));
		this.ui.setClearOnShrink(settings.get("clearOnShrink"));
		setMermaidRenderCallback(() => this.ui.requestRender());
		this.chatContainer = new Container();
		this.pendingMessagesContainer = new Container();
		this.statusContainer = new Container();
		this.todoContainer = new Container();
		this.btwContainer = new Container();
		this.editor = new CustomEditor(getEditorTheme());
		this.editor.setUseTerminalCursor(this.ui.getShowHardwareCursor());
		this.editor.setAutocompleteMaxVisible(settings.get("autocompleteMaxVisible"));
		this.editor.onAutocompleteCancel = () => {
			this.ui.requestRender(true);
		};
		this.editor.onAutocompleteUpdate = () => {
			this.ui.requestRender();
		};
		this.#syncEditorMaxHeight();
		this.#resizeHandler = () => {
			this.#syncEditorMaxHeight();
		};
		process.stdout.on("resize", this.#resizeHandler);
		try {
			this.historyStorage = HistoryStorage.open();
			this.editor.setHistoryStorage(this.historyStorage);
		} catch (error) {
			logger.warn("History storage unavailable", { error: String(error) });
		}
		this.editorContainer = new Container();
		this.editorContainer.addChild(this.editor);
		this.#userPausedFrame = new UserPausedFrameContainer(() => this.#isUserPaused);
		this.statusLine = new StatusLineComponent(session);
		this.statusLine.setAutoCompactEnabled(session.autoCompactionEnabled);
		if (this.eventBus) {
			this.#subagentTracker = new SubagentTracker(this.eventBus, () => {
				this.statusLine.setSubagentInfo(this.#subagentTracker?.getInfo() ?? null);
				if (this.todoGroups.length > 0) {
					this.#renderTodoList();
				}
				this.ui.requestRender();
			});
			this.statusLine.setSubagentInfo(this.#subagentTracker.getInfo());
		} else {
			this.statusLine.setSubagentInfo(null);
		}

		this.hideThinkingBlock = settings.get("hideThinkingBlock");

		const builtinCommandNames = new Set(BUILTIN_SLASH_COMMANDS.map(c => c.name));
		const hookCommands: SlashCommand[] = (
			this.session.extensionRunner?.getRegisteredCommands(builtinCommandNames) ?? []
		).map(cmd => ({
			name: cmd.name,
			description: cmd.description ?? "(hook command)",
			getArgumentCompletions: cmd.getArgumentCompletions,
		}));

		// Convert custom commands (TypeScript) to SlashCommand format
		const customCommands: SlashCommand[] = this.session.customCommands.map(loaded => ({
			name: loaded.command.name,
			description: `${loaded.command.description} (${loaded.source})`,
		}));

		// Build skill commands from session.skills (if enabled)
		const skillCommandList: SlashCommand[] = [];
		if (settings.get("skills.enableSkillCommands")) {
			for (const skill of this.session.skills) {
				const commandName = `skill:${skill.name}`;
				this.skillCommands.set(commandName, skill.filePath);
				skillCommandList.push({ name: commandName, description: skill.description });
			}
		}

		// Store pending commands for init() where file commands are loaded async
		this.#pendingSlashCommands = [...BUILTIN_SLASH_COMMANDS, ...hookCommands, ...customCommands, ...skillCommandList];

		this.#uiHelpers = new UiHelpers(this);
		this.#btwController = new BtwController(this);
		this.#extensionUiController = new ExtensionUiController(this);
		this.#eventController = new EventController(this);
		this.#commandController = new CommandController(this);
		this.#selectorController = new SelectorController(this);
		this.#inputController = new InputController(this);
	}

	async init(): Promise<void> {
		if (this.isInitialized) return;

		this.keybindings = await logger.timeAsync("InteractiveMode.init:keybindings", () => KeybindingsManager.create());

		// Register session manager flush for signal handlers (SIGINT, SIGTERM, SIGHUP)
		// On crash, write a crash marker entry before flushing so the JSONL records the abnormal exit.
		const crashReasons = new Set<postmortem.Reason>([
			postmortem.Reason.UNCAUGHT_EXCEPTION,
			postmortem.Reason.UNHANDLED_REJECTION,
			postmortem.Reason.SIGHUP,
			postmortem.Reason.SIGTERM,
			postmortem.Reason.SIGINT,
		]);
		this.#cleanupUnsubscribe = postmortem.register("session-manager-flush", reason => {
			if (crashReasons.has(reason)) {
				this.sessionManager.appendCrashMarker(reason);
			}
			return this.sessionManager.flush();
		});

		await logger.timeAsync("InteractiveMode.init:slashCommands", () =>
			this.refreshSlashCommandState(getProjectDir()),
		);

		// Register mode-derived slash commands
		const modeConfigs = this.session.getAllModeConfigs();
		if (modeConfigs.size > 0) {
			const modeWarnings = registerModeCommands(modeConfigs, this);
			for (const w of modeWarnings) {
				logger.warn(w);
			}
		}

		// Get current model info for welcome screen
		const modelName = this.session.model?.name ?? "Unknown";
		const providerName = this.session.model?.provider ?? "Unknown";

		// Get recent sessions
		const recentSessions = await logger.timeAsync("InteractiveMode.init:recentSessions", () =>
			getRecentSessions(this.sessionManager.getSessionDir()).then(sessions =>
				sessions.map(s => ({
					name: s.name,
					timeAgo: s.timeAgo,
				})),
			),
		);

		// Convert LSP servers to welcome format
		const lspServerInfo =
			this.lspServers?.map(s => ({
				name: s.name,
				status: s.status as "ready" | "error" | "connecting",
				fileTypes: s.fileTypes,
			})) ?? [];

		const startupQuiet = settings.get("startup.quiet");

		if (!startupQuiet) {
			// Add welcome header
			const welcome = new WelcomeComponent(this.#version, modelName, providerName, recentSessions, lspServerInfo);

			// Setup UI layout
			this.ui.addChild(new Spacer(1));
			this.ui.addChild(welcome);
			this.ui.addChild(new Spacer(1));

			// Add changelog if provided
			if (this.#changelogMarkdown) {
				this.ui.addChild(new DynamicBorder());
				if (settings.get("collapseChangelog")) {
					const versionMatch = this.#changelogMarkdown.match(/##\s+\[?(\d+\.\d+\.\d+)\]?/);
					const latestVersion = versionMatch ? versionMatch[1] : this.#version;
					const condensedText = `Updated to v${latestVersion}. Use ${theme.bold("/changelog")} to view full changelog.`;
					this.ui.addChild(new Text(condensedText, 1, 0));
				} else {
					this.ui.addChild(new Text(theme.bold(theme.fg("accent", "What's New")), 1, 0));
					this.ui.addChild(new Spacer(1));
					this.ui.addChild(new Markdown(this.#changelogMarkdown.trim(), 1, 0, getMarkdownTheme()));
					this.ui.addChild(new Spacer(1));
				}
				this.ui.addChild(new DynamicBorder());
			}
		}

		// Set terminal title if session already has one (resumed session)
		const existingTitle = this.sessionManager.getSessionName();
		if (existingTitle) {
			setTerminalTitle(`pi: ${existingTitle}`);
		}

		this.ui.addChild(this.#userPausedFrame);
		this.#userPausedFrame.addChild(this.chatContainer);
		this.#userPausedFrame.addChild(this.pendingMessagesContainer);
		this.#userPausedFrame.addChild(this.statusContainer);
		this.#userPausedFrame.addChild(this.todoContainer);
		this.#userPausedFrame.addChild(this.btwContainer);
		this.#userPausedFrame.addChild(this.statusLine); // Only renders hook statuses (main status in editor border)
		this.#userPausedFrame.addChild(new Spacer(1));
		this.#userPausedFrame.addChild(this.editorContainer);
		this.ui.setFocus(this.editor);

		this.#inputController.setupKeyHandlers();
		this.#inputController.setupEditorSubmitHandler();

		// Load initial todos
		await this.#loadTodoList();

		// Start the UI
		this.ui.start();
		this.#syncEditorMaxHeight();
		this.isInitialized = true;
		this.ui.requestRender(true);

		// Set initial terminal title (will be updated when session title is generated)
		this.ui.terminal.setTitle("✦");

		// Initialize hooks with TUI-based UI context
		await this.initHooksAndCustomTools();

		// Register audit suggest callback for popup bridge
		this.session.setAuditSuggestCallback(async () => {
			const choice = await this.showHookSelector("Implementation complete", ["Run audit", "Skip audit"]);
			return choice === "Run audit";
		});

		// Restore mode from session (e.g. plan mode on resume)
		await this.#restoreModeFromSession();

		// Subscribe to agent events
		this.#subscribeToAgent();

		// Set up theme file watcher
		onThemeChange(() => {
			this.ui.invalidate();
			this.updateEditorBorderColor();
			this.ui.requestRender();
		});

		// Subscribe to terminal dark/light appearance changes.
		// The terminal queries background color via OSC 11 at startup and on
		// Mode 2031 notifications, computing luminance to detect dark/light.
		this.ui.terminal.onAppearanceChange(mode => {
			onTerminalAppearanceChange(mode);
		});

		// Set up git branch watcher
		this.statusLine.watchBranch(() => {
			this.updateEditorTopBorder();
			this.ui.requestRender();
		});

		// Connect to Niri compositor IPC (if running inside Niri)
		const niriSocket = Bun.env.NIRI_SOCKET;
		if (niriSocket) {
			const ctx = this;
			this.#niriController = new NiriOverviewController(niriSocket, {
				ui: this.ui,
				session: {
					get isStreaming() {
						return ctx.session.isStreaming;
					},
					get messages() {
						return ctx.session.messages;
					},
					get state() {
						return ctx.session.state;
					},
				},
				get onInputCallback() {
					return ctx.onInputCallback;
				},
				get isAwaitingHookInput() {
					return ctx.hookSelector !== undefined || ctx.hookInput !== undefined;
				},
				get isPendingApproval() {
					return ctx.isPendingApproval;
				},
				get isUserPaused() {
					return ctx.#isUserPaused;
				},
				sessionManager: this.sessionManager,
				get todoPhases() {
					return ctx.session.getTodoGroups();
				},
				getClearedCompletedCounts() {
					return ctx.session.getClearedCompletedCounts();
				},
				subscribe: listener => {
					ctx.#niriListener = listener;
					return ctx.session.subscribe(() => {
						listener();
					});
				},
				onOverviewChanged(isOpen, bg, resetBg) {
					if (ctx.#planModeOverlay) {
						ctx.#planModeOverlay.setBackground(isOpen ? (bg ?? null) : null, isOpen ? (resetBg ?? null) : null);
						ctx.ui.requestRender();
					}
				},
			});
		}

		// Initial top border update
		this.updateEditorTopBorder();
	}

	/** Reload slash commands and autocomplete for the provided working directory. */
	async refreshSlashCommandState(cwd?: string): Promise<void> {
		const basePath = cwd ?? this.sessionManager.getCwd();
		const fileCommands = await loadSlashCommands({ cwd: basePath });
		this.fileSlashCommands = new Set(fileCommands.map(cmd => cmd.name));
		const fileSlashCommands: SlashCommand[] = fileCommands.map(cmd => ({
			name: cmd.name,
			description: cmd.description,
		}));
		const modeCommandDefs = getModeCommandDefs();
		const autocompleteProvider = this.#inputController.createAutocompleteProvider(
			[...this.#pendingSlashCommands, ...fileSlashCommands, ...modeCommandDefs],
			basePath,
		);
		this.editor.setAutocompleteProvider(autocompleteProvider);
		this.session.setSlashCommands(fileCommands);
	}

	async getUserInput(): Promise<SubmittedUserInput> {
		const { promise, resolve } = Promise.withResolvers<SubmittedUserInput>();
		this.onInputCallback = input => {
			this.onInputCallback = undefined;
			resolve(input);
		};
		return promise;
	}

	startPendingSubmission(input: { text: string; images?: ImageContent[] }): SubmittedUserInput {
		const submission: SubmittedUserInput = {
			text: input.text,
			images: input.images,
			cancelled: false,
			started: false,
		};
		this.#pendingSubmittedInput = submission;
		this.optimisticUserMessageSignature = `${submission.text}\u0000${submission.images?.length ?? 0}`;
		this.addMessageToChat({
			role: "user",
			content: [{ type: "text", text: submission.text }, ...(submission.images ?? [])],
			attribution: "user",
			timestamp: Date.now(),
		});
		this.editor.setText("");
		this.ensureLoadingAnimation();
		this.ui.requestRender();
		return submission;
	}

	cancelPendingSubmission(): boolean {
		const submission = this.#pendingSubmittedInput;
		if (!submission || submission.started) {
			return false;
		}

		submission.cancelled = true;
		this.#pendingSubmittedInput = undefined;
		this.optimisticUserMessageSignature = undefined;
		this.#pendingWorkingMessage = undefined;
		if (this.loadingAnimation) {
			this.loadingAnimation.stop();
			this.loadingAnimation = undefined;
			this.statusContainer.clear();
		}
		this.pendingImages = submission.images ? [...submission.images] : [];
		this.rebuildChatFromMessages();
		this.editor.setText(submission.text);
		this.updateEditorBorderColor();
		this.ui.requestRender();
		return true;
	}

	markPendingSubmissionStarted(input: SubmittedUserInput): boolean {
		if (this.#pendingSubmittedInput !== input || input.cancelled) {
			return false;
		}
		input.started = true;
		return true;
	}

	finishPendingSubmission(input: SubmittedUserInput): void {
		if (this.#pendingSubmittedInput === input) {
			this.#pendingSubmittedInput = undefined;
		}
	}

	#computeEditorMaxHeight(): number {
		const rows = this.ui.terminal.rows;
		const terminalRows = Number.isFinite(rows) && rows > 0 ? rows : EDITOR_FALLBACK_ROWS;
		const maxHeight = terminalRows - EDITOR_RESERVED_ROWS;
		return Math.max(EDITOR_MAX_HEIGHT_MIN, Math.min(EDITOR_MAX_HEIGHT_MAX, maxHeight));
	}

	#syncEditorMaxHeight(): void {
		this.editor.setMaxHeight(this.#computeEditorMaxHeight());
	}

	updateEditorBorderColor(): void {
		if (this.planModeEnabled) {
			this.editor.borderColor = theme.getPlanModeBorderColor();
		} else if (this.isBashMode) {
			this.editor.borderColor = theme.getBashModeBorderColor();
		} else if (this.isPythonMode) {
			this.editor.borderColor = theme.getPythonModeBorderColor();
		} else {
			const level = this.session.thinkingLevel ?? ThinkingLevel.Off;
			this.editor.borderColor = theme.getThinkingBorderColor(level);
		}
		this.updateEditorTopBorder();
		this.ui.requestRender();
	}

	#showPlanModeOverlay(ultraplan: boolean, paused: boolean): void {
		if (!this.#planModeOverlay) {
			this.#planModeOverlay = new PlanModeOverlay(ultraplan, paused);
		} else {
			this.#planModeOverlay.update(ultraplan, paused);
		}
		if (!this.#planModeOverlayHandle) {
			const w = this.#planModeOverlay.measuredWidth();
			this.#planModeOverlayHandle = this.ui.showOverlay(this.#planModeOverlay, {
				anchor: "top-right",
				width: w,
				margin: 1,
				focusable: false,
				layer: 1,
			});
		}
		this.#planModeOverlayHandle.setHidden(false);
	}

	#hidePlanModeOverlay(): void {
		if (this.#planModeOverlayHandle) {
			this.#planModeOverlayHandle.hide();
			this.#planModeOverlayHandle = undefined;
			this.#planModeOverlay = undefined;
		}
	}

	showAuditOverlay(): void {
		if (!this.#auditOverlay) {
			this.#auditOverlay = new AuditModeOverlay(this.#auditDepth, this.#auditMaxDepth);
		} else {
			this.#auditOverlay.update(this.#auditDepth, this.#auditMaxDepth);
		}
		if (!this.#auditOverlayHandle) {
			const w = this.#auditOverlay.measuredWidth();
			this.#auditOverlayHandle = this.ui.showOverlay(this.#auditOverlay, {
				anchor: "top-left",
				width: w,
				margin: 1,
				focusable: false,
				layer: 1,
			});
		}
		this.#auditOverlayHandle.setHidden(false);
		this.statusLine.setAuditStatus({
			active: true,
			depth: this.#auditDepth,
			maxDepth: this.#auditMaxDepth,
		});
	}

	#hideAuditOverlay(): void {
		if (this.#auditOverlayHandle) {
			this.#auditOverlayHandle.hide();
			this.#auditOverlayHandle = undefined;
			this.#auditOverlay = undefined;
		}
		this.statusLine.setAuditStatus(undefined);
	}

	async handleAuditCommand(): Promise<void> {
		if (this.planModeEnabled) {
			this.showWarning("Cannot audit during plan mode.");
			return;
		}
		if (this.session.getAuditState().active) {
			this.showWarning("Audit already in progress.");
			return;
		}
		if (this.session.isStreaming) {
			this.showWarning("Cannot audit while agent is processing.");
			return;
		}
		this.session.setAuditState({ type: "audit", pending: false, active: true });
		this.showAuditOverlay();
		const prompt = renderPromptTemplate(planAuditPrompt, {
			auditDepth: this.#auditDepth,
			maxDepth: this.#auditMaxDepth,
		});
		await this.session.prompt(prompt, { synthetic: true });
	}

	async handleAuditEscalation(auditContent: string): Promise<void> {
		this.#hideAuditOverlay();
		if (this.#auditDepth >= this.#auditMaxDepth) {
			this.showStatus("Audit depth limit reached. Review audit findings manually.");
			return;
		}
		this.#auditDepth++;
		this.#isAuditEscalation = true;

		// Create audit org item referencing the source plan
		const sourceRef = this.session.getAuditState().sourceRef;
		let auditItemRef = "";
		if (this.settings.get("org.enabled")) {
			auditItemRef = await this.#createAuditItem(auditContent, sourceRef);
		}

		const prompt = auditItemRef
			? `Implement these audit recommendations from ${auditItemRef}:\n\n${auditContent}`
			: `Implement these audit recommendations:\n\n${auditContent}`;

		await this.handlePlanModeCommand(prompt);
	}

	async #createAuditItem(findings: string, sourceRef?: string): Promise<string> {
		try {
			const config = buildOrgConfig(this.settings);
			const cwd = this.sessionManager.getCwd();
			const categories = resolveCategories(config, cwd);
			const auditCat = categories.find(c => c.name === "audits");
			if (!auditCat) return "";

			await fs.mkdir(auditCat.absPath, { recursive: true });

			const sourceId = sourceRef?.replace(/^org:\/\//, "") ?? "";
			const sourceLabel = sourceId || "implementation";
			const title = `Audit: ${sourceLabel}`;

			const id = await generateId(auditCat.absPath, auditCat.prefix, title);
			const filePath = path.join(auditCat.absPath, `${id}.org`);

			const sourceSection = sourceId ? `* Source\nAuditing: [[id:${sourceId}]]\n` : "* Source\nManual audit\n";
			const body = `${sourceSection}\n* Findings\n${findings}`;

			await appendItemToFile(
				filePath,
				{
					title,
					category: "audits",
					state: "DOING",
					id,
					properties: { EFFORT: "1h", PRIORITY: "#B", LAYER: "coding-agent" },
					body,
				},
				"DOING",
			);

			return `org://${id}`;
		} catch (err) {
			logger.warn("Failed to create audit org item", { error: err });
			return "";
		}
	}

	updateEditorTopBorder(): void {
		const availableWidth = this.editor.getTopBorderAvailableWidth(this.ui.terminal.columns);
		const topBorder = this.statusLine.getTopBorder(availableWidth);
		this.editor.setTopBorder(topBorder);
	}

	rebuildChatFromMessages(): void {
		this.chatContainer.clear();
		const context = this.sessionManager.buildSessionContext();
		this.renderSessionContext(context);
	}

	recordSubagentResults(results: SingleResult[]): void {
		for (const result of results) {
			this.#subagentTracker?.recordCompletion(result);
		}
	}

	#renderChildTodoGroups(todo: TodoItem, prefix: string): string[] {
		const childGroups = todo.delegation?.childGroups?.filter(group => group.tasks.length > 0) ?? [];
		if (childGroups.length === 0) return [];
		const lines: string[] = [];
		for (const group of childGroups) {
			lines.push(theme.fg("muted", `${prefix}↳ ${group.name}`));
			for (const child of group.tasks) {
				const nestedChild = child.delegation
					? { ...child, delegation: { ...child.delegation, childGroups: undefined } }
					: child;
				lines.push(this.#formatTodoLine(nestedChild, `${prefix}  `));
			}
		}
		return lines;
	}

	#getDelegatedTodoContent(todo: TodoItem): string {
		if (!isDelegatedTask(todo)) {
			return todo.content;
		}
		if (todo.status !== "in_progress") {
			return `${todo.content} [delegated]`;
		}

		const sessionId = todo.delegation?.sessionId;
		if (!sessionId || sessionId === "pending") {
			return `${todo.content} [delegated]`;
		}

		const activity = this.#subagentTracker?.getActivityForSession(sessionId);
		if (!activity) {
			return `${todo.content} [delegated]`;
		}

		const spinnerFrames = getSymbolTheme().spinnerFrames;
		const spinner = spinnerFrames[Math.floor(Date.now() / 80) % spinnerFrames.length] ?? "";
		if (!activity.currentTool) {
			return spinner ? `${todo.content} ${spinner}` : todo.content;
		}

		const activityText = truncateToWidth(
			replaceTabs([activity.currentTool, activity.lastIntent].filter(Boolean).join(": ")),
			42,
		);
		if (!activityText) {
			return spinner ? `${todo.content} ${spinner}` : todo.content;
		}

		return `${todo.content} ${spinner} ${activityText}`;
	}

	#formatTodoLine(todo: TodoItem, prefix: string): string {
		const checkbox = theme.checkbox;
		const content = this.#getDelegatedTodoContent(todo);
		const childLines = this.#renderChildTodoGroups(todo, `${prefix}  `);
		switch (todo.status) {
			case "completed":
				return [
					theme.fg("success", `${prefix}${checkbox.checked} ${chalk.strikethrough(content)}`),
					...childLines,
				].join("\n");
			case "in_progress": {
				const main = theme.fg("accent", `${prefix}${checkbox.unchecked} ${content}`);
				const lines = [main];
				if (todo.details) {
					lines.push(...todo.details.split("\n").map(line => theme.fg("dim", `${prefix}  ${line}`)));
				}
				return [...lines, ...childLines].join("\n");
			}
			case "abandoned":
				return [
					theme.fg("error", `${prefix}${checkbox.unchecked} ${chalk.strikethrough(content)}`),
					...childLines,
				].join("\n");
			case "failed":
				return [theme.fg("error", `${prefix}${checkbox.unchecked} ${content}`), ...childLines].join("\n");
			default:
				return [theme.fg("dim", `${prefix}${checkbox.unchecked} ${content}`), ...childLines].join("\n");
		}
	}

	#getActiveGroup(groups: TodoGroup[]): TodoGroup | undefined {
		const nonEmpty = groups.filter(group => group.tasks.length > 0);
		const active = nonEmpty.find(group =>
			group.tasks.some(
				task => task.status === "pending" || task.status === "in_progress" || task.status === "failed",
			),
		);
		return active ?? nonEmpty[nonEmpty.length - 1];
	}

	#renderTodoList(): void {
		this.todoContainer.clear();
		const groups = this.todoGroups.filter(group => group.tasks.length > 0);
		if (groups.length === 0) {
			return;
		}

		const indent = "  ";
		const hook = theme.tree.hook;
		const lines = ["", indent + theme.bold(theme.fg("accent", "Todos"))];

		if (!this.todoExpanded) {
			const activeGroup = this.#getActiveGroup(groups);
			if (!activeGroup) return;
			lines.push(`${indent}${theme.fg("accent", `${hook} ${activeGroup.name}`)}`);
			const visibleTasks = activeGroup.tasks.slice(0, 5);
			visibleTasks.forEach((todo, index) => {
				const prefix = `${indent}${index === 0 ? hook : " "} `;
				lines.push(this.#formatTodoLine(todo, prefix));
			});
			if (visibleTasks.length < activeGroup.tasks.length) {
				const remaining = activeGroup.tasks.length - visibleTasks.length;
				lines.push(theme.fg("muted", `${indent}  ${hook} +${remaining} more (Ctrl+T to expand)`));
			}
			this.todoContainer.addChild(new Text(lines.join("\n"), 1, 0));
			return;
		}

		for (const group of groups) {
			lines.push(`${indent}${theme.fg("accent", `${hook} ${group.name}`)}`);
			group.tasks.forEach((todo, index) => {
				const prefix = `${indent}${index === 0 ? hook : " "} `;
				lines.push(this.#formatTodoLine(todo, prefix));
			});
		}

		this.todoContainer.addChild(new Text(lines.join("\n"), 1, 0));
	}

	async #loadTodoList(): Promise<void> {
		this.todoGroups = this.session.getTodoGroups();
		this.#renderTodoList();
	}

	async #getPlanFilePath(): Promise<string> {
		return "local://PLAN.md";
	}

	#resolvePlanFilePath(planFilePath: string): string {
		if (planFilePath.startsWith("local://")) {
			return resolveLocalUrlToPath(planFilePath, {
				getArtifactsDir: () => this.sessionManager.getArtifactsDir(),
				getSessionId: () => this.sessionManager.getSessionId(),
			});
		}
		return path.resolve(this.sessionManager.getCwd(), planFilePath);
	}

	#updatePlanModeStatus(): void {
		const status =
			this.planModeEnabled || this.planModePaused
				? {
						enabled: this.planModeEnabled,
						paused: this.planModePaused,
						ultraplan: this.planModeUltraplan,
					}
				: undefined;
		this.statusLine.setPlanModeStatus(status);
		this.updateEditorTopBorder();
		this.ui.requestRender();
	}

	async #applyPlanModeModel(): Promise<void> {
		const planModel = this.session.resolveRoleModel("plan");
		if (!planModel) return;
		const currentModel = this.session.model;
		if (currentModel && currentModel.provider === planModel.provider && currentModel.id === planModel.id) {
			return;
		}
		this.#planModePreviousModel = currentModel;
		if (this.session.isStreaming) {
			this.#pendingModelSwitch = planModel;
			return;
		}
		try {
			await this.session.setModelTemporary(planModel);
		} catch (error) {
			this.showWarning(
				`Failed to switch to plan model for plan mode: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}

	/** Apply any deferred model switch after the current stream ends. */
	async flushPendingModelSwitch(): Promise<void> {
		const model = this.#pendingModelSwitch;
		if (!model) return;
		this.#pendingModelSwitch = undefined;
		try {
			await this.session.setModelTemporary(model);
		} catch (error) {
			this.showWarning(
				`Failed to switch model after streaming: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}

	/** Restore mode state from session entries on resume (e.g. plan mode). */
	async #restoreModeFromSession(): Promise<void> {
		const sessionContext = this.sessionManager.buildSessionContext();
		if (sessionContext.mode === "plan") {
			const planFilePath = sessionContext.modeData?.planFilePath as string | undefined;
			const ultraplan = sessionContext.modeData?.ultraplan as boolean | undefined;
			const flavor = sessionContext.modeData?.flavor as "design" | undefined;
			const modeConfigName = sessionContext.modeData?.modeConfigName as string | undefined;
			await this.#enterPlanMode({ planFilePath, ultraplan, flavor, modeConfigName });
		} else if (sessionContext.mode === "plan_paused") {
			this.planModePaused = true;
			this.#planModeHasEntered = true;
			this.#updatePlanModeStatus();
		}
	}

	async #enterPlanMode(options?: {
		planFilePath?: string;
		workflow?: "parallel" | "iterative";
		ultraplan?: boolean;
		flavor?: "design";
		modeConfigName?: string;
	}): Promise<void> {
		if (this.planModeEnabled) {
			return;
		}

		this.planModePaused = false;

		const planFilePath = options?.planFilePath ?? (await this.#getPlanFilePath());
		const previousTools = this.session.getActiveToolNames();
		const hasExitTool = this.session.getToolByName("exit_plan_mode") !== undefined;
		const planTools = [...previousTools];
		if (hasExitTool) planTools.push("exit_plan_mode");
		// Plan mode mandates org — ensure it's in the active set even if org.enabled is off
		if (this.session.getToolByName("org") && !previousTools.includes("org")) planTools.push("org");
		const uniquePlanTools = [...new Set(planTools)];

		this.#planModePreviousTools = previousTools;
		this.planModePlanFilePath = planFilePath;
		this.planModeEnabled = true;

		await this.session.setActiveToolsByName(uniquePlanTools);
		this.session.setPlanModeState({
			type: "plan",
			enabled: true,
			planFilePath,
			workflow: options?.workflow ?? "parallel",
			reentry: this.#planModeHasEntered,
			ultraplan: options?.ultraplan ?? false,
			flavor: options?.flavor,
			modeConfigName: options?.modeConfigName,
		});
		if (this.session.isStreaming) {
			await this.session.sendPlanModeContext({ deliverAs: "steer" });
		}
		this.#planModeHasEntered = true;
		await this.#applyPlanModeModel();
		this.planModeUltraplan = options?.ultraplan ?? false;
		this.planModeFlavor = options?.flavor;
		this.#updatePlanModeStatus();
		this.sessionManager.appendModeChange("plan", {
			planFilePath,
			ultraplan: options?.ultraplan,
			flavor: options?.flavor,
			modeConfigName: options?.modeConfigName,
		});
		this.updateEditorBorderColor();
		this.#showPlanModeOverlay(options?.ultraplan ?? false, false);
		this.showStatus(
			options?.ultraplan
				? "Ultraplan mode enabled."
				: options?.flavor === "design"
					? "Design plan mode enabled."
					: "Plan mode enabled.",
		);
	}

	async #exitPlanMode(options?: { silent?: boolean; paused?: boolean }): Promise<void> {
		if (!this.planModeEnabled) {
			return;
		}

		const previousTools = this.#planModePreviousTools;
		if (previousTools && previousTools.length > 0) {
			await this.session.setActiveToolsByName(previousTools);
		}
		if (this.#planModePreviousModel) {
			if (this.session.isStreaming) {
				this.#pendingModelSwitch = this.#planModePreviousModel;
			} else {
				await this.session.setModelTemporary(this.#planModePreviousModel);
			}
		}

		this.session.setPlanModeState(undefined);
		this.planModeEnabled = false;
		this.planModePaused = options?.paused ?? false;
		this.planModePlanFilePath = undefined;
		this.planModeFlavor = undefined;
		this.#planModePreviousTools = undefined;
		this.#planModePreviousModel = undefined;
		this.#updatePlanModeStatus();
		const paused = options?.paused ?? false;
		this.sessionManager.appendModeChange(paused ? "plan_paused" : "none");
		this.updateEditorBorderColor();
		if (paused) {
			// Keep overlay but flip to paused label
			this.#planModeOverlay?.update(this.planModeUltraplan, true);
			this.ui.requestRender();
		} else {
			this.#hidePlanModeOverlay();
		}
		if (!options?.silent) {
			this.showStatus(paused ? "Plan mode paused." : "Plan mode disabled.");
		}
		this.#niriListener?.();
	}

	async #readPlanFile(planFilePath: string): Promise<string | null> {
		const resolvedPath = this.#resolvePlanFilePath(planFilePath);
		try {
			return await Bun.file(resolvedPath).text();
		} catch (error) {
			if (isEnoent(error)) {
				return null;
			}
			throw error;
		}
	}

	#renderPlanPreview(planContent: string): void {
		this.chatContainer.addChild(new Spacer(1));
		this.chatContainer.addChild(new DynamicBorder());
		this.chatContainer.addChild(new Text(theme.bold(theme.fg("accent", "Plan Review")), 1, 1));
		this.chatContainer.addChild(new Spacer(1));
		this.chatContainer.addChild(new Markdown(orgToMarkdown(planContent), 1, 1, getMarkdownTheme()));
		this.chatContainer.addChild(new DynamicBorder());
		this.ui.requestRender();
	}

	/** Extract text from the first user-attributed message in the current session. */
	#getFirstUserMessageText(): string {
		for (const msg of this.session.messages) {
			if (msg.role !== "user" || msg.attribution !== "user") continue;
			const { content } = msg;
			if (typeof content === "string") return content;
			if (Array.isArray(content)) {
				return content
					.filter((b): b is { type: "text"; text: string } => b.type === "text")
					.map(b => b.text)
					.join(" ");
			}
		}
		return "";
	}

	async #approvePlan(
		planContent: string,
		options: {
			planFilePath: string;
			finalPlanFilePath: string;
			orgItem?: { id: string; file: string };
			waves?: PlanWave[];
		},
	): Promise<void> {
		const orgPlanItem: OrgPlanRef | null = options.orgItem ?? null;
		// Only rename the markdown plan file for file-backed plans.
		if (!orgPlanItem) {
			await renameApprovedPlanFile({
				planFilePath: options.planFilePath,
				finalPlanFilePath: options.finalPlanFilePath,
				getArtifactsDir: () => this.sessionManager.getArtifactsDir(),
				getSessionId: () => this.sessionManager.getSessionId(),
			});
		}
		const previousTools = this.#planModePreviousTools ?? this.session.getActiveToolNames();
		// Append design history entry when approving a design-flavored plan
		if (this.planModeFlavor === "design") {
			try {
				const historyPath = path.join(this.sessionManager.getCwd(), ".spell", "design-history.jsonl");
				const entry = extractDesignBriefEntry(planContent);
				const existing = await Bun.file(historyPath)
					.text()
					.catch(() => "");
				await Bun.write(historyPath, `${existing + JSON.stringify(entry)}\n`);
			} catch {
				// Non-fatal
			}
		}
		// Capture transcript path before session rotation — fallback for non-org plans.
		const fallbackTranscriptPath = this.sessionManager.getSessionFile() ?? undefined;
		await this.#exitPlanMode({ silent: true, paused: false });
		await this.handleClearCommand();
		let approvedOrgItemId = "";
		let approvedOrgItemArtifactsDir: string | undefined;
		let planReferencePath = options.finalPlanFilePath;
		let planningTranscriptPath = fallbackTranscriptPath;
		if (orgPlanItem) {
			const approved = await approvePlanItem(
				this.settings,
				this.sessionManager.getCwd(),
				orgPlanItem,
				this.#getFirstUserMessageText() || undefined,
			);
			if (!approved) {
				throw new Error("Failed to approve org PLAN item.");
			}
			approvedOrgItemId = approved.id;
			planningTranscriptPath = approved.transcriptPath ?? fallbackTranscriptPath;
			const orgItemArtifactsDir = path.join(path.dirname(orgPlanItem.file), "plan-artifacts", approved.id);
			const relativeOrgItemArtifactsDir = path.relative(this.sessionManager.getCwd(), orgItemArtifactsDir);
			approvedOrgItemArtifactsDir =
				relativeOrgItemArtifactsDir && !relativeOrgItemArtifactsDir.startsWith("..")
					? relativeOrgItemArtifactsDir
					: orgItemArtifactsDir;
			planReferencePath = `org://${approved.id}`;
		} else {
			// For file-backed plans (org disabled), persist the approved plan in the new
			// session local:// root so `local://<title>.md` resolves correctly.
			const newLocalPath = resolveLocalUrlToPath(options.finalPlanFilePath, {
				getArtifactsDir: () => this.sessionManager.getArtifactsDir(),
				getSessionId: () => this.sessionManager.getSessionId(),
			});
			await Bun.write(newLocalPath, planContent);
		}
		if (previousTools.length > 0) {
			await this.session.setActiveToolsByName(previousTools);
		}
		this.session.setPlanReferencePath(planReferencePath);
		this.session.markPlanReferenceSent();
		// Set audit state: auto for ultraplan, suggest for regular plan
		if (!this.#isAuditEscalation || this.#auditDepth < this.#auditMaxDepth) {
			this.session.setAuditState({
				type: "audit",
				pending: this.planModeUltraplan ? "auto" : "suggest",
				active: false,
				sourceRef: planReferencePath,
				auditDepth: this.#auditDepth,
				maxDepth: this.#auditMaxDepth,
			});
		} else {
			this.session.setAuditState({ type: "audit", pending: false, active: false });
		}
		// Reset depth for non-audit approvals
		if (!this.#isAuditEscalation) {
			this.#auditDepth = 0;
		}
		this.#isAuditEscalation = false;

		const planState = this.session.getPlanModeState();
		const modeConfig = planState?.modeConfigName ? this.session.getModeConfig(planState.modeConfigName) : undefined;
		const projectPolicies = await loadTaskPolicies(this.sessionManager.getCwd());
		const mergedPolicies = mergePolicies(projectPolicies, modeConfig?.frontmatter.taskPolicies);
		const hasTaskPolicies = mergedPolicies.policies.length > 0 || Object.keys(mergedPolicies.layers).length > 0;

		let autoInitialized = false;
		if ((options.waves?.length ?? 0) > 0) {
			const groups = planWavesToTodoGroups(options.waves ?? []);
			if (groups.length > 0) {
				this.session.setTodoGroups(groups, { reset: true });
				autoInitialized = true;
			}
		}

		const prompt = renderPromptTemplate(planModeApprovedPrompt, {
			planContent: orgToMarkdown(planContent),
			finalPlanFilePath: planReferencePath,
			orgItemId: approvedOrgItemId,
			orgItemArtifactsDir: approvedOrgItemArtifactsDir,
			planningTranscriptPath,
			waves: autoInitialized ? undefined : options.waves,
			modeExecutionInstructions: modeConfig?.sections.instructions,
			autoInitialized,
			taskPolicies: hasTaskPolicies ? mergedPolicies : undefined,
			taskPolicyList: hasTaskPolicies ? mergedPolicies.policies : undefined,
		});
		await this.session.prompt(prompt, { synthetic: true });
	}

	async handleModeCommand(modeName: string, prompt?: string): Promise<void> {
		const config = this.session.getModeConfig(modeName);
		if (!config) {
			this.showStatus(`Mode "${modeName}" not found.`);
			return;
		}

		const { extendsChain, frontmatter } = config;
		const isPlanLike = extendsChain.includes("plan") || extendsChain.includes("ultraplan");
		const isAuditLike = extendsChain.includes("audit");

		if (isPlanLike) {
			const isUltra = extendsChain.includes("ultraplan") || frontmatter.extends === "ultraplan";
			const isDesign = frontmatter.extends === "design" || extendsChain.includes("design");
			await this.handlePlanModeCommand(prompt, {
				ultraplan: isUltra || undefined,
				flavor: isDesign ? "design" : undefined,
				modeConfigName: config.name,
			});
			// Note: plan-like modes use their own tool restriction mechanism (exit_plan_mode handling)
		} else if (isAuditLike) {
			// Audit-extending modes: delegate to audit lifecycle
			// TODO(FEAT-126): Full audit mode activation with modeConfig
			this.showStatus(`Audit-extending mode "${config.name}" not yet supported.`);
		} else {
			// Standalone user mode
			const userState: UserModeState = {
				type: "user",
				name: config.name,
				config,
				enabled: true,
				readOnly: frontmatter.readOnly ?? false,
			};
			this.session.setUserModeState(userState);

			// Apply tool restrictions from mode config
			if (config.resolvedTools) {
				// Preserve essential tools that must always be available
				const essentialTools = ["ask", "exit_plan_mode", "resolve"];
				const allowedTools = new Set([...config.resolvedTools, ...essentialTools]);
				// Get current tool names and filter to allowed set
				const currentTools = this.session.agent.state.tools.map(t => t.name);
				const filteredTools = currentTools.filter(name => allowedTools.has(name));
				// Store snapshot before restricting
				userState.toolSnapshot = currentTools;
				await this.session.setActiveToolsByName(filteredTools);
			}

			this.showStatus(`Mode "${config.name}" activated.`);
		}
	}

	async handlePlanModeCommand(
		initialPrompt?: string,
		options?: { ultraplan?: boolean; flavor?: "design"; modeConfigName?: string },
	): Promise<void> {
		if (this.planModeEnabled) {
			const confirmed = await this.showHookConfirm(
				"Exit plan mode?",
				"This exits plan mode without approving a plan.",
			);
			if (!confirmed) return;
			await this.#exitPlanMode({ paused: true });
			return;
		}
		await this.#enterPlanMode({
			ultraplan: options?.ultraplan,
			flavor: options?.flavor,
			modeConfigName: options?.modeConfigName,
		});
		if (initialPrompt && this.onInputCallback) {
			this.onInputCallback(this.startPendingSubmission({ text: initialPrompt }));
		}
	}

	async handleExitPlanModeTool(details: ExitPlanModeDetails): Promise<void> {
		if (!this.planModeEnabled) {
			this.showWarning("Plan mode is not active.");
			return;
		}

		// Abort the agent to prevent it from continuing (e.g., calling exit_plan_mode
		// again) while the popup is showing. The event listener fires asynchronously
		// (agent's #emit is fire-and-forget), so without this the model sees "Plan
		// ready for approval." and immediately calls exit_plan_mode in a loop.
		await this.session.abort();

		// Org-backed plan: content comes from the resolved item body.
		// File-backed plan (org disabled): read from the plan file.
		const planFilePath = details.planFilePath || this.planModePlanFilePath || (await this.#getPlanFilePath());
		this.planModePlanFilePath = planFilePath;
		const planContent =
			details.planContent !== undefined ? details.planContent : await this.#readPlanFile(planFilePath);
		if (!planContent) {
			this.showError("Plan has no content.");
			return;
		}

		this.#renderPlanPreview(planContent);
		const selectorOptions = ["Approve and execute", "Refine plan", "Stay in plan mode"];
		if (this.planModeUltraplan) {
			selectorOptions.splice(1, 0, "Review with Momus");
		} else if (this.planModeFlavor === "design") {
			selectorOptions.splice(1, 0, "Review with Athena");
		}
		this.isPendingApproval = true;
		this.#niriListener?.();
		const { value: choice } = await raceWithBridge(
			this.showHookSelector("Plan mode - next step", selectorOptions),
			this.sessionBridge,
			{
				kind: "plan_approval",
				title: details.title ?? "Plan",
				itemId: details.itemId ?? "",
				planSummary: planContent.slice(0, 2000),
				selectorOptions,
			},
			response => {
				if (response.kind === "plan_approval") {
					return response.selectedOption;
				}
				return undefined;
			},
		);
		this.isPendingApproval = false;
		this.#niriListener?.();

		if (choice === "Approve and execute") {
			const finalPlanFilePath = details.finalPlanFilePath || planFilePath;
			try {
				const orgItem =
					details.itemId && details.orgItemFile ? { id: details.itemId, file: details.orgItemFile } : undefined;
				await this.#approvePlan(planContent, {
					planFilePath,
					finalPlanFilePath,
					orgItem,
					waves: details.waves,
				});
			} catch (error) {
				this.showError(
					`Failed to finalize approved plan: ${error instanceof Error ? error.message : String(error)}`,
				);
			}
			return;
		}
		if (choice === "Review with Momus") {
			await this.#enterPlanMode({ ultraplan: true });
			const childItemIds = extractIdLinks(planContent);
			const childBodies: string[] = [];
			for (const childItemId of childItemIds) {
				const childItem = await resolvePlanItem(this.settings, this.sessionManager.getCwd(), childItemId);
				if (!childItem) {
					this.showWarning(`Skipping unresolved child item ${childItemId} during Momus review.`);
					continue;
				}
				childBodies.push(`## ${childItemId}\n\n${childItem.body}`);
			}
			const combinedPlanContent =
				childBodies.length > 0
					? `${planContent}\n\n---\n\n# Linked Child Items\n\n${childBodies.join("\n\n")}`
					: planContent;
			await this.session.prompt(`Run Momus review on this plan and address any issues:\n\n${combinedPlanContent}`, {
				synthetic: true,
			});
			return;
		}
		if (choice === "Review with Athena") {
			await this.#enterPlanMode({ flavor: "design" });
			await this.session.prompt(`Run Athena review on this plan and address any issues:\n\n${planContent}`, {
				synthetic: true,
			});
			return;
		}
		if (choice === "Refine plan") {
			const refinement = await this.showHookInput("What should be refined?");
			if (refinement) {
				this.editor.setText(refinement);
			}
		}
	}

	stop(): void {
		if (this.loadingAnimation) {
			this.loadingAnimation.stop();
			this.loadingAnimation = undefined;
		}
		this.#cleanupMicAnimation();
		if (this.#sttController) {
			this.#sttController.dispose();
			this.#sttController = undefined;
		}
		this.#extensionUiController.clearExtensionTerminalInputListeners();
		this.statusLine.dispose();
		if (this.#resizeHandler) {
			process.stdout.removeListener("resize", this.#resizeHandler);
			this.#resizeHandler = undefined;
		}
		if (this.unsubscribe) {
			this.unsubscribe();
		}
		if (this.#cleanupUnsubscribe) {
			this.#cleanupUnsubscribe();
		}
		this.#niriController?.destroy();
		this.sessionBridge?.dispose();
		this.sessionBridge = undefined;
		if (this.isInitialized) {
			this.ui.stop();
			this.isInitialized = false;
		}
	}

	async shutdown(): Promise<void> {
		if (this.#isShuttingDown) return;
		this.#isShuttingDown = true;

		// Flush pending session writes before shutdown
		await this.sessionManager.flush();
		this.#btwController.dispose();

		// Emit shutdown event to hooks
		await this.session.dispose();

		if (this.isInitialized) {
			this.ui.requestRender(true);
		}

		// Wait for any pending renders to complete
		// requestRender() uses process.nextTick(), so we wait one tick
		await new Promise(resolve => process.nextTick(resolve));

		// Drain any in-flight Kitty key release events before stopping.
		// This prevents escape sequences from leaking to the parent shell over slow SSH.
		await this.ui.terminal.drainInput(1000);

		this.stop();

		// Print token usage summary
		try {
			const stats = this.session.getSessionStats();
			let wroteSummary = false;
			const hasUsage =
				stats.tokens.input > 0 || stats.tokens.output > 0 || stats.tokens.cacheRead > 0 || stats.cost > 0;
			if (hasUsage) {
				const summary = formatExitTokenSummary({
					input: stats.tokens.input,
					output: stats.tokens.output,
					thinking: 0,
					cacheRead: stats.tokens.cacheRead,
					cost: stats.cost,
				});
				process.stderr.write(`\n${chalk.dim(summary)}\n`);
				wroteSummary = true;
			}

			const subtaskStats = this.#subagentTracker?.getLifetimeStats();
			if (subtaskStats) {
				const subtaskSummary = formatSubtaskExitSummary({
					totalLaunched: subtaskStats.totalLaunched,
					totalTokens: subtaskStats.totalTokens,
					totalCost: subtaskStats.totalCost,
					avgTokensPerSubtask: subtaskStats.avgTokensPerSubtask,
					cacheHitRate: subtaskStats.cacheHitRate,
				});
				if (subtaskSummary) {
					process.stderr.write(`${wroteSummary ? "" : "\n"}${chalk.dim(subtaskSummary)}\n`);
				}
			}
		} catch {
			// Non-critical: don't let summary formatting break shutdown
		}
		this.#subagentTracker?.dispose();
		this.#subagentTracker = undefined;

		// Print resumption hint if this is a persisted session
		const sessionId = this.sessionManager.getSessionId();
		const sessionFile = this.sessionManager.getSessionFile();
		if (sessionId && sessionFile) {
			process.stderr.write(`\n${chalk.dim(`Resume this session with ${APP_NAME} --resume ${sessionId}`)}\n`);
		}

		await postmortem.quit(0);
	}

	async checkShutdownRequested(): Promise<void> {
		if (!this.shutdownRequested) return;
		await this.shutdown();
	}

	// Extension UI integration
	setToolUIContext(uiContext: ExtensionUIContext, hasUI: boolean): void {
		this.#toolUiContextSetter(uiContext, hasUI);
	}

	initializeHookRunner(uiContext: ExtensionUIContext, hasUI: boolean): void {
		this.#extensionUiController.initializeHookRunner(uiContext, hasUI);
	}

	createBackgroundUiContext(): ExtensionUIContext {
		return this.#extensionUiController.createBackgroundUiContext();
	}

	// Event handling
	async handleBackgroundEvent(event: AgentSessionEvent): Promise<void> {
		await this.#eventController.handleBackgroundEvent(event);
	}

	// UI helpers
	showStatus(message: string, options?: { dim?: boolean }): void {
		this.#uiHelpers.showStatus(message, options);
	}

	showError(message: string): void {
		this.#pendingSubmittedInput = undefined;
		this.optimisticUserMessageSignature = undefined;
		this.#pendingWorkingMessage = undefined;
		if (this.loadingAnimation) {
			this.loadingAnimation.stop();
			this.loadingAnimation = undefined;
			this.statusContainer.clear();
		}
		this.#uiHelpers.showError(message);
	}

	showWarning(message: string): void {
		this.#uiHelpers.showWarning(message);
	}

	ensureLoadingAnimation(): void {
		if (!this.loadingAnimation) {
			this.statusContainer.clear();
			this.loadingAnimation = new Loader(
				this.ui,
				spinner => theme.fg("accent", spinner),
				text => theme.fg("muted", text),
				this.#defaultWorkingMessage,
				getSymbolTheme().spinnerFrames,
			);
			this.statusContainer.addChild(this.loadingAnimation);
		}

		this.applyPendingWorkingMessage();
	}

	setWorkingMessage(message?: string): void {
		if (message === undefined) {
			this.#pendingWorkingMessage = undefined;
			if (this.loadingAnimation) {
				this.loadingAnimation.setMessage(this.#defaultWorkingMessage);
			}
			return;
		}

		if (this.loadingAnimation) {
			this.loadingAnimation.setMessage(message);
			return;
		}

		this.#pendingWorkingMessage = message;
	}

	applyPendingWorkingMessage(): void {
		if (this.#pendingWorkingMessage === undefined) {
			return;
		}

		const message = this.#pendingWorkingMessage;
		this.#pendingWorkingMessage = undefined;
		this.setWorkingMessage(message);
	}

	showNewVersionNotification(newVersion: string): void {
		this.#uiHelpers.showNewVersionNotification(newVersion);
	}

	clearEditor(): void {
		this.#uiHelpers.clearEditor();
	}

	updatePendingMessagesDisplay(): void {
		this.#uiHelpers.updatePendingMessagesDisplay();
	}

	queueCompactionMessage(text: string, mode: "steer" | "followUp"): void {
		this.#uiHelpers.queueCompactionMessage(text, mode);
	}

	flushCompactionQueue(options?: { willRetry?: boolean }): Promise<void> {
		return this.#uiHelpers.flushCompactionQueue(options);
	}

	flushPendingBashComponents(): void {
		this.#uiHelpers.flushPendingBashComponents();
	}

	isKnownSlashCommand(text: string): boolean {
		return this.#uiHelpers.isKnownSlashCommand(text);
	}

	addMessageToChat(message: AgentMessage, options?: { populateHistory?: boolean }): void {
		this.#uiHelpers.addMessageToChat(message, options);
	}

	renderSessionContext(
		sessionContext: SessionContext,
		options?: { updateFooter?: boolean; populateHistory?: boolean },
	): void {
		this.#uiHelpers.renderSessionContext(sessionContext, options);
	}

	renderInitialMessages(): void {
		this.#uiHelpers.renderInitialMessages();
	}

	getUserMessageText(message: Message): string {
		return this.#uiHelpers.getUserMessageText(message);
	}

	findLastAssistantMessage(): AssistantMessage | undefined {
		return this.#uiHelpers.findLastAssistantMessage();
	}

	extractAssistantText(message: AssistantMessage): string {
		return this.#uiHelpers.extractAssistantText(message);
	}

	// Command handling
	handleExportCommand(text: string): Promise<void> {
		return this.#commandController.handleExportCommand(text);
	}

	handleDumpCommand() {
		return this.#commandController.handleDumpCommand();
	}

	handleDebugTranscriptCommand(): Promise<void> {
		return this.#commandController.handleDebugTranscriptCommand();
	}

	handleShareCommand(): Promise<void> {
		return this.#commandController.handleShareCommand();
	}

	handleCopyCommand(sub?: string) {
		return this.#commandController.handleCopyCommand(sub);
	}

	handleSessionCommand(): Promise<void> {
		return this.#commandController.handleSessionCommand();
	}

	handleJobsCommand(): Promise<void> {
		return this.#commandController.handleJobsCommand();
	}

	handleUsageCommand(reports?: UsageReport[] | null): Promise<void> {
		return this.#commandController.handleUsageCommand(reports);
	}

	async handleChangelogCommand(showFull = false): Promise<void> {
		await this.#commandController.handleChangelogCommand(showFull);
	}

	handleHotkeysCommand(): void {
		this.#commandController.handleHotkeysCommand();
	}

	handleClearCommand(): Promise<void> {
		this.#btwController.dispose();
		this.#extensionUiController.clearExtensionTerminalInputListeners();
		return this.#commandController.handleClearCommand();
	}

	handleForkCommand(): Promise<void> {
		this.#btwController.dispose();
		return this.#commandController.handleForkCommand();
	}

	handleMoveCommand(targetPath: string): Promise<void> {
		return this.#commandController.handleMoveCommand(targetPath);
	}

	handleMemoryCommand(text: string): Promise<void> {
		return this.#commandController.handleMemoryCommand(text);
	}

	async handleSTTToggle(): Promise<void> {
		if (!settings.get("stt.enabled")) {
			this.showWarning("Speech-to-text is disabled. Enable it in settings: stt.enabled");
			return;
		}
		if (!this.#sttController) {
			this.#sttController = new STTController();
		}
		await this.#sttController.toggle(this.editor, {
			showWarning: (msg: string) => this.showWarning(msg),
			showStatus: (msg: string) => this.showStatus(msg),
			onStateChange: (state: SttState) => {
				if (state === "recording") {
					this.#voicePreviousShowHardwareCursor = this.ui.getShowHardwareCursor();
					this.#voicePreviousUseTerminalCursor = this.editor.getUseTerminalCursor();
					this.ui.setShowHardwareCursor(false);
					this.editor.setUseTerminalCursor(false);
					this.#startMicAnimation();
				} else if (state === "transcribing") {
					this.#stopMicAnimation();
					this.editor.cursorOverride = `\x1b[38;2;200;200;200m${theme.icon.mic}\x1b[0m`;
					this.editor.cursorOverrideWidth = visibleWidth(theme.icon.mic);
				} else {
					this.#cleanupMicAnimation();
				}
				this.updateEditorTopBorder();
				this.ui.requestRender();
			},
		});
	}

	#updateMicIcon(): void {
		const { r, g, b } = hsvToRgb({ h: this.#voiceHue, s: 0.9, v: 1.0 });
		this.editor.cursorOverride = `\x1b[38;2;${r};${g};${b}m${theme.icon.mic}\x1b[0m`;
		this.editor.cursorOverrideWidth = visibleWidth(theme.icon.mic);
	}

	#startMicAnimation(): void {
		if (this.#voiceAnimationInterval) return;
		this.#voiceHue = 0;
		this.#updateMicIcon();
		this.#voiceAnimationInterval = setInterval(() => {
			this.#voiceHue = (this.#voiceHue + 8) % 360;
			this.#updateMicIcon();
			this.ui.requestRender();
		}, 60);
	}

	#stopMicAnimation(): void {
		if (this.#voiceAnimationInterval) {
			clearInterval(this.#voiceAnimationInterval);
			this.#voiceAnimationInterval = undefined;
		}
	}

	#cleanupMicAnimation(): void {
		if (this.#voiceAnimationInterval) {
			clearInterval(this.#voiceAnimationInterval);
			this.#voiceAnimationInterval = undefined;
		}
		this.editor.cursorOverride = undefined;
		this.editor.cursorOverrideWidth = undefined;
		if (this.#voicePreviousShowHardwareCursor !== null) {
			this.ui.setShowHardwareCursor(this.#voicePreviousShowHardwareCursor);
			this.#voicePreviousShowHardwareCursor = null;
		}
		if (this.#voicePreviousUseTerminalCursor !== null) {
			this.editor.setUseTerminalCursor(this.#voicePreviousUseTerminalCursor);
			this.#voicePreviousUseTerminalCursor = null;
		}
	}

	showDebugSelector(): void {
		this.#selectorController.showDebugSelector();
	}

	showSubagentViewer(): void {
		this.#selectorController.showSubagentViewer();
	}

	handleBashCommand(command: string, excludeFromContext?: boolean): Promise<void> {
		return this.#commandController.handleBashCommand(command, excludeFromContext);
	}

	handlePythonCommand(code: string, excludeFromContext?: boolean): Promise<void> {
		return this.#commandController.handlePythonCommand(code, excludeFromContext);
	}

	async handleMCPCommand(text: string): Promise<void> {
		const controller = new MCPCommandController(this);
		await controller.handle(text);
	}

	async handleSSHCommand(text: string): Promise<void> {
		const controller = new SSHCommandController(this);
		await controller.handle(text);
	}

	handleCompactCommand(customInstructions?: string): Promise<void> {
		return this.#commandController.handleCompactCommand(customInstructions);
	}

	handleHandoffCommand(customInstructions?: string): Promise<void> {
		return this.#commandController.handleHandoffCommand(customInstructions);
	}

	executeCompaction(customInstructionsOrOptions?: string | CompactOptions, isAuto?: boolean): Promise<void> {
		return this.#commandController.executeCompaction(customInstructionsOrOptions, isAuto);
	}

	openInBrowser(urlOrPath: string): void {
		this.#commandController.openInBrowser(urlOrPath);
	}

	// Selector handling
	showSettingsSelector(): void {
		this.#selectorController.showSettingsSelector();
	}

	showHistorySearch(): void {
		this.#selectorController.showHistorySearch();
	}

	showExtensionsDashboard(): void {
		void this.#selectorController.showExtensionsDashboard();
	}

	showAgentsDashboard(): void {
		void this.#selectorController.showAgentsDashboard();
	}

	showModelSelector(options?: { temporaryOnly?: boolean }): void {
		this.#selectorController.showModelSelector(options);
	}

	showUserMessageSelector(): void {
		this.#selectorController.showUserMessageSelector();
	}

	showTreeSelector(): void {
		this.#selectorController.showTreeSelector();
	}

	showSessionSelector(): void {
		this.#selectorController.showSessionSelector();
	}

	handleResumeSession(sessionPath: string): Promise<void> {
		this.#btwController.dispose();
		return this.#selectorController.handleResumeSession(sessionPath);
	}

	showOAuthSelector(mode: "login" | "logout", providerId?: string): Promise<void> {
		return this.#selectorController.showOAuthSelector(mode, providerId);
	}

	showHookConfirm(title: string, message: string): Promise<boolean> {
		return this.#extensionUiController.showHookConfirm(title, message);
	}

	// Input handling
	handleCtrlC(): void {
		this.#inputController.handleCtrlC();
	}

	handleCtrlD(): void {
		this.#inputController.handleCtrlD();
	}

	handleCtrlZ(): void {
		this.#inputController.handleCtrlZ();
	}

	clearUserPaused(): void {
		if (!this.#isUserPaused) {
			return;
		}
		this.#isUserPaused = false;
		this.ui.requestRender();
		this.#niriListener?.();
	}

	/** Toggle the user_paused acknowledgement. Only valid when status is needs_input or user_paused. */
	handleToggleUserPause(): void {
		// Determine if we are currently in a needs_input-derivable state.
		const hasInputCallback = this.onInputCallback !== undefined;
		const isHookAwaiting = this.hookSelector !== undefined || this.hookInput !== undefined;
		if (!hasInputCallback && !isHookAwaiting && !this.isPendingApproval) return; // not in needs_input territory — no-op
		this.#isUserPaused = !this.#isUserPaused;
		this.ui.requestRender();
		this.#niriListener?.();
	}

	handleDequeue(): void {
		this.#inputController.handleDequeue();
	}

	handleBackgroundCommand(): void {
		this.#inputController.handleBackgroundCommand();
	}

	handleImagePaste(): Promise<boolean> {
		return this.#inputController.handleImagePaste();
	}

	handleBtwCommand(question: string): Promise<void> {
		return this.#btwController.start(question);
	}

	hasActiveBtw(): boolean {
		return this.#btwController.hasActiveRequest();
	}

	handleBtwEscape(): boolean {
		return this.#btwController.handleEscape();
	}

	cycleThinkingLevel(): void {
		this.#inputController.cycleThinkingLevel();
	}

	cycleRoleModel(options?: { temporary?: boolean }): Promise<void> {
		return this.#inputController.cycleRoleModel(options);
	}

	toggleToolOutputExpansion(): void {
		this.#inputController.toggleToolOutputExpansion();
	}

	setToolsExpanded(expanded: boolean): void {
		this.#inputController.setToolsExpanded(expanded);
	}

	toggleThinkingBlockVisibility(): void {
		this.#inputController.toggleThinkingBlockVisibility();
	}

	toggleTodoExpansion(): void {
		this.todoExpanded = !this.todoExpanded;
		this.#renderTodoList();
		this.ui.requestRender();
	}

	setTodos(todos: TodoItem[] | TodoGroup[]): void {
		if (todos.length > 0 && "tasks" in todos[0]) {
			this.todoGroups = todos as TodoGroup[];
		} else {
			this.todoGroups = [
				{
					id: "default",
					name: "Todos",
					tasks: todos as TodoItem[],
				},
			];
		}
		this.#renderTodoList();
		this.ui.requestRender();
	}

	async reloadTodos(): Promise<void> {
		await this.#loadTodoList();
		this.ui.requestRender();
	}

	openExternalEditor(): void {
		this.#inputController.openExternalEditor();
	}

	registerExtensionShortcuts(): void {
		this.#inputController.registerExtensionShortcuts();
	}

	// Hook UI methods
	initHooksAndCustomTools(): Promise<void> {
		return this.#extensionUiController.initHooksAndCustomTools();
	}

	emitCustomToolSessionEvent(
		reason: "start" | "switch" | "branch" | "tree" | "shutdown",
		previousSessionFile?: string,
	): Promise<void> {
		return this.#extensionUiController.emitCustomToolSessionEvent(reason, previousSessionFile);
	}

	setHookWidget(key: string, content: unknown): void {
		this.#extensionUiController.setHookWidget(key, content);
	}

	setHookStatus(key: string, text: string | undefined): void {
		this.#extensionUiController.setHookStatus(key, text);
	}

	showHookSelector(
		title: string,
		options: string[],
		dialogOptions?: ExtensionUIDialogOptions,
	): Promise<string | undefined> {
		return this.#extensionUiController.showHookSelector(title, options, dialogOptions);
	}

	hideHookSelector(): void {
		this.#extensionUiController.hideHookSelector();
	}

	showHookInput(title: string, placeholder?: string): Promise<string | undefined> {
		return this.#extensionUiController.showHookInput(title, placeholder);
	}

	hideHookInput(): void {
		this.#extensionUiController.hideHookInput();
	}

	showHookEditor(title: string, prefill?: string): Promise<string | undefined> {
		return this.#extensionUiController.showHookEditor(title, prefill);
	}

	hideHookEditor(): void {
		this.#extensionUiController.hideHookEditor();
	}

	showHookNotify(message: string, type?: "info" | "warning" | "error"): void {
		this.#extensionUiController.showHookNotify(message, type);
	}

	showHookCustom<T>(
		factory: (
			tui: TUI,
			theme: Theme,
			keybindings: KeybindingsManager,
			done: (result: T) => void,
		) => (Component & { dispose?(): void }) | Promise<Component & { dispose?(): void }>,
		options?: { overlay?: boolean },
	): Promise<T> {
		return this.#extensionUiController.showHookCustom(factory, options);
	}

	showExtensionError(extensionPath: string, error: string): void {
		this.#extensionUiController.showExtensionError(extensionPath, error);
	}

	showToolError(toolName: string, error: string): void {
		this.#extensionUiController.showToolError(toolName, error);
	}

	#subscribeToAgent(): void {
		this.#eventController.subscribeToAgent();
	}
}
