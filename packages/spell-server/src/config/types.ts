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
	web?: WebConfig;
}

/**
 * Web frontend authentication subsystem. Multiple named bearer tokens
 * authenticate human identities ("alice", "bob" ...) against the same
 * `/web/*` route surface (HTTP + WebSocket).
 */
export interface WebConfig {
	/** Map of identity name → secret token bytes. */
	tokens: Map<string, string>;
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

/** Renderer config used by RendererExecutor. */
export interface RendererConfig {
	/** Renderer ID (unique within channel context). */
	id: string;
	/** Command to execute (e.g., "pandoc", "/opt/custom-renderer"). */
	command: string;
	/** Command arguments. */
	args: string[];
	/** Timeout in milliseconds for subprocess execution. */
	timeoutMs: number;
	/** Cache strategy. 'transcript-hash' = SHA256(markdown || rendererSignature). undefined = no cache. */
	cacheBy?: 'transcript-hash';
	/** MIME type of output (e.g., "application/pdf"). */
	mime: string;
	/** File extension of output (e.g., "pdf"). */
	extension: string;
	/** Optional extra env vars forwarded to subprocess. */
	env?: Record<string, string>;
}

/** Renderer config parsed from KDL session-notifications block. */
export interface SessionNotificationRendererConfig {
	/** Renderer ID (unique within channel context). */
	id: string;
	/** Command to execute (e.g., "pandoc", "/opt/custom-renderer"). */
	command: string;
	/** Command arguments. */
	args: string[];
	/** Timeout in milliseconds for subprocess execution. */
	timeoutMs: number;
	/** Cache strategy. 'transcript-hash' = SHA256(markdown || rendererSignature), 'none' = no cache. */
	cacheBy: 'transcript-hash' | 'none';
	/** MIME type of output (e.g., "application/pdf"). */
	mime: string;
	/** File extension of output (e.g., "pdf"). */
	extension: string;
}

/** Summarize configuration for pre-renderer TL;DR generation. */
export interface SummarizeConfig {
	/** When to trigger summarization (message count or byte count threshold). */
	when: { kind: 'message-count' | 'byte-count'; threshold: number };
	/** LLM model to use for summarization. */
	model: string;
	/** HTTP endpoint for summarization (OpenAI-compatible). */
	endpoint: string;
	/** API key for authentication. */
	apiKey: string;
	/** Max tokens in summary response. Default 250. */
	maxTokens: number;
	/** Prompt style for summarization. */
	promptStyle: 'needs-input-recap';
}

/** Attach configuration for rendering session transcripts. */
export interface AttachConfig {
	/** Renderer ID (matches a RendererConfig.id in session-notifications). */
	rendererId: string;
	/** Transcript scope to render. */
	transcript: 'full' | 'last-turn' | { kind: 'last-n'; n: number };
	/** Event kinds that trigger this attachment (subset of BlockingEventKind). */
	on: string[];
	/** Optional summarize config for TL;DR generation before rendering. */
	summarize?: SummarizeConfig;
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
		renderers: SessionNotificationRendererConfig[];
		attaches: AttachConfig[];
		/** Enable reply routing: replies to notifications are routed back to pending events. Default: false */
		replyRouting?: boolean;
		/** TTL for pending reply mappings in milliseconds. Default: 24h (86_400_000). */
		replyTtlMs?: number;
	};
}

export interface ChannelsConfig {
	telegram?: TelegramChannelConfig;
}
