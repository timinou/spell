import * as fs from "node:fs/promises";
import * as nodePath from "node:path";
import type { AgentTool, AgentToolContext, AgentToolResult, AgentToolUpdateCallback } from "@oh-my-pi/pi-agent-core";
import { executeCodePath } from "@oh-my-pi/pi-natives";
import type { RenderResultOptions } from "../extensibility/custom-tools/types";
import type { Theme } from "../modes/theme/theme";
import type { FileSystem, PatchInput } from "../patch";
import {
	applyHashlineEdits,
	applyPatch,
	buildCompactHashlineDiffPreview,
	detectLineEnding,
	HashlineMismatchError,
	normalizeToLF,
	parseTag,
	restoreLineEndings,
	stripBom,
} from "../patch";
import { generateDiffString } from "../patch/diff";
import { enforcePathWrite } from "../sandbox";
import { renderCodeCell } from "../tui";
import type { ToolSession } from ".";
import { formatCodePathResult } from "./codepath-result";
import type { CodePathAction, EditParams } from "./codepath-types";
import { editSchema } from "./codepath-types";
import { enforceModeWrite } from "./mode-guard";
import { replaceTabs } from "./render-utils";
import { toolResult } from "./tool-result";

type Anchor = { line: number; hash: string };
type HashlineEdit =
	| { op: "replace"; pos: Anchor; end?: Anchor; lines: string[] }
	| { op: "append"; pos?: Anchor; lines: string[] }
	| { op: "prepend"; pos?: Anchor; lines: string[] };

function normalizeLines(value: string | string[] | undefined): string | undefined {
	if (value === undefined) return undefined;
	return typeof value === "string" ? value : value.join("\n");
}

function isLineIdAction(action: CodePathAction): boolean {
	return action.kind === "replace" || action.kind === "append" || action.kind === "prepend";
}

function isPatchAction(action: CodePathAction): boolean {
	return action.kind === "patch" && action.diff !== undefined;
}

function parseHashlineAnchor(raw: string, field: "pos" | "end", editIndex: number): Anchor {
	try {
		return parseTag(raw);
	} catch (_error) {
		throw new Error(
			`Invalid line reference "${raw}" in edit ${editIndex} (${field}). Expected format "LINE#ID" (e.g. "5#QW").`,
		);
	}
}

function resolveEditAnchors(action: CodePathAction, editIndex: number): HashlineEdit[] {
	const lines = normalizeLines(action.lines);
	const contentLines = lines === undefined ? [] : lines.split("\n");
	const op = action.kind === "append" || action.kind === "prepend" ? action.kind : "replace";
	const pos = action.pos !== undefined ? parseHashlineAnchor(action.pos, "pos", editIndex) : undefined;
	const end = action.end !== undefined ? parseHashlineAnchor(action.end, "end", editIndex) : undefined;

	switch (op) {
		case "replace": {
			if (pos && end) {
				return [{ op: "replace", pos, end, lines: contentLines }];
			} else if (pos || end) {
				const singleAnchor = pos || end!;
				if (contentLines.length > 1) {
					throw new Error(
						`Edit ${editIndex}: single anchor (${action.pos ? "pos" : "end"}) replaces exactly one line, but ${contentLines.length} lines were provided.`,
					);
				}
				return [{ op: "replace", pos: singleAnchor, lines: contentLines }];
			} else {
				throw new Error(`Edit ${editIndex}: replace requires at least one anchor (pos or end).`);
			}
		}
		case "append": {
			return [{ op: "append", pos: pos ?? end, lines: contentLines }];
		}
		case "prepend": {
			return [{ op: "prepend", pos: end ?? pos, lines: contentLines }];
		}
	}
}

function normalizeStructuralAction(action: CodePathAction): Record<string, unknown> {
	const out: Record<string, unknown> = { kind: action.kind };
	if (action.scope) out.scope = action.scope;
	if (action.content !== undefined) out.content = normalizeLines(action.content);
	if (action.find !== undefined) out.find = normalizeLines(action.find);
	if (action.mode) out.mode = action.mode;
	if (action.direction) out.direction = action.direction;
	if (action.line !== undefined) out.line = action.line;
	if (action.column !== undefined) out.column = action.column;
	if (action.nodeType) out.nodeType = action.nodeType;
	if (action.allowSiblingDelete !== undefined) out.allowSiblingDelete = action.allowSiblingDelete;
	if (action.occurrence !== undefined) out.occurrence = action.occurrence;
	if (action.idempotent !== undefined) out.idempotent = action.idempotent;
	return out;
}

