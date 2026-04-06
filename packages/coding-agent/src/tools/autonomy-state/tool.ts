import type { AgentTool, AgentToolContext, AgentToolResult, AgentToolUpdateCallback } from "@oh-my-pi/pi-agent-core";
import { logger } from "@oh-my-pi/pi-utils";
import { type Static, Type } from "@sinclair/typebox";
import type { ToolSession } from "..";
import { ToolError } from "../tool-errors";
import { toolResult } from "../tool-result";
import { validateValue } from "./schema";
import { SqlStore, type SqlStoreSchema } from "./sql-store";
import { AutonomyStateStore } from "./store";
import type { AutonomyStateResult, StateSchemaColumn } from "./types";

const autonomyStateSchema = Type.Union([
	// KV ops (legacy)
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
	// SQL table ops
	Type.Object({
		op: Type.Literal("query"),
		store: Type.String({ description: "State store name" }),
		table: Type.String({ description: "Table name" }),
		where: Type.Optional(Type.Record(Type.String(), Type.Unknown(), { description: "WHERE clause filters" })),
		limit: Type.Optional(Type.Number({ description: "Max rows to return" })),
		offset: Type.Optional(Type.Number({ description: "Rows to skip" })),
		orderBy: Type.Optional(Type.String({ description: "Column to order by" })),
		orderDir: Type.Optional(
			Type.Union([Type.Literal("asc"), Type.Literal("desc")], { description: "Sort direction" }),
		),
	}),
	Type.Object({
		op: Type.Literal("mutate"),
		store: Type.String({ description: "State store name" }),
		table: Type.String({ description: "Table name" }),
		action: Type.Union([Type.Literal("insert"), Type.Literal("update"), Type.Literal("delete")]),
		values: Type.Optional(Type.Record(Type.String(), Type.Unknown(), { description: "Column values" })),
		where: Type.Optional(Type.Record(Type.String(), Type.Unknown(), { description: "WHERE clause filters" })),
	}),
	Type.Object({
		op: Type.Literal("list_tables"),
		store: Type.String({ description: "State store name" }),
	}),
	Type.Object({
		op: Type.Literal("describe_table"),
		store: Type.String({ description: "State store name" }),
		table: Type.String({ description: "Table name" }),
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

function parseStoreSchemas(json: string | undefined): Map<string, SqlStoreSchema> {
	if (!json) return new Map();
	let parsed: unknown;
	try {
		parsed = JSON.parse(json);
	} catch {
		throw new ToolError("SPELL_AUTONOMY_STATE_SCHEMAS is not valid JSON.");
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		throw new ToolError("SPELL_AUTONOMY_STATE_SCHEMAS must be a JSON object mapping store names to schemas.");
	}
	for (const [key, value] of Object.entries(parsed)) {
		if (typeof value !== "object" || value === null || !Array.isArray((value as Record<string, unknown>).tables)) {
			throw new ToolError(`SPELL_AUTONOMY_STATE_SCHEMAS["${key}"] must have a "tables" array.`);
		}
	}
	return new Map(Object.entries(parsed as Record<string, SqlStoreSchema>));
}

function parseStorePaths(json: string | undefined): Map<string, string> {
	if (!json) return new Map();
	let parsed: unknown;
	try {
		parsed = JSON.parse(json);
	} catch {
		throw new ToolError("SPELL_AUTONOMY_STATE_STORES is not valid JSON.");
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		throw new ToolError("SPELL_AUTONOMY_STATE_STORES must be a JSON object mapping store names to file paths.");
	}
	for (const [key, value] of Object.entries(parsed)) {
		if (typeof value !== "string") {
			throw new ToolError(`SPELL_AUTONOMY_STATE_STORES["${key}"] must be a string file path.`);
		}
	}
	return new Map(Object.entries(parsed as Record<string, string>));
}

export class AutonomyStateTool implements AgentTool<typeof autonomyStateSchema, AutonomyStateResult> {
	readonly name = "autonomy_state";
	readonly label = "Autonomy State";
	readonly description =
		"Read and write autonomy run state persisted in SQLite for manifest-driven automation. Supports KV ops (get/set/list/delete) and table-aware SQL ops (query/mutate/list_tables/describe_table).";
	readonly parameters = autonomyStateSchema;
	readonly strict = true;
	#store: AutonomyStateStore | undefined;
	#schema: StateSchemaColumn[] | undefined;
	#sqlStores: Map<string, SqlStore> | undefined;
	#sqlSchemas: Map<string, SqlStoreSchema> | undefined;

	static createIf(_session: ToolSession): AutonomyStateTool | null {
		return Bun.env.SPELL_AUTONOMY_STATE_DB || Bun.env.SPELL_AUTONOMY_STATE_STORES ? new AutonomyStateTool() : null;
	}

	async execute(
		_toolCallId: string,
		input: AutonomyStateInput,
		_signal?: AbortSignal,
		_onUpdate?: AgentToolUpdateCallback<AutonomyStateResult>,
		_context?: AgentToolContext,
	): Promise<AgentToolResult<AutonomyStateResult>> {
		try {
			switch (input.op) {
				// KV ops
				case "get": {
					const store = this.#getKvStore();
					return this.#respond({ success: true, value: store.get(input.key) });
				}
				case "set": {
					const store = this.#getKvStore();
					const error = validateValue(input.key, input.value, this.#schema);
					if (error) return this.#respond({ success: false, error });
					store.set(input.key, input.value);
					return this.#respond({ success: true, value: input.value });
				}
				case "list": {
					const store = this.#getKvStore();
					return this.#respond({ success: true, keys: store.list() });
				}
				case "delete": {
					const store = this.#getKvStore();
					store.delete(input.key);
					return this.#respond({ success: true });
				}
				case "get_metadata": {
					const store = this.#getKvStore();
					return this.#respond({ success: true, metadata: store.getMetadata() ?? undefined });
				}
				// SQL table ops
				case "query": {
					const { store, schema } = this.#getSqlStoreAndSchema(input.store);
					const result = store.query(
						input.table,
						schema,
						input.where,
						input.limit,
						input.offset,
						input.orderBy,
						input.orderDir,
					);
					return this.#respond({ success: true, rows: result.rows, rowCount: result.rowCount });
				}
				case "mutate": {
					const { store, schema } = this.#getSqlStoreAndSchema(input.store);
					const result = store.mutate(input.table, schema, input.action, input.values, input.where);
					return this.#respond({ success: true, affectedRows: result.affectedRows });
				}
				case "list_tables": {
					const { store, schema } = this.#getSqlStoreAndSchema(input.store);
					return this.#respond({ success: true, tables: store.listTables(schema) });
				}
				case "describe_table": {
					const { store, schema } = this.#getSqlStoreAndSchema(input.store);
					return this.#respond({ success: true, columns: store.describeTable(input.table, schema) });
				}
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

	#getKvStore(): AutonomyStateStore {
		if (this.#store) return this.#store;
		const dbPath = Bun.env.SPELL_AUTONOMY_STATE_DB;
		if (!dbPath) {
			throw new ToolError("SPELL_AUTONOMY_STATE_DB is required for KV operations.");
		}
		this.#schema = parseSchema(Bun.env.SPELL_AUTONOMY_STATE_SCHEMA);
		this.#store = new AutonomyStateStore(dbPath, Bun.env.SPELL_AUTONOMY_RUN_ID);
		return this.#store;
	}

	#initSqlStores(): void {
		if (this.#sqlStores) return;
		const paths = parseStorePaths(Bun.env.SPELL_AUTONOMY_STATE_STORES);
		const schemas = parseStoreSchemas(Bun.env.SPELL_AUTONOMY_STATE_SCHEMAS);
		this.#sqlStores = new Map();
		this.#sqlSchemas = schemas;
		for (const [name, dbPath] of paths) {
			this.#sqlStores.set(name, new SqlStore(dbPath));
		}
	}

	#getSqlStoreAndSchema(storeName: string): { store: SqlStore; schema: SqlStoreSchema } {
		this.#initSqlStores();
		const store = this.#sqlStores!.get(storeName);
		if (!store) {
			const available = [...this.#sqlStores!.keys()].join(", ") || "(none)";
			throw new ToolError(`Unknown store "${storeName}". Available stores: ${available}`);
		}
		const schema = this.#sqlSchemas!.get(storeName);
		if (!schema) {
			throw new ToolError(`No schema defined for store "${storeName}".`);
		}
		return { store, schema };
	}
}
