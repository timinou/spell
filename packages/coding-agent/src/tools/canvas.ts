import * as fs from "node:fs";
import * as path from "node:path";
import type { AgentTool, AgentToolContext, AgentToolResult, AgentToolUpdateCallback } from "@oh-my-pi/pi-agent-core";
import type { WindowInfo } from "@oh-my-pi/pi-qml";
import { bridgeBinaryPath, isBridgeAvailable, QmlBridge } from "@oh-my-pi/pi-qml";
import type { RemoteQmlBridge } from "@oh-my-pi/pi-qml-remote";
import { logger } from "@oh-my-pi/pi-utils";
import { type Static, Type } from "@sinclair/typebox";
import type { ServiceCommand } from "../browser/service-protocol";
import { isServiceCommand } from "../browser/service-protocol";
import { ServiceRegistry, ServiceRegistryError } from "../browser/service-registry";
import { resolveCanvasUrlToPath } from "../internal-urls";
import canvasDescription from "../prompts/tools/canvas.md" with { type: "text" };
import { Priority } from "../utils/event-bus";
import type { ToolSession } from ".";
import { classifyEvent, deduplicateEvents } from "./canvas-event-utils";
import { formatLintOutput, lintQmlFile } from "./canvas-lint";
import type { OutputMeta } from "./output-meta";
import { ensureSpellConnection } from "./spell/connect";
import { ToolError } from "./tool-errors";
import { toolResult } from "./tool-result";

const canvasSchema = Type.Object({
	action: Type.Union(
		[
			Type.Literal("write"),
			Type.Literal("launch"),
			Type.Literal("open"),
			Type.Literal("close"),
			Type.Literal("send_message"),
			Type.Literal("list_windows"),
			Type.Literal("screenshot"),
		],
		{ description: "Action to perform" },
	),
	// write
	path: Type.Optional(Type.String({ description: "File path for write action" })),
	content: Type.Optional(Type.String({ description: "QML file content for write action" })),
	// launch / close / send_message
	id: Type.Optional(Type.String({ description: "Window id" })),
	// launch
	title: Type.Optional(Type.String({ description: "Window title (launch)" })),
	width: Type.Optional(Type.Number({ description: "Window width in pixels (launch, default 800)" })),
	height: Type.Optional(Type.Number({ description: "Window height in pixels (launch, default 600)" })),
	props: Type.Optional(
		Type.Record(Type.String(), Type.Unknown(), {
			description: "Initial props passed to bridge.props in QML (launch)",
		}),
	),
	// send_message
	payload: Type.Optional(Type.Record(Type.String(), Type.Unknown(), { description: "JSON payload (send_message)" })),
});

type CanvasToolInput = Static<typeof canvasSchema>;

export interface CanvasToolDetails {
	action: string;
	windowId?: string;
	windows?: Array<{ id: string; state: string; path: string; eventCount: number }>;
	events?: Array<{ name?: string; payload: Record<string, unknown> }>;
	error?: string;
	lintWarnings?: number;
	lintErrors?: number;
	screenshotPath?: string;
	artifactUri?: string;
	meta?: OutputMeta;
}

type CanvasLaunchSourceKind = "file" | "directory";

export interface NormalizedCanvasLaunchRequest {
	action: "launch";
	id: string;
	path: string;
}

async function tryStatCanvasPath(filePath: string): Promise<fs.Stats | null> {
	try {
		return await fs.promises.stat(filePath);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
		throw error;
	}
}

function defaultCanvasWindowId(filePath: string, sourceKind: CanvasLaunchSourceKind): string {
	if (sourceKind === "directory") return path.basename(path.dirname(filePath));
	const baseName = path.basename(filePath, path.extname(filePath));
	return baseName === "inspector" ? path.basename(path.dirname(filePath)) : baseName;
}

async function resolveCanvasDirectoryEntrypoint(dirPath: string): Promise<string> {
	const directoryName = path.basename(dirPath);
	const preferredEntries = ["inspector.qml", `${directoryName}.qml`];
	for (const entryName of preferredEntries) {
		const candidatePath = path.join(dirPath, entryName);
		const candidateStat = await tryStatCanvasPath(candidatePath);
		if (candidateStat?.isFile()) return candidatePath;
	}

	const entries = await fs.promises.readdir(dirPath, { withFileTypes: true });
	const qmlFiles = entries.filter(entry => entry.isFile() && entry.name.endsWith(".qml"));
	if (qmlFiles.length === 1) return path.join(dirPath, qmlFiles[0].name);

	throw new ToolError(
		`launch target '${dirPath}' is a directory. Provide a .qml file or include a deterministic entrypoint (inspector.qml, ${directoryName}.qml, or a single .qml file).`,
	);
}

