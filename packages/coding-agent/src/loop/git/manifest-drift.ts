import { TICKET_STATES } from "../contracts";
import type { ParsedSpecFile } from "../ingestion/parser";
import type { ManifestSnapshot, ManifestTicket } from "../types";
import type { DriftSnapshot } from "./drift";
import { detectSpecDrift } from "./drift";

export interface DriftReport {
	modified: string[];
	added: string[];
	deleted: string[];
	affectedTickets: string[];
	newItems: string[];
	removedItems: string[];
}

function emptyDriftReport(): DriftReport {
	return {
		modified: [],
		added: [],
		deleted: [],
		affectedTickets: [],
		newItems: [],
		removedItems: [],
	};
}

/**
 * Enhanced drift detection that categorizes changes into modified/added/deleted
 * and identifies affected CUSTOM_IDs by parsing changed files.
 */
export async function detectEnhancedDrift(baseline: DriftSnapshot, currentPaths: string[]): Promise<DriftReport> {
	const report = emptyDriftReport();

	const baselinePaths = new Set(Object.keys(baseline));
	const currentSet = new Set(currentPaths);

	// New files not in baseline
	for (const p of currentPaths) {
		if (!baselinePaths.has(p)) {
			report.added.push(p);
		}
	}

	// Deleted files: in baseline but not in current paths
	for (const p of baselinePaths) {
		if (!currentSet.has(p)) {
			report.deleted.push(p);
		}
	}

	// Modified files: in both but content changed
	const changedFiles = await detectSpecDrift(baseline);
	for (const f of changedFiles) {
		// Only count as modified if it wasn't already categorized as deleted
		if (currentSet.has(f)) {
			report.modified.push(f);
		}
	}

	// Parse changed/added files to find affected CUSTOM_IDs
	const allChangedPaths = [...report.modified, ...report.added];
	const currentIds = await extractCustomIds(allChangedPaths);

	// Parse deleted files from baseline to find removed CUSTOM_IDs
	// (We can't read deleted files, but we can note them as affected)
	// Deleted file IDs must come from baseline parsing — caller provides via newSpecContent

	report.affectedTickets.push(...currentIds);

	return report;
}

/** Extract CUSTOM_ID values from org files at the given paths. */
async function extractCustomIds(paths: string[]): Promise<string[]> {
	const ids: string[] = [];
	const customIdPattern = /:CUSTOM_ID:\s+(\S+)/g;

	for (const filePath of paths) {
		try {
			const content = await Bun.file(filePath).text();
			for (const m of content.matchAll(customIdPattern)) {
				if (m[1]) ids.push(m[1]);
			}
		} catch {
			// File may not exist (race condition); skip silently
		}
	}

	return ids;
}

export interface ManifestMergeResult {
	manifest: ManifestSnapshot;
	added: ManifestTicket[];
	removed: string[];
	preserved: string[];
	modified: string[];
}

/**
 * Merge drift changes into existing manifest, preserving completed tickets.
 *
 * - DONE tickets are never removed, even if their spec is deleted
 * - New items from changed specs become ITEM tickets
 * - Non-DONE tickets whose specs were deleted are removed
 * - Tickets whose specs changed preserve their state
 */
export function mergeManifestWithDrift(
	existing: ManifestSnapshot,
	driftReport: DriftReport,
	newSpecContent: ParsedSpecFile[],
): ManifestMergeResult {
	const result: ManifestMergeResult = {
		manifest: { ...existing, tickets: [...existing.tickets] },
		added: [],
		removed: [],
		preserved: [],
		modified: [],
	};

	const ticketById = new Map<string, ManifestTicket>();
	for (const t of existing.tickets) {
		ticketById.set(t.id, t);
	}

	// Build set of all new CUSTOM_IDs from spec content
	const newIdSet = new Set<string>();
	const specByCustomId = new Map<string, ParsedSpecFile>();
	for (const spec of newSpecContent) {
		for (const id of spec.customIds) {
			newIdSet.add(id);
			specByCustomId.set(id, spec);
		}
	}

	// Deleted file paths — tickets referencing these paths may need removal
	const deletedPaths = new Set(driftReport.deleted);
	const modifiedPaths = new Set(driftReport.modified);

	// Handle removals: tickets whose spec files were deleted
	const surviving: ManifestTicket[] = [];
	for (const ticket of result.manifest.tickets) {
		const specDeleted = ticket.specPath !== undefined && deletedPaths.has(ticket.specPath);
		const specModified = ticket.specPath !== undefined && modifiedPaths.has(ticket.specPath);
		const idGone = !newIdSet.has(ticket.id) && (specDeleted || specModified);

		if (idGone) {
			if (ticket.state === TICKET_STATES.done) {
				// Preserve completed tickets even if spec removed
				surviving.push(ticket);
				result.preserved.push(ticket.id);
			} else {
				result.removed.push(ticket.id);
			}
		} else {
			surviving.push(ticket);
		}
	}

	// Handle modifications: tickets whose spec content changed
	for (const ticket of surviving) {
		if (ticket.specPath !== undefined && modifiedPaths.has(ticket.specPath)) {
			result.modified.push(ticket.id);
		}
	}

	// Handle additions: new CUSTOM_IDs not already in manifest
	const existingIds = new Set(surviving.map(t => t.id));
	for (const spec of newSpecContent) {
		for (const customId of spec.customIds) {
			if (!existingIds.has(customId)) {
				const newTicket: ManifestTicket = {
					id: customId,
					title: customId,
					state: TICKET_STATES.item,
					specPath: spec.path,
					acceptanceCriteria: [],
					dependencies: [],
					triggers: [],
					gates: [],
					tags: [],
					changedFiles: [],
					findings: [],
					iterationHistory: [],
				};
				surviving.push(newTicket);
				result.added.push(newTicket);
				existingIds.add(customId);
			}
		}
	}

	result.manifest.tickets = surviving;
	result.manifest.version = existing.version + 1;
	result.manifest.updatedAt = Date.now();

	return result;
}
