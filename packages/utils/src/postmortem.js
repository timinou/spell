/**
 * Cleanup and postmortem handler utilities.
 *
 * This module provides a system for registering and running cleanup callbacks
 * in response to process exit, signals, or fatal exceptions. It is intended to
 * allow reliably releasing resources or shutting down subprocesses, files, sockets, etc.
 */
import * as fs from "node:fs";
import inspector from "node:inspector";
import * as os from "node:os";
import * as path from "node:path";
import { isMainThread } from "node:worker_threads";
import { getLogPath, getProjectDir, getReportsDir, VERSION } from "./dirs";
import * as logger from "./logger";
import { toError } from "./type-guards";
// Cleanup reasons, in order of priority/meaning.
export var Reason;
(function (Reason) {
    Reason["PRE_EXIT"] = "pre_exit";
    Reason["EXIT"] = "exit";
    Reason["SIGINT"] = "sigint";
    Reason["SIGTERM"] = "sigterm";
    Reason["SIGHUP"] = "sighup";
    Reason["UNCAUGHT_EXCEPTION"] = "uncaught_exception";
    Reason["UNHANDLED_REJECTION"] = "unhandled_rejection";
    Reason["MANUAL"] = "manual";
    Reason["TERMINAL_LOST"] = "terminal_lost";
})(Reason || (Reason = {}));
// Internal list of active cleanup callbacks (in registration order)
const callbackList = [];
// Tracks cleanup run state (to prevent recursion/reentry issues)
let cleanupStage = "idle";
let sessionContextGetter;
/**
 * Internal: runs all registered cleanup callbacks for the given reason.
 * Ensures each callback is invoked at most once. Handles errors and prevents reentrancy.
 *
 * Returns a Promise that settles after all cleanups complete or error out.
 */
