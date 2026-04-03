import type { RsyncArgs } from "./types";

/** Shell-quote a path by wrapping in single quotes with proper escaping */
export function buildQuotedPath(path: string): string {
	return `'${path.replaceAll("'", `'\\''`)}'`;
}

/** Execute an rsync command synchronously, throw on failure */
export function executeRsync(command: RsyncArgs): void {
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
