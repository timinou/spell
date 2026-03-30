import type { AgentTool, AgentToolResult } from "@oh-my-pi/pi-agent-core";
import type { GatewayClient } from "@oh-my-pi/pi-gateway";
import { type Static, Type } from "@sinclair/typebox";
import gatewayDescription from "../prompts/tools/gateway.md" with { type: "text" };
import type { ToolSession } from ".";
import { toolResult } from "./tool-result";

const gatewaySchema = Type.Object({
	action: Type.Union([
		Type.Literal("register"),
		Type.Literal("deregister"),
		Type.Literal("list"),
		Type.Literal("status"),
	]),
	alias: Type.Optional(Type.String({ description: "Service alias (e.g. 'myapp')" })),
	target: Type.Optional(Type.String({ description: "Backend URL (e.g. 'http://127.0.0.1:3000')" })),
	persistent: Type.Optional(Type.Boolean({ description: "Persist across sessions (default: false)" })),
});

type GatewayInput = Static<typeof gatewaySchema>;

export class GatewayTool implements AgentTool<typeof gatewaySchema> {
	name = "gateway" as const;
	label = "Gateway";
	parameters = gatewaySchema;
	description = gatewayDescription;

	#session: ToolSession;
	#client: GatewayClient;

	constructor(session: ToolSession) {
		this.#session = session;
		this.#client = session.gatewayClient!;
	}

	static createIf(session: ToolSession): GatewayTool | null {
		return session.gatewayClient ? new GatewayTool(session) : null;
	}

	async execute(_toolCallId: string, input: GatewayInput, _signal?: AbortSignal): Promise<AgentToolResult> {
		try {
			switch (input.action) {
				case "register":
					return await this.#register(input);
				case "deregister":
					return await this.#deregister(input);
				case "list":
					return await this.#list();
				case "status":
					return await this.#status(input);
			}
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			return toolResult().text(`Gateway error: ${message}`).done();
		}
		// Exhaustive switch -- unreachable at compile time, defensive at runtime
		return toolResult().text(`Unknown gateway action: ${input.action}`).done();
	}

	async #register(input: GatewayInput): Promise<AgentToolResult> {
		if (!input.alias) {
			return toolResult().text("Error: alias is required for register").done();
		}
		if (!input.target) {
			return toolResult().text("Error: target is required for register").done();
		}

		const sessionId = this.#session.getSessionId?.() ?? undefined;
		await this.#client.register({
			alias: input.alias,
			target: input.target,
			sessionId,
			persistent: input.persistent,
		});

		const url = this.#client.getAliasUrl(input.alias);
		return toolResult().text(`Registered service "${input.alias}" → ${input.target}\nURL: ${url}`).done();
	}

	async #deregister(input: GatewayInput): Promise<AgentToolResult> {
		if (!input.alias) {
			return toolResult().text("Error: alias is required for deregister").done();
		}

		await this.#client.deregister(input.alias);
		return toolResult().text(`Deregistered service "${input.alias}"`).done();
	}

	async #list(): Promise<AgentToolResult> {
		const services = await this.#client.list();
		if (services.length === 0) {
			return toolResult().text("No active gateway services").done();
		}

		const lines = services.map(s => `${s.alias} → ${s.target} [${s.status}]${s.persistent ? " (persistent)" : ""}`);
		return toolResult().text(lines.join("\n")).done();
	}

	async #status(input: GatewayInput): Promise<AgentToolResult> {
		const result = await this.#client.status(input.alias);
		return toolResult()
			.text(JSON.stringify(result, null, 2))
			.done();
	}
}
