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

import { type KnowledgeEvent, repoHandle, subscribeKnowledge } from "@oh-my-pi/pi-natives";

import type { InteractiveModeContext } from "../types";
import { type MemoryProgressSnapshot, peekMemoryProgress } from "../../tools/memory";

/** Hook-status key. Stable so the controller can replace its own entry. */
const STATUS_KEY = "memory.indexing";

/** Poll cadence. 2 s is fast enough to feel live, slow enough that the
 *  daemon stats call (sub-ms) is negligible cost. */
const DEFAULT_INTERVAL_MS = 2_000;

export interface MemoryStatusControllerDeps {
	/** Override the daemon-progress lookup (test seam). Always async
	 *  post-FEAT-780; tests may return a resolved Promise. */
	peek?: (repoRoot: string) => Promise<MemoryProgressSnapshot>;
	/** Poll cadence in milliseconds. Default 2000. */
	intervalMs?: number;
	/** Test seam for the timer. */
	setIntervalFn?: typeof setInterval;
	/** Test seam for the timer. */
	clearIntervalFn?: typeof clearInterval;
	/** FEAT-784: override the push-subscribe wiring (test seam). When
	 *  omitted, the controller uses the real knowledge daemon. Return
	 *  `{ unsubscribe, error: null }` to simulate success; any non-null
	 *  error means "daemon unavailable, polling-only". */
	subscribe?: (
		repoHandle: string,
		lanes: string[],
		onEvent: (event: KnowledgeEvent) => void,
	) => { unsubscribe: () => void; error: Error | null };
}

export class MemoryStatusController {
	static readonly STATUS_KEY = STATUS_KEY;
	static readonly DEFAULT_INTERVAL_MS = DEFAULT_INTERVAL_MS;

	readonly #ctx: InteractiveModeContext;
	readonly #peek: (cwd: string) => Promise<MemoryProgressSnapshot>;
	readonly #intervalMs: number;
	readonly #setIntervalFn: typeof setInterval;
	readonly #clearIntervalFn: typeof clearInterval;
	readonly #subscribe: NonNullable<MemoryStatusControllerDeps["subscribe"]>;

	#timer: ReturnType<typeof setInterval> | undefined;
	/** Last status text we wrote, so we don't spam render requests. */
	#lastStatus: string | undefined;
	/** FEAT-780: a poll is in flight. Prevents pile-up if `peek` ever
	 *  takes longer than `intervalMs` to resolve. Net effect: we skip
	 *  ticks rather than queue them. */
	#inFlight: boolean = false;
	/** FEAT-784: push-subscribe handle. `undefined` means subscribe
	 *  failed (daemon down) or controller is stopped. */
	#subscription: { unsubscribe: () => void } | undefined;

	constructor(ctx: InteractiveModeContext, deps: MemoryStatusControllerDeps = {}) {
		this.#ctx = ctx;
		this.#peek = deps.peek ?? peekMemoryProgress;
		this.#intervalMs = deps.intervalMs ?? DEFAULT_INTERVAL_MS;
		this.#setIntervalFn = deps.setIntervalFn ?? setInterval;
		this.#clearIntervalFn = deps.clearIntervalFn ?? clearInterval;
		this.#subscribe = deps.subscribe ?? subscribeKnowledge;
	}

	/**
	 * Begin polling. The first poll fires synchronously so warming state
	 * shows up faster than the first interval. Safe to call twice — second
	 * call is a no-op.
	 */
	start(): void {
		if (this.#timer) return;
		// Fire-and-forget: the initial poll resolves asynchronously now
		// that `peek` is async. setInterval can't await, so wrap with
		// `void` to make the discard explicit.
		void this.poll();
		this.#timer = this.#setIntervalFn(() => {
			void this.poll();
		}, this.#intervalMs);
		// FEAT-784: open the push channel. On any event (warm_completed,
		// index_changed, evicted, lag) just kick a poll. The poll is
		// idempotent + #inFlight-guarded, so the worst case is one
		// re-render. On subscribe failure, fall back silently to polling.
		const cwd = this.#ctx.sessionManager.getCwd();
		const sub = this.#subscribe(repoHandle(cwd), ["org_memory"], () => {
			void this.poll();
		});
		if (sub.error === null) {
			this.#subscription = sub;
		}
	}

	/**
	 * Exposed so tests (and callers that need a deterministic refresh)
	 * can drive the poll without waiting for the interval.
	 *
	 * FEAT-780: async now that `peek` is async (executeOrg cutover).
	 * Guarded by #inFlight so concurrent polls drop on the floor rather
	 * than queuing.
	 */
	async poll(): Promise<void> {
		if (this.#inFlight) return;
		this.#inFlight = true;
		try {
			const cwd = this.#ctx.sessionManager.getCwd();
			const snap = await this.#peek(cwd);
			const text = this.#renderText(snap);
			if (text === this.#lastStatus) return;
			this.#lastStatus = text;
			this.#ctx.statusLine.setHookStatus(STATUS_KEY, text);
			this.#ctx.ui.requestRender();
		} finally {
			this.#inFlight = false;
		}
	}

	dispose(): void {
		if (this.#timer) {
			this.#clearIntervalFn(this.#timer);
			this.#timer = undefined;
		}
		if (this.#subscription) {
			this.#subscription.unsubscribe();
			this.#subscription = undefined;
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
