import { native } from "../native";
/**
 * FEAT-780: returns a Promise so the Node event loop stays free during
 * long daemon calls (recall, query, remember). Callers MUST `await`.
 *
 * `signal` is an optional `AbortSignal` propagated to the libuv worker.
 * Cancellation aborts the JS-side await; the daemon-side work may keep
 * running and finish on its own.
 */
export function executeOrg(options, signal) {
    return native.executeOrg(options, signal);
}
//# sourceMappingURL=index.js.map