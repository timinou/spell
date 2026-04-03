import { buildPushRsyncArgs } from "./rsync";
import { buildSshCommand, execSsh, sshOptionsFromTarget } from "./ssh";
import type { AtomicSwapPlan, PushOptions, RsyncArgs } from "./types";

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

/** Build the full atomic swap plan for a push operation */
export function buildPushPlan(opts: PushOptions): AtomicSwapPlan {
	const sshOptions = sshOptionsFromTarget(opts.target);
	const stagingDir = `${opts.target.projectRoot}.staging`;
	const backupDir = `${opts.target.projectRoot}.old`;
	const quotedProjectRoot = buildQuotedPath(opts.target.projectRoot);
	const quotedStagingDir = buildQuotedPath(stagingDir);
	const quotedBackupDir = buildQuotedPath(backupDir);

	return {
		rsyncToStaging: buildPushRsyncArgs({
			sshOptions,
			localRoot: opts.localRoot,
			remoteStaging: stagingDir,
			include: opts.target.include,
			exclude: opts.target.exclude,
		}),
		swapCommands: [
			buildSshCommand(sshOptions, `mkdir -p ${quotedStagingDir}`),
			buildSshCommand(sshOptions, `rm -rf ${quotedBackupDir}`),
			buildSshCommand(sshOptions, `mv ${quotedProjectRoot} ${quotedBackupDir} 2>/dev/null || true`),
			buildSshCommand(sshOptions, `mv ${quotedStagingDir} ${quotedProjectRoot}`),
		],
	};
}

/** Execute the full push sequence (rsync + atomic swap) */
export async function executePush(opts: PushOptions): Promise<void> {
	if (opts.dryRun) return;

	const plan = buildPushPlan(opts);
	executeRsync(plan.rsyncToStaging);
	for (const command of plan.swapCommands) {
		await execSsh(command);
	}
}
