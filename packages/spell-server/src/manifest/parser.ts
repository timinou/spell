import * as path from "node:path";
import type { Document, Node } from "@bgotink/kdl";
import { parse } from "@bgotink/kdl";
import { ActionRegistry } from "../actions/registry";
import type {
	ActionDescriptor,
	ActionParameterDescriptor,
	ActionParameterType,
	ActionPromptSlotDescriptor,
	ActionScalar,
	ActionValue,
	ManifestAction,
} from "../actions/types";
import { parseEnvReference, resolveEnvValue as resolveEnvIfNeeded } from "../config/env-resolver";
import {
	type AutonomyManifest,
	type Checkpoint,
	type CheckpointRequirement,
	type CronSchedule,
	type ExportTarget,
	type FilterConfig,
	type GoalOverride,
	type HookTarget,
	isValidManifest,
	type Layout,
	type LayoutRegion,
	type ManifestGoal,
	type ManifestGoalPatch,
	type ManifestHookConfig,
	type ManifestImport,
	type ManifestOverride,
	type ManifestOverrideStrategy,
	type ManifestSetup,
	type ManifestSetupPatch,
	type NamedStateStore,
	type NotificationRoute,
	type OperatorAction,
	type OperatorActionTransition,
	type OrgHook,
	type Panel,
	type PanelAction,
	type PanelColumn,
	type ParsedManifestModule,
	type RetryConfig,
	type ReviewPolicy,
	type ReviewPolicyState,
	type ReviewPolicyTransition,
	type SandboxConfig,
	type SetupOverride,
	type StateConfig,
	type StateSchema,
	type StateSchemaColumn,
	type StateSchemaTable,
	type StateSchemaTableColumn,
	type SyncCollection,
	type TelegramHook,
	type ToolModule,
	type WebhookHook,
	type WebhookSchedule,
} from "./types";
import { validateManifest } from "./validator";

export interface ParseManifestOptions {
	filePath?: string;
	env?: Record<string, string | undefined>;
	registry?: ActionRegistry;
}

const ACTION_PARAM_TYPES = new Set<ActionParameterType>([
	"string",
	"number",
	"boolean",
	"string[]",
	"number[]",
	"boolean[]",
	"json",
]);

function getNodeName(node: Node): string {
	return node.getName();
}

function resolveOptionalStringProperty(
	node: Node,
	property: string,
	pathLabel: string,
	options: ParseManifestOptions,
): string | undefined {
	const value = node.getProperty(property);
	if (value === undefined) return undefined;
	return resolveEnvIfNeeded<string>(value, "string", `${pathLabel}.${property}`, options.env);
}

function resolveOptionalNumberProperty(
	node: Node,
	property: string,
	pathLabel: string,
	options: ParseManifestOptions,
): number | undefined {
	const value = node.getProperty(property);
	if (value === undefined) return undefined;
	return resolveEnvIfNeeded<number>(value, "number", `${pathLabel}.${property}`, options.env);
}

function resolveOptionalBooleanProperty(
	node: Node,
	property: string,
	pathLabel: string,
	options: ParseManifestOptions,
): boolean | undefined {
	const value = node.getProperty(property);
	if (value === undefined) return undefined;
	return resolveEnvIfNeeded<boolean>(value, "boolean", `${pathLabel}.${property}`, options.env);
}

function expectStringArgument(node: Node, pathLabel: string, index: number, options: ParseManifestOptions): string {
	return resolveEnvIfNeeded<string>(node.getArgument(index), "string", pathLabel, options.env);
}

function expectNumberArgument(node: Node, pathLabel: string, index: number, options: ParseManifestOptions): number {
	return resolveEnvIfNeeded<number>(node.getArgument(index), "number", pathLabel, options.env);
}

function expectBooleanProperty(
	node: Node,
	property: string,
	pathLabel: string,
	options: ParseManifestOptions,
): boolean {
	const value = resolveOptionalBooleanProperty(node, property, pathLabel, options);
	if (value === undefined) {
		throw new Error(`${pathLabel}.${property} must be a boolean`);
	}
	return value;
}

function parseStringArguments(node: Node, pathLabel: string, options: ParseManifestOptions, startIndex = 0): string[] {
	const values = node.getArguments().slice(startIndex);
	return values.map((_, index) => expectStringArgument(node, `${pathLabel}.${index}`, startIndex + index, options));
}

function parseFilterNode(node: Node, pathLabel: string, options: ParseManifestOptions): FilterConfig {
	const allowNode = node.children?.findNodeByName("allow");
	const denyNode = node.children?.findNodeByName("deny");
	const filter: FilterConfig = {};

	if (allowNode) {
		filter.allow = parseStringArguments(allowNode, `${pathLabel}.allow`, options);
	}
	if (denyNode) {
		filter.deny = parseStringArguments(denyNode, `${pathLabel}.deny`, options);
	}

	return filter;
}

function parseSandboxNode(node: Node, pathLabel: string, options: ParseManifestOptions): SandboxConfig {
	const sandbox: SandboxConfig = {};
	for (const child of node.children?.nodes ?? []) {
		const childName = getNodeName(child);
		const values = parseStringArguments(child, `${pathLabel}.${childName}`, options);
		if (childName === "paths-write") sandbox.pathsWrite = values;
		if (childName === "bash-allow") sandbox.bashAllow = values;
		if (childName === "bash-deny") sandbox.bashDeny = values;
	}
	return sandbox;
}

