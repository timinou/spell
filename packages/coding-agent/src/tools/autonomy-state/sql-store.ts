import { Database } from "bun:sqlite";

export interface SqlStoreSchema {
	tables: SqlStoreTableSchema[];
}

export interface SqlStoreTableSchema {
	name: string;
	columns: SqlStoreColumnSchema[];
}

export interface SqlStoreColumnSchema {
	name: string;
	type: string;
	primary?: boolean;
}

export interface SqlQueryResult {
	rows: Record<string, unknown>[];
	rowCount: number;
}

export interface SqlMutateResult {
	affectedRows: number;
}

function escapeIdentifier(name: string): string {
	return `"${name.replaceAll('"', '""')}"`;
}

function findTable(schema: SqlStoreSchema, tableName: string): SqlStoreTableSchema | undefined {
	return schema.tables.find(t => t.name === tableName);
}

function validateColumns(table: SqlStoreTableSchema, columnNames: string[]): string | null {
	for (const col of columnNames) {
		if (!table.columns.some(c => c.name === col)) {
			return `Unknown column "${col}" in table "${table.name}". Valid columns: ${table.columns.map(c => c.name).join(", ")}`;
		}
	}
	return null;
}

export class SqlStore {
	#db: Database;

	constructor(dbPath: string) {
		this.#db = new Database(dbPath);
		this.#db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA busy_timeout=5000;");
	}

	query(
		tableName: string,
		schema: SqlStoreSchema,
		where?: Record<string, unknown>,
		limit?: number,
		offset?: number,
		orderBy?: string,
		orderDir?: "asc" | "desc",
	): SqlQueryResult {
		const table = findTable(schema, tableName);
		if (!table) {
			throw new Error(
				`Unknown table "${tableName}". Available tables: ${schema.tables.map(t => t.name).join(", ")}`,
			);
		}

		const whereKeys = where ? Object.keys(where) : [];
		if (whereKeys.length > 0) {
			const error = validateColumns(table, whereKeys);
			if (error) throw new Error(error);
		}

		if (orderBy) {
			const error = validateColumns(table, [orderBy]);
			if (error) throw new Error(error);
		}

		let sql = `SELECT * FROM ${escapeIdentifier(tableName)}`;
		const params: unknown[] = [];

		if (whereKeys.length > 0) {
			const clauses = whereKeys.map(key => {
				params.push(where![key]);
				return `${escapeIdentifier(key)} = ?`;
			});
			sql += ` WHERE ${clauses.join(" AND ")}`;
		}

		// Count query (same WHERE, no ORDER BY or LIMIT/OFFSET)
		const countSql = sql.replace(/^SELECT \* FROM/, "SELECT count(*) as count FROM");
		const countRow = this.#db.prepare(countSql).get(...params) as { count: number } | null;
		const rowCount = countRow?.count ?? 0;

		if (orderBy) {
			sql += ` ORDER BY ${escapeIdentifier(orderBy)} ${orderDir === "desc" ? "DESC" : "ASC"}`;
		}

		if (limit !== undefined) {
			sql += " LIMIT ?";
			params.push(limit);
		}
		if (offset !== undefined) {
			sql += " OFFSET ?";
			params.push(offset);
		}

		const rows = this.#db.prepare(sql).all(...params) as Record<string, unknown>[];
		return { rows, rowCount };
	}

	mutate(
		tableName: string,
		schema: SqlStoreSchema,
		action: "insert" | "update" | "delete",
		values?: Record<string, unknown>,
		where?: Record<string, unknown>,
	): SqlMutateResult {
		const table = findTable(schema, tableName);
		if (!table) {
			throw new Error(
				`Unknown table "${tableName}". Available tables: ${schema.tables.map(t => t.name).join(", ")}`,
			);
		}

		if (action === "insert") {
			if (!values || Object.keys(values).length === 0) {
				throw new Error("INSERT requires non-empty values");
			}
			const error = validateColumns(table, Object.keys(values));
			if (error) throw new Error(error);

			const cols = Object.keys(values);
			const placeholders = cols.map(() => "?").join(", ");
			const sql = `INSERT INTO ${escapeIdentifier(tableName)} (${cols.map(escapeIdentifier).join(", ")}) VALUES (${placeholders})`;
			const params = cols.map(c => serializeValue(values[c]));
			const result = this.#db.prepare(sql).run(...params);
			return { affectedRows: result.changes };
		}

		if (action === "update") {
			if (!values || Object.keys(values).length === 0) {
				throw new Error("UPDATE requires non-empty values");
			}
			const error = validateColumns(table, Object.keys(values));
			if (error) throw new Error(error);

			const whereKeys = where ? Object.keys(where) : [];
			if (whereKeys.length > 0) {
				const whereError = validateColumns(table, whereKeys);
				if (whereError) throw new Error(whereError);
			}

			const setClauses = Object.keys(values).map(c => `${escapeIdentifier(c)} = ?`);
			const params: unknown[] = Object.keys(values).map(c => serializeValue(values[c]));

			let sql = `UPDATE ${escapeIdentifier(tableName)} SET ${setClauses.join(", ")}`;
			if (whereKeys.length > 0) {
				const whereClauses = whereKeys.map(k => {
					params.push(where![k]);
					return `${escapeIdentifier(k)} = ?`;
				});
				sql += ` WHERE ${whereClauses.join(" AND ")}`;
			}

			const result = this.#db.prepare(sql).run(...params);
			return { affectedRows: result.changes };
		}

		// delete
		const whereKeys = where ? Object.keys(where) : [];
		if (whereKeys.length > 0) {
			const error = validateColumns(table, whereKeys);
			if (error) throw new Error(error);
		}

		let sql = `DELETE FROM ${escapeIdentifier(tableName)}`;
		const params: unknown[] = [];
		if (whereKeys.length > 0) {
			const clauses = whereKeys.map(k => {
				params.push(where![k]);
				return `${escapeIdentifier(k)} = ?`;
			});
			sql += ` WHERE ${clauses.join(" AND ")}`;
		}

		const result = this.#db.prepare(sql).run(...params);
		return { affectedRows: result.changes };
	}

	listTables(schema: SqlStoreSchema): string[] {
		return schema.tables.map(t => t.name);
	}

	describeTable(
		tableName: string,
		schema: SqlStoreSchema,
	): SqlStoreColumnSchema[] {
		const table = findTable(schema, tableName);
		if (!table) {
			throw new Error(
				`Unknown table "${tableName}". Available tables: ${schema.tables.map(t => t.name).join(", ")}`,
			);
		}
		return table.columns;
	}

	close(): void {
		this.#db.close();
	}
}

function serializeValue(value: unknown): unknown {
	if (value === null || value === undefined) return null;
	if (typeof value === "object") return JSON.stringify(value);
	return value;
}
