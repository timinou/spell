import type { AgentStatus, SessionStatusFile } from "./types";
/** Default directory for session status files. */
export declare const STATUS_DIR: string;
/**
 * Writes the current session status to a JSON file in STATUS_DIR.
 * Deduplicates writes — only writes when the status or session title changes.
 */
export declare class StatusFileWriter {
    #private;
    constructor(statusDir?: string);
    /** Set the window ID. Must be called before write(). */
    setWindowId(id: number | string): void;
    get windowId(): number | string | null;
    /** Ensure the status directory exists. */
    ensureDir(): Promise<void>;
    /**
     * Write the session status file if it changed since last write.
     * No-op if no window ID is set or the dedup key matches.
     */
    writeIfChanged(status: AgentStatus, projectName: string, sessionTitle: string, pid?: number): void;
    /** Remove the status file on shutdown. */
    cleanup(): Promise<void>;
}
/**
 * Reads all session status files from STATUS_DIR.
 * Filters out stale entries (where the PID is no longer running).
 */
export declare class StatusFileReader {
    #private;
    constructor(statusDir?: string);
    /** Read all valid, non-stale session status files. */
    readAll(): Promise<SessionStatusFile[]>;
}
//# sourceMappingURL=status-file.d.ts.map