import type { Context, MiddlewareFn } from "grammy";
import type { AuthState } from "../../rpc/bridge-types";
import type { TelegramBridgeConfig, UserConfig } from "../types";
import type { TokenStore } from "./tokens";

export interface AuthFlavor {
	authState: AuthState;
}

export type AuthContext = Context & AuthFlavor;

const DEFAULT_GUEST_MODE = "telegram-readonly";

function extractStartToken(ctx: Context): string | null {
	const text = ctx.message?.text?.trim();
	if (!text || !text.startsWith("/start")) {
		return null;
	}
	const parts = text.split(/\s+/, 2);
	const token = parts[1]?.trim();
	return token ? token : null;
}

function resolveFallbackUserConfig(config: TelegramBridgeConfig, isOwner: boolean): UserConfig {
	if (isOwner) {
		return {
			modes: ["telegram-full"],
			defaultMode: "telegram-full",
			idleTimeout: null,
		};
	}

	const firstConfiguredUser = Object.values(config.users)[0];
	if (firstConfiguredUser) {
		return firstConfiguredUser;
	}

	return {
		modes: [DEFAULT_GUEST_MODE],
		defaultMode: DEFAULT_GUEST_MODE,
	};
}

function applyAuthState(ctx: Context, authState: AuthState): void {
	(ctx as AuthContext).authState = authState;
}

export function authMiddleware(config: TelegramBridgeConfig, tokenStore: TokenStore): MiddlewareFn<Context> {
	return async (ctx, next) => {
		if (!ctx.from) {
			await next();
			return;
		}

		const userId = String(ctx.from.id);
		const configuredUser = config.users[userId];
		const isOwner = config.owners.includes(ctx.from.id);
		if (configuredUser || isOwner) {
			applyAuthState(ctx, {
				userId,
				isOwner,
				userConfig: configuredUser ?? resolveFallbackUserConfig(config, isOwner),
			});
			await next();
			return;
		}

		const startToken = extractStartToken(ctx);
		if (startToken) {
			const validToken = tokenStore.validate(startToken);
			if (validToken && tokenStore.claim(startToken, userId)) {
				applyAuthState(ctx, {
					userId,
					isOwner: false,
					userConfig: resolveFallbackUserConfig(config, false),
				});
				await tokenStore.save();
				await next();
				return;
			}
		}

		const claimedToken = tokenStore.findClaimedByUser(userId);
		if (claimedToken && tokenStore.validate(claimedToken.token)) {
			applyAuthState(ctx, {
				userId,
				isOwner: false,
				userConfig: resolveFallbackUserConfig(config, false),
			});
			await next();
			return;
		}

		await ctx.reply("Not authorized");
	};
}