class SimpleFileSystem implements FileSystem {
	async exists(path: string): Promise<boolean> {
		return fs.exists(path);
	}
	async read(path: string): Promise<string> {
		return fs.readFile(path, "utf-8");
	}
	async write(path: string, content: string): Promise<void> {
		await fs.writeFile(path, content, "utf-8");
	}
	async delete(path: string): Promise<void> {
		await fs.unlink(path);
	}
	async mkdir(path: string): Promise<void> {
		await fs.mkdir(path, { recursive: true });
	}
}

export class CodepathEditTool implements AgentTool<typeof editSchema> {
	readonly name = "edit";
	readonly label = "Edit";
	readonly description =
		"Perform structural code edits, LINE#ID-based text edits, or apply unified diffs. Supports 18+ action kinds with occurrence selectors and idempotent semantics.";
	readonly parameters = editSchema;
	readonly lenientArgValidation = true;
	readonly concurrency = "exclusive";

	constructor(private readonly session: ToolSession) {}

	async execute(
		_toolCallId: string,
		params: EditParams,
		signal?: AbortSignal,
		_onUpdate?: AgentToolUpdateCallback,
		_context?: AgentToolContext,
	): Promise<AgentToolResult> {
		const sessionCwd = this.session.cwd;
		const results: AgentToolResult[] = [];

		for (let i = 0; i < params.operations.length; i++) {
			const op = params.operations[i];
			if (!op) continue;

			const targetPath = nodePath.isAbsolute(op.target) ? op.target : nodePath.resolve(sessionCwd, op.target);
			enforceModeWrite(this.session, targetPath, { op: "update" });
			const sandboxError = enforcePathWrite(targetPath, sessionCwd, this.session.sandboxPolicy);
			if (sandboxError) throw new Error(sandboxError);

			const action = op.action;
			const idempotent = op.idempotent ?? params.idempotent ?? false;

			if (isPatchAction(action)) {
				const patchResult = await this.#executePatch(targetPath, action.diff!, signal);
				results.push(patchResult);
			} else if (isLineIdAction(action)) {
				const lineIdResult = await this.#executeLineId(targetPath, action, i + 1, idempotent);
				results.push(lineIdResult);
			} else {
				const structuralResult = await this.#executeStructural(targetPath, action, signal);
				results.push(structuralResult);
			}
		}

		if (results.length === 1) return results[0]!;

		// Aggregate multiple results
		const allText = results
			.map(r =>
				r.content
					.filter(c => c.type === "text")
					.map(c => (c as { text?: string }).text ?? "")
					.join("\n"),
			)
			.join("\n\n");
		const _hasError = results.some(r => "isError" in r && r.isError === true);
		return toolResult({ operations: params.operations.length }).text(allText).done();
	}

