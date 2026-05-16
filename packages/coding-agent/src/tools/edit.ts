import * as fs from "node:fs/promises";
import * as nodePath from "node:path";
import type { AgentTool, AgentToolContext, AgentToolResult, AgentToolUpdateCallback } from "@oh-my-pi/pi-agent-core";
import { executeCodePath } from "@oh-my-pi/pi-natives";
import type { Component } from "@oh-my-pi/pi-tui";
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
import editDescription from "../prompts/tools/edit.md" with { type: "text" };
import { enforcePathWrite } from "../sandbox";
import { renderCodeCell } from "../tui";
import type { ToolSession } from ".";
import { formatCodePathResult } from "./codepath-result";
import type { CodePathAction, EditParams } from "./codepath-types";
import { editSchema } from "./codepath-types";
import { enforceModeWrite } from "./mode-guard";
import { resolveCwdRelativePath } from "./path-resolution";
import { replaceTabs } from "./render-utils";
import { type DetailsWithMeta, toolResult } from "./tool-result";

type EditToolResultDetails = DetailsWithMeta & {
	operations?: number;
	target?: string;
	action?: string;
	op?: string;
	error?: string;
	noop?: boolean;
	idempotent?: boolean;
	diff?: string;
	firstChangedLine?: number;
};

type Anchor = { line: number; hash: string };
type HashlineEdit =
	| { op: "replace"; pos: Anchor; end?: Anchor; lines: string[] }
	| { op: "append"; pos?: Anchor; lines: string[] }
	| { op: "prepend"; pos?: Anchor; lines: string[] };

function normalizeLines(value: string | string[] | null | undefined): string | undefined {
	if (value === undefined || value === null) return undefined;
	return typeof value === "string" ? value : value.join("\n");
}

function isErrorResult(result: AgentToolResult): boolean {
	if (result.isError === true) return true;
	const details = result.details as { error?: unknown } | undefined;
	return details?.error !== undefined;
}

