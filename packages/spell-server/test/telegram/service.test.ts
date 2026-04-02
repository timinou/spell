import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { TelegramBot } from "../../src/telegram/bot/bot";
import { TelegramBotService } from "../../src/telegram/service";
import type { TelegramBridgeConfig } from "../../src/telegram/types";

const tempDirs = new Set<string>();
let originalHome: string | undefined;

afterEach(async () => {
	if (originalHome === undefined) {
		delete process.env.HOME;
	} else {
		process.env.HOME = originalHome;
	}
	await Promise.allSettled(
		[...tempDirs].map(async tempDir => {
			tempDirs.delete(tempDir);
			await fs.rm(tempDir, { recursive: true, force: true });
		}),
	);
});

beforeEach(async () => {
	originalHome = process.env.HOME;
	const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "spell-telegram-service-"));
	tempDirs.add(tempDir);
	const homeDir = path.join(tempDir, "home");
	await fs.mkdir(homeDir, { recursive: true });
	process.env.HOME = homeDir;
});

describe("TelegramBotService.start", () => {
	it("waits for polling startup before resolving", async () => {
		const fakeBot = new FakeTelegramBot();
		const service = new TelegramBotService({ config: testConfig() }, { createBot: () => fakeBot.asTelegramBot() });

		const startPromise = service.start();
		const beforePollingStarts = await Promise.race([
			startPromise.then(() => "resolved" as const),
			Bun.sleep(20).then(() => "pending" as const),
		]);
		expect(beforePollingStarts).toBe("pending");

		await fakeBot.triggerStart();
		await startPromise;
		expect(fakeBot.startCalls).toBe(1);

		await service.stop();
	});

	it("rejects when polling fails before startup completes", async () => {
		const fakeBot = new FakeTelegramBot();
		fakeBot.failStart(new Error("polling failed"));
		const service = new TelegramBotService({ config: testConfig() }, { createBot: () => fakeBot.asTelegramBot() });

		await expect(service.start()).rejects.toThrow("polling failed");
		expect(fakeBot.stopCalls).toBe(1);
	});
});

function testConfig(): TelegramBridgeConfig {
	return {
		botToken: "123:token",
		owners: [123456],
		uploadDir: "/tmp/uploads",
		idleTimeout: 60,
		maxSessions: 2,
		defaultModel: "claude-sonnet-4-5",
		defaultProject: "spell",
		projects: {
			spell: "/home/user/code/ora/spell",
		},
		users: {
			"123456": {
				modes: ["telegram-readonly", "telegram-full"],
				defaultMode: "telegram-readonly",
			},
		},
	};
}

class FakeTelegramBot {
	api = {
		getMe: async () => ({ username: "spellbot" }),
		setMyCommands: async () => undefined,
	};
	startCalls = 0;
	stopCalls = 0;
	#startOptions?: { onStart?: (botInfo: { username?: string }) => void | Promise<void> };
	#polling = Promise.withResolvers<void>();
	#startError?: Error;

	asTelegramBot(): TelegramBot {
		return this as unknown as TelegramBot;
	}

	catch(): this {
		return this;
	}

	use(): this {
		return this;
	}

	command(): this {
		return this;
	}

	callbackQuery(): this {
		return this;
	}

	start(options?: { onStart?: (botInfo: { username?: string }) => void | Promise<void> }): Promise<void> {
		this.startCalls += 1;
		this.#startOptions = options;
		if (this.#startError) {
			return Promise.reject(this.#startError);
		}
		return this.#polling.promise;
	}

	async triggerStart(): Promise<void> {
		await this.#startOptions?.onStart?.({ username: "spellbot" });
	}

	failStart(error: Error): void {
		this.#startError = error;
	}

	async stop(): Promise<void> {
		this.stopCalls += 1;
		this.#polling.resolve();
	}
}
