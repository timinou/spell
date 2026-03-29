/** Resolve the TTY device path for stdin (fd 0) via POSIX `ttyname(3)`. */
export declare function getTtyPath(): string | null;
/**
 * Get a stable identifier for the current terminal.
 * Uses the TTY device path (e.g., /dev/pts/3), falling back to environment
 * variables for terminal multiplexers or terminal emulators.
 * Returns null if no terminal can be identified (e.g., piped input).
 */
export declare function getTerminalId(): string | null;
//# sourceMappingURL=ttyid.d.ts.map