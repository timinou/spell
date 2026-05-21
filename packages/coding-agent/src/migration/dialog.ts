/**
 * Interactive prompt for the YAML/JSON → KDL migrator.
 *
 * Renders findings to stdout, reads a single-letter answer from stdin via
 * node:readline. Falls back to "no" when stdin is not a TTY or the caller
 * passes `interactive=false`.
 *
 * No TUI / Component dependency — this runs at Settings.init() time, before
 * the rest of the runtime is wired up.
 */

import * as readline from "node:readline/promises";
import { logger } from "@oh-my-pi/pi-utils";
import type { Finding } from "./detect";

export type DialogAnswer = "yes" | "no" | "skip-forever" | "diff";

export interface DialogOptions {
	findings: Finding[];
	/** When false, render summary to logger and return "no" without prompting. */
	interactive?: boolean;
	/** Override stdin/stdout for tests. */
	input?: NodeJS.ReadableStream;
	output?: NodeJS.WritableStream;
}

/** ANSI color helpers — minimal, no theme system dependency at init time. */
const ansi = {
	bold: (s: string) => `\x1b[1m${s}\x1b[22m`,
	dim: (s: string) => `\x1b[2m${s}\x1b[22m`,
	accent: (s: string) => `\x1b[36m${s}\x1b[39m`,
	warn: (s: string) => `\x1b[33m${s}\x1b[39m`,
	success: (s: string) => `\x1b[32m${s}\x1b[39m`,
};

function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Render the migration summary. Returns the formatted string for both
 * stdout-write and logging paths.
 */
export function renderSummary(findings: Finding[]): string {
	const lines: string[] = [];
	lines.push("");
	lines.push(ansi.bold("Migrate Spell config to KDL?"));
	lines.push("");
	lines.push("Found legacy files:");
	const widest = findings.reduce((w, f) => Math.max(w, f.source.length), 0);
	for (const f of findings) {
		const pad = " ".repeat(Math.max(2, widest - f.source.length + 2));
		const tag = f.tier === "user" ? ansi.accent("[user]") : ansi.success("[project]");
		lines.push(`  ${f.source}${pad}${tag}  ${ansi.dim(`(${f.format}, ${formatBytes(f.bytes)})`)}`);
	}
	lines.push("");
	const uniqueDests = [...new Set(findings.map(f => f.dest))];
	lines.push("Will write to:");
	for (const d of uniqueDests) {
		lines.push(`  ${ansi.bold(d)}`);
	}
	lines.push("");
	lines.push(ansi.dim("Originals → *.migrated-YYYY-MM-DD.bak (idempotent: skipped on re-run)"));
	lines.push("");
	return lines.join("\n");
}

function renderPrompt(): string {
	return [
		ansi.bold("  [Y]"),
		"es   ",
		ansi.bold("[N]"),
		"o   ",
		ansi.bold("[S]"),
		"kip forever   ",
		ansi.bold("[D]"),
		"iff   ",
		ansi.dim("→ "),
	].join("");
}

/**
 * Run the dialog. Returns the user's chosen action.
 *
 * - Non-interactive (no TTY or `interactive=false`) → "no".
 * - Empty input / EOF → "no".
 * - Unknown character → re-prompt up to 3 times then "no".
 */
export async function runMigrationDialog(opts: DialogOptions): Promise<DialogAnswer> {
	const { findings, interactive = true } = opts;
	if (findings.length === 0) return "no";

	const output = opts.output ?? process.stdout;
	const input = opts.input ?? process.stdin;
	const isTTY = (input as NodeJS.ReadStream).isTTY === true;

	const summary = renderSummary(findings);

	if (!interactive || !isTTY) {
		// Non-interactive: surface the summary as a single warn entry so the
		// user discovers it in logs, but take no action.
		logger.warn("Spell config migration available (skipped, non-interactive)", {
			sources: findings.map(f => f.source),
			dests: [...new Set(findings.map(f => f.dest))],
		});
		return "no";
	}

	output.write(summary);

	const rl = readline.createInterface({ input, output, terminal: true });
	try {
		for (let attempt = 0; attempt < 3; attempt++) {
			let raw: string;
			try {
				raw = (await rl.question(renderPrompt())).trim().toLowerCase();
			} catch {
				// stdin closed mid-prompt (EOF). Treat as no.
				return "no";
			}
			if (raw === "" || raw === "n" || raw === "no") return "no";
			if (raw === "y" || raw === "yes") return "yes";
			if (raw === "s" || raw === "skip" || raw === "skip-forever") return "skip-forever";
			if (raw === "d" || raw === "diff") return "diff";
			output.write(ansi.warn(`Unknown answer "${raw}". Use Y / N / S / D.\n`));
		}
		output.write(ansi.warn("Too many invalid answers — skipping migration.\n"));
		return "no";
	} finally {
		rl.close();
	}
}
