import type { SocketSessionRegistry } from "../../socket";
import type { AuthContext } from "../bot/auth";
import type { ProcessManager } from "../process-manager";

function formatUptime(durationMs: number): string {
	const minutes = Math.max(0, Math.floor(durationMs / 60_000));
	if (minutes < 60) {
		return `${minutes}m`;
	}

	const hours = Math.floor(minutes / 60);
	const remainingMinutes = minutes % 60;
	return `${hours}h ${remainingMinutes}m`;
}

function eventKindLabel(kind: string): string {
	switch (kind) {
		case "plan_approval":
			return "Plan approval";
		case "ask":
			return "Question";
		case "pending_action":
			return "Action";
		case "hook_selector":
			return "Selection";
		case "hook_input":
			return "Input";
		default:
			return kind;
	}
}

export function formatSessionList(registry: SocketSessionRegistry | undefined, processManager: ProcessManager): string {
	const tuiSessions = registry?.getActive() ?? [];
	const telegramSessions = processManager.getAllSessions();
	if (tuiSessions.length === 0 && telegramSessions.length === 0) {
		return "No active sessions.";
	}

	const total = tuiSessions.length + telegramSessions.length;
	const lines: string[] = [`Sessions (${total} active)`, ""];

	for (const session of tuiSessions) {
		const uptime = formatUptime(Date.now() - session.startedAt);
		const status = session.currentBlockingEvent
			? `${eventKindLabel(session.currentBlockingEvent.kind)} pending`
			: "Active";
		lines.push(`[TUI] spell @ ${session.cwd}`);
		lines.push(`  Mode: ${session.mode} | Up: ${uptime}`);
		lines.push(`  Status: ${status}`);
		lines.push("");
	}

	for (const session of telegramSessions) {
		const uptime = formatUptime(Date.now() - session.createdAt);
		lines.push(`[TG] ${session.project} @ ${session.cwd}`);
		lines.push(`  Mode: ${session.mode} | Up: ${uptime}`);
		lines.push(`  Status: Active`);
		lines.push("");
	}

	while (lines.at(-1) === "") {
		lines.pop();
	}
	return lines.join("\n");
}

export async function handleSessionsCommand(
	ctx: AuthContext,
	registry: SocketSessionRegistry | undefined,
	processManager: ProcessManager,
): Promise<void> {
	await ctx.reply(formatSessionList(registry, processManager));
}
