import {
	TypstSurfaceSession,
	type TypstBlockKind,
	type TypstBlockModel,
	type TypstHitTestResult,
	type TypstSurfaceState,
	type TypstUnsupportedReason,
	type TypstViewport,
} from "@oh-my-pi/pi-natives";

export type TypstSourceAnchor = string;
export type TypstInlineStyle = "emphasis" | "strong";

export interface TypstEditDiagnostic {
	code: string;
	message: string;
	anchor?: TypstSourceAnchor;
	reason?: TypstUnsupportedReason;
}

export interface TypstEditSuccess {
	accepted: true;
	source: string;
	state: TypstSurfaceState;
	diagnostics: TypstEditDiagnostic[];
}

export interface TypstEditFailure {
	accepted: false;
	source: string;
	state: TypstSurfaceState;
	diagnostics: TypstEditDiagnostic[];
	reason: TypstUnsupportedReason;
}

export type TypstEditResult = TypstEditSuccess | TypstEditFailure;

interface VersionedOperation {
	expectedDocumentVersion?: number;
}

export interface SetBlockTextOp extends VersionedOperation {
	op: "set_block_text";
	anchor: TypstSourceAnchor;
	text: string;
}

export interface ToggleInlineStyleOp extends VersionedOperation {
	op: "toggle_inline_style";
	anchor: TypstSourceAnchor;
	style: TypstInlineStyle;
	startOffset: number;
	endOffset: number;
}

export interface SetBlockKindOp extends VersionedOperation {
	op: "set_block_kind";
	anchor: TypstSourceAnchor;
	kind: Extract<TypstBlockKind, "heading" | "paragraph" | "list_item">;
	level?: number;
}

export interface InsertBlockAfterOp extends VersionedOperation {
	op: "insert_block_after";
	anchor: TypstSourceAnchor;
	kind: Extract<TypstBlockKind, "heading" | "paragraph" | "list_item" | "image">;
	text: string;
	level?: number;
	assetPath?: string;
}

export interface DeleteBlockOp extends VersionedOperation {
	op: "delete_block";
	anchor: TypstSourceAnchor;
}

export interface MoveBlockOp extends VersionedOperation {
	op: "move_block";
	anchor: TypstSourceAnchor;
	beforeAnchor?: TypstSourceAnchor;
	afterAnchor?: TypstSourceAnchor;
}

export interface SetVariableOp extends VersionedOperation {
	op: "set_variable";
	anchor?: TypstSourceAnchor;
	name: string;
	value: string;
}

export interface ReplaceAssetRefOp extends VersionedOperation {
	op: "replace_asset_ref";
	anchor: TypstSourceAnchor;
	path: string;
}

export interface SetTableCellOp extends VersionedOperation {
	op: "set_table_cell";
	anchor: TypstSourceAnchor;
	row: number;
	column: number;
	value: string;
}

export interface ApplyAgentPatchOp extends VersionedOperation {
	op: "apply_agent_patch";
	source: string;
}

export type TypstEditOperation =
	| SetBlockTextOp
	| ToggleInlineStyleOp
	| SetBlockKindOp
	| InsertBlockAfterOp
	| DeleteBlockOp
	| MoveBlockOp
	| SetVariableOp
	| ReplaceAssetRefOp
	| SetTableCellOp
	| ApplyAgentPatchOp;

interface BlockSnapshot {
	model: TypstBlockModel;
	rawLines: string[];
}

export class TypstVisualEditEngine {
	#session: TypstSurfaceSession;
	#source = "";
	#state: TypstSurfaceState;
	#draftCounter = 0;

	constructor(options: { forceDegraded?: boolean } = {}) {
		this.#session = new TypstSurfaceSession({ forceDegraded: options.forceDegraded ?? false });
		this.#state = this.#session.state;
	}

	get source(): string {
		return this.#source;
	}

	get state(): TypstSurfaceState {
		return this.#state;
	}

	load(source: string): TypstSurfaceState {
		this.#source = normalizeSource(source);
		this.#state = this.#session.setDocument(this.#source);
		return this.#state;
	}

