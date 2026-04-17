import * as path from "node:path";
import { buildCompactHashlineDiffPreview } from "../patch/hashline";
import type { OutputMeta } from "./output-meta";
import type { MutationState } from "./pending-action";

export type CodeGraphCommand =
	| "index"
	| "status"
	| "context"
	| "impact"
	| "deps"
	| "flow"
	| "dead_code"
	| "clusters"
	| "symbols"
	| "files"
	| "search";

export type CodeFileCommand =
	| "outline"
	| "read"
	| "navigate"
	| "edit"
	| "undo"
	| "redo"
	| "diff"
	| "save"
	| "open"
	| "close"
	| "buffers"
	| "languages";

export interface CodeOutlineEntry {
	name: string;
	kind: string;
	line: number;
	endLine: number;
	column?: number;
	exported?: boolean;
	signature?: string;
	children: CodeOutlineEntry[];
}

export interface CodeNavigateItem {
	nodeType?: string;
	text?: string;
	line?: number;
	endLine?: number;
}

export interface CodeNavigateData {
	action?: string;
	nodeType?: string;
	text?: string;
	line?: number;
	endLine?: number;
	column?: number;
	parentType?: string;
	editableScopeNodeType?: string;
	editableScopeLine?: number;
	editableScopeEndLine?: number;
	editableScopeColumn?: number;
	name?: string;
	kind?: string;
	items: CodeNavigateItem[];
	referenceCount: number;
}
export interface CodeProofData {
	basis?: string;
	reason?: string;
	confidence?: string;
	matches?: number;
}

export interface CodeEditData {
	version?: number;
	diff: string;
	editCount: number;
	created?: boolean;
	operation?: string;
	proof?: CodeProofData;
	noop?: boolean;
	idempotent?: boolean;
	formatting?: "formatted" | "unchanged" | "unavailable";
	formatterServer?: string;
	mutationState: MutationState;
	persisted: boolean;
}

export interface CodeHistoryRange {
	start?: { line?: number; column?: number };
	end?: { line?: number; column?: number };
}

export interface CodeHistoryEntry {
	version?: number;
	changedRanges: CodeHistoryRange[];
	inputEdit?: {
		startByte?: number;
		oldEndByte?: number;
		newText?: string;
	};
}

export interface CodeHistoryData {
	entries: CodeHistoryEntry[] | null;
	applied: boolean;
}

export interface CodeDiffHunk {
	oldStart?: number;
	oldCount?: number;
	newStart?: number;
	newCount?: number;
	kind?: string;
	content: string;
}

export interface CodeBufferInfo {
	path?: string;
	language?: string;
	version?: number;
	dirty?: boolean;
	lineCount?: number;
}

export interface CodeLanguageInfo {
	id: string;
	extensions: string[];
	semanticCapable?: boolean;
	capabilities?: string[];
	embeddedLanguages?: string[];
}

interface CodeFileDetailsBase<TCommand extends CodeFileCommand, TData> {
	kind: "file";
	command: TCommand;
	file?: string;
	displayPath?: string;
	data: TData;
	rawOutput: unknown;
	injectedHint?: string;
	meta?: OutputMeta;
}

export type CodeOutlineDetails = CodeFileDetailsBase<
	"outline",
	{
		entries: CodeOutlineEntry[];
		topLevelCount: number;
		totalSymbols: number;
	}
>;

export type CodeReadDetails = CodeFileDetailsBase<
	"read",
	{
		text: string;
		resolution?: number;
		offset?: number;
		limit?: number;
	}
>;

