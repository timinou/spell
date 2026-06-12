/**
 * Tile store (FUP-123) — persistence for stored-program tiles.
 *
 * A "tile" is a saved PTC-Lisp WRITE/READ program surfaced as a button the user
 * drives (codemod / format / changelog). Its persistence is SPLIT by lifecycle
 * (decision DEC-tile-persistence-architecture):
 *
 *   CONFIG  (low-churn, declarative)  → an ORG ITEM in the `tiles` category, with
 *           the config in its PROPERTIES drawer. Git-tracked, org-queryable,
 *           promote-lifecycle. owner+project keyed (per-operator now, per-project
 *           later — both fields always present).
 *   HISTORY (high-churn, event-log)   → one MEMORY EPISODE per run (the KG
 *           timeline), PLUS a cached last-outcome on the org item (3 properties)
 *           so the UI renders without a KG query.
 *
 * ∴ no new storage backend: tiles reuse org + memory, both already git-tracked
 * and queryable. The program itself is NOT stored here — a tile references a
 * memory playbook by id (`programRef`, FUP-115), with an inline fallback until
 * that ships.
 *
 * This module is the shared contract. The team-chat panel reaches it via the
 * ws `tile_*` RPC commands (rpc-mode.ts); a future unattended scheduler (FUP-130)
 * reaches the SAME functions directly.
 */

import { executeOrg } from "@spell/pi-natives";
import {
	DEFAULT_ORG_CONFIG,
	type OrgCategory,
	appendItemToFile,
	findItemById,
	generateId,
	readCategory,
	resolveCategories,
	setPropertyInFile,
} from "@spell/pi-org";
import { logger } from "@spell/pi-utils";
import fs from "node:fs/promises";
import path from "node:path";

/** Effect mode of a tile's program (mirrors StoredProgram.mode). */
export type TileMode = "read" | "write";

/**
 * What KIND of transform a tile carries — a presentation + starter-program facet,
 * not a safety axis (both kinds are write programs gated identically by the
 * rollback-safe bar). `codemod` = an arbitrary structural transform; `format` =
 * a hygiene/normalization sweep (whitespace, final newline). Defaults to
 * `codemod` for tiles created before this field existed.
 */
export type TileKind = "codemod" | "format";

/** The transactional outcome of a single run (mirrors TxnOutcome.outcome). */
export type TileOutcome = "committed" | "rolled-back" | "dry-run" | "inert" | "none";

/** A persisted tile's durable config + cached last-outcome. */
export interface TileRecord {
	/** Stable org CUSTOM_ID, e.g. "TILE-007-migrate-oldlog". */
	readonly id: string;
	/** Operator token (per-operator scoping). */
	readonly owner: string;
	/** Project/cwd key this tile targets. */
	readonly project: string;
	/** Display label. */
	readonly title: string;
	/** Transform kind (presentation/starter facet; default "codemod"). */
	readonly kind: TileKind;
	/**
	 * Reference to the program: a memory playbook id (FUP-115). When FUP-115 has
	 * not shipped, `programInline` carries the program text as a fallback.
	 */
	readonly programRef?: string;
	/** Inline program text fallback (used only when programRef is absent). */
	readonly programInline?: string;
	/** Effect mode. */
	readonly mode: TileMode;
	/** Armed for unattended auto-write (the trust toggle). */
	readonly autoWrite: boolean;
	/** Cron schedule for the future unattended scheduler (FUP-130); unused here. */
	readonly schedule?: string;
	/** Cached last-run outcome (for fast render without a KG query). */
	readonly lastOutcome?: TileOutcome;
	/** Cached last-run file count. */
	readonly lastFiles?: number;
	/** Cached last-run ISO timestamp. */
	readonly lastRunAt?: string;
}

/** A run outcome to record against a tile (config-independent). */
export interface TileRunOutcome {
	readonly intent: string;
	readonly outcome: TileOutcome;
	readonly files: number;
	readonly paths?: readonly string[];
	readonly error?: string;
}

const TILE_CATEGORY = "tiles";
const TILE_PREFIX = "TILE";

/** Resolve the tiles category for a project root. Throws if config lacks it. */
function tilesCategory(projectRoot: string): OrgCategory {
	const categories = resolveCategories(DEFAULT_ORG_CONFIG, projectRoot);
	const cat = categories.find(c => c.name === TILE_CATEGORY);
	if (!cat) throw new Error("tiles category not configured in org config");
	return cat;
}

const TODO_KEYWORDS = [...DEFAULT_ORG_CONFIG.todoKeywords];

/** Map an org item's PROPERTIES drawer back into a TileRecord. */
function recordFromProperties(id: string, title: string, props: Record<string, string>): TileRecord {
	const autoWrite = (props.AUTOWRITE ?? "nil") === "t";
	const mode: TileMode = props.MODE === "write" ? "write" : "read";
	const kind: TileKind = props.KIND === "format" ? "format" : "codemod";
	const lastFiles = props.LAST_FILES ? Number(props.LAST_FILES) : undefined;
	return {
		id,
		owner: props.OWNER ?? "",
		project: props.PROJECT ?? "",
		title,
		programRef: props.PROGRAM_REF || undefined,
		programInline: props.PROGRAM_INLINE || undefined,
		kind,
		mode,
		autoWrite,
		schedule: props.SCHEDULE || undefined,
		lastOutcome: (props.LAST_OUTCOME as TileOutcome) || undefined,
		lastFiles: Number.isFinite(lastFiles) ? lastFiles : undefined,
		lastRunAt: props.LAST_RUN_AT || undefined,
	};
}

