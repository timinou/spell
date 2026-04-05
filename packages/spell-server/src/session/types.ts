import type { RpcClient, RpcSpawnOptions } from "../rpc";

export interface SessionLifecycle<K> {
	buildSpawnOptions(key: K, baseOptions: BaseSpawnOptions): RpcSpawnOptions;
	getIdleTimeout(key: K): number | null;
	onSessionComplete?(key: K): void | Promise<void>;
	onSessionError?(key: K, error: Error): void | Promise<void>;
}

export interface BaseSpawnOptions {
	cwd: string;
	tools: string[];
	appendSystemPrompt?: string;
	sessionDir?: string;
	sandboxPolicyPath?: string;
	/** Environment variables passed from manifest state-store declarations */
	env?: Record<string, string>;
}

export interface SessionEntry<K> {
	key: K;
	client: RpcClient;
	startedAt: number;
	timer?: Timer;
}
