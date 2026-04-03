import type { AgentTool, AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { type Static, Type } from "@sinclair/typebox";
import type { SpellSurfaceClientOptions } from "./goals-tool";
import { resolveSpellSurfaceClientOptions } from "./goals-tool";
import type { ToolSession } from ".";
import { toolResult } from "./tool-result";

const approvalsSchema = Type.Object({});

type ApprovalsInput = Static<typeof approvalsSchema>;

function authHeader(options: SpellSurfaceClientOptions): string {
	return `Basic ${Buffer.from(`${options.username}:${options.password}`).toString("base64")}`;
}

export async function fetchApprovalsToolView(options: SpellSurfaceClientOptions): Promise<unknown> {
	const fetchImpl = options.fetchImpl ?? fetch;
	const response = await fetchImpl(`${options.baseUrl}/api/approvals`, {
		headers: { Authorization: authHeader(options) },
	});
	if (!response.ok) {
		throw new Error(`Approvals request failed with ${response.status}`);
	}
	return response.json();
}

export class ApprovalsTool implements AgentTool<typeof approvalsSchema> {
	readonly name = "approvals" as const;
	readonly label = "Approvals";
	readonly description = "Read canonical approval summaries from the configured Spell Server.";
	readonly parameters = approvalsSchema;
	readonly strict = true;
	#clientOptions: SpellSurfaceClientOptions;

	constructor(clientOptions: SpellSurfaceClientOptions) {
		this.#clientOptions = clientOptions;
	}

	static async createIf(session: ToolSession): Promise<ApprovalsTool | null> {
		const clientOptions = await resolveSpellSurfaceClientOptions(session);
		return clientOptions ? new ApprovalsTool(clientOptions) : null;
	}

	async execute(_toolCallId: string, _input: ApprovalsInput): Promise<AgentToolResult> {
		const view = await fetchApprovalsToolView(this.#clientOptions);
		return toolResult()
			.text(JSON.stringify(view, null, 2))
			.done();
	}
}
