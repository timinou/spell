import type { Context, MiddlewareFn } from "grammy";
import type { TelegramBridgeConfig, UserConfig } from "../config/types";
import type { AuthState } from "../types";
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

function resolveGuestConfig(config: TelegramBridgeConfig): UserConfig {
	const firstOwnerConfig = Object.values(config.users)[0];
	if (firstOwnerConfig) {
		return firstOwnerConfig;
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
		const ownerConfig = config.users[userId];
		if (ownerConfig) {
			applyAuthState(ctx, {
				userId,
				isOwner: true,
				userConfig: ownerConfig,
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
					userConfig: resolveGuestConfig(config),
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
				userConfig: resolveGuestConfig(config),
			});
			await next();
			return;
		}

		await ctx.reply("Not authorized");
	};
}
