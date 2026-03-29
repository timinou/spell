import { matchesKey } from "../keys";
import { Loader } from "./loader";
/**
 * Loader that can be cancelled with Escape.
 * Extends Loader with an AbortSignal for cancelling async operations.
 *
 * @example
 * const loader = new CancellableLoader(tui, cyan, dim, "Working...");
 * loader.onAbort = () => done(null);
 * doWork(loader.signal).then(done);
 */
export class CancellableLoader extends Loader {
    #abortController = new AbortController();
    /** AbortSignal that is aborted when user presses Escape */
    get signal() {
        return this.#abortController.signal;
    }
    /** Whether the loader was aborted */
    get aborted() {
        return this.#abortController.signal.aborted;
    }
    handleInput(data) {
        if (matchesKey(data, "escape") || matchesKey(data, "esc")) {
            this.#abortController.abort();
            this.onAbort?.();
        }
    }
    dispose() {
        this.stop();
    }
}
//# sourceMappingURL=cancellable-loader.js.map