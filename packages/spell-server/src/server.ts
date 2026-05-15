import { access } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { logger } from "@oh-my-pi/pi-utils";
import type { LoadedConfig } from "./config/loader";
import type { TelegramChannelConfig } from "./config/types";
import { cleanupStaleSandboxPolicies, GoalExecutionController } from "./executor";
import type { GoalResult } from "./executor/types";
import { HookDispatcher } from "./hooks/dispatcher";
import { createNotificationSender } from "./hooks/notification-sender";
import { OrgHookExecutor } from "./hooks/org";
import { TelegramHookExecutor } from "./hooks/telegram";
import type { HookExecutor } from "./hooks/types";
import { WebhookHookExecutor } from "./hooks/webhook";
import type { OperatorActionHandler } from "./http/routes/operator-actions";
import { startHttpServer } from "./http/server";
import { GoalScheduler } from "./scheduler/goal-scheduler";
import { AutonomyLifecycle } from "./session/autonomy-lifecycle";
import { SessionManager } from "./session/session-manager";
import { SocketServer, SocketSessionRegistry } from "./socket";
import { StateStoreManager } from "./state/store-manager";
import { TelegramBotService, type TelegramBotServiceOptions } from "./telegram/service";
import { deriveSigningKey } from "./web/artifacts/signing-key";
import { ArtifactWatcher } from "./web/artifacts/watcher";
import { fallbackPlaceholderResponse, loadWebAssets } from "./web/assets/loader";
import { WebSpawnedLifecycle } from "./web/session/spawned-lifecycle";
import { WebSessionHub } from "./web/session/web-session-hub";
import { TemplateRunner } from "./web/templates/runner";
import { WebSubsystem } from "./web/ws/server";
import { WorkflowEngine } from "./workflow";
import { generateOperatorActionHandler } from "./workflow/operator-action-generator";

export interface SpellServer {
	telegramBotActive: boolean;
	sessionRegistry?: SocketSessionRegistry;
	stop(): Promise<void>;
}

interface SpellServerStartDependencies {
	createTelegramBotService?: (options: TelegramBotServiceOptions) => Pick<TelegramBotService, "start" | "stop">;
	operatorActionHandler?: OperatorActionHandler;
	startHttpServer?: typeof startHttpServer;
}

const PROJECT_OPERATOR_ACTION_HANDLER_PATH = "src/review/operator-action-handler.ts";

interface OperatorActionHandlerModule {
	createOperatorActionHandler?: (options: { cwd: string }) => Promise<OperatorActionHandler> | OperatorActionHandler;
}

async function loadProjectOperatorActionHandler(cwd: string): Promise<OperatorActionHandler | undefined> {
	const modulePath = join(cwd, PROJECT_OPERATOR_ACTION_HANDLER_PATH);
	try {
		await access(modulePath);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			return undefined;
		}
		throw error;
	}

	const module = (await import(pathToFileURL(modulePath).href)) as OperatorActionHandlerModule;
	if (typeof module.createOperatorActionHandler !== "function") {
		throw new Error(
			`Operator action handler module '${modulePath}' must export createOperatorActionHandler(options)`,
		);
	}

	const handler = await module.createOperatorActionHandler({ cwd });
	logger.debug("Loaded project operator action bridge", { modulePath });
	return handler;
}

const SHUTDOWN_DRAIN_TIMEOUT_MS = 30_000;

