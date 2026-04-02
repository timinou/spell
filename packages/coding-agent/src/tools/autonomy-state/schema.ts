import type { StateSchemaColumn } from "./types";

export function validateValue(key: string, value: unknown, schema: StateSchemaColumn[] | undefined): string | null {
	if (!schema) return null;
	const column = schema.find(entry => entry.name === key);
	if (!column) return null;
	if (column.type === "json") return null;
	if (column.type === "string" && typeof value !== "string") return `Key '${key}' expects string`;
	if (column.type === "number" && typeof value !== "number") return `Key '${key}' expects number`;
	if (column.type === "boolean" && typeof value !== "boolean") return `Key '${key}' expects boolean`;
	return null;
}
