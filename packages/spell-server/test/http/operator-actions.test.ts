import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { loadConfig } from "../../src/config/loader";
import type { GoalExecutionController } from "../../src/executor/goal-executor";
import type { GoalExecutionState } from "../../src/executor/state";
import type { GoalRun } from "../../src/executor/types";
import { startHttpServer } from "../../src/http";
import type { SpellServerDeps } from "../../src/http/server";
import type { AutonomyManifest, ManifestGoal, ManifestSetup } from "../../src/manifest";
import { GoalScheduler } from "../../src/scheduler";
import { startSpellServer } from "../../src/server";
import type { TelegramBotServiceOptions } from "../../src/telegram/service";

class StubExecutor {
	getState(_goalName: string): GoalExecutionState {
		return "pending";
	}

	getRunHistory(_goalName: string): GoalRun[] {
		return [];
	}

	async executeGoal(goalName: string, _cwd: string): Promise<{ goalName: string }> {
		return { goalName };
	}
}

function createManifest(): AutonomyManifest {
	const defaultSetup: ManifestSetup = { domain: "coding" };
	const webhookGoal: ManifestGoal = {
		setup: "default",
		schedule: { type: "webhook", auth: "bearer" },
		prompt: "wait for webhook",
	};
	return {
		name: "spell-server",
		version: "1.0.0",
		setups: new Map([["default", defaultSetup]]),
		goals: new Map([["incoming", webhookGoal]]),
	};
}

const VALID_SERVER_KDL = `http {
	port 0
	auth {
		username "spell"
		password "secret" // pragma: allowlist secret
	}
}`;

const VALID_MANIFEST_KDL = `name "spell-server"
version "1.0.0"
setup "default" {
	domain "coding"
	mode "worker"
}
goal "nightly" {
	setup "default"
	schedule type="cron" expression="0 0 1 1 *"
	prompt "Run nightly checks."
}`;

const FULL_CHANNELS_KDL = `telegram {
	bot-token "123456:ABC-DEF"
	default-model "claude-sonnet-4-5"
	owners 12345
	project "growth" ".."
	user 12345 {
		modes "telegram-readonly" "telegram-full"
		default-mode "telegram-readonly"
		projects "growth"
	}
}`;

const tempDirs = new Set<string>();

afterEach(async () => {
	await Promise.allSettled(
		[...tempDirs].map(async tempDir => {
			tempDirs.delete(tempDir);
			await fs.rm(tempDir, { recursive: true, force: true });
		}),
	);
});

class FakeTelegramBotService {
	startCalls = 0;
	stopCalls = 0;

	async start(): Promise<void> {
		this.startCalls += 1;
	}

	async stop(): Promise<void> {
		this.stopCalls += 1;
	}
}

async function createProjectDir(files: Record<string, string>): Promise<string> {
	const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "spell-operator-actions-"));
	tempDirs.add(tempDir);
	for (const [relativePath, content] of Object.entries(files)) {
		const targetPath = path.join(tempDir, relativePath);
		await fs.mkdir(path.dirname(targetPath), { recursive: true });
		await Bun.write(targetPath, content);
	}
	return tempDir;
}

