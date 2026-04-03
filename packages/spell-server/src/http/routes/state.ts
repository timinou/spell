import type { StateStoreManager } from "../../state/store-manager";

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 1_000;

function parsePagination(request: Request): { limit: number; offset: number } {
	const url = new URL(request.url);
	const rawLimit = Number(url.searchParams.get("limit") ?? DEFAULT_LIMIT);
	const rawOffset = Number(url.searchParams.get("offset") ?? 0);
	const limit = Number.isFinite(rawLimit) ? Math.max(0, Math.min(MAX_LIMIT, Math.floor(rawLimit))) : DEFAULT_LIMIT;
	const offset = Number.isFinite(rawOffset) ? Math.max(0, Math.floor(rawOffset)) : 0;
	return { limit, offset };
}

function notFound(message: string): Response {
	return Response.json({ error: message }, { status: 404 });
}

export function handleListStores(manager: StateStoreManager): Response {
	return Response.json(manager.getStores());
}

export function handleListTables(storeName: string, manager: StateStoreManager): Response {
	const tables = manager.getTablesForStore(storeName);
	if (tables === null) {
		return notFound("Store not found");
	}
	return Response.json(tables);
}

export function handleQueryTable(
	storeName: string,
	tableName: string,
	request: Request,
	manager: StateStoreManager,
): Response {
	const tables = manager.getTablesForStore(storeName);
	if (tables === null) {
		return notFound("Store not found");
	}
	if (!tables.some(table => table.name === tableName)) {
		return notFound("Table not found");
	}
	const { limit, offset } = parsePagination(request);
	return Response.json(manager.queryTable(storeName, tableName, limit, offset));
}

export function handleTableCount(storeName: string, tableName: string, manager: StateStoreManager): Response {
	const count = manager.countTable(storeName, tableName);
	if (count === null) {
		return notFound("Store or table not found");
	}
	return Response.json({ total: count });
}
