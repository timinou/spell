/**
 * Shared types for the Telegram bridge runtime state.
 */

/** Per-user access configuration */
export interface UserConfig {
	/** Allowed mode names (references .spell/modes/*.md files) */
	modes: string[];
	/** Default mode on session start */
	defaultMode: string;
	/** Idle timeout in seconds. null = never timeout (for owner). */
	idleTimeout?: number | null;
	/** Allowed project names (keys from top-level projects map). Empty = all. */
	projects?: string[];
}

/** State of a chat session managed by the bridge */
export interface ChatSession {
	/** Telegram chat ID */
	chatId: string;
	/** Telegram user ID of session owner */
	userId: string;
	/** Current project name */
	project: string;
	/** Current project working directory */
	cwd: string;
	/** Current mode name */
	mode: string;
	/** Whether full thinking output is shown */
	showThinking: boolean;
	/** Path to the Spell session file for --resume */
	sessionPath?: string;
	/** When the session was created */
	createdAt: number;
	/** When the last message was processed */
	lastActiveAt: number;
}

/** Authentication state for a Telegram user */
export interface AuthState {
	/** Telegram user ID */
	userId: string;
	/** Whether this is the bot owner (in whitelist) */
	isOwner: boolean;
	/** Resolved user config (merged with defaults) */
	userConfig: UserConfig;
}

/** Temporary auth token for guest access */
export interface TempToken {
	/** The token string */
	token: string;
	/** When the token was created (epoch ms) */
	createdAt: number;
	/** When the token expires (epoch ms) */
	expiresAt: number;
	/** Telegram user ID that claimed this token (null if unclaimed) */
	claimedBy?: string;
}

/** Bridge-level state persisted to telegram-state.json */
export interface BridgeState {
	/** Map of chat ID -> session info for resume */
	sessions: Record<
		string,
		{
			sessionPath: string;
			project: string;
			mode: string;
			userId: string;
		}
	>;
}
