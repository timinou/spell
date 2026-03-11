import * as path from "node:path";
import type { AgentTool, AgentToolContext, AgentToolResult, AgentToolUpdateCallback } from "@oh-my-pi/pi-agent-core";
import type { WindowInfo } from "@oh-my-pi/pi-qml";
import { bridgeBinaryPath, isBridgeAvailable, QmlBridge } from "@oh-my-pi/pi-qml";
import type { RemoteQmlBridge } from "@oh-my-pi/pi-qml-remote";

import { type Static, Type } from "@sinclair/typebox";
import qmlDescription from "../prompts/tools/qml.md" with { type: "text" };
import type { ToolSession } from ".";
import type { OutputMeta } from "./output-meta";
import { ToolError } from "./tool-errors";
import { toolResult } from "./tool-result";

const qmlSchema = Type.Object({
	action: Type.Union(
		[
			Type.Literal("write"),
			Type.Literal("launch"),
			Type.Literal("close"),
			Type.Literal("send_message"),
			Type.Literal("listen"),
			Type.Literal("list_windows"),
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
	// listen: no extra fields needed
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

export class QmlTool implements AgentTool<typeof qmlSchema, QmlToolDetails> {
	readonly name = "qml";
	readonly label = "QML";
	readonly description = qmlDescription;
	readonly parameters = qmlSchema;
	readonly strict = false;

	#bridge: QmlBridge | null = null;

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
					`omp-qml-bridge binary not found at ${bridgeBinaryPath()}.\nBuild it first: cd packages/qml && bun run build:bridge`,
				);
			}
			this.#bridge = new QmlBridge();
		}
		return this.#bridge;
	}

	async execute(
		_toolCallId: string,
		params: QmlToolInput,
		_signal?: AbortSignal,
		_onUpdate?: AgentToolUpdateCallback<QmlToolDetails>,
		_context?: AgentToolContext,
	): Promise<AgentToolResult<QmlToolDetails>> {
		const { action } = params;

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
				const details: QmlToolDetails = { action: "launch", windowId: id, events };
				const text = `Window '${id}' launched (state: ${win.state})${events.length ? `\n${events.length} event(s) received` : ""}`;
				return toolResult(details).text(text).done();
			}

			case "close": {
				const id = params.id;
				if (!id) throw new ToolError("close action requires 'id'");

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

			case "listen": {
				const id = params.id;
				if (!id) throw new ToolError("listen action requires 'id'");

				let events: WindowInfo["events"];
				let win: WindowInfo | undefined;

				const remote = this.#remoteBridge();
				if (remote) {
					events = await remote.waitForEvent(id);
					win = remote.getWindow(id);
				} else {
					const bridge = this.#ensureBridge();
					// Push-based: resolves immediately when any event arrives, no polling.
					events = await bridge.waitForEvent(id);
					win = bridge.getWindow(id);
				}

				const details: QmlToolDetails = { action: "listen", windowId: id, events };
				const closed =
					win?.state === "closed" || events.some(e => (e.payload as { action?: string }).action === "close");
				const lines: string[] = [];
				if (events.length === 0) {
					lines.push(`Listen timeout on '${id}' — window ${win?.state ?? "unknown"}`);
				} else {
					lines.push(`${events.length} event(s) from '${id}'${closed ? " [closed]" : ""}:`);
					for (const e of events) {
						lines.push(JSON.stringify(e.payload));
					}
				}
				return toolResult(details).text(lines.join("\n")).done();
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

			default:
				throw new ToolError(`Unknown action: ${action as string}`);
		}
	}

	async dispose(): Promise<void> {
		await this.#bridge?.dispose();
		this.#bridge = null;
	}
}
