import type { SyncTarget } from "../config/types";
import type { CommandResult, SshCommand, SshOptions } from "./types";

/** Build SSH base args from target config */
export function buildSshArgs(opts: SshOptions): string[] {
	const keyArgs = opts.sshKey ? ["-i", opts.sshKey] : [];
	return [
		"ssh",
		"-o",
		"StrictHostKeyChecking=accept-new",
		"-o",
		`ConnectTimeout=${opts.connectTimeout}`,
		"-p",
		String(opts.port),
		...keyArgs,
		`${opts.user}@${opts.host}`,
	];
}

/** Build an SSH command to execute a remote command string */
export function buildSshCommand(opts: SshOptions, remoteCmd: string): SshCommand {
	return {
		args: [...buildSshArgs(opts), remoteCmd],
		description: `SSH: ${remoteCmd}`,
	};
}

/** Extract SshOptions from SyncTarget */
export function sshOptionsFromTarget(target: SyncTarget): SshOptions {
	return {
		host: target.host,
		user: target.user,
		port: target.port,
		sshKey: target.sshKey,
		connectTimeout: 10,
	};
}

/** Execute an SSH command via Bun shell. Returns CommandResult. */
export async function execSsh(command: SshCommand): Promise<CommandResult> {
	const result = Bun.spawnSync(command.args, {
		stdout: "pipe",
		stderr: "pipe",
	});
	const stdout = result.stdout.toString();
	const stderr = result.stderr.toString();
	const commandResult: CommandResult = {
		exitCode: result.exitCode,
		stdout,
		stderr,
	};

	if (result.exitCode !== 0) {
		throw new Error(`${command.description} failed: ${stderr || stdout || `exit code ${result.exitCode}`}`);
	}

	return commandResult;
}
