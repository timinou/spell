import { type Document, Node } from "@bgotink/kdl";

import {
	getBooleanArgument,
	getBooleanProperty,
	getChildNode,
	getChildNodes,
	getDocumentNode,
	getNumberArgument,
	getStringArgument,
	getStringArguments,
	getStringProperty,
} from "./kdl-helpers";

export interface KdlProviderConfig {
	baseUrl?: string;
	apiKey?: string;
	api?: string;
	auth?: string;
	authHeader?: boolean;
	proxy?: boolean;
	headers?: Record<string, string>;
	compat?: Record<string, unknown>;
	discovery?: { type: string };
	models?: KdlModelConfig[];
	modelOverrides?: Record<string, unknown>;
}

export interface KdlModelConfig {
	id: string;
	name?: string;
	displayName?: string;
	api?: string;
	contextWindow?: number;
	maxTokens?: number;
	reasoning?: boolean;
	thinking?: Record<string, unknown>;
	input?: string[];
	cost?: Record<string, number>;
	premiumMultiplier?: number;
}

function parseValue(node: Node): string | number | boolean | null | undefined {
	return getStringArgument(node) ?? getNumberArgument(node) ?? getBooleanArgument(node) ?? node.getArgument(0);
}

function parseHeadersBlock(node: Node): Record<string, string> | undefined {
	const headers: Record<string, string> = {};
	for (const child of getChildNodes(node)) {
		const value = parseValue(child);
		if (typeof value === "string" && value.length > 0) headers[child.getName()] = value;
	}
	return Object.keys(headers).length > 0 ? headers : undefined;
}

function parseCompatBlock(node: Node): Record<string, unknown> | undefined {
	const compat: Record<string, unknown> = {};
	for (const child of getChildNodes(node)) {
		const value = parseValue(child);
		if (value !== undefined) compat[child.getName()] = value;
		const childType = getStringProperty(child, "type");
		if (childType !== undefined) compat[child.getName()] = childType;
		const childReasoning = getBooleanProperty(child, "reasoning");
		if (childReasoning !== undefined) compat[child.getName()] = childReasoning;
	}
	return Object.keys(compat).length > 0 ? compat : undefined;
}

function parseModelConfig(node: Node): KdlModelConfig | undefined {
	const id = getStringArgument(node);
	if (!id) return undefined;
	const config: KdlModelConfig = { id };
	for (const child of getChildNodes(node)) {
		switch (child.getName()) {
			case "name":
				config.name = getStringArgument(child);
				break;
			case "display-name":
				config.displayName = getStringArgument(child);
				break;
			case "api":
				config.api = getStringArgument(child);
				break;
			case "context-window":
				config.contextWindow = getNumberArgument(child);
				break;
			case "max-tokens":
				config.maxTokens = getNumberArgument(child);
				break;
			case "reasoning":
				config.reasoning = getBooleanArgument(child);
				break;
			case "thinking": {
				const thinking: Record<string, unknown> = {};
				for (const thinkingChild of getChildNodes(child)) {
					const value = parseValue(thinkingChild);
					if (value !== undefined) thinking[thinkingChild.getName()] = value;
				}
				if (Object.keys(thinking).length > 0) config.thinking = thinking;
				break;
			}
			case "input": {
				const input = getStringArguments(child);
				if (input.length > 0) config.input = input;
				break;
			}
			case "cost": {
				const cost: Record<string, number> = {};
				for (const costChild of getChildNodes(child)) {
					const value = getNumberArgument(costChild);
					if (typeof value === "number") cost[costChild.getName()] = value;
				}
				if (Object.keys(cost).length > 0) config.cost = cost;
				break;
			}
			case "premium-multiplier":
				config.premiumMultiplier = getNumberArgument(child);
				break;
		}
	}
	return config;
}

function parseModels(node: Node): KdlModelConfig[] | undefined {
	const models = getChildNodes(node, "model")
		.map(parseModelConfig)
		.filter((model): model is KdlModelConfig => model !== undefined);
	return models.length > 0 ? models : undefined;
}