function isLineIdAction(action: CodePathAction): boolean {
	if (action.kind === "replace" || action.kind === "append" || action.kind === "prepend") {
		return true;
	}
	if ((action.kind === "insertBefore" || action.kind === "insertAfter") && action.pos !== undefined) {
		return true;
	}
	return false;
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
	const op =
		action.kind === "append" || action.kind === "prepend"
			? action.kind
			: action.kind === "insertBefore"
				? "prepend"
				: action.kind === "insertAfter"
					? "append"
					: "replace";
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
	// Reverse map new kind names back to legacy wire format for executeCodePath.
	// The kernel still expects legacy Action enum variants.
	const newToLegacyKind: Record<string, string> = {
		fileCreate: "create",
		symbolReplace: "write",
		fileWrite: "write",
		symbolDelete: "delete",
		fileDelete: "delete",
		symbolRename: "rename",
		symbolWrap: "wrap",
		symbolFindReplace: "findAndReplace",
		symbolRawTextReplace: "rawTextReplace",
		fileFindReplace: "findAndReplace",
		fileRawTextReplace: "rawTextReplace",
		symbolSplice: "splice",
		symbolMove: "move",
		symbolClone: "clone",
		symbolTranspose: "transpose",
		symbolInsertBefore: "insertBefore",
		symbolInsertAfter: "insertAfter",
		fileAppend: "append",
		lineAppend: "append",
		linePrepend: "prepend",
		lineInsert: "insertBefore", // default; will adjust based on at.side
		filePrepend: "prepend",
		lineReplace: "replace",
		filePatch: "patch",
		headingPromote: "promote",
		headingDemote: "demote",
		headingReplaceBlock: "replaceCodeBlock",
		cssRenameClassToken: "renameClassToken",
		cssRenameIdToken: "renameIdToken",
		cssRenameCustomProp: "renameCustomProperty",
		cssRemoveDeadStyle: "removeDeadStyle",
	};
	const legacyKind = newToLegacyKind[action.kind] || action.kind;
	const actionAny = action as any;

	const out: Record<string, unknown> = { kind: legacyKind };
	// Reverse field mappings for new kinds:
	// - symbolRename: newName → content
	if (action.kind === "symbolRename" && (action as any).newName) {
		out.content = (action as any).newName;
	}
	// - symbolClone: renameTo → content
	else if (action.kind === "symbolClone" && (action as any).renameTo) {
		out.content = (action as any).renameTo;
	}
	// - cssRename*: replace → content, find stays
	else if (
		(action.kind === "cssRenameClassToken" ||
			action.kind === "cssRenameIdToken" ||
			action.kind === "cssRenameCustomProp") &&
		(action as any).replace
	) {
		out.content = (action as any).replace;
		if ((action as any).find) out.find = (action as any).find;
	}
	// - lineReplace: span → pos/end
	else if (action.kind === "lineReplace" && (action as any).span) {
		if ((action as any).span.start) out.pos = (action as any).span.start;
		if ((action as any).span.end) out.end = (action as any).span.end;
	}
	// - lineInsert: at{side, anchor} → pos + kind adjustment
	else if (action.kind === "lineInsert" && actionAny.at) {
		if (actionAny.at.anchor) out.pos = actionAny.at.anchor;
		// Adjust kind based on side
		if (actionAny.at.side === "after") {
			out.kind = "insertAfter";
		} else {
			out.kind = "insertBefore";
		}
		if (actionAny.content !== undefined) out.lines = normalizeLines(actionAny.content);
	}
	if (action.scope) out.scope = action.scope;
	// Only copy content/find if not already set by reverse mapping
	if (action.content !== undefined && out.content === undefined) out.content = normalizeLines(action.content);
	// For operations where kernel expects `lines` instead of `content`, convert here
	const needsLines = ["insertBefore", "insertAfter", "append", "prepend", "splice"];
	if (needsLines.includes(legacyKind) && action.content !== undefined && out.lines === undefined) {
		out.lines = normalizeLines(action.content);
		// Remove content since kernel doesn't expect both
		if (out.content !== undefined && legacyKind !== "splice") {
			delete out.content;
		}
	}
	if (action.find !== undefined && out.find === undefined) out.find = normalizeLines(action.find);
	// FEAT-701: lines/pos/end/diff were silently dropped; the kernel
	// Action enum requires `lines` for InsertBefore/InsertAfter/Append/
	// Prepend/Splice replacement, `pos`/`end` for LINE#ID anchors, and
	// `diff` for the patch action.
	if (action.lines !== undefined) out.lines = normalizeLines(action.lines);
	if (action.pos !== undefined) out.pos = action.pos;
	if (action.end !== undefined) out.end = action.end;
	if (action.diff !== undefined) out.diff = action.diff;
	if (action.mode) out.mode = action.mode;
	if (action.direction) out.direction = action.direction;
	if (action.line !== undefined) out.line = action.line;
	if (action.column !== undefined) out.column = action.column;
	if (action.nodeType) out.nodeType = action.nodeType;
	if (action.allowSiblingDelete !== undefined) out.allowSiblingDelete = action.allowSiblingDelete;
	if (action.occurrence !== undefined) out.occurrence = action.occurrence;
	// PLAN-308 W A2: force was previously dropped on fileCreate/fileWrite → create/write translation.
	if ((action as any).force !== undefined) out.force = (action as any).force;
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
	readonly description = editDescription;
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
		const transactionMode: "best-effort" | "strict" = params.transaction ?? "best-effort";

		// History ops (undo/redo): dispatch via kernel manage subcommand and short-circuit.
		// Reject batches mixing history with regular edits — history ops are atomic on
		// the workspace edit log, not per-target.
		const historyKinds = new Set(["undo", "redo"]);
		const hasHistory = params.operations.some(op => op && historyKinds.has(op.action.kind));
		if (hasHistory) {
			if (params.operations.length > 1) {
				const err = toolResult<EditToolResultDetails>({
					error: "history_op_in_batch",
				})
					.text("undo/redo operations must be dispatched alone; cannot be mixed with edits in the same batch.")
					.done();
				err.isError = true;
				return err;
			}
			const kind = params.operations[0].action.kind as "undo" | "redo";
			const chunks = await executeCodePath({
				command: "manage",
				manage: kind,
				target: "",
				abortSignal: signal,
			});
			const formatted = formatCodePathResult(chunks, { format: "node-list" });
			return toolResult<EditToolResultDetails>({ action: kind })
				.text(formatted.text ?? `${kind} complete`)
				.done();
		}

		// Pre-resolve target paths once; used by strict snapshot and the loop.
		// resolveCwdRelativePath auto-coalesces the cwd-prefix duplication pattern
		// (e.g. cwd `/proj/apps/foo` + target `apps/foo/lib/x.ts` → silent nest) when
		// on-disk evidence supports it. Degenerate paths (target == cwd-tail) are
		// the only hard-reject case; warnings are surfaced in per-op result text.
		const ops = params.operations
			.map((op, i) => {
				if (!op) return null;
				const resolved = resolveCwdRelativePath(sessionCwd, op.target, { mode: "file" });
				return { i, op, targetPath: resolved.path, resolved };
			})
			.filter(
				(
					x,
				): x is {
					i: number;
					op: NonNullable<EditParams["operations"][number]>;
					targetPath: string;
					resolved: ReturnType<typeof resolveCwdRelativePath>;
				} => x !== null,
			);

		// Strict transaction: snapshot every unique target file before any op runs.
		const snapshots = new Map<string, { existed: boolean; content: string | null }>();
		if (transactionMode === "strict") {
			for (const { targetPath } of ops) {
				if (snapshots.has(targetPath)) continue;
				if (await fs.exists(targetPath)) {
					snapshots.set(targetPath, { existed: true, content: await fs.readFile(targetPath, "utf-8") });
				} else {
					snapshots.set(targetPath, { existed: false, content: null });
				}
			}
		}

		const results: AgentToolResult[] = [];
		let failedOpIndex: number | null = null;
		const skippedOpIndices: number[] = [];

		for (const { i, op, targetPath, resolved } of ops) {
			// Degenerate cwd-prefix duplication (target path equals cwd-tail) is the
			// only case the coalesce helper cannot rescue; treat as fail-fast like
			// other batch-stopping diagnostics. Coalesced / kept-nested decisions are
			// surfaced as warnings on the per-op success text further below.
			if (resolved.decision === "degenerate") {
				const result = toolResult<EditToolResultDetails>({
					target: op.target,
					error: "cwd_prefix_duplication",
				})
					.text(resolved.warning ?? "cwd_prefix_duplication")
					.done();
				result.isError = true;
				results.push(result);
				failedOpIndex = i + 1;
				for (let j = i + 1; j < params.operations.length; j++) skippedOpIndices.push(j + 1);
				break;
			}

			enforceModeWrite(this.session, targetPath, { op: "update" });
			const sandboxError = enforcePathWrite(targetPath, sessionCwd, this.session.sandboxPolicy);
			if (sandboxError) throw new Error(sandboxError);

			const action = op.action;
			const idempotent = op.idempotent ?? params.idempotent ?? false;

			let result: AgentToolResult;
			if (isPatchAction(action)) {
				result = await this.#executePatch(targetPath, action.diff!, signal);
			} else if (isLineIdAction(action)) {
				result = await this.#executeLineId(targetPath, action, i + 1, idempotent);
			} else {
				result = await this.#executeStructural(targetPath, action, signal);
			}

			if (isErrorResult(result)) {
				result.isError = true;
				results.push(result);
				failedOpIndex = i + 1;
				for (let j = i + 1; j < params.operations.length; j++) skippedOpIndices.push(j + 1);
				break;
			}
			// Surface the coalesce/kept-nested warning so the agent self-corrects on
			// the next call. We append it; we do NOT mark the result as an error —
			// the op succeeded at the resolved location.
			if (resolved.warning && !isErrorResult(result)) {
				result = {
					...result,
					content: result.content.map((c, idx, all) => {
						// Append warning to the FIRST text node so single-op consumers
						// (which read result.content.find(type=text)) see it inline.
						if (c.type !== "text") return c;
						const firstTextIdx = all.findIndex(x => x.type === "text");
						return idx === firstTextIdx ? { ...c, text: `${c.text}\n⚠ ${resolved.warning}` } : c;
					}),
				};
			}
			results.push(result);
		}

		// Strict rollback: restore every snapshotted file on any failure.
		let rolledBack = false;
		if (transactionMode === "strict" && failedOpIndex !== null) {
			for (const [path, snap] of snapshots) {
				if (snap.existed) {
					await fs.writeFile(path, snap.content ?? "", "utf-8");
				} else if (await fs.exists(path)) {
					await fs.unlink(path);
				}
			}
			rolledBack = true;
		}

		// Single-op shortcut: hand the per-op result back unchanged (isError already stamped).
		if (params.operations.length === 1 && results.length === 1) return results[0]!;

		// Aggregate multi-op text with per-op headers and skipped/rolled-back markers.
		const sections: string[] = [];
		for (let i = 0; i < results.length; i++) {
			const tag = failedOpIndex === i + 1 ? " (failed)" : "";
			const body = results[i]!.content.filter(c => c.type === "text")
				.map(c => (c as { text?: string }).text ?? "")
				.join("\n");
			sections.push(`── operation ${i + 1}${tag} ──\n${body}`);
		}
		for (const idx of skippedOpIndices) sections.push(`── operation ${idx} (skipped) ──`);
		if (rolledBack) sections.push("Rolled back transaction:strict — all target files restored to pre-batch state.");
		const allText = sections.join("\n\n");

		const builder = toolResult<EditToolResultDetails>({ operations: params.operations.length }).text(allText);
		if (failedOpIndex !== null) builder.error();
		return builder.done();
	}

	async #executeStructural(
		targetPath: string,
		action: CodePathAction,
		_signal?: AbortSignal,
	): Promise<AgentToolResult> {
		// Delegate structural ops to the unified executeCodePath edit surface.
		const chunks = await executeCodePath({
			command: "edit",
			target: nodePath.relative(this.session.cwd, targetPath),
			actions: [normalizeStructuralAction(action)],
			root: this.session.cwd,
		});

		const diagnostics = chunks.flatMap(c => c.diagnostics);
		if (diagnostics.length > 0) {
			const diag = diagnostics[0]!;
			return toolResult<EditToolResultDetails>({
				target: nodePath.relative(this.session.cwd, targetPath),
				action: action.kind,
				error: diag.variant,
			})
				.text(diag.message)
				.done();
		}

		const nodes = chunks.flatMap(c => c.nodes);
		const editResult = nodes.find(n => n.kind === "§edit-result");
		const meta = editResult?.metadata as Record<string, unknown> | undefined;
		const diff = meta?.diff as string | undefined;
		const editCount = (meta?.editCount as number) ?? 1;
		const created = meta?.created as boolean | undefined;
		const summary = diff?.length
			? diff
			: created
				? `Created ${targetPath}`
				: `Updated ${targetPath} (${editCount} edit(s))`;
		return toolResult<EditToolResultDetails>({
			target: nodePath.relative(this.session.cwd, targetPath),
			action: action.kind,
		})
			.text(summary)
			.done();
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
				return toolResult<EditToolResultDetails>({
					target: nodePath.relative(this.session.cwd, targetPath),
					op: "create",
				})
					.text(`Created ${targetPath}`)
					.done();
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
				return toolResult<EditToolResultDetails>({
					target: nodePath.relative(this.session.cwd, targetPath),
					error: "stale_anchor",
				})
					.text(diag)
					.done();
			}
			throw err;
		}

		if (originalNormalized === normalizedText) {
			if (!idempotent) {
				return toolResult<EditToolResultDetails>({
					target: nodePath.relative(this.session.cwd, targetPath),
					noop: true,
				})
					.text(
						`No changes made to ${targetPath}. The edits produced identical content. Retry with idempotent=true only when an intentional no-op is acceptable.`,
					)
					.done();
			}
			return toolResult<EditToolResultDetails>({
				target: nodePath.relative(this.session.cwd, targetPath),
				noop: true,
				idempotent: true,
			})
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

		return toolResult<EditToolResultDetails>({
			target: nodePath.relative(this.session.cwd, targetPath),
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

		return toolResult<EditToolResultDetails>({
			target: nodePath.relative(this.session.cwd, targetPath),
			op: "update",
			diff: change.newContent,
		})
			.text(text)
			.done();
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
