import { logger } from "@oh-my-pi/pi-utils";
import type { RpcClient, RpcEvent } from "@oh-my-pi/telegram-bridge";
import type { AutonomyManifest, FilterConfig, ManifestGoal, ManifestSetup } from "../manifest/types";
import type { SessionManager } from "../session/session-manager";
import type { BaseSpawnOptions } from "../session/types";
import { removeSandboxPolicy, writeSandboxPolicy } from "./sandbox-writer";
import { type GoalExecutionState, transition } from "./state";
import type { GoalResult, GoalRun, GoalRunStatus } from "./types";

const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_INITIAL_DELAY_MS = 5_000;
const DEFAULT_DELAY_MULTIPLIER = 2;
const TIMEOUT_ERROR_PREFIX = "Goal execution timed out after";

interface GoalExecutionControllerOptions {
	sessionManager: SessionManager<string>;
	manifest: AutonomyManifest;
	onHook?: (goalName: string, result: GoalResult) => void | Promise<void>;
	onEscalation?: (goalName: string, error: string) => void | Promise<void>;
	now?: () => number;
	sleep?: (ms: number) => Promise<void>;
}

interface AttemptResult {
	summary?: string;
}

export class GoalExecutionController {
	#sessionManager: SessionManager<string>;
	#manifest: AutonomyManifest;
	#states = new Map<string, GoalExecutionState>();
	#runs = new Map<string, GoalRun[]>();
	#activeSandboxFiles = new Map<string, string>();
	#onHook?: (goalName: string, result: GoalResult) => void | Promise<void>;
	#onEscalation?: (goalName: string, error: string) => void | Promise<void>;
	#now: () => number;
	#sleep: (ms: number) => Promise<void>;

	constructor(options: GoalExecutionControllerOptions) {
		this.#sessionManager = options.sessionManager;
		this.#manifest = options.manifest;
		this.#onHook = options.onHook;
		this.#onEscalation = options.onEscalation;
		this.#now = options.now ?? (() => Date.now());
		this.#sleep = options.sleep ?? (ms => Bun.sleep(ms));
	}

	async executeGoal(goalName: string, cwd: string): Promise<GoalResult> {
		const goal = this.#manifest.goals.get(goalName);
		if (!goal) {
			throw new Error(`Unknown goal: ${goalName}`);
		}

		const setup = this.#manifest.setups.get(goal.setup);
		if (!setup) {
			throw new Error(`Unknown setup: ${goal.setup}`);
		}

		const currentState = this.getState(goalName);
		if (currentState === "running") {
			throw new Error(`Goal '${goalName}' is already running`);
		}
		if (currentState === "paused") {
			throw new Error(`Goal '${goalName}' is paused after escalation`);
		}
		if (currentState !== "pending") {
			this.#states.set(goalName, "pending");
		}

		return this.#runWithRetry(goalName, goal, setup, cwd);
	}

	getState(goalName: string): GoalExecutionState {
		return this.#states.get(goalName) ?? "pending";
	}

	getRunHistory(goalName: string): GoalRun[] {
		const runs = this.#runs.get(goalName) ?? [];
		return runs.map(run => ({ ...run }));
	}

	getAllGoalStates(): Map<string, GoalExecutionState> {
		return new Map(this.#states);
	}

	async #runWithRetry(goalName: string, goal: ManifestGoal, setup: ManifestSetup, cwd: string): Promise<GoalResult> {
		const startedAt = this.#now();
		const runs: GoalRun[] = [];
		this.#runs.set(goalName, runs);

		const retryConfig = goal.retry;
		const maxRetries = retryConfig?.maxRetries ?? DEFAULT_MAX_RETRIES;
		const initialDelayMs = retryConfig?.initialDelayMs ?? DEFAULT_INITIAL_DELAY_MS;
		const multiplier = retryConfig?.multiplier ?? DEFAULT_DELAY_MULTIPLIER;

		let delayMs = initialDelayMs;
		let lastError: Error | null = null;
		let lastSummary: string | undefined;

		for (let attempt = 1; attempt <= maxRetries + 1; attempt += 1) {
			this.#moveTo(goalName, attempt === 1 ? "running" : "running", attempt === 1 ? "pending" : "retrying");

			const run: GoalRun = {
				runId: `${goalName}-${startedAt}-${attempt}`,
				goalName,
				startedAt: new Date(this.#now()),
				status: "running",
				attempt,
			};
			runs.push(run);

			try {
				const attemptResult = await this.#executeAttempt(goalName, goal, setup, cwd);
				lastSummary = attemptResult.summary;
				run.status = "completed";
				run.completedAt = new Date(this.#now());
				this.#moveTo(goalName, "completed");

				const result: GoalResult = {
					goalName,
					status: "success",
					duration: this.#now() - startedAt,
					summary: attemptResult.summary,
					runs: runs.map(currentRun => ({ ...currentRun })),
				};

				if (this.#onHook) {
					await this.#onHook(goalName, result);
				}
				return result;
			} catch (error) {
				const normalized = toError(error);
				lastError = normalized;
				run.status = this.#classifyRunStatus(normalized);
				run.error = normalized.message;
				run.completedAt = new Date(this.#now());
				this.#moveTo(goalName, "failed");

				if (attempt <= maxRetries) {
					this.#moveTo(goalName, "retrying");
					await this.#sleep(delayMs);
					delayMs = Math.max(delayMs, 1) * multiplier;
				}
			}
		}

		const errorMessage = lastError?.message ?? "Goal execution failed";
		this.#moveTo(goalName, "escalated", "failed");
		logger.warn("Goal execution escalated after retries exhausted", { goalName, error: errorMessage });
		if (this.#onEscalation) {
			await this.#onEscalation(goalName, errorMessage);
		}
		this.#moveTo(goalName, "paused");

		return {
			goalName,
			status: "failure",
			duration: this.#now() - startedAt,
			error: errorMessage,
			summary: lastSummary,
			runs: runs.map(run => ({ ...run })),
		};
	}

	async #executeAttempt(
		goalName: string,
		goal: ManifestGoal,
		setup: ManifestSetup,
		cwd: string,
	): Promise<AttemptResult> {
		const sandboxPolicyPath = setup.sandbox ? await writeSandboxPolicy(setup.sandbox) : undefined;
		if (sandboxPolicyPath) {
			this.#activeSandboxFiles.set(goalName, sandboxPolicyPath);
		}

		try {
			const client = await this.#sessionManager.getOrCreate(
				goalName,
				this.#buildSpawnOptions(goal, setup, cwd, sandboxPolicyPath),
			);
			return await this.#promptUntilSettled(goalName, client, goal.prompt, setup.timeout);
		} finally {
			await this.#cleanupSandbox(goalName);
		}
	}

	#buildSpawnOptions(
		_goal: ManifestGoal,
		setup: ManifestSetup,
		cwd: string,
		sandboxPolicyPath?: string,
	): BaseSpawnOptions {
		const tools = this.#resolveAllowedValues(setup.tools);
		return {
			cwd,
			tools,
			appendSystemPrompt: undefined,
			sandboxPolicyPath,
		};
	}

