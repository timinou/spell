/**
 * Shared path-traversal defense used by URI handlers that map a URL path
 * segment into a filesystem subpath. Mirrors the kernel's path_starts_with
 * check in crates/pi-code-path/src/scheme_dispatch.rs.
 *
 * Extracted from the now-deleted skill-protocol.ts so canvas/local/memory
 * handlers (still JS-routed pending future cutover) can keep using it.
 *
 * Optional `scheme` arg keeps the original error message format
 * ("Path traversal (..) is not allowed in <scheme>:// URLs") so existing
 * test assertions and user-facing diagnostics stay stable.
 */
import * as path from "node:path";

export function validateRelativePath(relativePath: string, scheme = "skill"): void {
	if (path.isAbsolute(relativePath)) {
		throw new Error(`Absolute paths are not allowed in ${scheme}:// URLs`);
	}

	const normalized = path.normalize(relativePath);
	if (normalized.startsWith("..") || normalized.includes("/../") || normalized.includes("/..")) {
		throw new Error(`Path traversal (..) is not allowed in ${scheme}:// URLs`);
	}
}
