import type { WindowInfo, WindowState } from "@oh-my-pi/pi-qml";
import { logger } from "@oh-my-pi/pi-utils";
import type { ClientPanelMessage, ServerPanelMessage } from "./protocol";

export interface RemoteLaunchOptions {
	title?: string;
	width?: number;
	height?: number;
	props?: Record<string, unknown>;
}

/**
 * Remote analogue of QmlBridge — routes panel commands over a WebSocket
 * transport instead of a local QML bridge process.
 *
 * The server wires up transport via _setTransport / _clearTransport.
 * Incoming client messages are delivered via _deliverClientMessage.
 */
export class RemoteQmlBridge {
	// #send is null when no client is connected
	#send: ((msg: ServerPanelMessage) => void) | null = null;
	readonly #windows = new Map<string, WindowInfo>();
	// Each entry is a set of one-shot listeners waiting for any event on that id
	readonly #waiters = new Map<string, Set<() => void>>();

	// -------------------------------------------------------------------------
	// Transport wiring (called by QmlRemoteServer)
	// -------------------------------------------------------------------------

	_setTransport(send: (msg: ServerPanelMessage) => void): void {
		this.#send = send;
	}

	_clearTransport(): void {
		this.#send = null;
	}

	// -------------------------------------------------------------------------
	// Incoming event delivery (called by QmlRemoteServer)
	// -------------------------------------------------------------------------

	_deliverClientMessage(msg: ClientPanelMessage): void {
		const win = this.#windows.get(msg.id);
		if (!win) {
			logger.debug("RemoteQmlBridge: event for unknown panel", { msg });
			return;
		}

		switch (msg.type) {
			case "panel_ready":
				win.state = "ready";
				if (Array.isArray(msg.armedTools)) {
					win.armedTools = msg.armedTools;
				}
				break;
			case "panel_closed":
				win.state = "closed";
				break;
			case "panel_error":
				win.state = "error";
				win.lastError = msg.message;
				logger.warn("Remote QML panel error", { id: msg.id, message: msg.message });
				break;
			case "panel_event":
				win.events.push({ name: msg.name, payload: msg.payload });
				// Keep event buffer bounded
				if (win.events.length > 100) win.events.shift();
				break;
		}

		// Wake waiters only for user-visible events and closure (mirrors QmlBridge)
		if (msg.type === "panel_event" || msg.type === "panel_closed") {
			const waiters = this.#waiters.get(msg.id);
			if (waiters) {
				for (const fn of [...waiters]) fn();
			}
		}
	}

	// -------------------------------------------------------------------------
	// Public API — mirrors QmlBridge
	// -------------------------------------------------------------------------

	/**
	 * Push QML source content to the connected Android client.
	 * Unlike QmlBridge.launch, `qmlContent` is the raw QML source string,
	 * not a file path.
	 */
	launch(id: string, qmlContent: string, options: RemoteLaunchOptions = {}): WindowInfo {
		this.#requireTransport("launch");

		const info: WindowInfo = {
			id,
			// Store content in path field — WindowInfo is reused from pi-qml.
			// Remote panels don't have a filesystem path; callers should not
			// depend on this field for remote bridges.
			path: "(remote)",
			state: "loading" as WindowState,
			events: [],
		};
		this.#windows.set(id, info);

		this.#send!({
			type: "push_qml",
			id,
			content: qmlContent,
			props: options.props,
			title: options.title,
			width: options.width,
			height: options.height,
		});

		return info;
	}

	/** Instruct the client to close a panel. */
	close(id: string): void {
		const win = this.#windows.get(id);
		if (!win || win.state === "closed") return;
		this.#requireTransport("close");
		this.#send!({ type: "close_panel", id });
	}

	/** Forward a JSON message to a panel. */
	sendMessage(id: string, payload: Record<string, unknown>): void {
		if (!this.#windows.has(id)) throw new Error(`Panel not found: ${id}`);
		this.#requireTransport("sendMessage");
		this.#send!({ type: "message", id, payload });
	}

	/** Instruct the client to reload a panel. */
	reload(id: string): void {
		const win = this.#windows.get(id);
		if (!win) throw new Error(`Panel not found: ${id}`);
		this.#requireTransport("reload");
		win.state = "loading";
		this.#send!({ type: "reload_panel", id });
	}

	/** List all tracked panels and their current state. */
	listWindows(): WindowInfo[] {
		return [...this.#windows.values()];
	}

	/** Get a specific panel's info. */
	getWindow(id: string): WindowInfo | undefined {
		return this.#windows.get(id);
	}

	/** Drain pending events for a panel and clear its queue. */
	drainEvents(id: string): WindowInfo["events"] {
		const win = this.#windows.get(id);
		if (!win) return [];
		return win.events.splice(0);
	}

	/**
	 * Wait for the next panel_event or panel_closed from a panel.
	 * Resolves with all queued events at that moment.
	 * Default timeout: 10 minutes.
	 */
	waitForEvent(id: string, timeoutMs = 600_000): Promise<WindowInfo["events"]> {
		const win = this.#windows.get(id);
		if (!win) return Promise.reject(new Error(`Panel not found: ${id}`));

		const { promise, resolve, reject } = Promise.withResolvers<WindowInfo["events"]>();

		let timer: NodeJS.Timeout | undefined;

		const cleanup = () => {
			clearTimeout(timer);
			const set = this.#waiters.get(id);
			set?.delete(wakeup);
		};

		const wakeup = () => {
			const win = this.#windows.get(id);
			// Only wake on user events or closure, not on ready/error
			if (!win) return;
			cleanup();
			resolve(win.events.splice(0));
		};

		// Register before setting the timer to avoid races
		let set = this.#waiters.get(id);
		if (!set) {
			set = new Set();
			this.#waiters.set(id, set);
		}
		set.add(wakeup);

		timer = setTimeout(() => {
			cleanup();
			reject(new Error(`Timed out waiting for panel event: ${id}`));
		}, timeoutMs);

		return promise;
	}

	// -------------------------------------------------------------------------
	// Internal helpers
	// -------------------------------------------------------------------------

	#requireTransport(op: string): void {
		if (!this.#send) throw new Error(`RemoteQmlBridge.${op}: no client connected`);
	}
}