export type CodeNavigateDetails = CodeFileDetailsBase<"navigate", CodeNavigateData>;
export type CodeEditDetails = CodeFileDetailsBase<"edit", CodeEditData>;
export type CodeUndoRedoDetails = CodeFileDetailsBase<"undo" | "redo", CodeHistoryData>;
export type CodeDiffDetails = CodeFileDetailsBase<"diff", { hunks: CodeDiffHunk[] }>;
export type CodeSaveDetails = CodeFileDetailsBase<"save", { success: boolean; version?: number }>;
export type CodeBuffersDetails = CodeFileDetailsBase<"buffers", { buffers: CodeBufferInfo[] }>;
export type CodeLanguagesDetails = CodeFileDetailsBase<"languages", { languages: CodeLanguageInfo[] }>;
export type CodeOpenDetails = CodeFileDetailsBase<"open", { success: boolean; language?: string; lineCount?: number }>;
export type CodeCloseDetails = CodeFileDetailsBase<"close", { success: boolean }>;

export type CodeFileDetails =
	| CodeOutlineDetails
	| CodeReadDetails
	| CodeNavigateDetails
	| CodeEditDetails
	| CodeUndoRedoDetails
	| CodeDiffDetails
	| CodeSaveDetails
	| CodeBuffersDetails
	| CodeLanguagesDetails
	| CodeOpenDetails
	| CodeCloseDetails;

export interface CodeGraphDetails {
	kind: "graph";
	command: CodeGraphCommand;
	output: string;
	cacheStatus?: string;
	rebuilt?: boolean;
	semanticStatus?: string;
	graph: true;
	meta?: OutputMeta;
}

export interface CodeToolErrorDetails {
	kind: "error";
	command: string;
	file?: string;
	displayPath?: string;
	failureKind?: string;
	message: string;
	error: true;
	proof?: CodeProofData;
	output?: unknown;
	meta?: OutputMeta;
}

export type CodeToolResultDetails = CodeGraphDetails | CodeFileDetails | CodeToolErrorDetails;

const OUTLINE_PREVIEW_LIMIT = 12;
const NAVIGATE_ITEM_PREVIEW_LIMIT = 6;
const BUFFER_PREVIEW_LIMIT = 10;
const LANGUAGE_PREVIEW_LIMIT = 10;
const HISTORY_PREVIEW_LIMIT = 5;
const PREVIEW_TEXT_LIMIT = 120;
function classifyCodeToolFailure(message: string): string {
	if (message.includes("operation 'create'")) return "payload_validation";
	if (message.includes("Stale code buffer detected")) return "buffer_freshness";
	if (message.includes("Ambiguous line target")) return "ambiguous_target";
	if (message.includes("Unsafe line-target")) return "unsafe_boundary";
	if (message.includes("structurally invalid")) return "structural_invalidity";
	if (message.includes("save to disk failed")) return "save_failure";
	return "execution_failure";
}

export function createCodeToolError(input: {
	command: string;
	message: string;
	file?: string;
	cwd?: string;
	output?: unknown;
}): CodeToolErrorDetails {
	const proof = normalizeProof(asRecord(input.output)?.proof);
	return {
		kind: "error",
		command: input.command,
		file: input.file,
		displayPath: toDisplayPath(input.file, input.cwd),
		failureKind: classifyCodeToolFailure(input.message),
		message: input.message,
		error: true,
		proof,
		output: input.output,
	};
}

export function createCodeGraphDetails(input: {
	command: CodeGraphCommand;
	output: string;
	cacheStatus?: string;
	rebuilt?: boolean;
	semanticStatus?: string;
}): CodeGraphDetails {
	return {
		kind: "graph",
		command: input.command,
		output: input.output,
		cacheStatus: input.cacheStatus,
		rebuilt: input.rebuilt,
		semanticStatus: input.semanticStatus,
		graph: true,
	};
}

