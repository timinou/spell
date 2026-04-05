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
	socket?: {
		path: string;
	};
}

// -- Voice configuration types --

export type SttProvider = "deepgram" | "openai";
export type TtsProvider = "elevenlabs" | "deepgram";
export type VoiceReplyMode = "mirror" | "always" | "never";

export interface SttConfig {
	provider: SttProvider;
	apiKey: string;
	model?: string;
	language: string; // BCP-47, default "en"
}

export interface TtsConfig {
	provider: TtsProvider;
	apiKey: string;
	model?: string;
	voice?: string;
}

export interface VoiceConfig {
	stt?: SttConfig;
	tts?: TtsConfig;
	replyMode: VoiceReplyMode; // default "mirror"
}

export interface UserVoiceConfig {
	replyMode?: VoiceReplyMode;
	ttsVoice?: string;
}

// -- Telegram user and channel configuration --

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
	/** Per-user voice configuration overrides */
	voice?: UserVoiceConfig;
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
	/** Auto-send generated images to chat. Default: true. */
	autoSendImages: boolean;
	/** Voice configuration (STT/TTS) */
	voice?: VoiceConfig;
	/** Optional local session event notifications routed to Telegram targets. */
	sessionNotifications?: {
		events: string[];
		notifyOwners: boolean;
		additionalChatIds: number[];
	};
}

export interface ChannelsConfig {
	telegram?: TelegramChannelConfig;
}
