import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentTool, AgentToolResult } from "@spell/pi-agent-core";
import { isEnoent } from "@spell/pi-utils";
import { loadConfig } from "@spell/spell-server/config/loader";
import { type Static, Type } from "@sinclair/typebox";
import type { ToolSession } from ".";
import { toolResult } from "./tool-result";

export interface SpellSurfaceClientOptions {
	baseUrl: string;
	username: string;
	password: string;
	fetchImpl?: typeof fetch;
}

const goalsSchema = Type.Object({});

type GoalsInput = Static<typeof goalsSchema>;

function authHeader(options: SpellSurfaceClientOptions): string {
	return `Basic ${Buffer.from(`${options.username}:${options.password}`).toString("base64")}`;
}

function normalizeBaseUrl(value: string): string {
	return value.endsWith("/") ? value.slice(0, -1) : value;
}

async function tryLoadSpellServerConfig(cwd: string) {
	for (const configDir of [path.join(cwd, ".spell"), path.join(os.homedir(), ".spell")]) {
		try {
			await fs.stat(path.join(configDir, "server.kdl"));
			return await loadConfig(configDir);
		} catch (error) {
			if (!isEnoent(error)) throw error;
		}
	}
	return null;
}

export async function resolveSpellSurfaceClientOptions(
	session: ToolSession,
): Promise<SpellSurfaceClientOptions | null> {
	const envBaseUrl = Bun.env.SPELL_SERVER_URL?.trim();
	const envUsername = Bun.env.SPELL_SERVER_USERNAME?.trim();
	const envPassword = Bun.env.SPELL_SERVER_PASSWORD?.trim();
	if (envBaseUrl && envUsername && envPassword) {
		return {
			baseUrl: normalizeBaseUrl(envBaseUrl),
			username: envUsername,
			password: envPassword,
		};
	}

	const config = await tryLoadSpellServerConfig(session.cwd);
	const configPort = config?.server.http.port;
	const configBaseUrl = typeof configPort === "number" && configPort > 0 ? `http://127.0.0.1:${configPort}` : null;
	const baseUrl = envBaseUrl || configBaseUrl;
	const username = envUsername || config?.server.http.auth.username;
	const password = envPassword || config?.server.http.auth.password;
	if (!baseUrl || !username || !password) {
		return null;
	}
	return {
		baseUrl: normalizeBaseUrl(baseUrl),
		username,
		password,
	};
}

export async function fetchGoalsToolView(options: SpellSurfaceClientOptions): Promise<unknown> {
	const fetchImpl = options.fetchImpl ?? fetch;
	const response = await fetchImpl(`${options.baseUrl}/api/goals`, {
		headers: { Authorization: authHeader(options) },
	});
	if (!response.ok) {
		throw new Error(`Goals request failed with ${response.status}`);
	}
	return response.json();
}

export class GoalsTool implements AgentTool<typeof goalsSchema> {
	readonly name = "goals" as const;
	readonly label = "Goals";
	readonly description = "Read canonical goal summaries from the configured Spell Server.";
	readonly parameters = goalsSchema;
	readonly strict = true;
	#clientOptions: SpellSurfaceClientOptions;

	constructor(clientOptions: SpellSurfaceClientOptions) {
		this.#clientOptions = clientOptions;
	}

	static async createIf(session: ToolSession): Promise<GoalsTool | null> {
		const clientOptions = await resolveSpellSurfaceClientOptions(session);
		return clientOptions ? new GoalsTool(clientOptions) : null;
	}

	async execute(_toolCallId: string, _input: GoalsInput): Promise<AgentToolResult> {
		const view = await fetchGoalsToolView(this.#clientOptions);
		return toolResult()
			.text(JSON.stringify(view, null, 2))
			.done();
	}
}
