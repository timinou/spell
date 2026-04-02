import { logger } from "@oh-my-pi/pi-utils";
import type { LoadedConfig } from "./config/loader";
import { GoalExecutionController } from "./executor/goal-executor";
import type { GoalResult } from "./executor/types";
import { HookDispatcher } from "./hooks/dispatcher";
import { NoopNotificationSender, type NotificationSender } from "./hooks/notification-sender";
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

export async function startSpellServer(config: LoadedConfig, cwd: string): Promise<SpellServer> {
	const lifecycle = new AutonomyLifecycle();
	const sessionManager = new SessionManager<string>({
		lifecycle,
		keyToString: key => key,
	});
	const scheduler = new GoalScheduler();
	const notificationSender = createNotificationSender(config);
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
			await sessionManager.killAll();
			logger.debug("Spell server stopped");
		},
	};
}

function createNotificationSender(config: LoadedConfig): NotificationSender {
	const telegramConfig = config.channels.telegram;
	if (!telegramConfig) {
		return new NoopNotificationSender();
	}
	return new TelegramNotificationSender(telegramConfig.botToken, new Set(telegramConfig.owners));
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

class TelegramNotificationSender implements NotificationSender {
	#botToken: string;
	#owners: Set<number>;

	constructor(botToken: string, owners: Set<number>) {
		this.#botToken = botToken;
		this.#owners = owners;
	}

	async sendMessage(chatId: number, text: string): Promise<void> {
		if (!this.#owners.has(chatId)) {
			logger.warn("Skipping Telegram notification for unauthorized chat", { chatId });
			return;
		}

		const response = await fetch(`https://api.telegram.org/bot${this.#botToken}/sendMessage`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ chat_id: chatId, text }),
		});
		if (response.ok) {
			return;
		}

		const responseText = await response.text();
		throw new Error(`Telegram send failed with ${response.status}: ${responseText}`);
	}
}
