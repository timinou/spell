/**
 * MemoryStatusController — surfaces recall-daemon warm-load progress as a
 * status-line hook segment. Polls `executeOrg({command:'recall_stats'})` on
 * a fixed cadence; when the daemon reports `warming`, writes
 * `📚 indexing N/M (phase)` into the status-line under the `memory.indexing`
 * key. Once warm, clears the entry.
 *
 * Lives in core (not as an extension) because daemon warm-load is
 * unconditional infrastructure: every interactive session benefits from
 * the affordance regardless of which extensions are loaded.
 *
 * PLAN-316.
 */

import type { InteractiveModeContext } from "../types";
import { type MemoryProgressSnapshot, peekMemoryProgress } from "../../tools/memory";

/** Hook-status key. Stable so the controller can replace its own entry. */
const STATUS_KEY = "memory.indexing";

/** Poll cadence. 2 s is fast enough to feel live, slow enough that the
 *  daemon stats call (sub-ms) is negligible cost. */
const DEFAULT_INTERVAL_MS = 2_000;

export interface MemoryStatusControllerDeps {
	/** Override the daemon-progress lookup (test seam). */
	peek?: (repoRoot: string) => MemoryProgressSnapshot;
	/** Poll cadence in milliseconds. Default 2000. */
	intervalMs?: number;
	/** Test seam for the timer. */
	setIntervalFn?: typeof setInterval;
	/** Test seam for the timer. */
	clearIntervalFn?: typeof clearInterval;
}

export class MemoryStatusController {
	static readonly STATUS_KEY = STATUS_KEY;
	static readonly DEFAULT_INTERVAL_MS = DEFAULT_INTERVAL_MS;

	readonly #ctx: InteractiveModeContext;
	readonly #peek: (cwd: string) => MemoryProgressSnapshot;
	readonly #intervalMs: number;
	readonly #setIntervalFn: typeof setInterval;
	readonly #clearIntervalFn: typeof clearInterval;

	#timer: ReturnType<typeof setInterval> | undefined;
	/** Last status text we wrote, so we don't spam render requests. */
	#lastStatus: string | undefined;

	constructor(ctx: InteractiveModeContext, deps: MemoryStatusControllerDeps = {}) {
		this.#ctx = ctx;
		this.#peek = deps.peek ?? peekMemoryProgress;
		this.#intervalMs = deps.intervalMs ?? DEFAULT_INTERVAL_MS;
		this.#setIntervalFn = deps.setIntervalFn ?? setInterval;
		this.#clearIntervalFn = deps.clearIntervalFn ?? clearInterval;
	}

	/**
	 * Begin polling. The first poll fires synchronously so warming state
	 * shows up faster than the first interval. Safe to call twice — second
	 * call is a no-op.
	 */
	start(): void {
		if (this.#timer) return;
		this.poll();
		this.#timer = this.#setIntervalFn(() => this.poll(), this.#intervalMs);
	}

	/**
	 * Exposed so tests (and callers that need a deterministic refresh)
	 * can drive the poll without waiting for the interval.
	 */
	poll(): void {
		const cwd = this.#ctx.sessionManager.getCwd();
		const snap = this.#peek(cwd);
		const text = this.#renderText(snap);
		if (text === this.#lastStatus) return;
		this.#lastStatus = text;
		this.#ctx.statusLine.setHookStatus(STATUS_KEY, text);
		this.#ctx.ui.requestRender();
	}

	dispose(): void {
		if (this.#timer) {
			this.#clearIntervalFn(this.#timer);
			this.#timer = undefined;
		}
		if (this.#lastStatus !== undefined) {
			this.#ctx.statusLine.setHookStatus(STATUS_KEY, undefined);
			this.#ctx.ui.requestRender();
			this.#lastStatus = undefined;
		}
	}

	// -----------------------------------------------------------------
	// Internals
	// -----------------------------------------------------------------

	/** `undefined` when the daemon is warm/cold/unavailable/error — i.e.
	 *  nothing useful to show. The widget hides itself in those cases.
	 *  Cold is treated as "no widget" too: a freshly-spawned controller
	 *  might catch the daemon before an open RPC has registered the
	 *  slot, and we'd rather show nothing than a stale "0/0 (cold)". */
	#renderText(snap: MemoryProgressSnapshot): string | undefined {
		if (snap.status !== "warming") return undefined;
		const { done = 0, total = 0, phase = "scan" } = snap.progress ?? {};
		const counts = total > 0 ? `${done}/${total}` : phase;
		return `\uD83D\uDCDA indexing ${counts} (${phase})`;
	}
}
