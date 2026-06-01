var _a;
import * as fs from "node:fs";
import * as net from "node:net";
import * as path from "node:path";
import { logger } from "@spell/pi-utils";
/** Resolves the path to the compiled bridge binary. */
export function bridgeBinaryPath() {
    // Resolve relative to this file at runtime
    const dir = path.dirname(import.meta.path);
    const packageRoot = path.resolve(dir, "..");
    return path.join(packageRoot, "native", "spell-qml-bridge");
}
/** Returns true if the bridge binary exists and is executable. */
export function isBridgeAvailable(binary = bridgeBinaryPath()) {
    try {
        fs.accessSync(binary, fs.constants.X_OK);
        return true;
    }
    catch {
        return false;
    }
}
/**
 * Manages a single long-lived bridge subprocess.
 * Supports two modes:
 * - stdio: spawns child process, communicates via stdin/stdout (used by QML tool)
 * - socket: connects to a daemon via unix domain socket (used by desktop mode)
 */
export class QmlProcess {
    #binaryPath;
    #env;
    #proc = null;
    #stdin = null;
    #socket = null;
    #socketBuffer = "";
    #listeners = new Set();
    #pendingReconnectState = null;
    #buffer = "";
    #stderrBuffer = "";
    #stopping = false;
    constructor(options) {
        this.#env = options?.env;
        this.#binaryPath = options?.binaryPath ?? bridgeBinaryPath();
    }
    /** Returns the unix socket path for daemon mode. */
    static socketPath() {
        const runtime = process.env.XDG_RUNTIME_DIR;
        if (runtime)
            return path.join(runtime, "spell-qml-bridge.sock");
        return `/tmp/spell-qml-bridge-${process.getuid?.() ?? 0}.sock`;
    }
    /** Spawn or connect to the bridge. */
    async ensure() {
        // Already connected via socket
        if (this.#socket && !this.#socket.destroyed)
            return "existing";
        // Already running as child process
        if (this.#proc && this.#proc.exitCode === null)
            return "new";
        if (this.#stopping)
            throw new Error("QmlProcess is shutting down");
        // Try daemon socket first, fall back to spawning
        try {
            await this.#connectSocket();
            return "existing";
        }
        catch {
            // Socket not available — try spawning daemon then connecting
        }
        await this.#spawnDaemon();
        return "new";
    }
    /** Spawn the bridge in daemon mode, then connect via socket. */
    async #spawnDaemon() {
        const binary = this.#binaryPath;
        if (!isBridgeAvailable(binary)) {
            throw new Error(`spell-qml-bridge binary not found at ${binary}.\n` +
                `Build it first: cd packages/qml && bun run build:bridge`);
        }
        // Spawn daemon — capture stderr for diagnostics if connection fails.
        const daemonProc = Bun.spawn([binary, "--daemon"], {
            stdin: "ignore",
            stdout: "ignore",
            stderr: "pipe",
            env: this.#env ? { ...process.env, ...this.#env } : undefined,
        });
        // Retry connect with exponential backoff
        const delays = [100, 200, 400, 500];
        let lastError;
        for (const delay of delays) {
            await Bun.sleep(delay);
            try {
                await this.#connectSocket();
                // Release stderr pipe so daemon isn't blocked by full buffer
                void daemonProc.stderr.cancel().catch(() => { });
                return;
            }
            catch (err) {
                lastError = err instanceof Error ? err : new Error(String(err));
            }
        }
        // Connection failed — drain daemon stderr for diagnostics
        const stderrText = await this.#drainStderrBounded(daemonProc.stderr, 200, 50);
        const stderrSuffix = stderrText ? `\nDaemon stderr:\n${stderrText}` : "";
        throw new Error(`Failed to connect to daemon socket after spawn: ${lastError?.message ?? "unknown error"}${stderrSuffix}`);
    }
    /** Read up to `maxLines` from a stderr stream with a timeout. */
    async #drainStderrBounded(stream, timeoutMs, maxLines) {
        const reader = stream.getReader();
        const chunks = [];
        const decoder = new TextDecoder();
        try {
            const deadline = Date.now() + timeoutMs;
            while (Date.now() < deadline) {
                const remaining = deadline - Date.now();
                if (remaining <= 0)
                    break;
                const result = await Promise.race([reader.read(), Bun.sleep(remaining).then(() => null)]);
                if (!result || result.done)
                    break;
                chunks.push(decoder.decode(result.value, { stream: true }));
            }
        }
        catch {
            // Stream may be closed or errored
        }
        finally {
            await reader.cancel().catch(() => { });
        }
        const text = chunks.join("").trim();
        const lines = text.split("\n");
        return lines.slice(-maxLines).join("\n");
    }
    /** Spawn the bridge as a child process with stdio pipes (legacy mode). */
    async spawnStdio() {
        if (this.#proc && this.#proc.exitCode === null)
            return;
        if (this.#stopping)
            throw new Error("QmlProcess is shutting down");
        const binary = this.#binaryPath;
        if (!isBridgeAvailable(binary)) {
            throw new Error(`spell-qml-bridge binary not found at ${binary}.\n` +
                `Build it first: cd packages/qml && bun run build:bridge`);
        }
        const proc = Bun.spawn([binary], {
            stdin: "pipe",
            stdout: "pipe",
            stderr: "pipe",
            env: this.#env ? { ...process.env, ...this.#env } : undefined,
        });
        this.#proc = proc;
        this.#stdin = proc.stdin;
        // Read stdout line by line (bridge JSON protocol)
        this.#readLoop(this.#proc.stdout).catch(err => {
            logger.error("QmlProcess stdout read error", { error: String(err) });
        });
        // Read stderr and forward as synthetic error events
        this.#readStderr(this.#proc.stderr).catch(err => {
            logger.error("QmlProcess stderr read error", { error: String(err) });
        });
        // Log unexpected exit
        this.#proc.exited.then(code => {
            if (!this.#stopping) {
                logger.warn("spell-qml-bridge exited unexpectedly", { code });
            }
        });
        logger.debug("spell-qml-bridge spawned (stdio mode)", { binary });
    }
    /**
     * Connect to the daemon's unix domain socket.
     * Rejects if connection fails within 5 seconds.
     */
    #connectSocket() {
        const socketPath = _a.socketPath();
        const { promise, resolve, reject } = Promise.withResolvers();
        const socket = net.createConnection(socketPath);
        const timeout = setTimeout(() => {
            socket.destroy();
            reject(new Error("Socket connection timed out (5s)"));
        }, 5000);
        socket.on("connect", () => {
            clearTimeout(timeout);
            this.#socket = socket;
            this.#socketBuffer = "";
            // Buffer the first state event so reconnect() can consume it
            // without racing against #dispatch delivering it to other listeners.
            this.#pendingReconnectState = null;
            const captureState = (event) => {
                if (event.type === "state") {
                    this.#pendingReconnectState = event;
                    this.#listeners.delete(captureState);
                }
            };
            this.#listeners.add(captureState);
            logger.debug("Connected to spell-qml-bridge daemon", { socketPath });
            resolve();
        });
        socket.on("error", (err) => {
            clearTimeout(timeout);
            socket.destroy();
            reject(err);
        });
        socket.on("data", (chunk) => {
            this.#socketBuffer += chunk.toString("utf8");
            for (;;) {
                const nl = this.#socketBuffer.indexOf("\n");
                if (nl < 0)
                    break;
                const line = this.#socketBuffer.slice(0, nl).trim();
                this.#socketBuffer = this.#socketBuffer.slice(nl + 1);
                if (line)
                    this.#dispatch(line);
            }
        });
        socket.on("close", () => {
            if (!this.#stopping) {
                logger.warn("Daemon socket closed unexpectedly");
            }
            this.#socket = null;
        });
        return promise;
    }
    async #readLoop(stream) {
        const decoder = new TextDecoder();
        const reader = stream.getReader();
        try {
            while (true) {
                const { done, value } = await reader.read();
                if (done)
                    break;
                this.#buffer += decoder.decode(value, { stream: true });
                for (;;) {
                    const nl = this.#buffer.indexOf("\n");
                    if (nl < 0)
                        break;
                    const line = this.#buffer.slice(0, nl).trim();
                    this.#buffer = this.#buffer.slice(nl + 1);
                    if (line)
                        this.#dispatch(line);
                }
            }
        }
        finally {
            reader.releaseLock();
        }
    }
    /**
     * Read stderr line-by-line and dispatch as synthetic error events.
     * Lines are broadcast to all listeners as `{ type: "error", id: "__stderr__", message }`,
     * allowing the QmlBridge to forward them to the agent.
     */
    async #readStderr(stream) {
        const decoder = new TextDecoder();
        const reader = stream.getReader();
        try {
            while (true) {
                const { done, value } = await reader.read();
                if (done)
                    break;
                this.#stderrBuffer += decoder.decode(value, { stream: true });
                for (;;) {
                    const nl = this.#stderrBuffer.indexOf("\n");
                    if (nl < 0)
                        break;
                    const line = this.#stderrBuffer.slice(0, nl).trim();
                    this.#stderrBuffer = this.#stderrBuffer.slice(nl + 1);
                    if (line) {
                        const event = { type: "error", id: "__stderr__", message: line };
                        for (const listener of this.#listeners) {
                            try {
                                listener(event);
                            }
                            catch (err) {
                                logger.error("QmlProcess stderr listener threw", { error: String(err) });
                            }
                        }
                    }
                }
            }
        }
        finally {
            reader.releaseLock();
        }
    }
    #dispatch(line) {
        let event;
        try {
            event = JSON.parse(line);
        }
        catch {
            logger.warn("spell-qml-bridge: invalid JSON line", { line });
            return;
        }
        for (const listener of this.#listeners) {
            try {
                listener(event);
            }
            catch (err) {
                logger.error("QmlProcess event listener threw", { error: String(err) });
            }
        }
    }
    /** Consume the state event buffered during socket connect. Returns null if none buffered. */
    takeReconnectState() {
        const state = this.#pendingReconnectState;
        this.#pendingReconnectState = null;
        return state;
    }
    /** Send a command to the bridge. Caller must have called ensure() first. */
    send(command) {
        const line = `${JSON.stringify(command)}\n`;
        if (this.#socket) {
            if (!this.#socket.writable) {
                throw new Error("Daemon socket is not writable");
            }
            this.#socket.write(line);
            return;
        }
        if (!this.#stdin)
            throw new Error("Bridge not running");
        this.#stdin.write(line);
        this.#stdin.flush();
    }
    addListener(fn) {
        this.#listeners.add(fn);
        return () => this.#listeners.delete(fn);
    }
    /** Wait for a specific event type and window id (resolves on first match). */
    waitFor(predicate, timeoutMs = 10_000) {
        const { promise, resolve, reject } = Promise.withResolvers();
        const timer = setTimeout(() => {
            remove();
            reject(new Error("Timed out waiting for bridge event"));
        }, timeoutMs);
        const remove = this.addListener(event => {
            if (predicate(event)) {
                clearTimeout(timer);
                remove();
                resolve(event);
            }
        });
        return promise;
    }
    /** Gracefully shut down the bridge process (stdio mode) or disconnect (daemon mode). */
    async dispose() {
        this.#stopping = true;
        if (this.#socket) {
            this.#socket.destroy();
            this.#socket = null;
            return;
        }
        if (this.#proc) {
            try {
                this.#stdin?.end();
                this.#stdin = null;
                await Promise.race([
                    this.#proc.exited,
                    Bun.sleep(2000).then(() => {
                        this.#proc?.kill();
                    }),
                ]);
            }
            catch {
                this.#proc?.kill();
            }
        }
    }
    /** Send quit command to daemon and disconnect. */
    async kill() {
        if (this.#socket?.writable) {
            this.send({ type: "quit" });
            // Brief delay to let the quit flush
            await Bun.sleep(100);
        }
        this.#stopping = true;
        if (this.#socket) {
            this.#socket.destroy();
            this.#socket = null;
        }
    }
    /** True if connected via unix domain socket (daemon mode). */
    get isDaemon() {
        return this.#socket !== null && !this.#socket.destroyed;
    }
    get isRunning() {
        if (this.#socket && !this.#socket.destroyed)
            return true;
        return this.#proc !== null && this.#proc.exitCode === null;
    }
}
_a = QmlProcess;
//# sourceMappingURL=qml-process.js.map