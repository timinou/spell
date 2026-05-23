/**
 * Bash command execution with streaming support and cancellation.
 *
 * Uses brush-core via native bindings for shell execution.
 */
import * as fs from "node:fs/promises";
import { executeShell, Shell } from "@oh-my-pi/pi-natives";
import { Settings } from "../config/settings";
import { getRetainedSpillBudget, resolveToolSpillPolicy, type SpillPolicy } from "../session/spill-policy";
import { OutputSink } from "../session/streaming-output";
import { getOrCreateSnapshot } from "../utils/shell-snapshot";
import { NON_INTERACTIVE_ENV } from "./non-interactive-env";

export interface BashExecutorOptions {
	cwd?: string;
	timeout?: number;
	onChunk?: (chunk: string) => void;
	signal?: AbortSignal;
	/** Session key suffix to isolate shell sessions per agent */
	sessionKey?: string;
	/** Additional environment variables to inject */
	env?: Record<string, string>;
	/** Artifact path/URI for full output storage */
	artifactPath?: string;
	artifactUri?: string;
	spillPolicy?: SpillPolicy;
	/** PLAN-310 W5: project root for kernel-side URI scheme expansion in bash. */
	schemeRoot?: string;
	/** PLAN-310 W5: user home for UserRoot scheme templates. */
	schemeHome?: string;
	/** PLAN-310 W5: session dir for SessionRoot scheme templates. */
	schemeSessionDir?: string;
}

export interface BashResult {
	output: string;
	exitCode: number | undefined;
	cancelled: boolean;
	truncated: boolean;
	totalLines: number;
	totalBytes: number;
	outputLines: number;
	outputBytes: number;
	artifactUri?: string;
}

const HARD_TIMEOUT_GRACE_MS = 5_000;

const shellSessions = new Map<string, Shell>();
const brokenShellSessions = new Set<string>();

async function resolveShellCwd(cwd: string | undefined): Promise<string | undefined> {
	if (!cwd) return undefined;

	try {
		// Brush preserves the working directory string verbatim, so resolve symlinks
		// up front to keep `pwd` aligned with tools like `git worktree list`.
		return await fs.realpath(cwd);
	} catch {
		return cwd;
	}
}

