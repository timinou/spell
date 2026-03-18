import * as fs from "node:fs";
import path from "node:path";
import * as timers from "node:timers";
import { $env } from "./env";
let cachedShellConfig = null;
const IS_WINDOWS = process.platform === "win32";
const TERM_SIGNAL = IS_WINDOWS ? undefined : "SIGTERM";
/**
 * Check if a shell binary is executable.
 */
function isExecutable(path) {
    try {
        fs.accessSync(path, fs.constants.X_OK);
        return true;
    }
    catch {
        return false;
    }
}
/**
 * Build the spawn environment (cached).
 */
function buildSpawnEnv(shell) {
    const noCI = $env.PI_BASH_NO_CI || $env.CLAUDE_BASH_NO_CI;
    return {
        ...Bun.env,
        SHELL: shell,
        GIT_EDITOR: "true",
        GPG_TTY: "not a tty",
        OMPCODE: "1",
        CLAUDECODE: "1",
        ...(noCI ? {} : { CI: "true" }),
    };
}
/**
 * Get shell args, optionally including login shell flag.
 * Supports PI_BASH_NO_LOGIN and CLAUDE_BASH_NO_LOGIN to skip -l.
 */
function getShellArgs() {
    const noLogin = $env.PI_BASH_NO_LOGIN || $env.CLAUDE_BASH_NO_LOGIN;
    return noLogin ? ["-c"] : ["-l", "-c"];
}
/**
 * Get shell prefix for wrapping commands (profilers, strace, etc.).
 */
function getShellPrefix() {
    return $env.PI_SHELL_PREFIX || $env.CLAUDE_CODE_SHELL_PREFIX;
}
/**
 * Find bash executable on PATH (Windows)
 */
function findBashOnPath() {
    try {
        return Bun.which("bash.exe");
    }
    catch {
        // Ignore errors
    }
    return null;
}
/**
 * Build full shell config from a shell path.
 */
function buildConfig(shell) {
    return {
        shell,
        args: getShellArgs(),
        env: buildSpawnEnv(shell),
        prefix: getShellPrefix(),
    };
}
/**
 * Resolve a basic shell (bash or sh) as fallback.
 */
export function resolveBasicShell() {
    for (const name of ["bash", "bash.exe", "sh", "sh.exe"]) {
        const resolved = Bun.which(name);
        if (resolved)
            return resolved;
    }
    if (process.platform !== "win32") {
        const searchPaths = ["/bin", "/usr/bin", "/usr/local/bin", "/opt/homebrew/bin"];
        const candidates = ["bash", "sh"];
        for (const name of candidates) {
            for (const dir of searchPaths) {
                const fullPath = path.join(dir, name);
                if (fs.existsSync(fullPath))
                    return fullPath;
            }
        }
    }
    return undefined;
}
/**
 * Get shell configuration based on platform.
 * Resolution order:
 * 1. User-specified shellPath in settings.json
 * 2. On Windows: Git Bash in known locations, then bash on PATH
 * 3. On Unix: $SHELL if bash/zsh, then fallback paths
 * 4. Fallback: sh
 */
