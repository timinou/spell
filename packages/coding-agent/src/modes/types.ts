import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage, ImageContent, Message, UsageReport } from "@oh-my-pi/pi-ai";
import type { Component, Container, Loader, Spacer, Text, TUI } from "@oh-my-pi/pi-tui";
import type { KeybindingsManager } from "../config/keybindings";
import type { Settings } from "../config/settings";
import type { ExtensionUIContext, ExtensionUIDialogOptions } from "../extensibility/extensions";
import type { CompactOptions } from "../extensibility/extensions/types";
import type { MCPManager } from "../mcp";
import type { CanvasTaskManager } from "../orchestrators/canvas-task-manager";
import type { AgentSession, AgentSessionEvent } from "../session/agent-session";
import type { HistoryStorage } from "../session/history-storage";
import type { SessionContext, SessionManager } from "../session/session-manager";
import type { SingleResult } from "../task/types";
import type { ExitPlanModeDetails } from "../tools";
import type { TodoGroup, TodoItem } from "../tools/todo-write";
import type { EventBus } from "../utils/event-bus";
import type { AssistantMessageComponent } from "./components/assistant-message";
import type { BashExecutionComponent } from "./components/bash-execution";
import type { CustomEditor } from "./components/custom-editor";
import type { HookEditorComponent } from "./components/hook-editor";
import type { HookInputComponent } from "./components/hook-input";
import type { HookSelectorComponent } from "./components/hook-selector";
import type { StatusLineComponent } from "./components/status-line";
import type { ToolExecutionHandle } from "./components/tool-execution";
import type { OAuthManualInputManager } from "./oauth-manual-input";
import type { Theme } from "./theme/theme";

export type { TodoDelegation, TodoGroup, TodoItem, TodoStatus } from "../tools/todo-write";
export type CompactionQueuedMessage = {
	text: string;
	mode: "steer" | "followUp";
};

export type SubmittedUserInput =
	| { kind: "terminal-lost" }
	| { kind: "user-input"; text: string; images?: ImageContent[]; cancelled: boolean; started: boolean };

export interface InteractiveModeContext {
	// UI access
	ui: TUI;
	chatContainer: Container;
	pendingMessagesContainer: Container;
	statusContainer: Container;
	todoContainer: Container;
	btwContainer: Container;
	editor: CustomEditor;
	editorContainer: Container;
	statusLine: StatusLineComponent;

	// Session access
	session: AgentSession;
	sessionManager: SessionManager;
	settings: Settings;
	keybindings: KeybindingsManager;
	agent: AgentSession["agent"];
	historyStorage?: HistoryStorage;
	mcpManager?: MCPManager;
	taskManager?: CanvasTaskManager;
	eventBus?: EventBus;
	lspServers?: Array<{ name: string; status: "ready" | "error"; fileTypes: string[]; error?: string }>;

	// State
	isInitialized: boolean;
	isBackgrounded: boolean;
	isBashMode: boolean;
	toolOutputExpanded: boolean;
	todoExpanded: boolean;
	planModeEnabled: boolean;
	planModePlanFilePath?: string;
	hideThinkingBlock: boolean;
	pendingImages: ImageContent[];
	compactionQueuedMessages: CompactionQueuedMessage[];
	pendingTools: Map<string, ToolExecutionHandle>;
	pendingBashComponents: BashExecutionComponent[];
	bashComponent: BashExecutionComponent | undefined;
	streamingComponent: AssistantMessageComponent | undefined;
	streamingMessage: AssistantMessage | undefined;
	loadingAnimation: Loader | undefined;
	autoCompactionLoader: Loader | undefined;
	retryLoader: Loader | undefined;
	autoCompactionEscapeHandler?: () => void;
	retryEscapeHandler?: () => void;
	unsubscribe?: () => void;
	onInputCallback?: (input: SubmittedUserInput) => void;
	optimisticUserMessageSignature: string | undefined;
	lastSigintTime: number;
	lastEscapeTime: number;
	shutdownRequested: boolean;
	hookSelector: HookSelectorComponent | undefined;
	hookInput: HookInputComponent | undefined;
	hookEditor: HookEditorComponent | undefined;
	lastStatusSpacer: Spacer | undefined;
	lastStatusText: Text | undefined;
	fileSlashCommands: Set<string>;
	skillCommands: Map<string, string>;
	oauthManualInput: OAuthManualInputManager;
	todoGroups: TodoGroup[];

	// Lifecycle
	init(): Promise<void>;
	shutdown(): Promise<void>;
	checkShutdownRequested(): Promise<void>;

	// Extension UI integration
	setToolUIContext(uiContext: ExtensionUIContext, hasUI: boolean): void;
	initializeHookRunner(uiContext: ExtensionUIContext, hasUI: boolean): void;
	createBackgroundUiContext(): ExtensionUIContext;

	// Event handling
	handleBackgroundEvent(event: AgentSessionEvent): Promise<void>;