export async function startSpellServer(
	config: LoadedConfig,
	cwd: string,
	dependencies: SpellServerStartDependencies = {},
): Promise<SpellServer> {
	const lifecycle = new AutonomyLifecycle(config.manifest);
	const sessionManager = new SessionManager<string>({
		lifecycle,
		keyToString: key => key,
	});
	const scheduler = new GoalScheduler();
	const removedSandboxPolicies = await cleanupStaleSandboxPolicies();
	if (removedSandboxPolicies.length > 0) {
		logger.warn("Removed stale sandbox policy files", { count: removedSandboxPolicies.length });
	}
	const notificationSender = createNotificationSender(config.channels);
	const hookExecutors = new Map<string, HookExecutor>([
		["webhook", new WebhookHookExecutor() as HookExecutor],
		["telegram", new TelegramHookExecutor(notificationSender) as HookExecutor],
		["org", new OrgHookExecutor() as HookExecutor],
	]);
	const hookDispatcher = new HookDispatcher(hookExecutors);
	const executor = new GoalExecutionController({
		sessionManager,
		manifest: config.manifest,
		onHook: async (goalName, result) => {
			const goal = config.manifest.goals.get(goalName);
			if (!goal?.hooks) {
				return;
			}
			await hookDispatcher.dispatch(goalName, result, goal.hooks);
		},
		onEscalation: async (goalName, error) => {
			const goal = config.manifest.goals.get(goalName);
			if (!goal?.hooks) {
				return;
			}
			const result: GoalResult = {
				goalName,
				status: "failure",
				duration: 0,
				error,
				runs: executor.getRunHistory(goalName),
			};
			await hookDispatcher.dispatch(goalName, result, goal.hooks);
		},
	});

	for (const [goalName, goal] of config.manifest.goals) {
		if (goal.schedule.type !== "cron") {
			continue;
		}
		scheduler.register({
			goalName,
			cronExpression: goal.schedule.expression,
			timezone: goal.schedule.timezone,
			jitterMs: parseDurationToMs(goal.schedule.jitter),
			callback: async () => {
				await executor.executeGoal(goalName, cwd);
			},
		});
	}

	const workflowEngine = new WorkflowEngine();
	const stateStoreManager = new StateStoreManager(config.manifest, cwd);
	const operatorActionHandler =
		dependencies.operatorActionHandler ??
		(config.manifest.operatorActions.length > 0
			? generateOperatorActionHandler(config.manifest.operatorActions, workflowEngine)
			: await loadProjectOperatorActionHandler(cwd));
	let sessionRegistry: SocketSessionRegistry | undefined;
	let socketServer: SocketServer | undefined;
	if (config.server.socket) {
		sessionRegistry = new SocketSessionRegistry();
		socketServer = new SocketServer(config.server.socket.path, sessionRegistry);
		await socketServer.start();
	}

	let webSubsystem: WebSubsystem | undefined;
	let webAssetServer: ((request: Request) => Promise<Response | null> | Response | null) | undefined;
	let webHub: WebSessionHub | undefined;
	let webWatcher: ArtifactWatcher | undefined;
	let artifactDeps: import("./web/artifacts/types").ArtifactRequestDeps | undefined;
	if (config.server.web) {
		const registry = sessionRegistry ?? new SocketSessionRegistry();
		sessionRegistry = registry;
		const webSessionManager = new SessionManager<string>({
			lifecycle: new WebSpawnedLifecycle(),
			keyToString: key => key,
		});
		webHub = new WebSessionHub({ sessionManager: webSessionManager, registry });
		webWatcher = new ArtifactWatcher();
		const signingKey = deriveSigningKey(config.server);
		artifactDeps = {
			sessionRoots: id => webHub?.getSessionRoot(id),
			web: config.server.web,
			signingKey,
		};
		const templateRunner = new TemplateRunner({ manifest: config.manifest, hub: webHub, cwd });
		webSubsystem = new WebSubsystem({
			server: config.server,
			signingKey,
			registry,
			hub: webHub,
			watcher: webWatcher,
			templateRunner,
			manifest: config.manifest,
		});
		const distDir = resolveSpellWebDist(cwd);
		try {
			const loaded = await loadWebAssets(distDir);
			webAssetServer = loaded.handle;
		} catch (error) {
			logger.warn("web frontend bundle missing", { distDir, error: String(error) });
			webAssetServer = async req =>
				req.url.includes("/web/api/") || req.url.includes("/web/artifacts/") || req.url.includes("/web/ws")
					? null
					: fallbackPlaceholderResponse();
		}
	}

	const startHttpServerImpl = dependencies.startHttpServer ?? startHttpServer;
	const httpServer = startHttpServerImpl({
		executor,
		scheduler,
		manifest: config.manifest,
		config: {
			port: config.server.http.port,
			auth: config.server.http.auth,
			webhookSecret: config.server.http.webhookSecret,
			goalTokens: config.server.http.goalTokens,
		},
		cwd,
		operatorActionHandler,
		stateStoreManager,
		workflowEngine,
		web: webSubsystem,
		webAssetServer,
		artifactDeps,
	});

	const createTelegramBotService =
		dependencies.createTelegramBotService ?? (options => new TelegramBotService(options));
	let telegramBot: Pick<TelegramBotService, "start" | "stop"> | null = null;
	let telegramBotActive = false;
	try {
		if (hasFullTelegramConfig(config.channels.telegram)) {
			telegramBot = createTelegramBotService({
				config: config.channels.telegram,
				operatorActionBridge: operatorActionHandler,
				sessionRegistry,
			});
			await telegramBot.start();
			telegramBotActive = true;
			logger.debug("Telegram bot service started");
		} else if (config.channels.telegram) {
			logger.debug("Telegram notification-only mode (no users/projects configured)");
		}

		scheduler.start();
		logger.debug("Spell server started", {
			port: httpServer.server.port,
			configuredPort: config.server.http.port,
			goals: config.manifest.goals.size,
			telegramBotActive,
		});

		return {
			telegramBotActive,
			sessionRegistry,
			async stop(): Promise<void> {
				scheduler.stop();
				httpServer.stop();
				stateStoreManager.close();
				if (socketServer) {
					await socketServer.stop();
				}

				if (telegramBot) {
					await telegramBot.stop();
				}
				webHub?.stop();
				webWatcher?.stop();

				const inflightGoals = executor.getInflightGoalNames();
				if (inflightGoals.length > 0) {
					logger.warn("Waiting for inflight goals before shutdown", {
						goalNames: inflightGoals,
						timeoutMs: SHUTDOWN_DRAIN_TIMEOUT_MS,
					});
					const drainResult = await executor.waitForInflightGoals(SHUTDOWN_DRAIN_TIMEOUT_MS);
					if (!drainResult.drained) {
						logger.warn("Force-killing inflight goals after shutdown timeout", {
							goalNames: drainResult.activeGoals,
							timeoutMs: SHUTDOWN_DRAIN_TIMEOUT_MS,
						});
					}
				}
				await sessionManager.killAll();
				logger.debug("Spell server stopped");
			},
		};
	} catch (error) {
		scheduler.stop();
		httpServer.stop();
		stateStoreManager.close();
		const cleanupTasks: Array<Promise<unknown>> = [sessionManager.killAll()];
		if (socketServer) {
			cleanupTasks.push(socketServer.stop());
		}
		if (telegramBot) {
			cleanupTasks.push(telegramBot.stop());
		}
		await Promise.allSettled(cleanupTasks);
		throw error;
	}
}

