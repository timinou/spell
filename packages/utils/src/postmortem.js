/**
 * Cleanup and postmortem handler utilities.
 *
 * This module provides a system for registering and running cleanup callbacks
 * in response to process exit, signals, or fatal exceptions. It is intended to
 * allow reliably releasing resources or shutting down subprocesses, files, sockets, etc.
 */
import inspector from "node:inspector";
import { isMainThread } from "node:worker_threads";
import { logger } from ".";
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
})(Reason || (Reason = {}));
// Internal list of active cleanup callbacks (in registration order)
const callbackList = [];
// Tracks cleanup run state (to prevent recursion/reentry issues)
let cleanupStage = "idle";
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
// Register signal and error event handlers to trigger cleanup before exit.
// Main thread: full signal handling (SIGINT, SIGTERM, SIGHUP) + exceptions + exit
// Worker thread: exit only (workers use self.addEventListener for exceptions)
let inspectorOpened = false;
function formatFatalError(label, err) {
    const name = err.name || "Error";
    const message = err.message || "(no message)";
    const stack = err.stack || "";
    const stackLines = stack.split("\n").slice(1);
    const formattedStack = stackLines.length > 0 ? `\n${stackLines.join("\n")}` : "";
    return `\n[${label}] ${name}: ${message}${formattedStack}\n`;
}
if (isMainThread) {
    process
        .on("SIGINT", async () => {
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
        logger.error("Uncaught exception", { err, stack: err.stack });
        await runCleanup(Reason.UNCAUGHT_EXCEPTION);
        process.exit(1);
    })
        .on("unhandledRejection", async (reason) => {
        const err = reason instanceof Error ? reason : new Error(String(reason));
        process.stderr.write(formatFatalError("Unhandled Rejection", err));
        logger.error("Unhandled rejection", { err, stack: err.stack });
        await runCleanup(Reason.UNHANDLED_REJECTION);
        process.exit(1);
    })
        .on("exit", async () => {
        void runCleanup(Reason.EXIT); // fire and forget (exit imminent)
    })
        .on("SIGTERM", async () => {
        await runCleanup(Reason.SIGTERM);
        process.exit(143); // 128 + SIGTERM (15)
    })
        .on("SIGHUP", async () => {
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
//# sourceMappingURL=postmortem.js.map