	// UI helpers
	showStatus(message: string, options?: { dim?: boolean }): void;
	showError(message: string): void;
	showWarning(message: string): void;
	showNewVersionNotification(newVersion: string): void;
	clearEditor(): void;
	updatePendingMessagesDisplay(): void;
	queueCompactionMessage(text: string, mode: "steer" | "followUp"): void;
	flushCompactionQueue(options?: { willRetry?: boolean }): Promise<void>;
	flushPendingBashComponents(): void;
	flushPendingModelSwitch(): Promise<void>;
	setWorkingMessage(message?: string): void;
	applyPendingWorkingMessage(): void;
	ensureLoadingAnimation(): void;
	startPendingSubmission(input: {
		text: string;
		images?: ImageContent[];
	}): Extract<SubmittedUserInput, { kind: "user-input" }>;
	cancelPendingSubmission(): boolean;
	markPendingSubmissionStarted(input: Extract<SubmittedUserInput, { kind: "user-input" }>): boolean;
	finishPendingSubmission(input: Extract<SubmittedUserInput, { kind: "user-input" }>): void;
	isKnownSlashCommand(text: string): boolean;
	addMessageToChat(message: AgentMessage, options?: { populateHistory?: boolean }): void;
	renderSessionContext(
		sessionContext: SessionContext,
		options?: { updateFooter?: boolean; populateHistory?: boolean },
	): void;
	renderInitialMessages(): void;
	getUserMessageText(message: Message): string;
	findLastAssistantMessage(): AssistantMessage | undefined;
	extractAssistantText(message: AssistantMessage): string;
	updateEditorTopBorder(): void;
	updateEditorBorderColor(): void;
	rebuildChatFromMessages(): void;
	setTodos(todos: TodoItem[] | TodoGroup[]): void;
	reloadTodos(): Promise<void>;
	recordSubagentResults?(results: SingleResult[]): void;
	toggleTodoExpansion(): void;

	// Command handling
	handleExportCommand(text: string): Promise<void>;
	handleShareCommand(): Promise<void>;
	handleCopyCommand(sub?: string): void;
	handleSessionCommand(): Promise<void>;
	handleJobsCommand(): Promise<void>;
	handleSnapshotsCommand(): Promise<void>;
	handleUsageCommand(reports?: UsageReport[] | null): Promise<void>;
	handleChangelogCommand(showFull?: boolean): Promise<void>;
	handleHotkeysCommand(): void;
	handleDumpCommand(): void;
	handleDebugTranscriptCommand(): Promise<void>;
	handleClearCommand(): Promise<void>;
	handleForkCommand(): Promise<void>;
	handleBashCommand(command: string, excludeFromContext?: boolean): Promise<void>;
	handleMCPCommand(text: string): Promise<void>;
	handleSSHCommand(text: string): Promise<void>;
	handleCompactCommand(customInstructions?: string): Promise<void>;
	handleHandoffCommand(customInstructions?: string): Promise<void>;
	handleMoveCommand(targetPath: string): Promise<void>;
	handleMemoryCommand(text: string): Promise<void>;
	handleSTTToggle(): Promise<void>;
	handleToggleUserPause(): void;
	clearUserPaused(): void;
	executeCompaction(customInstructionsOrOptions?: string | CompactOptions, isAuto?: boolean): Promise<void>;
	openInBrowser(urlOrPath: string): void;
	refreshSlashCommandState(cwd?: string): Promise<void>;

	// Selector handling
	showSettingsSelector(): void;
	showHistorySearch(): void;
	showExtensionsDashboard(): void;
	showAgentsDashboard(): void;
	showModelSelector(options?: { temporaryOnly?: boolean }): void;
	showUserMessageSelector(): void;
	showTreeSelector(): void;
	showSessionSelector(): void;
	handleResumeSession(sessionPath: string): Promise<void>;
	showOAuthSelector(mode: "login" | "logout", providerId?: string): Promise<void>;
	showHookConfirm(title: string, message: string): Promise<boolean>;
	showDebugSelector(): void;
	showSubagentViewer(): void;
	showMemoryBrowser(): void;

	// Input handling
	handleCtrlC(): void;
	handleCtrlD(): void;
	handleCtrlZ(): void;
	handleDequeue(): void;
	handleBackgroundCommand(): void;
	handleImagePaste(): Promise<boolean>;
	handleBtwCommand(question: string): Promise<void>;
	hasActiveBtw(): boolean;
	handleBtwEscape(): boolean;
	cycleThinkingLevel(): void;
	cycleRoleModel(options?: { temporary?: boolean }): Promise<void>;
	toggleToolOutputExpansion(): void;
	setToolsExpanded(expanded: boolean): void;
	toggleThinkingBlockVisibility(): void;
	openExternalEditor(): void;
	registerExtensionShortcuts(): void;
	handlePlanModeCommand(initialPrompt?: string, options?: { ultraplan?: boolean; flavor?: "design" }): Promise<void>;
	handleModeCommand(modeName: string, prompt?: string): Promise<void>;
	handleExitPlanModeTool(details: ExitPlanModeDetails): Promise<void>;
	handleAuditCommand(): Promise<void>;
	handleAuditEscalation(auditContent: string): Promise<void>;
	showAuditOverlay(): void;

	// Hook UI methods
	initHooksAndCustomTools(): Promise<void>;
	emitCustomToolSessionEvent(
		reason: "start" | "switch" | "branch" | "tree" | "shutdown",
		previousSessionFile?: string,
	): Promise<void>;
	setHookWidget(key: string, content: unknown): void;
	setHookStatus(key: string, text: string | undefined): void;
	showHookSelector(
		title: string,
		options: string[],
		dialogOptions?: ExtensionUIDialogOptions,
	): Promise<string | undefined>;
	hideHookSelector(): void;
	showHookInput(title: string, placeholder?: string): Promise<string | undefined>;
	hideHookInput(): void;
	showHookEditor(title: string, prefill?: string): Promise<string | undefined>;
	hideHookEditor(): void;
	showHookNotify(message: string, type?: "info" | "warning" | "error"): void;
	showHookCustom<T>(
		factory: (
			tui: TUI,
			theme: Theme,
			keybindings: KeybindingsManager,
			done: (result: T) => void,
		) => (Component & { dispose?(): void }) | Promise<Component & { dispose?(): void }>,
		options?: { overlay?: boolean },
	): Promise<T>;
	showExtensionError(extensionPath: string, error: string): void;
	showToolError(toolName: string, error: string): void;
}
