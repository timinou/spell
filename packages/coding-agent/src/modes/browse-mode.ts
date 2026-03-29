import * as path from "node:path";
import { QmlBridge } from "@oh-my-pi/pi-qml";
import { logger } from "@oh-my-pi/pi-utils";
import type { CanvasOrchestratorManager } from "../orchestrators/canvas-orchestrator";
import type { AgentSession, AgentSessionEvent } from "../session/agent-session";
import type { EventBus } from "../utils/event-bus";
import { BrowseEventMapper } from "./browse-event-mapper";
import { createFindingTabId } from "./browse-findings";

export interface BrowseModeOptions {
	initialMessage?: string;
	sessionFile?: string;
	eventBus?: EventBus;
	orchestratorManager?: CanvasOrchestratorManager;
}

function createBrowseSettingsCategory(sessionFile: string | undefined): string {
	if (!sessionFile) return "SpellBrowse";
	return `SpellBrowse-${Bun.hash(sessionFile).toString(16)}`;
}

export async function runBrowseMode(session: AgentSession, options: BrowseModeOptions = {}): Promise<void> {
	const bridge = new QmlBridge();
	options.orchestratorManager?.setBridge(bridge);

	const shellPath = path.resolve(import.meta.dir, "qml/BrowseShell.qml");
	const modelLabel = session.model ? `${session.model.provider}/${session.model.id}` : "";

	await bridge.launch("browse-shell", shellPath, {
		title: "Spell - Browse",
		width: 1360,
		height: 900,
		props: {
			model: modelLabel,
			settingsCategory: createBrowseSettingsCategory(options.sessionFile),
		},
	});

	const mapper = new BrowseEventMapper();
	session.subscribe((event: AgentSessionEvent) => {
		const qmlEvent = mapper.map(event);
		if (qmlEvent) {
			bridge.sendMessage("browse-shell", qmlEvent).catch(err => {
				logger.error("Failed to send browse event to QML", { error: String(err) });
			});
		}
	});

	if (options.initialMessage) {
		await bridge.sendMessage("browse-shell", {
			type: "user_message",
			text: options.initialMessage,
		});
		await session.prompt(options.initialMessage);
	}

	const dashboardInterval = startDashboardUpdater(bridge, session, options);
	await processBrowseEvents(session, bridge, options.orchestratorManager);
	clearInterval(dashboardInterval);
}

async function processBrowseEvents(
	session: AgentSession,
	bridge: QmlBridge,
	orchestratorManager?: CanvasOrchestratorManager,
): Promise<void> {
	while (true) {
		const events = await bridge.waitForEvent("browse-shell", 600_000);
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
				case "view_in_tab": {
					const payload = event.payload as { tabId?: string; url?: string; title?: string };
					const tabId =
						typeof payload.tabId === "string" && payload.tabId.length > 0 ? payload.tabId : createFindingTabId();
					await bridge.sendMessage("browse-shell", {
						action: "tab:open",
						tabId,
						url: typeof payload.url === "string" && payload.url.length > 0 ? payload.url : "about:blank",
						title:
							typeof payload.title === "string" && payload.title.length > 0 ? payload.title : "Research source",
					});
					break;
				}
				case "restart":
					await restart(session, bridge);
					return;
			}
		}

		const shell = bridge.getWindow("browse-shell");
		if (!shell || shell.state === "closed") {
			break;
		}
	}

	orchestratorManager?.setBridge(undefined);
	await bridge.dispose();
}

function startDashboardUpdater(bridge: QmlBridge, session: AgentSession, options: BrowseModeOptions): NodeJS.Timeout {
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
			orchestrators: orchestrators.map(orchestrator => ({
				windowId: orchestrator.windowId,
				scope: orchestrator.scope,
			})),
			windows: bridge
				.listWindows()
				.filter(windowInfo => windowInfo.id !== "browse-shell")
				.map(windowInfo => ({ id: windowInfo.id, title: windowInfo.id, state: windowInfo.state })),
			tokens: tokenCount,
		};

		bridge.sendMessage("browse-shell", payload).catch(() => {});
	}, 1000);
}

function formatElapsed(ms: number): string {
	const seconds = Math.floor(ms / 1000);
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	const remainingSeconds = seconds % 60;
	return `${minutes}m ${remainingSeconds}s`;
}

async function restart(session: AgentSession, bridge: QmlBridge): Promise<never> {
	const sessionFile = session.sessionManager.getSessionFile();
	await bridge.dispose();
	await session.dispose();

	const rawArgs = process.argv.slice(1);
	const cleanArgs: string[] = [];
	for (let i = 0; i < rawArgs.length; i++) {
		const arg = rawArgs[i];
		if (arg === "--resume" || arg === "-r" || arg === "--session") {
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
