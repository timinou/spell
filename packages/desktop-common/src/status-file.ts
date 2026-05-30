import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { logger } from "@spell/pi-utils";
import type { AgentStatus, SessionStatusFile } from "./types";

interface SessionRecoveryInfo {
	sessionId: string;
	sessionFile: string;
	cwd: string;
}

function hasRecoveryMetadata(status: SessionStatusFile): status is SessionStatusFile & {
	sessionId: string;
	cwd: string;
} {
	return (
		typeof status.sessionId === "string" &&
		status.sessionId.length > 0 &&
		typeof status.cwd === "string" &&
		status.cwd.length > 0
	);
}

/** Default directory for session status files. */
export const STATUS_DIR = path.join(os.homedir(), ".spell", "status");

/**
 * Writes the current session status to a JSON file in STATUS_DIR.
 * Deduplicates writes — only writes when the status, session title, or recovery metadata changes.
 */
export class StatusFileWriter {
	#statusDir: string;
	#windowId: number | string | null = null;
	#lastWrittenDedup: string | null = null;
	#sessionInfo: SessionRecoveryInfo | null = null;
	#workspaceName: string | null | undefined;
	#metadataVersion = 0;

	constructor(statusDir = STATUS_DIR) {
		this.#statusDir = statusDir;
	}

	/** Set the window ID. Must be called before write(). */
	setWindowId(id: number | string): void {
		this.#windowId = id;
	}

	setSessionInfo(info: SessionRecoveryInfo): void {
		this.#sessionInfo = info;
		this.#metadataVersion += 1;
	}

	setWorkspaceName(name: string | null): void {
		this.#workspaceName = name;
		this.#metadataVersion += 1;
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
		const dedup = `${status}\0${sessionTitle}\0${this.#metadataVersion}`;
		if (dedup === this.#lastWrittenDedup) return;
		this.#lastWrittenDedup = dedup;

		const payload: SessionStatusFile = {
			status,
			windowId: this.#windowId,
			pid,
			projectName,
			sessionTitle,
			updatedAt: Date.now(),
			...(this.#sessionInfo ?? {}),
			...(this.#workspaceName !== undefined ? { workspaceName: this.#workspaceName } : {}),
		};
		const filePath = path.join(this.#statusDir, `${this.#windowId}.json`);
		Bun.write(filePath, JSON.stringify(payload)).catch(err => {
			logger.warn("StatusFileWriter: write failed", { path: filePath, err: String(err) });
		});
	}

	/** Remove the status file on shutdown. */
	async cleanup(): Promise<void> {
		if (this.#windowId === null) return;
		const filePath = path.join(this.#statusDir, `${this.#windowId}.json`);
		await fs.rm(filePath, { force: true }).catch(err => {
			logger.warn("StatusFileWriter: cleanup failed", { path: filePath, err: String(err) });
		});
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
		const entries = await this.#readStatusFiles();
		const results: SessionStatusFile[] = [];
		for (const entry of entries) {
			if (!isProcessAlive(entry.data.pid)) {
				await fs.rm(entry.filePath, { force: true }).catch(() => {});
				continue;
			}
			results.push(entry.data);
		}
		return results;
	}

	/** Read stale status files for crashed sessions without cleaning them up. */
	async readCrashed(): Promise<SessionStatusFile[]> {
		const entries = await this.#readStatusFiles();
		return entries.filter(entry => !isProcessAlive(entry.data.pid)).map(entry => entry.data);
	}

	/** Remove dead-PID status files that are missing recovery metadata and cannot be resumed. */
	async cleanStale(): Promise<number> {
		const entries = await this.#readStatusFiles();
		let cleaned = 0;
		for (const entry of entries) {
			if (isProcessAlive(entry.data.pid) || hasRecoveryMetadata(entry.data)) {
				continue;
			}
			try {
				await fs.rm(entry.filePath, { force: true });
				cleaned += 1;
			} catch (err) {
				logger.warn("StatusFileReader: stale cleanup failed", {
					path: entry.filePath,
					err: String(err),
				});
			}
		}
		return cleaned;
	}

	async #readStatusFiles(): Promise<Array<{ filePath: string; data: SessionStatusFile }>> {
		let entries: string[];
		try {
			entries = await fs.readdir(this.#statusDir);
		} catch {
			return [];
		}

		const results: Array<{ filePath: string; data: SessionStatusFile }> = [];
		for (const entry of entries) {
			if (!entry.endsWith(".json")) continue;
			const filePath = path.join(this.#statusDir, entry);
			try {
				const data: SessionStatusFile = await Bun.file(filePath).json();
				if (!data.status || !data.pid) continue;
				results.push({ filePath, data });
			} catch {
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
