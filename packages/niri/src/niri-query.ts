import { $ } from "bun";
import { readFile } from "node:fs/promises";

export interface NiriWorkspaceInfo {
	id: number;
	name: string | null;
	idx: number;
}

/**
 * Returns the niri window ID of the currently focused window, or null if
 * niri is not running or the query fails.
 */
export async function queryNiriFocusedWindowId(): Promise<number | null> {
	try {
		const result = await $`niri msg -j focused-window`.quiet().nothrow();
		if (result.exitCode !== 0) return null;
		const win = JSON.parse(result.text()) as { id?: unknown };
		return typeof win.id === "number" ? win.id : null;
	} catch {
		return null;
	}
}
/**
 * Reads the parent PID of `pid` from `/proc/<pid>/stat`, or null if it cannot
 * be determined (process gone, non-Linux, or unreadable). The ppid is field 4
 * of the stat line; the comm field (2) may itself contain spaces and
 * parentheses, so we anchor parsing on the final ")" rather than splitting
 * the whole line.
 */
async function readParentPid(pid: number): Promise<number | null> {
	try {
		const stat = await readFile(`/proc/${pid}/stat`, "utf8");
		const rparen = stat.lastIndexOf(")");
		if (rparen === -1) return null;
		// Fields after "(comm)": state ppid pgrp ...  → ppid is index 1 here.
		const rest = stat.slice(rparen + 2).split(" ");
		const ppid = Number(rest[1]);
		return Number.isInteger(ppid) && ppid > 0 ? ppid : null;
	} catch {
		return null;
	}
}

/** Walks the process-ancestor chain of `pid` (inclusive), nearest-first. */
async function processAncestry(pid: number): Promise<number[]> {
	const chain: number[] = [];
	let current: number | null = pid;
	// Bound the walk: PID 1 (init) is the practical ceiling; the guard also
	// protects against a pathological cycle in a doctored /proc.
	for (let i = 0; i < 64 && current !== null && current > 1; i++) {
		chain.push(current);
		current = await readParentPid(current);
	}
	return chain;
}

export interface NiriWindowInfo {
	id: number;
	pid: number;
	is_focused?: boolean;
}

/**
 * Pure core of {@link queryNiriOwnWindowId}: given a process-ancestry chain
 * (nearest-first) and the niri window list, returns the window ID this session
 * owns, or null when no ancestor owns a window.
 *
 * Walks ancestors nearest-first, returning the first that owns exactly one
 * window. When an ancestor owns MULTIPLE windows (one terminal process backing
 * several windows) it disambiguates by focus: the focused candidate if present
 * (the just-launched window is focused at boot), else the first candidate.
 *
 * Exported for unit testing; production callers use {@link queryNiriOwnWindowId}.
 */
export function resolveOwnWindowId(ancestry: readonly number[], windows: readonly NiriWindowInfo[]): number | null {
	// pid → window ids owned by that pid (usually 1, sometimes many).
	const byPid = new Map<number, number[]>();
	for (const w of windows) {
		if (typeof w.id !== "number" || typeof w.pid !== "number") continue;
		const ids = byPid.get(w.pid);
		if (ids) ids.push(w.id);
		else byPid.set(w.pid, [w.id]);
	}
	if (byPid.size === 0) return null;

	for (const ancestor of ancestry) {
		const ids = byPid.get(ancestor);
		if (!ids || ids.length === 0) continue;
		if (ids.length === 1) return ids[0];
		// Multiple windows share this terminal pid → disambiguate by focus.
		const focused = windows.find(w => w.is_focused === true && ids.includes(w.id));
		return focused ? focused.id : ids[0];
	}
	return null;
}

/**
 * Resolves the niri window ID of THIS session's own terminal window.
 *
 * The agent runs as a child of its terminal-emulator process, which is the
 * process niri knows as a window's `pid`. We therefore walk our own ancestry
 * (`process.pid` → parent → …) and return the first ancestor that owns a niri
 * window. This is robust to focus: unlike {@link queryNiriFocusedWindowId} it
 * never mis-attributes the session to whatever window happened to be focused
 * at boot — the historical cause of status files landing on the wrong window.
 *
 * Returns null only when niri is unavailable or our ancestry owns no window at
 * all (then the caller keeps the focused-window fallback path).
 */
export async function queryNiriOwnWindowId(): Promise<number | null> {
	try {
		const result = await $`niri msg -j windows`.quiet().nothrow();
		if (result.exitCode !== 0) return null;
		const raw = JSON.parse(result.text()) as Array<{ id?: unknown; pid?: unknown; is_focused?: unknown }>;
		const windows: NiriWindowInfo[] = [];
		for (const w of raw) {
			if (typeof w.id === "number" && typeof w.pid === "number")
				windows.push({ id: w.id, pid: w.pid, is_focused: w.is_focused === true });
		}
		if (windows.length === 0) return null;
		return resolveOwnWindowId(await processAncestry(process.pid), windows);
	} catch {
		return null;
	}
}
/** Returns the focused workspace metadata, or null when niri is unavailable. */
export async function queryFocusedWorkspace(): Promise<NiriWorkspaceInfo | null> {
	try {
		const [focusedWindowResult, workspacesResult] = await Promise.all([
			$`niri msg -j focused-window`.quiet().nothrow(),
			$`niri msg -j workspaces`.quiet().nothrow(),
		]);
		if (focusedWindowResult.exitCode !== 0 || workspacesResult.exitCode !== 0) return null;
		const focusedWindow = JSON.parse(focusedWindowResult.text()) as { workspace_id?: unknown };
		const workspaces = JSON.parse(workspacesResult.text()) as Array<NiriWorkspaceInfo>;
		const workspaceId = focusedWindow.workspace_id;
		if (typeof workspaceId !== "number") return null;
		const workspace = workspaces.find(entry => entry.id === workspaceId);
		return workspace ?? null;
	} catch {
		return null;
	}
}