export function getShellConfig(customShellPath) {
    if (cachedShellConfig) {
        return cachedShellConfig;
    }
    // 1. Check user-specified shell path
    if (customShellPath) {
        if (fs.existsSync(customShellPath)) {
            cachedShellConfig = buildConfig(customShellPath);
            return cachedShellConfig;
        }
        throw new Error(`Custom shell path not found: ${customShellPath}\nPlease update shellPath in ~/.spell/agent/settings.json`);
    }
    if (process.platform === "win32") {
        // 2. Try Git Bash in known locations
        const paths = [];
        const programFiles = Bun.env.ProgramFiles;
        if (programFiles) {
            paths.push(`${programFiles}\\Git\\bin\\bash.exe`);
        }
        const programFilesX86 = Bun.env["ProgramFiles(x86)"];
        if (programFilesX86) {
            paths.push(`${programFilesX86}\\Git\\bin\\bash.exe`);
        }
        for (const path of paths) {
            if (fs.existsSync(path)) {
                cachedShellConfig = buildConfig(path);
                return cachedShellConfig;
            }
        }
        // 3. Fallback: search bash.exe on PATH (Cygwin, MSYS2, WSL, etc.)
        const bashOnPath = findBashOnPath();
        if (bashOnPath) {
            cachedShellConfig = buildConfig(bashOnPath);
            return cachedShellConfig;
        }
        throw new Error(`No bash shell found. Options:\n` +
            `  1. Install Git for Windows: https://git-scm.com/download/win\n` +
            `  2. Add your bash to PATH (Cygwin, MSYS2, etc.)\n` +
            `  3. Set shellPath in ~/.spell/agent/settings.json\n\n` +
            `Searched Git Bash in:\n${paths.map(p => `  ${p}`).join("\n")}`);
    }
    // Unix: prefer user's shell from $SHELL if it's bash/zsh and executable
    const userShell = Bun.env.SHELL;
    const isValidShell = userShell && (userShell.includes("bash") || userShell.includes("zsh"));
    if (isValidShell && isExecutable(userShell)) {
        cachedShellConfig = buildConfig(userShell);
        return cachedShellConfig;
    }
    // 4. Fallback: use basic shell
    const basicShell = resolveBasicShell();
    if (basicShell) {
        cachedShellConfig = buildConfig(basicShell);
        return cachedShellConfig;
    }
    cachedShellConfig = buildConfig("sh");
    return cachedShellConfig;
}
/**
 * Global native kill tree function, injected by pi-natives when loaded.
 * Falls back to platform-specific behavior if not set.
 */
export let nativeKillTree;
/**
 * Set the native kill tree function. Called by pi-natives on load.
 */
export function setNativeKillTree(fn) {
    nativeKillTree = fn;
}
/**
 * Check if a process is running.
 */
export function isPidRunning(pid) {
    try {
        if (typeof pid === "number") {
            process.kill(pid, 0);
        }
        else {
            if (pid.killed)
                return false;
            if (pid.exitCode !== null)
                return false;
        }
        return true;
    }
    catch {
        return false;
    }
}
function joinSignals(...sigs) {
    const nn = sigs.filter(Boolean);
    if (nn.length === 0)
        return undefined;
    if (nn.length === 1)
        return nn[0];
    return AbortSignal.any(nn);
}
export function onProcessExit(proc, abortSignal) {
    if (typeof proc !== "number") {
        return proc.exited.then(() => true, () => true);
    }
    if (!isPidRunning(proc)) {
        return Promise.resolve(true);
    }
    const { promise, resolve, reject } = Promise.withResolvers();
    const localAbortController = new AbortController();
    const timer = timers.promises.setInterval(300, null, {
        signal: joinSignals(abortSignal, localAbortController.signal),
    });
    void (async () => {
        try {
            for await (const _ of timer) {
                if (!isPidRunning(proc)) {
                    resolve(true);
                    break;
                }
            }
        }
        catch (error) {
            return reject(error);
        }
        finally {
            localAbortController.abort();
        }
        resolve(false);
    })();
    return promise;
}
/**
 * Terminate a process and all its descendants.
 */
export async function terminate(options) {
    const { target, group = false, timeout = 5000, signal } = options;
    const abortController = new AbortController();
    try {
        const abortSignal = joinSignals(signal, abortController.signal);
        // Determine PID
        let pid;
        const exitPromise = onProcessExit(target, abortSignal);
        if (typeof target === "number") {
            pid = target;
        }
        else {
            pid = target.pid;
            if (target.killed)
                return true;
        }
        // Give it a moment to exit gracefully first.
        try {
            if (typeof target === "number") {
                process.kill(target, TERM_SIGNAL);
            }
            else {
                target.kill(TERM_SIGNAL);
            }
            if (exitPromise) {
                const exited = await Promise.race([Bun.sleep(1000).then(() => false), exitPromise]);
                if (exited)
                    return true;
            }
        }
        catch { }
        if (nativeKillTree) {
            nativeKillTree(pid, 9);
        }
        else {
            if (group && !IS_WINDOWS) {
                try {
                    process.kill(-pid, "SIGKILL");
                }
                catch { }
            }
            try {
                if (typeof target === "number") {
                    process.kill(target, "SIGKILL");
                }
                else {
                    target.kill("SIGKILL");
                }
            }
            catch { }
        }
        return await Promise.race([Bun.sleep(timeout).then(() => false), exitPromise]);
    }
    finally {
        abortController.abort();
    }
}
//# sourceMappingURL=procmgr.js.map