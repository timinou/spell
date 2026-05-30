/**
 * Structural invariant: no `@oh-my-pi/*` references survive in the repo.
 *
 * After the hard fork (commit ed7ed0a7b), the @oh-my-pi npm scope is dead
 * to this codebase. Bringing one back \u2014 even accidentally via copy-paste,
 * a stale doc snippet, or a partial revert \u2014 lets bun's install cache
 * shadow our workspace with whatever upstream binary happens to live there.
 *
 * This test enumerates every text file under `packages/`, `scripts/`,
 * `docs/`, and the repo root, and fails if any of them contains the
 * literal `@oh-my-pi/`. Pre-existing memory / org files that document the
 * old scope are exempt by directory; everything else must be clean.
 *
 * If you legitimately need to mention `@oh-my-pi/` (e.g. a migration note),
 * put it in `.spell/memory/`, `!tasks/`, or a CHANGELOG entry \u2014 the
 * allowlist below grows to cover the documentation surface, not the
 * shipping code.
 */
import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";

const repoRoot = path.resolve(__dirname, "..", "..", "..");

/** Directories whose contents are excluded from the scan entirely. */
const SKIP_DIRS = new Set([
	".git",
	"node_modules",
	"target",
	"dist",
	"build",
	"_build",
	".cache",
	"coverage",
	".turbo",
	".next",
	".idea",
	".vscode",
]);

/** Path prefixes (relative to repo root) that are allowed to mention the
 *  old scope \u2014 historical records, migration docs, audit notes. */
const ALLOWLIST_PREFIXES = [
	".spell/memory/",
	"!tasks/",
	// The CHANGELOG can legitimately reference the old scope for migration.
	"packages/coding-agent/CHANGELOG.md",
	"packages/agent/CHANGELOG.md",
	"packages/ai/CHANGELOG.md",
	"packages/natives/CHANGELOG.md",
	"packages/tui/CHANGELOG.md",
	"packages/utils/CHANGELOG.md",
	// The structural-enforcement test itself documents what it forbids.
	"packages/utils/test/no-upstream-references.test.ts",
	// biome.json declares the noRestrictedImports rule by literal target names.
	"biome.json",
];

/** File extensions to scan. Binary files and lockfiles ignored. */
const SCAN_EXTENSIONS = new Set([
	".ts",
	".tsx",
	".js",
	".jsx",
	".mjs",
	".cjs",
	".json",
	".jsonc",
	".md",
	".mdx",
	".kdl",
	".yaml",
	".yml",
	".toml",
	".rs",
	".sh",
	".ps1",
	".dockerfile",
	".html",
	".css",
]);

const FORBIDDEN = "@oh-my-pi/";

function listFiles(dir: string, hits: string[]): void {
	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch {
		return;
	}
	for (const e of entries) {
		if (SKIP_DIRS.has(e.name)) continue;
		const full = path.join(dir, e.name);
		if (e.isDirectory()) {
			listFiles(full, hits);
			continue;
		}
		if (!e.isFile()) continue;
		const ext = path.extname(e.name).toLowerCase();
		// Files without an extension (Dockerfile, etc.) — scan if name matches a known pattern.
		if (!SCAN_EXTENSIONS.has(ext) && !/^(Dockerfile|Makefile|\.dockerfile)$/i.test(e.name)) continue;
		hits.push(full);
	}
}

function isAllowed(relPath: string): boolean {
	return ALLOWLIST_PREFIXES.some(prefix => relPath === prefix || relPath.startsWith(prefix));
}

describe("structural invariant: no @oh-my-pi/* references (hard fork)", () => {
	test("repo is free of @oh-my-pi/ references outside the allowlist", () => {
		const files: string[] = [];
		// Only scan the directories we expect shipping code in.
		for (const sub of ["packages", "scripts", "docs", "crates"]) {
			listFiles(path.join(repoRoot, sub), files);
		}
		// Plus a few root files.
		for (const root of [
			"package.json",
			"README.md",
			"AGENTS.md",
			"CHANGELOG.md",
			"biome.json",
			"tsconfig.json",
		]) {
			const full = path.join(repoRoot, root);
			if (fs.existsSync(full)) files.push(full);
		}

		const violations: Array<{ file: string; lines: number[] }> = [];
		for (const file of files) {
			const rel = path.relative(repoRoot, file);
			if (isAllowed(rel)) continue;
			let content: string;
			try {
				content = fs.readFileSync(file, "utf-8");
			} catch {
				continue;
			}
			if (!content.includes(FORBIDDEN)) continue;
			const lines: number[] = [];
			content.split("\n").forEach((line, i) => {
				if (line.includes(FORBIDDEN)) lines.push(i + 1);
			});
			violations.push({ file: rel, lines });
		}

		if (violations.length > 0) {
			const report = violations
				.map(v => `  ${v.file}: lines ${v.lines.join(", ")}`)
				.join("\n");
			throw new Error(
				`Found ${violations.length} files containing the forbidden @oh-my-pi/ scope:\n${report}\n\n` +
					`The hard fork (commit ed7ed0a7b) renamed @oh-my-pi/* \u2192 @spell/*.\n` +
					`Reintroducing the old scope lets bun's install cache shadow the workspace.\n` +
					`Either rename to @spell/* or, if this is documentation/history, add the\n` +
					`path prefix to ALLOWLIST_PREFIXES in this test file.`,
			);
		}

		expect(violations).toEqual([]);
	});
});
