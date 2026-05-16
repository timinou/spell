#!/usr/bin/env bun
/**
 * Generate tool-prompt fragment files from kernel introspection data.
 *
 * Sources:
 *   listOps(), listQualifiers(), listEdgeKinds(),
 *   listDiagnosticVariants(), listLanguageDialects()
 *
 * Uses `listOps()` (PLAN-308 Wave B) for richer per-variant metadata
 * including field types and descriptions — supersedes `listOpKinds()`.
 *
 * Output (under src/prompts/tools/_generated/):
 *   edit-ops.md         — Op variants grouped by family, with field types & descriptions
 *   find-recipes.md     — Recipe table of qualifiers, edges
 *   status-cmds.md      — Status command table (hand-crafted; kernel not introspected)
 *   diag-vocabulary.md  — Diagnostic variants from kernel
 *   dialects.md         — Language dialects from kernel
 */

import {
	listOps,
	listQualifiers,
	listEdgeKinds,
	listDiagnosticVariants,
	listLanguageDialects,
} from "@oh-my-pi/pi-natives";
import * as fs from "node:fs/promises";
import * as path from "node:path";

const OUT_DIR = path.join(import.meta.dir, "..", "src", "prompts", "tools", "_generated");

// ── Family helpers ───────────────────────────────────────────────────

/** Infer the target family from the Op's kind name prefix. */
function familyForKind(kind: string): string {
	if (kind.startsWith("symbol")) return "symbol";
	if (kind.startsWith("file")) return "file";
	if (kind.startsWith("line")) return "line";
	if (kind.startsWith("css")) return "css";
	if (kind.startsWith("heading")) return "heading";
	return "unknown";
}

interface FamilyDef {
	name: string;
	label: string;
	targetHint: string;
}

const FAMILIES: FamilyDef[] = [
	{ name: "symbol", label: "symbol-scoped", targetHint: "target must be `<file>::Symbol`" },
	{ name: "file", label: "file-scoped", targetHint: "target is `<file>`" },
	{ name: "line", label: "line-scoped", targetHint: "target is `<file>`" },
	{ name: "heading", label: "heading/css", targetHint: "Markdown/Org/CSS specific" },
	{ name: "css", label: "heading/css", targetHint: "Markdown/Org/CSS specific" },
];

// ── Fragment: edit-ops.md ───────────────────────────────────────────

/**
 * Build a field summary string for one Op variant, excluding the `target` field
 * (described in the family header).
 */
function describeFields(op: { kind: string; fields: { name: string; typeName: string; required: boolean; description: string }[] }): string {
	const nonTarget = op.fields.filter(f => f.name !== "target");
	if (nonTarget.length === 0) return "";

	const parts = nonTarget.map(f => {
		const req = f.required ? "required" : "optional";
		return `${f.name} (${req} ${f.typeName}) — ${f.description}`;
	});
	return parts.join(" · ");
}

function genEditOps(): string {
	const ops = listOps();
	const lines: string[] = [];

	for (const family of FAMILIES) {
		// css merged into heading
		if (family.name === "css") continue;

		const familyOps = ops
			.filter(o => familyForKind(o.kind) === family.name)
			.sort((a, b) => a.kind.localeCompare(b.kind));

		if (familyOps.length === 0) continue;

		if (family.name === "heading") {
			// Merge heading + css ops
			const hdrOps = ops.filter(o => familyForKind(o.kind) === "heading").sort((a, b) => a.kind.localeCompare(b.kind));
			const cssOps = ops.filter(o => familyForKind(o.kind) === "css").sort((a, b) => a.kind.localeCompare(b.kind));
			const combined = [...hdrOps, ...cssOps];

			lines.push(`${family.label} — ${family.targetHint}`);
			const combinedPad = Math.max(...combined.map(x => x.kind.length)) + 2;
			const entries = combined.map(o => {
				const fields = describeFields(o);
				if (!fields) return `  ${o.kind.padEnd(combinedPad)}`;
				return `  ${o.kind.padEnd(combinedPad)} ${fields}`;
			});
			lines.push(...entries);
			lines.push("");
			continue;
		}

		lines.push(`${family.label} — ${family.targetHint}`);
		const padLen = Math.max(...familyOps.map(x => x.kind.length)) + 2;
		const entries = familyOps.map(o => {
			const fields = describeFields(o);
			if (!fields) return `  ${o.kind.padEnd(padLen)}`;
			return `  ${o.kind.padEnd(padLen)} ${fields}`;
		});
		lines.push(...entries);
		lines.push("");
	}

	// history: hand-crafted (not in kernel)
	lines.push("history — no target, dispatched alone (not mixed with other ops)");
	lines.push("  undo · redo");
	lines.push("");

	return lines.join("\n");
}