describe("operator actions route", () => {
	let stop: (() => void) | undefined;
	let baseUrl = "";
	let delegatedRequest: unknown;

	beforeEach(() => {
		const scheduler = new GoalScheduler();
		const executor = new StubExecutor() as unknown as GoalExecutionController;
		delegatedRequest = undefined;
		const started = startHttpServer({
			executor,
			scheduler,
			manifest: createManifest(),
			config: {
				port: 0,
				auth: { username: "spell", password: "secret" }, // pragma: allowlist secret
				goalTokens: { incoming: "goal-token" },
			},
			cwd: "/repo/project",
			frontendHtml: "<html><body>Spell UI</body></html>",
			operatorActionHandler: async request => {
				delegatedRequest = request;
				return {
					articleId: request.articleId,
					workflowState: "FEED_APPROVED",
					triggeredGoals: ["feed-delivery-goal"],
					duplicate: false,
					downstreamJobs: [],
				};
			},
		});
		stop = started.stop;
		baseUrl = `http://127.0.0.1:${started.server.port}`;
	});

	afterEach(() => {
		stop?.();
		stop = undefined;
		baseUrl = "";
		delegatedRequest = undefined;
	});

	it("requires basic auth before delegating operator actions", async () => {
		const response = await fetch(`${baseUrl}/api/operator-actions`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({}),
		});
		expect(response.status).toBe(401);
	});

	it("validates the operator action payload and delegates safe requests", async () => {
		const invalid = await fetch(`${baseUrl}/api/operator-actions`, {
			method: "POST",
			headers: {
				Authorization: `Basic ${Buffer.from("spell:secret").toString("base64")}`,
				"content-type": "application/json",
			},
			body: JSON.stringify({ source: "telegram", articleId: "article-1" }),
		});
		expect(invalid.status).toBe(400);

		const valid = await fetch(`${baseUrl}/api/operator-actions`, {
			method: "POST",
			headers: {
				Authorization: `Basic ${Buffer.from("spell:secret").toString("base64")}`,
				"content-type": "application/json",
			},
			body: JSON.stringify({
				source: "telegram",
				requestId: "req-1",
				articleId: "article-1",
				action: "approve-feed",
				actor: { userId: "123456789", chatId: 801343188, messageId: 12 },
			}),
		});

		expect(valid.status).toBe(200);
		expect(await valid.json()).toEqual({
			articleId: "article-1",
			workflowState: "FEED_APPROVED",
			triggeredGoals: ["feed-delivery-goal"],
			duplicate: false,
			downstreamJobs: [],
		});
		expect(delegatedRequest).toEqual({
			source: "telegram",
			requestId: "req-1",
			articleId: "article-1",
			action: "approve-feed",
			actor: { userId: "123456789", chatId: 801343188, messageId: 12 },
		});
	});

	it("returns 501 when no operator action handler is configured", async () => {
		stop?.();
		const scheduler = new GoalScheduler();
		const executor = new StubExecutor() as unknown as GoalExecutionController;
		const started = startHttpServer({
			executor,
			scheduler,
			manifest: createManifest(),
			config: {
				port: 0,
				auth: { username: "spell", password: "secret" }, // pragma: allowlist secret
			},
			cwd: "/repo/project",
		});
		stop = started.stop;
		baseUrl = `http://127.0.0.1:${started.server.port}`;

		const response = await fetch(`${baseUrl}/api/operator-actions`, {
			method: "POST",
			headers: {
				Authorization: `Basic ${Buffer.from("spell:secret").toString("base64")}`,
				"content-type": "application/json",
			},
			body: JSON.stringify({
				source: "telegram",
				requestId: "req-1",
				articleId: "article-1",
				action: "approve-feed",
				actor: { userId: "123456789", chatId: 801343188 },
			}),
		});

		expect(response.status).toBe(501);
	});
	it("loads the project operator action bridge for both HTTP and Telegram surfaces", async () => {
		const projectDir = await createProjectDir({
			".spell/server.kdl": VALID_SERVER_KDL,
			".spell/autonomy.kdl": VALID_MANIFEST_KDL,
			".spell/channels.kdl": FULL_CHANNELS_KDL,
			"src/review/operator-action-handler.ts": `export async function createOperatorActionHandler({ cwd }) {
				if (!cwd.endsWith("operator-actions-")) {
					// no-op; the test only cares that cwd is provided
				}
				return async request => ({
					articleId: request.articleId,
					workflowState: "FEED_APPROVED",
					triggeredGoals: ["feed-delivery-goal"],
					duplicate: false,
					downstreamJobs: [],
				});
			}`,
		});
		const config = await loadConfig(path.join(projectDir, ".spell"));
		const fakeBotService = new FakeTelegramBotService();
		let capturedHttpHandler: SpellServerDeps["operatorActionHandler"] | undefined;
		let capturedTelegramOptions: TelegramBotServiceOptions | undefined;

		const server = await startSpellServer(config, projectDir, {
			startHttpServer: deps => {
				capturedHttpHandler = deps.operatorActionHandler;
				return { server: { port: 0 } as Bun.Server<undefined>, stop: () => {} };
			},
			createTelegramBotService: options => {
				capturedTelegramOptions = options;
				return fakeBotService;
			},
		});

		try {
			expect(server.telegramBotActive).toBe(true);
			expect(fakeBotService.startCalls).toBe(1);
			expect(typeof capturedHttpHandler).toBe("function");
			expect(capturedTelegramOptions?.operatorActionBridge).toBe(capturedHttpHandler);
			expect(
				await capturedHttpHandler?.({
					source: "telegram",
					requestId: "req-live-1",
					articleId: "article-1",
					action: "approve-feed",
					actor: { userId: "123456789", chatId: 801343188, messageId: 12 },
				}),
			).toEqual({
				articleId: "article-1",
				workflowState: "FEED_APPROVED",
				triggeredGoals: ["feed-delivery-goal"],
				duplicate: false,
				downstreamJobs: [],
			});
		} finally {
			await server.stop();
		}

		expect(fakeBotService.stopCalls).toBe(1);
	});
});
