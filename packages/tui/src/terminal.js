import { dlopen, FFIType, ptr } from "bun:ffi";
import * as fs from "node:fs";
import { $env, logger } from "@oh-my-pi/pi-utils";
import { setKittyProtocolActive } from "./keys";
import { StdinBuffer } from "./stdin-buffer";
/**
 * Minimal terminal interface for TUI
 */
// Track active terminal for emergency cleanup on crash
let activeTerminal = null;
// Track if a terminal was ever started (for emergency restore logic)
let terminalEverStarted = false;
const STD_INPUT_HANDLE = -10;
const ENABLE_VIRTUAL_TERMINAL_INPUT = 0x0200;
/**
 * errno-style codes that unambiguously mean the underlying stdio file
 * descriptor is gone or unusable. Any other `'error'` event on stdin/stdout
 * is most likely a synchronous throw from a `'data'` listener that Node/Bun
 * re-emitted on the stream — we must NOT mistake those for PTY death (see
 * BUG-391/BUG-387 interaction).
 */
const FATAL_IO_ERROR_CODES = new Set([
    "EIO",
    "EPIPE",
    "EBADF",
    "ENOTCONN",
    "ECONNRESET",
    "ESHUTDOWN",
]);
function isFatalIoError(err) {
    if (!err || typeof err !== "object")
        return false;
    const code = err.code;
    return typeof code === "string" && FATAL_IO_ERROR_CODES.has(code);
}
/**
 * Surface a non-IO stream error as an uncaught exception so the postmortem
 * crash reporter sees it instead of silently treating it as "terminal lost"
 * and exiting 0. We use `process.emit('uncaughtException', …)` rather than
 * a microtask `throw` so the rethrow is observable in unit tests without
 * tripping the test runner's own uncaught-error policy on a synthetic throw.
 */
function rethrowAsUncaught(err) {
    const toEmit = err instanceof Error ? err : new Error(String(err ?? "unknown stream error"));
    if (process.listenerCount("uncaughtException") > 0) {
        process.emit("uncaughtException", toEmit, "uncaughtException");
        return;
    }
    // No listener installed yet (e.g. very early in startup): fall back to a
    // genuine throw so we don't lose the error entirely.
    queueMicrotask(() => {
        throw toEmit;
    });
}
/**
 * Emergency terminal restore - call this from signal/crash handlers
 * Resets terminal state without requiring access to the ProcessTerminal instance
 */
export function emergencyTerminalRestore() {
    try {
        const terminal = activeTerminal;
        if (terminal) {
            terminal.stop();
            terminal.showCursor();
        }
        else if (terminalEverStarted) {
            // Blind restore only if we know a terminal was started but lost track of it
            // This avoids writing escape sequences for non-TUI commands (grep, commit, etc.)
            process.stdout.write("\x1b[?2004l" + // Disable bracketed paste
                "\x1b[?2031l" + // Disable Mode 2031 appearance notifications
                "\x1b[<u" + // Pop kitty keyboard protocol
                "\x1b[>4;0m" + // Disable modifyOtherKeys fallback
                "\x1b[?25h");
            if (process.stdin.setRawMode) {
                process.stdin.setRawMode(false);
            }
        }
    }
    catch {
        // Terminal may already be dead during crash cleanup - ignore errors
    }
}
/**
 * Real terminal using process.stdin/stdout
 */