function parseStateStoreNode(node: Node, pathLabel: string, options: ParseManifestOptions): [string, NamedStateStore] {
	const name = expectStringArgument(node, `${pathLabel}.name`, 0, options);
	const backend = resolveOptionalStringProperty(node, "backend", pathLabel, options);
	const stateStorePath = resolveOptionalStringProperty(node, "path", pathLabel, options);
	const schema = resolveOptionalStringProperty(node, "schema", pathLabel, options);
	if (!backend) {
		throw new Error(`${pathLabel}.backend is required`);
	}
	if (backend !== "sqlite" && backend !== "artifact-store") {
		throw new Error(`${pathLabel}.backend must be sqlite or artifact-store`);
	}
	if (!stateStorePath) {
		throw new Error(`${pathLabel}.path is required`);
	}
	return [name, { backend, path: stateStorePath, ...(schema !== undefined ? { schema } : {}) }];
}

function parseStateStoreChildren(
	node: Node,
	pathLabel: string,
	options: ParseManifestOptions,
): Map<string, NamedStateStore> | undefined {
	const stateStores = new Map<string, NamedStateStore>();
	for (const child of node.children?.nodes ?? []) {
		if (getNodeName(child) !== "state-store") continue;
		const [name, stateStore] = parseStateStoreNode(child, `${pathLabel}.state-store.${stateStores.size}`, options);
		stateStores.set(name, stateStore);
	}
	return stateStores.size === 0 ? undefined : stateStores;
}

function parseHookTarget(node: Node, pathLabel: string, options: ParseManifestOptions): HookTarget {
	const name = getNodeName(node);
	if (name === "webhook") {
		const method = resolveOptionalStringProperty(node, "method", pathLabel, options);
		if (method !== undefined && method !== "POST" && method !== "GET") {
			throw new Error(`${pathLabel}.method must be POST or GET`);
		}
		return {
			type: "webhook",
			url: expectStringArgument(node, pathLabel, 0, options),
			...(method !== undefined ? { method } : {}),
		} satisfies WebhookHook;
	}
	if (name === "telegram") {
		const chatId = resolveOptionalNumberProperty(node, "chat-id", pathLabel, options);
		if (chatId === undefined) {
			throw new Error(`${pathLabel}.chat-id must be a finite number`);
		}
		return { type: "telegram", chatId } satisfies TelegramHook;
	}
	if (name === "org") {
		const category = resolveOptionalStringProperty(node, "category", pathLabel, options);
		return { type: "org", ...(category !== undefined ? { category } : {}) } satisfies OrgHook;
	}
	throw new Error(`${pathLabel} has unsupported hook target "${name}"`);
}

function parseHooksNode(node: Node, pathLabel: string, options: ParseManifestOptions): ManifestHookConfig {
	const hooks: ManifestHookConfig = {};
	for (const child of node.children?.nodes ?? []) {
		const targets = (child.children?.nodes ?? []).map((target, index) =>
			parseHookTarget(target, `${pathLabel}.${getNodeName(child)}.${index}`, options),
		);
		if (getNodeName(child) === "on-success") hooks.onSuccess = targets;
		if (getNodeName(child) === "on-failure") hooks.onFailure = targets;
		if (getNodeName(child) === "on-complete") hooks.onComplete = targets;
	}
	return hooks;
}

function parseStateNode(node: Node, pathLabel: string, options: ParseManifestOptions): StateConfig {
	const persist = expectBooleanProperty(node, "persist", pathLabel, options);
	const schema = (node.children?.findNodesByName("schema") ?? []).map((schemaNode, index) => {
		const name = expectStringArgument(schemaNode, `${pathLabel}.schema.${index}.name`, 0, options);
		const typeValue = resolveOptionalStringProperty(schemaNode, "type", `${pathLabel}.schema.${index}`, options);
		if (typeValue !== "string" && typeValue !== "number" && typeValue !== "boolean" && typeValue !== "json") {
			throw new Error(`${pathLabel}.schema.${index}.type must be one of string, number, boolean, json`);
		}
		return { name, type: typeValue } satisfies StateSchemaColumn;
	});
	return schema.length === 0 ? { persist } : { persist, schema };
}

function parseRetryNode(node: Node, pathLabel: string, options: ParseManifestOptions): RetryConfig {
	const retry: RetryConfig = {};
	const maxRetries = resolveOptionalNumberProperty(node, "max-retries", pathLabel, options);
	if (maxRetries !== undefined) retry.maxRetries = maxRetries;
	const initialDelayMs = resolveOptionalNumberProperty(node, "initial-delay-ms", pathLabel, options);
	if (initialDelayMs !== undefined) retry.initialDelayMs = initialDelayMs;
	const multiplier = resolveOptionalNumberProperty(node, "multiplier", pathLabel, options);
	if (multiplier !== undefined) retry.multiplier = multiplier;
	return retry;
}

