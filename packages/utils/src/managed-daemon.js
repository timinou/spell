/**
 * Managed daemon lifecycle — spawn, socket-readiness, health checks, postmortem, graceful stop.
 *
 * Eliminates manual daemon lifecycle boilerplate. Consumers provide a DaemonConfig;
 * `startDaemon()` returns a ManagedDaemon that owns the entire lifecycle.
 *
 * Key invariant: callers MUST use `--fg-daemon` (or equivalent foreground mode)
 * so the returned `proc` PID tracks the live daemon, not a dead forked parent.
 */
import * as fs from "node:fs/promises";
import * as net from "node:net";
import { isEnoent } from "./fs-error";
import * as logger from "./logger";
import * as postmortem from "./postmortem";
import { isPidRunning, terminate } from "./procmgr";
// ---------------------------------------------------------------------------
// Socket utilities (exported — reusable beyond daemon management)
// ---------------------------------------------------------------------------
/**
 * Probe whether a Unix socket has a live listener (connect + disconnect).
 * Returns true if a connection was accepted, false otherwise.
 */
export async function probeSocket(socketPath, timeoutMs = 1000) {
    const { promise, resolve } = Promise.withResolvers();
    const conn = net.createConnection(socketPath);
    const timer = setTimeout(() => {
        conn.destroy();
        resolve(false);
    }, timeoutMs);
    conn.on("connect", () => {
        clearTimeout(timer);
        conn.destroy();
        resolve(true);
    });
    conn.on("error", () => {
        clearTimeout(timer);
        conn.destroy();
        resolve(false);
    });
    return promise;
}
/**
 * Poll until a socket file appears on disk, or throw when the deadline passes.
 *
 * @param socketPath - Absolute path to the socket file.
 * @param timeoutMs - Maximum time to wait in milliseconds.
 * @param pollIntervalMs - Interval between checks (default: 500ms).
 */
export async function waitForSocket(socketPath, timeoutMs, pollIntervalMs = 500) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        try {
            await fs.access(socketPath);
            return;
        }
        catch (err) {
            if (!isEnoent(err)) {
                // Permission error or similar — treat as not-ready and keep trying.
            }
        }
        await Bun.sleep(pollIntervalMs);
    }
    throw new Error(`Daemon socket did not appear within ${timeoutMs}ms: ${socketPath}`);
}
// ---------------------------------------------------------------------------
// startDaemon
// ---------------------------------------------------------------------------
const DEFAULT_HEALTH_INTERVAL_MS = 5_000;
const DEFAULT_STARTUP_TIMEOUT_MS = 30_000;
/**
 * Spawn a daemon, wait for socket readiness, register with postmortem, start health checks.
 *
 * The daemon MUST run in foreground mode so `proc.pid` tracks the live process.
 * `--fg-daemon` for Emacs, or equivalent for other daemons.
 */
export async function startDaemon(config) {
    const { name, command, socketPath, stopCommand, healthIntervalMs = DEFAULT_HEALTH_INTERVAL_MS, startupTimeoutMs = DEFAULT_STARTUP_TIMEOUT_MS, env, cwd, logStderr = true, onCrash, } = config;
    // Spawn the daemon process in foreground mode.
    const proc = Bun.spawn(command, {
        stdio: ["ignore", "ignore", logStderr ? "pipe" : "ignore"],
        env: env ? { ...process.env, ...env } : undefined,
        cwd,
    });
    // Consume stderr in a background task — logs each line, never blocks.
    if (logStderr && proc.stderr) {
        consumeStderr(proc.stderr, name);
    }
    // Wait for socket readiness.
    try {
        await waitForSocket(socketPath, startupTimeoutMs);
    }
    catch (err) {
        // Daemon failed to start — kill the process and propagate the error.
        try {
            proc.kill();
        }
        catch {
            // Already dead.
        }
        throw err;
    }
    logger.debug(`[managed-daemon] Daemon ready`, { name, socketPath, pid: proc.pid });
    // --- Mutable state ---
    let alive = true;
    let stopped = false;
    let healthTimer;
    let cancelPostmortem;
    // Health check timer.
    if (healthIntervalMs > 0) {
        healthTimer = setInterval(async () => {
            try {
                await fs.access(socketPath);
            }
            catch {
                logger.warn(`[managed-daemon] Socket disappeared — daemon may have crashed`, { name, socketPath });
                alive = false;
                if (healthTimer)
                    clearInterval(healthTimer);
                healthTimer = undefined;
                onCrash?.();
            }
        }, healthIntervalMs);
        healthTimer.unref();
    }
    // Postmortem registration — so signals and exit clean up the daemon.
    cancelPostmortem = postmortem.register(name, reason => {
        if (stopped)
            return;
        stopped = true;
        alive = false;
        if (healthTimer) {
            clearInterval(healthTimer);
            healthTimer = undefined;
        }
        // In EXIT context, only synchronous operations are safe.
        // proc.kill() is our best effort.
        if (reason === postmortem.Reason.EXIT) {
            try {
                proc.kill();
            }
            catch {
                // Already dead.
            }
            return;
        }
        // For signal/exception reasons, attempt graceful shutdown.
        try {
            proc.kill();
        }
        catch {
            // Already dead.
        }
    });
    const stop = async () => {
        if (stopped)
            return;
        stopped = true;
        alive = false;
        // Deregister postmortem so we don't double-dispose.
        cancelPostmortem?.();
        cancelPostmortem = undefined;
        // Clear health timer.
        if (healthTimer) {
            clearInterval(healthTimer);
            healthTimer = undefined;
        }
        logger.debug(`[managed-daemon] Stopping daemon`, { name });
        // 1. Graceful stop via stopCommand.
        if (stopCommand && stopCommand.length > 0) {
            try {
                const stopProc = Bun.spawn(stopCommand, {
                    stdio: ["ignore", "ignore", "ignore"],
                });
                // Wait up to 2s for the stop command to finish.
                await Promise.race([stopProc.exited, Bun.sleep(2000)]);
            }
            catch (err) {
                logger.warn(`[managed-daemon] Stop command failed`, {
                    name,
                    err: err instanceof Error ? err.message : String(err),
                });
            }
        }
        // 2. Wait briefly for process to exit after stop command.
        if (isPidRunning(proc)) {
            const exited = await Promise.race([
                proc.exited.then(() => true, () => true),
                Bun.sleep(2000).then(() => false),
            ]);
            if (!exited) {
                // 3. Escalate: terminate with SIGTERM → SIGKILL.
                await terminate({ target: proc, timeout: 3000 }).catch(() => { });
            }
        }
        // 4. Remove socket file.
        try {
            await fs.unlink(socketPath);
        }
        catch (err) {
            if (!isEnoent(err)) {
                logger.warn(`[managed-daemon] Could not remove socket after stop`, { name, socketPath });
            }
        }
    };
    return {
        socketPath,
        pid: proc.pid,
        isAlive() {
            return alive;
        },
        stop,
    };
}
// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function consumeStderr(stream, name) {
    const decoder = new TextDecoder();
    (async () => {
        for await (const chunk of stream) {
            for (const line of decoder.decode(chunk).split("\n")) {
                if (line.trim())
                    logger.debug(`[managed-daemon:${name}] ${line.trim()}`);
            }
        }
    })().catch(() => { });
}
//# sourceMappingURL=managed-daemon.js.map