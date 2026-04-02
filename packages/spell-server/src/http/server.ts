import { logger } from "@oh-my-pi/pi-utils";
import type { GoalExecutionController } from "../executor/goal-executor";
import type { AutonomyManifest } from "../manifest/types";
import type { GoalScheduler } from "../scheduler/goal-scheduler";
import { verifyBasicAuth } from "./auth";
import frontendHtml from "./frontend/index.html" with { type: "text" };
import { handleGetGoal, handleGetGoalLogs, handleGetGoalRuns, handleGetGoals, handleGetManifest } from "./routes/goals";
import { handleOperatorActionsRoute, type OperatorActionHandler } from "./routes/operator-actions";
import { handleTriggerRoute } from "./routes/triggers";
import type { ServerConfig } from "./types";

export interface SpellServerDeps {
	executor: GoalExecutionController;
	scheduler: GoalScheduler;
	manifest: AutonomyManifest;
	config: ServerConfig;
	cwd: string;
	frontendHtml?: string;
	operatorActionHandler?: OperatorActionHandler;
}

const CORS_HEADERS = {
	"Access-Control-Allow-Origin": "*",
	"Access-Control-Allow-Methods": "GET, POST, OPTIONS",
	"Access-Control-Allow-Headers": "Authorization, Content-Type, X-Signature-256",
};

function withCors(response: Response): Response {
	const headers = new Headers(response.headers);
	for (const [name, value] of Object.entries(CORS_HEADERS)) {
		headers.set(name, value);
	}
	return new Response(response.body, {
		status: response.status,
		statusText: response.statusText,
		headers,
	});
}

function unauthorizedResponse(): Response {
	return Response.json({ error: "Unauthorized" }, { status: 401 });
}

async function handleApiRoute(path: string, deps: SpellServerDeps): Promise<Response> {
	if (path === "/api/goals") {
		return handleGetGoals(deps.executor, deps.scheduler, deps.manifest);
	}
	if (path === "/api/manifest") {
		return handleGetManifest(deps.manifest);
	}

	const segments = path.split("/").filter(Boolean);
	const goalName = segments[2];
	const action = segments[3];
	if (!goalName) {
		return Response.json({ error: "Not found" }, { status: 404 });
	}
	if (segments.length === 3) {
		return handleGetGoal(goalName, deps.executor, deps.scheduler, deps.manifest);
	}
	if (segments.length === 4 && action === "runs") {
		return handleGetGoalRuns(goalName, deps.executor, deps.manifest);
	}
	if (segments.length === 4 && action === "logs") {
		return handleGetGoalLogs(goalName, deps.executor, deps.manifest);
	}
	return Response.json({ error: "Not found" }, { status: 404 });
}

export async function handleRequest(request: Request, deps: SpellServerDeps): Promise<Response> {
	const url = new URL(request.url);
	const path = url.pathname;

	if (request.method === "OPTIONS") {
		return withCors(new Response(null, { status: 204 }));
	}
	if ((path === "/" || path === "/index.html") && request.method === "GET") {
		return withCors(
			new Response(String(deps.frontendHtml ?? frontendHtml), {
				headers: { "Content-Type": "text/html; charset=utf-8" },
			}),
		);
	}
	if (path.startsWith("/api/")) {
		if (!verifyBasicAuth(request, deps.config)) {
			return withCors(unauthorizedResponse());
		}
		if (path === "/api/operator-actions") {
			return withCors(await handleOperatorActionsRoute(request, deps.operatorActionHandler));
		}
		return withCors(await handleApiRoute(path, deps));
	}
	if (path.startsWith("/trigger/") && request.method === "POST") {
		const triggerId = path.slice("/trigger/".length);
		return withCors(
			await handleTriggerRoute(triggerId, request, deps.executor, deps.manifest, deps.config, deps.cwd),
		);
	}
	return withCors(Response.json({ error: "Not found" }, { status: 404 }));
}

export function startHttpServer(deps: SpellServerDeps): { server: Bun.Server<undefined>; stop: () => void } {
	const server = Bun.serve({
		port: deps.config.port,
		fetch(request) {
			return handleRequest(request, deps).catch(error => {
				logger.error("HTTP request failed", { path: new URL(request.url).pathname, error: String(error) });
				return withCors(Response.json({ error: "Internal server error" }, { status: 500 }));
			});
		},
	});
	return { server, stop: () => server.stop() };
}