function parseModelOverridesBlock(node: Node): Record<string, Record<string, unknown>> | undefined {
	const overrides: Record<string, Record<string, unknown>> = {};
	for (const child of getChildNodes(node)) {
		const id = child.getName();
		const entry: Record<string, unknown> = {};
		for (const field of getChildNodes(child)) {
			switch (field.getName()) {
				case "name": {
					const v = getStringArgument(field);
					if (v !== undefined) entry.name = v;
					break;
				}
				case "context-window": {
					const v = getNumberArgument(field);
					if (v !== undefined) entry.contextWindow = v;
					break;
				}
				case "max-tokens": {
					const v = getNumberArgument(field);
					if (v !== undefined) entry.maxTokens = v;
					break;
				}
				case "reasoning": {
					const v = getBooleanArgument(field);
					if (v !== undefined) entry.reasoning = v;
					break;
				}
				case "premium-multiplier": {
					const v = getNumberArgument(field);
					if (v !== undefined) entry.premiumMultiplier = v;
					break;
				}
				case "input": {
					const input = getStringArguments(field);
					if (input.length > 0) entry.input = input;
					break;
				}
				case "cost": {
					const cost: Record<string, number> = {};
					for (const c of getChildNodes(field)) {
						const v = getNumberArgument(c);
						if (typeof v === "number") cost[c.getName()] = v;
					}
					if (Object.keys(cost).length > 0) entry.cost = cost;
					break;
				}
				case "thinking": {
					const thinking: Record<string, unknown> = {};
					for (const c of getChildNodes(field)) {
						const v = parseValue(c);
						if (v !== undefined) thinking[c.getName()] = v;
					}
					if (Object.keys(thinking).length > 0) entry.thinking = thinking;
					break;
				}
			}
		}
		if (Object.keys(entry).length > 0) overrides[id] = entry;
	}
	return Object.keys(overrides).length > 0 ? overrides : undefined;
}

function parseProviderNode(node: Node): KdlProviderConfig | undefined {
	const config: KdlProviderConfig = {};

	for (const child of getChildNodes(node)) {
		switch (child.getName()) {
			case "api-key":
				config.apiKey = getStringArgument(child);
				break;
			case "base-url":
				config.baseUrl = getStringArgument(child);
				break;
			case "api":
				config.api = getStringArgument(child);
				break;
			case "auth":
				config.auth = getStringArgument(child);
				break;
			case "auth-header":
				config.authHeader = getBooleanArgument(child);
				break;
			case "proxy":
				config.proxy = getBooleanArgument(child);
				break;
			case "headers":
				config.headers = parseHeadersBlock(child);
				break;
			case "compat":
				config.compat = parseCompatBlock(child);
				break;
			case "discovery": {
				const type = getStringProperty(child, "type") ?? getStringArgument(child);
				if (type) config.discovery = { type };
				break;
			}
			case "model":
				config.models ??= [];
				{
					const model = parseModelConfig(child);
					if (model) config.models.push(model);
				}
				break;
			case "models":
				config.models = parseModels(child);
				break;
			case "model-overrides":
				config.modelOverrides = parseModelOverridesBlock(child);
				break;
		}
	}

	return Object.keys(config).length > 0 ? config : undefined;
}

export function parseProvidersBlock(doc: Document): {
	providers: Record<string, KdlProviderConfig>;
	webSearch?: string;
	codeSearch?: string;
	image?: string;
} {
	const providersNode = getDocumentNode(doc, "providers");
	if (!providersNode) return { providers: {} };

	const result: {
		providers: Record<string, KdlProviderConfig>;
		webSearch?: string;
		codeSearch?: string;
		image?: string;
	} = { providers: {} };

	result.webSearch = getStringArgument(getChildNode(providersNode, "web-search") ?? Node.create("web-search"));
	result.codeSearch = getStringArgument(getChildNode(providersNode, "code-search") ?? Node.create("code-search"));
	result.image = getStringArgument(getChildNode(providersNode, "image") ?? Node.create("image"));

	for (const providerNode of getChildNodes(providersNode, "provider")) {
		const name = getStringArgument(providerNode);
		if (!name) continue;
		const config = parseProviderNode(providerNode);
		if (config) result.providers[name] = config;
	}

	return result;
}

export function validateKdlProviderConfig(name: string, config: KdlProviderConfig): void {
	if (config.apiKey?.startsWith("$") || config.apiKey?.startsWith("!")) {
		return;
	}

	if (config.models) {
		for (const model of config.models) {
			if (!model.id) throw new Error(`Provider ${name}: model missing id`);
		}
	}
}
