import { type AssistantMessage, formatToolCallStreamDiagnosticMessage } from "@spell/pi-ai";

const RETRY_ATTEMPT_PREFIX_REGEX = /^(Attempt|Final attempt) \d+(?:\/\d+)? failed(?:; retrying\.|\.) /;

function getBaseAssistantFailureMessage(message: AssistantMessage): string | undefined {
	const diagnostic = message.streamDiagnostics?.at(-1);
	if (!diagnostic) {
		return message.errorMessage;
	}
	return formatToolCallStreamDiagnosticMessage(diagnostic);
}

function hasRetryAttemptContext(errorMessage: string | undefined): errorMessage is string {
	return typeof errorMessage === "string" && RETRY_ATTEMPT_PREFIX_REGEX.test(errorMessage);
}

export function isRetryableAssistantStreamError(message: AssistantMessage): boolean {
	const state = message.streamDiagnostics?.at(-1)?.state;
	return state !== undefined && state !== "completed_tool_call_missing_trailing_stop";
}

export function formatRetryableAssistantErrorMessage(
	message: AssistantMessage,
	options: { attempt: number; maxAttempts: number | undefined; final: boolean },
): string {
	const baseMessage = getBaseAssistantFailureMessage(message) ?? message.errorMessage ?? "Unknown error";
	// `maxAttempts === undefined` ⇒ infinite retry (rate-limit/overloaded): omit the denominator.
	const counter = options.maxAttempts === undefined ? `${options.attempt}` : `${options.attempt}/${options.maxAttempts}`;
	const prefix = options.final
		? `Final attempt ${counter} failed. `
		: `Attempt ${counter} failed; retrying. `;
	return `${prefix}${baseMessage}`;
}

export function formatAssistantToolCallFailureMessage(message: AssistantMessage): string | undefined {
	const diagnostic = message.streamDiagnostics?.at(-1);
	if (!diagnostic) {
		return message.errorMessage;
	}
	const headline = hasRetryAttemptContext(message.errorMessage)
		? message.errorMessage
		: formatToolCallStreamDiagnosticMessage(diagnostic);
	const lines = [headline];
	if (diagnostic.rawPartialJsonArtifact?.uri) {
		lines.push(`Raw stalled tool JSON: ${diagnostic.rawPartialJsonArtifact.uri}`);
	}
	return lines.join("\n");
}
