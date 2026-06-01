/**
 * FEAT-784 — push-subscribe channel to pi-knowledge-worker.
 *
 * Used by MemoryStatusController to receive fast-path notifications when
 * the daemon's warm state changes, instead of waiting for the next poll.
 * Always treated as an *accelerator* on top of polling, never a
 * replacement — `knowledgeSubscribe` throwing (e.g. daemon down) is the
 * silent signal to keep polling.
 */
export {};
//# sourceMappingURL=types.js.map