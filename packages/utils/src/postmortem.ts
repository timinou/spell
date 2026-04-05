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
export enum Reason {
	PRE_EXIT = "pre_exit", // Pre-exit phase (not used by default)
	EXIT = "exit", // Normal process exit
	SIGINT = "sigint", // Ctrl-C or SIGINT
	SIGTERM = "sigterm", // SIGTERM
	SIGHUP = "sighup", // SIGHUP
	UNCAUGHT_EXCEPTION = "uncaught_exception", // Fatal exception
	UNHANDLED_REJECTION = "unhandled_rejection", // Unhandled promise rejection
	MANUAL = "manual", // Manual cleanup (not triggered by process)
}

export interface CrashSessionContext {
	session: {
		id: string | null;
		file: string | null;
		cwd: string | null;
	} | null;
	model: {
		provider: string | null;
		id: string | null;
		key: string | null;
	} | null;
}

interface CrashErrorInfo {
	name: string;
	message: string;
	stack?: string;
	code?: string;
	cause?: unknown;
	raw?: unknown;
}

interface CrashSystemInfo {
	os: string;
	arch: string;
	cpu: string;
	memory: {
		total: number;
		free: number;
	};
	versions: {
		app: string;
		bun: string;
		node: string;
	};
	cwd: string;
	shell: string;
	terminal: string | undefined;
}

interface CrashReport {
	timestamp: string;
	reason: Reason;
	pid: number;
	uptimeSeconds: number;
	logPath: string;
	error: CrashErrorInfo;
	session: CrashSessionContext["session"];
	model: CrashSessionContext["model"];
	system: CrashSystemInfo;
}

// Internal list of active cleanup callbacks (in registration order)
const callbackList: ((reason: Reason) => Promise<void> | void)[] = [];
// Tracks cleanup run state (to prevent recursion/reentry issues)
let cleanupStage: "idle" | "running" | "complete" = "idle";
let sessionContextGetter: (() => CrashSessionContext | null | undefined) | undefined;

/**
 * Internal: runs all registered cleanup callbacks for the given reason.
 * Ensures each callback is invoked at most once. Handles errors and prevents reentrancy.
 *
 * Returns a Promise that settles after all cleanups complete or error out.
 */
