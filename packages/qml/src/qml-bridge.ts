import { logger } from "@oh-my-pi/pi-utils";
import type { BridgeEvent, WindowInfo, WindowState } from "./protocol";
import { QmlProcess } from "./qml-process";
import { QmlWatcher } from "./watcher";

export interface LaunchOptions {
	title?: string;
	width?: number;
	height?: number;
	props?: Record<string, unknown>;
	/** Enable hot-reload when the QML file changes on disk (default: true) */
	watch?: boolean;
}

/**
 * High-level manager for QML windows.
 * Maintains one bridge process and one watcher per QmlBridge instance.
 * Intended to be held per tool-session and disposed when the session ends.
 */
export class QmlBridge {
	readonly #process = new QmlProcess();
	readonly #watcher = new QmlWatcher();
	readonly #windows = new Map<string, WindowInfo>();
	#removeListener: (() => void) | null = null;
	#reconnected = false;

	constructor() {
		// Register event listener immediately — process may not be up yet
		this.#removeListener = this.#process.addListener(event => this.#handleEvent(event));
	}

	#handleEvent(event: BridgeEvent): void {
		// Stderr events from the bridge process aren't tied to a specific window.
		// Forward them as "stderr" events to all active windows so the agent sees them.
		if (event.type === "error" && event.id === "__stderr__") {
			for (const win of this.#windows.values()) {
				if (win.state !== "closed") {
					win.events.push({ name: "stderr", payload: { message: event.message } });
					if (win.events.length > 100) win.events.shift();
				}
			}
			return;
		}

		// State event: used by reconnect() via waitFor, but also handle here
		// in case it arrives outside a reconnect flow.
		if (event.type === "state") return;