export function normalizeCodeBufferSuccess(input: {
	command: CodeFileCommand;
	output: unknown;
	file?: string;
	cwd?: string;
	action?: string;
	resolution?: number;
	offset?: number;
	limit?: number;
	formatting?: CodeEditData["formatting"];
	formatterServer?: string;
	noop?: boolean;
	idempotent?: boolean;
	mutationState?: CodeEditData["mutationState"];
	persisted?: boolean;
}): CodeFileDetails {
	const displayPath = toDisplayPath(input.file, input.cwd);
	const base = {
		kind: "file" as const,
		command: input.command,
		file: input.file,
		displayPath,
		rawOutput: input.output,
	};

	if (input.command === "outline") {
		const entries = normalizeOutlineEntries(input.output);
		return {
			...base,
			command: "outline",
			data: {
				entries,
				topLevelCount: entries.length,
				totalSymbols: countOutlineEntries(entries),
			},
		};
	}

	if (input.command === "read") {
		return {
			...base,
			command: "read",
			data: {
				text: typeof input.output === "string" ? input.output : String(input.output ?? ""),
				resolution: input.resolution,
				offset: input.offset,
				limit: input.limit,
			},
		};
	}

	if (input.command === "navigate") {
		return {
			...base,
			command: "navigate",
			data: normalizeNavigateData(input.output, input.action),
		};
	}

	if (input.command === "edit") {
		const record = asRecord(input.output);
		return {
			...base,
			command: "edit",
			data: {
				version: asNumber(record?.version),
				diff: asString(record?.diff) ?? "",
				editCount: asNumber(record?.editCount) ?? 0,
				created: asBoolean(record?.created) ?? false,
				operation: asString(record?.operation),
				proof: normalizeProof(record?.proof),
				noop: input.noop ?? false,
				idempotent: input.idempotent ?? false,
				formatting: input.formatting,
				formatterServer: input.formatterServer,
				mutationState: input.mutationState ?? (input.noop ? "noop" : "applied"),
				persisted:
					input.persisted ??
					(input.mutationState !== "pending_preview" && input.mutationState !== "discarded" && !input.noop),
			},
		};
	}

	if (input.command === "undo" || input.command === "redo") {
		return {
			...base,
			command: input.command,
			data: normalizeHistoryData(input.output),
		};
	}

	if (input.command === "diff") {
		return {
			...base,
			command: "diff",
			data: {
				hunks: normalizeDiffHunks(input.output),
			},
		};
	}

	if (input.command === "save") {
		const record = asRecord(input.output);
		return {
			...base,
			command: "save",
			data: {
				success: asBoolean(record?.success) ?? false,
				version: asNumber(record?.version),
			},
		};
	}

	if (input.command === "buffers") {
		return {
			...base,
			command: "buffers",
			data: {
				buffers: normalizeBufferInfos(input.output),
			},
		};
	}

	if (input.command === "open") {
		const record = asRecord(input.output);
		const lines = Array.isArray(record?.lines) ? record.lines : undefined;
		return {
			...base,
			command: "open",
			data: {
				success: asBoolean(record?.success) ?? false,
				language: asString(record?.language),
				lineCount: lines?.length,
			},
		};
	}

	if (input.command === "close") {
		const record = asRecord(input.output);
		return {
			...base,
			command: "close",
			data: {
				success: asBoolean(record?.success) ?? false,
			},
		};
	}

	const languagesRecord = asRecord(input.output);
	return {
		...base,
		command: "languages",
		data: {
			languages: normalizeLanguages(languagesRecord?.languages),
		},
	};
}

