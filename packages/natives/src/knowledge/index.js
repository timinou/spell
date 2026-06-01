import { native } from "../native";
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
export function subscribeKnowledge(repoHandle, lanes, onEvent) {
    let handle;
    try {
        handle = native.knowledgeSubscribe(repoHandle, lanes, (err, payload) => {
            if (err)
                return;
            try {
                const parsed = JSON.parse(payload);
                if (parsed && typeof parsed === "object" && typeof parsed.event === "string") {
                    onEvent(parsed);
                }
            }
            catch {
                // Malformed frame — drop silently.
            }
        });
    }
    catch (err) {
        return {
            unsubscribe: () => { },
            error: err instanceof Error ? err : new Error(String(err)),
        };
    }
    let disposed = false;
    return {
        unsubscribe: () => {
            if (disposed)
                return;
            disposed = true;
            native.knowledgeUnsubscribe(handle);
        },
        error: null,
    };
}
//# sourceMappingURL=index.js.map