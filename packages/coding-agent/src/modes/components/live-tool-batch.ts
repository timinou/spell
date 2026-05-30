import { Container, SPINNER_MARKER } from "@spell/pi-tui";
import { theme } from "../../modes/theme/theme";
import { formatStatusIcon, truncateToWidth } from "../../tools/render-utils";
import type { ToolExecutionComponent, ToolExecutionHandle } from "./tool-execution";

/**
 * Bounded live view over a single assistant message's parallel tool batch.
 *
 * ## Why this exists
 * A tool cell renders "pending" until its `tool_execution_end` arrives. The
 * terminal renderer ({@link packages/tui/src/tui.ts}) keeps the full transcript
 * in `#previousLines` and diff-paints the viewport: rows that scroll above the
 * viewport are committed to the terminal's NATIVE scrollback, which is immutable
 * — a later in-place edit of such a row is silently lost (proven via
 * xterm-headless). When a model emits a large parallel batch (observed: 59 / 77 /
 * 87 tool calls in one message), every cell is created pending at
 * `message_update` time, the batch overflows the viewport, and the top cells
 * scroll into scrollback BEFORE their results land — freezing them visually
 * pending forever even though the session continues. Small batches (1–3) finish
 * while still in the viewport, so they scroll off already-finalized; this is the
 * "async vs sync" asymmetry users observe.
 *
 * ## What it does
 * While the batch is large and still has unresolved cells it renders a COMPACT,
 * height-bounded summary (header + capped status rows + footer), so the live
 * region stays inside the viewport and never commits a pending row to
 * scrollback. Once every cell is finalized it switches to a pure pass-through
 * concat of the underlying {@link ToolExecutionComponent} renders — byte-for-byte
 * what history replay (`ui-helpers.renderSessionContext`) produces — so the
 * expanded output scrolls into scrollback already stable. Batches below
 * {@link COMPACT_THRESHOLD} always render full, so single/small batches are
 * visually identical to an ungrouped cell.
 *
 * ## Handle contract
 * It implements {@link ToolExecutionHandle} keyed by `toolCallId`, so the event
 * controller's `pendingTools` routing (`updateArgs` / `updateResult` /
 * `setArgsComplete` by id) is unchanged: many ids map to one group instance and
 * each call is dispatched to the matching cell. Orphan finalize, error-stop
 * finalize, and background/async tracking all continue to work per-id through
 * the group.
 */

/** Minimum cell count before a still-pending batch is rendered compact. */
export const COMPACT_THRESHOLD = 6;
/** Maximum per-cell status rows shown in the compact view (bounds height). */
export const COMPACT_MAX_ROWS = 8;

type BatchStatus = "pending" | "success" | "error";

interface BatchEntry {
	id: string;
	label: string;
	preview: string;
	status: BatchStatus;
	cell: ToolExecutionComponent;
}

/** Pull a short, human-meaningful preview from streamed tool args. */
function derivePreview(args: unknown): string {
	if (!args || typeof args !== "object" || Array.isArray(args)) return "";
	const record = args as Record<string, unknown>;
	for (const key of ["command", "target", "path", "file", "query", "url", "id"]) {
		const value = record[key];
		if (typeof value === "string" && value.trim().length > 0) return value.trim();
	}
	return "";
}

export class LiveToolBatchComponent extends Container implements ToolExecutionHandle {
	#entries: BatchEntry[] = [];
	#byId = new Map<string, BatchEntry>();
	#expanded = false;
	#cacheLines?: string[];
	#cacheWidth?: number;
	#selfDirty = true;

