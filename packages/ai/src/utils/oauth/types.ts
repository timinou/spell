export type OAuthCredentials = {
	refresh: string;
	access: string;
	expires: number;
	enterpriseUrl?: string;
	projectId?: string;
	email?: string;
	accountId?: string;
};

export type OAuthProvider =
	| "alibaba-coding-plan"
	| "anthropic"
	| "cerebras"
	| "cloudflare-ai-gateway"
	| "cursor"
	| "deepseek"
	| "github-copilot"
	| "google-gemini-cli"
	| "google-antigravity"
	| "gitlab-duo"
	| "huggingface"
	| "kimi"
	| "kimi-code"
	| "kilo"
	| "kagi"
	| "litellm"
	| "lm-studio"
	| "minimax-code"
	| "minimax-code-cn"
	| "moonshot"
	| "nvidia"
	| "nanogpt"
	| "ollama"
	| "openai-codex"
	| "opencode-go"
	| "opencode-zen"
	| "parallel"
	| "perplexity"
	| "qianfan"
	| "qwen-portal"
	| "synthetic"
	| "tavily"
	| "together"
	| "venice"
	| "vllm"
	| "xiaomi"
	| "zenmux"
	| "zai";

export type OAuthProviderId = OAuthProvider | (string & {});

export type OAuthPrompt = {
	message: string;
	placeholder?: string;
	allowEmpty?: boolean;
};

export type OAuthAuthInfo = {
	url: string;
	instructions?: string;
};

export interface OAuthProviderInfo {
	id: OAuthProviderId;
	name: string;
	available: boolean;
	/**
	 * Optional alternate provider id under which this entry's credential is stored.
	 * Use when an entry's UI/login id differs from the provider key resolved at
	 * model-streaming time (e.g. "kimi" entry whose credentials live under "kimi-code").
	 */
	storageId?: OAuthProviderId;
}

export interface OAuthController {
	onAuth?(info: OAuthAuthInfo): void;
	onProgress?(message: string): void;
	onManualCodeInput?(): Promise<string>;
	onPrompt?(prompt: OAuthPrompt): Promise<string>;
	signal?: AbortSignal;
}

export interface OAuthLoginCallbacks extends OAuthController {
	onAuth: (info: OAuthAuthInfo) => void;
	onPrompt: (prompt: OAuthPrompt) => Promise<string>;
}

export interface OAuthProviderInterface {
	readonly id: OAuthProviderId;
	readonly name: string;
	readonly sourceId?: string;
	login(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials | string>;
	refreshToken?(credentials: OAuthCredentials): Promise<OAuthCredentials>;
	getApiKey?(credentials: OAuthCredentials): string;
}
