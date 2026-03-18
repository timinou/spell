import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
export class TempDir {
    #path;
    constructor(path) {
        this.#path = path;
    }
    static createSync(prefix) {
        return new TempDir(fs.mkdtempSync(normalizePrefix(prefix)));
    }
    static async create(prefix) {
        return new TempDir(await fs.promises.mkdtemp(normalizePrefix(prefix)));
    }
    #removePromise = null;
    path() {
        return this.#path;
    }
    absolute() {
        return path.resolve(this.#path);
    }
    remove() {
        if (this.#removePromise) {
            return this.#removePromise;
        }
        const removePromise = fs.promises.rm(this.#path, { recursive: true, force: true });
        this.#removePromise = removePromise;
        return removePromise;
    }
    removeSync() {
        fs.rmSync(this.#path, { recursive: true, force: true });
        this.#removePromise = Promise.resolve();
    }
    toString() {
        return this.#path;
    }
    join(...paths) {
        return path.join(this.#path, ...paths);
    }
    async [Symbol.asyncDispose]() {
        try {
            await this.remove();
        }
        catch {
            // Ignore cleanup errors
        }
    }
    [Symbol.dispose]() {
        try {
            this.removeSync();
        }
        catch {
            // Ignore cleanup errors
        }
    }
}
const kTempDir = os.tmpdir();
function normalizePrefix(prefix) {
    if (!prefix) {
        return `${kTempDir}${path.sep}pi-temp-`;
    }
    else if (prefix.startsWith("@")) {
        return path.join(kTempDir, prefix.slice(1));
    }
    return prefix;
}
//# sourceMappingURL=temp.js.map