function parseScheduleNode(
	node: Node,
	pathLabel: string,
	options: ParseManifestOptions,
): CronSchedule | WebhookSchedule {
	const type = resolveOptionalStringProperty(node, "type", pathLabel, options);
	if (type === "cron") {
		const expression = resolveOptionalStringProperty(node, "expression", pathLabel, options);
		if (!expression) {
			throw new Error(`${pathLabel}.expression must be a string`);
		}
		const timezone = resolveOptionalStringProperty(node, "timezone", pathLabel, options);
		const jitter = resolveOptionalStringProperty(node, "jitter", pathLabel, options);
		return {
			type,
			expression,
			...(timezone !== undefined ? { timezone } : {}),
			...(jitter !== undefined ? { jitter } : {}),
		};
	}
	if (type === "webhook") {
		const pathValue = resolveOptionalStringProperty(node, "path", pathLabel, options);
		const auth = resolveOptionalStringProperty(node, "auth", pathLabel, options);
		if (auth !== undefined && auth !== "hmac" && auth !== "bearer") {
			throw new Error(`${pathLabel}.auth must be hmac or bearer`);
		}
		return { type, ...(pathValue !== undefined ? { path: pathValue } : {}), ...(auth !== undefined ? { auth } : {}) };
	}
	throw new Error(`${pathLabel}.type must be cron or webhook`);
}

function resolveActionScalarValue(
	value: unknown,
	descriptorType: ActionParameterType | undefined,
	pathLabel: string,
	options: ParseManifestOptions,
): ActionScalar {
	if (descriptorType === "number") {
		return resolveEnvIfNeeded<number>(value, "number", pathLabel, options.env);
	}
	if (descriptorType === "boolean") {
		return resolveEnvIfNeeded<boolean>(value, "boolean", pathLabel, options.env);
	}
	if (descriptorType === "string") {
		return resolveEnvIfNeeded<string>(value, "string", pathLabel, options.env);
	}
	if (typeof value === "string") {
		const envReference = parseEnvReference(value);
		if (!envReference) {
			return value;
		}
		const envValue = options.env?.[envReference.name];
		if (envValue === undefined || envValue === "") {
			if (envReference.defaultValue !== undefined) {
				return envReference.defaultValue;
			}
			if (envReference.optional) {
				return "";
			}
			throw new Error(`${pathLabel} requires environment variable ${envReference.name}`);
		}
		return envValue;
	}
	if (value === null || typeof value === "number" || typeof value === "boolean") {
		return value;
	}
	throw new Error(`${pathLabel} must be a scalar action value`);
}

function resolveActionListValue(
	node: Node,
	descriptorType: ActionParameterType | undefined,
	pathLabel: string,
	options: ParseManifestOptions,
): ActionScalar[] {
	const rawValues = node.getArguments().slice(1);
	if (descriptorType === "string[]") {
		return rawValues.map((_, index) =>
			resolveEnvIfNeeded<string>(node.getArgument(index + 1), "string", `${pathLabel}.${index}`, options.env),
		);
	}
	if (descriptorType === "number[]") {
		return rawValues.map((_, index) =>
			resolveEnvIfNeeded<number>(node.getArgument(index + 1), "number", `${pathLabel}.${index}`, options.env),
		);
	}
	if (descriptorType === "boolean[]") {
		return rawValues.map((_, index) =>
			resolveEnvIfNeeded<boolean>(node.getArgument(index + 1), "boolean", `${pathLabel}.${index}`, options.env),
		);
	}
	return rawValues.map((value, index) => resolveActionScalarValue(value, undefined, `${pathLabel}.${index}`, options));
}

function parseActionJsonValue(node: Node, pathLabel: string, options: ParseManifestOptions): ActionValue {
	const jsonText = expectStringArgument(node, pathLabel, 1, options);
	try {
		return JSON.parse(jsonText) as ActionValue;
	} catch (error) {
		const details = error instanceof Error ? `: ${error.message}` : "";
		throw new Error(`${pathLabel} must be valid JSON${details}`);
	}
}

function parseActionDescriptorNode(node: Node, pathLabel: string, options: ParseManifestOptions): ActionDescriptor {
	const id = expectStringArgument(node, `${pathLabel}.id`, 0, options);
	const source = resolveOptionalStringProperty(node, "source", pathLabel, options) ?? "project";
	if (source !== "first-party" && source !== "project") {
		throw new Error(`${pathLabel}.source must be "first-party" or "project"`);
	}
	const descriptor: ActionDescriptor = { id, source };
	const params: Record<string, ActionParameterDescriptor> = {};
	const promptSlots: Record<string, ActionPromptSlotDescriptor> = {};

	for (const child of node.children?.nodes ?? []) {
		const childName = getNodeName(child);
		if (childName === "param") {
			const paramName = expectStringArgument(child, `${pathLabel}.param.name`, 0, options);
			const typeValue = resolveOptionalStringProperty(child, "type", `${pathLabel}.param.${paramName}`, options);
			if (!typeValue) {
				throw new Error(`${pathLabel}.param.${paramName}.type is required`);
			}
			if (!ACTION_PARAM_TYPES.has(typeValue as ActionParameterType)) {
				throw new Error(
					`${pathLabel}.param.${paramName}.type must be one of: ${[...ACTION_PARAM_TYPES].join(", ")}`,
				);
			}
			const required = resolveOptionalBooleanProperty(child, "required", `${pathLabel}.param.${paramName}`, options);
			params[paramName] = {
				type: typeValue as ActionParameterType,
				...(required !== undefined ? { required } : {}),
			};
			continue;
		}
		if (childName === "prompt-slot") {
			const slotName = expectStringArgument(child, `${pathLabel}.prompt-slot.name`, 0, options);
			const required = resolveOptionalBooleanProperty(
				child,
				"required",
				`${pathLabel}.prompt-slot.${slotName}`,
				options,
			);
			promptSlots[slotName] = { ...(required !== undefined ? { required } : {}) };
			continue;
		}
		throw new Error(`${pathLabel} has unsupported child "${childName}"`);
	}

	if (Object.keys(params).length > 0) descriptor.params = params;
	if (Object.keys(promptSlots).length > 0) descriptor.promptSlots = promptSlots;
	return descriptor;
}

