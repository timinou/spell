import type { Node } from "@bgotink/kdl";
import { parse } from "@bgotink/kdl";
import type { SpellServerConfig } from "./types";

function expectStringArgument(node: Node, path: string): string {
	const value = node.getArgument(0);
	if (typeof value !== "string") {
		throw new Error(`${path} must have a string argument`);
	}
	return value;
}

function expectNumberArgument(node: Node, path: string): number {
	const value = node.getArgument(0);
	if (typeof value !== "number" || !Number.isFinite(value)) {
		throw new Error(`${path} must have a finite numeric argument`);
	}
	return value;
}

function parseAuthNode(node: Node, path: string): SpellServerConfig["http"]["auth"] {
	let username: string | undefined;
	let password: string | undefined;

	for (const child of node.children?.nodes ?? []) {
		if (child.getName() === "username") {
			username = expectStringArgument(child, `${path}.username`);
		}
		if (child.getName() === "password") {
			password = expectStringArgument(child, `${path}.password`);
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

export function parseServerConfig(kdlText: string): SpellServerConfig {
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
			port = expectNumberArgument(child, "server.http.port");
			continue;
		}
		if (child.getName() === "auth") {
			auth = parseAuthNode(child, "server.http.auth");
			continue;
		}
		if (child.getName() === "webhook-secret") {
			webhookSecret = expectStringArgument(child, "server.http.webhookSecret");
			continue;
		}
		if (child.getName() === "goal-token") {
			const goalName = child.getArgument(0);
			const token = child.getArgument(1);
			if (typeof goalName !== "string" || goalName.length === 0) {
				throw new Error("server.http.goalTokens entries must start with a non-empty goal name");
			}
			if (typeof token !== "string" || token.length === 0) {
				throw new Error(`server.http.goalTokens.${goalName} must have a non-empty token`);
			}
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
