import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import { type AuthContext, authMiddleware } from "../../src/telegram/bot/auth";
import { TokenStore } from "../../src/telegram/bot/tokens";
import type { TelegramBridgeConfig } from "../../src/telegram/types";

function testConfig(): TelegramBridgeConfig {
	return {
		botToken: "123:token",
		owners: [123456],
		uploadDir: "/tmp/uploads",
		idleTimeout: 60,
		maxSessions: 2,
		defaultModel: "claude-sonnet-4-5",
		projects: {
			spell: "/home/user/code/ora/spell",
		},
		users: {
			"234567": {
				modes: ["telegram-readonly", "telegram-full"],
				defaultMode: "telegram-readonly",
			},
		},
	};
}

interface MockContext {
	from?: { id: number };
	chat?: { id: number; type: "private" | "group" | "supergroup" | "channel" };
	message?: {
		text: string;
		message_id: number;
		date: number;
		chat: { id: number; type: "private" };
	};
	reply: (text: string) => Promise<void>;
	_replies: string[];
	authState?: AuthContext["authState"];
}

function mockContext(opts: { userId: number; chatId: number; text?: string }): MockContext {
	const replies: string[] = [];
	return {
		from: { id: opts.userId },
		chat: { id: opts.chatId, type: "private" },
		message: {
			text: opts.text ?? "",
			message_id: 1,
			date: Date.now(),
			chat: { id: opts.chatId, type: "private" },
		},
		reply: async (text: string) => {
			replies.push(text);
		},
		_replies: replies,
	};
}

function createTokenStore(label: string): TokenStore {
	const storePath = path.join(import.meta.dir, "fixtures", `.tmp-token-store-${label}-${Date.now()}.json`);
	return new TokenStore(storePath);
}

describe("authMiddleware", () => {
	it("allows owner IDs from the owners list even without a matching user block", async () => {
		const config = testConfig();
		const store = createTokenStore("owner");
		const middleware = authMiddleware(config, store);
		const ctx = mockContext({ userId: 123456, chatId: 10 });

		let nextCalled = false;
		await middleware(ctx as unknown as AuthContext, async () => {
			nextCalled = true;
		});

		expect(nextCalled).toBe(true);
		expect(ctx._replies).toEqual([]);
		expect(ctx.authState).toEqual({
			userId: "123456",
			isOwner: true,
			userConfig: {
				modes: ["telegram-full"],
				defaultMode: "telegram-full",
				idleTimeout: null,
			},
		});
	});

	it("uses the same owner fallback when the users map is empty", async () => {
		const config = { ...testConfig(), users: {} };
		const store = createTokenStore("owner-empty-users");
		const middleware = authMiddleware(config, store);
		const ctx = mockContext({ userId: 123456, chatId: 15 });

		let nextCalled = false;
		await middleware(ctx as unknown as AuthContext, async () => {
			nextCalled = true;
		});

		expect(nextCalled).toBe(true);
		expect(ctx._replies).toEqual([]);
		expect(ctx.authState?.userConfig).toEqual({
			modes: ["telegram-full"],
			defaultMode: "telegram-full",
			idleTimeout: null,
		});
	});

	it("allows configured non-owner users without granting owner access", async () => {
		const config = testConfig();
		const store = createTokenStore("configured-user");
		const middleware = authMiddleware(config, store);
		const ctx = mockContext({ userId: 234567, chatId: 14 });

		let nextCalled = false;
		await middleware(ctx as unknown as AuthContext, async () => {
			nextCalled = true;
		});

		expect(nextCalled).toBe(true);
		expect(ctx._replies).toEqual([]);
		expect(ctx.authState?.isOwner).toBe(false);
		expect(ctx.authState?.userConfig).toEqual({
			modes: ["telegram-readonly", "telegram-full"],
			defaultMode: "telegram-readonly",
		});
	});

	it("rejects unknown user without token", async () => {
		const config = testConfig();
		const store = createTokenStore("unknown");
		const middleware = authMiddleware(config, store);
		const ctx = mockContext({ userId: 222222, chatId: 11 });

		let nextCalled = false;
		await middleware(ctx as unknown as AuthContext, async () => {
			nextCalled = true;
		});

		expect(nextCalled).toBe(false);
		expect(ctx._replies).toEqual(["Not authorized"]);
	});

	it("allows guest with valid /start token", async () => {
		const config = testConfig();
		const store = createTokenStore("guest");
		const token = store.generate();
		const middleware = authMiddleware(config, store);
		const ctx = mockContext({ userId: 333333, chatId: 12, text: `/start ${token.token}` });

		let nextCalled = false;
		await middleware(ctx as unknown as AuthContext, async () => {
			nextCalled = true;
		});

		expect(nextCalled).toBe(true);
		expect(ctx._replies).toEqual([]);
		expect(ctx.authState?.isOwner).toBe(false);
		expect(ctx.authState?.userId).toBe("333333");
		expect(store.claim(token.token, "444444")).toBe(false);
	});

	it("rejects expired token", async () => {
		const config = testConfig();
		const store = createTokenStore("expired");
		const token = store.generate(1);
		const middleware = authMiddleware(config, store);
		await Bun.sleep(5);
		const ctx = mockContext({ userId: 777777, chatId: 13, text: `/start ${token.token}` });

		let nextCalled = false;
		await middleware(ctx as unknown as AuthContext, async () => {
			nextCalled = true;
		});

		expect(nextCalled).toBe(false);
		expect(ctx._replies).toEqual(["Not authorized"]);
	});

	it("skips auth for updates without from user", async () => {
		const config = testConfig();
		const store = createTokenStore("channel-post");
		const middleware = authMiddleware(config, store);
		const ctx: MockContext = {
			reply: async () => {
				throw new Error("reply should not be called");
			},
			_replies: [],
		};

		let nextCalled = false;
		await middleware(ctx as unknown as AuthContext, async () => {
			nextCalled = true;
		});

		expect(nextCalled).toBe(true);
		expect(ctx._replies).toEqual([]);
	});
});
