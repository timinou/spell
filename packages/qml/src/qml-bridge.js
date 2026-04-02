import { logger } from "@oh-my-pi/pi-utils";
import { QmlProcess } from "./qml-process";
import { QmlWatcher } from "./watcher";
/**
 * Returns true when a graphical display is available for rendering QML windows.
 * On Linux, checks DISPLAY (X11) and WAYLAND_DISPLAY. Always true on macOS/Windows.
 */
export function isDisplayAvailable() {
    if (process.platform !== "linux")
        return true;
    return Boolean(process.env.DISPLAY || process.env.WAYLAND_DISPLAY);
}
export class QmlBridge {
    #process;
    #watcher = new QmlWatcher();
    #windows = new Map();
    #removeListener = null;
    #reconnected = false;
    constructor(options) {
        this.#process = new QmlProcess(options);
        // Register event listener immediately — process may not be up yet
        this.#removeListener = this.#process.addListener(event => this.#handleEvent(event));
    }
    #handleEvent(event) {
        // Stderr events from the bridge process aren't tied to a specific window.
        // Forward them as "stderr" events to all active windows so the agent sees them.
        if (event.type === "error" && event.id === "__stderr__") {
            for (const win of this.#windows.values()) {
                if (win.state !== "closed") {
                    win.events.push({ name: "stderr", payload: { message: event.message } });
                    if (win.events.length > 100)
                        win.events.shift();
                }
            }
            return;
        }
        // State event: used by reconnect() via waitFor, but also handle here
        // in case it arrives outside a reconnect flow.
        if (event.type === "state")
            return;
        // Hotkey and systray events are not tied to a window — leave them for
        // addListener consumers (for example onHotkeyTriggered/onSystrayActivated).
        // Do not route them into the window map.
        if (event.type === "hotkey_triggered" || event.type === "systray_activated" || event.type === "systray_click")
            return;
        const win = this.#windows.get(event.id);
        if (!win) {
            logger.debug("QmlBridge: event for unknown window", { event });
            return;
        }
        switch (event.type) {
            case "ready":
                win.state = "ready";
                if (Array.isArray(event.armedTools)) {
                    win.armedTools = event.armedTools;
                }
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
                if (win.events.length > 100)
                    win.events.shift();
                break;
            case "screenshot":
                // Handled by the waitFor predicate in screenshot(); nothing to store.
                break;
        }
    }
    /** Write a QML file and optionally launch it. */
    async writeFile(filePath, content) {
        await Bun.write(filePath, content);
    }
    /** Launch a QML window. Returns the window id. */
    async launch(id, filePath, options = {}) {
        // On first launch, auto-restore windows from an existing daemon.
        if (!this.#reconnected) {
            this.#reconnected = true;
            const kind = await this.#process.ensure();
            if (kind === "existing")
                await this.reconnect();
        }
        else {
            await this.#process.ensure();
        }
        const info = {
            id,
            path: filePath,
            state: "loading",
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
        try {
            await this.#process.waitFor(e => (e.type === "ready" || e.type === "error") && e.id === id, 10_000);
        }
        catch (_err) {
            const stderrLines = info.events
                .filter(e => e.name === "stderr")
                .map(e => e.payload.message ?? "")
                .join("\n");
            const detail = stderrLines
                ? `QML load timed out. Run qmllint on the file to check syntax. Accumulated stderr:\n${stderrLines}`
                : `QML load timed out. Run qmllint on the file to check syntax.`;
            throw new Error(detail);
        }
        if (info.state === "error") {
            throw new Error(info.lastError ?? "QML failed to load");
        }
        // Set up hot-reload watcher
        if (options.watch !== false) {
            this.#watcher.watch(id, filePath, () => {
                if (info.state === "ready")
                    this.reload(id).catch(() => { });
            });
        }
        return info;
    }
    /** Reload a QML window (re-reads the file from disk). */
    async reload(id) {
        const win = this.#windows.get(id);
        if (!win)
            throw new Error(`Window not found: ${id}`);
        await this.#process.ensure();
        win.state = "loading";
        this.#process.send({ type: "reload", id });
        await this.#process.waitFor(e => (e.type === "ready" || e.type === "error") && e.id === id, 10_000);
    }
    /** Close a QML window. */
    async close(id) {
        const win = this.#windows.get(id);
        if (!win || win.state === "closed")
            return;
        await this.#process.ensure();
        this.#process.send({ type: "close", id });
        await this.#process.waitFor(e => e.type === "closed" && e.id === id, 5_000);
    }
    /** Send a JSON message to QML (bridge emits messageReceived signal). */
    async sendMessage(id, payload) {
        const win = this.#windows.get(id);
        if (!win)
            throw new Error(`Window not found: ${id}`);
        await this.#process.ensure();
        this.#process.send({ type: "message", id, payload });
    }
    /** Capture a screenshot of a running window and save it as PNG. Returns the save path. */
    async screenshot(id, savePath) {
        const win = this.#windows.get(id);
        if (!win)
            throw new Error(`Window not found: ${id}`);
        await this.#process.ensure();
        this.#process.send({ type: "screenshot", id, path: savePath });
        const event = await this.#process.waitFor(e => (e.type === "screenshot" || e.type === "error") && e.id === id, 10_000);
        if (event.type === "error")
            throw new Error(event.message);
        return event.path;
    }
    /** List all tracked windows and their current state. */
    listWindows() {
        return [...this.#windows.values()];
    }
    /** Get a specific window's info. */
    getWindow(id) {
        return this.#windows.get(id);
    }
    /** Drain pending events for a window and clear its queue. */
    drainEvents(id) {
        const win = this.#windows.get(id);
        if (!win)
            return [];
        const events = win.events.splice(0);
        return events;
    }
    /**
     * Wait for the next event(s) from a window using the push listener — no polling.
     * Resolves as soon as any event (or closed) arrives, or after timeoutMs (default 10min).
     * Returns all events that were queued at resolution time.
     */
    waitForEvent(id, timeoutMs = 600_000) {
        const win = this.#windows.get(id);
        if (!win)
            return Promise.reject(new Error(`Window not found: ${id}`));
        const { promise, resolve } = Promise.withResolvers();
        let timer;
        const done = (events) => {
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
    async reconnect() {
        await this.#process.ensure();
        // Use the state event buffered during connect to avoid the race where
        // the daemon sends state before waitFor is registered.
        const stateEvent = this.#process.takeReconnectState() ?? (await this.#process.waitFor(e => e.type === "state", 10_000));
        if (stateEvent.type !== "state")
            return;
        for (const win of stateEvent.windows) {
            if (this.#windows.has(win.id))
                continue; // don't double-track
            const info = {
                id: win.id,
                path: win.path,
                state: win.state,
                armedTools: Array.isArray(win.armedTools) ? win.armedTools : undefined,
                events: [],
            };
            this.#windows.set(win.id, info);
            // Set up hot-reload watcher for recovered windows
            if (info.state === "ready") {
                this.#watcher.watch(win.id, win.path, () => {
                    if (info.state === "ready")
                        this.reload(win.id).catch(() => { });
                });
            }
        }
    }
    /**
     * Register a global hotkey.
     * On Linux this is a no-op (the compositor owns hotkeys).
     * On macOS this uses Carbon RegisterEventHotKey.
     */
    async registerHotkey(hotkeyId, key, modifiers) {
        await this.#process.ensure();
        this.#process.send({ type: "register_hotkey", hotkeyId, key, modifiers });
    }
    /** Unregister a previously-registered global hotkey. */
    async unregisterHotkey(hotkeyId) {
        await this.#process.ensure();
        this.#process.send({ type: "unregister_hotkey", hotkeyId });
    }
    /**
     * Subscribe to hotkey triggers. Returns a disposal function.
     * The callback is invoked whenever any registered hotkey fires.
     */
    onHotkeyTriggered(callback) {
        return this.#process.addListener(event => {
            if (event.type === "hotkey_triggered") {
                callback(event.hotkeyId);
            }
        });
    }
    /** Subscribe to tray icon activation. Returns a disposal function. */
    onSystrayActivated(callback) {
        return this.#process.addListener(event => {
            if (event.type === "systray_activated")
                callback();
        });
    }
    /** Subscribe to system tray menu clicks. Returns a disposal function. */
    onSystrayClick(callback) {
        return this.#process.addListener(event => {
            if (event.type === "systray_click")
                callback(event.itemId);
        });
    }
    /** Create a system tray icon. */
    async createSystray(opts) {
        await this.#process.ensure();
        this.#process.send({ type: "create_systray", icon: opts?.icon, tooltip: opts?.tooltip });
    }
    /** Update the system tray context menu items. */
    async updateSystrayMenu(items) {
        await this.#process.ensure();
        this.#process.send({ type: "update_systray_menu", items });
    }
    /** Destroy the system tray icon. */
    async destroySystray() {
        await this.#process.ensure();
        this.#process.send({ type: "destroy_systray" });
    }
    /** Dispose the bridge — disconnects (daemon) or kills process, stops watchers. */
    async dispose() {
        this.#removeListener?.();
        this.#watcher.dispose();
        await this.#process.dispose();
    }
    /** Explicitly shut down the daemon process. */
    async killDaemon() {
        this.#removeListener?.();
        this.#watcher.dispose();
        await this.#process.kill();
    }
}
//# sourceMappingURL=qml-bridge.js.map