import * as path from "node:path";
import type { AgentTool, AgentToolContext, AgentToolResult, AgentToolUpdateCallback } from "@oh-my-pi/pi-agent-core";
import type { WindowInfo } from "@oh-my-pi/pi-qml";
import { bridgeBinaryPath, isBridgeAvailable, QmlBridge } from "@oh-my-pi/pi-qml";
import type { RemoteQmlBridge } from "@oh-my-pi/pi-qml-remote";

import { type Static, Type } from "@sinclair/typebox";
import canvasDescription from "../prompts/tools/canvas.md" with { type: "text" };
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
	meta?: OutputMeta;
}

/** Channel name for QML window events emitted to the EventBus. */
export const CANVAS_EVENTS_CHANNEL = "canvas:window:events";

/** Channel name for armed tool invocations emitted by the QML event loop. */
export const CANVAS_TOOL_INVOKE_CHANNEL = "canvas:tool:invoke";

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

	/** Returns the remote bridge if an Android client is connected, null otherwise. */
	/** Resolve a canvas file path, honoring canvas:// internal URLs. */
	async #resolveFilePath(filePath: string): Promise<string> {
		const internalRouter = this.session.internalRouter;
		if (internalRouter?.canHandle(filePath)) {
			const resource = await internalRouter.resolve(filePath);
			if (!resource.sourcePath) throw new ToolError("canvas:// URL has no filesystem path");
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
		void (async () => {
			try {
				while (!signal.aborted) {
					const bridge = getBridge();
					// waitForEvent resolves when events arrive or on timeout (10 min default).
					const raw = await bridge.waitForEvent(id);

					if (signal.aborted) break;

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
		const { action } = params;

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
				const abs = await this.#resolveFilePath(filePath);
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
				const id = params.id;
				const filePath = params.path;
				if (!id) throw new ToolError("launch action requires 'id'");
				if (!filePath) throw new ToolError("launch action requires 'path'");

				const remote = this.#remoteBridge();
				if (remote) {
					// Remote mode: read the local QML file and push its content to Android.
					const abs = await this.#resolveFilePath(filePath);
					const content = await Bun.file(abs).text();
					const win = remote.launch(id, content, {
						title: params.title,
						width: params.width,
						height: params.height,
						props: params.props as Record<string, unknown> | undefined,
					});
					const events = remote.drainEvents(id);
					// Merge armed tools: explicit props override; remote has no file-declared tools yet.
					const propsArmed = params.props?._armedTools;
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

				const abs = await this.#resolveFilePath(filePath);
				const bridge = this.#ensureBridge();
				const win = await bridge.launch(id, abs, {
					title: params.title,
					width: params.width,
					height: params.height,
					props: params.props as Record<string, unknown> | undefined,
				});
				const events = bridge.drainEvents(id);
				// Merge armed tools: explicit props override, then file-declared (with denylist).
				const propsArmed = params.props?._armedTools;
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
					const details: CanvasToolDetails = { action: "close", windowId: id };
					return toolResult(details).text(`Panel '${id}' closed on Android`).done();
				}

				const bridge = this.#ensureBridge();
				await bridge.close(id);
				const details: CanvasToolDetails = { action: "close", windowId: id };
				return toolResult(details).text(`Window '${id}' closed`).done();
			}

			case "send_message": {
				const id = params.id;
				if (!id) throw new ToolError("send_message action requires 'id'");
				if (!params.payload) throw new ToolError("send_message action requires 'payload'");

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
				const savePath = params.path ?? `/tmp/spell-qml/screenshot-${id}-${Date.now()}.png`;
				const bridge = this.#ensureBridge();
				const resultPath = await bridge.screenshot(id, savePath);
				const pngBuffer = await Bun.file(resultPath).arrayBuffer();
				const data = Buffer.from(pngBuffer).toString("base64");
				const details: CanvasToolDetails = { action: "screenshot", windowId: id };
				return toolResult(details)
					.content([
						{ type: "text", text: `Screenshot saved: ${resultPath}` },
						{ type: "image", data, mimeType: "image/png" },
					])
					.done();
			}

			default:
				throw new ToolError(`Unknown action: ${action as string}`);
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
