/**
 * QML desktop mode: Launches a Material Design 3 shell with chat panel,
 * forwards agent events to QML, and dispatches QML user actions to the session.
 */
import * as path from "node:path";
import { QmlBridge } from "@oh-my-pi/pi-qml";
import { logger } from "@oh-my-pi/pi-utils";
import type { AgentSession, AgentSessionEvent } from "../session/agent-session";
import { SessionEventMapper } from "./qml-event-mapper";

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
	const mapper = new SessionEventMapper();
	session.subscribe((event: AgentSessionEvent) => {
		const qmlEvent = mapper.map(event);
		if (qmlEvent) {
			bridge.sendMessage("shell", qmlEvent).catch(err => {
				logger.error("Failed to send event to QML", { error: String(err) });
			});
		}
	});

	// Send initial message if provided — emit a user bubble so the prompt is visible,
	// then forward it to the session.
	if (options.initialMessage) {
		await bridge.sendMessage("shell", {
			type: "user_message",
			text: options.initialMessage,
		});
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
