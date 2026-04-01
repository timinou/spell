import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { logger } from "@oh-my-pi/pi-utils";
import type { AgentStatus, SessionStatusFile } from "./types";

/** Default directory for session status files. */
export const STATUS_DIR = path.join(os.homedir(), ".spell", "status");

/**
 * Writes the current session status to a JSON file in STATUS_DIR.
 * Deduplicates writes — only writes when the status or session title changes.
 */
export class StatusFileWriter {
	#statusDir: string;
	#windowId: number | string | null = null;
	#lastWrittenDedup: string | null = null;

	constructor(statusDir = STATUS_DIR) {
		this.#statusDir = statusDir;
	}

	/** Set the window ID. Must be called before write(). */
	setWindowId(id: number | string): void {
		this.#windowId = id;
	}

	get windowId(): number | string | null {
		return this.#windowId;
	}

	/** Ensure the status directory exists. */
	async ensureDir(): Promise<void> {
		try {
			await fs.mkdir(this.#statusDir, { recursive: true });
		} catch {
			// ignore — may already exist
		}
	}

	/**
	 * Write the session status file if it changed since last write.
	 * No-op if no window ID is set or the dedup key matches.
	 */
	writeIfChanged(status: AgentStatus, projectName: string, sessionTitle: string, pid = process.pid): void {
		if (this.#windowId === null) return;
		const dedup = `${status}\0${sessionTitle}`;
		if (dedup === this.#lastWrittenDedup) return;
		this.#lastWrittenDedup = dedup;

		const payload: SessionStatusFile = {
			status,
			windowId: this.#windowId,
			pid,
			projectName,
			sessionTitle,
			updatedAt: Date.now(),
		};
		const filePath = path.join(this.#statusDir, `${this.#windowId}.json`);
		Bun.write(filePath, JSON.stringify(payload)).catch(() => {});
	}

	/** Remove the status file on shutdown. */
	async cleanup(): Promise<void> {
		if (this.#windowId === null) return;
		const filePath = path.join(this.#statusDir, `${this.#windowId}.json`);
		await fs.rm(filePath, { force: true }).catch(() => {});
		this.#windowId = null;
	}
}

/**
 * Reads all session status files from STATUS_DIR.
 * Filters out stale entries (where the PID is no longer running).
 */
export class StatusFileReader {
	#statusDir: string;

	constructor(statusDir = STATUS_DIR) {
		this.#statusDir = statusDir;
	}

	/** Read all valid, non-stale session status files. */
	async readAll(): Promise<SessionStatusFile[]> {
		let entries: string[];
		try {
			entries = await fs.readdir(this.#statusDir);
		} catch {
			return [];
		}

		const results: SessionStatusFile[] = [];
		for (const entry of entries) {
			if (!entry.endsWith(".json")) continue;
			const filePath = path.join(this.#statusDir, entry);
			try {
				const data: SessionStatusFile = await Bun.file(filePath).json();
				if (!data.status || !data.pid) continue;
				// Check if the process is still alive
				if (!isProcessAlive(data.pid)) {
					// Clean up stale file
					await fs.rm(filePath, { force: true }).catch(() => {});
					continue;
				}
				results.push(data);
			} catch {
				// Corrupt or unreadable file — skip
				logger.debug("StatusFileReader: skipping unreadable status file", { path: filePath });
			}
		}
		return results;
	}
}

/** Check if a process is alive by sending signal 0. */
function isProcessAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}