function parseActionNode(node: Node, pathLabel: string, options: ParseManifestOptions): ManifestAction {
	const id = expectStringArgument(node, `${pathLabel}.id`, 0, options);
	const descriptor = options.registry?.get(id);
	const action: ManifestAction = {
		id,
		params: {},
		promptSlots: {},
	};

	for (const child of node.children?.nodes ?? []) {
		const childName = getNodeName(child);
		if (childName === "param") {
			const paramName = expectStringArgument(child, `${pathLabel}.param.name`, 0, options);
			const descriptorType = descriptor?.params?.[paramName]?.type;
			action.params[paramName] = resolveActionScalarValue(
				child.getArgument(1),
				descriptorType,
				`${pathLabel}.param.${paramName}`,
				options,
			);
			continue;
		}
		if (childName === "param-list") {
			const paramName = expectStringArgument(child, `${pathLabel}.param-list.name`, 0, options);
			const descriptorType = descriptor?.params?.[paramName]?.type;
			action.params[paramName] = resolveActionListValue(
				child,
				descriptorType,
				`${pathLabel}.param-list.${paramName}`,
				options,
			);
			continue;
		}
		if (childName === "param-json") {
			const paramName = expectStringArgument(child, `${pathLabel}.param-json.name`, 0, options);
			action.params[paramName] = parseActionJsonValue(child, `${pathLabel}.param-json.${paramName}`, options);
			continue;
		}
		if (childName === "prompt") {
			const slotName = expectStringArgument(child, `${pathLabel}.prompt.name`, 0, options);
			action.promptSlots[slotName] = {
				name: slotName,
				kind: "inline",
				content: expectStringArgument(child, `${pathLabel}.prompt.${slotName}`, 1, options),
			};
			continue;
		}
		if (childName === "prompt-file") {
			const slotName = expectStringArgument(child, `${pathLabel}.prompt-file.name`, 0, options);
			const slotPath = expectStringArgument(child, `${pathLabel}.prompt-file.${slotName}`, 1, options);
			action.promptSlots[slotName] = {
				name: slotName,
				kind: "file",
				path: options.filePath ? path.resolve(path.dirname(options.filePath), slotPath) : slotPath,
			};
			continue;
		}
		throw new Error(`${pathLabel} has unsupported action child "${childName}"`);
	}

	return action;
}

function parseSetupPatch(node: Node, pathLabel: string, options: ParseManifestOptions): ManifestSetupPatch {
	const setup: ManifestSetupPatch = {};
	for (const child of node.children?.nodes ?? []) {
		const childName = getNodeName(child);
		if (childName === "domain") setup.domain = expectStringArgument(child, `${pathLabel}.domain`, 0, options);
		if (childName === "mode") setup.mode = expectStringArgument(child, `${pathLabel}.mode`, 0, options);
		if (childName === "skills") setup.skills = parseFilterNode(child, `${pathLabel}.skills`, options);
		if (childName === "tools") setup.tools = parseFilterNode(child, `${pathLabel}.tools`, options);
		if (childName === "sandbox") setup.sandbox = parseSandboxNode(child, `${pathLabel}.sandbox`, options);
		if (childName === "timeout") setup.timeout = expectStringArgument(child, `${pathLabel}.timeout`, 0, options);
		if (childName === "max-cost-usd")
			setup.maxCostUsd = expectNumberArgument(child, `${pathLabel}.max-cost-usd`, 0, options);
	}
	setup.stateStores = parseStateStoreChildren(node, pathLabel, options);
	return setup;
}

