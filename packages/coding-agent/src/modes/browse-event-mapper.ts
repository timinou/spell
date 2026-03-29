import type { AgentSessionEvent } from "../session/agent-session";
import type { CustomMessage } from "../session/messages";
import { type BrowseFinding, createFinding, parseBrowseFinding } from "./browse-findings";
import { SessionEventMapper } from "./qml-event-mapper";

export interface BrowseTabEvent {
	action: "tab:open" | "tab:close" | "tab:list" | "tab:switch";
	tabId: string;
	title?: string;
	url?: string;
}

function isCustomFindingMessage(message: unknown): message is CustomMessage<unknown> {
	return (
		typeof message === "object" &&
		message !== null &&
		"role" in message &&
		(message as { role?: string }).role === "custom" &&
		"customType" in message &&
		(message as { customType?: string }).customType === "finding"
	);
}

function findingFromMessage(message: CustomMessage<unknown>): BrowseFinding | null {
	const parsedDetails = parseBrowseFinding(message.details);
	if (parsedDetails) {
		return parsedDetails;
	}
	if (typeof message.content === "string") {
		const url = message.content.trim();
		if (url.length > 0) {
			return createFinding({
				url,
				title: url,
				timestamp: message.timestamp,
			});
		}
	}
	return null;
}

export class BrowseEventMapper extends SessionEventMapper {
	map(event: AgentSessionEvent): Record<string, unknown> | null {
		if (event.type === "message_end" && isCustomFindingMessage(event.message)) {
			const finding = findingFromMessage(event.message);
			if (finding) {
				return this.emitFinding(finding);
			}
		}
		return super.map(event);
	}

	emitFinding(finding: BrowseFinding): Record<string, unknown> {
		return {
			type: "finding",
			...finding,
		};
	}

	emitTabEvent(event: BrowseTabEvent): Record<string, unknown> {
		return { ...event };
	}
}