function runCleanup(reason) {
    switch (cleanupStage) {
        case "idle":
            cleanupStage = "running";
            break;
        case "running":
            logger.error("Cleanup invoked recursively", { stack: new Error().stack });
            return Promise.resolve();
        case "complete":
            return Promise.resolve();
    }
    // Call .cleanup() for each callback that is still "armed".
    // Use Promise.try to handle sync/async, but only those armed.
    // Create a copy to avoid mutating the original array with reverse()
    const promises = [...callbackList].reverse().map(callback => {
        return Promise.try(() => callback(reason));
    });
    return Promise.allSettled(promises).then(results => {
        for (const result of results) {
            if (result.status === "rejected") {
                const err = result.reason instanceof Error ? result.reason : new Error(String(result.reason));
                logger.error("Cleanup callback failed", { err, stack: err.stack });
            }
        }
        cleanupStage = "complete";
    });
}
function macosMarketingName(release) {
    const major = Number.parseInt(release.split(".")[0] ?? "", 10);
    if (Number.isNaN(major))
        return undefined;
    const names = {
        25: "Tahoe",
        24: "Sequoia",
        23: "Sonoma",
        22: "Ventura",
        21: "Monterey",
        20: "Big Sur",
    };
    return names[major];
}
function collectCrashSystemInfo() {
    const cpus = os.cpus();
    let osString = `${os.type()} ${os.release()} (${os.platform()})`;
    if (os.platform() === "darwin") {
        const marketingName = macosMarketingName(os.release());
        if (marketingName) {
            osString = `${osString} ${marketingName}`;
        }
    }
    return {
        os: osString,
        arch: os.arch(),
        cpu: cpus[0]?.model ?? "Unknown CPU",
        memory: {
            total: os.totalmem(),
            free: os.freemem(),
        },
        versions: {
            app: VERSION,
            bun: Bun.version,
            node: process.version,
        },
        cwd: getProjectDir(),
        shell: Bun.env.SHELL ?? Bun.env.ComSpec ?? "unknown",
        terminal: Bun.env.TERM_PROGRAM ?? Bun.env.TERM ?? undefined,
    };
}
function serializeUnknown(value) {
    if (value === null ||
        value === undefined ||
        typeof value === "string" ||
        typeof value === "number" ||
        typeof value === "boolean") {
        return value;
    }
    if (typeof value === "bigint") {
        return value.toString();
    }
    if (value instanceof Error) {
        return serializeError(value);
    }
    try {
        return JSON.parse(JSON.stringify(value, (_, nestedValue) => {
            return typeof nestedValue === "bigint" ? nestedValue.toString() : nestedValue;
        }));
    }
    catch {
        return String(value);
    }
}
function serializeError(err, raw) {
    const code = "code" in err && typeof err.code === "string" ? err.code : undefined;
    const info = {
        name: err.name || "Error",
        message: err.message || "(no message)",
    };
    if (err.stack) {
        info.stack = err.stack;
    }
    if (code) {
        info.code = code;
    }
    const cause = err.cause;
    if (cause !== undefined) {
        info.cause = serializeUnknown(cause);
    }
    if (raw !== undefined && raw !== err) {
        info.raw = serializeUnknown(raw);
    }
    return info;
}
function getCrashSessionContext() {
    try {
        const context = sessionContextGetter?.();
        return {
            session: context?.session ?? null,
            model: context?.model ?? null,
        };
    }
    catch (error) {
        const err = toError(error);
        logger.warn("Crash session context getter failed", { err, stack: err.stack });
        return {
            session: null,
            model: null,
        };
    }
}
function formatFatalError(label, err) {
    const name = err.name || "Error";
    const message = err.message || "(no message)";
    const stack = err.stack || "";
    const stackLines = stack.split("\n").slice(1);
    const formattedStack = stackLines.length > 0 ? `\n${stackLines.join("\n")}` : "";
    return `\n[${label}] ${name}: ${message}${formattedStack}\n`;
}
export function writeCrashReport(reason, err, raw) {
    try {
        const reportsDir = getReportsDir();
        fs.mkdirSync(reportsDir, { recursive: true });
        const timestamp = new Date().toISOString();
        const reportPath = path.join(reportsDir, `crash-${timestamp.replace(/[:.]/g, "-")}.json`);
        const sessionContext = getCrashSessionContext();
        const report = {
            timestamp,
            reason,
            pid: process.pid,
            uptimeSeconds: process.uptime(),
            logPath: getLogPath(),
            error: serializeError(err, raw),
            session: sessionContext.session,
            model: sessionContext.model,
            system: collectCrashSystemInfo(),
        };
        // Fatal handlers cannot rely on async I/O. Persist the smallest useful report first,
        // then let cleanup continue or fail independently.
        fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
        process.stderr.write(`Crash report written to ${reportPath}\n`);
        return reportPath;
    }
    catch (error) {
        const writeErr = toError(error);
        process.stderr.write(`Crash report write failed: ${writeErr.message}\n`);
        logger.error("Failed to write crash report", { err: writeErr, stack: writeErr.stack });
        return undefined;
    }
}
export function registerSessionContext(getter) {
    sessionContextGetter = getter;
}
// Register signal and error event handlers to trigger cleanup before exit.
// Main thread: full signal handling (SIGINT, SIGTERM, SIGHUP) + exceptions + exit
// Worker thread: exit only (workers use self.addEventListener for exceptions)
let inspectorOpened = false;
if (isMainThread) {
    process
        .on("SIGINT", async () => {
        writeCrashReport(Reason.SIGINT, new Error("Process received SIGINT"));
        await runCleanup(Reason.SIGINT);
        process.exit(130); // 128 + SIGINT (2)
    })
        .on("SIGUSR1", () => {
        if (inspectorOpened)
            return;
        inspectorOpened = true;
        inspector.open(undefined, undefined, false);
        const url = inspector.url();
        process.stderr.write(`Inspector opened: ${url}\n`);
    })
        .on("uncaughtException", async (err) => {
        process.stderr.write(formatFatalError("Uncaught Exception", err));
        const reportPath = writeCrashReport(Reason.UNCAUGHT_EXCEPTION, err);
        logger.error("Uncaught exception", { err, stack: err.stack, reportPath });
        await runCleanup(Reason.UNCAUGHT_EXCEPTION);
        process.exit(1);
    })
        .on("unhandledRejection", async (reason) => {
        const err = toError(reason);
        process.stderr.write(formatFatalError("Unhandled Rejection", err));
        const reportPath = writeCrashReport(Reason.UNHANDLED_REJECTION, err, reason);
        logger.error("Unhandled rejection", { err, stack: err.stack, reportPath });
        await runCleanup(Reason.UNHANDLED_REJECTION);
        process.exit(1);
    })
        .on("exit", async () => {
        void runCleanup(Reason.EXIT); // fire and forget (exit imminent)
    })
        .on("SIGTERM", async () => {
        writeCrashReport(Reason.SIGTERM, new Error("Process received SIGTERM"));
        await runCleanup(Reason.SIGTERM);
        process.exit(143); // 128 + SIGTERM (15)
    })
        .on("SIGHUP", async () => {
        writeCrashReport(Reason.SIGHUP, new Error("Process received SIGHUP"));
        await runCleanup(Reason.SIGHUP);
        process.exit(129); // 128 + SIGHUP (1)
    });
}
else {
    // Worker thread: only register exit handler for cleanup.
    // DO NOT register uncaughtException/unhandledRejection handlers here -
    // they would swallow errors before the worker's own handlers (self.addEventListener)
    // can report failures back to the parent thread.
    process.on("exit", () => {
        void runCleanup(Reason.EXIT);
    });
}
// Register logger flush as first callback so it is started last when callbacks are
// iterated in reverse. Note: runCleanup uses Promise.allSettled, so all callbacks
// execute concurrently — ordering only affects initiation sequence, not completion.
register("logger-flush", async () => {
    try {
        await Promise.race([logger.close(), Bun.sleep(2000)]);
    }
    catch {
        // Ignore flush failures during shutdown
    }
});
/**
 * Register a process cleanup callback, to be run on shutdown, signal, or fatal error.
 *
 * Returns a Callback instance that can be used to cancel (unregister) or manually clean up.
 * If register is called after cleanup already began, invokes callback on a microtask.
 */
