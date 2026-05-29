import type { KnowledgeEvent } from "./types";
export type { KnowledgeEvent } from "./types";
export { repoHandle } from "./handle";
/**
 * Subscribe to push events from the knowledge daemon. The returned
 * handle's `unsubscribe()` MUST be called when done (typically in the
 * controller's `dispose()`).
 *
 * Errors during subscribe are surfaced via the returned object's
 * `error` field. Callers MUST treat `error !== null` as the
 * fall-back-to-polling signal; this function never throws.
 *
 * `onEvent` is invoked on the Node main thread for each event frame.
 * The argument is the parsed event object; malformed frames are
 * silently dropped.
 */
export declare function subscribeKnowledge(repoHandle: string, lanes: string[], onEvent: (event: KnowledgeEvent) => void): {
    unsubscribe: () => void;
    error: Error | null;
};
//# sourceMappingURL=index.d.ts.map