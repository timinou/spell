/**
 * Custom message types and transformers for the coding agent.
 *
 * Extends the base AgentMessage type with coding-agent specific message types,
 * and provides a transformer to convert them to LLM-compatible messages.
 */
import type { AgentMessage } from "@spell/pi-agent-core";
import type {
	ImageContent,
	Message,
	MessageAttribution,
	ProviderPayload,
	TextContent,
	ToolResultMessage,
} from "@spell/pi-ai";
import { renderPromptTemplate } from "../config/prompt-templates";
import branchSummaryContextPrompt from "../prompts/compaction/branch-summary-context.md" with { type: "text" };
import compactionSummaryContextPrompt from "../prompts/compaction/compaction-summary-context.md" with { type: "text" };
import { getContextPressureSummaryText } from "../tools/context-pressure-policy";
import type { OutputMeta } from "../tools/output-meta";
import { formatOutputNotice } from "../tools/output-meta";

const COMPACTION_SUMMARY_TEMPLATE = compactionSummaryContextPrompt;
const BRANCH_SUMMARY_TEMPLATE = branchSummaryContextPrompt;

export const SKILL_PROMPT_MESSAGE_TYPE = "skill-prompt";

export interface SkillPromptDetails {
	name: string;
	path: string;
	args?: string;
	lineCount: number;
}
export const INTENTION_SUMMARY_MESSAGE_TYPE = "intentionSummary";

export interface IntentionSummaryDetails {
	did: string;
	/** Absent or empty when there is nothing the agent is blocked on. */
	stuck?: string;
	ask: string;
	/** Which blocking-state triggered this briefing. */
	trigger: "needs_input" | "pending_approval";
	/** Origin BlockingEvent.eventId; used by the controller to supersede prior cards. */
	eventId?: string;
	/** True until the smol-model generation resolves; component renders the "summarizing…" state. */
	pending?: boolean;
	/** True once a later briefing supersedes this card; component renders a dimmed historic state. */
	superseded?: boolean;
}

/**
 * Plain-text serialisation of an IntentionSummaryDetails. Used as the `content`
 * argument to SessionManager.appendCustomMessageEntry so that resume paths
 * which strip `details` still produce a readable history line.
 */
export function buildIntentionSummaryContent(details: IntentionSummaryDetails): string {
	const lines = [`DID: ${details.did}`];
	if (details.stuck && details.stuck.length > 0) lines.push(`STUCK: ${details.stuck}`);
	lines.push(`ASK: ${details.ask}`);
	return lines.join("\n");
}
function getPrunedToolResultContent(message: ToolResultMessage): (TextContent | ImageContent)[] {
	if (message.prunedAt === undefined) {
		return message.content;
	}
	const summary = getContextPressureSummaryText(message);
	if (summary) {
		return [{ type: "text", text: summary }];
	}
	const textBlocks = message.content.filter((content): content is TextContent => content.type === "text");
	const text = textBlocks.map(block => block.text).join("") || "[Output truncated]";
	return [{ type: "text", text }];
}

/**
 * Message type for bash executions via the ! command.
 */
export interface BashExecutionMessage {
	role: "bashExecution";
	command: string;
	output: string;
	exitCode: number | undefined;
	cancelled: boolean;
	truncated: boolean;
	meta?: OutputMeta;
	timestamp: number;
	/** If true, this message is excluded from LLM context (!! prefix) */
	excludeFromContext?: boolean;
}

/**
 * Message type for extension-injected messages via sendMessage().
 */
export interface CustomMessage<T = unknown> {
	role: "custom";
	customType: string;
	content: string | (TextContent | ImageContent)[];
	display: boolean;
	details?: T;
	/** Who initiated this message for billing/attribution semantics. */
	attribution?: MessageAttribution;
	timestamp: number;
}

/**
 * Legacy hook message type (pre-extensions). Kept for session migration.
 */
export interface HookMessage<T = unknown> {
	role: "hookMessage";
	customType: string;
	content: string | (TextContent | ImageContent)[];
	display: boolean;
	details?: T;
	/** Who initiated this message for billing/attribution semantics. */
	attribution?: MessageAttribution;
	timestamp: number;
}

