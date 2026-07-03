import * as fs from "node:fs/promises";
import * as path from "node:path";
import { type SessionStatusFile, STATUS_DIR, StatusFileReader } from "@spell/pi-desktop-common";
import { Command, Flags } from "@spell/pi-utils/cli";

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
		/^[A-Za-z0-9_-]+$/.test(session.sessionId) &&
		typeof session.cwd === "string" &&
		session.cwd.length > 0
	);
}

function formatSessionLabel(session: SessionStatusFile): string {
	return `${session.projectName}: ${session.sessionTitle || "(untitled)"}`;
}

function formatGhosttyCommandValue(session: RecoverableStatusSession): string {
	return `spell -r ${session.sessionId}`;
}

function formatSpawnCommand(session: RecoverableStatusSession, direct = false): string {
	if (direct) {
		return `ghostty --working-directory=${shellQuote(session.cwd)} --title=${shellQuote(formatSessionLabel(session))} -e spell -r ${shellQuote(session.sessionId)}`;
	}
	return `ghostty +new-window --working-directory=${shellQuote(session.cwd)} --title=${shellQuote(formatSessionLabel(session))} --command=${shellQuote(formatGhosttyCommandValue(session))}`;
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

function writeCleanupSummary(cleanedStale: number, options: { includeZero?: boolean; dryRun?: boolean } = {}): void {
	if (cleanedStale > 0) {
		const verb = options.dryRun ? "Dry run — would clean" : "Cleaned";
		process.stdout.write(`${verb} ${cleanedStale} stale status file(s).\n`);
		return;
	}
	if (options.includeZero) {
		process.stdout.write("No stale status files to clean.\n");
	}
}

function writeManualFallbackInstructions(groups: RecoveryGroup[]): void {
	process.stdout.write(
		"\nIf you see an empty shell instead of a recovered session, re-run with --direct or run one of these commands manually:\n",
	);
	for (const group of groups) {
		for (const { session } of group.sessions) {
			process.stdout.write(`  ${formatManualResumeCommand(session)}\n`);
		}
	}
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

function buildSpawnArgs(session: RecoverableStatusSession, direct: boolean): string[] {
	// Stamp the identity token into the initial window title so the desktop layer
	// can join this window to its session immediately, even in the moment before
	// the recovered spell process starts and re-emits its own titled OSC. Matches
	// the producer format in title-generator (`⟨<sessionId>⟩`).
	const title = `${formatSessionLabel(session)} ⟨${session.sessionId}⟩`;
	if (direct) {
		return [
			"ghostty",
			`--working-directory=${session.cwd}`,
			`--title=${title}`,
			"-e",
			"spell",
			"-r",
			session.sessionId,
		];
	}
	return [
		"ghostty",
		"+new-window",
		`--working-directory=${session.cwd}`,
		`--title=${title}`,
		`--command=${formatGhosttyCommandValue(session)}`,
	];
}

async function spawnRecoveredSession(session: RecoverableStatusSession, direct: boolean): Promise<boolean> {
	try {
		const proc = Bun.spawn(buildSpawnArgs(session, direct), {
			stdin: "ignore",
			stdout: direct ? "ignore" : "pipe",
			stderr: direct ? "ignore" : "pipe",
			windowsHide: true,
		});
		if (direct) {
			const settled = await Promise.race([
				proc.exited.then(code => code),
				Bun.sleep(200).then(() => "running" as const),
			]);
			return settled === "running" || settled === 0;
		}
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
		direct: Flags.boolean({
			description: "Launch standalone Ghostty processes instead of using +new-window IPC",
		}),
		clean: Flags.boolean({ description: "Remove stale status files without recovery metadata" }),
	};

	async run(): Promise<void> {
		const { flags } = await this.parse(RecoverCommand);
		const reader = new StatusFileReader();
		if (flags.clean) {
			if (flags["dry-run"]) {
				const staleCount = (await reader.readCrashed()).filter(session => !isRecoverableSession(session)).length;
				writeCleanupSummary(staleCount, { includeZero: true, dryRun: true });
				return;
			}
			writeCleanupSummary(await reader.cleanStale(), { includeZero: true });
			return;
		}

		const crashed = await reader.readCrashed();
		if (crashed.length === 0) {
			process.stdout.write("No crashed sessions to recover.\n");
			return;
		}

		const recoverable: RecoverableSession[] = [];
		let skippedMissingMetadata = 0;
		for (const session of crashed) {
			if (!isRecoverableSession(session)) {
				skippedMissingMetadata += 1;
				continue;
			}
			recoverable.push({
				session,
				statusFilePath: path.join(STATUS_DIR, `${session.windowId}.json`),
			});
		}

		if (recoverable.length === 0) {
			process.stdout.write("No recoverable crashed sessions found.\n");
			if (flags["dry-run"]) {
				writeCleanupSummary(skippedMissingMetadata, { includeZero: true, dryRun: true });
				return;
			}
			writeCleanupSummary(await reader.cleanStale());
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
				? flags.direct
					? "planned direct recovery commands"
					: "planned recovery commands"
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
						`${ghosttyAvailable ? formatSpawnCommand(session, flags.direct) : formatManualResumeCommand(session)}\n`,
					);
				}
			}
			if (skippedMissingMetadata > 0) {
				process.stdout.write(
					`\nWould clean ${skippedMissingMetadata} stale status file(s) missing recovery metadata during a real recovery run.\n`,
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
			writeCleanupSummary(await reader.cleanStale());
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
				const spawned = await spawnRecoveredSession(session, flags.direct === true);
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
		writeCleanupSummary(await reader.cleanStale());
		writeManualFallbackInstructions(groups);
	}
}
