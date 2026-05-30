import * as path from "node:path";
import type { SessionStatusFile } from "@spell/pi-desktop-common";
import type { QmlBridge } from "@spell/pi-qml";
import { logger } from "@spell/pi-utils";
import { $ } from "bun";
import type { MacOSConfig } from "./config";
import { loadConfig } from "./config";
import { focusTerminalByPid } from "./focus-window";
import { OverlayController } from "./overlay-controller";
import { SessionService } from "./session-service";

const DASHBOARD_ID = "__macos_dashboard__";
const DASHBOARD_QML = path.join(import.meta.dir, "../qml/SessionDashboard.qml");

export class MacOSIntegration {
	#bridge: QmlBridge;
	#sessionService: SessionService;
	#overlay: OverlayController;
	#config: MacOSConfig | null = null;
	#dashboardOpen = false;
	#disposeHotkeyListener: (() => void) | null = null;
	#disposeSystrayActivatedListener: (() => void) | null = null;
	#disposeSystrayClickListener: (() => void) | null = null;
	#notifiedSessions = new Set<string>();

	constructor(bridge: QmlBridge) {
		this.#bridge = bridge;
		this.#sessionService = new SessionService();
		this.#overlay = new OverlayController(bridge, this.#sessionService);
	}

	get sessionService(): SessionService {
		return this.#sessionService;
	}

	async start(): Promise<void> {
		this.#config = await loadConfig();
		this.#sessionService.onTransition((session, previousStatus) => {
			this.#handleTransition(session, previousStatus);
		});
		this.#sessionService.onUpdate(sessions => {
			void this.#handleSessionsUpdated(sessions);
		});
		this.#sessionService.start();

		await this.#bridge.createSystray({ tooltip: "Spell" });
		await this.#updateSystray(this.#sessionService.sessions);
		this.#disposeSystrayActivatedListener = this.#bridge.onSystrayActivated(() => {
			void this.toggleDashboard();
		});
		this.#disposeSystrayClickListener = this.#bridge.onSystrayClick(itemId => {
			if (itemId === "toggle-dashboard") void this.toggleDashboard();
			if (itemId === "toggle-overview") void this.#overlay.toggle();
		});

		const { key, modifiers } = this.#config.overviewHotkey;
		await this.#bridge.registerHotkey("overview", key, modifiers);
		this.#disposeHotkeyListener = this.#bridge.onHotkeyTriggered(hotkeyId => {
			if (hotkeyId === "overview") {
				void this.#overlay.toggle();
			}
		});

		logger.debug("MacOSIntegration: started");
	}

	async stop(): Promise<void> {
		this.#sessionService.stop();
		this.#disposeHotkeyListener?.();
		this.#disposeSystrayActivatedListener?.();
		this.#disposeSystrayClickListener?.();
		try {
			await this.#bridge.unregisterHotkey("overview");
		} catch (error) {
			logger.debug("MacOSIntegration: unregister hotkey failed", { err: String(error) });
		}
		if (this.#dashboardOpen) {
			try {
				await this.#bridge.close(DASHBOARD_ID);
			} catch (error) {
				logger.debug("MacOSIntegration: close dashboard failed", { err: String(error) });
			}
		}
		await this.#overlay.hide();
		try {
			await this.#bridge.destroySystray();
		} catch (error) {
			logger.debug("MacOSIntegration: destroy systray failed", { err: String(error) });
		}
		logger.debug("MacOSIntegration: stopped");
	}

	async toggleDashboard(): Promise<void> {
		if (this.#dashboardOpen) {
			try {
				await this.#bridge.close(DASHBOARD_ID);
			} catch (error) {
				logger.debug("MacOSIntegration: close dashboard failed", { err: String(error) });
			}
			this.#dashboardOpen = false;
			return;
		}

		await this.#bridge.launch(DASHBOARD_ID, DASHBOARD_QML, {
			title: "Spell Sessions",
			width: 360,
			height: 420,
			props: { sessions: this.#sessionService.sessions, overviewHotkeyLabel: this.#overviewHotkeyLabel() },
			watch: false,
		});
		this.#dashboardOpen = true;
		void this.#dashboardEventLoop();
	}

	async #dashboardEventLoop(): Promise<void> {
		while (this.#dashboardOpen) {
			const events = await this.#bridge.waitForEvent(DASHBOARD_ID, 30_000);
			for (const event of events) {
				const action = event.payload?.action;
				if (action === "focus_session") {
					const pid = event.payload.pid;
					if (typeof pid === "number") {
						await focusTerminalByPid(pid);
					}
				}
			}
			const window = this.#bridge.getWindow(DASHBOARD_ID);
			if (!window || window.state === "closed") {
				this.#dashboardOpen = false;
				break;
			}
		}
	}

	async #handleSessionsUpdated(sessions: readonly SessionStatusFile[]): Promise<void> {
		await this.#updateSystray(sessions);
		if (this.#dashboardOpen) {
			try {
				await this.#bridge.sendMessage(DASHBOARD_ID, {
					action: "update_sessions",
					sessions,
					overviewHotkeyLabel: this.#overviewHotkeyLabel(),
				});
			} catch (error) {
				logger.debug("MacOSIntegration: dashboard update failed", { err: String(error) });
			}
		}
		await this.#overlay.pushUpdate();
	}

	async #updateSystray(sessions: readonly SessionStatusFile[]): Promise<void> {
		const attentionCount = sessions.filter(
			session => session.status === "needs_input" || session.status === "pending_approval",
		).length;
		const tooltip =
			sessions.length === 0
				? "Spell"
				: `${sessions.length} sessions${attentionCount > 0 ? ` (${attentionCount} need attention)` : ""}`;
		await this.#bridge.createSystray({ tooltip });
		await this.#bridge.updateSystrayMenu([
			{ id: "toggle-dashboard", label: this.#dashboardOpen ? "Hide Sessions" : "Show Sessions" },
			{ id: "toggle-overview", label: `Toggle Overview (${this.#overviewHotkeyLabel()})` },
			{ id: "separator-1", label: "", separator: true },
			...sessions.slice(0, 8).map(session => ({
				id: `session-${session.windowId}`,
				label: `${session.projectName}: ${this.#statusLabel(session.status)}`,
				enabled: false,
			})),
		]);
	}

	#statusLabel(status: SessionStatusFile["status"]): string {
		return status
			.split("_")
			.map(part => part.charAt(0).toUpperCase() + part.slice(1))
			.join(" ");
	}

	#overviewHotkeyLabel(): string {
		const hotkey = this.#config?.overviewHotkey;
		if (!hotkey) return "Cmd+Opt+O";
		const modifiers = hotkey.modifiers.map(modifier => {
			if (modifier === "cmd") return "Cmd";
			if (modifier === "alt") return "Opt";
			return modifier.charAt(0).toUpperCase() + modifier.slice(1);
		});
		return [...modifiers, hotkey.key.toUpperCase()].join("+");
	}

	#handleTransition(session: SessionStatusFile, _previousStatus: string | null): void {
		if (session.status !== "needs_input" && session.status !== "pending_approval") return;
		const key = `${session.windowId}:${session.status}`;
		if (this.#notifiedSessions.has(key)) return;
		this.#notifiedSessions.add(key);
		const title = session.status === "needs_input" ? "Input Needed" : "Approval Pending";
		const body = `${session.projectName}: ${session.sessionTitle || "Session"}`;
		void this.#sendNotification(title, body);
	}

	async #sendNotification(title: string, body: string): Promise<void> {
		if (process.platform !== "darwin") return;
		await $`osascript -e 'display notification "${body}" with title "${title}"'`.quiet().nothrow();
	}
}
