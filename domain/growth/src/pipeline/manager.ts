import { Database } from "bun:sqlite";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { Deliverable, DeliverableState, DeliverableType } from "./types.ts";

// Valid one-way state progression. Each state may only advance to the next.
const STATE_ORDER: DeliverableState[] = ['BRIEF', 'DRAFT', 'REVIEW', 'FINAL', 'SENT'];

interface CreateOpts {
  title: string;
  type: DeliverableType;
  clientId?: string;
  /** If supplied, file stub is copied from this path; otherwise an empty stub is created. */
  templatePath?: string;
}

interface DeliverableManagerOptions {
  dbPath: string;
}

/**
 * Manages the lifecycle of deliverables: creation, state advancement, and queries.
 *
 * State machine: BRIEF → DRAFT → REVIEW → FINAL → SENT (one direction only).
 * Each deliverable is backed by a .typ file on disk and a row in the SQLite table.
 */
export class DeliverableManager {
  readonly #db: Database;

  constructor({ dbPath }: DeliverableManagerOptions) {
    this.#db = new Database(dbPath, { create: true });
    this.#db.exec("PRAGMA journal_mode=WAL;");
    this.#db.exec("PRAGMA foreign_keys=ON;");
    this.#ensureSchema();
  }

  /**
   * Create a new deliverable in BRIEF state.
   * Generates a UUID, writes a .typ stub to disk, and inserts a DB row.
   */
  create(opts: CreateOpts): Deliverable {
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    // Derive a safe filename from the title — lowercase, spaces to hyphens, strip unsafe chars.
    const slug = opts.title
      .toLowerCase()
      .replace(/\s+/g, '-')
      .replace(/[^a-z0-9\-]/g, '');
    const filePath = `deliverables/${id}-${slug}.typ`;

    // Write the .typ stub synchronously using node:fs so the call stays synchronous.
    const stubContent = opts.templatePath
      ? readFileSync(opts.templatePath, 'utf8')
      : `// Deliverable: ${opts.title}\n// Type: ${opts.type}\n// Created: ${now}\n`;

    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, stubContent, 'utf8');

    // orgItemId is set to empty string at creation; callers may update it after org item creation.
    const orgItemId = '';

    this.#db
      .prepare(
        `INSERT INTO deliverables
           (id, org_item_id, file_path, client_id, type, state, title, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, orgItemId, filePath, opts.clientId ?? null, opts.type, 'BRIEF', opts.title, now, now);

    return this.#requireById(id);
  }

  /**
   * Advance a deliverable to `targetState`.
   * Only forward transitions are allowed (BRIEF→DRAFT→REVIEW→FINAL→SENT).
   * Throws if the transition is invalid or the deliverable does not exist.
   */
  advance(id: string, targetState: DeliverableState): Deliverable {
    const current = this.getById(id);
    if (current === null) {
      throw new Error(`DeliverableManager: deliverable "${id}" not found`);
    }

    const currentIdx = STATE_ORDER.indexOf(current.state);
    const targetIdx = STATE_ORDER.indexOf(targetState);

    if (targetIdx !== currentIdx + 1) {
      throw new Error(
        `DeliverableManager: invalid transition ${current.state} → ${targetState}. ` +
          `Expected next state: ${STATE_ORDER[currentIdx + 1] ?? '(terminal)'}`,
      );
    }

    const now = new Date().toISOString();
    this.#db
      .prepare(`UPDATE deliverables SET state = ?, updated_at = ? WHERE id = ?`)
      .run(targetState, now, id);

    return this.#requireById(id);
  }

  getById(id: string): Deliverable | null {
    const row = this.#db
      .prepare(`SELECT * FROM deliverables WHERE id = ?`)
      .get(id) as RawRow | null;
    return row === null ? null : rowToDeliverable(row);
  }

  listByState(state: DeliverableState): Deliverable[] {
    return (
      this.#db
        .prepare(`SELECT * FROM deliverables WHERE state = ? ORDER BY updated_at DESC`)
        .all(state) as RawRow[]
    ).map(rowToDeliverable);
  }

  listByClient(clientId: string): Deliverable[] {
    return (
      this.#db
        .prepare(`SELECT * FROM deliverables WHERE client_id = ? ORDER BY updated_at DESC`)
        .all(clientId) as RawRow[]
    ).map(rowToDeliverable);
  }

  dispose(): void {
    this.#db.close();
  }

  // ─── Private helpers ────────────────────────────────────────────────────────

  #ensureSchema(): void {
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS deliverables (
        id          TEXT NOT NULL PRIMARY KEY,
        org_item_id TEXT NOT NULL DEFAULT '',
        file_path   TEXT NOT NULL,
        client_id   TEXT,
        type        TEXT NOT NULL,
        state       TEXT NOT NULL,
        title       TEXT NOT NULL,
        due_date    TEXT,
        created_at  TEXT NOT NULL,
        updated_at  TEXT NOT NULL
      );
    `);
    this.#db.exec(
      `CREATE INDEX IF NOT EXISTS idx_deliverables_state ON deliverables (state);`,
    );
    this.#db.exec(
      `CREATE INDEX IF NOT EXISTS idx_deliverables_client_id ON deliverables (client_id);`,
    );
    this.#db.exec(
      `CREATE INDEX IF NOT EXISTS idx_deliverables_due_date ON deliverables (due_date);`,
    );
  }

  /** Returns the deliverable by id, throwing if somehow absent after a write. */
  #requireById(id: string): Deliverable {
    const row = this.getById(id);
    if (row === null) {
      throw new Error(`DeliverableManager: expected row for id "${id}" to exist after write`);
    }
    return row;
  }
}

// ─── Row mapping ────────────────────────────────────────────────────────────

/** Raw SQLite row shape — snake_case column names as returned by bun:sqlite. */
interface RawRow {
  id: string;
  org_item_id: string;
  file_path: string;
  client_id: string | null;
  type: string;
  state: string;
  title: string;
  created_at: string;
  updated_at: string;
}

function rowToDeliverable(row: RawRow): Deliverable {
  const deliverable: Deliverable = {
    id: row.id,
    orgItemId: row.org_item_id,
    filePath: row.file_path,
    type: row.type as DeliverableType,
    state: row.state as DeliverableState,
    title: row.title,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
  if (row.client_id !== null) {
    deliverable.clientId = row.client_id;
  }
  return deliverable;
}
