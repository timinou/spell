import { logger } from "@oh-my-pi/pi-utils";
import type { LoadedConfig } from "./config/loader";
import { cleanupStaleSandboxPolicies, GoalExecutionController } from "./executor";
import type { GoalResult } from "./executor/types";
import { HookDispatcher } from "./hooks/dispatcher";
import { createNotificationSender } from "./hooks/notification-sender";
import { OrgHookExecutor } from "./hooks/org";
import { TelegramHookExecutor } from "./hooks/telegram";
import type { HookExecutor } from "./hooks/types";
import { WebhookHookExecutor } from "./hooks/webhook";
import { startHttpServer } from "./http/server";
import { GoalScheduler } from "./scheduler/goal-scheduler";
import { AutonomyLifecycle } from "./session/autonomy-lifecycle";
import { SessionManager } from "./session/session-manager";

export interface SpellServer {
	stop(): Promise<void>;
}

const SHUTDOWN_DRAIN_TIMEOUT_MS = 30_000;

export async function startSpellServer(config: LoadedConfig, cwd: string): Promise<SpellServer> {
	const lifecycle = new AutonomyLifecycle();
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

	const httpServer = startHttpServer({
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
	});

	scheduler.start();
	logger.debug("Spell server started", {
		port: httpServer.server.port,
		configuredPort: config.server.http.port,
		goals: config.manifest.goals.size,
	});

	return {
		async stop(): Promise<void> {
			scheduler.stop();
			httpServer.stop();
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