	/** Register a new cell. The cell is also added as a child so its
	 *  invalidations (spinner ticks, partial updates) propagate dirty upward. */
	addCell(id: string, label: string, args: unknown, cell: ToolExecutionComponent): void {
		if (this.#byId.has(id)) return;
		const entry: BatchEntry = { id, label, preview: derivePreview(args), status: "pending", cell };
		this.#entries.push(entry);
		this.#byId.set(id, entry);
		this.addChild(cell);
		this.#invalidateSelf();
	}

	has(id: string): boolean {
		return this.#byId.has(id);
	}

	get size(): number {
		return this.#entries.length;
	}

	/**
	 * Remove a cell from the group entirely. Used by the event controller to
	 * reap ghost cells whose toolCallId vanished from the streaming partial
	 * message (e.g. provider stream-retry that wiped its content blocks).
	 * Returns true if the cell existed and was removed.
	 */
	removeCell(id: string): boolean {
		const entry = this.#byId.get(id);
		if (!entry) return false;
		this.removeChild(entry.cell);
		this.#entries = this.#entries.filter(e => e.id !== id);
		this.#byId.delete(id);
		this.#invalidateSelf();
		return true;
	}

	updateArgs(args: unknown, toolCallId?: string): void {
		if (!toolCallId) return;
		const entry = this.#byId.get(toolCallId);
		if (!entry) return;
		const preview = derivePreview(args);
		if (preview) entry.preview = preview;
		entry.cell.updateArgs(args, toolCallId);
		this.#invalidateSelf();
	}

	updateResult(
		result: {
			content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
			details?: unknown;
			isError?: boolean;
		},
		isPartial = false,
		toolCallId?: string,
	): void {
		if (!toolCallId) return;
		const entry = this.#byId.get(toolCallId);
		if (!entry) return;
		entry.cell.updateResult(result, isPartial, toolCallId);
		// A partial (still-running / streaming) result keeps the cell pending; only
		// a terminal result flips the compact status row.
		if (!isPartial) {
			entry.status = result.isError ? "error" : "success";
		}
		this.#invalidateSelf();
	}

	setArgsComplete(toolCallId?: string): void {
		if (!toolCallId) return;
		const entry = this.#byId.get(toolCallId);
		if (!entry) return;
		entry.cell.setArgsComplete(toolCallId);
		this.#invalidateSelf();
	}

	setExpanded(expanded: boolean): void {
		this.#expanded = expanded;
		for (const entry of this.#entries) {
			entry.cell.setExpanded(expanded);
		}
		this.#invalidateSelf();
	}

	/** True once every registered cell has a terminal result. */
	get #allResolved(): boolean {
		for (const entry of this.#entries) {
			if (entry.status === "pending") return false;
		}
		return true;
	}

	/** Compact (bounded) view applies only to large, still-running batches. */
	get #isCompact(): boolean {
		return this.#entries.length >= COMPACT_THRESHOLD && !this.#allResolved;
	}

	#invalidateSelf(): void {
		this.invalidate();
	}

	// `render()` is overridden and never resets the base Container `#dirty` flag,
	// so `Container.markDirty()`'s `if (#dirty) return` guard would permanently
	// swallow upward propagation after the first dirtying (BUG-391 stuck-dirty
	// hazard). `Container.invalidate()` unconditionally calls `#parent.markDirty()`,
	// so route both our own invalidations AND child-driven `markDirty()` (spinner
	// ticks, partial updates bubbling up from cell components) through it.
	override markDirty(): void {
		this.invalidate();
	}

	override invalidate(): void {
		this.#selfDirty = true;
		this.#cacheLines = undefined;
		super.invalidate();
	}

	override render(width: number): string[] {
		const safeWidth = Math.max(1, width);
		if (!this.#selfDirty && this.#cacheWidth === safeWidth && this.#cacheLines) {
			return this.#cacheLines;
		}
		const lines = this.#isCompact ? this.#renderCompact(safeWidth) : this.#renderFull(safeWidth);
		this.#cacheLines = lines;
		this.#cacheWidth = safeWidth;
		this.#selfDirty = false;
		return lines;
	}

	/** Pass-through: identical to ungrouped cells (and to history replay). */
	#renderFull(width: number): string[] {
		const lines: string[] = [];
		for (const entry of this.#entries) {
			lines.push(...entry.cell.render(width));
		}
		return lines;
	}

	/** Height-bounded summary that keeps the live region inside the viewport. */
	#renderCompact(width: number): string[] {
		const total = this.#entries.length;
		const done = this.#entries.filter(e => e.status !== "pending").length;
		const running = total - done;

		const header = `${theme.fg("toolTitle", theme.bold("Tools"))}${theme.fg("dim", ` (${total})`)} ${SPINNER_MARKER}`;
		const lines = [` ${theme.format.bullet} ${header}`];

		const shown = Math.min(COMPACT_MAX_ROWS, total);
		for (let index = 0; index < shown; index++) {
			const entry = this.#entries[index];
			const isLastShown = index === shown - 1 && shown === total;
			const connector = isLastShown ? theme.tree.last : theme.tree.branch;
			const status = this.#statusSymbol(entry.status);
			const label = theme.fg("toolTitle", entry.label);
			const preview = entry.preview
				? ` ${theme.fg("dim", truncateToWidth(entry.preview, Math.max(8, width - 24)))}`
				: "";
			lines.push(`   ${theme.fg("dim", connector)} ${status} ${label}${preview}`.trimEnd());
		}

		const hiddenCount = total - shown;
		const summary = `${done} done, ${running} running`;
		if (hiddenCount > 0) {
			lines.push(`   ${theme.fg("dim", theme.tree.last)} ${theme.fg("dim", `… ${hiddenCount} more · ${summary}`)}`);
		} else {
			lines.push(`   ${theme.fg("dim", summary)}`);
		}

		return lines;
	}

	#statusSymbol(status: BatchStatus): string {
		if (status === "success") return formatStatusIcon("success", theme);
		if (status === "error") return formatStatusIcon("error", theme);
		return formatStatusIcon("pending", theme);
	}
}
