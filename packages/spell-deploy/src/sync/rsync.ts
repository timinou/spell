import type { RsyncArgs, SshOptions } from "./types";

function buildRsyncSshTransport(sshOptions: SshOptions): string {
	const keyPart = sshOptions.sshKey ? ` -i '${sshOptions.sshKey}'` : "";
	return `ssh -p ${sshOptions.port}${keyPart} -o StrictHostKeyChecking=accept-new -o ConnectTimeout=${sshOptions.connectTimeout}`;
}

/** Build rsync args for pushing files to remote staging dir */
export function buildPushRsyncArgs(opts: {
	sshOptions: SshOptions;
	localRoot: string;
	remoteStaging: string;
	include: string[];
	exclude: string[];
}): RsyncArgs {
	const filterArgs = [
		...opts.include.flatMap(pattern => ["--include", pattern]),
		...opts.exclude.flatMap(pattern => ["--exclude", pattern]),
	];

	return {
		args: [
			"rsync",
			"-avz",
			"--delete",
			"-e",
			buildRsyncSshTransport(opts.sshOptions),
			...filterArgs,
			`${opts.localRoot}/`,
			`${opts.sshOptions.user}@${opts.sshOptions.host}:${opts.remoteStaging}/`,
		],
		description: `rsync push ${opts.localRoot}/ -> ${opts.sshOptions.user}@${opts.sshOptions.host}:${opts.remoteStaging}/`,
	};
}

/** Build rsync args for pulling remote state dirs to local */
export function buildPullRsyncArgs(opts: {
	sshOptions: SshOptions;
	remoteProjectRoot: string;
	localRoot: string;
	pullDirs: string[];
}): RsyncArgs[] {
	return opts.pullDirs.map(dir => ({
		args: [
			"rsync",
			"-avz",
			"-e",
			buildRsyncSshTransport(opts.sshOptions),
			`${opts.sshOptions.user}@${opts.sshOptions.host}:${opts.remoteProjectRoot}/${dir}`,
			`${opts.localRoot}/${dir}`,
		],
		description: `rsync pull ${dir}`,
	}));
}