// ── Fragment: find-recipes.md ───────────────────────────────────────

function genFindRecipes(): string {
	const qualifiers = listQualifiers().sort((a, b) => a.name.localeCompare(b.name));
	const edges = listEdgeKinds().sort((a, b) => a.symbol.localeCompare(b.symbol));

	const lines: string[] = [];

	lines.push("## Qualifiers");
	lines.push("");
	lines.push("| qualifier | applies to | args |");
	lines.push("|---|---|---|");
	for (const q of qualifiers) {
		const args = q.argsSchema ?? "—";
		const applies = q.appliesTo.join(", ");
		lines.push(`| #${q.name} | ${applies} | ${args} |`);
	}
	lines.push("");

	lines.push("## Edge kinds");
	lines.push("");
	lines.push("| symbol | name | description |");
	lines.push("|---|---|---|");
	for (const e of edges) {
		lines.push(`| ${e.symbol} | ${e.name} | ${e.description} |`);
	}
	lines.push("");

	return lines.join("\n");
}

// ── Fragment: dialects.md ───────────────────────────────────────────

function genDialects(): string {
	const dialects = listLanguageDialects().sort((a, b) => a.id.localeCompare(b.id));
	const lines: string[] = [];
	lines.push("| dialect | extensions | capabilities |");
	lines.push("|---|---|---|");
	for (const d of dialects) {
		lines.push(`| ${d.id} | ${d.extensions.join(", ") || "—"} | ${d.capabilities.join(", ") || "—"} |`);
	}
	lines.push("");
	return lines.join("\n");
}

// ── Fragment: status-cmds.md — hand-crafted ─────────────────────────

function genStatusCmds(): string {
	// Kernel does not expose status command introspection; hand-crafted table.
	const commands: { cmd: string; desc: string }[] = [
		{ cmd: "languages", desc: "loaded tree-sitter grammars + load state" },
		{ cmd: "index", desc: "code-graph indexing state (gates def→/ref→/call→)" },
		{ cmd: "watcherStatus", desc: "FS watcher health + queue" },
		{ cmd: "lockStatus", desc: "per-file lock ownership + waiters" },
		{ cmd: "status", desc: "overall resolver + dialect registry snapshot" },
	];

	const lines: string[] = [];
	lines.push("| command | shows |");
	lines.push("|---|---|");
	for (const c of commands) {
		lines.push(`| ${c.cmd} | ${c.desc} |`);
	}
	lines.push("");
	return lines.join("\n");
}

// ── Fragment: diag-vocabulary.md ────────────────────────────────────

function genDiagVocabulary(): string {
	const variants = listDiagnosticVariants().sort((a, b) => a.variant.localeCompare(b.variant));

	const lines: string[] = [];
	lines.push("| variant | severity | template |");
	lines.push("|---|---|---|");
	for (const v of variants) {
		lines.push(`| ${v.variant} | ${v.severity} | \`${v.template}\` |`);
	}
	lines.push("");
	return lines.join("\n");
}

// ── Main ────────────────────────────────────────────────────────────

async function main() {
	await fs.mkdir(OUT_DIR, { recursive: true });

	await fs.writeFile(path.join(OUT_DIR, "edit-ops.md"), genEditOps(), "utf-8");
	await fs.writeFile(path.join(OUT_DIR, "find-recipes.md"), genFindRecipes(), "utf-8");
	await fs.writeFile(path.join(OUT_DIR, "dialects.md"), genDialects(), "utf-8");
	await fs.writeFile(path.join(OUT_DIR, "status-cmds.md"), genStatusCmds(), "utf-8");
	await fs.writeFile(path.join(OUT_DIR, "diag-vocabulary.md"), genDiagVocabulary(), "utf-8");

	console.log("✓ Generated 5 fragment files in", OUT_DIR);
}

main().catch(err => {
	console.error("Failed to generate tool prompts:", err);
	process.exit(1);
});
