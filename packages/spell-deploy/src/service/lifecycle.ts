import { buildSshArgs, buildSshCommand, execSsh } from "../sync/ssh";
import type { SshCommand, SshOptions } from "../sync/types";
import type { ServiceAction } from "./types";

/** Build systemctl command for a service action */
export function buildServiceCommand(sshOptions: SshOptions, unitName: string, action: ServiceAction): SshCommand {
	return buildSshCommand(sshOptions, `sudo systemctl ${action} ${unitName}`);
}

/** Execute a service action on remote */
export async function serviceAction(sshOptions: SshOptions, unitName: string, action: ServiceAction): Promise<void> {
	const cmd = buildServiceCommand(sshOptions, unitName, action);
	await execSsh(cmd);
}

/** Build command to install unit file on remote */
export function buildInstallUnitCommand(
	sshOptions: SshOptions,
	unitContent: string,
	unitName: string,
): {
	args: string[];
	stdin: string;
	description: string;
} {
	const remotePath = `/etc/systemd/system/${unitName}.service`;
	const remoteScript = `sudo tee ${remotePath} > /dev/null && sudo systemctl daemon-reload`;
	return {
		args: [...buildSshArgs(sshOptions), remoteScript],
		stdin: unitContent,
		description: `Install systemd unit ${unitName}`,
	};
}
