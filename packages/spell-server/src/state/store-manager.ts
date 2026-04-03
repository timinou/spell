import * as path from "node:path";
import { Database } from "bun:sqlite";
import type { AutonomyManifest, NamedStateStore, StateSchema, StateSchemaTable } from "../manifest/types";

interface StateStoreSummary {
	name: string;
	backend: NamedStateStore["backend"];
	path: string;
	schemaId?: string;
}

interface StateTableQueryResult {
	columns: string[];
	rows: Record<string, unknown>[];
	total: number;
}

export class StateStoreManager {
	#stores = new Map<string, NamedStateStore>();
	#connections = new Map<string, Database>();
	#schemas = new Map<string, StateSchema>();
	#storeSchemaMap = new Map<string, string>();

	constructor(manifest: AutonomyManifest, cwd: string) {
		for (const schema of manifest.stateSchemas) {
			this.#schemas.set(schema.id, schema);
		}

		for (const setup of manifest.setups.values()) {
			for (const [storeName, store] of setup.stateStores ?? []) {
				this.#stores.set(storeName, store);
				if (store.schema) {
					this.#storeSchemaMap.set(storeName, store.schema);
				}
				if (store.backend !== "sqlite") {
					continue;
				}
				const resolvedPath = path.resolve(cwd, store.path);
				this.#connections.set(storeName, new Database(resolvedPath, { readonly: true }));
			}
		}
	}

	getStores(): StateStoreSummary[] {
		return Array.from(this.#stores.entries(), ([name, store]) => ({
			name,
			backend: store.backend,
			path: store.path,
			...(store.schema ? { schemaId: store.schema } : {}),
		}));
	}

	getTablesForStore(storeName: string): StateSchemaTable[] | null {
		if (!this.#stores.has(storeName)) {
			return null;
		}
		const schemaId = this.#storeSchemaMap.get(storeName);
		if (!schemaId) {
			return [];
		}
		return this.#schemas.get(schemaId)?.tables ?? [];
	}

	queryTable(storeName: string, tableName: string, limit: number, offset: number): StateTableQueryResult | null {
		const store = this.#stores.get(storeName);
		if (!store) {
			return null;
		}
		const tables = this.getTablesForStore(storeName);
		if (!tables) {
			return null;
		}
		const table = tables.find(candidate => candidate.name === tableName);
		if (!table) {
			return null;
		}
		const database = this.#connections.get(storeName);
		if (!database) {
			return {
				columns: table.columns.map(column => column.name),
				rows: [],
				total: 0,
			};
		}

		const escapedTableName = table.name.replaceAll('"', '""');
		const rows = database
			.query(`SELECT * FROM "${escapedTableName}" LIMIT ? OFFSET ?`)
			.all(limit, offset) as Record<string, unknown>[];
		const countRow = database
			.query(`SELECT count(*) as count FROM "${escapedTableName}"`)
			.get() as { count: number } | null;

		return {
			columns: table.columns.map(column => column.name),
			rows,
			total: countRow?.count ?? 0,
		};
	}

	close(): void {
		for (const connection of this.#connections.values()) {
			connection.close();
		}
		this.#connections.clear();
	}
}
