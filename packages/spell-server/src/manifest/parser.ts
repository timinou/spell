import type { Document, Node } from "@bgotink/kdl";
import { parse } from "@bgotink/kdl";
import {
	type AutonomyManifest,
	type FilterConfig,
	type HookTarget,
	isValidManifest,
	type ManifestGoal,
	type ManifestHookConfig,
	type ManifestSetup,
	type RetryConfig,
	type SandboxConfig,
	type StateConfig,
	type StateSchemaColumn,
} from "./types";
import { validateManifest } from "./validator";

function expectStringArgument(node: Node, path: string): string {
	const value = node.getArgument(0);
	if (typeof value !== "string") {
		throw new Error(`${path} must have a string argument`);
	}
	return value;
}

function expectNumberProperty(node: Node, property: string, path: string): number {
	const value = node.getProperty(property);
	if (typeof value !== "number" || !Number.isFinite(value)) {
		throw new Error(`${path}.${property} must be a finite number`);
	}
	return value;
}

function parseFilterNode(node: Node, path: string): FilterConfig {
	const allowNode = node.children?.findNodeByName("allow");
	const denyNode = node.children?.findNodeByName("deny");
	const filter: FilterConfig = {};

	if (allowNode) {
		const values = allowNode.getArguments();
		if (!values.every(value => typeof value === "string")) {
			throw new Error(`${path}.allow must contain only strings`);
		}
		filter.allow = values;
	}
	if (denyNode) {
		const values = denyNode.getArguments();
		if (!values.every(value => typeof value === "string")) {
			throw new Error(`${path}.deny must contain only strings`);
		}
		filter.deny = values;
	}

	return filter;
}

function parseSandboxNode(node: Node, path: string): SandboxConfig {
	const sandbox: SandboxConfig = {};
	for (const child of node.children?.nodes ?? []) {
		const values = child.getArguments();
		if (!values.every(value => typeof value === "string")) {
			throw new Error(`${path}.${child.getName()} must contain only strings`);
		}
		if (child.getName() === "paths-write") sandbox.pathsWrite = values;
		if (child.getName() === "bash-allow") sandbox.bashAllow = values;
		if (child.getName() === "bash-deny") sandbox.bashDeny = values;
	}
	return sandbox;
}

function parseHookTarget(node: Node, path: string): HookTarget {
	const name = node.getName();
	if (name === "webhook") {
		const methodValue = node.getProperty("method");
		if (methodValue !== undefined && methodValue !== "POST" && methodValue !== "GET") {
			throw new Error(`${path}.method must be POST or GET`);
		}
		return {
			type: "webhook",
			url: expectStringArgument(node, path),
			method: methodValue,
		};
	}
	if (name === "telegram") {
		return { type: "telegram", chatId: expectNumberProperty(node, "chat-id", path) };
	}
	if (name === "org") {
		const category = node.getProperty("category");
		if (category !== undefined && typeof category !== "string") {
			throw new Error(`${path}.category must be a string`);
		}
		return { type: "org", category };
	}
	throw new Error(`${path} has unsupported hook target "${name}"`);
}

function parseHooksNode(node: Node, path: string): ManifestHookConfig {
	const hooks: ManifestHookConfig = {};
	for (const child of node.children?.nodes ?? []) {
		const targets = (child.children?.nodes ?? []).map((target, index) =>
			parseHookTarget(target, `${path}.${child.getName()}.${index}`),
		);
		if (child.getName() === "on-success") hooks.onSuccess = targets;
		if (child.getName() === "on-failure") hooks.onFailure = targets;
		if (child.getName() === "on-complete") hooks.onComplete = targets;
	}
	return hooks;
}

function parseStateNode(node: Node, path: string): StateConfig {
	const persist = node.getProperty("persist");
	if (typeof persist !== "boolean") {
		throw new Error(`${path}.persist must be a boolean`);
	}
	const schema = (node.children?.findNodesByName("schema") ?? []).map((schemaNode, index) => {
		const name = expectStringArgument(schemaNode, `${path}.schema.${index}`);
		const typeValue = schemaNode.getProperty("type");
		if (typeValue !== "string" && typeValue !== "number" && typeValue !== "boolean" && typeValue !== "json") {
			throw new Error(`${path}.schema.${index}.type must be one of string, number, boolean, json`);
		}
		return { name, type: typeValue } satisfies StateSchemaColumn;
	});
	return schema.length === 0 ? { persist } : { persist, schema };
}

function parseRetryNode(node: Node, path: string): RetryConfig {
	const retry: RetryConfig = {};
	const maxRetries = node.getProperty("max-retries");
	if (maxRetries !== undefined) {
		if (typeof maxRetries !== "number" || !Number.isFinite(maxRetries)) {
			throw new Error(`${path}.max-retries must be a finite number`);
		}
		retry.maxRetries = maxRetries;
	}
	const initialDelayMs = node.getProperty("initial-delay-ms");
	if (initialDelayMs !== undefined) {
		if (typeof initialDelayMs !== "number" || !Number.isFinite(initialDelayMs)) {
			throw new Error(`${path}.initial-delay-ms must be a finite number`);
		}
		retry.initialDelayMs = initialDelayMs;
	}
	const multiplier = node.getProperty("multiplier");
	if (multiplier !== undefined) {
		if (typeof multiplier !== "number" || !Number.isFinite(multiplier)) {
			throw new Error(`${path}.multiplier must be a finite number`);
		}
		retry.multiplier = multiplier;
	}
	return retry;
}