export async function normalizeCanvasLaunchRequest(
	params: Pick<CanvasToolInput, "action" | "id" | "path">,
	resolvePath: (filePath: string) => Promise<string>,
): Promise<NormalizedCanvasLaunchRequest | null> {
	if (params.action !== "launch" && params.action !== "open") return null;
	if (!params.path) throw new ToolError(`${params.action} action requires 'path'`);

	const requestedPath = await resolvePath(params.path);
	const requestedStat = await tryStatCanvasPath(requestedPath);
	const sourceKind: CanvasLaunchSourceKind = requestedStat?.isDirectory() ? "directory" : "file";
	const launchPath =
		sourceKind === "directory" ? await resolveCanvasDirectoryEntrypoint(requestedPath) : requestedPath;
	const id =
		typeof params.id === "string" && params.id.trim().length > 0
			? params.id.trim()
			: defaultCanvasWindowId(launchPath, sourceKind);

	return { action: "launch", id, path: launchPath };
}

/** Channel name for QML window events emitted to the EventBus. */
export const CANVAS_EVENTS_CHANNEL = "canvas:window:events";

/** Channel name for armed tool invocations emitted by the QML event loop. */
export const CANVAS_TOOL_INVOKE_CHANNEL = "canvas:tool:invoke";

/** Channel name for scoped orchestrator requests from QML. */
export const CANVAS_ORCHESTRATOR_CHANNEL = "canvas:orchestrator:request";

/** Channel name for full agent requests from QML. */
export const CANVAS_AGENT_CHANNEL = "canvas:agent:request";

/** Channel name for task subagent requests from QML. */
export const CANVAS_TASK_CHANNEL = "canvas:task:request";

/** Tools that cannot be armed from QML file declarations (only from explicit agent props). */
const CANVAS_ARMED_DENYLIST = new Set();

/** Payload emitted on CANVAS_EVENTS_CHANNEL. */
export interface CanvasWindowEventsPayload {
	windowId: string;
	events: WindowInfo["events"];
	/** True when the window closed and the event loop has terminated. */
	closed: boolean;
	/**
	 * True when all events in this batch are low-value noise (url_changed,
	 * harmless stderr, etc.). The SDK delivers these without triggering a turn.
	 */
	silent: boolean;
	/** Human-readable summary of accumulated silent events before this batch. */
	silentSummary?: string;
}

/**
 * Payload emitted on CANVAS_TOOL_INVOKE_CHANNEL.
 *
 * The event loop constructs `reply` as a closure that calls bridge.sendMessage
 * back to the originating window. It is undefined when no _rid was supplied.
 */
export interface CanvasToolInvokePayload {
	/** Window that sent the invocation. */
	windowId: string;
	/** Tool name requested by QML (e.g. "write"). */
	tool: string;
	/** Arguments extracted from the QML payload (minus the protocol fields). */
	args: Record<string, unknown>;
	/** Tools this window is allowed to arm-invoke. Validated by the sdk handler. */
	allowedTools: string[];
	/**
	 * Optional callback to deliver the tool result back to the QML window.
	 * Present only when the QML payload included a `_rid` field.
	 */
	reply?: (result: Record<string, unknown>) => void;
}

/** Payload emitted on CANVAS_ORCHESTRATOR_CHANNEL when QML sends _tier: 'orchestrator'. */
export interface CanvasOrchestratorPayload {
	windowId: string;
	scope: string;
	tools?: string[];
	context?: Record<string, unknown>;
}

/** Payload emitted on CANVAS_AGENT_CHANNEL when QML sends _tier: 'agent'. */
export interface CanvasAgentPayload {
	windowId: string;
	assignment: string;
	context?: Record<string, unknown>;
	/** Optional callback to deliver submission status back to the originating window. */
	reply?: (result: Record<string, unknown>) => void;
}

/** Payload emitted on CANVAS_TASK_CHANNEL when QML sends _tier: 'task'. */
export interface CanvasTaskPayload {
	windowId: string;
	assignment: string;
	/** Model role pattern, e.g. "pi/sniper". Defaults to "pi/sniper". */
	model?: string;
	/** System prompt for the task subagent. */
	systemPrompt?: string;
	/** Tool names the task subagent should have. */
	tools?: string[];
	/** JTD output schema for structured result. */
	outputSchema?: unknown;
	/** Arbitrary context passed through to the subagent. */
	context?: Record<string, unknown>;
	/** Images to include (e.g. element screenshots). */
	images?: Array<{ data: string; mimeType: string }>;
	/** Optional callback to deliver task acknowledgment back to the QML window. Present only when the QML payload included a `_rid` field. */
	reply?: (result: Record<string, unknown>) => void;
}