	async #executeStructural(
		targetPath: string,
		action: CodePathAction,
		signal?: AbortSignal,
	): Promise<AgentToolResult> {
		const chunks = await executeCodePath({
			command: "edit",
			target: targetPath,
			actions: [normalizeStructuralAction(action)],
			abortSignal: signal,
		});
		const result = formatCodePathResult(chunks, { format: "node-list" });
		return toolResult({ target: targetPath, action: action.kind }).text(result.text).done();
	}

	async #executeLineId(
		targetPath: string,
		action: CodePathAction,
		editIndex: number,
		idempotent: boolean,
	): Promise<AgentToolResult> {
		const exists = await fs.exists(targetPath);
		if (!exists) {
			// File creation via anchorless append/prepend
			if ((action.kind === "append" || action.kind === "prepend") && !action.pos && !action.end) {
				const lines = normalizeLines(action.lines) ?? "";
				const content = action.kind === "prepend" ? lines : lines;
				await fs.mkdir(nodePath.dirname(targetPath), { recursive: true });
				await fs.writeFile(targetPath, content, "utf-8");
				return toolResult({ target: targetPath, op: "create" }).text(`Created ${targetPath}`).done();
			}
			throw new Error(`File not found: ${targetPath}`);
		}

		const anchorEdits = resolveEditAnchors(action, editIndex);
		const rawContent = await fs.readFile(targetPath, "utf-8");
		const { bom, text } = stripBom(rawContent);
		const originalEnding = detectLineEnding(text);
		const originalNormalized = normalizeToLF(text);

		let normalizedText = originalNormalized;
		let firstChangedLine: number | undefined;
		let warnings: string[] | undefined;

		try {
			const anchorResult = applyHashlineEdits(normalizedText, anchorEdits);
			normalizedText = anchorResult.lines;
			firstChangedLine = anchorResult.firstChangedLine;
			warnings = anchorResult.warnings;
		} catch (err) {
			if (err instanceof HashlineMismatchError) {
				const diag = HashlineMismatchError.formatMessage(err.mismatches, err.fileLines);
				return toolResult({ target: targetPath, error: "stale_anchor" }).text(diag).done();
			}
			throw err;
		}

		if (originalNormalized === normalizedText) {
			if (!idempotent) {
				return toolResult({ target: targetPath, noop: true })
					.text(
						`No changes made to ${targetPath}. The edits produced identical content. Retry with idempotent=true only when an intentional no-op is acceptable.`,
					)
					.done();
			}
			return toolResult({ target: targetPath, noop: true, idempotent: true })
				.text(`No changes (idempotent).`)
				.done();
		}

		const finalContent = bom + restoreLineEndings(normalizedText, originalEnding);
		await fs.writeFile(targetPath, finalContent, "utf-8");

		const diffResult = generateDiffString(originalNormalized, normalizedText);
		const preview = buildCompactHashlineDiffPreview(diffResult.diff);
		const summaryLine = `Changes: +${preview.addedLines} -${preview.removedLines}`;
		const warningsBlock = warnings?.length ? `\n\nWarnings:\n${warnings.join("\n")}` : "";
		const previewBlock = preview.preview ? `\n\nDiff preview:\n${preview.preview}` : "";

		return toolResult({
			target: targetPath,
			diff: diffResult.diff,
			firstChangedLine: firstChangedLine ?? diffResult.firstChangedLine,
		})
			.text(`Updated ${targetPath}\n${summaryLine}${previewBlock}${warningsBlock}`)
			.done();
	}

	async #executePatch(targetPath: string, diff: string, _signal?: AbortSignal): Promise<AgentToolResult> {
		const input: PatchInput = { path: targetPath, op: "update", diff };
		const result = await applyPatch(input, {
			cwd: this.session.cwd,
			fs: new SimpleFileSystem(),
		});

		const change = result.change;
		let text: string;
		switch (change.type) {
			case "create":
				text = `Created ${targetPath}`;
				break;
			case "delete":
				text = `Deleted ${targetPath}`;
				break;
			default:
				text = `Updated ${targetPath}`;
				break;
		}

		if (result.warnings && result.warnings.length > 0) {
			text += `\n\nWarnings:\n${result.warnings.join("\n")}`;
		}

		return toolResult({ target: targetPath, op: "update", diff: change.newContent }).text(text).done();
	}

	renderResult(result: AgentToolResult, options: RenderResultOptions, theme: unknown): Component {
		const uiTheme = theme as Theme;
		const text = result.content
			.filter(c => c.type === "text")
			.map(c => (c as { text?: string }).text ?? "")
			.join("\n");
		const sanitized = replaceTabs(text);
		const maxChars = 2_000;
		const truncated = sanitized.length > maxChars ? `${sanitized.slice(0, maxChars)}\n...truncated` : sanitized;
		return {
			render: (width: number) =>
				renderCodeCell(
					{
						code: truncated,
						language: "diff",
						title: "Edit",
						status: "complete",
						expanded: options.expanded,
						width,
					},
					uiTheme,
				),
			invalidate: () => {},
		};
	}
}