function parseScheduleNode(node: Node, path: string): ManifestGoal["schedule"] {
	const type = node.getProperty("type");
	if (type === "cron") {
		const expression = node.getProperty("expression");
		if (typeof expression !== "string") {
			throw new Error(`${path}.expression must be a string`);
		}
		const timezone = node.getProperty("timezone");
		const jitter = node.getProperty("jitter");
		if (timezone !== undefined && typeof timezone !== "string") {
			throw new Error(`${path}.timezone must be a string`);
		}
		if (jitter !== undefined && typeof jitter !== "string") {
			throw new Error(`${path}.jitter must be a string`);
		}
		return { type, expression, timezone, jitter };
	}
	if (type === "webhook") {
		const pathValue = node.getProperty("path");
		const auth = node.getProperty("auth");
		if (pathValue !== undefined && typeof pathValue !== "string") {
			throw new Error(`${path}.path must be a string`);
		}
		if (auth !== undefined && auth !== "hmac" && auth !== "bearer") {
			throw new Error(`${path}.auth must be hmac or bearer`);
		}
		return { type, path: pathValue, auth };
	}
	throw new Error(`${path}.type must be cron or webhook`);
}

function parseSetupNode(node: Node, path: string): ManifestSetup {
	const setup: ManifestSetup = { domain: "" };
	for (const child of node.children?.nodes ?? []) {
		if (child.getName() === "domain") setup.domain = expectStringArgument(child, `${path}.domain`);
		if (child.getName() === "mode") setup.mode = expectStringArgument(child, `${path}.mode`);
		if (child.getName() === "skills") setup.skills = parseFilterNode(child, `${path}.skills`);
		if (child.getName() === "tools") setup.tools = parseFilterNode(child, `${path}.tools`);
		if (child.getName() === "sandbox") setup.sandbox = parseSandboxNode(child, `${path}.sandbox`);
		if (child.getName() === "timeout") setup.timeout = expectStringArgument(child, `${path}.timeout`);
		if (child.getName() === "max-cost-usd") {
			const value = child.getArgument(0);
			if (typeof value !== "number" || !Number.isFinite(value)) {
				throw new Error(`${path}.max-cost-usd must have a finite numeric argument`);
			}
			setup.maxCostUsd = value;
		}
	}
	if (setup.domain.length === 0) {
		throw new Error(`${path}.domain is required`);
	}
	return setup;
}

function parseGoalNode(node: Node, path: string): ManifestGoal {
	let setup: string | undefined;
	let schedule: ManifestGoal["schedule"] | undefined;
	let prompt: string | undefined;
	let hooks: ManifestHookConfig | undefined;
	let state: StateConfig | undefined;
	let retry: RetryConfig | undefined;

	for (const child of node.children?.nodes ?? []) {
		if (child.getName() === "setup") setup = expectStringArgument(child, `${path}.setup`);
		if (child.getName() === "schedule") schedule = parseScheduleNode(child, `${path}.schedule`);
		if (child.getName() === "prompt") prompt = expectStringArgument(child, `${path}.prompt`);
		if (child.getName() === "hooks") hooks = parseHooksNode(child, `${path}.hooks`);
		if (child.getName() === "state") state = parseStateNode(child, `${path}.state`);
		if (child.getName() === "retry") retry = parseRetryNode(child, `${path}.retry`);
	}

	if (!setup) throw new Error(`${path}.setup is required`);
	if (!schedule) throw new Error(`${path}.schedule is required`);
	if (!prompt) throw new Error(`${path}.prompt is required`);

	return { setup, schedule, prompt, hooks, state, retry };
}

function parseDocumentManifest(document: Document): AutonomyManifest {
	const errors: string[] = [];
	let name: string | undefined;
	let version: string | undefined;
	const setups = new Map<string, ManifestSetup>();
	const goals = new Map<string, ManifestGoal>();

	for (const node of document.nodes) {
		if (node.getName() === "name") {
			name = expectStringArgument(node, "name");
			continue;
		}
		if (node.getName() === "version") {
			version = expectStringArgument(node, "version");
			continue;
		}
		if (node.getName() === "setup") {
			const setupName = expectStringArgument(node, "setup");
			if (setups.has(setupName)) errors.push(`Duplicate setup "${setupName}"`);
			else setups.set(setupName, parseSetupNode(node, `setups.${setupName}`));
			continue;
		}
		if (node.getName() === "goal") {
			const goalName = expectStringArgument(node, "goal");
			if (goals.has(goalName)) errors.push(`Duplicate goal "${goalName}"`);
			else goals.set(goalName, parseGoalNode(node, `goals.${goalName}`));
		}
	}

	const manifest: AutonomyManifest = {
		name: name ?? "",
		version: version ?? "",
		setups,
		goals,
	};

	if (!isValidManifest(manifest)) {
		errors.push("Parsed manifest does not match manifest schema");
	}

	const validation = validateManifest(manifest);
	if (!validation.valid) {
		errors.push(...validation.errors.map(error => `${error.path}: ${error.message}`));
	}

	if (errors.length > 0) {
		throw new Error(errors.join("\n"));
	}

	return manifest;
}

export function parseManifestKdl(kdlText: string): AutonomyManifest {
	const document = parse(kdlText);
	return parseDocumentManifest(document);
}
