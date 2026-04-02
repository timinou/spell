/**
 * Configuration types for the Telegram bridge.
 * Loaded from ~/.spell/telegram.yaml
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

/** Top-level bridge configuration (from ~/.spell/telegram.yaml) */
export interface TelegramBridgeConfig {
	/** Path to file containing the bot token */
	botTokenFile: string;
	/** Resolved bot token (read from botTokenFile at load time) */
	botToken: string;
	/** Directory for file uploads from Telegram */
	uploadDir: string;
	/** Port for the log viewer HTTP server. undefined = disabled. */
	logViewerPort?: number;
	/** Default idle timeout in seconds */
	idleTimeout: number;
	/** Max concurrent sessions */
	maxSessions: number;
	/** Named projects: name -> absolute path */
	projects: Record<string, string>;
	/** Authorized users: Telegram user ID (string) -> config */
	users: Record<string, UserConfig>;
	/** Default project name (first in projects map if not specified) */
	defaultProject?: string;
}

/** Raw YAML shape before validation/resolution */
export interface RawTelegramConfig {
	bot_token_file?: string;
	upload_dir?: string;
	log_viewer_port?: number;
	idle_timeout?: number;
	max_sessions?: number;
	default_project?: string;
	projects?: Record<string, string>;
	users?: Record<
		string | number,
		{
			modes?: string[];
			default_mode?: string;
			idle_timeout?: number | null;
			projects?: string[];
		}
	>;
}