/** Serialize a TileRecord's config into a PROPERTIES map. */
function propertiesFromRecord(rec: Omit<TileRecord, "id">): Record<string, string> {
	const props: Record<string, string> = {
		OWNER: rec.owner,
		PROJECT: rec.project,
		KIND: rec.kind,
		MODE: rec.mode,
		AUTOWRITE: rec.autoWrite ? "t" : "nil",
	};
	if (rec.programRef) props.PROGRAM_REF = rec.programRef;
	if (rec.programInline) props.PROGRAM_INLINE = rec.programInline;
	if (rec.schedule) props.SCHEDULE = rec.schedule;
	if (rec.lastOutcome) props.LAST_OUTCOME = rec.lastOutcome;
	if (rec.lastFiles !== undefined) props.LAST_FILES = String(rec.lastFiles);
	if (rec.lastRunAt) props.LAST_RUN_AT = rec.lastRunAt;
	return props;
}

/**
 * List tiles for a project. Reads every TILE-* org item and filters by project.
 * Per-operator filtering is the caller's job (owner is on each record).
 */
export async function listTiles(projectRoot: string, project: string): Promise<TileRecord[]> {
	const cat = tilesCategory(projectRoot);
	const items = await readCategory(cat.absPath, cat.name, cat.dirAbsPath, TODO_KEYWORDS, false);
	return items
		.map(it => recordFromProperties(it.id, it.title, it.properties ?? {}))
		.filter(rec => rec.project === project);
}

/** Fetch one tile by id, or undefined if not found. */
export async function getTile(projectRoot: string, id: string): Promise<TileRecord | undefined> {
	const cat = tilesCategory(projectRoot);
	const item = await findItemById(
		[{ absPath: cat.absPath, name: cat.name, dir: cat.dirAbsPath, prefix: cat.prefix, root: projectRoot }],
		id,
		TODO_KEYWORDS,
	);
	if (!item) return undefined;
	return recordFromProperties(item.id, item.title, item.properties ?? {});
}

/**
 * Create a new tile. Returns the assigned id. The org item is created in state
 * ITEM with the config serialized into its PROPERTIES drawer.
 */
export async function createTile(
	projectRoot: string,
	rec: Omit<TileRecord, "id" | "lastOutcome" | "lastFiles" | "lastRunAt">,
): Promise<string> {
	const cat = tilesCategory(projectRoot);
	const id = await generateId(cat.absPath, TILE_PREFIX, rec.title);
	const filePath = path.join(cat.absPath, `${id}.org`);
	await appendItemToFile(
		filePath,
		{ id, title: rec.title, category: cat.name, properties: propertiesFromRecord(rec) },
		"ITEM",
	);
	return id;
}

/**
 * Update a tile's config properties in place (e.g. arm/disarm autoWrite, retitle,
 * re-point programRef). Only the supplied fields are written. The org file is
 * located by id; missing tiles return false.
 */
export async function updateTile(
	projectRoot: string,
	id: string,
	patch: Partial<Omit<TileRecord, "id">>,
): Promise<boolean> {
	const cat = tilesCategory(projectRoot);
	const existing = await getTile(projectRoot, id);
	if (!existing) return false;
	const filePath = path.join(cat.absPath, `${id}.org`);
	const merged = { ...existing, ...patch };
	let ok = true;
	// The title is the org HEADLINE, not a PROPERTIES field — update it via the
	// native updateItem title path when the patch changes it (else a rename is
	// silently lost on reload).
	if (patch.title !== undefined && patch.title !== existing.title) {
		const result = await executeOrg({ command: "updateItem", file: filePath, id, title: patch.title, todoKeywords: TODO_KEYWORDS });
		if (result.error) ok = false;
	}
	// setPropertyInFile is one-property-at-a-time; write each drawer property.
	const props = propertiesFromRecord(merged);
	for (const [key, value] of Object.entries(props)) {
		const wrote = await setPropertyInFile(filePath, id, key, value, TODO_KEYWORDS);
		if (!wrote) ok = false;
	}
	return ok;
}

/**
 * Delete a tile. Each tile is its own `TILE-*.org` file, so deletion unlinks that
 * file. Returns true if a file was removed, false if it did not exist.
 */
export async function deleteTile(projectRoot: string, id: string): Promise<boolean> {
	const cat = tilesCategory(projectRoot);
	const filePath = path.join(cat.absPath, `${id}.org`);
	try {
		await fs.unlink(filePath);
		return true;
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
		throw err;
	}
}

/**
 * Record a run outcome against a tile: writes ONE memory episode (the durable KG
 * timeline) and updates the tile's cached last-outcome properties (for fast
 * render). Records BOTH commits and rollbacks with equal fidelity — a failed run
 * is never invisible.
 */
export async function recordRun(
	projectRoot: string,
	id: string,
	run: TileRunOutcome,
): Promise<void> {
	const at = new Date().toISOString();
	const pathsSuffix = run.paths && run.paths.length > 0 ? ` [${run.paths.join(", ")}]` : "";
	const errSuffix = run.error ? ` — ${run.error}` : "";
	const summary = `tile ${id} ${run.intent} ${run.outcome} ${run.files}${pathsSuffix}${errSuffix}`;

	// History → memory episode (KG timeline). ABOUT the tile org item.
	const result = await executeOrg({
		command: "remember",
		kind: "episode",
		summary,
		about: [id],
		repoRoot: projectRoot,
	});
	if (result.error) {
		logger.warn("tile recordRun: episode write failed", { id, output: String(result.output) });
	}

	// Cache the last outcome on the org item for fast render (no KG query needed).
	await updateTile(projectRoot, id, {
		lastOutcome: run.outcome,
		lastFiles: run.files,
		lastRunAt: at,
	});
}
