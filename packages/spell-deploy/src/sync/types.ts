import type { SyncSettings, SyncTarget } from "../config/types";

export interface SshOptions {
	host: string;
	user: string;
	port: number;
	sshKey?: string;
	/** Connection timeout in seconds */
	connectTimeout: number;
}

export interface RsyncArgs {
	/** Full rsync command args array */
	args: string[];
	/** Human-readable description */
	description: string;
}

export interface SshCommand {
	/** SSH command args array */
	args: string[];
	/** Human-readable description */
	description: string;
}

/** Describes the sequence of commands for an atomic push */
export interface AtomicSwapPlan {
	/** rsync local files to staging dir on remote */
	rsyncToStaging: RsyncArgs;
	/** SSH commands: mkdir staging, mv current to .old, mv staging to current, rm .old */
	swapCommands: SshCommand[];
}

export interface PushOptions {
	target: SyncTarget;
	/** Local project root */
	localRoot: string;
	/** Dry-run: build commands but don't execute */
	dryRun: boolean;
}

export interface PullOptions {
	target: SyncTarget;
	sync: SyncSettings;
	/** Local project root */
	localRoot: string;
	dryRun: boolean;
}

export interface CommandResult {
	exitCode: number;
	stdout: string;
	stderr: string;
}
