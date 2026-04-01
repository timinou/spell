import { formatDuration } from "@oh-my-pi/pi-utils";
import type { AgentRetryState } from "./types";

export function formatRetryStatus(retry: AgentRetryState): string {
	const waitSuffix = retry.delayMs > 0 ? ` in ${formatDuration(retry.delayMs)}` : "";
	const errorMessage = retry.errorMessage.trim();
	if (!errorMessage) {
		return `Retrying (${retry.attempt}/${retry.maxAttempts})${waitSuffix}`;
	}
	return `Retrying (${retry.attempt}/${retry.maxAttempts})${waitSuffix} — ${errorMessage}`;
}