export interface BranchSummaryMessage {
	role: "branchSummary";
	summary: string;
	fromId: string;
	timestamp: number;
}

export interface CompactionSummaryMessage {
	role: "compactionSummary";
	summary: string;
	shortSummary?: string;
	tokensBefore: number;
	providerPayload?: ProviderPayload;
	timestamp: number;
}

/**
 * Message type for auto-read file mentions via @filepath syntax.
 */
export interface FileMentionMessage {
	role: "fileMention";
	files: Array<{
		path: string;
		content: string;
		lineCount?: number;
		/** File size in bytes, if known. */
		byteSize?: number;
		/** Why the file contents were omitted from auto-read. */
		skippedReason?: "tooLarge";
		image?: ImageContent;
	}>;
	timestamp: number;
}

// Extend CustomAgentMessages via declaration merging
// Legacy hookMessage is kept for migration; new code should use custom.
declare module "@spell/pi-agent-core" {
	interface CustomAgentMessages {
		bashExecution: BashExecutionMessage;
		custom: CustomMessage;
		hookMessage: HookMessage;
		branchSummary: BranchSummaryMessage;
		compactionSummary: CompactionSummaryMessage;
		fileMention: FileMentionMessage;
	}
}

/**
 * Convert a BashExecutionMessage to user message text for LLM context.
 */
export function bashExecutionToText(msg: BashExecutionMessage): string {
	let text = `Ran \`${msg.command}\`\n`;
	if (msg.output) {
		text += `\`\`\`\n${msg.output}\n\`\`\``;
	} else {
		text += "(no output)";
	}
	if (msg.cancelled) {
		text += "\n\n(command cancelled)";
	} else if (msg.exitCode !== null && msg.exitCode !== undefined && msg.exitCode !== 0) {
		text += `\n\nCommand exited with code ${msg.exitCode}`;
	}
	text += formatOutputNotice(msg.meta);
	return text;
}

export function createBranchSummaryMessage(summary: string, fromId: string, timestamp: string): BranchSummaryMessage {
	return {
		role: "branchSummary",
		summary,
		fromId,
		timestamp: new Date(timestamp).getTime(),
	};
}

export function createCompactionSummaryMessage(
	summary: string,
	tokensBefore: number,
	timestamp: string,
	shortSummary?: string,
	providerPayload?: ProviderPayload,
): CompactionSummaryMessage {
	return {
		role: "compactionSummary",
		summary,
		shortSummary,
		tokensBefore,
		providerPayload,
		timestamp: new Date(timestamp).getTime(),
	};
}

/** Convert CustomMessageEntry to AgentMessage format */
export function createCustomMessage(
	customType: string,
	content: string | (TextContent | ImageContent)[],
	display: boolean,
	details: unknown | undefined,
	timestamp: string,
	attribution?: MessageAttribution,
): CustomMessage {
	return {
		role: "custom",
		customType,
		content,
		display,
		details,
		attribution,
		timestamp: new Date(timestamp).getTime(),
	};
}

/**
 * Enforce the tool-call/tool-result contiguity invariant required by LLM
 * provider APIs: a tool_use block MUST be immediately followed by the
 * tool_result blocks that answer it, with nothing in between.
 *
 * Reactive entries (e.g. the intention-summary briefing fired on a
 * `needs_input` / `pending_approval` blocking event) can be persisted into the
 * session graph *between* two tool results of a single assistant batch — the
 * blocking event fires while sibling tools are still streaming their results.
 * Order-preserving conversion then splits the tool_result run with a non-result
 * message, leaving the trailing results orphaned (no matching tool_use in the
 * previous message) → provider rejects with a 4xx.
 *
 * This pass is order-preserving except that any non-tool-result message found
 * *inside* a tool_result run is hoisted to immediately after the run. A message
 * is "inside" the run only when another tool_result follows it before the next
 * assistant message; messages that legitimately trail a completed run are left
 * untouched. Self-heals already-corrupted sessions on load and is
 * provider-agnostic.
 */
