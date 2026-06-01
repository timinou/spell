import { Database } from "bun:sqlite";
import { logger } from "@spell/pi-utils";
import type { RunMetadata } from "./types";

const LARGE_VALUE_WARN_BYTES = 100_000;

type MetadataRow = {
	run_id: string;
	started_at: string;
	status: string;
	duration: number | null;
	output_summary: string | null;
};

type ValueRow = {
	value: string;
};

export class AutonomyStateStore {
	#db: Database;
	#runId: string;

	constructor(dbPath: string, runId: string = Bun.env.SPELL_AUTONOMY_RUN_ID ?? crypto.randomUUID()) {
		this.#db = new Database(dbPath);
		this.#runId = runId;
		this.#db.exec(`
PRAGMA journal_mode=WAL;
PRAGMA synchronous=NORMAL;
PRAGMA busy_timeout=5000;
CREATE TABLE IF NOT EXISTS _metadata (
	run_id TEXT PRIMARY KEY,
	started_at TEXT NOT NULL,
	status TEXT NOT NULL DEFAULT 'running',
	duration INTEGER,
	output_summary TEXT
);
CREATE TABLE IF NOT EXISTS kv_store (
	key TEXT PRIMARY KEY,
	value TEXT NOT NULL,
	updated_at INTEGER NOT NULL
);
`);
		this.#db
			.prepare("INSERT OR IGNORE INTO _metadata (run_id, started_at, status) VALUES (?, ?, 'running')")
			.run(this.#runId, new Date().toISOString());
	}

	get(key: string): unknown | null {
		const row = this.#db.prepare("SELECT value FROM kv_store WHERE key = ?").get(key) as ValueRow | null;
		if (!row) return null;
		return JSON.parse(row.value) as unknown;
	}

	set(key: string, value: unknown): void {
		const serialized = JSON.stringify(value);
		if (serialized === undefined) {
			throw new Error(`Value for key '${key}' is not JSON serializable`);
		}
		if (serialized.length >= LARGE_VALUE_WARN_BYTES) {
			logger.warn("AutonomyStateStore storing large value", { key, bytes: serialized.length });
		}
		this.#db
			.prepare(
				"INSERT INTO kv_store (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
			)
			.run(key, serialized, Date.now());
	}

	list(): string[] {
		return (this.#db.prepare("SELECT key FROM kv_store ORDER BY key ASC").all() as Array<{ key: string }>).map(
			row => row.key,
		);
	}

	delete(key: string): void {
		this.#db.prepare("DELETE FROM kv_store WHERE key = ?").run(key);
	}

	getMetadata(): RunMetadata | null {
		const row = this.#db
			.prepare("SELECT run_id, started_at, status, duration, output_summary FROM _metadata WHERE run_id = ?")
			.get(this.#runId) as MetadataRow | null;
		if (!row) return null;
		return {
			runId: row.run_id,
			startedAt: row.started_at,
			status: row.status,
			duration: row.duration ?? undefined,
			outputSummary: row.output_summary ?? undefined,
		};
	}

	setMetadata(metadata: Partial<RunMetadata>): void {
		const current = this.getMetadata();
		const next: RunMetadata = {
			runId: metadata.runId ?? current?.runId ?? this.#runId,
			startedAt: metadata.startedAt ?? current?.startedAt ?? new Date().toISOString(),
			status: metadata.status ?? current?.status ?? "running",
			duration: metadata.duration ?? current?.duration,
			outputSummary: metadata.outputSummary ?? current?.outputSummary,
		};
		this.#runId = next.runId;
		this.#db
			.prepare(
				"INSERT INTO _metadata (run_id, started_at, status, duration, output_summary) VALUES (?, ?, ?, ?, ?) ON CONFLICT(run_id) DO UPDATE SET started_at = excluded.started_at, status = excluded.status, duration = excluded.duration, output_summary = excluded.output_summary",
			)
			.run(next.runId, next.startedAt, next.status, next.duration ?? null, next.outputSummary ?? null);
	}

	close(): void {
		this.#db.close();
	}
}
