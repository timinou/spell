import type { AgentSessionEvent } from "../session/agent-session";
import type { CustomMessage } from "../session/messages";
import type { CodeSearchSource } from "../web/search/code-search";
import type { SearchSource } from "../web/search/types";
import type { FindingSourceType } from "./browse-findings";
import { type BrowseFinding, createFinding, parseBrowseFinding } from "./browse-findings";
import { SessionEventMapper } from "./qml-event-mapper";

export interface BrowseTabEvent {
	action: "tab:open" | "tab:close" | "tab:list" | "tab:switch";
	tabId: string;
	title?: string;
	url?: string;
}

const INTERCEPTED_TOOLS = new Set(["web_search", "fetch", "code_search"]);

interface PendingToolCall {
	toolName: string;
	args: Record<string, unknown>;
}

interface ToolResultDetails {
	response?: { sources?: unknown[] };
	error?: string;
	finalUrl?: string;
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

/** Extract domain from a URL for use as fallback title. */
function domainFromUrl(url: string): string {
	const match = /^[a-z]+:\/\/([^/]+)/i.exec(url);
	return match ? match[1] : url;
}

export class BrowseEventMapper extends SessionEventMapper {
	onAdditionalEvent?: (event: Record<string, unknown>) => void;
	#pendingToolCalls = new Map<string, PendingToolCall>();

	map(event: AgentSessionEvent): Record<string, unknown> | null {
		if (event.type === "tool_execution_start") {
			this.#pendingToolCalls.set(event.toolCallId, {
				toolName: event.toolName,
				args: (event.args as Record<string, unknown>) ?? {},
			});
			return super.map(event);
		}

		if (event.type === "tool_execution_end") {
			const pending = this.#pendingToolCalls.get(event.toolCallId);
			this.#pendingToolCalls.delete(event.toolCallId);

			if (pending && INTERCEPTED_TOOLS.has(pending.toolName) && !event.isError) {
				this.#extractToolFindings(event, pending);
			}
			return super.map(event);
		}

		if (event.type === "agent_end") {
			this.#pendingToolCalls.clear();
			return super.map(event);
		}

		if (event.type === "message_end" && isCustomFindingMessage(event.message)) {
			const finding = findingFromMessage(event.message);
			if (finding) {
				finding.curated = true;
				return this.emitFinding(finding);
			}
		}
		return super.map(event);
	}

	#extractToolFindings(event: AgentSessionEvent & { type: "tool_execution_end" }, pending: PendingToolCall): void {
		const result = event.result as
			| { content?: Array<{ type: string; text?: string }>; details?: unknown }
			| undefined;
		if (!result) return;

		switch (pending.toolName) {
			case "web_search":
				this.#extractSearchFindings(result, pending.args, event.toolCallId);
				break;
			case "code_search":
				this.#extractCodeSearchFindings(result);
				break;
			case "fetch":
				this.#extractFetchFinding(result);
				break;
		}
	}

	#extractSearchFindings(result: { details?: unknown }, args: Record<string, unknown>, toolCallId: string): void {
		const details = result.details as ToolResultDetails | undefined;
		if (!details || details.error || !Array.isArray(details.response?.sources)) return;

		const findings: BrowseFinding[] = [];
		for (const raw of details.response!.sources) {
			const source = raw as SearchSource;
			if (!source.url) continue;
			findings.push(
				createFinding({
					url: source.url,
					title: source.title,
					excerpt: source.snippet,
					sourceType: "search" as FindingSourceType,
					curated: false,
					enriched: false,
				}),
			);
		}

		this.onAdditionalEvent?.({
			type: "findings_batch",
			findings,
			searchGroup: { query: (args.query as string) ?? "", toolCallId },
		});
	}

	#extractCodeSearchFindings(result: { details?: unknown }): void {
		const details = result.details as ToolResultDetails | undefined;
		if (!details || details.error || !Array.isArray(details.response?.sources)) return;

		const findings: BrowseFinding[] = [];
		for (const raw of details.response!.sources) {
			const source = raw as CodeSearchSource;
			if (!source.url) continue;
			const title = source.title || `${source.repository}/${source.path}`;
			findings.push(
				createFinding({
					url: source.url,
					title,
					excerpt: source.snippet,
					sourceType: "code_search" as FindingSourceType,
					curated: false,
					enriched: false,
				}),
			);
		}

		this.onAdditionalEvent?.({
			type: "findings_batch",
			findings,
			searchGroup: null,
		});
	}

	#extractFetchFinding(result: { content?: Array<{ type: string; text?: string }>; details?: unknown }): void {
		const details = result.details as ToolResultDetails | undefined;
		const url = details?.finalUrl || details?.url;
		if (!url) return;

		const text = result.content?.[0]?.text;
		const contentBody = text ? text.slice(0, 10240) : undefined;
		const title = domainFromUrl(url);

		const finding = createFinding({
			url,
			title,
			sourceType: "fetch" as FindingSourceType,
			curated: false,
			enriched: false,
			contentBody,
		});

		this.onAdditionalEvent?.({
			type: "findings_batch",
			findings: [finding],
			searchGroup: null,
		});
	}

	emitFinding(finding: BrowseFinding): Record<string, unknown> {
		return {
			type: "finding",
			...finding,
			curated: true,
		};
	}

	emitTabEvent(event: BrowseTabEvent): Record<string, unknown> {
		return { ...event };
	}
}
