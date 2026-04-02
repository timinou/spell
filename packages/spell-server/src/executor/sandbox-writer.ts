import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { SandboxConfig } from "../manifest/types";

const SANDBOX_FILE_PREFIX = "spell-sandbox-";
const SANDBOX_FILE_PATTERN = /^spell-sandbox-(\d+)-([a-z0-9_-]+)-(\d+)\.json$/;

function sanitizeGoalName(goalName: string): string {
	const sanitized = goalName
		.toLowerCase()
		.replace(/[^a-z0-9_-]+/g, "-")
		.replace(/^-+|-+$/g, "");
	return sanitized || "goal";
}

function isProcessAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

export async function writeSandboxPolicy(
	goalName: string,
	sandbox: SandboxConfig,
	tmpDir: string = os.tmpdir(),
): Promise<string> {
	const fileName = `${SANDBOX_FILE_PREFIX}${process.pid}-${sanitizeGoalName(goalName)}-${Date.now()}.json`;
	const filePath = path.join(tmpDir, fileName);
	const policy = {
		pathsWrite: sandbox.pathsWrite ?? [],
		bashAllow: sandbox.bashAllow ?? [],
		bashDeny: sandbox.bashDeny ?? [],
	};
	await Bun.write(filePath, JSON.stringify(policy));
	return filePath;
}

export async function cleanupStaleSandboxPolicies(tmpDir: string = os.tmpdir()): Promise<string[]> {
	const entries = await fs.readdir(tmpDir, { withFileTypes: true });
	const removed: string[] = [];
	await Promise.all(
		entries.map(async entry => {
			if (!entry.isFile() || !entry.name.startsWith(SANDBOX_FILE_PREFIX) || !entry.name.endsWith(".json")) {
				return;
			}
			const match = SANDBOX_FILE_PATTERN.exec(entry.name);
			if (match && isProcessAlive(Number(match[1]))) {
				return;
			}
			const filePath = path.join(tmpDir, entry.name);
			try {
				await fs.unlink(filePath);
				removed.push(filePath);
			} catch {
				// Best-effort cleanup.
			}
		}),
	);
	return removed.sort();
}

export async function removeSandboxPolicy(filePath: string): Promise<void> {
	try {
		await fs.unlink(filePath);
	} catch {
		// Best-effort cleanup.
	}
}
