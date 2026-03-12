import * as path from "node:path";
import type { AgentTool, AgentToolContext, AgentToolResult, AgentToolUpdateCallback } from "@oh-my-pi/pi-agent-core";
import type { WindowInfo } from "@oh-my-pi/pi-qml";
import { bridgeBinaryPath, isBridgeAvailable, QmlBridge } from "@oh-my-pi/pi-qml";
import type { RemoteQmlBridge } from "@oh-my-pi/pi-qml-remote";

import { type Static, Type } from "@sinclair/typebox";
import qmlDescription from "../prompts/tools/qml.md" with { type: "text" };
import type { ToolSession } from ".";
import type { OutputMeta } from "./output-meta";
import { ensureSpellConnection } from "./spell/connect";
import { ToolError } from "./tool-errors";
import { toolResult } from "./tool-result";

const qmlSchema = Type.Object({
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

type QmlToolInput = Static<typeof qmlSchema>;

export interface QmlToolDetails {
	action: string;
	windowId?: string;
	windows?: Array<{ id: string; state: string; path: string; eventCount: number }>;
	events?: Array<{ name?: string; payload: Record<string, unknown> }>;
	error?: string;
	meta?: OutputMeta;
}

/** Channel name for QML window events emitted to the EventBus. */
export const QML_EVENTS_CHANNEL = "qml:window:events";

/** Payload emitted on QML_EVENTS_CHANNEL. */
export interface QmlWindowEventsPayload {
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

export class QmlTool implements AgentTool<typeof qmlSchema, QmlToolDetails> {
	readonly name = "qml";
	readonly label = "QML";
	readonly description = qmlDescription;
	readonly parameters = qmlSchema;
	readonly strict = false;

	#bridge: QmlBridge | null = null;
	/** Per-window abort controllers for background event loops. */
	#eventLoops = new Map<string, AbortController>();

	constructor(private readonly session: ToolSession) {}

	/** Returns the remote bridge if an Android client is connected, null otherwise. */
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
	 * Classify an event as silent (noise) or loud (agent-visible).
	 *
	 * Silent: url_changed, harmless stderr (fontconfig, CSP frame-ancestors,
	 * dev-mode warnings), or any event with payload.silent === true.
	 * Loud: close, JS errors in stderr, user interactions, unknown types.
	 */
	#classifyEvent(event: WindowInfo["events"][number]): "silent" | "loud" {
		const name = event.name ?? "";
		const payload = event.payload as Record<string, unknown>;

		// QML-side opt-in silence.
		if (payload.silent === true) return "silent";

		// close is always loud.
		if (name === "close" || payload.action === "close") return "loud";

		// Navigation noise.
		if (name === "url_changed") return "silent";

		// Stderr events: JS errors stay loud; harmless system messages are silent.
		if (name === "stderr") {
			const text = String(payload.text ?? payload.message ?? payload.data ?? "");
			// JS/runtime errors must surface to the agent.
			if (/TypeError|SyntaxError|ReferenceError|RangeError|URIError|EvalError/.test(text)) {
				return "loud";
			}
			// Known harmless patterns.
			if (/fontconfig|frame-ancestors|Content Security Policy|dev mode|Lit is in/i.test(text)) {
				return "silent";
			}
			// Unknown stderr — surface it.
			return "loud";
		}

		// Default: loud (fail-open for visibility).
		return "loud";
	}

	/**
	 * Collapse adjacent events with identical name+payload into a single entry
	 * with a 'count' field in the payload to avoid redundant noise.
	 */
	#deduplicateEvents(events: WindowInfo["events"]): Array<WindowInfo["events"][number] & { count?: number }> {
		const out: Array<WindowInfo["events"][number] & { count?: number }> = [];
		for (const ev of events) {
			const prev = out.at(-1);
			if (prev && prev.name === ev.name && JSON.stringify(prev.payload) === JSON.stringify(ev.payload)) {
				prev.count = (prev.count ?? 1) + 1;
			} else {
				out.push({ ...ev });
			}
		}
		return out;
	}

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

					// A close is "user-initiated" when the QML side explicitly sent
					// { action: "close" } before Qt.quit(). A window-manager kill
					// (Alt+F4, clicking X) produces only the bridge "closed" event
					// with an empty events array — that must NOT abort the current
					// agent turn, so we suppress the bus emit in that case.
					const userInitiatedClose = raw.some(e => (e.payload as { action?: string }).action === "close");
					const wmClose = bridge.getWindow(id)?.state === "closed" && !userInitiatedClose;
					const closed = userInitiatedClose || wmClose;

					if (raw.length === 0 && !userInitiatedClose) {
						if (closed) break;
						continue;
					}

					const events = this.#deduplicateEvents(raw);
					const silentBatch = events.filter(e => this.#classifyEvent(e) === "silent");
					const loudBatch = events.filter(e => this.#classifyEvent(e) === "loud");

					// Accumulate silents from this batch.
					pendingSilent = [...pendingSilent, ...silentBatch];

					if (loudBatch.length > 0 || userInitiatedClose) {
						// Emit accumulated silent events as a non-turn message before the loud batch.
						if (pendingSilent.length > 0 && eventBus) {
							const silentPayload: QmlWindowEventsPayload = {
								windowId: id,
								events: pendingSilent,
								closed: false,
								silent: true,
							};
							eventBus.emit(QML_EVENTS_CHANNEL, silentPayload);
						}
						const silentSummary = pendingSilent.length > 0 ? this.#buildSilentSummary(pendingSilent) : undefined;
						pendingSilent = [];

						const payload: QmlWindowEventsPayload = {
							windowId: id,
							events: loudBatch,
							closed,
							silent: false,
							silentSummary,
						};
						eventBus?.emit(QML_EVENTS_CHANNEL, payload);
					} else if (silentBatch.length > 0 && eventBus) {
						// All events in this batch are silent — emit quietly, no turn.
						const silentPayload: QmlWindowEventsPayload = {
							windowId: id,
							events: silentBatch,
							closed: false,
							silent: true,
						};
						eventBus.emit(QML_EVENTS_CHANNEL, silentPayload);
					}

					if (closed) break;
				}
			} catch {
				// Window gone or bridge disposed — loop terminates silently.
			} finally {
				this.#eventLoops.delete(id);
			}
		})();
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
		params: QmlToolInput,
		_signal?: AbortSignal,
		_onUpdate?: AgentToolUpdateCallback<QmlToolDetails>,
		context?: AgentToolContext,
	): Promise<AgentToolResult<QmlToolDetails>> {
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
				const abs = path.isAbsolute(filePath) ? filePath : path.join(this.session.cwd, filePath);
				await Bun.write(abs, content);
				const details: QmlToolDetails = { action: "write" };
				return toolResult(details).text(`Written: ${abs}`).done();
			}

			case "launch": {
				const id = params.id;
				const filePath = params.path;
				if (!id) throw new ToolError("launch action requires 'id'");
				if (!filePath) throw new ToolError("launch action requires 'path'");

				const remote = this.#remoteBridge();
				if (remote) {
					// Remote mode: read the local QML file and push its content to Android.
					const abs = path.isAbsolute(filePath) ? filePath : path.join(this.session.cwd, filePath);
					const content = await Bun.file(abs).text();
					const win = remote.launch(id, content, {
						title: params.title,
						width: params.width,
						height: params.height,
						props: params.props as Record<string, unknown> | undefined,
					});
					const events = remote.drainEvents(id);
					// Start background event loop so events arrive as follow-ups.
					this.#startEventLoop(id, () => this.#remoteBridge()!);
					const details: QmlToolDetails = { action: "launch", windowId: id, events };
					const text = `Panel '${id}' pushed to Android (state: ${win.state})${events.length ? `\n${events.length} event(s) received` : ""}`;
					return toolResult(details).text(text).done();
				}

				const abs = path.isAbsolute(filePath) ? filePath : path.join(this.session.cwd, filePath);
				const bridge = this.#ensureBridge();
				const win = await bridge.launch(id, abs, {
					title: params.title,
					width: params.width,
					height: params.height,
					props: params.props as Record<string, unknown> | undefined,
				});
				const events = bridge.drainEvents(id);
				// Start background event loop so events arrive as follow-ups.
				this.#startEventLoop(id, () => this.#ensureBridge());
				const details: QmlToolDetails = { action: "launch", windowId: id, events };
				const text = `Window '${id}' launched (state: ${win.state})${events.length ? `\n${events.length} event(s) received` : ""}`;
				return toolResult(details).text(text).done();
			}

			case "close": {
				const id = params.id;
				if (!id) throw new ToolError("close action requires 'id'");
				// Stop the event loop before closing so we don't race with the close event.
				this.#stopEventLoop(id);

				const remote = this.#remoteBridge();
				if (remote) {
					remote.close(id);
					const details: QmlToolDetails = { action: "close", windowId: id };
					return toolResult(details).text(`Panel '${id}' closed on Android`).done();
				}

				const bridge = this.#ensureBridge();
				await bridge.close(id);
				const details: QmlToolDetails = { action: "close", windowId: id };
				return toolResult(details).text(`Window '${id}' closed`).done();
			}

			case "send_message": {
				const id = params.id;
				if (!id) throw new ToolError("send_message action requires 'id'");
				if (!params.payload) throw new ToolError("send_message action requires 'payload'");

				const remote = this.#remoteBridge();
				if (remote) {
					remote.sendMessage(id, params.payload as Record<string, unknown>);
					const details: QmlToolDetails = { action: "send_message", windowId: id };
					return toolResult(details).text(`Message sent to panel '${id}' on Android`).done();
				}

				const bridge = this.#ensureBridge();
				await bridge.sendMessage(id, params.payload as Record<string, unknown>);
				const details: QmlToolDetails = { action: "send_message", windowId: id };
				return toolResult(details).text(`Message sent to '${id}'`).done();
			}

			case "list_windows": {
				const remote = this.#remoteBridge();
				const windows = remote ? remote.listWindows() : this.#bridge ? this.#bridge.listWindows() : [];
				const details: QmlToolDetails = {
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
				const details: QmlToolDetails = { action: "screenshot", windowId: id };
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
		await this.#bridge?.dispose();
		this.#bridge = null;
	}
}
