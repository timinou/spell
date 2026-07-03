/**
 * resolveWorkspaceByToken tests.
 *
 * The pure core of the session→workspace self-join. Spell stamps its session id
 * into its own window title as `⟨<sessionId>⟩`; niri echoes the title verbatim
 * as `windows[].title`. Given this session's id, the live windows, and the
 * workspaces, return the NAME of the workspace whose window carries the token.
 *
 * This replaces the old process-ancestry/focus resolution, which was ambiguous
 * under a shared terminal server (one pid backing many windows) and raced on
 * focus. Matching on an identity spell OWNS (its own title token) is correct
 * regardless of focus, launch order, or pid sharing.
 *
 * Contracts:
 *  - Finds the window whose title contains the exact token, reads its workspace.
 *  - Ignores focus and other sessions' windows entirely.
 *  - Token absent from all titles → null (not yet propagated / no such window).
 *  - Window found but workspace unnamed or unknown → null.
 *  - Empty session id → null.
 */

import { describe, expect, it } from "bun:test";

import { type NiriWindowInfo, type NiriWorkspaceInfo, resolveWorkspaceByToken } from "../src/niri-query";

describe("resolveWorkspaceByToken", () => {
	const workspaces: NiriWorkspaceInfo[] = [
		{ id: 1, name: "Sales dep", idx: 4 },
		{ id: 2, name: "Spell", idx: 2 },
		{ id: 3, name: null, idx: 9 },
	];

	// Three windows across two workspaces. Only window 13 carries our token; the
	// others belong to different sessions (and one is on the same workspace, to
	// prove we match by token, not by co-location).
	const windows: NiriWindowInfo[] = [
		{ id: 12, title: "other: Something Else ⟨sess-OTHER⟩", workspace_id: 2 },
		{ id: 13, title: "agentmaker: Issue triage ⟨sess-ABC⟩", workspace_id: 1 },
		{ id: 14, title: "verse: 3D Text ⟨sess-XYZ⟩", workspace_id: 1 },
	];

	it("returns the workspace name of the window carrying this session's token", () => {
		expect(resolveWorkspaceByToken("sess-ABC", windows, workspaces)).toBe("Sales dep");
	});

	it("matches by token, not by focus or window order", () => {
		expect(resolveWorkspaceByToken("sess-XYZ", windows, workspaces)).toBe("Sales dep");
		expect(resolveWorkspaceByToken("sess-OTHER", windows, workspaces)).toBe("Spell");
	});

	it("returns null when no window carries the token (not yet propagated)", () => {
		expect(resolveWorkspaceByToken("sess-NOPE", windows, workspaces)).toBeNull();
	});

	it("returns null when the token's workspace has no name", () => {
		const onUnnamed: NiriWindowInfo[] = [{ id: 20, title: "x: y ⟨sess-Q⟩", workspace_id: 3 }];
		expect(resolveWorkspaceByToken("sess-Q", onUnnamed, workspaces)).toBeNull();
	});

	it("returns null when the token's window references an unknown workspace", () => {
		const onGhost: NiriWindowInfo[] = [{ id: 21, title: "x: y ⟨sess-G⟩", workspace_id: 999 }];
		expect(resolveWorkspaceByToken("sess-G", onGhost, workspaces)).toBeNull();
	});

	it("does not partial-match a token that is a substring of another id", () => {
		// "sess-A" must not match the window titled with "sess-ABC" — the
		// delimiters make the match exact.
		expect(resolveWorkspaceByToken("sess-A", windows, workspaces)).toBeNull();
	});

	it("returns null for an empty session id", () => {
		expect(resolveWorkspaceByToken("", windows, workspaces)).toBeNull();
	});

	it("returns null for an empty window list", () => {
		expect(resolveWorkspaceByToken("sess-ABC", [], workspaces)).toBeNull();
	});

	it("tolerates windows with a null title", () => {
		const withNull: NiriWindowInfo[] = [
			{ id: 30, title: null, workspace_id: 1 },
			{ id: 31, title: "hit ⟨sess-N⟩", workspace_id: 2 },
		];
		expect(resolveWorkspaceByToken("sess-N", withNull, workspaces)).toBe("Spell");
	});
});