export function hoistInterleavedToolResults(messages: Message[]): Message[] {
	const out: Message[] = [];
	let i = 0;
	while (i < messages.length) {
		if (messages[i].role !== "toolResult") {
			out.push(messages[i]);
			i++;
			continue;
		}
		// Start of a tool_result run. Collect results; defer any non-result
		// message that is itself followed by a further result (i.e. interleaved).
		const run: Message[] = [];
		const deferred: Message[] = [];
		let j = i;
		while (j < messages.length) {
			if (messages[j].role === "toolResult") {
				run.push(messages[j]);
				j++;
				continue;
			}
			// Peek ahead across consecutive non-result, non-assistant messages.
			let k = j;
			const pending: Message[] = [];
			while (k < messages.length && messages[k].role !== "toolResult" && messages[k].role !== "assistant") {
				pending.push(messages[k]);
				k++;
			}
			if (k < messages.length && messages[k].role === "toolResult") {
				// Interleaved inside the run — hoist these out, keep consuming results.
				deferred.push(...pending);
				j = k;
				continue;
			}
			// Run is over (hit an assistant message or end of list).
			break;
		}
		out.push(...run, ...deferred);
		i = j;
	}
	return out;
}

/**
 * Transform AgentMessages (including custom types) to LLM-compatible Messages.
 *
 * This is used by:
 * - Agent's transormToLlm option (for prompt calls and queued messages)
 * - Compaction's generateSummary (for summarization)
 * - Custom extensions and tools
 *
 * The final pass enforces the tool-call/tool-result contiguity invariant via
 * {@link hoistInterleavedToolResults}, self-healing sessions whose tool_result
 * runs were split by a reactive entry (e.g. an intention-summary briefing).
 */
export function convertToLlm(messages: AgentMessage[]): Message[] {
	const converted = messages
		.map((m): Message | undefined => {
			switch (m.role) {
				case "bashExecution":
					if (m.excludeFromContext) {
						return undefined;
					}
					return {
						role: "user",
						content: [{ type: "text", text: bashExecutionToText(m) }],
						attribution: "user",
						timestamp: m.timestamp,
					};
				case "custom":
				case "hookMessage": {
					const content = typeof m.content === "string" ? [{ type: "text" as const, text: m.content }] : m.content;
					const role = "user";
					const attribution = m.attribution;
					return {
						role,
						content,
						attribution,
						timestamp: m.timestamp,
					};
				}
				case "branchSummary":
					return {
						role: "user",
						content: [
							{
								type: "text" as const,
								text: renderPromptTemplate(BRANCH_SUMMARY_TEMPLATE, { summary: m.summary }),
							},
						],
						attribution: "agent",
						timestamp: m.timestamp,
					};
				case "compactionSummary":
					return {
						role: "user",
						content: [
							{
								type: "text" as const,
								text: renderPromptTemplate(COMPACTION_SUMMARY_TEMPLATE, { summary: m.summary }),
							},
						],
						attribution: "agent",
						providerPayload: m.providerPayload,
						timestamp: m.timestamp,
					};
				case "fileMention": {
					const fileContents = m.files
						.map(file => {
							const inner = file.content ? `\n${file.content}\n` : "\n";
							return `<file path="${file.path}">${inner}</file>`;
						})
						.join("\n\n");
					const content: (TextContent | ImageContent)[] = [
						{ type: "text" as const, text: `<system-reminder>\n${fileContents}\n</system-reminder>` },
					];
					for (const file of m.files) {
						if (file.image) {
							content.push(file.image);
						}
					}
					return {
						role: "user",
						content,
						attribution: "user",
						timestamp: m.timestamp,
					};
				}
				case "user":
					return { ...m, attribution: m.attribution ?? "user" };
				case "developer":
					return { ...m, attribution: m.attribution ?? "agent" };
				case "assistant":
					return m;
				case "toolResult":
					return {
						...m,
						content: getPrunedToolResultContent(m as ToolResultMessage),
						attribution: m.attribution ?? "agent",
					};
				default:
					// biome-ignore lint/correctness/noSwitchDeclarations: fine
					const _exhaustiveCheck: never = m;
					return undefined;
			}
		})
		.filter((m): m is Message => m !== undefined);
	return hoistInterleavedToolResults(converted);
}