	setViewport(viewport: TypstViewport): TypstSurfaceState {
		this.#state = this.#session.setViewport(viewport);
		return this.#state;
	}

	hitTest(x: number, y: number): TypstHitTestResult {
		return this.#session.hitTest(x, y);
	}

	snapshotSvg(): string {
		return this.#session.snapshotSvg();
	}

	applyEdit(operation: TypstEditOperation): TypstEditResult {
		const versionFailure = this.#ensureDocumentVersion(operation);
		if (versionFailure) return versionFailure;
		if (operation.op === "apply_agent_patch") {
			return this.#commit(operation.source, [{ code: "agent_patch_applied", message: "Applied agent-generated Typst patch." }]);
		}

		const snapshots = buildSnapshots(this.#source, this.#state);
		const editableFailure =
			typeof (operation as { anchor?: string }).anchor === "string"
				? this.#ensureEditableTarget(snapshots, (operation as { anchor: string }).anchor)
				: null;
		if (editableFailure) return editableFailure;

		switch (operation.op) {
			case "set_block_text":
				return this.#applySetBlockText(snapshots, operation);
			case "toggle_inline_style":
				return this.#applyInlineStyle(snapshots, operation);
			case "set_block_kind":
				return this.#applySetBlockKind(snapshots, operation);
			case "insert_block_after":
				return this.#applyInsertBlock(snapshots, operation);
			case "delete_block":
				return this.#applyDeleteBlock(snapshots, operation);
			case "move_block":
				return this.#applyMoveBlock(snapshots, operation);
			case "set_variable":
				return this.#applySetVariable(snapshots, operation);
			case "replace_asset_ref":
				return this.#applyReplaceAsset(snapshots, operation);
			case "set_table_cell":
				return this.#applySetTableCell(snapshots, operation);
		}
	}

	#ensureDocumentVersion(operation: VersionedOperation): TypstEditFailure | null {
		if (
			typeof operation.expectedDocumentVersion === "number" &&
			operation.expectedDocumentVersion !== this.#state.documentVersion
		) {
			return this.#reject(
				"stale_mapping",
				"The visual selection is stale relative to the latest Typst source; reload mapping before editing.",
			);
		}
		return null;
	}

	#ensureEditableTarget(snapshots: BlockSnapshot[], anchor: TypstSourceAnchor): TypstEditFailure | null {
		const snapshot = snapshots.find((candidate) => candidate.model.anchor === anchor);
		if (!snapshot) {
			return this.#reject("stale_mapping", `No source anchor matches ${anchor}.`, anchor);
		}
		if (!snapshot.model.editable) {
			return this.#reject(
				snapshot.model.reason ?? "unsupported_block",
				"This Typst region is preview-only; direct editing is disabled to avoid corrupting unsupported syntax.",
				anchor,
			);
		}
		return null;
	}

	#applySetBlockText(snapshots: BlockSnapshot[], operation: SetBlockTextOp): TypstEditResult {
		const snapshot = requireSnapshot(snapshots, operation.anchor);
		if (!supportsTextEditing(snapshot.model.kind)) {
			return this.#reject("unsupported_block", `Block ${operation.anchor} does not support inline text editing.`, operation.anchor);
		}
		snapshot.model.text = operation.text;
		return this.#commit(recomposeSnapshots(snapshots), [
			{ code: "block_text_updated", message: `Updated text for ${operation.anchor}.`, anchor: operation.anchor },
		]);
	}

	#applyInlineStyle(snapshots: BlockSnapshot[], operation: ToggleInlineStyleOp): TypstEditResult {
		const snapshot = requireSnapshot(snapshots, operation.anchor);
		if (!supportsTextEditing(snapshot.model.kind)) {
			return this.#reject("unsupported_block", `Block ${operation.anchor} does not support inline styling.`, operation.anchor);
		}
		if (operation.startOffset < 0 || operation.endOffset <= operation.startOffset || operation.endOffset > snapshot.model.text.length) {
			return this.#reject("stale_mapping", "Inline style selection falls outside the current source span.", operation.anchor);
		}
		snapshot.model.text = toggleInlineStyle(snapshot.model.text, operation.startOffset, operation.endOffset, operation.style);
		return this.#commit(recomposeSnapshots(snapshots), [
			{ code: "inline_style_toggled", message: `Toggled ${operation.style} for ${operation.anchor}.`, anchor: operation.anchor },
		]);
	}

	#applySetBlockKind(snapshots: BlockSnapshot[], operation: SetBlockKindOp): TypstEditResult {
		const snapshot = requireSnapshot(snapshots, operation.anchor);
		snapshot.model.kind = operation.kind;
		snapshot.model.level = operation.kind === "heading" ? clampHeadingLevel(operation.level ?? snapshot.model.level ?? 1) : undefined;
		return this.#commit(recomposeSnapshots(snapshots), [
			{ code: "block_kind_changed", message: `Changed ${operation.anchor} to ${operation.kind}.`, anchor: operation.anchor },
		]);
	}

	#applyInsertBlock(snapshots: BlockSnapshot[], operation: InsertBlockAfterOp): TypstEditResult {
		const insertionIndex = snapshots.findIndex((candidate) => candidate.model.anchor === operation.anchor);
		if (insertionIndex < 0) {
			return this.#reject("stale_mapping", `No insertion anchor matches ${operation.anchor}.`, operation.anchor);
		}
		snapshots.splice(insertionIndex + 1, 0, createSnapshot(this.#nextDraftAnchor(), operation));
		return this.#commit(recomposeSnapshots(snapshots), [
			{ code: "block_inserted", message: `Inserted ${operation.kind} after ${operation.anchor}.`, anchor: operation.anchor },
		]);
	}

	#applyDeleteBlock(snapshots: BlockSnapshot[], operation: DeleteBlockOp): TypstEditResult {
		const index = snapshots.findIndex((candidate) => candidate.model.anchor === operation.anchor);
		if (index < 0) {
			return this.#reject("stale_mapping", `No block matches ${operation.anchor}.`, operation.anchor);
		}
		snapshots.splice(index, 1);
		return this.#commit(recomposeSnapshots(snapshots), [
			{ code: "block_deleted", message: `Deleted ${operation.anchor}.`, anchor: operation.anchor },
		]);
	}

	#applyMoveBlock(snapshots: BlockSnapshot[], operation: MoveBlockOp): TypstEditResult {
		if (Boolean(operation.beforeAnchor) === Boolean(operation.afterAnchor)) {
			return this.#reject("stale_mapping", "Move operations must specify exactly one of beforeAnchor or afterAnchor.", operation.anchor);
		}
		const sourceIndex = snapshots.findIndex((candidate) => candidate.model.anchor === operation.anchor);
		if (sourceIndex < 0) {
			return this.#reject("stale_mapping", `No block matches ${operation.anchor}.`, operation.anchor);
		}
		const [entry] = snapshots.splice(sourceIndex, 1);
		const targetAnchor = operation.beforeAnchor ?? operation.afterAnchor ?? "";
		const targetIndex = snapshots.findIndex((candidate) => candidate.model.anchor === targetAnchor);
		if (targetIndex < 0) {
			return this.#reject("stale_mapping", `Move target ${targetAnchor} no longer exists.`, operation.anchor);
		}
		const insertionIndex = operation.beforeAnchor ? targetIndex : targetIndex + 1;
		snapshots.splice(insertionIndex, 0, entry);
		return this.#commit(recomposeSnapshots(snapshots), [
			{ code: "block_moved", message: `Moved ${operation.anchor}.`, anchor: operation.anchor },
		]);
	}

	#applySetVariable(snapshots: BlockSnapshot[], operation: SetVariableOp): TypstEditResult {
		let snapshot = operation.anchor ? snapshots.find((candidate) => candidate.model.anchor === operation.anchor) : undefined;
		if (!snapshot) {
			snapshot = snapshots.find((candidate) => getVariableName(candidate.model.meta) === operation.name);
		}
		if (!snapshot) {
			snapshots.unshift(createVariableSnapshot(this.#nextDraftAnchor(), operation.name, operation.value));
			return this.#commit(recomposeSnapshots(snapshots), [
				{ code: "variable_inserted", message: `Inserted variable ${operation.name}.` },
			]);
		}
		snapshot.model.kind = "variable";
		snapshot.model.text = `${operation.name} = ${operation.value}`;
		snapshot.model.meta = { name: operation.name, value: operation.value };
		return this.#commit(recomposeSnapshots(snapshots), [
			{ code: "variable_updated", message: `Updated variable ${operation.name}.`, anchor: snapshot.model.anchor },
		]);
	}

	#applyReplaceAsset(snapshots: BlockSnapshot[], operation: ReplaceAssetRefOp): TypstEditResult {
		const snapshot = requireSnapshot(snapshots, operation.anchor);
		if (snapshot.model.kind !== "image") {
			return this.#reject("unsupported_block", `Block ${operation.anchor} is not an image asset reference.`, operation.anchor);
		}
		snapshot.model.text = operation.path;
		snapshot.model.meta = { path: operation.path };
		return this.#commit(recomposeSnapshots(snapshots), [
			{ code: "asset_replaced", message: `Replaced image asset for ${operation.anchor}.`, anchor: operation.anchor },
		]);
	}

	#applySetTableCell(snapshots: BlockSnapshot[], operation: SetTableCellOp): TypstEditResult {
		const snapshot = requireSnapshot(snapshots, operation.anchor);
		if (snapshot.model.kind !== "table") {
			return this.#reject("unsupported_block", `Block ${operation.anchor} is not a supported table.`, operation.anchor);
		}
		const rows = getTableRows(snapshot.model.meta);
		while (rows.length <= operation.row) {
			rows.push([]);
		}
		while (rows[operation.row].length <= operation.column) {
			rows[operation.row].push("");
		}
		rows[operation.row][operation.column] = operation.value;
		snapshot.model.meta = { rows };
		snapshot.model.text = rows.map((row) => `| ${row.join(" | ")} |`).join("\n");
		return this.#commit(recomposeSnapshots(snapshots), [
			{ code: "table_cell_updated", message: `Updated table cell ${operation.row},${operation.column}.`, anchor: operation.anchor },
		]);
	}

	#commit(nextSource: string, diagnostics: TypstEditDiagnostic[]): TypstEditResult {
		this.#source = normalizeSource(nextSource);
		this.#state = this.#session.setDocument(this.#source);
		return {
			accepted: true,
			source: this.#source,
			state: this.#state,
			diagnostics,
		};
	}

	#reject(reason: TypstUnsupportedReason, message: string, anchor?: TypstSourceAnchor): TypstEditFailure {
		return {
			accepted: false,
			source: this.#source,
			state: this.#state,
			reason,
			diagnostics: [{ code: "edit_rejected", message, anchor, reason }],
		};
	}

	#nextDraftAnchor(): string {
		this.#draftCounter += 1;
		return `draft-${this.#draftCounter}`;
	}
}