function runCleanup(reason: Reason): Promise<void> {
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

function macosMarketingName(release: string): string | undefined {
	const major = Number.parseInt(release.split(".")[0] ?? "", 10);
	if (Number.isNaN(major)) return undefined;
	const names: Record<number, string> = {
		25: "Tahoe",
		24: "Sequoia",
		23: "Sonoma",
		22: "Ventura",
		21: "Monterey",
		20: "Big Sur",
	};
	return names[major];
}

function collectCrashSystemInfo(): CrashSystemInfo {
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

function serializeUnknown(value: unknown): unknown {
	if (
		value === null ||
		value === undefined ||
		typeof value === "string" ||
		typeof value === "number" ||
		typeof value === "boolean"
	) {
		return value;
	}
	if (typeof value === "bigint") {
		return value.toString();
	}
	if (value instanceof Error) {
		return serializeError(value);
	}
	try {
		return JSON.parse(
			JSON.stringify(value, (_, nestedValue: unknown) => {
				return typeof nestedValue === "bigint" ? nestedValue.toString() : nestedValue;
			}),
		);
	} catch {
		return String(value);
	}
}

function serializeError(err: Error, raw?: unknown): CrashErrorInfo {
	const code = "code" in err && typeof err.code === "string" ? err.code : undefined;
	const info: CrashErrorInfo = {
		name: err.name || "Error",
		message: err.message || "(no message)",
	};
	if (err.stack) {
		info.stack = err.stack;
	}
	if (code) {
		info.code = code;
	}
	const cause = (err as Error & { cause?: unknown }).cause;
	if (cause !== undefined) {
		info.cause = serializeUnknown(cause);
	}
	if (raw !== undefined && raw !== err) {
		info.raw = serializeUnknown(raw);
	}
	return info;
}

function getCrashSessionContext(): CrashSessionContext {
	try {
		const context = sessionContextGetter?.();
		return {
			session: context?.session ?? null,
			model: context?.model ?? null,
		};
	} catch (error) {
		const err = toError(error);
		logger.warn("Crash session context getter failed", { err, stack: err.stack });
		return {
			session: null,
			model: null,
		};
	}
}

function formatFatalError(label: string, err: Error): string {
	const name = err.name || "Error";
	const message = err.message || "(no message)";
	const stack = err.stack || "";
	const stackLines = stack.split("\n").slice(1);
	const formattedStack = stackLines.length > 0 ? `\n${stackLines.join("\n")}` : "";
	return `\n[${label}] ${name}: ${message}${formattedStack}\n`;
}

export function writeCrashReport(reason: Reason, err: Error, raw?: unknown): string | undefined {
	try {
		const reportsDir = getReportsDir();
		fs.mkdirSync(reportsDir, { recursive: true });
		const timestamp = new Date().toISOString();
		const reportPath = path.join(reportsDir, `crash-${timestamp.replace(/[:.]/g, "-")}.json`);
		const sessionContext = getCrashSessionContext();
		const report: CrashReport = {
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
	} catch (error) {
		const writeErr = toError(error);
		process.stderr.write(`Crash report write failed: ${writeErr.message}\n`);
		logger.error("Failed to write crash report", { err: writeErr, stack: writeErr.stack });
		return undefined;
	}
}

export function registerSessionContext(getter: () => CrashSessionContext | null | undefined): void {
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
			if (inspectorOpened) return;
			inspectorOpened = true;
			inspector.open(undefined, undefined, false);
			const url = inspector.url();
			process.stderr.write(`Inspector opened: ${url}\n`);
		})
		.on("uncaughtException", async err => {
			process.stderr.write(formatFatalError("Uncaught Exception", err));
			const reportPath = writeCrashReport(Reason.UNCAUGHT_EXCEPTION, err);
			logger.error("Uncaught exception", { err, stack: err.stack, reportPath });
			await runCleanup(Reason.UNCAUGHT_EXCEPTION);
			process.exit(1);
		})
		.on("unhandledRejection", async reason => {
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
} else {
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
	} catch {
		// Ignore flush failures during shutdown
	}
});

/**
 * Register a process cleanup callback, to be run on shutdown, signal, or fatal error.
 *
 * Returns a Callback instance that can be used to cancel (unregister) or manually clean up.
 * If register is called after cleanup already began, invokes callback on a microtask.
 */
export function register(id: string, callback: (reason: Reason) => void | Promise<void>): () => void {
	let done = false;
	const exec = (reason: Reason) => {
		if (done) return;
		done = true;
		try {
			return callback(reason);
		} catch (e) {
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
		} catch (e) {
			const err = e instanceof Error ? e : new Error(String(e));
			logger.error("Cleanup callback failed", { err, id, stack: err.stack });
		}
		return () => {};
	}

	// Register callback as "armed" (active).
	callbackList.push(exec);
	return cancel;
}

/**
 * Runs all cleanup callbacks without exiting.
 * Use this in workers or when you need to clean up but continue execution.
 */
export function cleanup(): Promise<void> {
	return runCleanup(Reason.MANUAL);
}

/**
 * Runs all cleanup callbacks and exits.
 *
 * In main thread: waits for stdout drain, then calls process.exit().
 * In workers: runs cleanup only (process.exit would kill entire process).
 */
export async function quit(code: number = 0): Promise<void> {
	await runCleanup(Reason.MANUAL);

	if (!isMainThread) {
		return; // Workers: cleanup done, let worker exit naturally
	}

	if (process.stdout.writableLength > 0) {
		const { promise, resolve } = Promise.withResolvers<void>();
		process.stdout.once("drain", resolve);
		await Promise.race([promise, Bun.sleep(5000)]);
	}
	process.exit(code);
}
