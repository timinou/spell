import type { Database } from "bun:sqlite";
import type { Deliverable, DeliverableState, DeliverableType, Deadline, PipelineSummary } from "./types.ts";

/**
 * Returns a count of deliverables grouped by state.
 * States not present in the DB contribute 0.
 */
export function getPipelineSummary(db: Database): PipelineSummary {
  const rows = db
    .prepare(`SELECT state, COUNT(*) as count FROM deliverables GROUP BY state`)
    .all() as Array<{ state: string; count: number }>;

  const map: Record<string, number> = {};
  for (const row of rows) {
    map[row.state] = row.count;
  }

  return {
    brief: map['BRIEF'] ?? 0,
    draft: map['DRAFT'] ?? 0,
    review: map['REVIEW'] ?? 0,
    final: map['FINAL'] ?? 0,
    sent: map['SENT'] ?? 0,
  };
}

/**
 * Returns deliverables whose `due_date` falls within the next `days` calendar days
 * (default: 7), ordered by due_date ascending.
 * Deliverables with no due_date are excluded.
 */
export function getUpcomingDeadlines(db: Database, days = 7): Deadline[] {
  const now = new Date();
  const cutoff = new Date(now.getTime() + days * 24 * 60 * 60 * 1_000);

  const rows = db
    .prepare(
      `SELECT id, title, due_date, state
       FROM deliverables
       WHERE due_date IS NOT NULL
         AND due_date >= ?
         AND due_date <= ?
       ORDER BY due_date ASC`,
    )
    .all(now.toISOString(), cutoff.toISOString()) as Array<{
    id: string;
    title: string;
    due_date: string;
    state: string;
  }>;

  return rows.map((row) => ({
    deliverableId: row.id,
    title: row.title,
    dueDate: row.due_date,
    state: row.state as DeliverableState,
  }));
}

/**
 * Returns the most recently updated deliverables, newest first.
 * Default limit: 20.
 */
export function getRecentDeliverables(db: Database, limit = 20): Deliverable[] {
  const rows = db
    .prepare(`SELECT * FROM deliverables ORDER BY updated_at DESC LIMIT ?`)
    .all(limit) as RawRow[];

  return rows.map(rowToDeliverable);
}

// ─── Internal row shape ──────────────────────────────────────────────────────

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
