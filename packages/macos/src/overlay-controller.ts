import * as path from "node:path";
import type { SessionStatusFile } from "@oh-my-pi/pi-desktop-common";
import type { QmlBridge } from "@oh-my-pi/pi-qml";
import { logger } from "@oh-my-pi/pi-utils";
import type { SessionService } from "./session-service";

const OVERLAY_ID = "__macos_overlay__";
const OVERLAY_QML = path.join(import.meta.dir, "../qml/OverviewOverlay.qml");

interface OverlaySessionView {
	status: SessionStatusFile["status"];
	projectName: string;
	sessionTitle: string;
	pid: number;
	windowId: number | string;
	updatedAt: number;
}

export class OverlayController {
	#bridge: QmlBridge;
	#sessionService: SessionService;
	#isOpen = false;
	#isToggling = false;

	constructor(bridge: QmlBridge, sessionService: SessionService) {
		this.#bridge = bridge;
		this.#sessionService = sessionService;
	}

	get isOpen(): boolean {
		return this.#isOpen;
	}

	async toggle(): Promise<void> {
		if (this.#isToggling) return;
		this.#isToggling = true;
		try {
			if (this.#isOpen) {
				await this.hide();
			} else {
				await this.show();
			}
		} finally {
			this.#isToggling = false;
		}
	}

	async show(): Promise<void> {
		if (this.#isOpen) {
			await this.pushUpdate();
			return;
		}
		await this.#bridge.launch(OVERLAY_ID, OVERLAY_QML, {
			title: "Spell Overview",
			width: 1280,
			height: 900,
			props: { sessions: this.#buildSessionViews() },
			watch: false,
		});
		this.#isOpen = true;
		void this.#eventLoop();
	}

	async hide(): Promise<void> {
		if (!this.#isOpen) return;
		try {
			await this.#bridge.close(OVERLAY_ID);
		} catch (error) {
			logger.debug("OverlayController: close failed", { err: String(error) });
		} finally {
			this.#isOpen = false;
		}
	}

	async pushUpdate(): Promise<void> {
		if (!this.#isOpen) return;
		try {
			await this.#bridge.sendMessage(OVERLAY_ID, {
				action: "update_sessions",
				sessions: this.#buildSessionViews(),
			});
		} catch (error) {
			logger.debug("OverlayController: update failed", { err: String(error) });
		}
	}

	#buildSessionViews(): OverlaySessionView[] {
		return this.#sessionService.sessions.map(session => ({
			status: session.status,
			projectName: session.projectName,
			sessionTitle: session.sessionTitle,
			pid: session.pid,
			windowId: session.windowId,
			updatedAt: session.updatedAt,
		}));
	}

	async #eventLoop(): Promise<void> {
		while (this.#isOpen) {
			await this.#bridge.waitForEvent(OVERLAY_ID, 30_000);
			const window = this.#bridge.getWindow(OVERLAY_ID);
			if (!window || window.state === "closed") {
				this.#isOpen = false;
				break;
			}
		}
	}
}
