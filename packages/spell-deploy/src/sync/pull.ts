import { buildPullRsyncArgs } from "./rsync";
import { buildSshCommand, execSsh, sshOptionsFromTarget } from "./ssh";
import type { PullOptions, RsyncArgs, SshCommand } from "./types";

function buildQuotedPath(path: string): string {
	return `'${path.replaceAll("'", `'\\''`)}'`;
}

function executeRsync(command: RsyncArgs): void {
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

/** Build the pull plan: optional SQLite backup + rsync per pull dir */
export function buildPullPlan(opts: PullOptions): {
	backupCommand?: SshCommand;
	rsyncCommands: RsyncArgs[];
} {
	const sshOptions = sshOptionsFromTarget(opts.target);
	const quotedProjectRoot = buildQuotedPath(opts.target.projectRoot);
	const backupCommand = opts.sync.sqliteBackup
		? buildSshCommand(
				sshOptions,
				`cd ${quotedProjectRoot} && mkdir -p backups && for f in data/*.sqlite; do sqlite3 "$f" ".backup backups/$(basename $f .sqlite)-$(date +%Y%m%d-%H%M%S).sqlite"; done`,
			)
		: undefined;

	return {
		backupCommand,
		rsyncCommands: buildPullRsyncArgs({
			sshOptions,
			remoteProjectRoot: opts.target.projectRoot,
			localRoot: opts.localRoot,
			pullDirs: opts.sync.pull,
		}),
	};
}

/** Execute the full pull sequence */
export async function executePull(opts: PullOptions): Promise<void> {
	if (opts.dryRun) return;

	const plan = buildPullPlan(opts);
	if (plan.backupCommand) {
		await execSsh(plan.backupCommand);
	}
	for (const command of plan.rsyncCommands) {
		executeRsync(command);
	}
}
