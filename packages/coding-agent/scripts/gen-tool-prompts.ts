#!/usr/bin/env bun
/**
 * Generate tool-prompt fragment files from kernel introspection data.
 *
 * Sources:
 *   listOpKinds(), listQualifiers(), listEdgeKinds(), listDiagnosticVariants(),
 *   listLanguageDialects()
 *
 * Output (under src/prompts/tools/_generated/):
 *   edit-ops.md         — Op variants grouped by family
 *   find-recipes.md     — Recipe table of qualifiers, edges, and common targets
 *   status-cmds.md      — Status command table (hand-crafted; kernel not introspected)
 *   diag-vocabulary.md  — Diagnostic variants from kernel
 */

import {
	listOpKinds,
	listQualifiers,
	listEdgeKinds,
	listDiagnosticVariants,
	listLanguageDialects,
} from "@oh-my-pi/pi-natives";
import * as fs from "node:fs/promises";
import * as path from "node:path";

const OUT_DIR = path.join(import.meta.dir, "..", "src", "prompts", "tools", "_generated");

// ── Families ────────────────────────────────────────────────────────

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

function describeOp(op: { kind: string; requiredFields: string[]; optionalFields: string[] }): string {
	const parts: string[] = [];
	if (op.requiredFields.length > 0) {
		parts.push(`(${op.requiredFields.join(", ")})`);
	}
	if (op.optionalFields.length > 0) {
		parts.push(`(${op.optionalFields.join(", ")}?)`);
	}
	return parts.join(" ");
}

// ── Fragment: edit-ops.md ───────────────────────────────────────────

function genEditOps(): string {
	const ops = listOpKinds();
	const lines: string[] = [];

	for (const family of FAMILIES) {
		const familyOps = ops.filter(o => o.family === family.name).sort((a, b) => a.kind.localeCompare(b.kind));
		if (familyOps.length === 0) continue;
		if (family.name === "css") {
			// Merge with heading under "heading/css" heading
			continue;
		}
		if (family.name === "heading") {
			lines.push(`${family.label} — ${family.targetHint}`);
			// Add heading ops
			const hdrOps = ops.filter(o => o.family === "heading").sort((a, b) => a.kind.localeCompare(b.kind));
			const cssOps = ops.filter(o => o.family === "css").sort((a, b) => a.kind.localeCompare(b.kind));
			const combined = [...hdrOps, ...cssOps];
			lines.push(`  ${combined.map(o => o.kind).join(" · ")}`);
			lines.push("");
			continue;
		}
		lines.push(`${family.label} — ${family.targetHint}`);
		for (const op of familyOps) {
			const desc = describeOp(op);
			lines.push(`  ${op.kind.padEnd(22)} ${desc}`);
		}
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
