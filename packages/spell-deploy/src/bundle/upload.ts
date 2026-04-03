import { buildSshCommand } from "../sync/ssh";
import type { SshCommand, SshOptions } from "../sync/types";
import type { BundleManifest } from "./types";

/** Build upload commands: scp binary to remote, verify hash */
export function buildUploadCommands(opts: {
	manifest: BundleManifest;
	remoteBundleDir: string;
	sshOptions: SshOptions;
}): { scpArgs: string[]; verifyCommand: SshCommand } {
	const remoteTmp = `${opts.remoteBundleDir}/spell.tmp`;
	const remoteFinal = `${opts.remoteBundleDir}/spell`;
	const scpArgs = [
		"scp",
		"-P",
		String(opts.sshOptions.port),
		...(opts.sshOptions.sshKey ? ["-i", opts.sshOptions.sshKey] : []),
		opts.manifest.binaryPath,
		`${opts.sshOptions.user}@${opts.sshOptions.host}:${remoteTmp}`,
	];
	const verifyCommand = buildSshCommand(opts.sshOptions, `chmod +x ${remoteTmp} && mv ${remoteTmp} ${remoteFinal}`);
	return { scpArgs, verifyCommand };
}