export function formatCodeToolContent(details: CodeToolResultDetails): string {
	if (details.kind === "error") {
		const parts = [
			`Error${details.failureKind ? ` [${details.failureKind}]` : ""}${details.displayPath ? ` ${details.displayPath}` : ""}: ${details.message}`,
		];
		if (details.proof) {
			parts.push(formatProofLine("Proof", details.proof));
		}
		if (details.command === "edit") {
			parts.push("Recovery: re-read/navigate, tighten the target, then retry narrowly.");
		}
		return parts.join("\n");
	}

	if (details.kind === "graph") {
		return details.output;
	}

	const withHint = (content: string): string =>
		details.injectedHint ? `${content}\n\n${details.injectedHint}` : content;

	if (details.command === "read") {
		return withHint(details.data.text);
	}

	if (details.command === "outline") {
		const label = details.displayPath ? ` ${details.displayPath}` : "";
		const lines = [`Outline${label} (${details.data.topLevelCount} top, ${details.data.totalSymbols} total)`];
		for (const line of previewList(details.data.entries, OUTLINE_PREVIEW_LIMIT).map(formatOutlineEntry)) {
			lines.push(`- ${line}`);
		}
		const remaining = details.data.entries.length - Math.min(details.data.entries.length, OUTLINE_PREVIEW_LIMIT);
		if (remaining > 0) {
			lines.push(`- … ${remaining} more top-level entries`);
		}
		return withHint(lines.join("\n"));
	}

	if (details.command === "navigate") {
		const label = details.displayPath ? ` ${details.displayPath}` : "";
		const action = details.data.action ? ` ${details.data.action}` : "";
		const nodeLabel = [details.data.nodeType, details.data.name].filter(Boolean).join(" ") || "node";
		const location = formatLineRange(details.data.line, details.data.endLine, details.data.column);
		const lines = [`Navigate${action}${label}: ${nodeLabel}${location ? ` ${location}` : ""}`];
		if (details.data.text && details.data.text !== details.data.name) {
			lines.push(`text: ${truncatePreview(details.data.text)}`);
		}
		const metadata: string[] = [];
		if (details.data.parentType) metadata.push(`parent: ${details.data.parentType}`);
		if (details.data.editableScopeNodeType) {
			const scopeLocation = formatLineRange(
				details.data.editableScopeLine,
				details.data.editableScopeEndLine,
				details.data.editableScopeColumn,
			);
			metadata.push(`scope: ${details.data.editableScopeNodeType}${scopeLocation ? ` ${scopeLocation}` : ""}`);
		}
		if (details.data.kind) metadata.push(`kind: ${details.data.kind}`);
		if (metadata.length > 0) lines.push(metadata.join(" | "));
		const summary: string[] = [];
		if (details.data.items.length > 0) summary.push(pluralize(details.data.items.length, "item"));
		if (details.data.referenceCount > 0) summary.push(pluralize(details.data.referenceCount, "ref"));
		if (summary.length > 0) lines.push(summary.join(", "));

		for (const item of previewList(details.data.items, NAVIGATE_ITEM_PREVIEW_LIMIT)) {
			const itemLocation = formatLineRange(item.line, item.endLine);
			const itemLabel = [item.nodeType, truncatePreview(item.text)].filter(Boolean).join(" ");
			lines.push(`  ${itemLabel}${itemLocation ? ` ${itemLocation}` : ""}`);
		}
		const remaining = details.data.items.length - Math.min(details.data.items.length, NAVIGATE_ITEM_PREVIEW_LIMIT);
		if (remaining > 0) {
			lines.push(`  … ${remaining} more items`);
		}
		return withHint(lines.join("\n"));
	}

	if (details.command === "edit") {
		const label = details.displayPath ? ` ${details.displayPath}` : "";
		const formatting = details.data.formatting
			? formatEditFormatting(details.data.formatting, details.data.formatterServer)
			: undefined;
		if (details.data.noop) {
			const noopHeader = `${details.data.created ? "No-op create" : "No-op edit"}${label}${details.data.idempotent ? " (idempotent)" : ""}`;
			return withHint([noopHeader, formatting, "No semantic changes applied."].filter(Boolean).join("\n"));
		}
		if (details.data.mutationState === "pending_preview") {
			const preview = buildCompactHashlineDiffPreview(details.data.diff);
			const changes = countDiffChanges(details.data.diff);
			const lines = [
				`Preview queued${label}`,
				"Resolve required before disk changes.",
				`Changes: +${changes.addedLines} -${changes.removedLines}`,
			].filter(Boolean);
			if (preview.preview.trim().length > 0) {
				lines.push("Diff preview:", preview.preview);
			}
			return withHint(lines.join("\n"));
		}
		if (details.data.mutationState === "discarded") {
			return withHint([`Preview discarded${label}`, "No mutation landed."].join("\n"));
		}
		const header = `${details.data.created ? "Created" : "Edited"}${label}`;
		const operationLine = details.data.operation ? `Operation: ${details.data.operation}` : undefined;
		const proofLine = details.data.proof ? formatProofLine("Proof", details.data.proof) : undefined;
		if (details.data.diff.trim().length === 0) {
			return withHint([header, operationLine, proofLine, formatting].filter(Boolean).join("\n"));
		}
		const preview = buildCompactHashlineDiffPreview(details.data.diff);
		const changes = countDiffChanges(details.data.diff);
		const lines = [
			header,
			operationLine,
			proofLine,
			formatting,
			`Changes: +${changes.addedLines} -${changes.removedLines}`,
		].filter(Boolean);
		if (preview.preview.trim().length > 0) {
			lines.push("Diff preview:", preview.preview);
		}
		return withHint(lines.join("\n"));
	}

	function formatEditFormatting(
		formatting: NonNullable<CodeEditData["formatting"]>,
		formatterServer?: string,
	): string {
		if (formatting === "unavailable") {
			return "Formatting: unavailable (saved without formatter)";
		}
		const via = formatterServer ? ` via ${formatterServer}` : "";
		return `Formatting: ${formatting}${via}`;
	}

	function formatProofLine(label: string, proof: CodeProofData): string {
		const details = [proof.basis, proof.reason, proof.confidence].filter(Boolean).join(" | ");
		const matches = proof.matches !== undefined ? ` | matches: ${proof.matches}` : "";
		return `${label}: ${details || "available"}${matches}`;
	}

	if (details.command === "undo" || details.command === "redo") {
		const label = details.displayPath ? ` ${details.displayPath}` : "";
		if (!details.data.applied || !details.data.entries || details.data.entries.length === 0) {
			return withHint(`${capitalize(details.command)}${label} had no effect.`);
		}
		const lines = [`${capitalize(details.command)}${label} (${pluralize(details.data.entries.length, "entry")})`];
		for (const entry of previewList(details.data.entries, HISTORY_PREVIEW_LIMIT)) {
			lines.push(formatHistoryEntry(entry));
		}
		const remaining = details.data.entries.length - Math.min(details.data.entries.length, HISTORY_PREVIEW_LIMIT);
		if (remaining > 0) {
			lines.push(`… ${remaining} more entries`);
		}
		return withHint(lines.join("\n"));
	}

	if (details.command === "diff") {
		const label = details.displayPath ? ` ${details.displayPath}` : "";
		const lines = [`Unsaved diff${label} (${pluralize(details.data.hunks.length, "hunk")})`];
		for (const [index, hunk] of details.data.hunks.entries()) {
			lines.push(`@@ hunk ${index + 1} ${formatHunkSummary(hunk)} @@`);
			if (hunk.content.trim()) {
				lines.push(hunk.content);
			}
		}
		return withHint(lines.join("\n"));
	}

	if (details.command === "save") {
		const label = details.displayPath ? ` ${details.displayPath}` : "";
		return withHint(
			details.data.success
				? `Saved${label} (buffer version ${details.data.version ?? "unknown"}).`
				: `Save${label} did not report success.`,
		);
	}

	if (details.command === "buffers") {
		const lines = [`Open buffers (${details.data.buffers.length})`];
		for (const buffer of previewList(details.data.buffers, BUFFER_PREVIEW_LIMIT)) {
			lines.push(`- ${formatBufferInfo(buffer)}`);
		}
		const remaining = details.data.buffers.length - Math.min(details.data.buffers.length, BUFFER_PREVIEW_LIMIT);
		if (remaining > 0) {
			lines.push(`- … ${remaining} more buffers`);
		}
		return withHint(lines.join("\n"));
	}
	if (details.command === "languages") {
		const lines = [`Built-in languages (${details.data.languages.length})`];
		for (const language of previewList(details.data.languages, LANGUAGE_PREVIEW_LIMIT)) {
			const suffix = language.extensions.length > 0 ? ` (${language.extensions.join(", ")})` : "";
			const capabilitySuffix = language.capabilities?.length ? ` [${language.capabilities.join(", ")}]` : "";
			const embeddedSuffix = language.embeddedLanguages?.length
				? ` embeds ${language.embeddedLanguages.join(", ")}`
				: "";
			const semanticSuffix = language.semanticCapable === false ? " [fallback]" : "";
			lines.push(`- ${language.id}${suffix}${capabilitySuffix}${embeddedSuffix}${semanticSuffix}`);
		}
		const remaining = details.data.languages.length - Math.min(details.data.languages.length, LANGUAGE_PREVIEW_LIMIT);
		if (remaining > 0) {
			lines.push(`- … ${remaining} more languages`);
		}
		return withHint(lines.join("\n"));
	}

	if (details.command === "open") {
		const label = details.displayPath ? ` ${details.displayPath}` : "";
		const language = details.data.language ? ` [${details.data.language}]` : "";
		const lineCount = details.data.lineCount !== undefined ? ` ${pluralize(details.data.lineCount, "line")}` : "";
		return withHint(`Opened${label}${language}${lineCount}`);
	}

	if (details.command === "close") {
		const label = details.displayPath ? ` ${details.displayPath}` : "";
		return withHint(`Closed${label}`);
	}

	return "";
}

