import * as path from "node:path";
import { parse } from "@bgotink/kdl";
import { isEnoent } from "@oh-my-pi/pi-utils";
import { createBuiltinActionRegistry } from "../actions";
import type { ActionRegistry } from "../actions/registry";
import { type ParseManifestOptions, parseManifestModuleDocument } from "./parser";
import {
	type AutonomyManifest,
	type Checkpoint,
	type ExportTarget,
	type FilterConfig,
	isValidManifest,
	type Layout,
	type ManifestGoal,
	type ManifestGoalPatch,
	type ManifestHookConfig,
	type ManifestSetup,
	type ManifestSetupPatch,
	type NamedStateStore,
	type NotificationRoute,
	type OperatorAction,
	type Panel,
	type RetryConfig,
	type ReviewPolicy,
	type SandboxConfig,
	type StateConfig,
	type StateSchema,
	type SyncCollection,
	type ToolModule,
} from "./types";
import { validateManifest } from "./validator";

interface ManifestLoadOptions {
	registry?: ActionRegistry;
	env?: Record<string, string | undefined>;
}

interface ResolvedManifestModule {
	name?: string;
	version?: string;
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

interface ResolveContext {
	cache: Map<string, ResolvedManifestModule>;
	stack: string[];
	registry: ActionRegistry;
	env: Record<string, string | undefined>;
}

type SetupField = keyof ManifestSetupPatch;
type GoalField = keyof ManifestGoalPatch;

const SETUP_MERGE_STRATEGIES: Record<SetupField, "replace" | "filter" | "sandbox" | "stateStores"> = {
	domain: "replace",
	mode: "replace",
	skills: "filter",
	tools: "filter",
	sandbox: "sandbox",
	timeout: "replace",
	maxCostUsd: "replace",
	stateStores: "stateStores",
};

const GOAL_MERGE_STRATEGIES: Record<
	GoalField,
	"replace" | "hooks" | "retry" | "state" | "stateStores" | "nonMergeable"
> = {
	setup: "replace",
	schedule: "nonMergeable",
	prompt: "replace",
	action: "nonMergeable",
	hooks: "hooks",
	state: "state",
	stateStores: "stateStores",
	retry: "retry",
};

function cloneMap<K, V>(source: Map<K, V>): Map<K, V> {
	return new Map([...source.entries()].map(([key, value]) => [key, structuredClone(value)]));
}

function cloneArray<T>(source: T[]): T[] {
	return source.map(item => structuredClone(item));
}

function prefixIdArray<T extends { id: string }>(alias: string, items: T[]): T[] {
	return items.map(item => ({
		...structuredClone(item),
		id: `${alias}.${item.id}`,
	}));
}

function appendUnique(left: string[] | undefined, right: string[] | undefined): string[] | undefined {
	if (!left && !right) return undefined;
	return [...new Set([...(left ?? []), ...(right ?? [])])];
}

function mergeFilterConfig(base: FilterConfig | undefined, patch: FilterConfig): FilterConfig {
	return {
		...(appendUnique(base?.allow, patch.allow) ? { allow: appendUnique(base?.allow, patch.allow) } : {}),
		...(appendUnique(base?.deny, patch.deny) ? { deny: appendUnique(base?.deny, patch.deny) } : {}),
	};
}

function mergeSandboxConfig(base: SandboxConfig | undefined, patch: SandboxConfig): SandboxConfig {
	return {
		...(appendUnique(base?.pathsWrite, patch.pathsWrite)
			? { pathsWrite: appendUnique(base?.pathsWrite, patch.pathsWrite) }
			: {}),
		...(appendUnique(base?.bashAllow, patch.bashAllow)
			? { bashAllow: appendUnique(base?.bashAllow, patch.bashAllow) }
			: {}),
		...(appendUnique(base?.bashDeny, patch.bashDeny)
			? { bashDeny: appendUnique(base?.bashDeny, patch.bashDeny) }
			: {}),
	};
}

function mergeStateStores(
	base: Map<string, NamedStateStore> | undefined,
	patch: Map<string, NamedStateStore>,
): Map<string, NamedStateStore> {
	const merged = cloneMap(base ?? new Map<string, NamedStateStore>());
	for (const [name, stateStore] of patch) {
		merged.set(name, structuredClone(stateStore));
	}
	return merged;
}

function mergeHookTargets<T>(base: T[] | undefined, patch: T[] | undefined): T[] | undefined {
	if (!base && !patch) return undefined;
	return [...(base ?? []), ...(patch ?? [])].map(item => structuredClone(item));
}

function mergeHooks(base: ManifestHookConfig | undefined, patch: ManifestHookConfig): ManifestHookConfig {
	return {
		...(mergeHookTargets(base?.onSuccess, patch.onSuccess)
			? { onSuccess: mergeHookTargets(base?.onSuccess, patch.onSuccess) }
			: {}),
		...(mergeHookTargets(base?.onFailure, patch.onFailure)
			? { onFailure: mergeHookTargets(base?.onFailure, patch.onFailure) }
			: {}),
		...(mergeHookTargets(base?.onComplete, patch.onComplete)
			? { onComplete: mergeHookTargets(base?.onComplete, patch.onComplete) }
			: {}),
	};
}

function mergeRetry(base: RetryConfig | undefined, patch: RetryConfig): RetryConfig {
	return {
		...(base ?? {}),
		...patch,
	};
}

function mergeState(base: StateConfig | undefined, patch: StateConfig): StateConfig {
	const schema = [...(base?.schema ?? []), ...(patch.schema ?? [])].map(column => structuredClone(column));
	return {
		persist: patch.persist,
		...(schema.length > 0 ? { schema } : {}),
	};
}

function materializeSetup(patch: ManifestSetupPatch, pathLabel: string): ManifestSetup {
	if (!patch.domain) {
		throw new Error(`${pathLabel}.domain is required for replace overrides`);
	}
	return {
		domain: patch.domain,
		...(patch.mode !== undefined ? { mode: patch.mode } : {}),
		...(patch.skills !== undefined ? { skills: patch.skills } : {}),
		...(patch.tools !== undefined ? { tools: patch.tools } : {}),
		...(patch.sandbox !== undefined ? { sandbox: patch.sandbox } : {}),
		...(patch.timeout !== undefined ? { timeout: patch.timeout } : {}),
		...(patch.maxCostUsd !== undefined ? { maxCostUsd: patch.maxCostUsd } : {}),
		...(patch.stateStores !== undefined ? { stateStores: patch.stateStores } : {}),
	};
}

function materializeGoal(patch: ManifestGoalPatch, pathLabel: string): ManifestGoal {
	if (!patch.setup) {
		throw new Error(`${pathLabel}.setup is required for replace overrides`);
	}
	if (!patch.schedule) {
		throw new Error(`${pathLabel}.schedule is required for replace overrides`);
	}
	if (!patch.prompt && !patch.action) {
		throw new Error(`${pathLabel} must define prompt or action for replace overrides`);
	}
	return {
		setup: patch.setup,
		schedule: patch.schedule,
		...(patch.prompt !== undefined ? { prompt: patch.prompt } : {}),
		...(patch.action !== undefined ? { action: patch.action } : {}),
		...(patch.hooks !== undefined ? { hooks: patch.hooks } : {}),
		...(patch.state !== undefined ? { state: patch.state } : {}),
		...(patch.stateStores !== undefined ? { stateStores: patch.stateStores } : {}),
		...(patch.retry !== undefined ? { retry: patch.retry } : {}),
	};
}

function mergeSetup(base: ManifestSetup, patch: ManifestSetupPatch, pathLabel: string): ManifestSetup {
	const merged = structuredClone(base);
	for (const [field, value] of Object.entries(patch) as [SetupField, ManifestSetupPatch[SetupField]][]) {
		if (value === undefined) continue;
		const strategy = SETUP_MERGE_STRATEGIES[field];
		if (strategy === "replace") {
			if (field === "domain") merged.domain = value as string;
			if (field === "mode") merged.mode = value as string;
			if (field === "timeout") merged.timeout = value as string;
			if (field === "maxCostUsd") merged.maxCostUsd = value as number;
			continue;
		}
		if (strategy === "filter") {
			if (field === "skills") merged.skills = mergeFilterConfig(merged.skills, value as FilterConfig);
			if (field === "tools") merged.tools = mergeFilterConfig(merged.tools, value as FilterConfig);
			continue;
		}
		if (strategy === "sandbox") {
			merged.sandbox = mergeSandboxConfig(merged.sandbox, value as SandboxConfig);
			continue;
		}
		if (strategy === "stateStores") {
			merged.stateStores = mergeStateStores(merged.stateStores, value as Map<string, NamedStateStore>);
			continue;
		}
		throw new Error(`${pathLabel}.${field} is not mergeable`);
	}
	return merged;
}

function mergeGoal(base: ManifestGoal, patch: ManifestGoalPatch, pathLabel: string): ManifestGoal {
	const merged = structuredClone(base);
	for (const [field, value] of Object.entries(patch) as [GoalField, ManifestGoalPatch[GoalField]][]) {
		if (value === undefined) continue;
		const strategy = GOAL_MERGE_STRATEGIES[field];
		if (strategy === "replace") {
			if (field === "setup") merged.setup = value as string;
			if (field === "prompt") merged.prompt = value as string;
			continue;
		}
		if (strategy === "hooks") {
			merged.hooks = mergeHooks(merged.hooks, value as ManifestHookConfig);
			continue;
		}
		if (strategy === "retry") {
			merged.retry = mergeRetry(merged.retry, value as RetryConfig);
			continue;
		}
		if (strategy === "state") {
			merged.state = mergeState(merged.state, value as StateConfig);
			continue;
		}
		if (strategy === "stateStores") {
			merged.stateStores = mergeStateStores(merged.stateStores, value as Map<string, NamedStateStore>);
			continue;
		}
		if (strategy === "nonMergeable") {
			throw new Error(`${pathLabel}.${field} is not mergeable; use strategy="replace" on the whole symbol instead`);
		}
	}
	return merged;
}

async function readManifestText(filePath: string): Promise<string> {
	try {
		return await Bun.file(filePath).text();
	} catch (error) {
		if (isEnoent(error)) {
			throw new Error(`Missing manifest file: ${filePath}`);
		}
		throw error;
	}
}

function prefixSetupSymbols(alias: string, symbols: Map<string, ManifestSetup>): Map<string, ManifestSetup> {
	const prefixed = new Map<string, ManifestSetup>();
	for (const [name, value] of symbols) {
		prefixed.set(`${alias}.${name}`, structuredClone(value));
	}
	return prefixed;
}

function prefixGoalSymbols(
	alias: string,
	goals: Map<string, ManifestGoal>,
	setups: Map<string, ManifestSetup>,
): Map<string, ManifestGoal> {
	const prefixed = new Map<string, ManifestGoal>();
	for (const [name, goal] of goals) {
		const prefixedGoal = structuredClone(goal);
		if (setups.has(goal.setup)) {
			prefixedGoal.setup = `${alias}.${goal.setup}`;
		}
		prefixed.set(`${alias}.${name}`, prefixedGoal);
	}
	return prefixed;
}

function appendPrefixedItems<T extends { id: string }>(
	target: T[],
	items: T[],
	alias: string,
	collisionMessage: (id: string) => string,
): void {
	for (const item of prefixIdArray(alias, items)) {
		if (target.some(existing => existing.id === item.id)) {
			throw new Error(collisionMessage(item.id));
		}
		target.push(item);
	}
}

function appendItems<T extends { id: string }>(
	target: T[],
	items: T[],
	collisionMessage: (id: string) => string,
): void {
	for (const item of items) {
		if (target.some(existing => existing.id === item.id)) {
			throw new Error(collisionMessage(item.id));
		}
		target.push(structuredClone(item));
	}
}

function mergePrefixedSymbols<T>(
	target: Map<string, T>,
	prefixed: Map<string, T>,
	collisionMessage: (name: string) => string,
): void {
	for (const [name, value] of prefixed) {
		if (target.has(name)) {
			throw new Error(collisionMessage(name));
		}
		target.set(name, value);
	}
}

async function hydratePromptFileContents(manifest: AutonomyManifest): Promise<void> {
	for (const [goalName, goal] of manifest.goals) {
		if (!goal.action) continue;
		for (const [slotName, slot] of Object.entries(goal.action.promptSlots)) {
			if (slot.kind !== "file" || !slot.path) continue;
			try {
				slot.content = await Bun.file(slot.path).text();
			} catch (error) {
				if (isEnoent(error)) {
					throw new Error(`goals.${goalName}.action.promptSlots.${slotName} references missing file ${slot.path}`);
				}
				throw error;
			}
		}
	}
}

async function resolveManifestModule(filePath: string, context: ResolveContext): Promise<ResolvedManifestModule> {
	const absolutePath = path.resolve(filePath);
	const cached = context.cache.get(absolutePath);
	if (cached) {
		return {
			name: cached.name,
			version: cached.version,
			setups: cloneMap(cached.setups),
			goals: cloneMap(cached.goals),
			exportTargets: cloneArray(cached.exportTargets),
			notificationRoutes: cloneArray(cached.notificationRoutes),
			reviewPolicies: cloneArray(cached.reviewPolicies),
			checkpoints: cloneArray(cached.checkpoints),
			panels: cloneArray(cached.panels),
			layouts: cloneArray(cached.layouts),
			syncCollections: cloneArray(cached.syncCollections),
			stateSchemas: cloneArray(cached.stateSchemas),
			toolModules: cloneArray(cached.toolModules),
			operatorActions: cloneArray(cached.operatorActions),
		};
	}
	if (context.stack.includes(absolutePath)) {
		throw new Error(`Manifest import cycle detected: ${[...context.stack, absolutePath].join(" -> ")}`);
	}

	const parseOptions: ParseManifestOptions = {
		filePath: absolutePath,
		env: context.env,
		registry: context.registry,
	};
	const manifestText = await readManifestText(absolutePath);
	const manifestModule = parseManifestModuleDocument(parse(manifestText), parseOptions);
	for (const descriptor of manifestModule.actionDescriptors) {
		if (!context.registry.has(descriptor.id)) {
			context.registry.register(descriptor);
		}
	}

	const setups = new Map<string, ManifestSetup>();
	const goals = new Map<string, ManifestGoal>();
	const exportTargets: ExportTarget[] = [];
	const notificationRoutes: NotificationRoute[] = [];
	const reviewPolicies: ReviewPolicy[] = [];
	const checkpoints: Checkpoint[] = [];
	const panels: Panel[] = [];
	const layouts: Layout[] = [];
	const syncCollections: SyncCollection[] = [];
	const stateSchemas: StateSchema[] = [];
	const toolModules: ToolModule[] = [];
	const operatorActions: OperatorAction[] = [];
	const aliasSet = new Set<string>();

	for (const manifestImport of manifestModule.imports) {
		if (aliasSet.has(manifestImport.alias)) {
			throw new Error(`Duplicate import alias "${manifestImport.alias}" in ${absolutePath}`);
		}
		aliasSet.add(manifestImport.alias);
		const imported = await resolveManifestModule(path.resolve(path.dirname(absolutePath), manifestImport.source), {
			...context,
			stack: [...context.stack, absolutePath],
		});
		mergePrefixedSymbols(
			setups,
			prefixSetupSymbols(manifestImport.alias, imported.setups),
			name => `Imported setup collision for ${name}`,
		);
		mergePrefixedSymbols(
			goals,
			prefixGoalSymbols(manifestImport.alias, imported.goals, imported.setups),
			name => `Imported goal collision for ${name}`,
		);
		appendPrefixedItems(
			exportTargets,
			imported.exportTargets,
			manifestImport.alias,
			id => `Imported export-target collision for ${id}`,
		);
		appendPrefixedItems(
			notificationRoutes,
			imported.notificationRoutes,
			manifestImport.alias,
			id => `Imported notification-route collision for ${id}`,
		);
		appendPrefixedItems(
			reviewPolicies,
			imported.reviewPolicies,
			manifestImport.alias,
			id => `Imported review-policy collision for ${id}`,
		);
		appendPrefixedItems(
			checkpoints,
			imported.checkpoints,
			manifestImport.alias,
			id => `Imported checkpoint collision for ${id}`,
		);
		appendPrefixedItems(panels, imported.panels, manifestImport.alias, id => `Imported panel collision for ${id}`);
		appendPrefixedItems(layouts, imported.layouts, manifestImport.alias, id => `Imported layout collision for ${id}`);
		appendPrefixedItems(
			syncCollections,
			imported.syncCollections,
			manifestImport.alias,
			id => `Imported sync-collection collision for ${id}`,
		);
		appendPrefixedItems(
			stateSchemas,
			imported.stateSchemas,
			manifestImport.alias,
			id => `Imported state-schema collision for ${id}`,
		);
		appendPrefixedItems(
			toolModules,
			imported.toolModules,
			manifestImport.alias,
			id => `Imported tool-module collision for ${id}`,
		);
		appendPrefixedItems(
			operatorActions,
			imported.operatorActions,
			manifestImport.alias,
			id => `Imported operator-action collision for ${id}`,
		);
	}

	mergePrefixedSymbols(setups, manifestModule.setups, name => `Duplicate setup "${name}"`);
	mergePrefixedSymbols(goals, manifestModule.goals, name => `Duplicate goal "${name}"`);
	appendItems(exportTargets, manifestModule.exportTargets, id => `Duplicate export-target "${id}"`);
	appendItems(notificationRoutes, manifestModule.notificationRoutes, id => `Duplicate notification-route "${id}"`);
	appendItems(reviewPolicies, manifestModule.reviewPolicies, id => `Duplicate review-policy "${id}"`);
	appendItems(checkpoints, manifestModule.checkpoints, id => `Duplicate checkpoint "${id}"`);
	appendItems(panels, manifestModule.panels, id => `Duplicate panel "${id}"`);
	appendItems(layouts, manifestModule.layouts, id => `Duplicate layout "${id}"`);
	appendItems(syncCollections, manifestModule.syncCollections, id => `Duplicate sync-collection "${id}"`);
	appendItems(stateSchemas, manifestModule.stateSchemas, id => `Duplicate state-schema "${id}"`);
	appendItems(toolModules, manifestModule.toolModules, id => `Duplicate tool-module "${id}"`);
	appendItems(operatorActions, manifestModule.operatorActions, id => `Duplicate operator-action "${id}"`);

	for (const [index, override] of manifestModule.overrides.entries()) {
		if (override.kind === "setup") {
			const target = setups.get(override.from);
			if (!target) {
				throw new Error(`overrides.${index}.from references unknown setup "${override.from}"`);
			}
			setups.set(
				override.name,
				override.strategy === "replace"
					? materializeSetup(override.value, `overrides.${index}`)
					: mergeSetup(target, override.value, `overrides.${index}`),
			);
			continue;
		}
		const target = goals.get(override.from);
		if (!target) {
			throw new Error(`overrides.${index}.from references unknown goal "${override.from}"`);
		}
		goals.set(
			override.name,
			override.strategy === "replace"
				? materializeGoal(override.value, `overrides.${index}`)
				: mergeGoal(target, override.value, `overrides.${index}`),
		);
	}

	const resolved: ResolvedManifestModule = {
		name: manifestModule.name,
		version: manifestModule.version,
		setups,
		goals,
		exportTargets,
		notificationRoutes,
		reviewPolicies,
		checkpoints,
		panels,
		layouts,
		syncCollections,
		stateSchemas,
		toolModules,
		operatorActions,
	};
	context.cache.set(absolutePath, {
		name: resolved.name,
		version: resolved.version,
		setups: cloneMap(resolved.setups),
		goals: cloneMap(resolved.goals),
		exportTargets: cloneArray(resolved.exportTargets),
		notificationRoutes: cloneArray(resolved.notificationRoutes),
		reviewPolicies: cloneArray(resolved.reviewPolicies),
		checkpoints: cloneArray(resolved.checkpoints),
		panels: cloneArray(resolved.panels),
		layouts: cloneArray(resolved.layouts),
		syncCollections: cloneArray(resolved.syncCollections),
		stateSchemas: cloneArray(resolved.stateSchemas),
		toolModules: cloneArray(resolved.toolModules),
		operatorActions: cloneArray(resolved.operatorActions),
	});
	return resolved;
}

export async function loadManifestFromFile(
	filePath: string,
	options: ManifestLoadOptions = {},
): Promise<AutonomyManifest> {
	const registry = options.registry ?? createBuiltinActionRegistry();
	const resolved = await resolveManifestModule(filePath, {
		cache: new Map<string, ResolvedManifestModule>(),
		stack: [],
		registry,
		env: options.env ?? process.env,
	});
	if (!resolved.name) {
		throw new Error("name is required");
	}
	if (!resolved.version) {
		throw new Error("version is required");
	}
	const manifest: AutonomyManifest = {
		name: resolved.name,
		version: resolved.version,
		setups: resolved.setups,
		goals: resolved.goals,
		exportTargets: resolved.exportTargets,
		notificationRoutes: resolved.notificationRoutes,
		reviewPolicies: resolved.reviewPolicies,
		checkpoints: resolved.checkpoints,
		panels: resolved.panels,
		layouts: resolved.layouts,
		syncCollections: resolved.syncCollections,
		stateSchemas: resolved.stateSchemas,
		toolModules: resolved.toolModules,
		operatorActions: resolved.operatorActions,
	};
	await hydratePromptFileContents(manifest);
	if (!isValidManifest(manifest)) {
		throw new Error("Resolved manifest does not match manifest schema");
	}
	const validation = validateManifest(manifest, registry);
	if (!validation.valid) {
		throw new Error(validation.errors.map(error => `${error.path}: ${error.message}`).join("\n"));
	}
	return manifest;
}
