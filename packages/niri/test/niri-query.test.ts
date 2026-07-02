/**
 * resolveOwnWindowId tests.
 *
 * The pure core of window-identity resolution: given this session's
 * process-ancestry chain (nearest-first) and the niri window list, return the
 * window ID the session owns. This is the fix for status files landing on the
 * wrong niri window — historically the id was taken from whatever window was
 * FOCUSED at boot, which races across concurrently-launched sessions.
 *
 * Contracts:
 *  - Picks the ancestor that owns a window, ignoring focus.
 *  - Walks nearest-first: the closest owning ancestor wins.
 *  - Multiple windows per terminal pid → disambiguate by focus, else first.
 *  - No owning ancestor → null (caller keeps the focused-window fallback).
 */

import { describe, expect, it } from "bun:test";

import { type NiriWindowInfo, resolveOwnWindowId } from "../src/niri-query";

describe("resolveOwnWindowId", () => {
	// A realistic tree: agent (pid 500) → terminal (pid 200) → niri window 17.
	// Window 42 is focused and owned by a DIFFERENT terminal (pid 999); the old
	// focus-based logic would wrongly return 42.
	const windows: NiriWindowInfo[] = [
		{ id: 42, pid: 999, is_focused: true },
		{ id: 17, pid: 200, is_focused: false },
		{ id: 9, pid: 300, is_focused: false },
	];

	it("returns the window owned by an ancestor, ignoring the focused window", () => {
		const ancestry = [500, 200, 100, 1]; // agent → terminal(200) → shell → init
		expect(resolveOwnWindowId(ancestry, windows)).toBe(17);
	});

	it("does not fall for the focused window when it belongs to another process", () => {
		// Ancestry never includes pid 999, so focused window 42 must be ignored.
		const ancestry = [501, 300];
		expect(resolveOwnWindowId(ancestry, windows)).toBe(9);
	});

	it("walks nearest-first: the closest owning ancestor wins", () => {
		// Both pid 200 (win 17) and pid 300 (win 9) are ancestors; 200 is nearer.
		const ancestry = [500, 200, 300, 1];
		expect(resolveOwnWindowId(ancestry, windows)).toBe(17);
	});

	it("returns null when no ancestor owns a window", () => {
		const ancestry = [500, 400, 100, 1];
		expect(resolveOwnWindowId(ancestry, windows)).toBeNull();
	});

	it("returns null for an empty window list", () => {
		expect(resolveOwnWindowId([500, 200], [])).toBeNull();
	});

	describe("one terminal process backing multiple windows", () => {
		// e.g. a single ghostty instance (pid 200) hosting three niri windows.
		const shared: NiriWindowInfo[] = [
			{ id: 10, pid: 200, is_focused: false },
			{ id: 11, pid: 200, is_focused: true },
			{ id: 12, pid: 200, is_focused: false },
		];

		it("disambiguates by focus (the just-launched window is focused at boot)", () => {
			expect(resolveOwnWindowId([500, 200], shared)).toBe(11);
		});

		it("falls back to the first candidate when none is focused", () => {
			const none = shared.map(w => ({ ...w, is_focused: false }));
			expect(resolveOwnWindowId([500, 200], none)).toBe(10);
		});
	});
});
