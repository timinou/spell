import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import { type AuthContext, authMiddleware } from "../src/bot/auth";
import { startBot } from "../src/bot/bot";
import { TokenStore } from "../src/bot/tokens";
import type { TelegramBridgeConfig } from "../src/config/types";

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

function testConfig(): TelegramBridgeConfig {
	return {
		botTokenFile: "/tmp/bot-token.txt",
		botToken: "123:token",
		uploadDir: "/tmp/uploads",
		idleTimeout: 60,
		maxSessions: 2,
		projects: {
			spell: "/home/user/code/ora/spell",
		},
		users: {
			"9001": {
				modes: ["telegram-readonly"],
				defaultMode: "telegram-readonly",
			},
		},
	};
}

function createTokenStore(label: string): TokenStore {
	const storePath = path.join(import.meta.dir, "fixtures", `.tmp-bot-token-store-${label}-${Date.now()}.json`);
	return new TokenStore(storePath);
}

describe("bot module", () => {
	it("exports startBot function", () => {
		expect(typeof startBot).toBe("function");
	});

	it("auth middleware claims token from /start deep link and reuses claim", async () => {
		const config = testConfig();
		const tokenStore = createTokenStore("claim");
		const tempToken = tokenStore.generate();
		const middleware = authMiddleware(config, tokenStore);

		const firstCtx = mockContext({ userId: 1234, chatId: 45, text: `/start ${tempToken.token}` });
		let firstNextCalled = false;
		await middleware(firstCtx as unknown as AuthContext, async () => {
			firstNextCalled = true;
		});

		expect(firstNextCalled).toBe(true);
		expect(firstCtx.authState?.isOwner).toBe(false);
		expect(firstCtx._replies).toEqual([]);

		const secondCtx = mockContext({ userId: 1234, chatId: 45, text: "hello" });
		let secondNextCalled = false;
		await middleware(secondCtx as unknown as AuthContext, async () => {
			secondNextCalled = true;
		});

		expect(secondNextCalled).toBe(true);
		expect(secondCtx._replies).toEqual([]);

		const thirdCtx = mockContext({ userId: 5678, chatId: 46, text: `/start ${tempToken.token}` });
		let thirdNextCalled = false;
		await middleware(thirdCtx as unknown as AuthContext, async () => {
			thirdNextCalled = true;
		});

		expect(thirdNextCalled).toBe(false);
		expect(thirdCtx._replies).toEqual(["Not authorized"]);
	});
});
