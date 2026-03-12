/**
 * QML desktop mode: Launches a Material Design 3 shell with chat panel,
 * forwards agent events to QML, and dispatches QML user actions to the session.
 */
import * as path from "node:path";
import { QmlBridge } from "@oh-my-pi/pi-qml";
import { logger } from "@oh-my-pi/pi-utils";
import type { AgentSession, AgentSessionEvent } from "../session/agent-session";

export interface QmlModeOptions {
	initialMessage?: string;
	sessionFile?: string;
}

export async function runQmlMode(session: AgentSession, options: QmlModeOptions = {}): Promise<void> {
	const bridge = new QmlBridge();

	// Discover skill QML panels (if any skills expose them)
	const panels = discoverSkillPanels(session);

	// Build panel list with Chat always first
	const shellPath = path.resolve(import.meta.dir, "qml/shell.qml");
	const chatPanelPath = path.resolve(import.meta.dir, "qml/panels/ChatPanel.qml");
	const allPanels = [{ id: "chat", title: "Chat", path: chatPanelPath }, ...panels];

	await bridge.launch("shell", shellPath, {
		title: "Spell",
		width: 1280,
		height: 800,
		props: { panels: allPanels },
	});

	// Forward agent events to QML
	session.subscribe((event: AgentSessionEvent) => {
		const qmlEvent = mapSessionEvent(event);
		if (qmlEvent) {
			bridge.sendMessage("shell", qmlEvent).catch(err => {
				logger.error("Failed to send event to QML", { error: String(err) });
			});
		}
	});

	// Send initial message if provided
	if (options.initialMessage) {
		await session.prompt(options.initialMessage);
	}

	await processQmlEvents(session, bridge);
}

/**
 * Event loop: wait for QML user actions and dispatch them to the session.
 * Exits when the shell window closes.
 */
async function processQmlEvents(session: AgentSession, bridge: QmlBridge): Promise<void> {
	while (true) {
		const events = await bridge.waitForEvent("shell", 600_000);
		for (const event of events) {
			if (!event.payload) continue;
			const { type } = event.payload as { type?: string };

			switch (type) {
				case "prompt":
					await session.prompt(event.payload.text as string);
					break;
				case "abort":
					await session.abort();
					break;
				case "steer":
					await session.steer(event.payload.text as string);
					break;
				case "restart":
					await restart(session, bridge);
					return;
			}
		}

		// Check if shell was closed
		const shell = bridge.getWindow("shell");
		if (!shell || shell.state === "closed") {
			break;
		}
	}

	await bridge.dispose();
}

/**
 * Map an AgentSessionEvent to a simplified payload for the QML shell.
 * Returns null for event types the QML UI doesn't need.
 */
function mapSessionEvent(event: AgentSessionEvent): Record<string, unknown> | null {
	switch (event.type) {
		case "message_start":
			return { type: "message_start", role: getRoleIfPresent(event.message) };
		case "message_update": {
			const msg = event.message;
			if (!hasContent(msg)) return null;
			return {
				type: "message_update",
				role: msg.role,
				text: getMessageText(msg.content),
				thinking: getThinkingText(msg.content),
			};
		}
		case "message_end":
			return { type: "message_end", role: getRoleIfPresent(event.message) };
		case "tool_execution_start":
			return {
				type: "tool_start",
				toolCallId: event.toolCallId,
				toolName: event.toolName,
				intent: event.intent,
			};
		case "tool_execution_update":
			return {
				type: "tool_update",
				toolCallId: event.toolCallId,
				toolName: event.toolName,
			};
		case "tool_execution_end":
			return {
				type: "tool_end",
				toolCallId: event.toolCallId,
				toolName: event.toolName,
				isError: event.isError,
			};
		case "agent_start":
			return { type: "agent_busy", busy: true };
		case "agent_end":
			return { type: "agent_busy", busy: false };
		default:
			return null;
	}
}

/** Narrow to messages that carry a standard content array (excludes custom messages like BashExecutionMessage). */
function hasContent(msg: unknown): msg is { role: string; content: ReadonlyArray<{ type: string }> } {
	return (
		typeof msg === "object" &&
		msg !== null &&
		"content" in msg &&
		Array.isArray((msg as Record<string, unknown>).content)
	);
}

function getRoleIfPresent(msg: unknown): string | undefined {
	if (typeof msg === "object" && msg !== null && "role" in msg) {
		return (msg as { role: string }).role;
	}
	return undefined;
}

/** Extract concatenated text content from a message's content array. */
function getMessageText(content: ReadonlyArray<{ type: string; text?: string }>): string {
	return content
		.filter((c): c is { type: "text"; text: string } => c.type === "text" && typeof c.text === "string")
		.map(c => c.text)
		.join("");
}

/** Extract concatenated thinking content from a message's content array. */
function getThinkingText(content: ReadonlyArray<{ type: string; thinking?: string }>): string {
	return content
		.filter(
			(c): c is { type: "thinking"; thinking: string } => c.type === "thinking" && typeof c.thinking === "string",
		)
		.map(c => c.thinking)
		.join("");
}

/**
 * Discover QML panels from loaded skills.
 * TODO: Skills don't expose qmlPanels yet — returns empty until the Skill interface is extended.
 */
function discoverSkillPanels(_session: AgentSession): Array<{ id: string; title: string; path: string }> {
	return [];
}

/**
 * Restart the process: dispose the session, re-exec with --resume pointing
 * at the current session file so the QML shell reconnects.
 */
async function restart(session: AgentSession, bridge: QmlBridge): Promise<never> {
	const sessionFile = session.sessionManager.getSessionFile();
	await bridge.dispose();
	await session.dispose();

	// Strip existing --resume / --session flags and their values, then re-add --resume
	const rawArgs = process.argv.slice(1);
	const cleanArgs: string[] = [];
	for (let i = 0; i < rawArgs.length; i++) {
		const arg = rawArgs[i];
		if (arg === "--resume" || arg === "-r" || arg === "--session") {
			// Skip the flag and its value (if next arg isn't another flag)
			if (i + 1 < rawArgs.length && !rawArgs[i + 1].startsWith("-")) {
				i++;
			}
			continue;
		}
		cleanArgs.push(arg);
	}
	if (sessionFile) {
		cleanArgs.push("--resume", sessionFile);
	}

	const proc = Bun.spawn([process.argv[0], ...cleanArgs], {
		stdio: ["inherit", "inherit", "inherit"],
		env: process.env,
	});
	process.exit(await proc.exited);
}
