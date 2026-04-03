import { buildPushRsyncArgs } from "./rsync";
import {
	buildSqliteRsyncCommands,
	cleanupSshWrapper,
	discoverLocalSqliteFiles,
	executeSqliteRsync,
	type SqliteRsyncCommand,
	writeSshWrapper,
} from "./sqlite-rsync";
import { buildSshCommand, execSsh, sshOptionsFromTarget } from "./ssh";
import type { AtomicSwapPlan, PushOptions } from "./types";
import { buildQuotedPath, executeRsync } from "./utils";

/** Build the full atomic swap plan for a push operation */
export function buildPushPlan(opts: PushOptions & { sqliteFiles?: string[] }): AtomicSwapPlan & {
	sqliteRsyncCommands: SqliteRsyncCommand[];
} {
	const sshOptions = sshOptionsFromTarget(opts.target);
	const stagingDir = `${opts.target.projectRoot}.staging`;
	const backupDir = `${opts.target.projectRoot}.old`;
	const quotedProjectRoot = buildQuotedPath(opts.target.projectRoot);
	const quotedStagingDir = buildQuotedPath(stagingDir);
	const quotedBackupDir = buildQuotedPath(backupDir);

	const sqliteRsyncCommands = opts.sqliteFiles?.length
		? buildSqliteRsyncCommands({
				sshOptions,
				remoteProjectRoot: opts.target.projectRoot,
				localRoot: opts.localRoot,
				sqliteFiles: opts.sqliteFiles,
				direction: "push",
			})
		: [];

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
		sqliteRsyncCommands,
	};
}

/** Execute the full push sequence: rsync + atomic swap + sqlite3-rsync */
export async function executePush(opts: PushOptions): Promise<void> {
	if (opts.dryRun) return;

	const sshOptions = sshOptionsFromTarget(opts.target);

	// Discover local SQLite files under the included dirs
	const sqliteFiles = await discoverLocalSqliteFiles({
		localRoot: opts.localRoot,
		dirs: opts.target.include,
	});

	const plan = buildPushPlan({ ...opts, sqliteFiles });

	// Step 1: rsync to staging
	executeRsync(plan.rsyncToStaging);

	// Step 2: atomic swap
	for (const command of plan.swapCommands) {
		await execSsh(command);
	}

	// Step 3: sqlite3-rsync directly to projectRoot (not staging)
	if (plan.sqliteRsyncCommands.length > 0) {
		const wrapperPath = await writeSshWrapper(sshOptions);
		try {
			const commands = wrapperPath
				? buildSqliteRsyncCommands({
						sshOptions,
						remoteProjectRoot: opts.target.projectRoot,
						localRoot: opts.localRoot,
						sqliteFiles,
						direction: "push",
						sshWrapperPath: wrapperPath,
					})
				: plan.sqliteRsyncCommands;

			for (const command of commands) {
				executeSqliteRsync(command);
			}
		} finally {
			await cleanupSshWrapper(wrapperPath);
		}
	}
}
