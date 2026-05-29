/**
 * FEAT-784 — push-subscribe channel to pi-knowledge-worker.
 *
 * Used by MemoryStatusController to receive fast-path notifications when
 * the daemon's warm state changes, instead of waiting for the next poll.
 * Always treated as an *accelerator* on top of polling, never a
 * replacement — `knowledgeSubscribe` throwing (e.g. daemon down) is the
 * silent signal to keep polling.
 */
/**
 * Event payload pushed by the daemon. The full set is declared by the
 * daemon's protocol v2; consumers typically only branch on `.event`.
 *
 * Receivers MAY treat any event as a "kick to re-poll" — the controller
 * does exactly that.
 */
export interface KnowledgeEvent {
    event: "index_changed" | "warm_completed" | "evicted" | "heartbeat" | "lag";
    [key: string]: unknown;
}
declare module "../bindings" {
    interface NativeBindings {
        /**
         * Open a push channel to the daemon. `onEvent` is invoked on the
         * Node main thread for each event frame; the argument is the raw
         * JSON-encoded frame string (the receiver parses what it needs).
         *
         * Throws on daemon unreachable / refused / malformed. Callers
         * MUST treat the throw as the fallback signal (typically: keep
         * polling, no UI noise).
         */
        knowledgeSubscribe(repoHandle: string, lanes: string[], onEvent: (err: Error | null, payload: string) => void): number;
        /**
         * Tear down a subscription opened via `knowledgeSubscribe`.
         * Idempotent — unknown handles are silently ignored.
         */
        knowledgeUnsubscribe(handle: number): void;
    }
}
//# sourceMappingURL=types.d.ts.map