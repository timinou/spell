import { buildSshArgs } from "../sync/ssh";
import { buildQuotedPath } from "../sync/utils";
import type { SecretPushOptions } from "./types";

/** Build command to push secrets via SSH stdin (no plaintext on disk during transfer) */
export function buildSecretPushCommand(opts: SecretPushOptions): {
	args: string[];
	stdin: string;
	description: string;
} {
	const quotedTmp = buildQuotedPath(`${opts.remotePath}.tmp`);
	const quotedPath = buildQuotedPath(opts.remotePath);
	const remoteScript = `cat > ${quotedTmp} && chmod 600 ${quotedTmp} && mv ${quotedTmp} ${quotedPath}`;
	return {
		args: [...buildSshArgs(opts.sshOptions), remoteScript],
		stdin: opts.envContent,
		description: `Push secrets to ${opts.remotePath}`,
	};
}

/** Execute secret push: pipe decrypted env to remote via SSH stdin */
export async function executeSecretPush(opts: SecretPushOptions): Promise<void> {
	const cmd = buildSecretPushCommand(opts);
	const proc = Bun.spawn(cmd.args, {
		stdin: "pipe",
		stdout: "pipe",
		stderr: "pipe",
	});

	proc.stdin.write(cmd.stdin);
	proc.stdin.end();

	const exitCode = await proc.exited;
	if (exitCode !== 0) {
		const stderr = await new Response(proc.stderr).text();
		throw new Error(`${cmd.description} failed: ${stderr}`);
	}
}
