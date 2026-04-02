import type { WindowInfo } from "./protocol";
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
export interface QmlBridgeOptions {
    /** Extra environment variables for the bridge process. */
    env?: Record<string, string>;
}
/**
 * Returns true when a graphical display is available for rendering QML windows.
 * On Linux, checks DISPLAY (X11) and WAYLAND_DISPLAY. Always true on macOS/Windows.
 */
export declare function isDisplayAvailable(): boolean;
export declare class QmlBridge {
    #private;
    constructor(options?: QmlBridgeOptions);
    /** Write a QML file and optionally launch it. */
    writeFile(filePath: string, content: string): Promise<void>;
    /** Launch a QML window. Returns the window id. */
    launch(id: string, filePath: string, options?: LaunchOptions): Promise<WindowInfo>;
    /** Reload a QML window (re-reads the file from disk). */
    reload(id: string): Promise<void>;
    /** Close a QML window. */
    close(id: string): Promise<void>;
    /** Send a JSON message to QML (bridge emits messageReceived signal). */
    sendMessage(id: string, payload: Record<string, unknown>): Promise<void>;
    /** Capture a screenshot of a running window and save it as PNG. Returns the save path. */
    screenshot(id: string, savePath: string): Promise<string>;
    /** List all tracked windows and their current state. */
    listWindows(): WindowInfo[];
    /** Get a specific window's info. */
    getWindow(id: string): WindowInfo | undefined;
    /** Drain pending events for a window and clear its queue. */
    drainEvents(id: string): WindowInfo["events"];
    /**
     * Wait for the next event(s) from a window using the push listener — no polling.
     * Resolves as soon as any event (or closed) arrives, or after timeoutMs (default 10min).
     * Returns all events that were queued at resolution time.
     */
    waitForEvent(id: string, timeoutMs?: number): Promise<WindowInfo["events"]>;
    /**
     * Reconnect to an existing daemon and rebuild window state.
     * Connects to the daemon socket, waits for the state event,
     * then rebuilds the internal windows map from the daemon's state.
     */
    reconnect(): Promise<void>;
    /**
     * Register a global hotkey.
     * On Linux this is a no-op (the compositor owns hotkeys).
     * On macOS this uses Carbon RegisterEventHotKey.
     */
    registerHotkey(hotkeyId: string, key: string, modifiers: string[]): Promise<void>;
    /** Unregister a previously-registered global hotkey. */
    unregisterHotkey(hotkeyId: string): Promise<void>;
    /**
     * Subscribe to hotkey triggers. Returns a disposal function.
     * The callback is invoked whenever any registered hotkey fires.
     */
    onHotkeyTriggered(callback: (hotkeyId: string) => void): () => void;
    /** Subscribe to tray icon activation. Returns a disposal function. */
    onSystrayActivated(callback: () => void): () => void;
    /** Subscribe to system tray menu clicks. Returns a disposal function. */
    onSystrayClick(callback: (itemId: string) => void): () => void;
    /** Create a system tray icon. */
    createSystray(opts?: {
        icon?: string;
        tooltip?: string;
    }): Promise<void>;
    /** Update the system tray context menu items. */
    updateSystrayMenu(items: Array<{
        id: string;
        label: string;
        enabled?: boolean;
        checked?: boolean;
        separator?: boolean;
    }>): Promise<void>;
    /** Destroy the system tray icon. */
    destroySystray(): Promise<void>;
    /** Dispose the bridge — disconnects (daemon) or kills process, stops watchers. */
    dispose(): Promise<void>;
    /** Explicitly shut down the daemon process. */
    killDaemon(): Promise<void>;
}
//# sourceMappingURL=qml-bridge.d.ts.map