function normalizeOutlineEntries(value: unknown): CodeOutlineEntry[] {
	if (!Array.isArray(value)) return [];
	const entries: CodeOutlineEntry[] = [];
	for (const item of value) {
		const record = asRecord(item);
		if (!record) continue;
		const name = asString(record.name);
		const kind = asString(record.kind);
		const line = asNumber(record.line);
		const endLine = asNumber(record.endLine ?? record.end_line) ?? line;
		if (!name || !kind || line === undefined || endLine === undefined) continue;
		entries.push({
			name,
			kind,
			line,
			endLine,
			column: asNumber(record.column),
			exported: asBoolean(record.exported),
			signature: asString(record.signature),
			children: normalizeOutlineEntries(record.children),
		});
	}
	return entries;
}

function countOutlineEntries(entries: CodeOutlineEntry[]): number {
	let total = 0;
	for (const entry of entries) {
		total += 1 + countOutlineEntries(entry.children);
	}
	return total;
}

function normalizeNavigateData(value: unknown, action?: string): CodeNavigateData {
	const record = asRecord(value);
	const items = Array.isArray(record?.items)
		? record.items.map(item => normalizeNavigateItem(item)).filter((item): item is CodeNavigateItem => item !== null)
		: [];
	const references = Array.isArray(record?.references) ? record.references.length : 0;
	return {
		action,
		nodeType: asString(record?.nodeType ?? record?.node_type),
		text: asString(record?.text),
		line: asNumber(record?.line),
		endLine: asNumber(record?.endLine ?? record?.end_line),
		column: asNumber(record?.column),
		parentType: asString(record?.parentType ?? record?.parent_type),
		editableScopeNodeType: asString(record?.editableScopeNodeType ?? record?.editable_scope_node_type),
		editableScopeLine: asNumber(record?.editableScopeLine ?? record?.editable_scope_line),
		editableScopeEndLine: asNumber(record?.editableScopeEndLine ?? record?.editable_scope_end_line),
		editableScopeColumn: asNumber(record?.editableScopeColumn ?? record?.editable_scope_column),
		name: asString(record?.name),
		kind: asString(record?.kind),
		items,
		referenceCount: references,
	};
}

