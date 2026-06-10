import * as fs from "node:fs/promises";
import * as nodePath from "node:path";
import type { AgentTool, AgentToolContext, AgentToolResult, AgentToolUpdateCallback } from "@spell/pi-agent-core";
import { executeCodePath } from "@spell/pi-natives";
import type { Component } from "@spell/pi-tui";
import type { RenderResultOptions } from "../extensibility/custom-tools/types";
import type { Theme } from "../modes/theme/theme";
import type { FileSystem, PatchInput } from "../patch";
import { applyPatch } from "../patch";
import editDescription from "../prompts/tools/edit.md" with { type: "text" };
import { enforcePathWrite } from "../sandbox";
import { renderCodeCell } from "../tui";
import type { ToolSession } from ".";
import { formatCodePathResult } from "./codepath-result";
import { sessionContextOpts } from "./codepath-session";
import type { EditParams } from "./codepath-types";
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

/**
 * Compose a descriptive title for an edit-result cell: `<verb> · <target>`,
 * or `<n> ops` for an aggregated batch. Keeps the bare "Edit" only when no
 * details survive. Errors get a leading ⚠ so the title reads at a glance.
 */
function editResultTitle(d: EditToolResultDetails | undefined, isError: boolean): string {
	const lead = isError ? "⚠ " : "";
	if (!d) return `${lead}Edit`;
	if (typeof d.operations === "number" && d.operations > 1) {
		return `${lead}edit · ${d.operations} ops`;
	}
	const verb = d.action ?? d.op;
	if (verb && d.target) return `${lead}${verb} · ${d.target}`;
	if (d.target) return `${lead}edit · ${d.target}`;
	if (verb) return `${lead}${verb}`;
	return `${lead}Edit`;
}

function normalizeLines(value: string | string[] | null | undefined): string | undefined {
	if (value === undefined || value === null) return undefined;
	return typeof value === "string" ? value : value.join("\n");
}

// BUG-403: kinds that REQUIRE the target file to exist before applying.
// Excludes fileCreate (creates the file) and the anchorless fileAppend /
// filePrepend variants (those create on absence, handled separately).
const MUTATING_KINDS = new Set([
	// Unified 3-verb surface (PLAN-320)
	"replace",
	"rename",
	"delete",
	// Legacy OpKind taxonomy
	"fileWrite",
	"fileDelete",
	"filePatch",
	"fileFindReplace",
	"fileRawTextReplace",
	"symbolReplace",
	"symbolRename",
	"symbolWrap",
	"symbolDelete",
	"symbolInsertBefore",
	"symbolInsertAfter",
	"symbolFindReplace",
	"symbolRawTextReplace",
	"symbolMove",
	"symbolClone",
	"symbolSplice",
	"symbolTranspose",
	"lineReplace",
	"lineInsert",
	"lineAppend",
	"linePrepend",
	"headingPromote",
	"headingDemote",
	"headingReplaceBlock",
	"cssRenameClassToken",
	"cssRenameIdToken",
	"cssRenameCustomProp",
	"cssRemoveDeadStyle",
]);
function isMutatingKind(kind: string | undefined): boolean {
	return kind !== undefined && MUTATING_KINDS.has(kind);
}