function finalizeSetup(patch: ManifestSetupPatch, pathLabel: string): ManifestSetup {
	if (!patch.domain) {
		throw new Error(`${pathLabel}.domain is required`);
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

function parseGoalPatch(node: Node, pathLabel: string, options: ParseManifestOptions): ManifestGoalPatch {
	const goal: ManifestGoalPatch = {};
	for (const child of node.children?.nodes ?? []) {
		const childName = getNodeName(child);
		if (childName === "setup") goal.setup = expectStringArgument(child, `${pathLabel}.setup`, 0, options);
		if (childName === "schedule") goal.schedule = parseScheduleNode(child, `${pathLabel}.schedule`, options);
		if (childName === "prompt") goal.prompt = expectStringArgument(child, `${pathLabel}.prompt`, 0, options);
		if (childName === "action") goal.action = parseActionNode(child, `${pathLabel}.action`, options);
		if (childName === "hooks") goal.hooks = parseHooksNode(child, `${pathLabel}.hooks`, options);
		if (childName === "state") goal.state = parseStateNode(child, `${pathLabel}.state`, options);
		if (childName === "retry") goal.retry = parseRetryNode(child, `${pathLabel}.retry`, options);
	}
	goal.stateStores = parseStateStoreChildren(node, pathLabel, options);
	return goal;
}

function finalizeGoal(patch: ManifestGoalPatch, pathLabel: string): ManifestGoal {
	if (!patch.setup) throw new Error(`${pathLabel}.setup is required`);
	if (!patch.schedule) throw new Error(`${pathLabel}.schedule is required`);
	if (!patch.prompt && !patch.action) throw new Error(`${pathLabel} must define prompt or action`);
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

function validateSymbolName(name: string, pathLabel: string): void {
	if (name.includes(".")) {
		throw new Error(`${pathLabel} must not contain '.' because dotted names are reserved for imported aliases`);
	}
}

function parseImportNode(node: Node, pathLabel: string, options: ParseManifestOptions): ManifestImport {
	const source = expectStringArgument(node, `${pathLabel}.source`, 0, options);
	const alias = resolveOptionalStringProperty(node, "as", pathLabel, options);
	if (!alias) {
		throw new Error(`${pathLabel}.as is required`);
	}
	validateSymbolName(alias, `${pathLabel}.as`);
	return { source, alias };
}

function parseOverrideStrategy(node: Node, pathLabel: string, options: ParseManifestOptions): ManifestOverrideStrategy {
	const strategy = resolveOptionalStringProperty(node, "strategy", pathLabel, options);
	if (strategy !== "replace" && strategy !== "merge") {
		throw new Error(`${pathLabel}.strategy must be replace or merge`);
	}
	return strategy;
}

function parseOverrideNode(node: Node, pathLabel: string, options: ParseManifestOptions): ManifestOverride {
	const kind = expectStringArgument(node, `${pathLabel}.kind`, 0, options);
	const name = expectStringArgument(node, `${pathLabel}.name`, 1, options);
	validateSymbolName(name, `${pathLabel}.name`);
	const from = resolveOptionalStringProperty(node, "from", pathLabel, options);
	if (!from) {
		throw new Error(`${pathLabel}.from is required`);
	}
	const strategy = parseOverrideStrategy(node, pathLabel, options);
	if (kind === "setup") {
		const value = parseSetupPatch(node, pathLabel, options);
		return { kind, name, from, strategy, value } satisfies SetupOverride;
	}
	if (kind === "goal") {
		const value = parseGoalPatch(node, pathLabel, options);
		return { kind, name, from, strategy, value } satisfies GoalOverride;
	}
	throw new Error(`${pathLabel}.kind must be "setup" or "goal"`);
}

function parseExportTargetNode(node: Node, pathLabel: string, options: ParseManifestOptions): ExportTarget {
	const id = expectStringArgument(node, `${pathLabel}.id`, 0, options);
	const kind = resolveOptionalStringProperty(node, "kind", pathLabel, options);
	if (!kind) {
		throw new Error(`${pathLabel}.kind is required`);
	}
	const url = resolveOptionalStringProperty(node, "url", pathLabel, options);
	const targetPath = resolveOptionalStringProperty(node, "path", pathLabel, options);
	const format = resolveOptionalStringProperty(node, "format", pathLabel, options);
	return {
		id,
		kind,
		...(url !== undefined ? { url } : {}),
		...(targetPath !== undefined ? { path: targetPath } : {}),
		...(format !== undefined ? { format } : {}),
	} satisfies ExportTarget;
}

function parseNotificationRouteNode(node: Node, pathLabel: string, options: ParseManifestOptions): NotificationRoute {
	const id = expectStringArgument(node, `${pathLabel}.id`, 0, options);
	const channel = resolveOptionalStringProperty(node, "channel", pathLabel, options);
	const on = resolveOptionalStringProperty(node, "on", pathLabel, options);
	if (!channel) {
		throw new Error(`${pathLabel}.channel is required`);
	}
	if (!on) {
		throw new Error(`${pathLabel}.on is required`);
	}
	const chatId = resolveOptionalNumberProperty(node, "chat-id", pathLabel, options);
	const url = resolveOptionalStringProperty(node, "url", pathLabel, options);
	const category = resolveOptionalStringProperty(node, "category", pathLabel, options);
	return {
		id,
		channel,
		on,
		...(chatId !== undefined ? { chatId } : {}),
		...(url !== undefined ? { url } : {}),
		...(category !== undefined ? { category } : {}),
	} satisfies NotificationRoute;
}

function parseReviewPolicyNode(node: Node, pathLabel: string, options: ParseManifestOptions): ReviewPolicy {
	const id = expectStringArgument(node, `${pathLabel}.id`, 0, options);
	const states: ReviewPolicyState[] = [];
	const transitions: ReviewPolicyTransition[] = [];
	for (const [index, child] of (node.children?.nodes ?? []).entries()) {
		const childName = getNodeName(child);
		if (childName === "state") {
			const name = expectStringArgument(child, `${pathLabel}.state.${states.length}.name`, 0, options);
			const initial = resolveOptionalBooleanProperty(
				child,
				"initial",
				`${pathLabel}.state.${states.length}`,
				options,
			);
			const terminal = resolveOptionalBooleanProperty(
				child,
				"terminal",
				`${pathLabel}.state.${states.length}`,
				options,
			);
			states.push({
				name,
				...(initial !== undefined ? { initial } : {}),
				...(terminal !== undefined ? { terminal } : {}),
			} satisfies ReviewPolicyState);
			continue;
		}
		if (childName === "transition") {
			const transitionPath = `${pathLabel}.transition.${transitions.length}`;
			const from = resolveOptionalStringProperty(child, "from", transitionPath, options);
			const to = resolveOptionalStringProperty(child, "to", transitionPath, options);
			const action = resolveOptionalStringProperty(child, "action", transitionPath, options);
			if (!from) throw new Error(`${transitionPath}.from is required`);
			if (!to) throw new Error(`${transitionPath}.to is required`);
			if (!action) throw new Error(`${transitionPath}.action is required`);
			transitions.push({ from, to, action } satisfies ReviewPolicyTransition);
			continue;
		}
		throw new Error(`${pathLabel} has unsupported child "${childName}" at index ${index}`);
	}
	return { id, states, transitions } satisfies ReviewPolicy;
}

function parseCheckpointNode(node: Node, pathLabel: string, options: ParseManifestOptions): Checkpoint {
	const id = expectStringArgument(node, `${pathLabel}.id`, 0, options);
	const requires: CheckpointRequirement[] = [];
	for (const [index, child] of (node.children?.nodes ?? []).entries()) {
		const childName = getNodeName(child);
		if (childName !== "require") {
			throw new Error(`${pathLabel} has unsupported child "${childName}" at index ${index}`);
		}
		const requirePath = `${pathLabel}.require.${requires.length}`;
		const name = expectStringArgument(child, `${requirePath}.name`, 0, options);
		const kind = resolveOptionalStringProperty(child, "kind", requirePath, options);
		if (!kind) throw new Error(`${requirePath}.kind is required`);
		const policy = resolveOptionalStringProperty(child, "policy", requirePath, options);
		const state = resolveOptionalStringProperty(child, "state", requirePath, options);
		const scope = resolveOptionalStringProperty(child, "scope", requirePath, options);
		requires.push({
			name,
			kind,
			...(policy !== undefined ? { policy } : {}),
			...(state !== undefined ? { state } : {}),
			...(scope !== undefined ? { scope } : {}),
		} satisfies CheckpointRequirement);
	}
	return { id, requires } satisfies Checkpoint;
}

function parsePanelNode(node: Node, pathLabel: string, options: ParseManifestOptions): Panel {
	const id = expectStringArgument(node, `${pathLabel}.id`, 0, options);
	const source = resolveOptionalStringProperty(node, "source", pathLabel, options);
	if (!source) {
		throw new Error(`${pathLabel}.source is required`);
	}
	const columns: PanelColumn[] = [];
	const actions: PanelAction[] = [];
	for (const [index, child] of (node.children?.nodes ?? []).entries()) {
		const childName = getNodeName(child);
		if (childName === "column") {
			const columnPath = `${pathLabel}.column.${columns.length}`;
			const name = expectStringArgument(child, `${columnPath}.name`, 0, options);
			const type = resolveOptionalStringProperty(child, "type", columnPath, options);
			if (!type) throw new Error(`${columnPath}.type is required`);
			columns.push({ name, type } satisfies PanelColumn);
			continue;
		}
		if (childName === "action") {
			const actionPath = `${pathLabel}.action.${actions.length}`;
			const name = expectStringArgument(child, `${actionPath}.name`, 0, options);
			const label = resolveOptionalStringProperty(child, "label", actionPath, options);
			if (!label) throw new Error(`${actionPath}.label is required`);
			actions.push({ name, label } satisfies PanelAction);
			continue;
		}
		throw new Error(`${pathLabel} has unsupported child "${childName}" at index ${index}`);
	}
	return { id, source, columns, actions } satisfies Panel;
}

function parseLayoutNode(node: Node, pathLabel: string, options: ParseManifestOptions): Layout {
	const id = expectStringArgument(node, `${pathLabel}.id`, 0, options);
	const regions: LayoutRegion[] = [];
	for (const [index, child] of (node.children?.nodes ?? []).entries()) {
		const childName = getNodeName(child);
		if (childName !== "region") {
			throw new Error(`${pathLabel} has unsupported child "${childName}" at index ${index}`);
		}
		const regionPath = `${pathLabel}.region.${regions.length}`;
		const name = expectStringArgument(child, `${regionPath}.name`, 0, options);
		const panel = resolveOptionalStringProperty(child, "panel", regionPath, options);
		if (!panel) throw new Error(`${regionPath}.panel is required`);
		regions.push({ name, panel } satisfies LayoutRegion);
	}
	return { id, regions } satisfies Layout;
}

function parseSyncCollectionNode(node: Node, pathLabel: string, options: ParseManifestOptions): SyncCollection {
	const id = expectStringArgument(node, `${pathLabel}.id`, 0, options);
	const source = resolveOptionalStringProperty(node, "source", pathLabel, options);
	if (!source) {
		throw new Error(`${pathLabel}.source is required`);
	}
	const filter = resolveOptionalStringProperty(node, "filter", pathLabel, options);
	return { id, source, ...(filter !== undefined ? { filter } : {}) } satisfies SyncCollection;
}

function parseStateSchemaNode(node: Node, pathLabel: string, options: ParseManifestOptions): StateSchema {
	const id = expectStringArgument(node, `${pathLabel}.id`, 0, options);
	const backend = resolveOptionalStringProperty(node, "backend", pathLabel, options);
	if (!backend) {
		throw new Error(`${pathLabel}.backend is required`);
	}
	const tables: StateSchemaTable[] = [];
	for (const [tableIndex, tableNode] of (node.children?.nodes ?? []).entries()) {
		const childName = getNodeName(tableNode);
		if (childName !== "table") {
			throw new Error(`${pathLabel} has unsupported child "${childName}" at index ${tableIndex}`);
		}
		const tablePath = `${pathLabel}.table.${tables.length}`;
		const name = expectStringArgument(tableNode, `${tablePath}.name`, 0, options);
		const columns: StateSchemaTableColumn[] = [];
		for (const [columnIndex, columnNode] of (tableNode.children?.nodes ?? []).entries()) {
			const columnName = getNodeName(columnNode);
			if (columnName !== "column") {
				throw new Error(`${tablePath} has unsupported child "${columnName}" at index ${columnIndex}`);
			}
			const columnPath = `${tablePath}.column.${columns.length}`;
			const columnId = expectStringArgument(columnNode, `${columnPath}.name`, 0, options);
			const type = resolveOptionalStringProperty(columnNode, "type", columnPath, options);
			if (!type) throw new Error(`${columnPath}.type is required`);
			const primary = resolveOptionalBooleanProperty(columnNode, "primary", columnPath, options);
			columns.push({
				name: columnId,
				type,
				...(primary !== undefined ? { primary } : {}),
			} satisfies StateSchemaTableColumn);
		}
		tables.push({ name, columns } satisfies StateSchemaTable);
	}
	return { id, backend, tables } satisfies StateSchema;
}

function parseToolModuleNode(node: Node, pathLabel: string, options: ParseManifestOptions): ToolModule {
	const id = expectStringArgument(node, `${pathLabel}.id`, 0, options);
	const modulePath = resolveOptionalStringProperty(node, "path", pathLabel, options);
	if (!modulePath) {
		throw new Error(`${pathLabel}.path is required`);
	}
	return { id, path: modulePath };
}

function parseOperatorActionNode(node: Node, pathLabel: string, options: ParseManifestOptions): OperatorAction {
	const id = expectStringArgument(node, `${pathLabel}.id`, 0, options);
	const transitions: OperatorActionTransition[] = [];
	let triggerGoal: string | undefined;
	let downstreamJob: { kind: string } | undefined;
	for (const child of node.children?.nodes ?? []) {
		const childName = getNodeName(child);
		if (childName === "transition") {
			const from = resolveOptionalStringProperty(child, "from", `${pathLabel}.transition`, options);
			const to = resolveOptionalStringProperty(child, "to", `${pathLabel}.transition`, options);
			if (!from || !to) {
				throw new Error(`${pathLabel}.transition requires from and to properties`);
			}
			transitions.push({ from, to });
		} else if (childName === "trigger-goal") {
			triggerGoal = expectStringArgument(child, `${pathLabel}.trigger-goal`, 0, options);
		} else if (childName === "downstream-job") {
			const kind = resolveOptionalStringProperty(child, "kind", `${pathLabel}.downstream-job`, options);
			if (!kind) {
				throw new Error(`${pathLabel}.downstream-job.kind is required`);
			}
			downstreamJob = { kind };
		}
	}
	if (transitions.length === 0) {
		throw new Error(`${pathLabel} requires at least one transition`);
	}
	return {
		id,
		transitions,
		...(triggerGoal !== undefined ? { triggerGoal } : {}),
		...(downstreamJob !== undefined ? { downstreamJob } : {}),
	};
}

export function parseManifestModuleDocument(
	document: Document,
	options: ParseManifestOptions = {},
): ParsedManifestModule {
	const errors: string[] = [];
	let name: string | undefined;
	let version: string | undefined;
	const imports: ManifestImport[] = [];
	const setups = new Map<string, ManifestSetup>();
	const goals = new Map<string, ManifestGoal>();
	const overrides: ManifestOverride[] = [];
	const actionDescriptors: ActionDescriptor[] = [];
	const exportTargets: ExportTarget[] = [];
	const notificationRoutes: NotificationRoute[] = [];
	const reviewPolicies: ReviewPolicy[] = [];
	const checkpoints: Checkpoint[] = [];
	const panels: Panel[] = [];
	const layouts: Layout[] = [];
	const syncCollections: SyncCollection[] = [];
	const toolModules: ToolModule[] = [];
	const operatorActions: OperatorAction[] = [];
	const stateSchemas: StateSchema[] = [];

	for (const [index, node] of document.nodes.entries()) {
		const nodeName = getNodeName(node);
		try {
			if (nodeName === "name") {
				name = expectStringArgument(node, "name", 0, options);
				continue;
			}
			if (nodeName === "version") {
				version = expectStringArgument(node, "version", 0, options);
				continue;
			}
			if (nodeName === "import") {
				imports.push(parseImportNode(node, `import.${imports.length}`, options));
				continue;
			}
			if (nodeName === "setup") {
				const setupName = expectStringArgument(node, "setup.name", 0, options);
				validateSymbolName(setupName, "setup.name");
				if (setups.has(setupName)) {
					throw new Error(`Duplicate setup "${setupName}"`);
				}
				setups.set(
					setupName,
					finalizeSetup(parseSetupPatch(node, `setups.${setupName}`, options), `setups.${setupName}`),
				);
				continue;
			}
			if (nodeName === "goal") {
				const goalName = expectStringArgument(node, "goal.name", 0, options);
				validateSymbolName(goalName, "goal.name");
				if (goals.has(goalName)) {
					throw new Error(`Duplicate goal "${goalName}"`);
				}
				goals.set(goalName, finalizeGoal(parseGoalPatch(node, `goals.${goalName}`, options), `goals.${goalName}`));
				continue;
			}
			if (nodeName === "override") {
				overrides.push(parseOverrideNode(node, `overrides.${overrides.length}`, options));
				continue;
			}
			if (nodeName === "action-descriptor") {
				actionDescriptors.push(
					parseActionDescriptorNode(node, `action-descriptor.${actionDescriptors.length}`, options),
				);
				continue;
			}
			if (nodeName === "export-target") {
				exportTargets.push(parseExportTargetNode(node, `export-target.${exportTargets.length}`, options));
				continue;
			}
			if (nodeName === "notification-route") {
				notificationRoutes.push(
					parseNotificationRouteNode(node, `notification-route.${notificationRoutes.length}`, options),
				);
				continue;
			}
			if (nodeName === "review-policy") {
				reviewPolicies.push(parseReviewPolicyNode(node, `review-policy.${reviewPolicies.length}`, options));
				continue;
			}
			if (nodeName === "checkpoint") {
				checkpoints.push(parseCheckpointNode(node, `checkpoint.${checkpoints.length}`, options));
				continue;
			}
			if (nodeName === "panel") {
				panels.push(parsePanelNode(node, `panel.${panels.length}`, options));
				continue;
			}
			if (nodeName === "layout") {
				layouts.push(parseLayoutNode(node, `layout.${layouts.length}`, options));
				continue;
			}
			if (nodeName === "sync-collection") {
				syncCollections.push(parseSyncCollectionNode(node, `sync-collection.${syncCollections.length}`, options));
				continue;
			}
			if (nodeName === "state-schema") {
				stateSchemas.push(parseStateSchemaNode(node, `state-schema.${stateSchemas.length}`, options));
				continue;
			}
			if (nodeName === "tool-module") {
				const tm = parseToolModuleNode(node, `tool-module.${toolModules.length}`, options);
				if (toolModules.some(existing => existing.id === tm.id)) {
					throw new Error(`Duplicate tool-module "${tm.id}"`);
				}
				toolModules.push(tm);
				continue;
			}
			if (nodeName === "operator-action") {
				const oa = parseOperatorActionNode(node, `operator-action.${operatorActions.length}`, options);
				if (operatorActions.some(existing => existing.id === oa.id)) {
					throw new Error(`Duplicate operator-action "${oa.id}"`);
				}
				operatorActions.push(oa);
				continue;
			}
			throw new Error(`Unsupported top-level node "${nodeName}" at index ${index}`);
		} catch (error) {
			errors.push(error instanceof Error ? error.message : String(error));
		}
	}

	if (errors.length > 0) {
		throw new Error(errors.join("\n"));
	}

	return {
		name,
		version,
		imports,
		setups,
		goals,
		overrides,
		actionDescriptors,
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
}

function hydrateManifest(manifestModule: ParsedManifestModule): AutonomyManifest {
	if (!manifestModule.name) {
		throw new Error("name is required");
	}
	if (!manifestModule.version) {
		throw new Error("version is required");
	}
	return {
		name: manifestModule.name,
		version: manifestModule.version,
		setups: manifestModule.setups,
		goals: manifestModule.goals,
		exportTargets: manifestModule.exportTargets,
		notificationRoutes: manifestModule.notificationRoutes,
		reviewPolicies: manifestModule.reviewPolicies,
		checkpoints: manifestModule.checkpoints,
		panels: manifestModule.panels,
		layouts: manifestModule.layouts,
		syncCollections: manifestModule.syncCollections,
		stateSchemas: manifestModule.stateSchemas,
		toolModules: manifestModule.toolModules,
		operatorActions: manifestModule.operatorActions,
	};
}

export function parseManifestKdl(kdlText: string, options: ParseManifestOptions = {}): AutonomyManifest {
	const document = parse(kdlText);
	const manifestModule = parseManifestModuleDocument(document, options);
	if (manifestModule.imports.length > 0 || manifestModule.overrides.length > 0) {
		throw new Error("Imports and overrides require loadManifestFromFile()");
	}
	const registry =
		options.registry ?? (manifestModule.actionDescriptors.length > 0 ? new ActionRegistry() : undefined);
	if (registry) {
		for (const descriptor of manifestModule.actionDescriptors) {
			if (!registry.has(descriptor.id)) {
				registry.register(descriptor);
			}
		}
	}
	const manifest = hydrateManifest(manifestModule);
	if (!isValidManifest(manifest)) {
		throw new Error("Parsed manifest does not match manifest schema");
	}
	const validation = validateManifest(manifest, registry);
	if (!validation.valid) {
		throw new Error(validation.errors.map(error => `${error.path}: ${error.message}`).join("\n"));
	}
	return manifest;
}
