export interface AutonomyManifest {
	name: string;
	version: string;
	setups: Map<string, ManifestSetup>;
	goals: Map<string, ManifestGoal>;
}

export interface ManifestSetup {
	domain: string;
	mode?: string;
	skills?: FilterConfig;
	tools?: FilterConfig;
	sandbox?: SandboxConfig;
	timeout?: string;
	maxCostUsd?: number;
}

export interface FilterConfig {
	allow?: string[];
	deny?: string[];
}

export interface SandboxConfig {
	pathsWrite?: string[];
	bashAllow?: string[];
	bashDeny?: string[];
}

export interface ManifestGoal {
	setup: string;
	schedule: CronSchedule | WebhookSchedule;
	prompt: string;
	hooks?: ManifestHookConfig;
	state?: StateConfig;
	retry?: RetryConfig;
}

export interface CronSchedule {
	type: "cron";
	expression: string;
	timezone?: string;
	jitter?: string;
}

export interface WebhookSchedule {
	type: "webhook";
	path?: string;
	auth?: "hmac" | "bearer";
}

export interface ManifestHookConfig {
	onSuccess?: HookTarget[];
	onFailure?: HookTarget[];
	onComplete?: HookTarget[];
}

export type HookTarget = WebhookHook | TelegramHook | OrgHook;

export interface WebhookHook {
	type: "webhook";
	url: string;
	method?: "POST" | "GET";
}

export interface TelegramHook {
	type: "telegram";
	chatId: number;
}

export interface OrgHook {
	type: "org";
	category?: string;
}

export interface StateConfig {
	persist: boolean;
	schema?: StateSchemaColumn[];
}

export interface StateSchemaColumn {
	name: string;
	type: "string" | "number" | "boolean" | "json";
}

export interface RetryConfig {
	maxRetries?: number;
	initialDelayMs?: number;
	multiplier?: number;
}

const STATE_SCHEMA_TYPES = new Set(["string", "number", "boolean", "json"]);
const WEBHOOK_AUTH_TYPES = new Set(["hmac", "bearer"]);
const WEBHOOK_METHODS = new Set(["POST", "GET"]);

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function isStringArray(value: unknown): value is string[] {
	return Array.isArray(value) && value.every(item => typeof item === "string");
}

function isOptionalStringArray(value: unknown): value is string[] | undefined {
	return value === undefined || isStringArray(value);
}

function isOptionalFiniteNumber(value: unknown): value is number | undefined {
	return value === undefined || (typeof value === "number" && Number.isFinite(value));
}

function isValidFilterConfig(value: unknown): value is FilterConfig {
	if (!isRecord(value)) return false;
	return isOptionalStringArray(value.allow) && isOptionalStringArray(value.deny);
}

function isValidSandboxConfig(value: unknown): value is SandboxConfig {
	if (!isRecord(value)) return false;
	return (
		isOptionalStringArray(value.pathsWrite) &&
		isOptionalStringArray(value.bashAllow) &&
		isOptionalStringArray(value.bashDeny)
	);
}

function isValidSchedule(value: unknown): value is CronSchedule | WebhookSchedule {
	if (!isRecord(value) || typeof value.type !== "string") return false;
	if (value.type === "cron") {
		return (
			typeof value.expression === "string" &&
			(value.timezone === undefined || typeof value.timezone === "string") &&
			(value.jitter === undefined || typeof value.jitter === "string")
		);
	}
	if (value.type === "webhook") {
		return (
			(value.path === undefined || typeof value.path === "string") &&
			(value.auth === undefined || (typeof value.auth === "string" && WEBHOOK_AUTH_TYPES.has(value.auth)))
		);
	}
	return false;
}

function isValidHookTarget(value: unknown): value is HookTarget {
	if (!isRecord(value) || typeof value.type !== "string") return false;
	if (value.type === "webhook") {
		return (
			typeof value.url === "string" &&
			(value.method === undefined || (typeof value.method === "string" && WEBHOOK_METHODS.has(value.method)))
		);
	}
	if (value.type === "telegram") {
		return typeof value.chatId === "number" && Number.isFinite(value.chatId);
	}
	if (value.type === "org") {
		return value.category === undefined || typeof value.category === "string";
	}
	return false;
}

function isHookTargetArray(value: unknown): value is HookTarget[] {
	return Array.isArray(value) && value.every(isValidHookTarget);
}

function isValidHooks(value: unknown): value is ManifestHookConfig {
	if (!isRecord(value)) return false;
	return (
		(value.onSuccess === undefined || isHookTargetArray(value.onSuccess)) &&
		(value.onFailure === undefined || isHookTargetArray(value.onFailure)) &&
		(value.onComplete === undefined || isHookTargetArray(value.onComplete))
	);
}

function isValidState(value: unknown): value is StateConfig {
	if (!isRecord(value) || typeof value.persist !== "boolean") return false;
	if (value.schema === undefined) return true;
	return (
		Array.isArray(value.schema) &&
		value.schema.every(column => {
			if (!isRecord(column)) return false;
			return (
				typeof column.name === "string" && typeof column.type === "string" && STATE_SCHEMA_TYPES.has(column.type)
			);
		})
	);
}

function isValidRetry(value: unknown): value is RetryConfig {
	if (!isRecord(value)) return false;
	return (
		isOptionalFiniteNumber(value.maxRetries) &&
		isOptionalFiniteNumber(value.initialDelayMs) &&
		isOptionalFiniteNumber(value.multiplier)
	);
}

export function isValidSetup(value: unknown): value is ManifestSetup {
	if (!isRecord(value) || typeof value.domain !== "string" || value.domain.length === 0) return false;
	return (
		(value.mode === undefined || typeof value.mode === "string") &&
		(value.skills === undefined || isValidFilterConfig(value.skills)) &&
		(value.tools === undefined || isValidFilterConfig(value.tools)) &&
		(value.sandbox === undefined || isValidSandboxConfig(value.sandbox)) &&
		(value.timeout === undefined || typeof value.timeout === "string") &&
		isOptionalFiniteNumber(value.maxCostUsd)
	);
}

export function isValidGoal(value: unknown): value is ManifestGoal {
	if (!isRecord(value)) return false;
	return (
		typeof value.setup === "string" &&
		value.setup.length > 0 &&
		isValidSchedule(value.schedule) &&
		typeof value.prompt === "string" &&
		value.prompt.length > 0 &&
		(value.hooks === undefined || isValidHooks(value.hooks)) &&
		(value.state === undefined || isValidState(value.state)) &&
		(value.retry === undefined || isValidRetry(value.retry))
	);
}

export function isValidManifest(value: unknown): value is AutonomyManifest {
	if (!isRecord(value)) return false;
	if (typeof value.name !== "string" || typeof value.version !== "string") return false;
	if (!(value.setups instanceof Map) || !(value.goals instanceof Map)) return false;
	return (
		[...value.setups.entries()].every(([name, setup]) => typeof name === "string" && isValidSetup(setup)) &&
		[...value.goals.entries()].every(([name, goal]) => typeof name === "string" && isValidGoal(goal))
	);
}
