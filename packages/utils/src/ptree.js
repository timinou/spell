var __addDisposableResource = (this && this.__addDisposableResource) || function (env, value, async) {
    if (value !== null && value !== void 0) {
        if (typeof value !== "object" && typeof value !== "function") throw new TypeError("Object expected.");
        var dispose, inner;
        if (async) {
            if (!Symbol.asyncDispose) throw new TypeError("Symbol.asyncDispose is not defined.");
            dispose = value[Symbol.asyncDispose];
        }
        if (dispose === void 0) {
            if (!Symbol.dispose) throw new TypeError("Symbol.dispose is not defined.");
            dispose = value[Symbol.dispose];
            if (async) inner = dispose;
        }
        if (typeof dispose !== "function") throw new TypeError("Object not disposable.");
        if (inner) dispose = function() { try { inner.call(this); } catch (e) { return Promise.reject(e); } };
        env.stack.push({ value: value, dispose: dispose, async: async });
    }
    else if (async) {
        env.stack.push({ async: true });
    }
    return value;
};
var __disposeResources = (this && this.__disposeResources) || (function (SuppressedError) {
    return function (env) {
        function fail(e) {
            env.error = env.hasError ? new SuppressedError(e, env.error, "An error was suppressed during disposal.") : e;
            env.hasError = true;
        }
        var r, s = 0;
        function next() {
            while (r = env.stack.pop()) {
                try {
                    if (!r.async && s === 1) return s = 0, env.stack.push(r), Promise.resolve().then(next);
                    if (r.dispose) {
                        var result = r.dispose.call(r.value);
                        if (r.async) return s |= 2, Promise.resolve(result).then(next, function(e) { fail(e); return next(); });
                    }
                    else s |= 1;
                }
                catch (e) {
                    fail(e);
                }
            }
            if (s === 1) return env.hasError ? Promise.reject(env.error) : Promise.resolve();
            if (env.hasError) throw env.error;
        }
        return next();
    };
})(typeof SuppressedError === "function" ? SuppressedError : function (error, suppressed, message) {
    var e = new Error(message);
    return e.name = "SuppressedError", e.error = error, e.suppressed = suppressed, e;
});
import { terminate } from "./procmgr";
// ── Exceptions ───────────────────────────────────────────────────────────────
/**
 * Base for all exceptions representing child process nonzero exit, killed, or
 * cancellation.
 */
export class Exception extends Error {
    constructor(message, exitCode, stderr) {
        super(message);
        this.exitCode = exitCode;
        this.stderr = stderr;
        this.name = this.constructor.name;
    }
}
/** Exception for nonzero exit codes (not cancellation). */
export class NonZeroExitError extends Exception {
    static { this.MAX_TRACE = 32 * 1024; }
    constructor(exitCode, stderr) {
        super(`Process exited with code ${exitCode}:\n${stderr}`, exitCode, stderr);
    }
    get aborted() {
        return false;
    }
}
/** Exception for explicit process abortion (via signal). */
export class AbortError extends Exception {
    constructor(reason, stderr) {
        const msg = reason instanceof Error ? reason.message : String(reason ?? "aborted");
        super(`Operation cancelled: ${msg}`, -1, stderr);
        this.reason = reason;
    }
    get aborted() {
        return true;
    }
}
/** Exception for process timeout. */
export class TimeoutError extends AbortError {
    constructor(timeout, stderr) {
        super(new Error(`Timed out after ${Math.round(timeout / 1000)}s`), stderr);
    }
}
// ── ChildProcess ─────────────────────────────────────────────────────────────
/**
 * ChildProcess wraps a managed subprocess, capturing stderr tail, providing
 * cross-platform kill/detach logic plus AbortSignal integration.
 *
 * Stdout is exposed directly from the underlying Bun subprocess; consumers
 * must read it (via text(), wait(), etc.) to prevent pipe deadlock.
 * Stderr is eagerly drained into an internal buffer.
 */
