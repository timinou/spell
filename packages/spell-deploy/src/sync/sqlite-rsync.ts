import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { buildSshArgs, execSsh } from "./ssh";
import type { SshOptions } from "./types";

export interface SqliteRsyncCommand {
	/** Full sqlite3-rsync command args array */
	args: string[];
	/** Human-readable description */
	description: string;
}

/**
 * Build SSH wrapper script content for sqlite3-rsync --ssh flag.
 * Returns null if default SSH is sufficient (port 22, no custom key).
 */
export function buildSshWrapperScript(opts: SshOptions): string | null {
	if (opts.port === 22 && !opts.sshKey) return null;

	const keyPart = opts.sshKey ? ` -i ${shellQuote(opts.sshKey)}` : "";
	return [
		"#!/bin/sh",
		`exec ssh -p ${opts.port}${keyPart} -o StrictHostKeyChecking=accept-new -o ConnectTimeout=${opts.connectTimeout} "$@"`,
	].join("\n");
}

/** Discover *.sqlite files on the remote under given dirs via SSH find */
export async function discoverRemoteSqliteFiles(opts: {
	sshOptions: SshOptions;
	remoteProjectRoot: string;
	dirs: string[];
}): Promise<string[]> {
	if (opts.dirs.length === 0) return [];

	// Build find command across all dirs
	const findPaths = opts.dirs.map(dir => `${opts.remoteProjectRoot}/${dir}`).join(" ");
	const findCmd = `find ${findPaths} -name '*.sqlite' -type f 2>/dev/null || true`;

	const result = execSsh({
		args: [...buildSshArgs(opts.sshOptions), findCmd],
		description: `SSH: find sqlite files in ${opts.dirs.join(", ")}`,
	});

	return parseFindOutput(result.stdout, opts.remoteProjectRoot);
}

/** Discover *.sqlite files locally under given dirs */
export async function discoverLocalSqliteFiles(opts: { localRoot: string; dirs: string[] }): Promise<string[]> {
	if (opts.dirs.length === 0) return [];

	const results: string[] = [];
	for (const dir of opts.dirs) {
		const fullDir = path.join(opts.localRoot, dir);
		try {
			const entries = await fs.readdir(fullDir, { recursive: true });
			for (const entry of entries) {
				if (entry.endsWith(".sqlite")) {
					// Store as relative path from localRoot
					results.push(path.join(dir, entry));
				}
			}
		} catch {
			// Directory doesn't exist — skip
		}
	}
	return results;
}

/** Build sqlite3-rsync commands for a set of discovered sqlite files */
export function buildSqliteRsyncCommands(opts: {
	sshOptions: SshOptions;
	remoteProjectRoot: string;
	localRoot: string;
	sqliteFiles: string[];
	direction: "pull" | "push";
	sshWrapperPath?: string;
}): SqliteRsyncCommand[] {
	return opts.sqliteFiles.map(relPath => {
		const remotePath = `${opts.sshOptions.user}@${opts.sshOptions.host}:${opts.remoteProjectRoot}/${relPath}`;
		const localPath = path.join(opts.localRoot, relPath);
		const sshArgs = opts.sshWrapperPath ? ["--ssh", opts.sshWrapperPath] : [];

		const args =
			opts.direction === "pull"
				? ["sqlite3-rsync", ...sshArgs, remotePath, localPath]
				: ["sqlite3-rsync", ...sshArgs, localPath, remotePath];

		return {
			args,
			description: `sqlite3-rsync ${opts.direction} ${relPath}`,
		};
	});
}

/** Execute a single sqlite3-rsync command */
export function executeSqliteRsync(command: SqliteRsyncCommand): void {
	const result = Bun.spawnSync(command.args, {
		stdout: "pipe",
		stderr: "pipe",
	});

	if (result.exitCode !== 0) {
		const stderr = result.stderr.toString();
		const stdout = result.stdout.toString();
		throw new Error(`${command.description} failed: ${stderr || stdout || `exit code ${result.exitCode}`}`);
	}
}

/**
 * Write an SSH wrapper script to a temp file and return its path.
 * Returns null if no wrapper is needed.
 */
export async function writeSshWrapper(opts: SshOptions): Promise<string | null> {
	const script = buildSshWrapperScript(opts);
	if (!script) return null;

	const tmpDir = os.tmpdir();
	const wrapperPath = path.join(tmpDir, `spell-ssh-wrapper-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
	await Bun.write(wrapperPath, script);
	await fs.chmod(wrapperPath, 0o755);
	return wrapperPath;
}

/** Remove an SSH wrapper script if it exists */
export async function cleanupSshWrapper(wrapperPath: string | null): Promise<void> {
	if (!wrapperPath) return;
	try {
		await fs.unlink(wrapperPath);
	} catch {
		// Ignore cleanup failures
	}
}

// --- internal helpers ---

/** Parse `find` output into relative paths from projectRoot */
function parseFindOutput(stdout: string, projectRoot: string): string[] {
	const prefix = projectRoot.endsWith("/") ? projectRoot : `${projectRoot}/`;
	return stdout
		.split("\n")
		.map(line => line.trim())
		.filter(line => line.length > 0)
		.map(line => (line.startsWith(prefix) ? line.slice(prefix.length) : line));
}

/** Shell-quote a string for use in a wrapper script */
function shellQuote(s: string): string {
	return `'${s.replaceAll("'", "'\\''")}'`;
}
