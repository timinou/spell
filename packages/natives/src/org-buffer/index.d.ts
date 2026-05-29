import type { OrgBufferOptions, OrgBufferResult } from "./types";
export type { OrgBufferOptions, OrgBufferResult } from "./types";
/**
 * FEAT-780: returns a Promise so the Node event loop stays free during
 * long daemon calls (recall, query, remember). Callers MUST `await`.
 *
 * `signal` is an optional `AbortSignal` propagated to the libuv worker.
 * Cancellation aborts the JS-side await; the daemon-side work may keep
 * running and finish on its own.
 */
export declare function executeOrg(options: OrgBufferOptions, signal?: AbortSignal): Promise<OrgBufferResult>;
//# sourceMappingURL=index.d.ts.map