export class ChildProcess {
    #nothrow = false;
    #stderrTail = "";
    #stderrChunks = [];
    #exitReason;
    #exitReasonPending;
    #stderrDone;
    #exited;
    #stderrStream;
    constructor(proc, exposeStderr) {
        this.proc = proc;
        this.exposeStderr = exposeStderr;
        // Eagerly drain stderr into a truncated tail string + raw chunks.
        const dec = new TextDecoder();
        const trim = () => {
            if (this.#stderrTail.length > NonZeroExitError.MAX_TRACE)
                this.#stderrTail = this.#stderrTail.slice(-NonZeroExitError.MAX_TRACE);
        };
        let stderrStream = proc.stderr;
        if (exposeStderr) {
            const [teeStream, drainStream] = stderrStream.tee();
            this.#stderrStream = teeStream;
            stderrStream = drainStream;
        }
        this.#stderrDone = (async () => {
            try {
                for await (const chunk of stderrStream) {
                    this.#stderrChunks.push(chunk);
                    this.#stderrTail += dec.decode(chunk, { stream: true });
                    trim();
                }
            }
            catch { }
            this.#stderrTail += dec.decode();
            trim();
        })();
        // Normalize Bun's exited promise into our exitReason / exitedCleanly model.
        const { promise, resolve, reject } = Promise.withResolvers();
        this.#exited = promise;
        proc.exited
            .catch(() => null)
            .then(async (exitCode) => {
            if (this.#exitReasonPending) {
                this.#exitReason = this.#exitReasonPending;
                reject(this.#exitReasonPending);
                return;
            }
            if (exitCode === 0) {
                resolve(0);
                return;
            }
            await this.#stderrDone;
            if (exitCode !== null) {
                this.#exitReason = new NonZeroExitError(exitCode, this.#stderrTail);
                resolve(exitCode);
                return;
            }
            const ex = this.proc.killed
                ? new AbortError(new Error("process killed"), this.#stderrTail)
                : new NonZeroExitError(-1, this.#stderrTail);
            this.#exitReason = ex;
            reject(ex);
        });
    }
    // ── Properties ───────────────────────────────────────────────────────
    get pid() {
        return this.proc.pid;
    }
    get exited() {
        return this.#exited;
    }
    get exitCode() {
        return this.proc.exitCode;
    }
    get exitReason() {
        return this.#exitReason;
    }
    get killed() {
        return this.proc.killed;
    }
    get stdin() {
        return this.proc.stdin;
    }
    /** Raw stdout stream. Must be consumed to prevent pipe deadlock. */
    get stdout() {
        return this.proc.stdout;
    }
    /** Optional stderr stream (only when requested in spawn options). */
    get stderr() {
        return this.#stderrStream;
    }
    get exitedCleanly() {
        if (this.#nothrow)
            return this.#exited;
        return this.#exited.then(code => {
            if (code !== 0)
                throw new NonZeroExitError(code, this.#stderrTail);
            return code;
        });
    }
    /** Returns the truncated stderr tail (last 32KB). */
    peekStderr() {
        return this.#stderrTail;
    }
    nothrow() {
        this.#nothrow = true;
        return this;
    }
    kill(reason) {
        if (reason && !this.#exitReasonPending)
            this.#exitReasonPending = reason;
        if (!this.proc.killed)
            void terminate({ target: this.proc });
    }
    // ── Output helpers ───────────────────────────────────────────────────
    async text() {
        const p = new Response(this.stdout).text();
        if (this.#nothrow)
            return p;
        const [text] = await Promise.all([p, this.exitedCleanly]);
        return text;
    }
    async blob() {
        const p = new Response(this.stdout).blob();
        if (this.#nothrow)
            return p;
        const [blob] = await Promise.all([p, this.exitedCleanly]);
        return blob;
    }
    async json() {
        return new Response(this.stdout).json();
    }
    async arrayBuffer() {
        return new Response(this.stdout).arrayBuffer();
    }
    async bytes() {
        return new Response(this.stdout).bytes();
    }
    // ── Wait ─────────────────────────────────────────────────────────────
    async wait(opts) {
        const { allowNonZero = false, allowAbort = false, stderr: stderrMode = "buffer" } = opts ?? {};
        const stdoutP = new Response(this.stdout).text();
        const stderrP = stderrMode === "full"
            ? this.#stderrDone.then(() => new TextDecoder().decode(Buffer.concat(this.#stderrChunks)))
            : this.#stderrDone.then(() => this.#stderrTail);
        const [stdout, stderr] = await Promise.all([stdoutP, stderrP]);
        let exitError;
        try {
            await this.#exited;
        }
        catch (err) {
            if (err instanceof Exception)
                exitError = err;
            else
                throw err;
        }
        if (!exitError)
            exitError = this.exitReason;
        if (!exitError && this.exitCode !== null && this.exitCode !== 0) {
            exitError = new NonZeroExitError(this.exitCode, this.#stderrTail);
        }
        const exitCode = this.exitCode ?? (exitError && !exitError.aborted ? exitError.exitCode : null);
        const ok = exitCode === 0;
        if (exitError) {
            if ((exitError.aborted && !allowAbort) || (!exitError.aborted && !allowNonZero))
                throw exitError;
        }
        return { stdout, stderr, exitCode, ok, exitError };
    }
    // ── Signal / timeout ─────────────────────────────────────────────────
    attachSignal(signal) {
        const onAbort = () => this.kill(new AbortError(signal.reason, "<cancelled>"));
        if (signal.aborted)
            return void onAbort();
        signal.addEventListener("abort", onAbort, { once: true });
        this.#exited.catch(() => { }).finally(() => signal.removeEventListener("abort", onAbort));
    }
    attachTimeout(ms) {
        if (ms <= 0 || this.proc.killed)
            return;
        Promise.race([
            Bun.sleep(ms).then(() => true),
            this.proc.exited.then(() => false, () => false),
        ]).then(timedOut => {
            if (timedOut)
                this.kill(new TimeoutError(ms, this.#stderrTail));
        });
    }
    [Symbol.dispose]() {
        if (this.proc.exitCode !== null)
            return;
        this.kill(new AbortError("process disposed", this.#stderrTail));
    }
}
/** Spawn a child process with piped stdout/stderr. */
export function spawn(cmd, opts) {
    const { timeout = -1, signal, stderr, ...rest } = opts ?? {};
    const child = Bun.spawn(cmd, {
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
        windowsHide: true,
        ...rest,
    });
    const cp = new ChildProcess(child, stderr === "full");
    if (signal)
        cp.attachSignal(signal);
    if (timeout > 0)
        cp.attachTimeout(timeout);
    return cp;
}
/** Spawn, wait, and return captured output. */
export async function exec(cmd, opts) {
    const env_1 = { stack: [], error: void 0, hasError: false };
    try {
        const { input, stderr, allowAbort, allowNonZero, ...spawnOpts } = opts ?? {};
        const stdin = typeof input === "string" ? Buffer.from(input) : input;
        const resolved = stdin === undefined ? spawnOpts : { ...spawnOpts, stdin };
        const child = __addDisposableResource(env_1, spawn(cmd, resolved), false);
        return await child.wait({ stderr, allowAbort, allowNonZero });
    }
    catch (e_1) {
        env_1.error = e_1;
        env_1.hasError = true;
    }
    finally {
        __disposeResources(env_1);
    }
}
/** Combine AbortSignals and timeout values into a single signal. */
export function combineSignals(...signals) {
    let timeout;
    let n = 0;
    for (let i = 0; i < signals.length; i++) {
        const s = signals[i];
        if (s instanceof AbortSignal) {
            if (s.aborted)
                return s;
            if (i !== n)
                signals[n] = s;
            n++;
        }
        else if (typeof s === "number" && s > 0) {
            timeout = timeout === undefined ? s : Math.min(timeout, s);
        }
    }
    if (timeout !== undefined) {
        signals[n] = AbortSignal.timeout(timeout);
        n++;
    }
    switch (n) {
        case 0:
            return undefined;
        case 1:
            return signals[0];
        default:
            return AbortSignal.any(signals.slice(0, n));
    }
}
//# sourceMappingURL=ptree.js.map