import { logger } from "@oh-my-pi/pi-utils";
import type { GoalExecutionController } from "../executor/goal-executor";
import type { AutonomyManifest } from "../manifest/types";
import type { GoalScheduler } from "../scheduler/goal-scheduler";
import type { StateStoreManager } from "../state/store-manager";
import { handleArtifactsRoute } from "../web/artifacts/router";
import type { ArtifactRequestDeps } from "../web/artifacts/types";
import type { WebSubsystem } from "../web/ws/server";
import type { WorkflowEngine } from "../workflow/engine";
import { verifyBasicAuth } from "./auth";
import frontendHtml from "./frontend/index.html" with { type: "text" };
import {
	handleApplyApprovalAction,
	handleClaimApproval,
	handleCreateApproval,
	handleGetApproval,
	handleListApprovals,
	handleReleaseApprovalClaim,
} from "./routes/approvals";
import { handleGetDownstreamJob, handleListDownstreamJobs } from "./routes/downstream-jobs";
import { handleGetGoal, handleGetGoalLogs, handleGetGoalRuns, handleGetGoals, handleGetManifest } from "./routes/goals";
import { handleOperatorActionsRoute, type OperatorActionHandler } from "./routes/operator-actions";
import { handleListStores, handleListTables, handleQueryTable, handleTableCount } from "./routes/state";
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
	stateStoreManager?: StateStoreManager;
	workflowEngine?: WorkflowEngine;
	web?: WebSubsystem;
	webAssetServer?: (request: Request) => Promise<Response | null> | Response | null;
	artifactDeps?: ArtifactRequestDeps;
}

