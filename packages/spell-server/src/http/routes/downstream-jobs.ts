import type { WorkflowEngine } from "../../workflow/engine";
import type { DownstreamJobEntry } from "../types";

function toEntry(job: ReturnType<WorkflowEngine["listJobs"]>[number]): DownstreamJobEntry {
	return {
		id: job.id,
		itemId: job.itemId,
		kind: job.kind,
		status: job.status,
		retryEligible: job.retryEligible,
		attempts: job.attempts.map(attempt => ({ ...attempt })),
		updatedAt: job.updatedAt,
	};
}

export function handleListDownstreamJobs(request: Request, engine: WorkflowEngine): Response {
	const url = new URL(request.url);
	const kind = url.searchParams.get("kind") ?? undefined;
	const status = url.searchParams.get("status") ?? undefined;
	const itemId = url.searchParams.get("itemId") ?? undefined;
	return Response.json(
		engine
			.listJobs({
				...(kind ? { kind } : {}),
				...(status ? { status: status as ReturnType<WorkflowEngine["listJobs"]>[number]["status"] } : {}),
				...(itemId ? { itemId } : {}),
			})
			.map(job => toEntry(job)),
	);
}

export function handleGetDownstreamJob(jobId: string, engine: WorkflowEngine): Response {
	const job = engine.listJobs().find(candidate => candidate.id === jobId);
	if (!job) {
		return Response.json({ error: "Downstream job not found" }, { status: 404 });
	}
	return Response.json(toEntry(job));
}
