/**
 * One-shot migration entry point.
 *
 * The ONLY symbol settings.ts needs to import is `maybeRunMigration`. When
 * the migration is no longer needed, removal is `rm -rf src/migration/` plus
 * deleting the import + call in settings.ts. No other coupling exists.
 *
 * Behavior
 *  ───────
 *
 *   ┌─ detect legacy files ──────────────────────────────────────┐
 *   │                                                            │
 *   │   none found  →  return (silent no-op)                     │
 *   │                                                            │
 *   │   found, skip-forever marker present  →  return (skipped)  │
 *   │                                                            │
 *   │   found, --no-migrate  →  return (skipped)                 │
 *   │                                                            │
 *   │   found, --yes-migrate  →  translate all                   │
 *   │                                                            │
 *   │   found, interactive=true, TTY  →  dialog → translate/skip │
 *   │                                                            │
 *   │   found, interactive=false  →  warn-once, no action        │
 *   │                                                            │
 *   └────────────────────────────────────────────────────────────┘
 *
 * All paths return without throwing. Translation failures of individual
 * findings are logged but do not abort the whole run; the user can re-launch
 * to retry.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { getUserKdlPath, isEnoent, logger } from "@oh-my-pi/pi-utils";
import { detectLegacyConfig, type Finding } from "./detect";
import { runMigrationDialog } from "./dialog";
import { translateFinding, type TranslateResult } from "./translate";

export interface MaybeRunMigrationOptions {
	/** Project root. Defaults to process.cwd(). */
	cwd?: string;
	/** Whether to prompt the user. Default true. */
	interactive?: boolean;
	/** Force-yes (CI / scripted). Translates without prompting. Default false. */
	yes?: boolean;
	/** Force-no. Skips all migration. Default false. */
	no?: boolean;
	/** Override user-tier destination (test-only). */
	userKdlDest?: string;
	/** Override project-tier destination (test-only). */
	projectKdlDest?: string;
	/** Override agent dir (test-only). */
	agentDir?: string;
	/** Override skip-forever marker path (defaults to <userKdlDir>/.migration-skipped). */
	skipMarkerPath?: string;
	/** Override stdin/stdout for the dialog (test-only). */
	input?: NodeJS.ReadableStream;
	output?: NodeJS.WritableStream;
}

export interface MigrationOutcome {
	/** Findings detected on this run (may be empty). */
	findings: Finding[];
	/** Translations that succeeded. */
	translated: TranslateResult[];
	/** The action taken: see DialogAnswer plus "auto-yes" / "auto-no" / "no-findings". */
	action: "no-findings" | "auto-yes" | "auto-no" | "yes" | "no" | "skip-forever" | "diff";
}

/** Compute the default skip-forever marker path next to the user KDL. */
function defaultSkipMarker(userDest: string): string {
	return path.join(path.dirname(userDest), ".migration-skipped");
}

/**
 * Detect → prompt → translate. Self-contained, idempotent, and safely
 * removable: this directory plus the two-line settings.ts integration are
 * the only footprint.
 */
export async function maybeRunMigration(options: MaybeRunMigrationOptions = {}): Promise<MigrationOutcome> {
	const interactive = options.interactive ?? true;
	const userDest = options.userKdlDest ?? getUserKdlPath();
	const skipMarkerPath = options.skipMarkerPath ?? defaultSkipMarker(userDest);

	const detection = await detectLegacyConfig({
		cwd: options.cwd,
		agentDir: options.agentDir,
		userKdlDest: options.userKdlDest,
		projectKdlDest: options.projectKdlDest,
		skipMarkerPath,
	});

	if (detection.findings.length === 0) {
		return { findings: [], translated: [], action: "no-findings" };
	}

	// Explicit no — short-circuit before any prompt.
	if (options.no) {
		return { findings: detection.findings, translated: [], action: "auto-no" };
	}

	// Explicit yes — translate all without prompting.
	if (options.yes) {
		const translated = await translateAll(detection.findings);
		return { findings: detection.findings, translated, action: "auto-yes" };
	}

	// Interactive prompt path.
	const answer = await runMigrationDialog({
		findings: detection.findings,
		interactive,
		input: options.input,
		output: options.output,
	});

	switch (answer) {
		case "yes": {
			const translated = await translateAll(detection.findings);
			return { findings: detection.findings, translated, action: "yes" };
		}
		case "no":
			return { findings: detection.findings, translated: [], action: "no" };
		case "skip-forever": {
			await writeSkipMarker(skipMarkerPath, detection.findings);
			return { findings: detection.findings, translated: [], action: "skip-forever" };
		}
		case "diff":
			// Diff mode is informational only — render and treat as no.
			await renderDiff(detection.findings, options.output ?? process.stdout);
			return { findings: detection.findings, translated: [], action: "diff" };
	}
}

async function translateAll(findings: Finding[]): Promise<TranslateResult[]> {
	const results: TranslateResult[] = [];
	for (const f of findings) {
		try {
			const r = await translateFinding(f);
			if (r) {
				results.push(r);
				logger.warn("migration: translated", {
					source: r.source,
					dest: r.dest,
					bak: r.bakPath,
					keys: r.keysWritten,
				});
			}
		} catch (err) {
			logger.warn("migration: translate failed", { source: f.source, err: String(err) });
		}
	}
	return results;
}

async function writeSkipMarker(markerPath: string, findings: Finding[]): Promise<void> {
	await fs.mkdir(path.dirname(markerPath), { recursive: true });
	const payload = [
		`# Spell migration skipped at ${new Date().toISOString()}`,
		`# Delete this file to re-enable the migration prompt.`,
		"",
		...findings.map(f => `# - ${f.source}`),
		"",
	].join("\n");
	await fs.writeFile(markerPath, payload);
	logger.warn("migration: skip-forever marker written", { markerPath });
}

async function renderDiff(findings: Finding[], output: NodeJS.WritableStream): Promise<void> {
	for (const f of findings) {
		output.write(`\n── ${f.source} ${"─".repeat(Math.max(0, 70 - f.source.length))}\n`);
		try {
			const text = await fs.readFile(f.source, "utf8");
			output.write(text);
			if (!text.endsWith("\n")) output.write("\n");
		} catch (err) {
			if (!isEnoent(err)) throw err;
			output.write("(missing)\n");
		}
	}
	output.write("\n");
}
