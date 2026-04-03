import { buildPullRsyncArgs } from "./rsync";
import {
	buildSqliteRsyncCommands,
	cleanupSshWrapper,
	discoverRemoteSqliteFiles,
	executeSqliteRsync,
	type SqliteRsyncCommand,
	writeSshWrapper,
} from "./sqlite-rsync";
import { sshOptionsFromTarget } from "./ssh";
import type { PullOptions, RsyncArgs } from "./types";
import { executeRsync } from "./utils";

/** Build the pull plan: rsync per pull dir + sqlite3-rsync commands */
export function buildPullPlan(opts: PullOptions & { sqliteFiles?: string[] }): {
	rsyncCommands: RsyncArgs[];
	sqliteRsyncCommands: SqliteRsyncCommand[];
} {
	const sshOptions = sshOptionsFromTarget(opts.target);

	const sqliteRsyncCommands = opts.sqliteFiles?.length
		? buildSqliteRsyncCommands({
				sshOptions,
				remoteProjectRoot: opts.target.projectRoot,
				localRoot: opts.localRoot,
				sqliteFiles: opts.sqliteFiles,
				direction: "pull",
			})
		: [];

	return {
		rsyncCommands: buildPullRsyncArgs({
			sshOptions,
			remoteProjectRoot: opts.target.projectRoot,
			localRoot: opts.localRoot,
			pullDirs: opts.sync.pull,
		}),
		sqliteRsyncCommands,
	};
}

/** Execute the full pull sequence: discover SQLite files, rsync (excluding SQLite), then sqlite3-rsync */
export async function executePull(opts: PullOptions): Promise<void> {
	if (opts.dryRun) return;

	const sshOptions = sshOptionsFromTarget(opts.target);

	// Discover SQLite files on the remote
	const sqliteFiles = await discoverRemoteSqliteFiles({
		sshOptions,
		remoteProjectRoot: opts.target.projectRoot,
		dirs: opts.sync.pull,
	});

	const plan = buildPullPlan({ ...opts, sqliteFiles });

	// Step 1: rsync (excludes SQLite files)
	for (const command of plan.rsyncCommands) {
		executeRsync(command);
	}

	// Step 2: sqlite3-rsync for each discovered SQLite file
	if (plan.sqliteRsyncCommands.length > 0) {
		const wrapperPath = await writeSshWrapper(sshOptions);
		try {
			// Rebuild commands with the wrapper path if needed
			const commands = wrapperPath
				? buildSqliteRsyncCommands({
						sshOptions,
						remoteProjectRoot: opts.target.projectRoot,
						localRoot: opts.localRoot,
						sqliteFiles,
						direction: "pull",
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