export function drainCanvasTierEventsNow(
	eventBus: { drain: (maxItems?: number) => Promise<number> } | undefined,
	isAgentIdle?: () => boolean,
	onError: (error: unknown) => void = err => {
		logger.error("Canvas immediate event drain failed", { error: String(err) });
	},
): void {
	if (!eventBus) return;
	if (isAgentIdle?.() === false) return;
	void eventBus.drain().catch(onError);
}

export class CanvasTool implements AgentTool<typeof canvasSchema, CanvasToolDetails> {
	readonly name = "canvas";
	readonly label = "Canvas";
	readonly description = canvasDescription;
	readonly parameters = canvasSchema;
	readonly strict = false;

	#bridge: QmlBridge | null = null;
	/** Per-window abort controllers for background event loops. */
	#eventLoops = new Map<string, AbortController>();
	/** Per-window list of tools allowed to be arm-invoked without an agent turn. */
	#armedTools = new Map<string, string[]>();
	/** Per-window debounce accumulator for canvas event batching. */
	#pendingCanvasEvents = new Map<string, { events: WindowInfo["events"]; timer: NodeJS.Timeout }>();

	constructor(private readonly session: ToolSession) {}

	#isCanvasInternalUrl(filePath: string): boolean {
		return filePath.startsWith("canvas://");
	}

	/** Resolve a file path for read/launch operations (must exist for internal URLs). */
	async #resolveLaunchPath(filePath: string): Promise<string> {
		const internalRouter = this.session.internalRouter;
		if (internalRouter?.canHandle(filePath)) {
			const resource = await internalRouter.resolve(filePath);
			if (!resource.sourcePath) throw new ToolError("canvas:// URL has no filesystem path");
			return resource.sourcePath;
		}
		return path.isAbsolute(filePath) ? filePath : path.join(this.session.cwd, filePath);
	}

	/** Resolve a file path for writes. canvas://session/... may not exist yet. */
	async #resolveWritePath(filePath: string): Promise<string> {
		if (this.#isCanvasInternalUrl(filePath)) {
			return resolveCanvasUrlToPath(
				filePath,
				{
					getStdlibRoot: () => path.resolve(import.meta.dir, "../modes/qml"),
					getArtifactsDir: this.session.getArtifactsDir,
					getSessionId: this.session.getSessionId,
				},
				"write",
			);
		}

		const internalRouter = this.session.internalRouter;
		if (internalRouter?.canHandle(filePath)) {
			const resource = await internalRouter.resolve(filePath);
			if (!resource.sourcePath) throw new ToolError("Internal URL has no filesystem path");
			return resource.sourcePath;
		}

		return path.isAbsolute(filePath) ? filePath : path.join(this.session.cwd, filePath);
	}

	#remoteBridge(): RemoteQmlBridge | null {
		const server = this.session.qmlRemoteServer;
		return server?.bridge ?? null;
	}

	#ensureBridge(): QmlBridge {
		if (!this.#bridge) {
			if (!isBridgeAvailable()) {
				throw new ToolError(
					`spell-qml-bridge binary not found at ${bridgeBinaryPath()}.\nBuild it first: cd packages/qml && bun run build:bridge`,
				);
			}
			this.#bridge = new QmlBridge();
		}
		return this.#bridge;
	}

	#syncManagerBridge(bridge: QmlBridge | RemoteQmlBridge | undefined): void {
		this.session.orchestratorManager?.setBridge(bridge);
		this.session.taskManager?.setBridge(bridge);
	}

	#drainQueuedCanvasEvents(eventBus: typeof this.session.eventBus): void {
		drainCanvasTierEventsNow(eventBus, this.session.isAgentIdle);
	}

	async #maybeAugmentPhoenixInspectorLaunchProps(
		absPath: string,
		props: Record<string, unknown>,
	): Promise<Record<string, unknown>> {
		if (
			!absPath.endsWith(`${path.sep}.spell${path.sep}extensions${path.sep}phoenix-inspector${path.sep}inspector.qml`)
		) {
			return props;
		}

		const nextProps = { ...props };
		const inspectorDir = path.dirname(absPath);
		nextProps.taskTierSupported = true;
		if (typeof nextProps.quickFixSystemPrompt !== "string") {
			try {
				nextProps.quickFixSystemPrompt = await Bun.file(path.join(inspectorDir, "prompts/frontend-fix.md")).text();
			} catch {}
		}
		if (nextProps.quickFixOutputSchema === undefined) {
			try {
				nextProps.quickFixOutputSchema = await Bun.file(
					path.join(inspectorDir, "prompts/quick-fix-schema.json"),
				).json();
			} catch {}
		}
		if (typeof nextProps.tidewaveMcpUrl !== "string") {
			let dir = path.dirname(inspectorDir);
			while (dir && dir !== path.dirname(dir)) {
				try {
					const raw = await Bun.file(path.join(dir, ".spell/mcp.json")).text();
					const parsed = JSON.parse(raw) as { mcpServers?: Record<string, { url?: unknown }> };
					const url = parsed.mcpServers?.tidewave?.url;
					if (typeof url === "string" && url.trim().length > 0) {
						nextProps.tidewaveMcpUrl = url.trim();
						break;
					}
				} catch {}
				dir = path.dirname(dir);
			}
		}
		return nextProps;
	}

	/**
	 * Start a background event loop for a window. Events are delivered to the agent
	 * via EventBus rather than requiring explicit `listen` calls. The loop runs until
	 * the window closes or `#stopEventLoop` is called (e.g., on explicit close/dispose).
	 */

	/**
	 * Build a one-line summary of accumulated silent events, e.g.:
	 * "6 silent events suppressed (3x url_changed, 2x stderr, 1x heartbeat)"
	 */
	#buildSilentSummary(silentEvents: WindowInfo["events"]): string {
		const counts = new Map<string, number>();
		for (const ev of silentEvents) {
			const key = ev.name ?? "unknown";
			counts.set(key, (counts.get(key) ?? 0) + 1);
		}
		const breakdown = [...counts.entries()].map(([k, n]) => `${n}x ${k}`).join(", ");
		return `${silentEvents.length} silent event(s) suppressed (${breakdown})`;
	}

	/**
	 * Start a background event loop for a window. Events are delivered to the agent
	 * via EventBus rather than requiring explicit `listen` calls. The loop runs until
	 * the window closes or `#stopEventLoop` is called (e.g., on explicit close/dispose).
	 */
	#startEventLoop(id: string, getBridge: () => QmlBridge | RemoteQmlBridge): void {
		// Stop any existing loop for this window before starting a new one.
		this.#stopEventLoop(id);

		const ac = new AbortController();
		this.#eventLoops.set(id, ac);
		const { signal } = ac;

		const eventBus = this.session.eventBus;

		// Accumulates silent events between loud batches.
		let pendingSilent: WindowInfo["events"] = [];

		// Fire-and-forget: errors are logged, not thrown, since there's no caller to propagate to.
		let reconnectAttempts = 0;
		void (async () => {
			try {
				while (!signal.aborted) {
					const bridge = getBridge();
					// waitForEvent resolves when events arrive or on timeout (10 min default).
					const raw = await bridge.waitForEvent(id);

					if (signal.aborted) break;

					// Handle socket disconnect: wait for auto-reconnect, then retry.
					const hasDisconnect = raw.some(e => e.name === "socket_disconnected");
					if (hasDisconnect) {
						reconnectAttempts++;
						if (reconnectAttempts > 3) {
							logger.warn("Canvas event loop: max reconnect retries reached", { id });
							break;
						}
						// QmlProcess auto-reconnect runs in background. Wait for it to finish.
						await Bun.sleep(2000);
						continue;
					}
					reconnectAttempts = 0; // Reset on successful event delivery

					const userInitiatedClose = raw.some(e => (e.payload as { action?: string }).action === "close");
					const wmClose = bridge.getWindow(id)?.state === "closed" && !userInitiatedClose;
					const closed = userInitiatedClose || wmClose;

					if (raw.length === 0 && wmClose) {
						// WM killed the window — surface a close event so the agent knows.
						const payload: CanvasWindowEventsPayload = {
							windowId: id,
							events: [{ name: "close", payload: { action: "close", wmClose: true } }],
							closed: true,
							silent: false,
						};
						eventBus?.emit(CANVAS_EVENTS_CHANNEL, payload);
						break;
					}
					if (raw.length === 0) continue;

					// For canvas windows, debounce events with a 100ms timer.
					if (id.startsWith("canvas")) {
						const existing = this.#pendingCanvasEvents.get(id);
						if (existing) {
							existing.events.push(...raw);
							clearTimeout(existing.timer);
						} else {
							this.#pendingCanvasEvents.set(id, { events: [...raw], timer: undefined! });
						}
						const entry = this.#pendingCanvasEvents.get(id)!;
						const capturedPendingSilent = pendingSilent;
						entry.timer = setTimeout(() => {
							const accumulated = entry.events;
							this.#pendingCanvasEvents.delete(id);
							this.#flushEvents(
								id,
								accumulated,
								userInitiatedClose,
								capturedPendingSilent,
								closed,
								getBridge,
								eventBus,
							);
							if (closed) {
								// Cannot break from setTimeout callback; abort the loop instead.
								ac.abort();
							}
						}, 100);
						// Reset pending silent since it will be consumed by the timer callback.
						pendingSilent = [];
					} else {
						pendingSilent = this.#flushEvents(
							id,
							raw,
							userInitiatedClose,
							pendingSilent,
							closed,
							getBridge,
							eventBus,
						);
					}

					if (closed && !id.startsWith("canvas")) break;
				}
			} catch {
				// Window gone or bridge disposed — loop terminates silently.
			} finally {
				this.#eventLoops.delete(id);
			}
		})();
	}

	/**
	 * Process raw events through deduplication, armed-tool extraction, and
	 * classification. Emits payloads on the event bus. Returns the updated
	 * pendingSilent accumulator (caller must reassign).
	 */
	#flushEvents(
		id: string,
		raw: WindowInfo["events"],
		userInitiatedClose: boolean,
		pendingSilent: WindowInfo["events"],
		closed: boolean,
		getBridge: () => QmlBridge | RemoteQmlBridge,
		eventBus: typeof this.session.eventBus,
	): WindowInfo["events"] {
		const events = deduplicateEvents(raw);

		// Extract armed tool invocations before regular event classification.
		const allowedTools = this.#armedTools.get(id) ?? [];
		const regularEvents: typeof events = [];
		for (const ev of events) {
			const p = ev.payload as Record<string, unknown>;
			if (typeof p._tool === "string" && eventBus) {
				const toolName = p._tool;
				const rid = typeof p._rid === "string" ? p._rid : undefined;
				const args: Record<string, unknown> = {};
				for (const [k, v] of Object.entries(p)) {
					if (k !== "_tool" && k !== "_rid") args[k] = v;
				}
				const invokeBridge = getBridge();
				const invokePayload: CanvasToolInvokePayload = {
					windowId: id,
					tool: toolName,
					args,
					allowedTools,
					reply: rid
						? result => {
								void invokeBridge.sendMessage(id, { _rid: rid, ...result });
							}
						: undefined,
				};
				eventBus.emit(CANVAS_TOOL_INVOKE_CHANNEL, invokePayload);
			} else if (typeof p._tier === "string" && eventBus) {
				// Tier dispatch: route to orchestrator or full agent channel.
				const tier = p._tier;
				if (tier === "orchestrator" && typeof p._scope === "string") {
					const payload: CanvasOrchestratorPayload = {
						windowId: id,
						scope: p._scope,
						tools: Array.isArray(p._tools) ? (p._tools as string[]) : undefined,
						context:
							typeof p.context === "object" && p.context !== null
								? (p.context as Record<string, unknown>)
								: undefined,
					};
					eventBus.enqueue(CANVAS_ORCHESTRATOR_CHANNEL, payload, Priority.P1);
					this.#drainQueuedCanvasEvents(eventBus);
				} else if (tier === "agent" && typeof p._assignment === "string") {
					const rid = typeof p._rid === "string" ? p._rid : undefined;
					const agentBridge = getBridge();
					const payload: CanvasAgentPayload = {
						windowId: id,
						assignment: p._assignment,
						context:
							typeof p.context === "object" && p.context !== null
								? (p.context as Record<string, unknown>)
								: undefined,
						reply: rid
							? result => {
									void agentBridge.sendMessage(id, { _rid: rid, ...result });
								}
							: undefined,
					};
					eventBus.enqueue(CANVAS_AGENT_CHANNEL, payload, Priority.P1);
					this.#drainQueuedCanvasEvents(eventBus);
				} else if (tier === "task" && typeof p._assignment === "string") {
					const rid = typeof p._rid === "string" ? p._rid : undefined;
					const taskBridge = getBridge();
					const context =
						typeof p.context === "object" && p.context !== null
							? (p.context as Record<string, unknown>)
							: undefined;
					const images = Array.isArray(p.images)
						? (p.images as Array<{ data: string; mimeType: string }>)
						: undefined;
					const payload: CanvasTaskPayload = {
						windowId: id,
						assignment: p._assignment,
						model: typeof p._model === "string" ? p._model : undefined,
						systemPrompt: typeof p._systemPrompt === "string" ? p._systemPrompt : undefined,
						tools: Array.isArray(p._tools) ? (p._tools as string[]) : undefined,
						outputSchema: p._outputSchema,
						context,
						images,
						reply: rid
							? result => {
									void taskBridge.sendMessage(id, { _rid: rid, ...result });
								}
							: undefined,
					};
					eventBus.enqueue(CANVAS_TASK_CHANNEL, payload, Priority.P1);
					this.#drainQueuedCanvasEvents(eventBus);
				} else {
					// Unknown tier or missing required fields — treat as regular event.
					regularEvents.push(ev);
				}
			} else if (p.type === "save_session" && typeof p.name === "string") {
				void this.#handleSaveSession(p);
			} else {
				regularEvents.push(ev);
			}
		}

		const silentBatch = regularEvents.filter(e => classifyEvent(e) === "silent");
		const loudBatch = regularEvents.filter(e => classifyEvent(e) === "loud");

		const accumulated = [...pendingSilent, ...silentBatch];

		if (loudBatch.length > 0 || userInitiatedClose) {
			if (accumulated.length > 0 && eventBus) {
				const silentPayload: CanvasWindowEventsPayload = {
					windowId: id,
					events: accumulated,
					closed: false,
					silent: true,
				};
				eventBus.emit(CANVAS_EVENTS_CHANNEL, silentPayload);
			}
			const silentSummary = accumulated.length > 0 ? this.#buildSilentSummary(accumulated) : undefined;

			const payload: CanvasWindowEventsPayload = {
				windowId: id,
				events: loudBatch,
				closed,
				silent: false,
				silentSummary,
			};
			eventBus?.emit(CANVAS_EVENTS_CHANNEL, payload);
			return [];
		} else if (silentBatch.length > 0 && eventBus) {
			const silentPayload: CanvasWindowEventsPayload = {
				windowId: id,
				events: silentBatch,
				closed: false,
				silent: true,
			};
			eventBus.emit(CANVAS_EVENTS_CHANNEL, silentPayload);
		}

		return accumulated;
	}

	#stopEventLoop(id: string): void {
		const ac = this.#eventLoops.get(id);
		if (ac) {
			ac.abort();
			this.#eventLoops.delete(id);
		}
	}

	async execute(
		_toolCallId: string,
		params: CanvasToolInput,
		_signal?: AbortSignal,
		_onUpdate?: AgentToolUpdateCallback<CanvasToolDetails>,
		context?: AgentToolContext,
	): Promise<AgentToolResult<CanvasToolDetails>> {
		const normalizedLaunch = await normalizeCanvasLaunchRequest(params, filePath =>
			this.#resolveLaunchPath(filePath),
		);
		const action = normalizedLaunch?.action ?? params.action;

		// For actions that can use a remote Android device, ensure Spell is connected.
		// write and screenshot are local-only; all others can route to Android.
		// But only attempt Spell setup if there's already a remote server configured —
		// otherwise we'd block a local desktop launch waiting for Android.
		if (action !== "write" && action !== "screenshot" && context && this.#remoteBridge()) {
			await ensureSpellConnection(this.session, context);
		}

		switch (action) {
			case "write": {
				const filePath = params.path;
				const content = params.content;
				if (!filePath) throw new ToolError("write action requires 'path'");
				if (content === undefined) throw new ToolError("write action requires 'content'");
				const abs = await this.#resolveWritePath(filePath);
				await Bun.write(abs, content);
				const lint = await lintQmlFile(abs);
				const lintText = formatLintOutput(lint);
				const details: CanvasToolDetails = {
					action: "write",
					...(lint.available && { lintWarnings: lint.warnings.length, lintErrors: lint.errors.length }),
				};
				return toolResult(details).text(`Written: ${abs}${lintText}`).done();
			}

			case "launch": {
				const id = normalizedLaunch?.id ?? params.id;
				const filePath = normalizedLaunch?.path ?? params.path;
				if (!id) throw new ToolError("launch action requires 'id'");
				if (!filePath) throw new ToolError("launch action requires 'path'");

				const remote = this.#remoteBridge();
				if (remote) {
					// Remote mode: read the local QML file and push its content to Android.
					const abs = filePath;
					const content = await Bun.file(abs).text();
					const props = await this.#maybeAugmentPhoenixInspectorLaunchProps(
						abs,
						(params.props as Record<string, unknown> | undefined) ?? {},
					);
					const win = remote.launch(id, content, {
						title: params.title,
						width: params.width,
						height: params.height,
						props,
					});
					this.#syncManagerBridge(remote);
					const events = remote.drainEvents(id);
					// Merge armed tools: explicit props override; remote has no file-declared tools yet.
					const propsArmed = props._armedTools;
					let armedList: string[];
					if (Array.isArray(propsArmed)) {
						armedList = propsArmed.filter((t): t is string => typeof t === "string");
					} else if (Array.isArray(win.armedTools)) {
						armedList = win.armedTools.filter(t => !CANVAS_ARMED_DENYLIST.has(t));
					} else {
						armedList = [];
					}
					if (armedList.length > 0) {
						this.#armedTools.set(id, armedList);
					}
					// Start background event loop so events arrive as follow-ups.
					this.#startEventLoop(id, () => this.#remoteBridge()!);
					const details: CanvasToolDetails = { action: "launch", windowId: id, events };
					const text = `Panel '${id}' pushed to Android (state: ${win.state})${events.length ? `\n${events.length} event(s) received` : ""}`;
					return toolResult(details).text(text).done();
				}

				const abs = filePath;
				const bridge = this.#ensureBridge();

				// Service-aware launch: resolve storageName from registry
				let props = (params.props as Record<string, unknown> | undefined) ?? {};
				if (typeof props.serviceName === "string" && props.serviceName) {
					try {
						const registry = new ServiceRegistry();
						const service = await registry.get(props.serviceName);
						if (service) {
							props.storageName = service.profileStorage;
							await registry.updateLastUsed(props.serviceName);
						} else {
							props.storageName = props.serviceName;
						}
					} catch (err) {
						logger.warn("Failed to resolve service for launch", {
							serviceName: props.serviceName,
							error: err instanceof Error ? err.message : String(err),
						});
					}
				}
				props = await this.#maybeAugmentPhoenixInspectorLaunchProps(abs, props);

				const win = await bridge.launch(id, abs, {
					title: params.title,
					width: params.width,
					height: params.height,
					props,
				});
				this.#syncManagerBridge(bridge);
				const events = bridge.drainEvents(id);
				// Merge armed tools: explicit props override, then file-declared (with denylist).
				const propsArmed = props._armedTools;
				let armedList: string[];
				if (Array.isArray(propsArmed)) {
					armedList = propsArmed.filter((t): t is string => typeof t === "string");
				} else if (Array.isArray(win.armedTools)) {
					armedList = win.armedTools.filter(t => !CANVAS_ARMED_DENYLIST.has(t));
				} else {
					armedList = [];
				}
				if (armedList.length > 0) {
					this.#armedTools.set(id, armedList);
				}
				// Start background event loop so events arrive as follow-ups.
				this.#startEventLoop(id, () => this.#ensureBridge());
				const details: CanvasToolDetails = { action: "launch", windowId: id, events };
				const text = `Window '${id}' launched (state: ${win.state})${events.length ? `\n${events.length} event(s) received` : ""}`;
				return toolResult(details).text(text).done();
			}

			case "close": {
				const id = params.id;
				if (!id) throw new ToolError("close action requires 'id'");
				// Stop the event loop before closing so we don't race with the close event.
				this.#stopEventLoop(id);
				this.#armedTools.delete(id);

				const remote = this.#remoteBridge();
				if (remote) {
					remote.close(id);
					if (remote.listWindows().length === 0) {
						this.#syncManagerBridge(undefined);
					}
					const details: CanvasToolDetails = { action: "close", windowId: id };
					return toolResult(details).text(`Panel '${id}' closed on Android`).done();
				}

				const bridge = this.#ensureBridge();
				await bridge.close(id);
				if (bridge.listWindows().filter(w => w.state !== "closed").length === 0) {
					this.#syncManagerBridge(undefined);
				}
				const details: CanvasToolDetails = { action: "close", windowId: id };
				return toolResult(details).text(`Window '${id}' closed`).done();
			}

			case "send_message": {
				const id = params.id;
				if (!id) throw new ToolError("send_message action requires 'id'");
				if (!params.payload) throw new ToolError("send_message action requires 'payload'");

				// Intercept service commands — handled in TS, never forwarded to QML
				const payloadAction = (params.payload as Record<string, unknown>)?.action;
				if (typeof payloadAction === "string" && isServiceCommand(payloadAction)) {
					const result = await this.#handleServiceCommand(params.payload as unknown as ServiceCommand);
					const details: CanvasToolDetails = { action: "send_message", windowId: id };
					return toolResult(details)
						.text(JSON.stringify(result, null, 2))
						.done();
				}

				const remote = this.#remoteBridge();
				if (remote) {
					remote.sendMessage(id, params.payload as Record<string, unknown>);
					const details: CanvasToolDetails = { action: "send_message", windowId: id };
					return toolResult(details).text(`Message sent to panel '${id}' on Android`).done();
				}

				const bridge = this.#ensureBridge();
				await bridge.sendMessage(id, params.payload as Record<string, unknown>);
				const details: CanvasToolDetails = { action: "send_message", windowId: id };
				return toolResult(details).text(`Message sent to '${id}'`).done();
			}

			case "list_windows": {
				const remote = this.#remoteBridge();
				const windows = remote ? remote.listWindows() : this.#bridge ? this.#bridge.listWindows() : [];
				const details: CanvasToolDetails = {
					action: "list_windows",
					windows: windows.map(w => ({
						id: w.id,
						state: w.state,
						path: w.path,
						eventCount: w.events.length,
					})),
				};
				if (windows.length === 0) {
					return toolResult(details).text("No active windows").done();
				}
				const rows = windows.map(w => `${w.id}\t${w.state}\t${w.events.length} events\t${w.path}`);
				return toolResult(details)
					.text(["id\tstate\tevents\tpath", ...rows].join("\n"))
					.done();
			}
			case "screenshot": {
				const id = params.id;
				if (!id) throw new ToolError("screenshot action requires 'id'");
				const requestedPath =
					typeof params.path === "string" && params.path.trim().length > 0
						? path.resolve(this.session.cwd, params.path)
						: undefined;

				const artifact = await this.session.allocateOutputArtifact?.("screenshot", "png");

				const savePath = requestedPath ?? artifact?.path ?? `/tmp/spell-qml/screenshot-${id}-${Date.now()}.png`;
				const bridge = this.#ensureBridge();
				const resultPath = await bridge.screenshot(id, savePath);
				const pngBuffer = await Bun.file(resultPath).bytes();
				if (requestedPath && artifact?.path && artifact.path !== resultPath) {
					await Bun.write(artifact.path, pngBuffer);
				}
				const data = Buffer.from(pngBuffer).toString("base64");
				const details: CanvasToolDetails = {
					action: "screenshot",
					windowId: id,
					screenshotPath: requestedPath ?? artifact?.path ?? resultPath,
					artifactUri: artifact?.uri,
				};
				const lines = [`Screenshot saved: ${details.screenshotPath}`];
				if (requestedPath && artifact?.path) {
					lines.push(`Artifact path: ${artifact.path}`);
				}
				if (artifact?.uri) {
					lines.push(`Artifact: ${artifact.uri}`);
				}
				return toolResult(details)
					.content([
						{ type: "text", text: lines.join("\n") },
						{ type: "image", data, mimeType: "image/png" },
					])
					.done();
			}

			default:
				throw new ToolError(`Unknown action: ${action as string}`);
		}
	}

	async #handleServiceCommand(cmd: ServiceCommand): Promise<Record<string, unknown>> {
		const registry = new ServiceRegistry();
		const rid = cmd._rid;
		try {
			switch (cmd.action) {
				case "service:list": {
					const services = await registry.list();
					return { action: "service:result", _rid: rid, command: cmd.action, ok: true, result: services };
				}
				case "service:connect": {
					await registry.add({
						name: cmd.name,
						displayName: cmd.displayName || cmd.name,
						description: cmd.description || "",
						profileStorage: cmd.name,
						domains: cmd.domains || [],
						parentService: cmd.parentService,
						loginUrl: cmd.loginUrl,
					});
					return {
						action: "service:result",
						_rid: rid,
						command: cmd.action,
						ok: true,
						result: { name: cmd.name },
					};
				}
				case "service:disconnect": {
					await registry.remove(cmd.name);
					return {
						action: "service:result",
						_rid: rid,
						command: cmd.action,
						ok: true,
						result: { name: cmd.name },
					};
				}
			}
		} catch (err) {
			const code = err instanceof ServiceRegistryError ? err.code : "unknown";
			const message = err instanceof Error ? err.message : String(err);
			return { action: "service:result", _rid: rid, command: cmd.action, ok: false, error: { code, message } };
		}
	}

	async #handleSaveSession(payload: Record<string, unknown>): Promise<void> {
		try {
			const name = payload.name as string;
			if (!name) return;
			const registry = new ServiceRegistry();
			const domains = Array.isArray(payload.domains)
				? payload.domains.filter((d): d is string => typeof d === "string")
				: [];
			await registry.add({
				name,
				displayName: (payload.displayName as string) || name,
				description: (payload.description as string) || "",
				profileStorage: name,
				domains,
				parentService: (payload.parentService as string) || undefined,
				loginUrl: undefined,
				faviconPath: undefined,
			});
			logger.debug("Saved browser session", { name, domains });
		} catch (err) {
			logger.warn("Failed to save browser session", {
				error: err instanceof Error ? err.message : String(err),
			});
		}
	}

	async dispose(): Promise<void> {
		// Abort all background event loops before disposing the bridge.
		for (const ac of this.#eventLoops.values()) {
			ac.abort();
		}
		this.#eventLoops.clear();
		this.#armedTools.clear();
		// Cancel all pending canvas debounce timers to avoid use-after-dispose.
		for (const entry of this.#pendingCanvasEvents.values()) {
			clearTimeout(entry.timer);
		}
		this.#pendingCanvasEvents.clear();
		await this.#bridge?.dispose();
		this.#bridge = null;
	}
}
