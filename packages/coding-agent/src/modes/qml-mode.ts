/**
 * QML desktop mode: Launches a Material Design 3 shell with chat panel,
 * forwards agent events to QML, and dispatches QML user actions to the session.
 */
import * as path from "node:path";
import { QmlBridge } from "@oh-my-pi/pi-qml";
import { logger } from "@oh-my-pi/pi-utils";
import { resolveDomainPath, type SpellDomain } from "../domain/loader";
import type { CanvasOrchestratorManager } from "../orchestrators/canvas-orchestrator";
import type { AgentSession, AgentSessionEvent } from "../session/agent-session";
import type { EventBus } from "../utils/event-bus";
import { SessionEventMapper } from "./qml-event-mapper";

export interface QmlPanelConfig {
	id: string;
	title: string;
	icon: string;
	path: string;
	armedTools?: string[];
}

export interface QmlLaunchConfig {
	shellPath: string;
	title: string;
	panels: QmlPanelConfig[];
	workspaces: SpellDomain["workspaces"];
}

export interface QmlModeOptions {
	initialMessage?: string;
	sessionFile?: string;
	eventBus?: EventBus;
	orchestratorManager?: CanvasOrchestratorManager;
	cwd?: string;
	domainManifest?: SpellDomain;
}

export function buildQmlLaunchConfig(
	cwd: string,
	domainManifest?: SpellDomain,
	skillPanels: QmlPanelConfig[] = [],
): QmlLaunchConfig {
	const panels = [...builtinPanels(), ...skillPanels, ...resolveDomainPanels(cwd, domainManifest)];
	const shellPath = domainManifest?.shellQmlPath
		? resolveDomainPath(domainManifest, cwd, domainManifest.shellQmlPath)
		: path.resolve(import.meta.dir, "qml/shell.qml");
	const title =
		domainManifest && domainManifest.name !== "coding" ? `Spell ${toTitleCase(domainManifest.name)}` : "Spell";
	return {
		shellPath,
		title,
		panels,
		workspaces: domainManifest?.workspaces ?? [],
	};
}

export async function runQmlMode(session: AgentSession, options: QmlModeOptions = {}): Promise<void> {
	const bridge = new QmlBridge();
	options.orchestratorManager?.setBridge(bridge);

	const launchConfig = buildQmlLaunchConfig(
		options.cwd ?? process.cwd(),
		options.domainManifest,
		discoverSkillPanels(session),
	);

	await bridge.launch("shell", launchConfig.shellPath, {
		title: launchConfig.title,
		width: 1280,
		height: 800,
		props: { panels: launchConfig.panels, workspaces: launchConfig.workspaces },
	});
	if (options.domainManifest?.workspaces.length) {
		await sendWorkspaceLayout(bridge, options.domainManifest, options.domainManifest.workspaces[0]?.id);
	}

	const mapper = new SessionEventMapper();
	session.subscribe((event: AgentSessionEvent) => {
		const qmlEvent = mapper.map(event);
		if (qmlEvent) {
			bridge.sendMessage("shell", qmlEvent).catch(err => {
				logger.error("Failed to send event to QML", { error: String(err) });
			});
		}
	});

	if (options.initialMessage) {
		await bridge.sendMessage("shell", {
			type: "user_message",
			text: options.initialMessage,
		});
		await session.prompt(options.initialMessage);
	}

	const dashboardInterval = startDashboardUpdater(bridge, session, options);

	await processQmlEvents(session, bridge, options);
	clearInterval(dashboardInterval);
}

/**
 * Event loop: wait for QML user actions and dispatch them to the session.
 * Exits when the shell window closes.
 */
async function processQmlEvents(session: AgentSession, bridge: QmlBridge, options: QmlModeOptions): Promise<void> {
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
				case "workspace_switch":
					if (options.domainManifest && typeof event.payload.workspaceId === "string") {
						await sendWorkspaceLayout(bridge, options.domainManifest, event.payload.workspaceId);
					}
					break;
				case "chat_message":
					if (typeof event.payload.text === "string" && event.payload.text.trim()) {
						await session.prompt(event.payload.text as string);
					}
					break;
				case "restart":
					await restart(session, bridge);
					return;
			}
		}

		const shell = bridge.getWindow("shell");
		if (!shell || shell.state === "closed") {
			break;
		}
	}

	options.orchestratorManager?.setBridge(undefined);
	await bridge.dispose();
}