export async function executeBash(command: string, options?: BashExecutorOptions): Promise<BashResult> {
	const settings = await Settings.init();
	const { shell, env: shellEnv, prefix } = settings.getShellConfig();
	const snapshotPath = shell.includes("bash") ? await getOrCreateSnapshot(shell, shellEnv) : null;
	const commandCwd = await resolveShellCwd(options?.cwd);
	const commandEnv = options?.env ? { ...NON_INTERACTIVE_ENV, ...options.env } : NON_INTERACTIVE_ENV;
	const spillPolicy = options?.spillPolicy ?? resolveToolSpillPolicy({ settings, toolName: "bash" });
	const retainedBudget = getRetainedSpillBudget(spillPolicy);

	const prefixedCommand = prefix ? `${prefix} ${command}` : command;
	const finalCommand = prefixedCommand;

	const sink = new OutputSink({
		onChunk: options?.onChunk,
		artifactPath: options?.artifactPath,
		artifactUri: options?.artifactUri,
		spillThresholdBytes: spillPolicy.trigger.maxBytes,
		spillThresholdLines: spillPolicy.trigger.maxLines,
		retainMaxBytes: retainedBudget.maxBytes,
		retainMaxLines: retainedBudget.maxLines,
	});
	const dump = async (success: boolean, notice?: string) => {
		const budget = success ? spillPolicy.success : spillPolicy.failure;
		return await sink.dump({ notice, maxBytes: budget.maxBytes, maxLines: budget.maxLines });
	};

	let pendingChunks = Promise.resolve();
	const enqueueChunk = (chunk: string) => {
		pendingChunks = pendingChunks.then(() => sink.push(chunk)).catch(() => {});
	};

	if (options?.signal?.aborted) {
		return {
			exitCode: undefined,
			cancelled: true,
			...(await dump(false, "Command cancelled")),
		};
	}

	const sessionKey = buildSessionKey(shell, prefix, snapshotPath, shellEnv, options?.sessionKey);
	const persistentSessionBroken = brokenShellSessions.has(sessionKey);
	if (persistentSessionBroken) {
		shellSessions.delete(sessionKey);
	}

	let shellSession = persistentSessionBroken ? undefined : shellSessions.get(sessionKey);
	if (!shellSession && !persistentSessionBroken) {
		shellSession = new Shell({ sessionEnv: shellEnv, snapshotPath: snapshotPath ?? undefined });
		shellSessions.set(sessionKey, shellSession);
	}
	const userSignal = options?.signal;
	const runAbortController = new AbortController();
	const abortCurrentExecution = () => {
		if (!runAbortController.signal.aborted) {
			runAbortController.abort();
		}
		if (shellSession) {
			void shellSession.abort();
		}
	};
	const abortHandler = () => {
		abortCurrentExecution();
	};
	if (userSignal) {
		userSignal.addEventListener("abort", abortHandler, { once: true });
	}

	let hardTimeoutTimer: NodeJS.Timeout | undefined;
	const hardTimeoutDeferred = Promise.withResolvers<"hard-timeout">();
	const baseTimeoutMs = Math.max(1_000, options?.timeout ?? 300_000);
	const hardTimeoutMs = baseTimeoutMs + HARD_TIMEOUT_GRACE_MS;
	hardTimeoutTimer = setTimeout(() => {
		abortCurrentExecution();
		hardTimeoutDeferred.resolve("hard-timeout");
	}, hardTimeoutMs);

	let resetSession = false;

	try {
		const runPromise = shellSession
			? shellSession.run(
					{
						command: finalCommand,
						cwd: commandCwd,
						env: commandEnv,
						timeoutMs: options?.timeout,
						signal: runAbortController.signal,
					},
					(err, chunk) => {
						if (!err) {
							enqueueChunk(chunk);
						}
					},
				)
			: executeShell(
					{
						command: finalCommand,
						cwd: commandCwd,
						env: commandEnv,
						sessionEnv: shellEnv,
						snapshotPath: snapshotPath ?? undefined,
						timeoutMs: options?.timeout,
						signal: runAbortController.signal,
						root: options?.schemeRoot,
						home: options?.schemeHome,
						sessionDir: options?.schemeSessionDir,
					},
					chunk => {
						enqueueChunk(chunk);
					},
				);

		const winner = await Promise.race([
			runPromise.then(result => ({ kind: "result" as const, result })),
			hardTimeoutDeferred.promise.then(() => ({ kind: "hard-timeout" as const })),
		]);

		await pendingChunks;

		if (winner.kind === "hard-timeout") {
			if (shellSession) {
				resetSession = true;
				brokenShellSessions.add(sessionKey);
			}
			return {
				exitCode: undefined,
				cancelled: true,
				...(await dump(false, `Command exceeded hard timeout after ${Math.round(hardTimeoutMs / 1000)} seconds`)),
			};
		}

		if (winner.result.timedOut) {
			const annotation = options?.timeout
				? `Command timed out after ${Math.round(options.timeout / 1000)} seconds`
				: "Command timed out";
			resetSession = true;
			return {
				exitCode: undefined,
				cancelled: true,
				...(await dump(false, annotation)),
			};
		}

		if (winner.result.cancelled) {
			resetSession = true;
			return {
				exitCode: undefined,
				cancelled: true,
				...(await dump(false, "Command cancelled")),
			};
		}

		return {
			exitCode: winner.result.exitCode,
			cancelled: false,
			...(await dump(winner.result.exitCode === 0)),
		};
	} catch (err) {
		resetSession = true;
		throw err;
	} finally {
		if (hardTimeoutTimer) {
			clearTimeout(hardTimeoutTimer);
		}
		if (userSignal) {
			userSignal.removeEventListener("abort", abortHandler);
		}
		await pendingChunks;
		if (resetSession) {
			shellSessions.delete(sessionKey);
		}
	}
}

function buildSessionKey(
	shell: string,
	prefix: string | undefined,
	snapshotPath: string | null,
	env: Record<string, string>,
	agentSessionKey?: string,
): string {
	const entries = Object.entries(env);
	entries.sort(([a], [b]) => a.localeCompare(b));
	const envSerialized = entries.map(([key, value]) => `${key}=${value}`).join("\n");
	return [agentSessionKey ?? "", shell, prefix ?? "", snapshotPath ?? "", envSerialized].join("\n");
}
