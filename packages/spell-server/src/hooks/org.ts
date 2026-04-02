import * as fs from "node:fs/promises";
import * as path from "node:path";
import { isEnoent, logger } from "@oh-my-pi/pi-utils";
import { $ } from "bun";
import type { GoalResult, GoalRun } from "../executor/types";
import type { OrgHook } from "../manifest/types";
import type { HookContext, HookExecutor } from "./types";

const DEFAULT_FAILURE_CATEGORY = "BUG";
const TASKS_DIR_NAME = "!tasks";

function buildOrgTitle(goalName: string, status: GoalResult["status"]): string {
	return status === "failure" ? `Goal failure: ${goalName}` : `Goal ${status}: ${goalName}`;
}

function formatRunLine(run: GoalRun): string {
	const completedAt = run.completedAt?.toISOString() ?? "in-progress";
	const errorSuffix = run.error ? ` error=${run.error}` : "";
	return `- ${run.runId} attempt=${run.attempt} status=${run.status} completedAt=${completedAt}${errorSuffix}`;
}

function buildOrgBody(result: GoalResult, context: HookContext): string {
	const lines = [
		`Goal: ${context.goalName}`,
		`Status: ${result.status}`,
		`Timestamp: ${context.timestamp.toISOString()}`,
		`DurationMs: ${result.duration}`,
	];
	if (result.summary) {
		lines.push("", "Summary:", result.summary);
	}
	if (result.error) {
		lines.push("", "Error:", result.error);
	}
	if (result.runs.length > 0) {
		lines.push("", "Runs:", ...result.runs.map(formatRunLine));
	}
	return lines.join("\n");
}

async function hasTasksDir(cwd: string): Promise<boolean> {
	try {
		const stat = await fs.stat(path.join(cwd, TASKS_DIR_NAME));
		return stat.isDirectory();
	} catch (error) {
		if (isEnoent(error)) {
			return false;
		}
		throw error;
	}
}

interface OrgHookExecutorOptions {
	spellBinary?: string | null;
	cwd?: string;
}

export class OrgHookExecutor implements HookExecutor {
	#spellBinaryOverride: string | null | undefined;
	#cwd: string | undefined;

	constructor(options: OrgHookExecutorOptions = {}) {
		this.#spellBinaryOverride = options.spellBinary;
		this.#cwd = options.cwd;
	}

	async execute(target: OrgHook, result: GoalResult, context: HookContext): Promise<void> {
		const category = target.category ?? (result.status === "failure" ? DEFAULT_FAILURE_CATEGORY : undefined);
		if (!category) {
			logger.debug("Skipping org hook without category", { goalName: context.goalName, status: result.status });
			return;
		}

		const cwd = this.#cwd ?? process.cwd();
		const spellBinary = this.#spellBinaryOverride === undefined ? Bun.which("spell") : this.#spellBinaryOverride;
		if (!spellBinary) {
			logger.warn("Skipping org hook because spell CLI is unavailable", {
				goalName: context.goalName,
				category,
				status: result.status,
			});
			return;
		}
		if (!(await hasTasksDir(cwd))) {
			logger.warn("Skipping org hook because !tasks directory is missing", {
				goalName: context.goalName,
				category,
				cwd,
			});
			return;
		}

		try {
			const command =
				await $`${spellBinary} org create category=${category} title=${buildOrgTitle(context.goalName, result.status)} body=${buildOrgBody(result, context)}`
					.cwd(cwd)
					.quiet()
					.nothrow();
			if (command.exitCode === 0) {
				logger.debug("Org hook created item", { goalName: context.goalName, category, status: result.status });
				return;
			}
			const stderr = command.stderr.toString().trim();
			const stdout = command.text().trim();
			logger.warn("Org hook execution failed", {
				goalName: context.goalName,
				category,
				error: stderr || stdout || `spell exited with code ${command.exitCode}`,
			});
		} catch (error) {
			logger.warn("Org hook execution failed", {
				goalName: context.goalName,
				category,
				error: String(error),
			});
		}
	}
}
