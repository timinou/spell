import type { AgentToolContext } from "@oh-my-pi/pi-agent-core";
import { isBridgeAvailable, QmlBridge } from "@oh-my-pi/pi-qml";
import { QmlRemoteServer } from "@oh-my-pi/pi-qml-remote";
import { logger } from "@oh-my-pi/pi-utils";
import type { ToolSession } from "..";
import { ToolError } from "../tool-errors";
import {
	getConnectedDevices,
	installApk,
	isAdbAvailable,
	isSpellInstalled,
	launchSpell,
	setupPortForward,
} from "./adb";
import { SpellManager } from "./manager";
import setupQml from "./setup.qml" with { type: "text" };
import { SpellSetupDialog } from "./setup-dialog";

const SPELL_PORT = 9473;
const DEVICE_POLL_INTERVAL_MS = 2_000;
const DEVICE_WAIT_TIMEOUT_MS = 120_000;
const WS_CONNECT_TIMEOUT_MS = 30_000;
const SETUP_QML_PATH = "/tmp/omp-qml/spell-setup.qml";

// ── display abstraction ───────────────────────────────────────────────────────

/** Common interface for the onboarding UI — QML window or TUI dialog. */
interface SetupDisplay {
	readonly signal: AbortSignal;
	showPhase(text: string): void;
	showDevice(name: string): void;
	showSuccess(text: string): void;
	showError(text: string): void;
}

// ── QML window display ────────────────────────────────────────────────────────

/**
 * Desktop QML window display. Launches setup.qml via QmlBridge and drives it
 * with bridge messages. Cancel button / Escape in the window aborts the signal.
 */
class QmlSetupDisplay implements SetupDisplay {
	#bridge: QmlBridge;
	#ac = new AbortController();
	readonly signal = this.#ac.signal;

	constructor(bridge: QmlBridge) {
		this.#bridge = bridge;
	}

	/** Write the QML file and launch the window. */
	async launch(): Promise<void> {
		await Bun.write(SETUP_QML_PATH, setupQml);
		await this.#bridge.launch("spell-setup", SETUP_QML_PATH, {
			title: "Spell",
			width: 460,
			height: 240,
		});
		this.#watchCancel();
	}

	/**
	 * Background event loop: resolve the abort controller if the user clicks
	 * Cancel / presses Escape, or closes the window.
	 */
	#watchCancel(): void {
		void (async () => {
			while (!this.#ac.signal.aborted) {
				try {
					const events = await this.#bridge.waitForEvent("spell-setup", 5_000);
					const cancelled = events.some(e => (e.payload as { action?: string }).action === "cancel");
					const closed =
						this.#bridge.getWindow("spell-setup")?.state === "closed" ||
						events.some(e => (e.payload as { action?: string }).action === "close");
					if (cancelled || closed) {
						this.#ac.abort();
						break;
					}
				} catch {
					// timeout or bridge gone — stop watching
					break;
				}
			}
		})();
	}

	showPhase(text: string): void {
		this.#send({ type: "phase", text });
	}

	showDevice(name: string): void {
		this.#send({ type: "device", name });
	}

	showSuccess(text: string): void {
		this.#send({ type: "success", text });
	}

	showError(text: string): void {
		this.#send({ type: "error", text });
	}

	#send(payload: Record<string, unknown>): void {
		try {
			void this.#bridge.sendMessage("spell-setup", payload);
		} catch {
			// window already closed — ignore
		}
	}

	async dispose(): Promise<void> {
		this.#ac.abort();
		this.#send({ type: "close" });
		try {
			await this.#bridge.close("spell-setup");
		} catch {
			// already closed
		}
		await this.#bridge.dispose();
	}
}

// ── TUI dialog display ────────────────────────────────────────────────────────

/** Thin adapter so SpellSetupDialog satisfies SetupDisplay. */
class TuiSetupDisplay implements SetupDisplay {
	readonly signal: AbortSignal;
	#dialog: SpellSetupDialog;

	constructor(dialog: SpellSetupDialog) {
		this.#dialog = dialog;
		this.signal = dialog.signal;
	}

	showPhase(text: string): void {
		this.#dialog.showPhase(text);
	}

	showDevice(name: string): void {
		// In TUI mode the device name is already embedded in the phase text;
		// update the phase to show it as part of the next phase message.
		this.#dialog.showPhase(`Device found: ${name}`);
	}

	showSuccess(text: string): void {
		this.#dialog.showSuccess(text);
	}

	showError(text: string): void {
		this.#dialog.showError(text);
	}
}

// ── shared helpers ────────────────────────────────────────────────────────────

async function waitForDevice(signal: AbortSignal): Promise<{ id: string } | null> {
	const deadline = Date.now() + DEVICE_WAIT_TIMEOUT_MS;
	while (Date.now() < deadline && !signal.aborted) {
		const devices = await getConnectedDevices();
		if (devices.length > 0) return devices[0]!;
		await Bun.sleep(DEVICE_POLL_INTERVAL_MS);
	}
	return null;
}

async function waitForConnection(server: QmlRemoteServer, signal: AbortSignal): Promise<boolean> {
	const { promise, resolve } = Promise.withResolvers<boolean>();
	const deadline = Date.now() + WS_CONNECT_TIMEOUT_MS;

	const removeListener = server.addListener("connected", () => resolve(true));

	void (async () => {
		while (Date.now() < deadline && !signal.aborted) {
			await Bun.sleep(500);
		}
		resolve(false);
	})();

	const connected = await promise;
	removeListener();
	return connected;
}

