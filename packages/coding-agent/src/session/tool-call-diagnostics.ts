import { type AssistantMessage, formatToolCallStreamDiagnosticMessage } from "@oh-my-pi/pi-ai";

export function formatAssistantToolCallFailureMessage(message: AssistantMessage): string | undefined {
	const diagnostic = message.streamDiagnostics?.at(-1);
	if (!diagnostic) {
		return message.errorMessage;
	}
	const lines = [formatToolCallStreamDiagnosticMessage(diagnostic)];
	if (diagnostic.rawPartialJsonArtifact?.uri) {
		lines.push(`Raw stalled tool JSON: ${diagnostic.rawPartialJsonArtifact.uri}`);
	}
	return lines.join("\n");
}