export function register(id, callback) {
    let done = false;
    const exec = (reason) => {
        if (done)
            return;
        done = true;
        try {
            return callback(reason);
        }
        catch (e) {
            const err = e instanceof Error ? e : new Error(String(e));
            logger.error("Cleanup callback failed", { err, id, stack: err.stack });
        }
    };
    const cancel = () => {
        const index = callbackList.indexOf(exec);
        if (index >= 0) {
            callbackList.splice(index, 1);
        }
        done = true;
    };
    if (cleanupStage !== "idle") {
        // If cleanup is already running/completed, warn and run on microtask.
        logger.warn("Cleanup invoked recursively", { id });
        try {
            callback(Reason.MANUAL);
        }
        catch (e) {
            const err = e instanceof Error ? e : new Error(String(e));
            logger.error("Cleanup callback failed", { err, id, stack: err.stack });
        }
        return () => { };
    }
    // Register callback as "armed" (active).
    callbackList.push(exec);
    return cancel;
}
/**
 * Runs all cleanup callbacks without exiting.
 * Use this in workers or when you need to clean up but continue execution.
 */
export function cleanup() {
    return runCleanup(Reason.MANUAL);
}
/**
 * Runs all cleanup callbacks and exits.
 *
 * In main thread: waits for stdout drain, then calls process.exit().
 * In workers: runs cleanup only (process.exit would kill entire process).
 */
export async function quit(code = 0) {
    await runCleanup(Reason.MANUAL);
    if (!isMainThread) {
        return; // Workers: cleanup done, let worker exit naturally
    }
    if (process.stdout.writableLength > 0) {
        const { promise, resolve } = Promise.withResolvers();
        process.stdout.once("drain", resolve);
        await Promise.race([promise, Bun.sleep(5000)]);
    }
    process.exit(code);
}
/**
 * Runs cleanup callbacks for a specific reason and exits gracefully.
 * Used for non-signal shutdown paths (e.g. terminal pty loss).
 */
export async function quitGracefully(reason) {
    await runCleanup(reason);
    if (!isMainThread) {
        return;
    }
    if (process.stdout.writableLength > 0) {
        if (!process.stdout.writable) {
            // stdout is not writable — cannot drain, skip wait
        }
        else {
            const { promise, resolve } = Promise.withResolvers();
            process.stdout.once("drain", resolve);
            await Promise.race([promise, Bun.sleep(1500)]);
        }
    }
    process.exit(0);
}
//# sourceMappingURL=postmortem.js.map