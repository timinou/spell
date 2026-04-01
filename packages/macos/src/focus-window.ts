import { logger } from "@oh-my-pi/pi-utils";
import { $ } from "bun";

/**
 * Focus a terminal window by PID using osascript on macOS.
 * Uses System Events to bring the process to front.
 * Falls back gracefully if the process is gone.
 */
export async function focusTerminalByPid(pid: number): Promise<boolean> {
	if (process.platform !== "darwin") {
		logger.debug("focusTerminalByPid: not on macOS, skipping");
		return false;
	}
	const result =
		await $`osascript -e 'tell application "System Events" to set frontmost of (first process whose unix id is ${pid}) to true'`
			.quiet()
			.nothrow();
	if (result.exitCode !== 0) {
		logger.debug("focusTerminalByPid: osascript failed", { pid, exitCode: result.exitCode });
		return false;
	}
	return true;
}
