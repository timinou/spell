/**
 * Internal URL router for internal protocols (agent://, artifact://, memory://, skill://, rule://, mcp://, pi://, local://).
 *
 * PLAN-310 cutover note: this router is being phased out. Schemes listed in
 * `KERNEL_OWNED_SCHEMES` short-circuit `resolve()` with `RouterDelegateToKernel`,
 * which callers (get.ts:tryResolveViaInternalRouter) treat as "fall through to
 * `executeCodePath`". The set grows one scheme per cutover commit until all
 * registered schemes are kernel-owned, at which point the entire router is
 * deleted (Phase 4).
 */
import type { InternalResource, InternalUrl, ProtocolHandler } from "./types";

/**
 * Schemes whose resolution has been migrated to the kernel SchemeRegistry.
 * `InternalUrlRouter.resolve()` throws `RouterDelegateToKernel` for any URL
 * with a scheme in this set; callers must catch and fall through to the
 * kernel via `executeCodePath`.
 *
 * Order of entry mirrors PLAN-310 cutover order: simplest schemes first.
 */
export const KERNEL_OWNED_SCHEMES: ReadonlySet<string> = new Set<string>([
	// PLAN-310 Phase 2 cutover order — simplest schemes first.
	"pi",     // embedded markdown docs (Static loader)
	"memory", // .spell/memory/[root|<path>] (Namespaced layout, fs-backed)
	"local",  // <session_dir>/local/<path> (Direct layout, fs-backed, write-path note)
	"org",    // <project>/!tasks/* + <home>/.org/* via MultiRootIndex (Indexed layout)
	"agent",  // <session_dir>/<id>.md (NamedFile, fs-backed); path-form rewrites to #json:
	"rule",   // BUG-393: dynamic callback bridges to session.rules in-memory aggregate
	"skill",  // BUG-394: dynamic callback bridges to session.skills + sub-path fs read
	"jobs",     // BUG-395: dynamic callback bridges to AsyncJobManager state
	"artifact", // BUG-396: declarative Indexed loader (UserRoot + cross-session scan)
]);

/**
 * Sentinel exception thrown by `InternalUrlRouter.resolve()` when the URL's
 * scheme is in `KERNEL_OWNED_SCHEMES`. Callers catch this to delegate to the
 * kernel without raising a user-facing error.
 */
export class RouterDelegateToKernel extends Error {
	constructor(public readonly scheme: string) {
		super(`scheme '${scheme}' delegated to kernel SchemeRegistry`);
		this.name = "RouterDelegateToKernel";
	}
}

/**
 * Router for internal URL schemes.
 *
 * Dispatches URLs like `agent://output_id` or `memory://root/memory_summary.md` to
 * registered protocol handlers.
 */
export class InternalUrlRouter {
	#handlers = new Map<string, ProtocolHandler>();

	/**
	 * Register a protocol handler.
	 * @param handler Handler to register (uses handler.scheme as key)
	 */
	register(handler: ProtocolHandler): void {
		this.#handlers.set(handler.scheme, handler);
	}

	/**
	 * Check if the router can handle a URL.
	 * @param input URL string to check
	 */
	canHandle(input: string): boolean {
		const match = input.match(/^([a-z][a-z0-9+.-]*):\/\//i);
		if (!match) return false;
		const scheme = match[1].toLowerCase();
		return this.#handlers.has(scheme);
	}

	/**
	 * Resolve an internal URL to its content.
	 * @param input URL string (e.g., "agent://reviewer_0", "skill://notion-pages")
	 * @throws Error if scheme is not registered or resolution fails
	 */
	async resolve(input: string): Promise<InternalResource> {
		// PLAN-310 cutover: schemes migrated to kernel signal delegation via sentinel.
		const schemeMatch = input.match(/^([a-z][a-z0-9+.-]*):\/\//i);
		if (schemeMatch && KERNEL_OWNED_SCHEMES.has(schemeMatch[1].toLowerCase())) {
			throw new RouterDelegateToKernel(schemeMatch[1].toLowerCase());
		}

		let parsed: URL;
		try {
			parsed = new URL(input);
		} catch {
			throw new Error(`Invalid URL: ${input}`);
		}

		const hostMatch = input.match(/^([a-z][a-z0-9+.-]*):\/\/([^/?#]*)/i);
		let rawHost = hostMatch ? hostMatch[2] : parsed.hostname;
		try {
			rawHost = decodeURIComponent(rawHost);
		} catch {
			// Leave rawHost as-is if decoding fails.
		}
		(parsed as InternalUrl).rawHost = rawHost;
		const pathMatch = input.match(/^[a-z][a-z0-9+.-]*:\/\/[^/?#]*(\/[^?#]*)?/i);
		(parsed as InternalUrl).rawPathname = pathMatch?.[1] ?? parsed.pathname;

		const scheme = parsed.protocol.replace(/:$/, "").toLowerCase();
		const handler = this.#handlers.get(scheme);

		if (!handler) {
			const available = Array.from(this.#handlers.keys())
				.map(s => `${s}://`)
				.join(", ");
			throw new Error(`Unknown protocol: ${scheme}://\nSupported: ${available || "none"}`);
		}

		return handler.resolve(parsed as InternalUrl);
	}
}
