import * as fs from "node:fs/promises";
import * as path from "node:path";
import { type SessionStatusFile, STATUS_DIR, StatusFileReader } from "@oh-my-pi/pi-desktop-common";
import { Command, Flags } from "@oh-my-pi/pi-utils/cli";

interface RecoverableStatusSession extends SessionStatusFile {
	sessionId: string;
	cwd: string;
}

interface RecoverableSession {
	session: RecoverableStatusSession;
	statusFilePath: string;
}

interface RecoveryGroup {
	workspaceName: string | null;
	sessions: RecoverableSession[];
}

function shellQuote(value: string): string {
	if (value.length === 0) return "''";
	if (/^[A-Za-z0-9_\-.,/:=@]+$/.test(value)) return value;
	return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function isRecoverableSession(session: SessionStatusFile): session is RecoverableStatusSession {
	return (
		typeof session.sessionId === "string" &&
		session.sessionId.length > 0 &&
		typeof session.cwd === "string" &&
		session.cwd.length > 0
	);
}

function formatSessionLabel(session: SessionStatusFile): string {
	return `${session.projectName}: ${session.sessionTitle || "(untitled)"}`;
}

function formatSpawnCommand(session: RecoverableStatusSession): string {
	return `ghostty +new-window --working-directory=${shellQuote(session.cwd)} -e spell -r ${shellQuote(session.sessionId)}`;
}

function formatManualResumeCommand(session: RecoverableStatusSession): string {
	return `cd ${shellQuote(session.cwd)} && spell -r ${shellQuote(session.sessionId)}`;
}

function formatWorkspaceCommand(workspaceName: string): string {
	return `niri msg action focus-workspace ${shellQuote(workspaceName)}`;
}

function commandExists(command: string): boolean {
	return Boolean(Bun.which(command));
}

async function activateWorkspace(workspaceName: string): Promise<boolean> {
	try {
		const proc = Bun.spawn(["niri", "msg", "action", "focus-workspace", workspaceName], {
			stdin: "ignore",
			stdout: "pipe",
			stderr: "pipe",
			windowsHide: true,
		});
		return (await proc.exited) === 0;
	} catch {
		return false;
	}
}

async function spawnRecoveredSession(session: RecoverableStatusSession): Promise<boolean> {
	try {
		const proc = Bun.spawn(
			["ghostty", "+new-window", `--working-directory=${session.cwd}`, "-e", "spell", "-r", session.sessionId],
			{
				stdin: "ignore",
				stdout: "pipe",
				stderr: "pipe",
				windowsHide: true,
			},
		);
		return (await proc.exited) === 0;
	} catch {
		return false;
	}
}

function groupByWorkspace(sessions: RecoverableSession[]): RecoveryGroup[] {
	const groups = new Map<string | null, RecoverableSession[]>();
	for (const session of sessions) {
		const key = session.session.workspaceName ?? null;
		const group = groups.get(key);
		if (group) {
			group.push(session);
			continue;
		}
		groups.set(key, [session]);
	}
	return [...groups.entries()].map(([workspaceName, grouped]) => ({ workspaceName, sessions: grouped }));
}

export default class RecoverCommand extends Command {
	static description = "Recover crashed Spell sessions";

	static flags = {
		"dry-run": Flags.boolean({ description: "Preview recovery without spawning windows" }),
		"no-workspace": Flags.boolean({ description: "Skip niri workspace activation" }),
	};

	async run(): Promise<void> {
		const { flags } = await this.parse(RecoverCommand);
		const crashed = await new StatusFileReader().readCrashed();

		if (crashed.length === 0) {
			process.stdout.write("No crashed sessions to recover.\n");
			return;
		}

		const recoverable: RecoverableSession[] = [];
		let skippedMissingMetadata = 0;
		for (const session of crashed) {
			if (!isRecoverableSession(session)) {
				skippedMissingMetadata += 1;
				process.stderr.write(
					`Warning: skipping stale status file for window ${session.windowId} (${formatSessionLabel(session)}) because recovery metadata is incomplete.\n`,
				);
				continue;
			}
			recoverable.push({
				session,
				statusFilePath: path.join(STATUS_DIR, `${session.windowId}.json`),
			});
		}

		if (recoverable.length === 0) {
			process.stdout.write("No recoverable crashed sessions found.\n");
			return;
		}

		const ghosttyAvailable = commandExists("ghostty");
		const niriAvailable = !flags["no-workspace"] && commandExists("niri");
		const groups = groupByWorkspace(recoverable);

		process.stdout.write(`Found ${recoverable.length} recoverable crashed session(s):\n`);
		for (const group of groups) {
			process.stdout.write(`\nWorkspace ${group.workspaceName ?? "(unnamed)"}:\n`);
			for (const { session } of group.sessions) {
				process.stdout.write(`  - ${formatSessionLabel(session)}\n`);
			}
		}
		process.stdout.write("\n");

		if (flags["dry-run"]) {
			const spawnMode = ghosttyAvailable
				? "planned recovery commands"
				: "manual fallback commands (ghostty not found)";
			process.stdout.write(`Dry run — showing ${spawnMode}:\n`);
			if (flags["no-workspace"]) {
				process.stdout.write("(--no-workspace: workspace commands omitted)\n");
			} else if (!niriAvailable) {
				process.stdout.write("(niri not found: workspace commands omitted)\n");
			}
			for (const group of groups) {
				if (group.workspaceName && niriAvailable) {
					process.stdout.write(`${formatWorkspaceCommand(group.workspaceName)}\n`);
				}
				for (const { session } of group.sessions) {
					process.stdout.write(
						`${ghosttyAvailable ? formatSpawnCommand(session) : formatManualResumeCommand(session)}\n`,
					);
				}
			}
			if (skippedMissingMetadata > 0) {
				process.stdout.write(
					`\nSkipped ${skippedMissingMetadata} stale status file(s) missing recovery metadata.\n`,
				);
			}
			return;
		}

		if (!ghosttyAvailable) {
			process.stderr.write("ghostty not found; printing manual resume commands instead.\n");
			for (const group of groups) {
				for (const { session } of group.sessions) {
					process.stdout.write(`${formatManualResumeCommand(session)}\n`);
				}
			}
			if (skippedMissingMetadata > 0) {
				process.stdout.write(`Skipped ${skippedMissingMetadata} stale status file(s) missing recovery metadata.\n`);
			}
			return;
		}

		if (!flags["no-workspace"] && !niriAvailable) {
			process.stderr.write("niri not found; recovering sessions without workspace restoration.\n");
		}

		const recovered: string[] = [];
		let failedCount = 0;
		for (const group of groups) {
			if (group.workspaceName && niriAvailable) {
				const focused = await activateWorkspace(group.workspaceName);
				if (!focused) {
					process.stderr.write(`Warning: unable to focus workspace ${group.workspaceName}; continuing.\n`);
				} else {
					await Bun.sleep(200);
				}
			}
			for (const { session, statusFilePath } of group.sessions) {
				const spawned = await spawnRecoveredSession(session);
				if (!spawned) {
					failedCount += 1;
					process.stderr.write(`Warning: failed to recover ${formatSessionLabel(session)}.\n`);
					continue;
				}
				recovered.push(statusFilePath);
				process.stdout.write(`Recovered ${formatSessionLabel(session)}.\n`);
				await Bun.sleep(300);
			}
		}

		for (const filePath of recovered) {
			await fs.rm(filePath, { force: true }).catch(() => {});
		}

		process.stdout.write(`Recovered ${recovered.length} session(s).\n`);
		if (failedCount > 0) {
			process.stderr.write(
				`Recovery failed for ${failedCount} session(s); their status files were left in place.\n`,
			);
		}
		if (skippedMissingMetadata > 0) {
			process.stdout.write(`Skipped ${skippedMissingMetadata} stale status file(s) missing recovery metadata.\n`);
		}
	}
}