function normalizeNavigateItem(value: unknown): CodeNavigateItem | null {
	const record = asRecord(value);
	if (!record) return null;
	return {
		nodeType: asString(record.nodeType ?? record.node_type),
		text: asString(record.text),
		line: asNumber(record.line),
		endLine: asNumber(record.endLine ?? record.end_line),
	};
}

function normalizeHistoryData(value: unknown): CodeHistoryData {
	if (!Array.isArray(value)) {
		return { entries: null, applied: false };
	}
	return {
		entries: value.map(normalizeHistoryEntry).filter((entry): entry is CodeHistoryEntry => entry !== null),
		applied: value.length > 0,
	};
}

function normalizeHistoryEntry(value: unknown): CodeHistoryEntry | null {
	const record = asRecord(value);
	if (!record) return null;
	const changedRanges = Array.isArray(record.changedRanges)
		? record.changedRanges.map(normalizeHistoryRange).filter((range): range is CodeHistoryRange => range !== null)
		: [];
	const inputEditRecord = asRecord(record.inputEdit);
	return {
		version: asNumber(record.version),
		changedRanges,
		inputEdit: inputEditRecord
			? {
					startByte: asNumber(inputEditRecord.startByte),
					oldEndByte: asNumber(inputEditRecord.oldEndByte),
					newText: asString(inputEditRecord.newText),
				}
			: undefined,
	};
}