		const win = this.#windows.get(event.id);
		if (!win) {
			logger.debug("QmlBridge: event for unknown window", { event });
			return;
		}
		switch (event.type) {
			case "ready":
				win.state = "ready";
				break;
			case "closed":
				win.state = "closed";
				this.#watcher.unwatch(event.id);
				break;
			case "error":
				win.state = "error";
				win.lastError = event.message;
				logger.warn("QML window error", { id: event.id, message: event.message });
				break;
			case "event":
				win.events.push({ name: event.name, payload: event.payload });
				// Keep event buffer bounded
				if (win.events.length > 100) win.events.shift();
				break;
			case "screenshot":
				// Handled by the waitFor predicate in screenshot(); nothing to store.
				break;
		}
	}

	/** Write a QML file and optionally launch it. */
	async writeFile(filePath: string, content: string): Promise<void> {
		await Bun.write(filePath, content);
	}

	/** Launch a QML window. Returns the window id. */
	async launch(id: string, filePath: string, options: LaunchOptions = {}): Promise<WindowInfo> {
		// On first launch, auto-restore windows from an existing daemon.
		if (!this.#reconnected) {
			this.#reconnected = true;
			const kind = await this.#process.ensure();
			if (kind === "existing") await this.reconnect();
		} else {
			await this.#process.ensure();
		}

		const info: WindowInfo = {
			id,
			path: filePath,
			state: "loading" as WindowState,
			events: [],
		};
		this.#windows.set(id, info);

		this.#process.send({
			type: "load",
			id,
			path: filePath,
			props: options.props ?? {},
			title: options.title,
			width: options.width,
			height: options.height,
		});

		// Wait until ready or error (max 10s)
		await this.#process.waitFor(e => (e.type === "ready" || e.type === "error") && e.id === id, 10_000);

		// Set up hot-reload watcher
		if (options.watch !== false) {
			this.#watcher.watch(id, filePath, () => {
				if (info.state === "ready") this.reload(id).catch(() => {});
			});
		}

		return info;
	}

	/** Reload a QML window (re-reads the file from disk). */
	async reload(id: string): Promise<void> {
		const win = this.#windows.get(id);
		if (!win) throw new Error(`Window not found: ${id}`);
		await this.#process.ensure();
		win.state = "loading";
		this.#process.send({ type: "reload", id });
		await this.#process.waitFor(e => (e.type === "ready" || e.type === "error") && e.id === id, 10_000);
	}

	/** Close a QML window. */
	async close(id: string): Promise<void> {
		const win = this.#windows.get(id);
		if (!win || win.state === "closed") return;
		await this.#process.ensure();
		this.#process.send({ type: "close", id });
		await this.#process.waitFor(e => e.type === "closed" && e.id === id, 5_000);
	}

	/** Send a JSON message to QML (bridge emits messageReceived signal). */
	async sendMessage(id: string, payload: Record<string, unknown>): Promise<void> {
		const win = this.#windows.get(id);
		if (!win) throw new Error(`Window not found: ${id}`);
		await this.#process.ensure();
		this.#process.send({ type: "message", id, payload });
	}

	/** Capture a screenshot of a running window and save it as PNG. Returns the save path. */
	async screenshot(id: string, savePath: string): Promise<string> {
		const win = this.#windows.get(id);
		if (!win) throw new Error(`Window not found: ${id}`);
		await this.#process.ensure();
		this.#process.send({ type: "screenshot", id, path: savePath });
		const event = await this.#process.waitFor(
			e => (e.type === "screenshot" || e.type === "error") && e.id === id,
			10_000,
		);
		if (event.type === "error") throw new Error(event.message);
		return (event as { type: "screenshot"; id: string; path: string }).path;
	}

	/** List all tracked windows and their current state. */
	listWindows(): WindowInfo[] {
		return [...this.#windows.values()];
	}

	/** Get a specific window's info. */
	getWindow(id: string): WindowInfo | undefined {
		return this.#windows.get(id);
	}

	/** Drain pending events for a window and clear its queue. */
	drainEvents(id: string): WindowInfo["events"] {
		const win = this.#windows.get(id);
		if (!win) return [];
		const events = win.events.splice(0);
		return events;
	}

	/**
	 * Wait for the next event(s) from a window using the push listener — no polling.
	 * Resolves as soon as any event (or closed) arrives, or after timeoutMs (default 10min).
	 * Returns all events that were queued at resolution time.
	 */
	waitForEvent(id: string, timeoutMs = 600_000): Promise<WindowInfo["events"]> {
		const win = this.#windows.get(id);
		if (!win) return Promise.reject(new Error(`Window not found: ${id}`));

		const { promise, resolve } = Promise.withResolvers<WindowInfo["events"]>();
		let timer: NodeJS.Timeout | undefined;

		const done = (events: WindowInfo["events"]) => {
			clearTimeout(timer);
			remove();
			resolve(events);
		};

		// Register listener first to avoid the race between checking and subscribing.
		const remove = this.#process.addListener(event => {
			if ((event.type === "event" || event.type === "closed") && event.id === id) {
				done(win.events.splice(0));
			}
			// Also wake when stderr events are pushed into this window's queue
			if (event.type === "error" && event.id === "__stderr__" && win.events.length > 0) {
				done(win.events.splice(0));
			}
		});

		// Flush any events that arrived before we registered.
		if (win.events.length > 0) {
			done(win.events.splice(0));
			return promise;
		}

		// Timeout resolves with empty array — caller re-arms if still alive.
		timer = setTimeout(() => done([]), timeoutMs);

		return promise;
	}

	/**
	 * Reconnect to an existing daemon and rebuild window state.
	 * Connects to the daemon socket, waits for the state event,
	 * then rebuilds the internal windows map from the daemon's state.
	 */
	async reconnect(): Promise<void> {
		await this.#process.ensure();
		// Use the state event buffered during connect to avoid the race where
		// the daemon sends state before waitFor is registered.
		const stateEvent =
			this.#process.takeReconnectState() ?? (await this.#process.waitFor(e => e.type === "state", 10_000));
		if (stateEvent.type !== "state") return;

		for (const win of stateEvent.windows) {
			if (this.#windows.has(win.id)) continue; // don't double-track
			const info: WindowInfo = {
				id: win.id,
				path: win.path,
				state: win.state as WindowState,
				events: [],
			};
			this.#windows.set(win.id, info);

			// Set up hot-reload watcher for recovered windows
			if (info.state === "ready") {
				this.#watcher.watch(win.id, win.path, () => {
					if (info.state === "ready") this.reload(win.id).catch(() => {});
				});
			}
		}
	}

	/** Dispose the bridge — disconnects (daemon) or kills process, stops watchers. */
	async dispose(): Promise<void> {
		this.#removeListener?.();
		this.#watcher.dispose();
		await this.#process.dispose();
	}

	/** Explicitly shut down the daemon process. */
	async killDaemon(): Promise<void> {
		this.#removeListener?.();
		this.#watcher.dispose();
		await this.#process.kill();
	}
}