export class ProcessTerminal {
    #wasRaw = false;
    #inputHandler;
    #resizeHandler;
    #kittyProtocolActive = false;
    #modifyOtherKeysActive = false;
    #modifyOtherKeysTimeout;
    #stdinBuffer;
    #stdinDataHandler;
    #dead = false;
    #writeLogPath = $env.PI_TUI_WRITE_LOG || "";
    #windowsVTInputRestore;
    #appearanceCallbacks = [];
    #focusCallbacks = [];
    #focused = true;
    #lossCallbacks = [];
    #appearance;
    #osc11Pending = false;
    #osc11QueryQueued = false;
    #osc11ResponseBuffer = "";
    #pendingDa1Sentinels = 0;
    #osc11PollTimer;
    #livenessTimer;
    #mode2031Active = false;
    #mode2031DebounceTimer;
    #onStdoutError = (err) => {
        if (isFatalIoError(err)) {
            this.#onPtyLost("stdout-error");
            return;
        }
        // Likely a thrown error from a downstream 'data'/write callback that
        // Node/Bun re-emitted on the stream. Surface it via uncaughtException
        // so the crash reporter records a real stack instead of a silent exit.
        logger.warn("terminal stdout error (non-fatal io)", {
            code: err?.code,
            message: err?.message,
        });
        rethrowAsUncaught(err);
    };
    #onStdinError = (err) => {
        if (isFatalIoError(err)) {
            this.#onPtyLost("stdin-error");
            return;
        }
        logger.warn("terminal stdin error (non-fatal io)", {
            code: err?.code,
            message: err?.message,
        });
        rethrowAsUncaught(err);
    };
    #onStdinEnd = () => this.#onPtyLost("stdin-end");
    #onStdinClose = () => this.#onPtyLost("stdin-close");
    get kittyProtocolActive() {
        return this.#kittyProtocolActive;
    }
    get appearance() {
        return this.#appearance;
    }
    onAppearanceChange(callback) {
        this.#appearanceCallbacks.push(callback);
    }
    onLost(callback) {
        this.#lossCallbacks.push(callback);
        return () => {
            const index = this.#lossCallbacks.indexOf(callback);
            if (index >= 0) {
                this.#lossCallbacks.splice(index, 1);
            }
        };
    }
    onFocusChange(callback) {
        this.#focusCallbacks.push(callback);
        return () => {
            const idx = this.#focusCallbacks.indexOf(callback);
            if (idx >= 0) {
                this.#focusCallbacks.splice(idx, 1);
            }
        };
    }
    #onPtyLost(reason) {
        if (this.#dead)
            return;
        this.#dead = true;
        this.#stopOsc11Poll();
        this.#stopLivenessTimer();
        logger.info("terminal lost", { reason });
        for (const cb of [...this.#lossCallbacks]) {
            try {
                cb(reason);
            }
            catch {
                /* ignore callback errors */
            }
        }
        process.stdout.removeListener("error", this.#onStdoutError);
        process.stdin.removeListener("error", this.#onStdinError);
        process.stdin.removeListener("end", this.#onStdinEnd);
        process.stdin.removeListener("close", this.#onStdinClose);
    }
    /**
     * Liveness check: detect when the controlling pty has been destroyed by
     * checking whether stdout/stdin are still usable. Called from the OSC 11
     * poll interval so we piggy-back on the existing 2s cadence.
     */
    #checkPtyLiveness() {
        if (!process.stdout.writable) {
            this.#onPtyLost("stdout-unwritable");
            return false;
        }
        if (!process.stdin.readable) {
            this.#onPtyLost("stdin-unreadable");
            return false;
        }
        return true;
    }
    start(onInput, onResize) {
        this.#inputHandler = onInput;
        this.#resizeHandler = onResize;
        // Register for emergency cleanup
        activeTerminal = this;
        terminalEverStarted = true;
        // Save previous state and enable raw mode
        this.#wasRaw = process.stdin.isRaw || false;
        if (process.stdin.setRawMode) {
            process.stdin.setRawMode(true);
        }
        process.stdin.setEncoding("utf8");
        process.stdin.resume();
        // Enable bracketed paste mode - terminal will wrap pastes in \x1b[200~ ... \x1b[201~
        this.#safeWrite("\x1b[?2004h");
        // Set up resize handler immediately
        process.stdout.on("resize", this.#resizeHandler);
        // Refresh terminal dimensions - they may be stale after suspend/resume
        // (SIGWINCH is lost while process is stopped). Unix only.
        if (process.platform !== "win32") {
            process.kill(process.pid, "SIGWINCH");
        }
        // On Windows, enable ENABLE_VIRTUAL_TERMINAL_INPUT so the console sends
        // VT escape sequences (e.g. \x1b[Z for Shift+Tab) instead of raw console
        // events that lose modifier information. Must run after setRawMode(true)
        // since that resets console mode flags.
        this.#enableWindowsVTInput();
        // Query and enable Kitty keyboard protocol
        // The query handler intercepts input temporarily, then installs the user's handler
        // See: https://sw.kovidgoyal.net/kitty/keyboard-protocol/
        this.#queryAndEnableKittyProtocol();
        // Query terminal background color via OSC 11 for dark/light detection.
        // Uses DA1 (Primary Device Attributes) as a sentinel: terminals process
        // sequences in order, so if DA1 arrives before OSC 11 response,
        // the terminal does not support OSC 11. This avoids indefinite hangs.
        // Technique used by Neovim, bat, fish, and terminal-colorsaurus.
        this.#queryBackgroundColor();
        // Subscribe to Mode 2031 appearance change notifications.
        // When the terminal reports a change, we re-query OSC 11 to get the
        // actual background color (following Neovim convention) with 100ms debounce.
        this.#safeWrite("\x1b[?2031h");
        // Enable focus event reporting (CSI 1004h). Terminal sends \x1b[I on
        // focus-in and \x1b[O on focus-out. Used by TUI to throttle rendering
        // when the terminal window is not visible (niri overview switching,
        // minimized, other workspace, etc.).
        this.#safeWrite("\x1b[?1004h");
        // Start periodic OSC 11 re-query for terminals without Mode 2031
        // (Warp, Alacritty, WezTerm, iTerm2). Self-disables once Mode 2031 fires.
        this.#startOsc11Poll();
        // Detect controlling-pty destruction asynchronously. When the parent
        // shell or SSH session dies, stdout will emit 'error' (often EIO) and
        // stdin will emit 'end' or 'close'. These are the only reliable signals
        // because there is no portable SIGWINCH-like notification for pty loss.
        process.stdout.on("error", this.#onStdoutError);
        process.stdin.on("error", this.#onStdinError);
        process.stdin.on("end", this.#onStdinEnd);
        process.stdin.on("close", this.#onStdinClose);
    }
    /**
     * On Windows, add ENABLE_VIRTUAL_TERMINAL_INPUT to the stdin console mode
     * so modified keys (for example Shift+Tab) arrive as VT escape sequences.
     */
    #enableWindowsVTInput() {
        if (process.platform !== "win32")
            return;
        this.#restoreWindowsVTInput();
        try {
            const kernel32 = dlopen("kernel32.dll", {
                GetStdHandle: { args: [FFIType.i32], returns: FFIType.ptr },
                GetConsoleMode: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.bool },
                SetConsoleMode: { args: [FFIType.ptr, FFIType.u32], returns: FFIType.bool },
            });
            const handle = kernel32.symbols.GetStdHandle(STD_INPUT_HANDLE);
            const mode = new Uint32Array(1);
            const modePtr = ptr(mode);
            if (!modePtr || !kernel32.symbols.GetConsoleMode(handle, modePtr)) {
                kernel32.close();
                return;
            }
            const originalMode = mode[0];
            const vtMode = originalMode | ENABLE_VIRTUAL_TERMINAL_INPUT;
            if (vtMode !== originalMode && !kernel32.symbols.SetConsoleMode(handle, vtMode)) {
                kernel32.close();
                return;
            }
            this.#windowsVTInputRestore = () => {
                try {
                    kernel32.symbols.SetConsoleMode(handle, originalMode);
                }
                finally {
                    kernel32.close();
                }
            };
        }
        catch {
            // bun:ffi unavailable or console API unsupported; keep startup non-fatal.
        }
    }
    #restoreWindowsVTInput() {
        if (process.platform !== "win32")
            return;
        const restore = this.#windowsVTInputRestore;
        this.#windowsVTInputRestore = undefined;
        if (!restore)
            return;
        try {
            restore();
        }
        catch {
            // Ignore restore errors during terminal teardown.
        }
    }
    /**
     * Set up StdinBuffer to split batched input into individual sequences.
     * This ensures components receive single events, making matchesKey/isKeyRelease work correctly.
     *
     * Also watches for Kitty protocol response and enables it when detected.
     * This is done here (after stdinBuffer parsing) rather than on raw stdin
     * to handle the case where the response arrives split across multiple events.
     */
    #setupStdinBuffer() {
        this.#stdinBuffer = new StdinBuffer({ timeout: 10 });
        // Kitty protocol response pattern: \x1b[?<flags>u
        const kittyResponsePattern = /^\x1b\[\?(\d+)u$/;
        // Mode 2031 DSR response: \x1b[?997;{1=dark,2=light}n
        const appearanceDsrPattern = /^\x1b\[\?997;([12])n$/;
        // OSC 11 response: \x1b]11;rgb:RR/GG/BB or rgba:RR/GG/BB, terminated by BEL or ST.
        const osc11ResponsePattern = /^\x1b\]11;rgba?:([0-9a-fA-F]{1,4})\/([0-9a-fA-F]{1,4})\/([0-9a-fA-F]{1,4})(?:\x07|\x1b\\)$/;
        // DA1 (Primary Device Attributes) response: \x1b[?...c
        const da1ResponsePattern = /^\x1b\[\?[\d;]*c$/;
        // Forward individual sequences to the input handler
        this.#stdinBuffer.on("data", (sequence) => {
            // Check for Kitty protocol response (only if not already enabled)
            if (!this.#kittyProtocolActive) {
                const match = sequence.match(kittyResponsePattern);
                if (match) {
                    if (this.#modifyOtherKeysTimeout) {
                        clearTimeout(this.#modifyOtherKeysTimeout);
                        this.#modifyOtherKeysTimeout = undefined;
                    }
                    this.#kittyProtocolActive = true;
                    setKittyProtocolActive(true);
                    // Enable Kitty keyboard protocol (push flags)
                    // Flag 1 = disambiguate escape codes
                    // Flag 2 = report event types (press/repeat/release)
                    // Flag 4 = report alternate keys
                    this.#safeWrite("\x1b[>7u");
                    return; // Don't forward protocol response to TUI
                }
            }
            // DA1 response: swallow our sentinel reply regardless of whether OSC 11
            // already succeeded. Other terminal probes should never see these replies.
            if (da1ResponsePattern.test(sequence) && this.#pendingDa1Sentinels > 0) {
                this.#pendingDa1Sentinels--;
                if (this.#osc11Pending) {
                    // DA1 arrived before OSC 11 response: terminal does not support
                    // OSC 11. Clear the pending state without starting a queued query
                    // (queued query is started below, after sentinel is consumed).
                    this.#osc11Pending = false;
                    this.#osc11ResponseBuffer = "";
                }
                // Now that this DA1 cycle is complete, start any queued query.
                if (this.#osc11QueryQueued && !this.#dead) {
                    this.#osc11QueryQueued = false;
                    this.#startOsc11Query();
                }
                return;
            }
            // OSC 11 replies can be split if the stdin buffer flushes a partial sequence.
            // Accumulate fragments until the BEL/ST terminator arrives, then parse once.
            // If a new escape sequence arrives (not the ST terminator), abort buffering
            // and forward it as normal input so user keystrokes are never swallowed.
            if (this.#osc11Pending && (this.#osc11ResponseBuffer || sequence.startsWith("\x1b]11;"))) {
                if (this.#osc11ResponseBuffer && sequence.startsWith("\x1b") && sequence !== "\x1b\\") {
                    // New escape sequence arrived mid-buffer — not an OSC 11 continuation.
                    this.#osc11ResponseBuffer = "";
                    // Fall through to normal input handling below.
                }
                else {
                    this.#osc11ResponseBuffer += sequence;
                    const osc11Match = this.#osc11ResponseBuffer.match(osc11ResponsePattern);
                    if (!osc11Match)
                        return;
                    const [, rHex, gHex, bHex] = osc11Match;
                    this.#osc11Pending = false;
                    this.#osc11ResponseBuffer = "";
                    this.#handleOsc11Response(rHex, gHex, bHex);
                    return;
                }
            }
            // Focus events: \x1b[I (focus-in), \x1b[O (focus-out). Sent by
            // terminal when CSI 1004h is active. Fire callbacks; swallow event
            // (do not forward to input handler since it's not a user keystroke).
            if (sequence === "\x1b[I" || sequence === "\x1b[O") {
                const focused = sequence === "\x1b[I";
                if (focused !== this.#focused) {
                    this.#focused = focused;
                    for (const cb of [...this.#focusCallbacks]) {
                        try {
                            cb(focused);
                        }
                        catch { /* swallow */ }
                    }
                }
                return;
            }
            // Mode 2031 change notification: re-query OSC 11 with 100ms debounce
            // (Neovim convention — coalesces rapid notifications during transitions)
            const appearanceMatch = sequence.match(appearanceDsrPattern);
            if (appearanceMatch) {
                if (!this.#mode2031Active) {
                    this.#mode2031Active = true;
                    this.#stopOsc11Poll();
                }
                if (this.#mode2031DebounceTimer)
                    clearTimeout(this.#mode2031DebounceTimer);
                this.#mode2031DebounceTimer = setTimeout(() => {
                    this.#mode2031DebounceTimer = undefined;
                    this.#queryBackgroundColor();
                }, 100);
                return;
            }
            if (this.#inputHandler) {
                this.#inputHandler(sequence);
            }
        });
        // Re-wrap paste content with bracketed paste markers for existing editor handling
        this.#stdinBuffer.on("paste", (content) => {
            if (this.#inputHandler) {
                this.#inputHandler(`\x1b[200~${content}\x1b[201~`);
            }
        });
        // Handler that pipes stdin data through the buffer
        this.#stdinDataHandler = (data) => {
            this.#stdinBuffer.process(data);
        };
    }
    /**
     * Send OSC 11 background color query followed by DA1 sentinel.
     * DA1 avoids indefinite hangs: if DA1 response arrives before OSC 11,
     * the terminal does not support OSC 11.
     */
    #queryBackgroundColor() {
        if (this.#dead)
            return;
        // Queue if an OSC 11 query is in flight or its DA1 sentinel hasn't been
        // consumed yet. Starting a new query while a DA1 is outstanding would
        // increment the sentinel counter, and the old DA1 arrival would then
        // prematurely clear the new query's pending state.
        if (this.#osc11Pending || this.#pendingDa1Sentinels > 0) {
            this.#osc11QueryQueued = true;
            return;
        }
        this.#startOsc11Query();
    }
    #startOsc11Query() {
        this.#osc11Pending = true;
        this.#osc11ResponseBuffer = "";
        this.#pendingDa1Sentinels++;
        this.#safeWrite("\x1b]11;?\x07"); // OSC 11 query (BEL terminated)
        this.#safeWrite("\x1b[c"); // DA1 sentinel
    }
    /**
     * Parse an OSC 11 background color response and compute BT.601 luminance.
     * Handles 1-, 2-, 3-, and 4-digit XParseColor hex components.
     */
    #handleOsc11Response(rHex, gHex, bHex) {
        // First valid reply means we have an answer; the periodic re-query is no
        // longer needed for THIS appearance. Mode 2031 push events (and SIGWINCH-
        // driven explicit queries) still trigger fresh queries on changes.
        this.#stopOsc11Poll();
        const normalize = (hex) => {
            const value = parseInt(hex, 16);
            if (Number.isNaN(value))
                return 0;
            const max = 16 ** hex.length - 1;
            return max > 0 ? value / max : 0;
        };
        const luminance = 0.299 * normalize(rHex) + 0.587 * normalize(gHex) + 0.114 * normalize(bHex);
        const mode = luminance < 0.5 ? "dark" : "light";
        if (mode === this.#appearance)
            return;
        this.#appearance = mode;
        for (const cb of this.#appearanceCallbacks) {
            try {
                cb(mode);
            }
            catch {
                /* ignore callback errors */
            }
        }
    }
    /**
     * Start periodic OSC 11 re-queries for terminals without Mode 2031 (Warp, Alacritty, WezTerm).
     * Self-disables once Mode 2031 fires (push-based is better than polling).
     */
    #startOsc11Poll() {
        this.#stopOsc11Poll();
        this.#osc11PollTimer = setInterval(() => {
            if (this.#dead) {
                this.#stopOsc11Poll();
                return;
            }
            if (!this.#checkPtyLiveness())
                return;
            this.#queryBackgroundColor();
        }, 2_000);
        this.#osc11PollTimer.unref?.();
        // Separate liveness probe — must keep running even after OSC11 poll
        // self-disables on first valid reply. This is what detects pty death
        // when the user has accepted the background-color answer.
        this.#startLivenessTimer();
    }
    #stopOsc11Poll() {
        if (this.#osc11PollTimer) {
            clearInterval(this.#osc11PollTimer);
            this.#osc11PollTimer = undefined;
        }
    }
    #startLivenessTimer() {
        this.#stopLivenessTimer();
        this.#livenessTimer = setInterval(() => {
            if (this.#dead) {
                this.#stopLivenessTimer();
                return;
            }
            this.#checkPtyLiveness();
        }, 2_000);
        this.#livenessTimer.unref?.();
    }
    #stopLivenessTimer() {
        if (this.#livenessTimer) {
            clearInterval(this.#livenessTimer);
            this.#livenessTimer = undefined;
        }
    }
    /**
     * Query terminal for Kitty keyboard protocol support and enable if available.
     *
     * Sends CSI ? u to query current flags. If terminal responds with CSI ? <flags> u,
     * it supports the protocol and we enable it with CSI > 1 u.
     *
     * The response is detected in setupStdinBuffer's data handler, which properly
     * handles the case where the response arrives split across multiple stdin events.
     */
    #queryAndEnableKittyProtocol() {
        this.#setupStdinBuffer();
        process.stdin.on("data", this.#stdinDataHandler);
        this.#safeWrite("\x1b[?u");
        this.#modifyOtherKeysTimeout = setTimeout(() => {
            this.#modifyOtherKeysTimeout = undefined;
            if (this.#kittyProtocolActive || this.#modifyOtherKeysActive) {
                return;
            }
            this.#safeWrite("\x1b[>4;2m");
            this.#modifyOtherKeysActive = true;
        }, 150);
        this.#modifyOtherKeysTimeout.unref?.();
    }
    async drainInput(maxMs = 1000, idleMs = 50) {
        if (this.#kittyProtocolActive) {
            // Disable Kitty keyboard protocol first so any late key releases
            // do not generate new Kitty escape sequences.
            this.#safeWrite("\x1b[<u");
            this.#kittyProtocolActive = false;
            setKittyProtocolActive(false);
        }
        if (this.#modifyOtherKeysTimeout) {
            clearTimeout(this.#modifyOtherKeysTimeout);
            this.#modifyOtherKeysTimeout = undefined;
        }
        if (this.#modifyOtherKeysActive) {
            this.#safeWrite("\x1b[>4;0m");
            this.#modifyOtherKeysActive = false;
        }
        const previousHandler = this.#inputHandler;
        this.#inputHandler = undefined;
        let lastDataTime = Date.now();
        const onData = () => {
            lastDataTime = Date.now();
        };
        process.stdin.on("data", onData);
        const endTime = Date.now() + maxMs;
        try {
            while (true) {
                const now = Date.now();
                const timeLeft = endTime - now;
                if (timeLeft <= 0)
                    break;
                if (now - lastDataTime >= idleMs)
                    break;
                await new Promise(resolve => setTimeout(resolve, Math.min(idleMs, timeLeft)));
            }
        }
        finally {
            process.stdin.removeListener("data", onData);
            this.#inputHandler = previousHandler;
        }
    }
    stop() {
        // Unregister from emergency cleanup
        if (activeTerminal === this) {
            activeTerminal = null;
        }
        // Disable bracketed paste mode
        this.#safeWrite("\x1b[?2004l");
        // Disable Mode 2031 appearance change notifications
        this.#safeWrite("\x1b[?2031l");
        // Disable focus event reporting
        this.#safeWrite("\x1b[?1004l");
        this.#stopOsc11Poll();
        this.#stopLivenessTimer();
        if (this.#mode2031DebounceTimer) {
            clearTimeout(this.#mode2031DebounceTimer);
            this.#mode2031DebounceTimer = undefined;
        }
        this.#appearanceCallbacks = [];
        this.#lossCallbacks = [];
        this.#osc11Pending = false;
        this.#osc11QueryQueued = false;
        this.#osc11ResponseBuffer = "";
        this.#pendingDa1Sentinels = 0;
        this.#mode2031Active = false;
        // Disable Kitty keyboard protocol if not already done by drainInput()
        if (this.#kittyProtocolActive) {
            this.#safeWrite("\x1b[<u");
            this.#kittyProtocolActive = false;
            setKittyProtocolActive(false);
        }
        if (this.#modifyOtherKeysTimeout) {
            clearTimeout(this.#modifyOtherKeysTimeout);
            this.#modifyOtherKeysTimeout = undefined;
        }
        if (this.#modifyOtherKeysActive) {
            this.#safeWrite("\x1b[>4;0m");
            this.#modifyOtherKeysActive = false;
        }
        this.#restoreWindowsVTInput();
        // Clean up StdinBuffer
        if (this.#stdinBuffer) {
            this.#stdinBuffer.destroy();
            this.#stdinBuffer = undefined;
        }
        // Remove event handlers
        if (this.#stdinDataHandler) {
            process.stdin.removeListener("data", this.#stdinDataHandler);
            this.#stdinDataHandler = undefined;
        }
        this.#inputHandler = undefined;
        this.#appearance = undefined;
        if (this.#resizeHandler) {
            process.stdout.removeListener("resize", this.#resizeHandler);
            this.#resizeHandler = undefined;
        }
        process.stdout.removeListener("error", this.#onStdoutError);
        process.stdin.removeListener("error", this.#onStdinError);
        process.stdin.removeListener("end", this.#onStdinEnd);
        process.stdin.removeListener("close", this.#onStdinClose);
        // Pause stdin to prevent any buffered input (e.g., Ctrl+D) from being
        // re-interpreted after raw mode is disabled. This fixes a race condition
        // where Ctrl+D could close the parent shell over SSH.
        process.stdin.pause();
        // Restore raw mode state
        if (process.stdin.setRawMode) {
            process.stdin.setRawMode(this.#wasRaw);
        }
    }
    write(data) {
        this.#safeWrite(data);
        if (this.#writeLogPath) {
            try {
                fs.appendFileSync(this.#writeLogPath, data, { encoding: "utf8" });
            }
            catch {
                // Ignore logging errors
            }
        }
    }
    #safeWrite(data) {
        if (this.#dead)
            return;
        try {
            process.stdout.write(data);
        }
        catch (err) {
            // Any write failure means terminal is dead - no recovery possible
            this.#dead = true;
            logger.warn("terminal is dead - no recovery possible", { error: err, data });
        }
    }
    get columns() {
        return process.stdout.columns || 80;
    }
    get rows() {
        return process.stdout.rows || 24;
    }
    moveBy(lines) {
        if (lines > 0) {
            // Move down
            this.#safeWrite(`\x1b[${lines}B`);
        }
        else if (lines < 0) {
            // Move up
            this.#safeWrite(`\x1b[${-lines}A`);
        }
        // lines === 0: no movement
    }
    hideCursor() {
        this.#safeWrite("\x1b[?25l");
    }
    showCursor() {
        this.#safeWrite("\x1b[?25h");
    }
    clearLine() {
        this.#safeWrite("\x1b[K");
    }
    clearFromCursor() {
        this.#safeWrite("\x1b[J");
    }
    clearScreen() {
        this.#safeWrite("\x1b[H\x1b[0J"); // Move to home (1,1) and clear from cursor to end
    }
    setTitle(title) {
        // OSC 0;title BEL - set terminal window title
        this.#safeWrite(`\x1b]0;${title}\x07`);
    }
}
//# sourceMappingURL=terminal.js.map