/**
 * Journal writer — persists todo_write state to org files.
 *
 * Each coding session gets a single journal file at:
 *   .local/!journal/todos/YYYY-MM-DD-<session-hash>.org
 *
 * The file is fully rewritten on each todo_write call so it always reflects
 * the current state (no incremental diffing needed — the file is small and
 * write is cheap).
 *
 * Status mapping:
 *   pending     → ITEM
 *   in_progress → DOING
 *   completed   → DONE
 *   abandoned   → BLOCKED (deferred with :DEFERRED_TO: property)
 */

import * as path from "node:path";
import { logger } from "@oh-my-pi/pi-utils";
import { atomicWrite } from "./atomic-write";

// =============================================================================
// Types (mirrored from coding-agent to avoid circular imports)
// =============================================================================

export interface JournalTodoItem {
	id: string;
	content: string;
	status: "pending" | "in_progress" | "completed" | "abandoned";
	notes?: string;
	details?: string;
	gateCommit?: boolean;
	gateArtifact?: string;
	gateCmd?: string;
	gateLlm?: string;
	verifyCmd?: string;
	blockers?: string[];
	orgItemId?: string;
	orgItemClosingId?: string;
	deferralFupId?: string;
}

export interface JournalTodoPhase {
	id: string;
	name: string;
	tasks: JournalTodoItem[];
}

// =============================================================================
// Status mapping
// =============================================================================

const STATUS_TO_ORG: Record<string, string> = {
	pending: "ITEM",
	in_progress: "DOING",
	completed: "DONE",
	abandoned: "BLOCKED",
};

// =============================================================================
// Serialization
// =============================================================================

function serializeJournalOrg(phases: JournalTodoPhase[], sessionId: string, date: string): string {
	const lines: string[] = [
		`#+TITLE: Session ${sessionId} Todos`,
		`#+DATE: ${date}`,
		`#+TODO: ITEM DOING BLOCKED | DONE`,
		"",
	];

	for (const phase of phases) {
		lines.push(`* ${phase.name}`);
		lines.push("");

		for (const task of phase.tasks) {
			const keyword = STATUS_TO_ORG[task.status] ?? "ITEM";
			const title = task.status === "abandoned" ? `~~${task.content}~~` : task.content;

			lines.push(`** ${keyword} ${title}`);
			lines.push(":PROPERTIES:");
			lines.push(`:TASK_ID: ${task.id}`);
			lines.push(`:STATUS: ${task.status}`);
			if (task.gateCommit) lines.push(":GATE_COMMIT: true");
			if (task.gateArtifact) lines.push(`:GATE_ARTIFACT: ${task.gateArtifact}`);
			if (task.gateCmd) lines.push(`:GATE_CMD: ${task.gateCmd}`);
			if (task.gateLlm) lines.push(`:GATE_LLM: ${task.gateLlm}`);
			if (task.verifyCmd) lines.push(`:VERIFY_CMD: ${task.verifyCmd}`);
			if (task.blockers?.length) lines.push(`:DEPENDS: ${task.blockers.join(" ")}`);
			if (task.orgItemId) lines.push(`:ORG_ITEM_ID: ${task.orgItemId}`);
			if (task.orgItemClosingId) lines.push(`:ORG_ITEM_CLOSING_ID: ${task.orgItemClosingId}`);
			if (task.deferralFupId) lines.push(`:DEFERRED_TO: ${task.deferralFupId}`);
			lines.push(":END:");

			if (task.details) {
				lines.push("");
				lines.push(task.details.trimEnd());
			}

			if (task.notes) {
				lines.push("");
				lines.push(task.notes.trimEnd());
			}

			lines.push("");
		}
	}

	return lines.join("\n");
}

// =============================================================================
// Public API
// =============================================================================

/**
 * Compute the journal file path for a session.
 * Format: `.local/!journal/todos/YYYY-MM-DD-{sessionHash}.org`
 */
export function journalFilePath(projectRoot: string, sessionId: string): string {
	const date = new Date().toISOString().slice(0, 10);
	// Short stable hash of session ID for the filename
	const hashHex = BigInt(Bun.hash(sessionId)).toString(16).slice(0, 8).padStart(8, "0");
	const fileName = `${date}-${hashHex}.org`;
	return path.join(projectRoot, ".local", "!journal", "todos", fileName);
}

/**
 * Write the current todo phases to the journal org file.
 *
 * Best-effort: errors are logged but not thrown. Callers should not block on
 * this write — it's informational persistence, not a critical write path.
 */
export async function writeJournal(projectRoot: string, sessionId: string, phases: JournalTodoPhase[]): Promise<void> {
	const filePath = journalFilePath(projectRoot, sessionId);
	const date = new Date().toISOString().slice(0, 10);

	try {
		const content = serializeJournalOrg(phases, sessionId, date);
		await atomicWrite(filePath, content);
		logger.debug("org:journal written", { filePath, phases: phases.length });
	} catch (err) {
		// Non-fatal — journal writes fail silently to avoid disrupting todo_write
		logger.warn("org:journal write failed", {
			filePath,
			error: err instanceof Error ? err.message : String(err),
		});
	}
}
