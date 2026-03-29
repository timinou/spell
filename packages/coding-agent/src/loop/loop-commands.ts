import type { LoopManager } from "./loop-manager";

export async function executeLoopCommand(manager: LoopManager, text: string): Promise<string> {
	const parts = text.trim().split(/\s+/).filter(Boolean);
	const command = parts[0] ?? "status";
	const args = parts.slice(1);
	const result = await manager.handleCommand(command, args);
	return result.message;
}
