import { formatDuration } from "@spell/pi-utils";
import type { AgentRetryState } from "./types";

export function formatRetryStatus(retry: AgentRetryState): string {
	const waitSuffix = retry.delayMs > 0 ? ` in ${formatDuration(retry.delayMs)}` : "";
	// `maxAttempts === undefined` ⇒ infinite mode: show attempt count without a denominator.
	const attemptLabel = retry.maxAttempts === undefined ? `${retry.attempt}` : `${retry.attempt}/${retry.maxAttempts}`;
	const errorMessage = retry.errorMessage.trim();
	if (!errorMessage) {
		return `Retrying (${attemptLabel})${waitSuffix}`;
	}
	return `Retrying (${attemptLabel})${waitSuffix} — ${errorMessage}`;
}