function buildSnapshots(source: string, state: TypstSurfaceState): BlockSnapshot[] {
	const lines = source.length === 0 ? [] : source.split("\n");
	return state.blocks.map((block) => ({
		model: { ...block, meta: cloneValue(block.meta) },
		rawLines: lines.slice(block.span.startLine - 1, block.span.endLine),
	}));
}

function cloneValue<T>(value: T): T {
	return structuredClone(value);
}

function requireSnapshot(snapshots: BlockSnapshot[], anchor: TypstSourceAnchor): BlockSnapshot {
	const snapshot = snapshots.find((candidate) => candidate.model.anchor === anchor);
	if (!snapshot) {
		throw new Error(`Missing snapshot for ${anchor}`);
	}
	return snapshot;
}

function normalizeSource(source: string): string {
	return source.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

function recomposeSnapshots(snapshots: BlockSnapshot[]): string {
	const sections: string[] = [];
	let previousKind: TypstBlockKind | null = null;
	for (const snapshot of snapshots) {
		const rendered = serializeSnapshot(snapshot);
		if (rendered.length === 0) continue;
		if (sections.length > 0 && needsBlankLine(previousKind, snapshot.model.kind)) {
			sections.push("");
		}
		sections.push(...rendered);
		previousKind = snapshot.model.kind;
	}
	return sections.join("\n");
}

function serializeSnapshot(snapshot: BlockSnapshot): string[] {
	switch (snapshot.model.kind) {
		case "heading":
			return [`${"=".repeat(clampHeadingLevel(snapshot.model.level ?? 1))} ${snapshot.model.text}`];
		case "paragraph":
			return [snapshot.model.text];
		case "list_item":
			return [`- ${snapshot.model.text}`];
		case "image": {
			const path = getImagePath(snapshot.model.meta) ?? snapshot.model.text;
			return [`#image("${path}")`];
		}
		case "table":
			return getTableRows(snapshot.model.meta).map((row) => `| ${row.join(" | ")} |`);
		case "variable": {
			const name = getVariableName(snapshot.model.meta) ?? "variable";
			const value = getVariableValue(snapshot.model.meta) ?? "\"\"";
			return [`#let ${name} = ${value}`];
		}
		case "unsupported":
			return snapshot.rawLines;
	}
}

function supportsTextEditing(kind: TypstBlockKind): boolean {
	return kind === "heading" || kind === "paragraph" || kind === "list_item";
}

function toggleInlineStyle(text: string, startOffset: number, endOffset: number, style: TypstInlineStyle): string {
	const marker = style === "strong" ? "**" : "_";
	const selected = text.slice(startOffset, endOffset);
	const prefixed = text.slice(Math.max(0, startOffset - marker.length), startOffset);
	const suffixed = text.slice(endOffset, endOffset + marker.length);
	if (prefixed === marker && suffixed === marker) {
		return `${text.slice(0, startOffset - marker.length)}${selected}${text.slice(endOffset + marker.length)}`;
	}
	return `${text.slice(0, startOffset)}${marker}${selected}${marker}${text.slice(endOffset)}`;
}

function clampHeadingLevel(level: number): number {
	return Math.min(6, Math.max(1, Math.trunc(level)));
}

function createSnapshot(anchor: string, operation: InsertBlockAfterOp): BlockSnapshot {
	const kind = operation.kind;
	const text = kind === "image" ? operation.assetPath ?? operation.text : operation.text;
	const meta =
		kind === "image"
			? { path: operation.assetPath ?? operation.text }
			: kind === "heading"
				? {}
				: {};
		return {
			model: {
				anchor,
				kind,
				text,
				span: { anchor, startLine: 1, endLine: 1, startColumn: 1, endColumn: text.length + 1 },
				bounds: { page: 1, x: 0, y: 0, width: 0, height: 0 },
				editable: true,
				level: kind === "heading" ? clampHeadingLevel(operation.level ?? 1) : undefined,
				meta,
			},
			rawLines: [],
		};
}

function createVariableSnapshot(anchor: string, name: string, value: string): BlockSnapshot {
	return {
		model: {
			anchor,
			kind: "variable",
			text: `${name} = ${value}`,
			span: { anchor, startLine: 1, endLine: 1, startColumn: 1, endColumn: value.length + 1 },
			bounds: { page: 1, x: 0, y: 0, width: 0, height: 0 },
			editable: true,
			meta: { name, value },
		},
		rawLines: [],
	};
}

function needsBlankLine(previous: TypstBlockKind | null, next: TypstBlockKind): boolean {
	if (previous === null) return false;
	if (previous === "list_item" && next === "list_item") return false;
	if (previous === "table" && next === "table") return false;
	if (previous === "variable" && next === "variable") return false;
	return true;
}

function getTableRows(meta: unknown): string[][] {
	if (!isRecord(meta)) return [[]];
	const rows = meta.rows;
	if (!Array.isArray(rows)) return [[]];
	return rows.map((row) => (Array.isArray(row) ? row.map((cell) => String(cell)) : []));
}

function getImagePath(meta: unknown): string | undefined {
	if (!isRecord(meta) || typeof meta.path !== "string") return undefined;
	return meta.path;
}

function getVariableName(meta: unknown): string | undefined {
	if (!isRecord(meta) || typeof meta.name !== "string") return undefined;
	return meta.name;
}

function getVariableValue(meta: unknown): string | undefined {
	if (!isRecord(meta) || typeof meta.value !== "string") return undefined;
	return meta.value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}
