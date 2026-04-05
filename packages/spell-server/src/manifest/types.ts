import type { ActionDescriptor, ActionValue, ManifestAction, ManifestActionPromptSlot } from "../actions/types";

export interface AutonomyManifest {
	name: string;
	version: string;
	setups: Map<string, ManifestSetup>;
	goals: Map<string, ManifestGoal>;
	exportTargets: ExportTarget[];
	notificationRoutes: NotificationRoute[];
	reviewPolicies: ReviewPolicy[];
	checkpoints: Checkpoint[];
	panels: Panel[];
	layouts: Layout[];
	syncCollections: SyncCollection[];
	stateSchemas: StateSchema[];
	toolModules: ToolModule[];
	operatorActions: OperatorAction[];
}

export interface ManifestImport {
	source: string;
	alias: string;
}

export type ManifestOverrideStrategy = "replace" | "merge";

export interface ParsedManifestModule {
	name?: string;
	version?: string;
	imports: ManifestImport[];
	setups: Map<string, ManifestSetup>;
	goals: Map<string, ManifestGoal>;
	overrides: ManifestOverride[];
	actionDescriptors: ActionDescriptor[];
	exportTargets: ExportTarget[];
	notificationRoutes: NotificationRoute[];
	reviewPolicies: ReviewPolicy[];
	checkpoints: Checkpoint[];
	panels: Panel[];
	layouts: Layout[];
	syncCollections: SyncCollection[];
	stateSchemas: StateSchema[];
	toolModules: ToolModule[];
	operatorActions: OperatorAction[];
}

export type ManifestOverride = SetupOverride | GoalOverride;

export interface SetupOverride {
	kind: "setup";
	name: string;
	from: string;
	strategy: ManifestOverrideStrategy;
	value: ManifestSetupPatch;
}

export interface GoalOverride {
	kind: "goal";
	name: string;
	from: string;
	strategy: ManifestOverrideStrategy;
	value: ManifestGoalPatch;
}

export interface ManifestSetup {
	domain: string;
	mode?: string;
	skills?: FilterConfig;
	tools?: FilterConfig;
	sandbox?: SandboxConfig;
	timeout?: string;
	maxCostUsd?: number;
	stateStores?: Map<string, NamedStateStore>;
}