function normalizeHistoryRange(value: unknown): CodeHistoryRange | null {
	const record = asRecord(value);
	if (!record) return null;
	return {
		start: normalizePoint(record.start),
		end: normalizePoint(record.end),
	};
}

function normalizePoint(value: unknown): { line?: number; column?: number } | undefined {
	const record = asRecord(value);
	if (!record) return undefined;
	return {
		line: asNumber(record.line),
		column: asNumber(record.column),
	};
}

function normalizeDiffHunks(value: unknown): CodeDiffHunk[] {
	if (!Array.isArray(value)) return [];
	const hunks: CodeDiffHunk[] = [];
	for (const item of value) {
		const record = asRecord(item);
		if (!record) continue;
		hunks.push({
			oldStart: asNumber(record.oldStart),
			oldCount: asNumber(record.oldCount),
			newStart: asNumber(record.newStart),
			newCount: asNumber(record.newCount),
			kind: asString(record.kind),
			content: asString(record.content) ?? "",
		});
	}
	return hunks;
}

function normalizeBufferInfos(value: unknown): CodeBufferInfo[] {
	if (!Array.isArray(value)) return [];
	const buffers: CodeBufferInfo[] = [];
	for (const item of value) {
		const record = asRecord(item);
		if (!record) continue;
		buffers.push({
			path: asString(record.path),
			language: asString(record.language),
			version: asNumber(record.version),
			dirty: asBoolean(record.dirty),
			lineCount: asNumber(record.lineCount ?? record.line_count),
		});
	}
	return buffers;
}

function normalizeLanguages(value: unknown): CodeLanguageInfo[] {
	if (!Array.isArray(value)) return [];
	const languages: CodeLanguageInfo[] = [];
	for (const item of value) {
		const record = asRecord(item);
		const id = asString(record?.id);
		if (!id) continue;
		languages.push({
			id,
			extensions: Array.isArray(record?.extensions)
				? record.extensions.filter((entry): entry is string => typeof entry === "string")
				: [],
			semanticCapable: asBoolean(record?.semanticCapable),
			capabilities: Array.isArray(record?.capabilities)
				? record.capabilities.filter((entry): entry is string => typeof entry === "string")
				: [],
			embeddedLanguages: Array.isArray(record?.embeddedLanguages)
				? record.embeddedLanguages.filter((entry): entry is string => typeof entry === "string")
				: [],
		});
	}
	return languages;
}

function formatOutlineEntry(entry: CodeOutlineEntry): string {
	const childCount = entry.children.length;
	const childSuffix = childCount > 0 ? ` (${pluralize(childCount, "child")})` : "";
	return `${entry.kind} ${entry.name} ${formatLineRange(entry.line, entry.endLine)}${childSuffix}`;
}

function formatLineRange(start?: number, end?: number, column?: number): string {
	if (start === undefined) return "";
	const lineRange = end !== undefined && end !== start ? `L${start}-L${end}` : `L${start}`;
	return column !== undefined ? `${lineRange}:C${column}` : lineRange;
}

