/**
 * Reaper for ghost tool cells created during a provider stream retry.
 *
 * Pinned scenarios match the visible regression: a partial assistant message
 * carries N toolCall blocks during stream attempt #1, the provider stalls and
 * silently retries the SSE stream (wiping `output.content`), retry emits a
 * fresh set of ids, and the cells from attempt #1 must be removed so the
 * LiveToolBatch panel does not lie about "N running" while only the post-retry
 * subset will ever execute.
 */
import { describe, expect, it } from "bun:test";
import {
	GHOST_REAPER_FINALIZE_TEXT,
	type ReapableComponent,
	type RemovableGroup,
	reapGhostStreamingCells,
} from "../../../src/modes/utils/reap-ghost-streaming-cells";

class RemovableMock implements RemovableGroup {
	removed: string[] = [];
	finalized: { id: string; isError?: boolean }[] = [];
	updateResult(
		result: { content: Array<{ type: string; text?: string }>; isError?: boolean },
		_isPartial = false,
		toolCallId?: string,
	): void {
		this.finalized.push({ id: toolCallId ?? "", isError: result.isError });
	}
	removeCell(id: string): boolean {
		this.removed.push(id);
		return true;
	}
}

class PlainMock implements ReapableComponent {
	finalized: { id: string; text: string; isError?: boolean }[] = [];
	updateResult(
		result: { content: Array<{ type: string; text?: string }>; isError?: boolean },
		_isPartial = false,
		toolCallId?: string,
	): void {
		this.finalized.push({
			id: toolCallId ?? "",
			text: result.content[0]?.text ?? "",
			isError: result.isError,
		});
	}
}

describe("reapGhostStreamingCells", () => {
	it("removes dead ids from a removable group AND clears pendingTools", () => {
		const group = new RemovableMock();
		const pending = new Map<string, ReapableComponent>([
			["a", group],
			["b", group],
			["c", group],
		]);
		const streaming = new Set(["a", "b", "c"]);

		const result = reapGhostStreamingCells(pending, streaming, new Set(), new Set(["b"]));

		// 'a' and 'c' are ghosts; 'b' is still live.
		expect(result.reaped.sort()).toEqual(["a", "c"]);
		expect(result.removed.sort()).toEqual(["a", "c"]);
		expect(result.finalized).toEqual([]);
		expect(pending.has("a")).toBe(false);
		expect(pending.has("b")).toBe(true);
		expect(pending.has("c")).toBe(false);
		expect(streaming.has("a")).toBe(false);
		expect(streaming.has("b")).toBe(true);
		expect(streaming.has("c")).toBe(false);
		expect(group.removed.sort()).toEqual(["a", "c"]);
	});

	it("finalizes ghosts whose host has no remove API", () => {
		const cell = new PlainMock();
		const pending = new Map<string, ReapableComponent>([
			["x", cell],
			["y", cell],
		]);
		const streaming = new Set(["x", "y"]);

		const result = reapGhostStreamingCells(pending, streaming, new Set(), new Set(["y"]));

		expect(result.removed).toEqual([]);
		expect(result.finalized).toEqual(["x"]);
		expect(cell.finalized).toEqual([{ id: "x", text: GHOST_REAPER_FINALIZE_TEXT, isError: true }]);
		expect(pending.has("x")).toBe(false);
		expect(pending.has("y")).toBe(true);
	});

	it("never reaps background-async cells", () => {
		const group = new RemovableMock();
		const pending = new Map<string, ReapableComponent>([
			["bg", group],
			["live", group],
			["ghost", group],
		]);
		const streaming = new Set(["bg", "live", "ghost"]);
		const background = new Set(["bg"]);

		const result = reapGhostStreamingCells(pending, streaming, background, new Set(["live"]));

		expect(result.reaped).toEqual(["ghost"]);
		// 'bg' is removed from `streaming` (it's a dead id by virtue of stream
		// retry) but not detached from pendingTools because background-async
		// cells outlive the stream that created them.
		expect(streaming.has("bg")).toBe(false);
		expect(pending.has("bg")).toBe(true);
		expect(pending.has("live")).toBe(true);
		expect(pending.has("ghost")).toBe(false);
		expect(group.removed).toEqual(["ghost"]);
	});

	it("is a no-op when streamingToolCallIds is empty", () => {
		const group = new RemovableMock();
		const pending = new Map<string, ReapableComponent>([["foo", group]]);
		const result = reapGhostStreamingCells(pending, new Set(), new Set(), new Set());
		expect(result.reaped).toEqual([]);
		expect(pending.has("foo")).toBe(true);
	});

	it("is a no-op when every streaming id is in liveIds", () => {
		const group = new RemovableMock();
		const pending = new Map<string, ReapableComponent>([
			["a", group],
			["b", group],
		]);
		const streaming = new Set(["a", "b"]);
		const result = reapGhostStreamingCells(pending, streaming, new Set(), new Set(["a", "b"]));
		expect(result.reaped).toEqual([]);
		expect(group.removed).toEqual([]);
		expect(streaming).toEqual(new Set(["a", "b"]));
	});

	it("handles the realistic 'two retries' shape: 5 → 7 → 6 ids, only last 6 survive", () => {
		const group = new RemovableMock();
		const pending = new Map<string, ReapableComponent>();
		const streaming = new Set<string>();

		// Attempt 1: 5 cells materialised.
		for (const id of ["a1", "a2", "a3", "a4", "a5"]) {
			pending.set(id, group);
			streaming.add(id);
		}
		// Stream retry. The controller registers new ids on the next partial.
		const liveAfterRetry1 = new Set(["b1", "b2", "b3", "b4", "b5", "b6", "b7"]);
		for (const id of liveAfterRetry1) {
			pending.set(id, group);
			streaming.add(id);
		}
		// Reap a1..a5.
		const r1 = reapGhostStreamingCells(pending, streaming, new Set(), liveAfterRetry1);
		expect(r1.reaped.sort()).toEqual(["a1", "a2", "a3", "a4", "a5"]);
		expect(streaming.size).toBe(7);

		// Another retry. New ids c1..c6.
		const liveAfterRetry2 = new Set(["c1", "c2", "c3", "c4", "c5", "c6"]);
		for (const id of liveAfterRetry2) {
			pending.set(id, group);
			streaming.add(id);
		}
		const r2 = reapGhostStreamingCells(pending, streaming, new Set(), liveAfterRetry2);
		expect(r2.reaped.sort()).toEqual(["b1", "b2", "b3", "b4", "b5", "b6", "b7"]);
		expect(streaming).toEqual(liveAfterRetry2);
		// Only the final 6 ids remain in pendingTools.
		expect([...pending.keys()].sort()).toEqual(["c1", "c2", "c3", "c4", "c5", "c6"]);
	});
});
