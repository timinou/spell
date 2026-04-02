export interface SpellServerConfig {
	http: {
		port: number;
		auth: {
			username: string;
			password: string;
		};
		webhookSecret?: string;
		goalTokens?: Record<string, string>;
	};
}

/** Per-user Telegram access configuration */
export interface TelegramUserConfig {
	/** Allowed mode names (references .spell/modes/*.md files) */
	modes: string[];
	/** Default mode on session start */
	defaultMode: string;
	/** Idle timeout in seconds. null = never timeout (for owner). */
	idleTimeout?: number | null;
	/** Allowed project names (keys from top-level projects map). Empty = all. */
	projects?: string[];
}

/** Full Telegram channel configuration parsed from channels.kdl */
export interface TelegramChannelConfig {
	/** Bot token (read from inline value or file) */
	botToken: string;
	/** Owner Telegram user IDs (receive notifications, can /unlock) */
	owners: number[];
	/** Directory for file uploads from Telegram */
	uploadDir: string;
	/** Default idle timeout in seconds */
	idleTimeout: number;
	/** Max concurrent sessions */
	maxSessions: number;
	/** Port for the log viewer HTTP server. undefined = disabled. */
	logViewerPort?: number;
	/** Default model slug passed to spawned spell RPC sessions */
	defaultModel: string;
	/** Default project name */
	defaultProject?: string;
	/** Named projects: name -> absolute path */
	projects: Record<string, string>;
	/** Authorized users: Telegram user ID (string) -> config */
	users: Record<string, TelegramUserConfig>;
}

export interface ChannelsConfig {
	telegram?: TelegramChannelConfig;
}
