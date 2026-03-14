import { $ } from "bun";

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