function isErrorResult(result: AgentToolResult): boolean {
	if (result.isError === true) return true;
	const details = result.details as { error?: unknown } | undefined;
	return details?.error !== undefined;
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

	constructor(private readonly session: ToolSession) {}

	async execute(
		_toolCallId: string,
		params: EditParams,
		signal?: AbortSignal,
		_onUpdate?: AgentToolUpdateCallback,
		_context?: AgentToolContext,
	): Promise<AgentToolResult> {
		const sessionCwd = this.session.cwd;
		// BUG-401: `params.root` is the agent-supplied resolution root. Falls
		// back to `session.cwd`. Always absolute (resolved against sessionCwd
		// when relative). Threaded into both fs path resolution and the
		// kernel call's `root` so the two stay in lockstep.
		const effectiveCwd =
			params.root && params.root.length > 0
				? nodePath.isAbsolute(params.root)
					? params.root
					: nodePath.resolve(sessionCwd, params.root)
				: sessionCwd;
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
				...sessionContextOpts(this.session ?? null),
				command: "manage",
				manage: kind,
				target: "",
				sessionId: this.session.getSessionId?.()?.trim() || undefined,
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
				const resolved = resolveCwdRelativePath(effectiveCwd, op.target, { mode: "file" });
				// The on-disk file is the locator part only: strip the `::Symbol`
				// query, the `#body`/`#sig` qualifier, and a trailing `:A-B` / `:A`
				// / `:A-` line-slice suffix. The slice regex is end-anchored and
				// digit-only so it cannot clip a Windows drive prefix (`C:\`) or a
				// mid-path colon. Used for existence checks AND strict-transaction
				// snapshot/rollback keying — both must address the real file, not
				// the qualified target (otherwise rollback silently no-ops).
				const filePart = resolved.path
					.split("::")[0]!
					.split("#")[0]!
					.replace(/:\d+(?:-\d*)?$/, "");
				return { i, op, targetPath: resolved.path, filePart, resolved };
			})
			.filter(
				(
					x,
				): x is {
					i: number;
					op: NonNullable<EditParams["operations"][number]>;
					targetPath: string;
					filePart: string;
					resolved: ReturnType<typeof resolveCwdRelativePath>;
				} => x !== null,
			);

		// Strict transaction: snapshot every unique target file before any op runs.
		const snapshots = new Map<string, { existed: boolean; content: string | null }>();
		if (transactionMode === "strict") {
			for (const { filePart } of ops) {
				if (snapshots.has(filePart)) continue;
				if (await fs.exists(filePart)) {
					snapshots.set(filePart, { existed: true, content: await fs.readFile(filePart, "utf-8") });
				} else {
					snapshots.set(filePart, { existed: false, content: null });
				}
			}
		}

		const results: AgentToolResult[] = [];
		let failedOpIndex: number | null = null;
		const skippedOpIndices: number[] = [];

		for (const { i, op, targetPath, filePart, resolved } of ops) {
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
			const opKindPre = (action as any).kind as string | undefined;

			// BUG-403: ops that mutate an existing file must fail loud and early
			// when the target is missing, rather than degrading into a confusing
			// downstream diagnostic (e.g. "scope is empty — buffer is 0 bytes").
			// Anchorless fileAppend/filePrepend create-on-absence and are handled
			// below; fileCreate is excluded from MUTATING_KINDS.
			const isAnchorlessCreate =
				(opKindPre === "fileAppend" || opKindPre === "filePrepend") && !(action as any).pos && !(action as any).end;
			// `filePart` (the on-disk locator, qualifiers stripped) is precomputed
			// alongside the resolved target so existence checks and strict-transaction
			// snapshot/rollback share one notion of "the file".
			if (isMutatingKind(opKindPre) && !isAnchorlessCreate && !(await fs.exists(filePart))) {
				const result = toolResult<EditToolResultDetails>({
					target: op.target,
					action: opKindPre,
					error: "file_not_found",
				})
					.text(`file not found: ${op.target} (create it before editing)`)
					.done();
				result.isError = true;
				results.push(result);
				failedOpIndex = i + 1;
				for (let j = i + 1; j < params.operations.length; j++) skippedOpIndices.push(j + 1);
				break;
			}

			let result: AgentToolResult;
			// Route by Op kind
			const opKind = (action as any).kind;
			if (opKind === "filePatch" || opKind === "patch") {
				result = await this.#executePatch(targetPath, (action as any).diff!, signal);
			} else if (
				(opKind === "fileAppend" || opKind === "filePrepend") &&
				!(action as any).pos &&
				!(action as any).end &&
				!(await fs.exists(targetPath))
			) {
				// File-create shortcut: anchorless fileAppend/filePrepend on a
				// missing file becomes a creation. Single-shot, no kernel round-trip.
				result = await this.#executeLineId(targetPath, action, i + 1, idempotent);
			} else {
				// All other ops — including numeric-anchor line ops since
				// PLAN-317 — route through the kernel's TextResolver.
				result = await this.#executeStructural(targetPath, action, effectiveCwd, signal);
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
		action: any,
		effectiveCwd: string,
		_signal?: AbortSignal,
	): Promise<AgentToolResult> {
		// Delegate structural ops to the NAPI edit surface.
		// The Rust layer (CodeBuffer::open / CodePath resolver) handles
		// file existence checks with proper diagnostics — no need for a
		// TS-layer pre-flight gate that duplicates this logic.
		const chunks = await executeCodePath({
			...sessionContextOpts(this.session ?? null),
			command: "edit",
			target: nodePath.relative(effectiveCwd, targetPath),
			actions: [action],
			root: effectiveCwd,
			sessionId: this.session.getSessionId?.()?.trim() || undefined,
		});

		const diagnostics = chunks.flatMap(c => c.diagnostics);
		if (diagnostics.length > 0) {
			const diag = diagnostics[0]!;
			const text = diag.message;
			return toolResult<EditToolResultDetails>({
				target: nodePath.relative(effectiveCwd, targetPath),
				action: action.kind,
				error: diag.variant,
			})
				.text(text)
				.done();
		}

		const nodes = chunks.flatMap(c => c.nodes);
		const editResult = nodes.find(n => n.kind === "§edit-result");
		const meta = editResult?.metadata as Record<string, unknown> | undefined;
		const diff = meta?.diff as string | undefined;
		const editCount = (meta?.editCount as number) ?? 1;
		const created = meta?.created as boolean | undefined;
		const relTarget = nodePath.relative(effectiveCwd, targetPath);
		// Dual-audience summary: a one-line `<verb> · <target>` header gives the
		// agent immediate context (the diff's own ---/+++ headers are generic),
		// followed by the unified diff body. Falls back to the flat status line
		// when no diff is available (e.g. no-op or whole-file create/delete).
		const header = `${action.kind} · ${relTarget}`;
		const summary = diff?.length
			? `${header}\n${diff}`
			: created
				? `Created ${targetPath}`
				: `Updated ${targetPath} (${editCount} edit(s))`;
		return toolResult<EditToolResultDetails>({
			target: relTarget,
			action: action.kind,
		})
			.text(summary)
			.data({ diff, editCount, created })
			.done();
	}

	/**
	 * Anchorless fileAppend / filePrepend on a missing file becomes a
	 * single-shot file creation. PLAN-317 removed the hashline-anchor
	 * dispatch — every other line op goes through #executeStructural.
	 */
	async #executeLineId(
		targetPath: string,
		action: any,
		_editIndex: number,
		_idempotent: boolean,
	): Promise<AgentToolResult> {
		const body = normalizeLines(action.content) ?? "";
		await fs.mkdir(nodePath.dirname(targetPath), { recursive: true });
		await fs.writeFile(targetPath, body, "utf-8");
		return toolResult<EditToolResultDetails>({
			target: nodePath.relative(this.session.cwd, targetPath),
			op: "create",
		})
			.text(`Created ${targetPath}`)
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
			.data({ type: change.type, path: change.path, newPath: change.newPath, warnings: result.warnings })
			.done();
	}

	renderResult(result: AgentToolResult, options: RenderResultOptions, theme: unknown): Component {
		const uiTheme = theme as Theme;
		const text = result.content
			.filter(c => c.type === "text")
			.map(c => (c as { text?: string }).text ?? "")
			.join("\n");
		// Descriptive title: name the verb + target (and op count for batches) so
		// the cell reads e.g. `replace · src/app.ts::greet` instead of a bare
		// "Edit". Falls back to "Edit" when details are absent.
		const d = result.details as EditToolResultDetails | undefined;
		const title = editResultTitle(d, result.isError === true);
		// The agent-facing text prepends a `<verb> · <target>` header for context;
		// the TUI already shows that in the title, so drop a leading header line
		// that matches it to keep the diff cell clean.
		const verb = d?.action ?? d?.op;
		const headerLine = verb && d?.target ? `${verb} · ${d.target}` : undefined;
		const body = headerLine && text.startsWith(`${headerLine}\n`) ? text.slice(headerLine.length + 1) : text;
		const sanitized = replaceTabs(body);
		const maxChars = 2_000;
		const truncated = sanitized.length > maxChars ? `${sanitized.slice(0, maxChars)}\n...truncated` : sanitized;
		return {
			render: (width: number) =>
				renderCodeCell(
					{
						code: truncated,
						language: "diff",
						title,
						status: result.isError === true ? "error" : "complete",
						expanded: options.expanded,
						width,
					},
					uiTheme,
				),
			invalidate: () => {},
		};
	}
}
