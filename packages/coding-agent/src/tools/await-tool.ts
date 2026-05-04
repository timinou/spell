import type { AgentTool, AgentToolContext, AgentToolResult, AgentToolUpdateCallback } from "@oh-my-pi/pi-agent-core";
import { type Static, Type } from "@sinclair/typebox";
import type { AsyncJob } from "../async";
import { renderPromptTemplate } from "../config/prompt-templates";
import awaitDescription from "../prompts/tools/await.md" with { type: "text" };
import { formatRetryStatus } from "../task/retry-state";
import type { AgentRetryState, TaskToolDetails } from "../task/types";
import type { ToolSession } from "./index";
import { replaceTabs } from "./render-utils";

const awaitSchema = Type.Object({
	jobs: Type.Optional(
		Type.Array(Type.String(), {
			description: "Specific job IDs to wait for. If omitted, waits for any running job.",
		}),
	),
});

type AwaitParams = Static<typeof awaitSchema>;

interface AwaitResult {
	id: string;
	type: "bash" | "task";
	status: "running" | "completed" | "failed" | "cancelled";
	label: string;
	durationMs: number;
	resultText?: string;
	errorText?: string;
	retry?: AgentRetryState;
}

function extractRetryState(
	job: Pick<AsyncJob, "id" | "label" | "type" | "latestProgress">,
): AgentRetryState | undefined {
	if (job.type !== "task") return undefined;
	const details = job.latestProgress?.details as TaskToolDetails | undefined;
	if (!details?.progress) return undefined;
	const matchingProgress = details.progress.find(progress => progress.id === job.label || progress.id === job.id);
	return matchingProgress?.retry;
}

export interface AwaitToolDetails {
	jobs: AwaitResult[];
}

export class AwaitTool implements AgentTool<typeof awaitSchema, AwaitToolDetails> {
	readonly name = "await";
	readonly label = "Await";
	readonly description: string;
	readonly parameters = awaitSchema;
	readonly strict = true;

	constructor(private readonly session: ToolSession) {
		this.description = renderPromptTemplate(awaitDescription);
	}

	static createIf(session: ToolSession): AwaitTool | null {
		if (!session.settings.get("async.enabled")) return null;
		return new AwaitTool(session);
	}

	async execute(
		_toolCallId: string,
		params: AwaitParams,
		signal?: AbortSignal,
		_onUpdate?: AgentToolUpdateCallback<AwaitToolDetails>,
		_context?: AgentToolContext,
	): Promise<AgentToolResult<AwaitToolDetails>> {
		const awaitInvocationTime = Date.now();
		const manager = this.session.asyncJobManager;
		if (!manager) {
			return {
				content: [{ type: "text", text: "Async execution is disabled; no background jobs to poll." }],
				details: { jobs: [] },
			};
		}

		const requestedIds = params.jobs;

		// Resolve which jobs to watch
		const jobsToWatch = requestedIds?.length
			? requestedIds.map(id => manager.getJob(id)).filter(j => j != null)
			: manager.getRunningJobs();

		if (jobsToWatch.length === 0) {
			const message = requestedIds?.length
				? `No matching jobs found for IDs: ${requestedIds.join(", ")}`
				: "No running background jobs to wait for.";
			return {
				content: [{ type: "text", text: message }],
				details: { jobs: [] },
			};
		}

		// Capture initial watched IDs before any auto-promotion can happen
		const initialIds = new Set(jobsToWatch.map(j => j.id));

		// If all watched jobs are already done, return immediately
		const runningJobs = jobsToWatch.filter(j => j.status === "running");
		if (runningJobs.length === 0) {
			return this.#buildResult(manager, jobsToWatch, initialIds, awaitInvocationTime);
		}

		// Block until at least one running job finishes or the call is aborted
		const racePromises: Promise<unknown>[] = runningJobs.map(j => j.promise);

		if (signal) {
			const { promise: abortPromise, resolve: abortResolve } = Promise.withResolvers<void>();
			const onAbort = () => abortResolve();
			signal.addEventListener("abort", onAbort, { once: true });
			racePromises.push(abortPromise);
			try {
				await Promise.race(racePromises);
			} finally {
				signal.removeEventListener("abort", onAbort);
			}
		} else {
			await Promise.race(racePromises);
		}

		if (signal?.aborted) {
			return this.#buildResult(manager, jobsToWatch, initialIds, awaitInvocationTime);
		}

		return this.#buildResult(manager, jobsToWatch, initialIds, awaitInvocationTime);
	}

	#buildResult(
		manager: NonNullable<ToolSession["asyncJobManager"]>,
		jobs: Array<
			Pick<
				AsyncJob,
				"id" | "type" | "status" | "label" | "startTime" | "resultText" | "errorText" | "latestProgress"
			>
		>,
	): AgentToolResult<AwaitToolDetails> {
		const now = Date.now();
		const jobResults: AwaitResult[] = jobs.map(job => {
			const retry = extractRetryState(job);
			return {
				id: job.id,
				type: job.type,
				status: job.status as AwaitResult["status"],
				label: job.label,
				durationMs: Math.max(0, now - job.startTime),
				...(job.resultText ? { resultText: job.resultText } : {}),
				...(job.errorText ? { errorText: job.errorText } : {}),
				...(retry ? { retry } : {}),
			};
		});

		manager.acknowledgeDeliveries(jobResults.filter(job => job.status !== "running").map(job => job.id));

		const completed = jobResults.filter(job => job.status !== "running");
		const running = jobResults.filter(job => job.status === "running");

		const lines: string[] = [];
		if (completed.length > 0) {
			lines.push(`## Completed (${completed.length})\n`);
			for (const job of completed) {
				lines.push(`### ${job.id} [${job.type}] — ${job.status}`);
				lines.push(`Label: ${replaceTabs(job.label)}`);
				if (job.resultText) {
					lines.push("```", job.resultText, "```");
				}
				if (job.errorText) {
					lines.push(`Error: ${replaceTabs(job.errorText)}`);
				}
				lines.push("");
			}
		}

		if (running.length > 0) {
			lines.push(`## Still Running (${running.length})\n`);
			for (const job of running) {
				lines.push(`- \`${job.id}\` [${job.type}] — ${replaceTabs(job.label)}`);
				if (job.retry) {
					lines.push(`  ${replaceTabs(formatRetryStatus(job.retry))}`);
				}
			}
		}

		return {
			content: [{ type: "text", text: lines.join("\n") }],
			details: { jobs: jobResults },
		};
	}
}
