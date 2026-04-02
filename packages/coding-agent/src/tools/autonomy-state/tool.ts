import type { AgentTool, AgentToolContext, AgentToolResult, AgentToolUpdateCallback } from "@oh-my-pi/pi-agent-core";
import { logger } from "@oh-my-pi/pi-utils";
import { type Static, Type } from "@sinclair/typebox";
import type { ToolSession } from "..";
import { ToolError } from "../tool-errors";
import { toolResult } from "../tool-result";
import { validateValue } from "./schema";
import { AutonomyStateStore } from "./store";
import type { AutonomyStateResult, StateSchemaColumn } from "./types";

const autonomyStateSchema = Type.Union([
	Type.Object({
		op: Type.Literal("get"),
		key: Type.String({ description: "State key to fetch" }),
	}),
	Type.Object({
		op: Type.Literal("set"),
		key: Type.String({ description: "State key to store" }),
		value: Type.Unknown({ description: "JSON-serializable value to store" }),
	}),
	Type.Object({
		op: Type.Literal("list"),
	}),
	Type.Object({
		op: Type.Literal("delete"),
		key: Type.String({ description: "State key to delete" }),
	}),
	Type.Object({
		op: Type.Literal("get_metadata"),
	}),
]);

type AutonomyStateInput = Static<typeof autonomyStateSchema>;

function parseSchema(schemaJson: string | undefined): StateSchemaColumn[] | undefined {
	if (!schemaJson) return undefined;
	const parsed = JSON.parse(schemaJson) as unknown;
	if (!Array.isArray(parsed)) {
		throw new ToolError("SPELL_AUTONOMY_STATE_SCHEMA must be a JSON array.");
	}
	return parsed.map((entry, index) => {
		if (entry == null || typeof entry !== "object" || Array.isArray(entry)) {
			throw new ToolError(`SPELL_AUTONOMY_STATE_SCHEMA[${index}] must be an object.`);
		}
		const column = entry as Record<string, unknown>;
		if (typeof column.name !== "string" || column.name.length === 0) {
			throw new ToolError(`SPELL_AUTONOMY_STATE_SCHEMA[${index}].name must be a non-empty string.`);
		}
		if (column.type !== "string" && column.type !== "number" && column.type !== "boolean" && column.type !== "json") {
			throw new ToolError(`SPELL_AUTONOMY_STATE_SCHEMA[${index}].type is invalid.`);
		}
		return { name: column.name, type: column.type };
	});
}

export class AutonomyStateTool implements AgentTool<typeof autonomyStateSchema, AutonomyStateResult> {
	readonly name = "autonomy_state";
	readonly label = "Autonomy State";
	readonly description = "Read and write autonomy run state persisted in SQLite for manifest-driven automation.";
	readonly parameters = autonomyStateSchema;
	readonly strict = true;
	#store: AutonomyStateStore | undefined;
	#schema: StateSchemaColumn[] | undefined;

	constructor(_session: ToolSession) {
		// Session reserved for future tool-context access.
	}

	async execute(
		_toolCallId: string,
		input: AutonomyStateInput,
		_signal?: AbortSignal,
		_onUpdate?: AgentToolUpdateCallback<AutonomyStateResult>,
		_context?: AgentToolContext,
	): Promise<AgentToolResult<AutonomyStateResult>> {
		try {
			const store = this.#getStore();
			switch (input.op) {
				case "get":
					return this.#respond({ success: true, value: store.get(input.key) });
				case "set": {
					const error = validateValue(input.key, input.value, this.#schema);
					if (error) return this.#respond({ success: false, error });
					store.set(input.key, input.value);
					return this.#respond({ success: true, value: input.value });
				}
				case "list":
					return this.#respond({ success: true, keys: store.list() });
				case "delete":
					store.delete(input.key);
					return this.#respond({ success: true });
				case "get_metadata":
					return this.#respond({ success: true, metadata: store.getMetadata() ?? undefined });
			}
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			logger.warn("AutonomyStateTool execution failed", { error: message });
			return this.#respond({ success: false, error: message });
		}
	}

	#respond(result: AutonomyStateResult): AgentToolResult<AutonomyStateResult> {
		return toolResult<AutonomyStateResult>(result)
			.text(JSON.stringify(result, null, 2))
			.done();
	}

	#getStore(): AutonomyStateStore {
		if (this.#store) return this.#store;
		const dbPath = Bun.env.SPELL_AUTONOMY_STATE_DB;
		if (!dbPath) {
			throw new ToolError("SPELL_AUTONOMY_STATE_DB is required for autonomy_state.");
		}
		this.#schema = parseSchema(Bun.env.SPELL_AUTONOMY_STATE_SCHEMA);
		this.#store = new AutonomyStateStore(dbPath, Bun.env.SPELL_AUTONOMY_RUN_ID);
		return this.#store;
	}
}
