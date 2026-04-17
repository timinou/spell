import { logger, ptree } from "@oh-my-pi/pi-utils";
import { getRetainedSpillBudget, resolveToolSpillPolicy, type SpillPolicy } from "../session/spill-policy";
import { OutputSink } from "../session/streaming-output";
import { buildRemoteCommand, ensureConnection, ensureHostInfo, type SSHConnectionTarget } from "./connection-manager";
import { hasSshfs, mountRemote } from "./sshfs-mount";

export interface SSHExecutorOptions {
	/** Timeout in milliseconds */
	timeout?: number;
	/** Callback for streaming output chunks (already sanitized) */
	onChunk?: (chunk: string) => void;
	/** AbortSignal for cancellation */
	signal?: AbortSignal;
	/** Remote path to mount when sshfs is available */
	remotePath?: string;
	/** Wrap commands in a POSIX shell for compat mode */
	compatEnabled?: boolean;
	/** Artifact path/URI for full output storage */
	artifactPath?: string;
	artifactUri?: string;
	spillPolicy?: SpillPolicy;
}

export interface SSHResult {
	/** Combined stdout + stderr output (sanitized, possibly truncated) */
	output: string;
	/** Process exit code (undefined if killed/cancelled) */
	exitCode: number | undefined;
	/** Whether the command was cancelled via signal */
	cancelled: boolean;
	/** Whether the output was truncated */
	truncated: boolean;
	/** Total number of lines in the output stream */
	totalLines: number;
	/** Total number of bytes in the output stream */
	totalBytes: number;
	/** Number of lines included in the output text */
	outputLines: number;
	/** Number of bytes included in the output text */
	outputBytes: number;
	/** Artifact URI if full output was saved to artifact storage */
	artifactUri?: string;
}

function quoteForCompatShell(command: string): string {
	if (command.length === 0) {
		return "''";
	}
	const escaped = command.replace(/'/g, "'\\''");
	return `'${escaped}'`;
}

function buildCompatCommand(shell: "bash" | "sh", command: string): string {
	return `${shell} -c ${quoteForCompatShell(command)}`;
}

export async function executeSSH(
	host: SSHConnectionTarget,
	command: string,
	options?: SSHExecutorOptions,
): Promise<SSHResult> {
	await ensureConnection(host);
	if (hasSshfs()) {
		try {
			await mountRemote(host, options?.remotePath ?? "/");
		} catch (err) {
			logger.warn("SSHFS mount failed", { host: host.name, error: String(err) });
		}
	}

	let resolvedCommand = command;
	if (options?.compatEnabled) {
		const info = await ensureHostInfo(host);
		if (info.compatShell) {
			resolvedCommand = buildCompatCommand(info.compatShell, command);
		} else {
			logger.warn("SSH compat enabled without detected compat shell", { host: host.name });
		}
	}

	const spillPolicy = options?.spillPolicy ?? resolveToolSpillPolicy({ toolName: "ssh" });
	const retainedBudget = getRetainedSpillBudget(spillPolicy);
	const sink = new OutputSink({
		onChunk: options?.onChunk,
		artifactPath: options?.artifactPath,
		artifactUri: options?.artifactUri,
		spillThresholdBytes: spillPolicy.trigger.maxBytes,
		spillThresholdLines: spillPolicy.trigger.maxLines,
		retainMaxBytes: retainedBudget.maxBytes,
		retainMaxLines: retainedBudget.maxLines,
	});
	const dump = async (success: boolean, notice?: string) => {
		const budget = success ? spillPolicy.success : spillPolicy.failure;
		return await sink.dump({ notice, maxBytes: budget.maxBytes, maxLines: budget.maxLines });
	};

	using child = ptree.spawn(["ssh", ...(await buildRemoteCommand(host, resolvedCommand))], {
		signal: options?.signal,
		timeout: options?.timeout,
		stdin: "pipe",
		stderr: "full",
	});

	const streams = [child.stdout.pipeTo(sink.createInput())];
	if (child.stderr) {
		streams.push(child.stderr.pipeTo(sink.createInput()));
	}
	await Promise.allSettled(streams).catch(() => {});

	try {
		const exitCode = await child.exited;
		return {
			exitCode,
			cancelled: false,
			...(await dump(exitCode === 0)),
		};
	} catch (err) {
		if (err instanceof ptree.Exception) {
			if (err instanceof ptree.TimeoutError) {
				return {
					exitCode: undefined,
					cancelled: true,
					...(await dump(false, `SSH: ${err.message}`)),
				};
			}
			if (err.aborted) {
				return {
					exitCode: undefined,
					cancelled: true,
					...(await dump(false, `Command aborted: ${err.message}`)),
				};
			}
			return {
				exitCode: err.exitCode,
				cancelled: false,
				...(await dump(false, `Unexpected error: ${err.message}`)),
			};
		}
		throw err;
	}
}
