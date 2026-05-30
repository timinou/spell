import { logger } from "@spell/pi-utils";
import type { GoalExecutionController } from "../../executor/goal-executor";
import type { AutonomyManifest, ManifestGoal } from "../../manifest/types";
import { verifyBearerToken, verifyHmac } from "../auth";
import type { ServerConfig } from "../types";

const MAX_BODY_BYTES = 1024 * 1024;

function normalizeWebhookPath(path: string): string {
	return path.replace(/^\/+|\/+$/g, "");
}

function findTriggeredGoal(triggerId: string, manifest: AutonomyManifest): [string, ManifestGoal] | null {
	const direct = manifest.goals.get(triggerId);
	if (direct) {
		return [triggerId, direct];
	}

	for (const [goalName, goal] of manifest.goals) {
		if (goal.schedule.type !== "webhook" || !goal.schedule.path) {
			continue;
		}
		if (normalizeWebhookPath(goal.schedule.path) === normalizeWebhookPath(triggerId)) {
			return [goalName, goal];
		}
	}

	return null;
}

async function readBodyWithinLimit(request: Request): Promise<string | null> {
	const reader = request.body?.getReader();
	if (!reader) {
		return "";
	}

	const chunks: Uint8Array[] = [];
	let total = 0;
	while (true) {
		const { done, value } = await reader.read();
		if (done) {
			break;
		}
		if (!value) {
			continue;
		}
		total += value.byteLength;
		if (total > MAX_BODY_BYTES) {
			await reader.cancel();
			return null;
		}
		chunks.push(value);
	}

	return Buffer.concat(chunks).toString("utf8");
}

async function authorizeTrigger(
	request: Request,
	goalName: string,
	goal: ManifestGoal,
	config: ServerConfig,
	body: string,
): Promise<boolean> {
	if (goal.schedule.type !== "webhook" || !goal.schedule.auth) {
		return true;
	}

	if (goal.schedule.auth === "hmac") {
		return config.webhookSecret ? await verifyHmac(request, body, config.webhookSecret) : false;
	}

	return config.goalTokens ? verifyBearerToken(request, goalName, config.goalTokens) : false;
}

export async function handleTrigger(
	goalName: string,
	executor: GoalExecutionController,
	manifest: AutonomyManifest,
	cwd: string,
): Promise<Response> {
	if (!manifest.goals.has(goalName)) {
		return Response.json({ error: "Goal not found" }, { status: 404 });
	}
	if (executor.getState(goalName) === "running") {
		return Response.json({ error: "Goal already running" }, { status: 409 });
	}

	void executor.executeGoal(goalName, cwd).catch(error => {
		logger.error("Triggered goal execution failed", { goalName, error: String(error) });
	});
	return Response.json({ message: "Goal triggered", goalName }, { status: 202 });
}

export async function handleTriggerRoute(
	triggerId: string,
	request: Request,
	executor: GoalExecutionController,
	manifest: AutonomyManifest,
	config: ServerConfig,
	cwd: string,
): Promise<Response> {
	const match = findTriggeredGoal(triggerId, manifest);
	if (!match) {
		return Response.json({ error: "Goal not found" }, { status: 404 });
	}

	const [goalName, goal] = match;
	const body = await readBodyWithinLimit(request);
	if (body === null) {
		return Response.json({ error: "Request body too large" }, { status: 413 });
	}

	if (!(await authorizeTrigger(request, goalName, goal, config, body))) {
		return Response.json({ error: "Unauthorized" }, { status: 401 });
	}

	return await handleTrigger(goalName, executor, manifest, cwd);
}