const CORS_HEADERS = {
	"Access-Control-Allow-Origin": "*",
	"Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
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

function requireWorkflowEngine(engine: WorkflowEngine | undefined): WorkflowEngine {
	if (!engine) {
		throw new Error("Workflow engine is not configured");
	}
	return engine;
}

async function handleApiRoute(request: Request, path: string, deps: SpellServerDeps): Promise<Response> {
	if (path === "/api/goals") {
		return handleGetGoals(deps.executor, deps.scheduler, deps.manifest);
	}
	if (path === "/api/manifest") {
		return handleGetManifest(deps.manifest);
	}
	if (path === "/api/state") {
		const stateStoreManager = deps.stateStoreManager;
		if (!stateStoreManager) {
			return Response.json({ error: "State store manager is not configured" }, { status: 501 });
		}
		if (request.method === "GET") {
			return handleListStores(stateStoreManager);
		}
		return Response.json({ error: "Method not allowed" }, { status: 405 });
	}
	if (path === "/api/operator-actions") {
		return await handleOperatorActionsRoute(request, deps.operatorActionHandler);
	}
	if (path === "/api/approvals") {
		const workflowEngine = requireWorkflowEngine(deps.workflowEngine);
		if (request.method === "GET") {
			return handleListApprovals(request, workflowEngine);
		}
		if (request.method === "POST") {
			return await handleCreateApproval(request, workflowEngine);
		}
		return Response.json({ error: "Method not allowed" }, { status: 405 });
	}
	if (path === "/api/downstream-jobs") {
		const workflowEngine = requireWorkflowEngine(deps.workflowEngine);
		if (request.method === "GET") {
			return handleListDownstreamJobs(request, workflowEngine);
		}
		return Response.json({ error: "Method not allowed" }, { status: 405 });
	}

	const segments = path.split("/").filter(Boolean);
	if (segments[1] === "state") {
		const stateStoreManager = deps.stateStoreManager;
		if (!stateStoreManager) {
			return Response.json({ error: "State store manager is not configured" }, { status: 501 });
		}
		const storeName = segments[2];
		const tableSegment = segments[3];
		const tableName = segments[4];
		const action = segments[5];
		if (segments.length === 4 && tableSegment === "tables" && request.method === "GET" && storeName) {
			return handleListTables(storeName, stateStoreManager);
		}
		if (segments.length === 5 && tableSegment === "tables" && request.method === "GET" && storeName && tableName) {
			return handleQueryTable(storeName, tableName, request, stateStoreManager);
		}
		if (
			segments.length === 6 &&
			tableSegment === "tables" &&
			action === "count" &&
			request.method === "GET" &&
			storeName &&
			tableName
		) {
			return handleTableCount(storeName, tableName, stateStoreManager);
		}
		return Response.json({ error: "Not found" }, { status: 404 });
	}
	if (segments[1] === "goals") {
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
	if (segments[1] === "approvals") {
		const workflowEngine = requireWorkflowEngine(deps.workflowEngine);
		const itemId = segments[2];
		const action = segments[3];
		if (!itemId) {
			return Response.json({ error: "Not found" }, { status: 404 });
		}
		if (segments.length === 3 && request.method === "GET") {
			return handleGetApproval(itemId, workflowEngine);
		}
		if (segments.length === 4 && action === "claim" && request.method === "POST") {
			return await handleClaimApproval(itemId, request, workflowEngine);
		}
		if (segments.length === 4 && action === "claim" && request.method === "DELETE") {
			return await handleReleaseApprovalClaim(itemId, request, workflowEngine);
		}
		if (segments.length === 4 && action === "actions" && request.method === "POST") {
			return await handleApplyApprovalAction(itemId, request, workflowEngine);
		}
		return Response.json({ error: "Not found" }, { status: 404 });
	}
	if (segments[1] === "downstream-jobs") {
		const workflowEngine = requireWorkflowEngine(deps.workflowEngine);
		const jobId = segments[2];
		if (!jobId) {
			return Response.json({ error: "Not found" }, { status: 404 });
		}
		if (segments.length === 3 && request.method === "GET") {
			return handleGetDownstreamJob(jobId, workflowEngine);
		}
		return Response.json({ error: "Not found" }, { status: 404 });
	}
	return Response.json({ error: "Not found" }, { status: 404 });
}

export async function handleRequest(request: Request, deps: SpellServerDeps): Promise<Response> {
	const url = new URL(request.url);
	const path = url.pathname;

	if (request.method === "OPTIONS") {
		return withCors(new Response(null, { status: 204 }));
	}
	if (deps.artifactDeps && path.startsWith("/web/artifacts/")) {
		const response = await handleArtifactsRoute(request, deps.artifactDeps);
		if (response) return withCors(response);
	}
	if (deps.web) {
		const restResponse = await deps.web.handleRest(request);
		if (restResponse) return withCors(restResponse);
	}
	if (deps.webAssetServer && path.startsWith("/web")) {
		const assetResponse = await deps.webAssetServer(request);
		if (assetResponse) return withCors(assetResponse);
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
		try {
			return withCors(await handleApiRoute(request, path, deps));
		} catch (error) {
			if (error instanceof Error && error.message === "Workflow engine is not configured") {
				return withCors(Response.json({ error: error.message }, { status: 501 }));
			}
			if (
				error instanceof Error &&
				/^Invalid .*payload|Invalid JSON body|Action .* requires a reason|Unknown workflow/.test(error.message)
			) {
				return withCors(Response.json({ error: error.message }, { status: 400 }));
			}
			if (error instanceof Error && /must be claimed|already claimed|claimed by/.test(error.message)) {
				return withCors(Response.json({ error: error.message }, { status: 409 }));
			}
			throw error;
		}
	}
	if (path.startsWith("/trigger/") && request.method === "POST") {
		const triggerId = path.slice("/trigger/".length);
		return withCors(
			await handleTriggerRoute(triggerId, request, deps.executor, deps.manifest, deps.config, deps.cwd),
		);
	}
	return withCors(Response.json({ error: "Not found" }, { status: 404 }));
}

export function startHttpServer(deps: SpellServerDeps): {
	server: { port?: number; stop: () => void };
	stop: () => void;
} {
	const webHandler = deps.web?.websocketHandler();
	const fetcher = (
		request: Request,
		srv: { upgrade: (req: Request, opts?: unknown) => boolean },
	): Promise<Response> | undefined => {
		if (deps.web?.tryUpgrade(request, srv as never)) return undefined;
		return handleRequest(request, deps).catch(error => {
			logger.error("HTTP request failed", { path: new URL(request.url).pathname, error: String(error) });
			return withCors(Response.json({ error: "Internal server error" }, { status: 500 }));
		});
	};
	// Bun.serve splits its overloads on whether `websocket` is present;
	// route through `unknown` so callers observe a single uniform surface.
	const common = { port: deps.config.port, fetch: fetcher } as unknown as Parameters<typeof Bun.serve>[0];
	const withWs = { ...common, websocket: webHandler } as unknown as Parameters<typeof Bun.serve>[0];
	const server = (webHandler ? Bun.serve(withWs) : Bun.serve(common)) as unknown as { port: number; stop: () => void };
	if (deps.web) deps.web.registerFanout();
	return { server, stop: () => server.stop() };
}