// ── core setup flow ───────────────────────────────────────────────────────────

/**
 * Runs the full onboarding sequence. Throws ToolError on any failure or
 * cancellation. Display-agnostic — works with both QML and TUI surfaces.
 */
async function runSetupFlow(session: ToolSession, display: SetupDisplay): Promise<void> {
	const { signal } = display;

	// 1. ADB availability
	display.showPhase("Checking ADB...");
	if (!isAdbAvailable()) {
		display.showError("ADB not found. Install Android SDK Platform Tools and add adb to PATH.");
		await Bun.sleep(3_000);
		throw new ToolError("ADB not found in PATH. Install Android SDK Platform Tools.");
	}
	if (signal.aborted) throw new ToolError("Spell setup cancelled");

	// 2. Wait for device (shows immediately so the user sees the prompt)
	display.showPhase("Connect your Android phone via USB...");
	const device = await waitForDevice(signal);
	if (signal.aborted) throw new ToolError("Spell setup cancelled");
	if (!device) {
		throw new ToolError("No Android device connected (timed out after 120s)");
	}

	const deviceId = device.id;
	display.showDevice(deviceId);
	display.showPhase(`Device found: ${deviceId}`);
	await Bun.sleep(400);
	if (signal.aborted) throw new ToolError("Spell setup cancelled");

	// 3. Install Spell if not already present
	const installed = await isSpellInstalled(deviceId);
	if (!installed) {
		display.showPhase("Locating Spell APK...");
		const manager = new SpellManager();
		const apkPath = await manager.ensureApk(signal);
		if (signal.aborted) throw new ToolError("Spell setup cancelled");

		display.showPhase("Installing Spell...");
		const ok = await installApk(apkPath, deviceId);
		if (!ok) {
			display.showError("Failed to install Spell APK.");
			await Bun.sleep(3_000);
			throw new ToolError("adb install failed");
		}
	} else {
		display.showPhase("Spell already installed");
		await Bun.sleep(400);
	}
	if (signal.aborted) throw new ToolError("Spell setup cancelled");

	// 4. Port forwarding
	display.showPhase("Setting up port forwarding...");
	await setupPortForward(SPELL_PORT, deviceId);
	if (signal.aborted) throw new ToolError("Spell setup cancelled");

	// 5. Start QmlRemoteServer before launching so it's ready for the first connect
	display.showPhase("Starting connection server...");
	const server = new QmlRemoteServer({ port: SPELL_PORT });
	server.start();

	// 6. Launch Spell
	display.showPhase("Launching Spell...");
	await launchSpell(deviceId);
	if (signal.aborted) {
		server.stop();
		throw new ToolError("Spell setup cancelled");
	}

	// 7. Wait for WebSocket connection
	display.showPhase("Waiting for Spell to connect...");
	const connected = await waitForConnection(server, signal);
	if (!connected) {
		server.stop();
		display.showError("Spell did not connect (timed out after 30s)");
		await Bun.sleep(3_000);
		throw new ToolError("Spell did not connect within 30 seconds");
	}

	// 8. Attach to session
	session.qmlRemoteServer = server;

	// 9. Brief success moment before the caller tears down the display
	display.showSuccess("Connected!");
	await Bun.sleep(1_000);
}

// ── QML path ──────────────────────────────────────────────────────────────────

async function runWithQmlDisplay(session: ToolSession): Promise<void> {
	const bridge = new QmlBridge();
	const display = new QmlSetupDisplay(bridge);

	try {
		await display.launch();
		await runSetupFlow(session, display);
	} finally {
		await display.dispose();
	}
}

// ── TUI path ──────────────────────────────────────────────────────────────────

async function runWithTuiDisplay(session: ToolSession, ui: NonNullable<AgentToolContext["ui"]>): Promise<void> {
	const { promise: setupDone, resolve: onSuccess, reject: onFailure } = Promise.withResolvers<void>();

	await ui.custom((_tui, _theme, _kb, done) => {
		const dialog = new SpellSetupDialog(_tui);
		const display = new TuiSetupDisplay(dialog);

		// Escape in dialog → abort
		dialog.signal.addEventListener(
			"abort",
			() => {
				onFailure(new ToolError("Spell setup cancelled"));
				done(null);
			},
			{ once: true },
		);

		void runSetupFlow(session, display)
			.then(() => {
				onSuccess();
				done(undefined);
			})
			.catch((err: unknown) => {
				if (!dialog.signal.aborted) {
					logger.error("Spell setup failed", { error: err });
					onFailure(err);
					done(null);
				}
			});

		return dialog;
	});

	await setupDone;
}

// ── public API ────────────────────────────────────────────────────────────────

/**
 * Ensure Spell is installed, reachable, and a QmlRemoteServer is attached to
 * the session. Idempotent — returns immediately if already connected.
 *
 * Display strategy (first that applies):
 *   1. Desktop QML window  — when omp-qml-bridge is available
 *   2. TUI modal           — when a TUI context is present but no bridge
 *   3. Headless skip       — no UI at all; QmlTool falls back to local bridge
 *
 * Throws `ToolError` if setup fails or the user cancels.
 */
export async function ensureSpellConnection(session: ToolSession, context: AgentToolContext): Promise<void> {
	if (session.qmlRemoteServer) return;

	if (isBridgeAvailable()) {
		await runWithQmlDisplay(session);
		return;
	}

	if (context.hasUI && context.ui) {
		await runWithTuiDisplay(session, context.ui);
		return;
	}

	// Headless — nothing to display; QmlTool falls back to local bridge.
}
