import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { loadConfig } from "../src/config/loader";
import { startSpellServer } from "../src/server";

const VALID_SERVER_KDL = `http {
	port 0
	auth {
		username "spell"
		password "secret" // pragma: allowlist secret
	}
	webhook-secret "webhook-secret" // pragma: allowlist secret
	goal-token "incoming" "goal-token"
}
`;

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
}
`;

const FULL_CHANNELS_KDL = `telegram {
	bot-token "123456:ABC-DEF"
	default-model "claude-sonnet-4-5"
	owners 12345
	project "spell" "/tmp/spell"
	user 12345 {
		modes "telegram-readonly" "telegram-full"
		default-mode "telegram-readonly"
	}
}
`;

const MINIMAL_CHANNELS_KDL = `telegram {
	bot-token "123456:ABC-DEF"
	default-model "claude-sonnet-4-5"
	owners 12345
}
`;

const tempDirs = new Set<string>();

afterEach(async () => {
	await Promise.allSettled(
		[...tempDirs].map(async tempDir => {
			tempDirs.delete(tempDir);
			await fs.rm(tempDir, { recursive: true, force: true });
		}),
	);
});

describe("startSpellServer lifecycle", () => {
	it("reports telegramBotActive for full telegram config", async () => {
		const config = await loadConfig(
			await createConfigDir({
				"server.kdl": VALID_SERVER_KDL,
				"autonomy.kdl": VALID_MANIFEST_KDL,
				"channels.kdl": FULL_CHANNELS_KDL,
			}),
		);
		const fakeBotService = new FakeTelegramBotService();
		const server = await startSpellServer(config, process.cwd(), {
			createTelegramBotService: () => fakeBotService,
		});

		try {
			expect(server.telegramBotActive).toBe(true);
			expect(fakeBotService.startCalls).toBe(1);
		} finally {
			await server.stop();
		}
	});

	it("passes the operator action bridge into the telegram bot service", async () => {
		const config = await loadConfig(
			await createConfigDir({
				"server.kdl": VALID_SERVER_KDL,
				"autonomy.kdl": VALID_MANIFEST_KDL,
				"channels.kdl": FULL_CHANNELS_KDL,
			}),
		);
		const fakeBotService = new FakeTelegramBotService();
		const operatorActionHandler = () => ({
			articleId: "article-1",
			workflowState: "FEED_APPROVED",
			triggeredGoals: ["feed-delivery-goal"],
			duplicate: false,
			downstreamJobs: [],
		});
		let receivedOptions: { operatorActionBridge?: unknown } | undefined;
		const server = await startSpellServer(config, process.cwd(), {
			operatorActionHandler,
			createTelegramBotService: options => {
				receivedOptions = options;
				return fakeBotService;
			},
		});

		try {
			expect(receivedOptions?.operatorActionBridge).toBe(operatorActionHandler);
		} finally {
			await server.stop();
		}
	});

	it("stays in notification-only mode for minimal telegram config", async () => {
		const config = await loadConfig(
			await createConfigDir({
				"server.kdl": VALID_SERVER_KDL,
				"autonomy.kdl": VALID_MANIFEST_KDL,
				"channels.kdl": MINIMAL_CHANNELS_KDL,
			}),
		);
		let createCalls = 0;
		const server = await startSpellServer(config, process.cwd(), {
			createTelegramBotService: () => {
				createCalls += 1;
				return new FakeTelegramBotService();
			},
		});

		try {
			expect(server.telegramBotActive).toBe(false);
			expect(createCalls).toBe(0);
		} finally {
			await server.stop();
		}
	});

	it("stays inactive when channels.kdl is omitted", async () => {
		const config = await loadConfig(
			await createConfigDir({
				"server.kdl": VALID_SERVER_KDL,
				"autonomy.kdl": VALID_MANIFEST_KDL,
			}),
		);
		let createCalls = 0;
		const server = await startSpellServer(config, process.cwd(), {
			createTelegramBotService: () => {
				createCalls += 1;
				return new FakeTelegramBotService();
			},
		});

		try {
			expect(server.telegramBotActive).toBe(false);
			expect(createCalls).toBe(0);
		} finally {
			await server.stop();
		}
	});

	it("propagates telegram bot startup failures for full config", async () => {
		const config = await loadConfig(
			await createConfigDir({
				"server.kdl": VALID_SERVER_KDL,
				"autonomy.kdl": VALID_MANIFEST_KDL,
				"channels.kdl": FULL_CHANNELS_KDL,
			}),
		);
		const fakeBotService = new FakeTelegramBotService({ startError: new Error("bot startup failed") });

		await expect(
			startSpellServer(config, process.cwd(), {
				createTelegramBotService: () => fakeBotService,
			}),
		).rejects.toThrow("bot startup failed");
		expect(fakeBotService.startCalls).toBe(1);
		expect(fakeBotService.stopCalls).toBe(1);
	});

	it("waits for telegram bot shutdown before stop resolves", async () => {
		const config = await loadConfig(
			await createConfigDir({
				"server.kdl": VALID_SERVER_KDL,
				"autonomy.kdl": VALID_MANIFEST_KDL,
				"channels.kdl": FULL_CHANNELS_KDL,
			}),
		);
		const fakeBotService = new FakeTelegramBotService({ stopDeferred: true });
		const server = await startSpellServer(config, process.cwd(), {
			createTelegramBotService: () => fakeBotService,
		});

		const stopPromise = server.stop();
		const beforeBotStops = await Promise.race([
			stopPromise.then(() => "stopped" as const),
			Bun.sleep(20).then(() => "waiting" as const),
		]);
		expect(beforeBotStops).toBe("waiting");
		fakeBotService.releaseStop();
		await stopPromise;
		expect(fakeBotService.stopCalls).toBe(1);
	});
});

class FakeTelegramBotService {
	startCalls = 0;
	stopCalls = 0;
	#startError?: Error;
	#stopGate = Promise.withResolvers<void>();
	#deferStop: boolean;

	constructor(options: { startError?: Error; stopDeferred?: boolean } = {}) {
		this.#startError = options.startError;
		this.#deferStop = options.stopDeferred ?? false;
		if (!this.#deferStop) {
			this.#stopGate.resolve();
		}
	}

	async start(): Promise<void> {
		this.startCalls += 1;
		if (this.#startError) {
			throw this.#startError;
		}
	}

	async stop(): Promise<void> {
		this.stopCalls += 1;
		await this.#stopGate.promise;
	}

	releaseStop(): void {
		this.#stopGate.resolve();
	}
}

async function createConfigDir(files: Record<string, string>): Promise<string> {
	const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "spell-server-lifecycle-"));
	tempDirs.add(tempDir);
	for (const [name, content] of Object.entries(files)) {
		await Bun.write(path.join(tempDir, name), content);
	}
	return tempDir;
}