function formatHistoryRange(entry: CodeHistoryEntry): string {
	const firstRange = entry.changedRanges[0];
	const startLine = firstRange?.start?.line ?? firstRange?.end?.line;
	const endLine = firstRange?.end?.line ?? startLine;
	if (startLine === undefined) return "range unknown";
	return endLine !== undefined && endLine !== startLine ? `L${startLine}-${endLine}` : `L${startLine}`;
}

function formatHistoryEntry(entry: CodeHistoryEntry): string {
	const range = formatHistoryRange(entry);
	const textLen = entry.inputEdit?.newText?.length;
	const version = entry.version !== undefined ? `v${entry.version}` : "version unknown";
	const textSuffix = textLen !== undefined ? ` +${textLen} chars` : "";
	return `${version} ${range}${textSuffix}`;
}

function countDiffChanges(diff: string): { addedLines: number; removedLines: number } {
	let addedLines = 0;
	let removedLines = 0;
	for (const line of diff.split("\n")) {
		if (line.startsWith("+++")) continue;
		if (line.startsWith("---")) continue;
		if (line.startsWith("+")) {
			addedLines += 1;
			continue;
		}
		if (line.startsWith("-")) {
			removedLines += 1;
		}
	}
	return { addedLines, removedLines };
}

function formatHunkSummary(hunk: CodeDiffHunk): string {
	const kind = hunk.kind?.toLowerCase() ?? "change";
	const oldSpan = formatSpan(hunk.oldStart, hunk.oldCount);
	const newSpan = formatSpan(hunk.newStart, hunk.newCount);
	return `${kind} ${oldSpan} -> ${newSpan}`;
}

function formatSpan(start?: number, count?: number): string {
	if (start === undefined) return "unknown";
	if (count === undefined || count <= 1) return `L${start}`;
	return `L${start}-L${start + count - 1}`;
}

function formatBufferInfo(buffer: CodeBufferInfo): string {
	const label = buffer.path ?? "(unnamed buffer)";
	const language = buffer.language ? ` [${buffer.language}]` : "";
	const dirty = buffer.dirty ? " dirty" : " clean";
	const version = buffer.version !== undefined ? ` v${buffer.version}` : "";
	const lineCount = buffer.lineCount !== undefined ? ` ${pluralize(buffer.lineCount, "line")}` : "";
	return `${label}${language}${dirty}${version}${lineCount}`;
}

function toDisplayPath(file: string | undefined, cwd: string | undefined): string | undefined {
	if (!file) return undefined;
	if (!cwd) return file;
	const relative = path.relative(cwd, file);
	if (!relative || relative === "") return path.basename(file);
	return relative.startsWith("..") ? file : relative;
}

function previewList<T>(items: T[], limit: number): T[] {
	return items.slice(0, limit);
}

function truncatePreview(value: string | undefined): string | undefined {
	if (!value) return value;
	const singleLine = value.replace(/\s+/g, " ").trim();
	if (singleLine.length <= PREVIEW_TEXT_LIMIT) return singleLine;
	return `${singleLine.slice(0, PREVIEW_TEXT_LIMIT - 1)}…`;
}
function normalizeProof(value: unknown): CodeProofData | undefined {
	const record = asRecord(value);
	if (!record) return undefined;
	const proof = {
		basis: asString(record.basis),
		reason: asString(record.reason),
		confidence: asString(record.confidence),
		matches: asNumber(record.matches),
	};
	return Object.values(proof).some(value => value !== undefined) ? proof : undefined;
}

function pluralize(count: number, noun: string): string {
	return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

function capitalize(value: string): string {
	return value.length === 0 ? value : `${value[0]?.toUpperCase() ?? ""}${value.slice(1)}`;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

function asString(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function asBoolean(value: unknown): boolean | undefined {
	return typeof value === "boolean" ? value : undefined;
}
