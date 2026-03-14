import { $ } from "bun";

/** Context properties injected by the C++ bridge at runtime — qmllint cannot see them. */
const BRIDGE_CONTEXT_IDENTIFIERS = new Set(["bridge", "windowWidth", "windowHeight", "windowTitle"]);

/**
 * Candidate qmllint binary locations, checked in order.
 * - Linux: Qt6 from distro packages
 * - macOS Apple Silicon: Homebrew default prefix
 * - macOS Intel: Homebrew legacy prefix
 * - Fallback: PATH lookup via `which qmllint` (covers custom installs)
 */
const QMLLINT_CANDIDATES = [
	"/usr/lib/qt6/bin/qmllint", // Linux distro Qt6
	"/opt/homebrew/bin/qmllint", // macOS Apple Silicon (Homebrew)
	"/usr/local/bin/qmllint", // macOS Intel (Homebrew)
];

let resolvedBin: string | null | undefined; // undefined = not yet probed

async function findQmllint(): Promise<string | null> {
	if (resolvedBin !== undefined) return resolvedBin;
	for (const candidate of QMLLINT_CANDIDATES) {
		if (await Bun.file(candidate).exists()) {
			resolvedBin = candidate;
			return resolvedBin;
		}
	}
	// Last resort: PATH lookup (e.g. Qt installed via aqtinstall or custom prefix)
	const fromPath = Bun.which("qmllint");
	resolvedBin = fromPath ?? null;
	return resolvedBin;
}

export interface QmlLintWarning {
	line: number;
	column: number;
	id: string;
	message: string;
	type: "warning" | "critical" | string;
}

export interface QmlLintResult {
	available: boolean;
	warnings: QmlLintWarning[];
	errors: QmlLintWarning[];
}

interface QmllintFileEntry {
	filename: string;
	success: boolean;
	warnings: Array<{
		charOffset: number;
		column: number;
		id: string;
		length: number;
		line: number;
		message: string;
		type: string;
	}>;
}

interface QmllintOutput {
	files: QmllintFileEntry[];
	revision: number;
}

function isBridgeFalsePositive(warning: QmllintFileEntry["warnings"][number], source: string): boolean {
	if (warning.id !== "unqualified") return false;
	const token = source.slice(warning.charOffset, warning.charOffset + warning.length);
	return BRIDGE_CONTEXT_IDENTIFIERS.has(token);
}

export async function lintQmlFile(filePath: string): Promise<QmlLintResult> {
	// Probe candidate locations once; result is cached in module scope.
	const bin = await findQmllint();
	if (!bin) {
		return { available: false, warnings: [], errors: [] };
	}

	const result = await $`${bin} --json - ${filePath}`.quiet().nothrow();
	const raw = result.stdout.toString();
	if (!raw.trim()) {
		return { available: true, warnings: [], errors: [] };
	}

	let parsed: QmllintOutput;
	try {
		parsed = JSON.parse(raw) as QmllintOutput;
	} catch {
		return { available: true, warnings: [], errors: [] };
	}

	// Read the source once for false-positive detection.
	let source = "";
	try {
		source = await Bun.file(filePath).text();
	} catch {
		// If we can't read the file (shouldn't happen — we just wrote it), skip filtering.
	}

	const warnings: QmlLintWarning[] = [];
	const errors: QmlLintWarning[] = [];

	for (const file of parsed.files) {
		for (const w of file.warnings ?? []) {
			if (isBridgeFalsePositive(w, source)) continue;
			const entry: QmlLintWarning = {
				line: w.line,
				column: w.column,
				id: w.id,
				message: w.message,
				type: w.type,
			};
			if (w.type === "critical") {
				errors.push(entry);
			} else {
				warnings.push(entry);
			}
		}
	}

	return { available: true, warnings, errors };
}

export function formatLintOutput(result: QmlLintResult): string {
	if (!result.available) return "";
	const total = result.warnings.length + result.errors.length;
	if (total === 0) return "\nqmllint: clean";

	const lines: string[] = [];
	const errorCount = result.errors.length;
	const warnCount = result.warnings.length;
	const parts: string[] = [];
	if (errorCount > 0) parts.push(`${errorCount} error${errorCount !== 1 ? "s" : ""}`);
	if (warnCount > 0) parts.push(`${warnCount} warning${warnCount !== 1 ? "s" : ""}`);
	lines.push(`\nqmllint: ${parts.join(", ")}`);

	for (const e of result.errors) {
		lines.push(`  Line ${e.line}: ${e.message} [${e.id}]`);
	}
	for (const w of result.warnings) {
		lines.push(`  Line ${w.line}: ${w.message} [${w.id}]`);
	}

	return lines.join("\n");
}
