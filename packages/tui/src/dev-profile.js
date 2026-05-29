/**
 * FEAT-758 — opt-in TUI render profiling.
 *
 * Enable by setting `PI_TUI_PROFILE=1`. When enabled, every frame appends a
 * JSONL record to `PI_TUI_PROFILE_PATH` (default
 * `/tmp/spell-tui-profile-<pid>.jsonl`) so we can lock in the wins from
 * FEAT-761/762/763/759 with post-hoc analysis.
 *
 * Disabled = zero cost: `recordFrame` returns on the first guard.
 */
import fs from "node:fs";
import process from "node:process";
class DevProfileImpl {
    static { this.enabled = process.env.PI_TUI_PROFILE === "1"; }
    #path;
    #stream;
    #lastHeap = 0;
    #frameCount = 0;
    constructor() {
        this.#path = process.env.PI_TUI_PROFILE_PATH || `/tmp/spell-tui-profile-${process.pid}.jsonl`;
    }
    get path() {
        return this.#path;
    }
    #ensureOpen() {
        if (this.#stream)
            return;
        try {
            this.#stream = fs.createWriteStream(this.#path, { flags: "a" });
            // Don't keep event loop alive just because we're profiling.
            this.#stream.on("error", () => {
                this.#stream = undefined;
            });
        }
        catch {
            /* swallow — don't break the TUI for profiling errors */
        }
    }
    recordFrame(info) {
        if (!DevProfileImpl.enabled)
            return;
        this.#ensureOpen();
        let heap = 0;
        try {
            const bunGc = globalThis.Bun?.gc;
            heap = bunGc ? bunGc(false) : process.memoryUsage().heapUsed;
        }
        catch {
            heap = process.memoryUsage().heapUsed;
        }
        const record = {
            t: Date.now(),
            frame: ++this.#frameCount,
            frameMs: info.frameMs,
            dirtyCount: info.dirtyCount,
            linesChanged: info.linesChanged,
            allocDelta: this.#frameCount === 1 ? 0 : heap - this.#lastHeap,
            heap,
        };
        this.#lastHeap = heap;
        this.#stream?.write(`${JSON.stringify(record)}\n`);
    }
    close() {
        this.#stream?.end();
        this.#stream = undefined;
    }
}
export const devProfile = new DevProfileImpl();
export const DevProfile = DevProfileImpl;
//# sourceMappingURL=dev-profile.js.map