export interface ManifestSetupPatch {
	domain?: string;
	mode?: string;
	skills?: FilterConfig;
	tools?: FilterConfig;
	sandbox?: SandboxConfig;
	timeout?: string;
	maxCostUsd?: number;
	stateStores?: Map<string, NamedStateStore>;
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

export type StateStoreBackend = "sqlite" | "artifact-store";

export interface NamedStateStore {
	backend: StateStoreBackend;
	path: string;
	schema?: string;
}

export interface ManifestGoal {
	setup: string;
	schedule: CronSchedule | WebhookSchedule;
	prompt?: string;
	action?: ManifestAction;
	hooks?: ManifestHookConfig;
	state?: StateConfig;
	stateStores?: Map<string, NamedStateStore>;
	retry?: RetryConfig;
}

export interface ManifestGoalPatch {
	setup?: string;
	schedule?: CronSchedule | WebhookSchedule;
	prompt?: string;
	action?: ManifestAction;
	hooks?: ManifestHookConfig;
	state?: StateConfig;
	stateStores?: Map<string, NamedStateStore>;
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
const STATE_STORE_BACKENDS = new Set<StateStoreBackend>(["sqlite", "artifact-store"]);

export interface ExportTarget {
	id: string;
	kind: string;
	url?: string;
	path?: string;
	format?: string;
}

export interface NotificationRoute {
	id: string;
	channel: string;
	on: string;
	chatId?: number;
	url?: string;
	category?: string;
}

export interface ReviewPolicy {
	id: string;
	states: ReviewPolicyState[];
	transitions: ReviewPolicyTransition[];
}

export interface ReviewPolicyState {
	name: string;
	initial?: boolean;
	terminal?: boolean;
}

export interface ReviewPolicyTransition {
	from: string;
	to: string;
	action: string;
}

export interface Checkpoint {
	id: string;
	requires: CheckpointRequirement[];
}

export interface CheckpointRequirement {
	name: string;
	kind: string;
	policy?: string;
	state?: string;
	scope?: string;
}

export interface Panel {
	id: string;
	source: string;
	columns: PanelColumn[];
	actions: PanelAction[];
}

export interface PanelColumn {
	name: string;
	type: string;
}

export interface PanelAction {
	name: string;
	label: string;
}

export interface Layout {
	id: string;
	regions: LayoutRegion[];
}

export interface LayoutRegion {
	name: string;
	panel: string;
}

export interface SyncCollection {
	id: string;
	source: string;
	filter?: string;
}

export interface StateSchema {
	id: string;
	backend: string;
	tables: StateSchemaTable[];
}

export interface StateSchemaTable {
	name: string;
	columns: StateSchemaTableColumn[];
}

export interface StateSchemaTableColumn {
	name: string;
	type: string;
	primary?: boolean;
}

export interface ToolModule {
	id: string;
	path: string;
}

export interface OperatorAction {
	id: string;
	transitions: OperatorActionTransition[];
	triggerGoal?: string;
	downstreamJob?: { kind: string };
}

export interface OperatorActionTransition {
	from: string;
	to: string;
}

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

function isValidStateStore(value: unknown): value is NamedStateStore {
	if (!isRecord(value)) return false;
	return (
		typeof value.backend === "string" &&
		STATE_STORE_BACKENDS.has(value.backend as StateStoreBackend) &&
		typeof value.path === "string" &&
		value.path.length > 0 &&
		(value.schema === undefined || typeof value.schema === "string")
	);
}

function isValidStateStoreMap(value: unknown): value is Map<string, NamedStateStore> {
	if (!(value instanceof Map)) return false;
	return [...value.entries()].every(([name, stateStore]) => typeof name === "string" && isValidStateStore(stateStore));
}

function isValidActionValue(value: unknown): value is ActionValue {
	if (value === null) return true;
	if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return true;
	if (Array.isArray(value)) {
		return value.every(item => isValidActionValue(item));
	}
	if (!isRecord(value)) return false;
	return Object.values(value).every(item => isValidActionValue(item));
}

function isValidActionPromptSlot(value: unknown): value is ManifestActionPromptSlot {
	if (!isRecord(value)) return false;
	return (
		typeof value.name === "string" &&
		(value.kind === "inline" || value.kind === "file") &&
		(value.content === undefined || typeof value.content === "string") &&
		(value.path === undefined || typeof value.path === "string")
	);
}

function isValidManifestAction(value: unknown): value is ManifestAction {
	if (!isRecord(value) || typeof value.id !== "string") return false;
	if (!isRecord(value.params) || !isRecord(value.promptSlots)) return false;
	return (
		Object.values(value.params).every(paramValue => isValidActionValue(paramValue)) &&
		Object.values(value.promptSlots).every(promptSlot => isValidActionPromptSlot(promptSlot))
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

export function isValidExportTarget(value: unknown): value is ExportTarget {
	if (!isRecord(value)) return false;
	return (
		typeof value.id === "string" &&
		value.id.length > 0 &&
		typeof value.kind === "string" &&
		value.kind.length > 0 &&
		(value.url === undefined || typeof value.url === "string") &&
		(value.path === undefined || typeof value.path === "string") &&
		(value.format === undefined || typeof value.format === "string")
	);
}

export function isValidNotificationRoute(value: unknown): value is NotificationRoute {
	if (!isRecord(value)) return false;
	return (
		typeof value.id === "string" &&
		value.id.length > 0 &&
		typeof value.channel === "string" &&
		value.channel.length > 0 &&
		typeof value.on === "string" &&
		value.on.length > 0 &&
		isOptionalFiniteNumber(value.chatId) &&
		(value.url === undefined || typeof value.url === "string") &&
		(value.category === undefined || typeof value.category === "string")
	);
}

export function isValidReviewPolicyState(value: unknown): value is ReviewPolicyState {
	if (!isRecord(value)) return false;
	return (
		typeof value.name === "string" &&
		value.name.length > 0 &&
		(value.initial === undefined || typeof value.initial === "boolean") &&
		(value.terminal === undefined || typeof value.terminal === "boolean")
	);
}

export function isValidReviewPolicyTransition(value: unknown): value is ReviewPolicyTransition {
	if (!isRecord(value)) return false;
	return (
		typeof value.from === "string" &&
		value.from.length > 0 &&
		typeof value.to === "string" &&
		value.to.length > 0 &&
		typeof value.action === "string" &&
		value.action.length > 0
	);
}

export function isValidReviewPolicy(value: unknown): value is ReviewPolicy {
	if (!isRecord(value)) return false;
	return (
		typeof value.id === "string" &&
		value.id.length > 0 &&
		Array.isArray(value.states) &&
		value.states.every(state => isValidReviewPolicyState(state)) &&
		Array.isArray(value.transitions) &&
		value.transitions.every(transition => isValidReviewPolicyTransition(transition))
	);
}

export function isValidCheckpointRequirement(value: unknown): value is CheckpointRequirement {
	if (!isRecord(value)) return false;
	return (
		typeof value.name === "string" &&
		value.name.length > 0 &&
		typeof value.kind === "string" &&
		value.kind.length > 0 &&
		(value.policy === undefined || typeof value.policy === "string") &&
		(value.state === undefined || typeof value.state === "string") &&
		(value.scope === undefined || typeof value.scope === "string")
	);
}

export function isValidCheckpoint(value: unknown): value is Checkpoint {
	if (!isRecord(value)) return false;
	return (
		typeof value.id === "string" &&
		value.id.length > 0 &&
		Array.isArray(value.requires) &&
		value.requires.every(requirement => isValidCheckpointRequirement(requirement))
	);
}

export function isValidPanelColumn(value: unknown): value is PanelColumn {
	if (!isRecord(value)) return false;
	return (
		typeof value.name === "string" && value.name.length > 0 && typeof value.type === "string" && value.type.length > 0
	);
}

export function isValidPanelAction(value: unknown): value is PanelAction {
	if (!isRecord(value)) return false;
	return (
		typeof value.name === "string" &&
		value.name.length > 0 &&
		typeof value.label === "string" &&
		value.label.length > 0
	);
}

export function isValidPanel(value: unknown): value is Panel {
	if (!isRecord(value)) return false;
	return (
		typeof value.id === "string" &&
		value.id.length > 0 &&
		typeof value.source === "string" &&
		value.source.length > 0 &&
		Array.isArray(value.columns) &&
		value.columns.every(column => isValidPanelColumn(column)) &&
		Array.isArray(value.actions) &&
		value.actions.every(action => isValidPanelAction(action))
	);
}

export function isValidLayoutRegion(value: unknown): value is LayoutRegion {
	if (!isRecord(value)) return false;
	return (
		typeof value.name === "string" &&
		value.name.length > 0 &&
		typeof value.panel === "string" &&
		value.panel.length > 0
	);
}

export function isValidLayout(value: unknown): value is Layout {
	if (!isRecord(value)) return false;
	return (
		typeof value.id === "string" &&
		value.id.length > 0 &&
		Array.isArray(value.regions) &&
		value.regions.every(region => isValidLayoutRegion(region))
	);
}

export function isValidSyncCollection(value: unknown): value is SyncCollection {
	if (!isRecord(value)) return false;
	return (
		typeof value.id === "string" &&
		value.id.length > 0 &&
		typeof value.source === "string" &&
		value.source.length > 0 &&
		(value.filter === undefined || typeof value.filter === "string")
	);
}

export function isValidStateSchemaTableColumn(value: unknown): value is StateSchemaTableColumn {
	if (!isRecord(value)) return false;
	return (
		typeof value.name === "string" &&
		value.name.length > 0 &&
		typeof value.type === "string" &&
		value.type.length > 0 &&
		(value.primary === undefined || typeof value.primary === "boolean")
	);
}

export function isValidStateSchemaTable(value: unknown): value is StateSchemaTable {
	if (!isRecord(value)) return false;
	return (
		typeof value.name === "string" &&
		value.name.length > 0 &&
		Array.isArray(value.columns) &&
		value.columns.every(column => isValidStateSchemaTableColumn(column))
	);
}

export function isValidStateSchema(value: unknown): value is StateSchema {
	if (!isRecord(value)) return false;
	return (
		typeof value.id === "string" &&
		value.id.length > 0 &&
		typeof value.backend === "string" &&
		value.backend.length > 0 &&
		Array.isArray(value.tables) &&
		value.tables.every(table => isValidStateSchemaTable(table))
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
		isOptionalFiniteNumber(value.maxCostUsd) &&
		(value.stateStores === undefined || isValidStateStoreMap(value.stateStores))
	);
}

export function isValidGoal(value: unknown): value is ManifestGoal {
	if (!isRecord(value)) return false;
	const hasPrompt = typeof value.prompt === "string" && value.prompt.length > 0;
	const hasAction = value.action !== undefined && isValidManifestAction(value.action);
	return (
		typeof value.setup === "string" &&
		value.setup.length > 0 &&
		isValidSchedule(value.schedule) &&
		(hasPrompt || hasAction) &&
		(value.hooks === undefined || isValidHooks(value.hooks)) &&
		(value.state === undefined || isValidState(value.state)) &&
		(value.stateStores === undefined || isValidStateStoreMap(value.stateStores)) &&
		(value.retry === undefined || isValidRetry(value.retry))
	);
}

export function isValidManifest(value: unknown): value is AutonomyManifest {
	if (!isRecord(value)) return false;
	if (typeof value.name !== "string" || typeof value.version !== "string") return false;
	if (!(value.setups instanceof Map) || !(value.goals instanceof Map)) return false;
	return (
		Array.isArray(value.exportTargets) &&
		Array.isArray(value.notificationRoutes) &&
		Array.isArray(value.reviewPolicies) &&
		Array.isArray(value.checkpoints) &&
		Array.isArray(value.panels) &&
		Array.isArray(value.layouts) &&
		Array.isArray(value.syncCollections) &&
		Array.isArray(value.stateSchemas) &&
		Array.isArray(value.toolModules) &&
		Array.isArray(value.operatorActions) &&
		[...value.setups.entries()].every(([name, setup]) => typeof name === "string" && isValidSetup(setup)) &&
		[...value.goals.entries()].every(([name, goal]) => typeof name === "string" && isValidGoal(goal)) &&
		value.exportTargets.every(target => isValidExportTarget(target)) &&
		value.notificationRoutes.every(route => isValidNotificationRoute(route)) &&
		value.reviewPolicies.every(policy => isValidReviewPolicy(policy)) &&
		value.checkpoints.every(checkpoint => isValidCheckpoint(checkpoint)) &&
		value.panels.every(panel => isValidPanel(panel)) &&
		value.layouts.every(layout => isValidLayout(layout)) &&
		value.syncCollections.every(collection => isValidSyncCollection(collection)) &&
		value.stateSchemas.every(schema => isValidStateSchema(schema))
	);
}

export function resolveGoalStateStores(manifest: AutonomyManifest, goalName: string): Map<string, NamedStateStore> {
	const goal = manifest.goals.get(goalName);
	if (!goal) {
		throw new Error(`Unknown goal: ${goalName}`);
	}
	const setup = manifest.setups.get(goal.setup);
	if (!setup) {
		throw new Error(`Unknown setup: ${goal.setup}`);
	}

	const resolved = new Map<string, NamedStateStore>();
	for (const [name, stateStore] of setup.stateStores ?? []) {
		resolved.set(name, structuredClone(stateStore));
	}
	for (const [name, stateStore] of goal.stateStores ?? []) {
		const current = resolved.get(name);
		resolved.set(
			name,
			current
				? {
						backend: stateStore.backend ?? current.backend,
						path: stateStore.path ?? current.path,
						...(stateStore.schema !== undefined
							? { schema: stateStore.schema }
							: current.schema
								? { schema: current.schema }
								: {}),
					}
				: structuredClone(stateStore),
		);
	}
	return resolved;
}