function builtinPanels(): QmlPanelConfig[] {
	const chatPanelPath = path.resolve(import.meta.dir, "qml/panels/ChatPanel.qml");
	const dashboardPanelPath = path.resolve(import.meta.dir, "qml/panels/DashboardPanel.qml");
	return [
		{ id: "chat", title: "Chat", icon: "●", path: chatPanelPath },
		{ id: "dashboard", title: "Dashboard", icon: "■", path: dashboardPanelPath },
	];
}

function resolveDomainPanels(cwd: string, domainManifest?: SpellDomain): QmlPanelConfig[] {
	if (!domainManifest) {
		return [];
	}
	return domainManifest.panels.map(panel => ({
		id: panel.id,
		title: panel.name,
		icon: panel.icon ?? "",
		path: resolveDomainPath(domainManifest, cwd, panel.qmlPath),
		armedTools: panel.armedTools,
	}));
}

async function sendWorkspaceLayout(
	bridge: QmlBridge,
	domainManifest: SpellDomain,
	workspaceId: string | undefined,
): Promise<void> {
	if (!workspaceId) {
		return;
	}
	const workspace = domainManifest.workspaces.find(candidate => candidate.id === workspaceId);
	if (!workspace) {
		return;
	}
	await bridge.sendMessage("shell", {
		type: "workspace_layout",
		workspaceId: workspace.id,
		panels: workspace.panels,
		defaultMode: workspace.defaultMode ?? null,
		restrictions: workspace.restrictions ?? null,
	});
}

function toTitleCase(value: string): string {
	return value.length === 0 ? value : `${value[0].toUpperCase()}${value.slice(1)}`;
}

/**
 * Discover QML panels from loaded skills.
 * TODO: Skills don't expose qmlPanels yet — returns empty until the Skill interface is extended.
 */
function discoverSkillPanels(_session: AgentSession): QmlPanelConfig[] {
	return [];
}

/**
 * Start periodic dashboard updates sent to the shell.
 * Collects agent status, queue depth, orchestrators, and token count.
 * Returns the interval handle for cleanup.
 */
function startDashboardUpdater(bridge: QmlBridge, session: AgentSession, options: QmlModeOptions): NodeJS.Timeout {
	let lastAgentBusy = false;
	let busySince = 0;
	let tokenCount = 0;

	session.subscribe((event: AgentSessionEvent) => {
		if (event.type === "agent_start") {
			lastAgentBusy = true;
			busySince = Date.now();
		} else if (event.type === "agent_end") {
			lastAgentBusy = false;
		} else if (event.type === "message_end" && event.message) {
			const usage = (event.message as { usage?: { total_tokens?: number } }).usage;
			if (usage?.total_tokens) tokenCount = usage.total_tokens;
		}
	});

	return setInterval(() => {
		const queue = options.eventBus?.depth() ?? { p1: 0, p2: 0, p3: 0 };
		const orchestrators = options.orchestratorManager?.getActive() ?? [];
		const elapsed = lastAgentBusy ? formatElapsed(Date.now() - busySince) : "";

		const payload = {
			type: "dashboard_update",
			agent: {
				status: lastAgentBusy ? "busy" : "idle",
				elapsed,
			},
			queue,
			orchestrators: orchestrators.map(o => ({
				windowId: o.windowId,
				scope: o.scope,
			})),
			windows: bridge
				.listWindows()
				.filter(w => w.id !== "shell")
				.map(w => ({ id: w.id, title: w.id, state: w.state })),
			tokens: tokenCount,
		};

		bridge.sendMessage("shell", payload).catch(() => {});
	}, 1000);
}

function formatElapsed(ms: number): string {
	const seconds = Math.floor(ms / 1000);
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	const remainingSeconds = seconds % 60;
	return `${minutes}m ${remainingSeconds}s`;
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
