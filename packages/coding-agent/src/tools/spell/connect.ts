import type { AgentToolContext } from "@oh-my-pi/pi-agent-core";
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
import { SpellSetupDialog } from "./setup-dialog";

const SPELL_PORT = 9473;
const DEVICE_POLL_INTERVAL_MS = 2_000;
const DEVICE_WAIT_TIMEOUT_MS = 120_000;
const WS_CONNECT_TIMEOUT_MS = 30_000;

/**
 * Wait for an Android device to appear via ADB.
 * Returns the first device seen, or null if the deadline or signal fires first.
 */
async function waitForDevice(
	signal: AbortSignal,
): Promise<{ id: string } | null> {
	const deadline = Date.now() + DEVICE_WAIT_TIMEOUT_MS;
	while (Date.now() < deadline && !signal.aborted) {
		const devices = await getConnectedDevices();
		if (devices.length > 0) return devices[0]!;
		await Bun.sleep(DEVICE_POLL_INTERVAL_MS);
	}
	return null;
}

/**
 * Wait for a WebSocket client to connect to the QmlRemoteServer.
 * Uses the server's "connected" event rather than polling a bridge reference,
 * because `server.bridge` is always non-null (constructed eagerly).
 */
async function waitForConnection(
	server: QmlRemoteServer,
	signal: AbortSignal,
): Promise<boolean> {
	const { promise, resolve } = Promise.withResolvers<boolean>();

	const deadline = Date.now() + WS_CONNECT_TIMEOUT_MS;

	// Listen for the first connection event.
	const removeListener = server.addListener("connected", () => {
		resolve(true);
	});

	// Set a deadline timer — Bun.sleep is not cancellable, so drive it with a
	// recursive polling loop that defers to the event above when it fires.
	const pollDeadline = async (): Promise<void> => {
		while (Date.now() < deadline && !signal.aborted) {
			await Bun.sleep(500);
		}
		resolve(false);
	};
	void pollDeadline();

	const connected = await promise;
	removeListener();
	return connected;
}

/**
 * Core setup flow. Throws ToolError on any failure or cancellation.
 * Caller is responsible for wiring the result into the UI lifecycle.
 */
async function runSetupFlow(
	session: ToolSession,
	dialog: SpellSetupDialog,
): Promise<void> {
	const { signal } = dialog;

	// 1. Check ADB availability
	dialog.showPhase("Checking ADB...");
	if (!isAdbAvailable()) {
		dialog.showError(
			"ADB not found. Install Android SDK Platform Tools and ensure adb is in PATH.",
		);
		await Bun.sleep(3_000);
		throw new ToolError(
			"ADB not found in PATH. Install Android SDK Platform Tools.",
		);
	}
	if (signal.aborted) throw new ToolError("Spell setup cancelled");

	// 2. Wait for device
	dialog.showPhase("Waiting for Android device... (connect via USB)");
	const device = await waitForDevice(signal);
	if (!device) {
		throw new ToolError(
			"No Android device connected (timed out after 120s)",
		);
	}
	if (signal.aborted) throw new ToolError("Spell setup cancelled");

	const deviceId = device.id;
	dialog.showPhase(`Device found: ${deviceId}`);
	await Bun.sleep(500);
	if (signal.aborted) throw new ToolError("Spell setup cancelled");

	// 3. Install Spell if not already present
	const installed = await isSpellInstalled(deviceId);
	if (!installed) {
		dialog.showPhase("Locating Spell APK...");
		const manager = new SpellManager();
		const apkPath = await manager.ensureApk(signal);
		if (signal.aborted) throw new ToolError("Spell setup cancelled");

		dialog.showPhase("Installing Spell...");
		const ok = await installApk(apkPath, deviceId);
		if (!ok) {
			dialog.showError("Failed to install Spell APK.");
			await Bun.sleep(3_000);
			throw new ToolError("adb install failed");
		}
	} else {
		dialog.showPhase("Spell already installed");
		await Bun.sleep(500);
	}
	if (signal.aborted) throw new ToolError("Spell setup cancelled");

	// 4. Port forwarding
	dialog.showPhase("Setting up port forwarding...");
	await setupPortForward(SPELL_PORT, deviceId);
	if (signal.aborted) throw new ToolError("Spell setup cancelled");

	// 5. Start QmlRemoteServer before launching Spell so the server is ready
	//    the moment Spell attempts its first connection.
	dialog.showPhase("Starting connection server...");
	const server = new QmlRemoteServer({ port: SPELL_PORT });
	server.start();

	// 6. Launch Spell
	dialog.showPhase("Launching Spell...");
	await launchSpell(deviceId);
	if (signal.aborted) {
		server.stop();
		throw new ToolError("Spell setup cancelled");
	}

	// 7. Wait for WebSocket connection
	dialog.showPhase("Waiting for Spell to connect...");
	const connected = await waitForConnection(server, signal);
	if (!connected) {
		server.stop();
		dialog.showError("Spell did not connect (timed out after 30s)");
		await Bun.sleep(3_000);
		throw new ToolError("Spell did not connect within 30 seconds");
	}

	// 8. Attach server to session — visible to callers after this function returns
	session.qmlRemoteServer = server;

	// 9. Brief success display before dismissing the dialog
	dialog.showSuccess("Connected!");
	await Bun.sleep(1_000);
}

/**
 * Ensure Spell is installed, reachable, and a QmlRemoteServer is attached to
 * the session. Idempotent — returns immediately if already connected or in
 * headless mode.
 *
 * Throws `ToolError` if setup fails or the user cancels.
 */
export async function ensureSpellConnection(
	session: ToolSession,
	context: AgentToolContext,
): Promise<void> {
	// Already connected — nothing to do.
	if (session.qmlRemoteServer) return;
	// Headless mode — skip; QmlTool falls back to the local bridge.
	if (!context.hasUI) return;

	// Bridge the fire-and-forget UI lifecycle with the async setup outcome.
	const { promise: setupDone, resolve: onSuccess, reject: onFailure } =
		Promise.withResolvers<void>();

	await context.ui.custom((tui, _theme, done) => {
		const dialog = new SpellSetupDialog(tui);

		// Abort signal fires when user presses Escape inside the dialog.
		dialog.signal.addEventListener(
			"abort",
			() => {
				onFailure(new ToolError("Spell setup cancelled"));
				done(null);
			},
			{ once: true },
		);

		void runSetupFlow(session, dialog)
			.then(() => {
				onSuccess();
				done(undefined);
			})
			.catch((err: unknown) => {
				// signal.abort path already handled above; avoid double-rejection.
				if (!dialog.signal.aborted) {
					logger.error("Spell setup failed", { error: err });
					onFailure(err);
					done(null);
				}
			});

		return dialog;
	});

	// Re-throw any ToolError (or unexpected error) from the setup flow.
	await setupDone;
}
