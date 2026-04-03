import type { Node } from "@bgotink/kdl";
import { parse } from "@bgotink/kdl";
import { resolveEnvValue } from "./env-resolver";
import type { SpellServerConfig } from "./types";

export interface DotenvConfig {
	enabled: boolean;
	/** Relative path to .env file, defaults to ".env" */
	path: string;
}

function expectStringArgument(
	node: Node,
	path: string,
	env?: Record<string, string | undefined>,
	argumentIndex = 0,
): string {
	const value = node.getArgument(argumentIndex);
	const resolved = resolveEnvValue<string>(value, "string", path, env);
	if (resolved.length === 0) {
		throw new Error(`${path} must have a string argument`);
	}
	return resolved;
}

function expectNumberArgument(node: Node, path: string, env?: Record<string, string | undefined>): number {
	const value = node.getArgument(0);
	return resolveEnvValue<number>(value, "number", path, env);
}

function parseAuthNode(
	node: Node,
	path: string,
	env?: Record<string, string | undefined>,
): SpellServerConfig["http"]["auth"] {
	let username: string | undefined;
	let password: string | undefined;

	for (const child of node.children?.nodes ?? []) {
		if (child.getName() === "username") {
			username = expectStringArgument(child, `${path}.username`, env);
		}
		if (child.getName() === "password") {
			password = expectStringArgument(child, `${path}.password`, env);
		}
	}

	if (!username) {
		throw new Error(`${path}.username is required`);
	}
	if (!password) {
		throw new Error(`${path}.password is required`);
	}

	return { username, password };
}

export function parseDotenvConfig(kdlText: string): DotenvConfig | null {
	const normalizedKdl = kdlText.replace(/(^|\n)(\s*dotenv\s+)(true|false)(?=\s*(?:\n|$))/g, "$1$2#$3");
	const document = parse(normalizedKdl);
	const dotenvNode = document.findNodeByName("dotenv");
	if (!dotenvNode) return null;

	const arg = dotenvNode.getArgument(0);
	if (typeof arg === "boolean") {
		return { enabled: arg, path: ".env" };
	}
	if (typeof arg === "string") {
		return { enabled: true, path: arg };
	}
	throw new Error("dotenv must be a boolean or a path string");
}

export function parseServerConfig(kdlText: string, env?: Record<string, string | undefined>): SpellServerConfig {
	const document = parse(kdlText);
	const httpNode = document.findNodeByName("http");
	if (!httpNode) {
		throw new Error("server.http is required");
	}

	let port: number | undefined;
	let auth: SpellServerConfig["http"]["auth"] | undefined;
	let webhookSecret: string | undefined;
	const goalTokens: Record<string, string> = {};

	for (const child of httpNode.children?.nodes ?? []) {
		if (child.getName() === "port") {
			port = expectNumberArgument(child, "server.http.port", env);
			continue;
		}
		if (child.getName() === "auth") {
			auth = parseAuthNode(child, "server.http.auth", env);
			continue;
		}
		if (child.getName() === "webhook-secret") {
			webhookSecret = expectStringArgument(child, "server.http.webhookSecret", env);
			continue;
		}
		if (child.getName() === "goal-token") {
			const goalName = expectStringArgument(child, "server.http.goalTokens entry name", env, 0);
			const token = expectStringArgument(child, `server.http.goalTokens.${goalName}`, env, 1);
			goalTokens[goalName] = token;
		}
	}

	if (port === undefined) {
		throw new Error("server.http.port is required");
	}
	if (!auth) {
		throw new Error("server.http.auth is required");
	}

	return {
		http: {
			port,
			auth,
			webhookSecret,
			goalTokens: Object.keys(goalTokens).length > 0 ? goalTokens : undefined,
		},
	};
}