function resolveSpellWebDist(cwd: string): string {
	// Highest precedence: explicit override via env (used by `spell-team-chat`
	// and any custom front-end launcher).
	const override = process.env.SPELL_WEB_DIST;
	if (override && override.length > 0) {
		return override;
	}
	// Prefer the package's own bundled dist (works whether spell-server is
	// installed via the monorepo or as a symlinked dependency); fall back to
	// the workspace layout when running directly from the repo root.
	const pkgRelative = join(import.meta.dir, "..", "web", "dist");
	return pkgRelative ?? join(cwd, "packages/spell-server/web/dist");
}

function parseDurationToMs(value: string | undefined): number {
	if (!value) {
		return 0;
	}
	const match = /^(\d+(?:\.\d+)?)(ms|s|m|h|d)$/.exec(value.trim());
	if (!match) {
		logger.warn("Ignoring invalid cron jitter value", { value });
		return 0;
	}
	const amount = Number(match[1]);
	const unit = match[2];
	if (unit === "ms") return amount;
	if (unit === "s") return amount * 1_000;
	if (unit === "m") return amount * 60_000;
	if (unit === "h") return amount * 3_600_000;
	return amount * 86_400_000;
}

/** Full bot startup requires token + at least one user + at least one project */
function hasFullTelegramConfig(telegram: TelegramChannelConfig | undefined): telegram is TelegramChannelConfig {
	if (!telegram) return false;
	return (
		Boolean(telegram.botToken) && Object.keys(telegram.users).length > 0 && Object.keys(telegram.projects).length > 0
	);
}