	#resolveAllowedValues(filter?: FilterConfig): string[] {
		if (!filter?.allow) {
			return [];
		}
		const deny = new Set(filter.deny ?? []);
		return filter.allow.filter(tool => !deny.has(tool));
	}

	async #promptUntilSettled(
		goalName: string,
		client: RpcClient,
		prompt: string,
		timeout?: string,
	): Promise<AttemptResult> {
		let summaryText = "";
		const eventListener = (event: RpcEvent) => {
			if (event.type !== "message_update") {
				return;
			}
			const assistantEvent = event.assistantMessageEvent;
			if (assistantEvent.type === "text_delta") {
				summaryText += assistantEvent.delta;
				return;
			}
			if (assistantEvent.type === "text_end") {
				summaryText = assistantEvent.content;
			}
		};
		client.onEvent(eventListener);

		const timeoutMs = timeout ? parseTimeoutMs(timeout) : null;
		let timeoutTimer: Timer | undefined;
		let didTimeOut = false;

		try {
			const promptPromise = client.prompt(prompt);
			if (timeoutMs === null) {
				await this.#awaitPrompt(promptPromise);
			} else {
				const timeoutDeferred = Promise.withResolvers<void>();
				timeoutTimer = setTimeout(() => {
					didTimeOut = true;
					timeoutDeferred.reject(new Error(`${TIMEOUT_ERROR_PREFIX} ${timeoutMs}ms`));
					void this.#sessionManager.kill(goalName).catch(error => {
						logger.warn("Failed to kill timed out goal session", { goalName, error: String(error) });
					});
				}, timeoutMs);
				if (timeoutTimer && "unref" in timeoutTimer) {
					(timeoutTimer as NodeJS.Timeout).unref();
				}
				await Promise.race([this.#awaitPrompt(promptPromise), timeoutDeferred.promise]);
			}
		} catch (error) {
			const normalized = toError(error);
			if (!didTimeOut && isZeroExitError(normalized)) {
				return { summary: cleanSummary(summaryText) };
			}
			throw normalized;
		} finally {
			if (timeoutTimer) {
				clearTimeout(timeoutTimer);
			}
			client.offEvent(eventListener);
		}

		return { summary: cleanSummary(summaryText) };
	}

	async #awaitPrompt(promptPromise: Promise<void>): Promise<void> {
		await promptPromise;
	}

	#classifyRunStatus(error: Error): GoalRunStatus {
		if (error.message.startsWith(TIMEOUT_ERROR_PREFIX)) {
			return "timeout";
		}
		return "failed";
	}

	async #cleanupSandbox(goalName: string): Promise<void> {
		const sandboxFile = this.#activeSandboxFiles.get(goalName);
		if (!sandboxFile) {
			return;
		}
		this.#activeSandboxFiles.delete(goalName);
		await removeSandboxPolicy(sandboxFile);
	}

	#moveTo(goalName: string, nextState: GoalExecutionState, expectedCurrent?: GoalExecutionState): void {
		const currentState = this.getState(goalName);
		const fromState = expectedCurrent ?? currentState;
		if (expectedCurrent && currentState !== expectedCurrent) {
			throw new Error(`Invalid state transition: ${currentState} -> ${nextState}`);
		}
		this.#states.set(goalName, transition(fromState, nextState));
	}
}

function cleanSummary(summaryText: string): string | undefined {
	const trimmed = summaryText.trim();
	return trimmed ? trimmed : undefined;
}

function isZeroExitError(error: Error): boolean {
	return error.message.includes("RPC process exited with code 0");
}

function toError(error: unknown): Error {
	return error instanceof Error ? error : new Error(String(error));
}

function parseTimeoutMs(value: string): number {
	const trimmed = value.trim();
	const match = /^(\d+(?:\.\d+)?)(ms|s|m|h|d)$/.exec(trimmed);
	if (!match) {
		throw new Error(`Invalid timeout value: ${value}`);
	}

	const amount = Number(match[1]);
	const unit = match[2];
	const unitMultiplier =
		unit === "ms" ? 1 : unit === "s" ? 1_000 : unit === "m" ? 60_000 : unit === "h" ? 3_600_000 : 86_400_000;
	return amount * unitMultiplier;
}
