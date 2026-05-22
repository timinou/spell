import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { executeCodeBuffer, executeCodePath } from "@oh-my-pi/pi-natives";
import { isCodeToolSupportedPath } from "./code-supported-files";

export type WriteGuardCode = "WRITE_PARSE_REGRESSION";

export interface WriteGuardResult {
	ok: true;
}

export interface WriteGuardBlocked {
	ok: false;
	code: WriteGuardCode;
	detail: string;
}

const PARSE_PROBE_SESSION_ID = "write-guard-parse-probe";

/**
 * Run `nextContent` through the canonical edit pipeline (executeCodePath
 * with `Op::FileWrite`) on a scratch tempfile. The kernel's buf.edit_batch
 * triggers `errors_intersect_ranges` (the tree-sitter structural-invariant
 * guard). If the new content would leave the buffer parse-invalid, the
 * diagnostic surfaces in the resulting chunks.
 *
 * Replaces the pre-PLAN-309 implementation which called the now-deleted
 * executeCodeBuffer `replace_content`/`save` commands (BUG-390).
 */
async function probesAsStructurallyValid(
	sourcePath: string,
	initialContent: string,
	nextContent: string,
): Promise<boolean> {
	const tempDir = mkdtempSync(path.join(tmpdir(), "write-guard-parse-"));
	const probePath = path.join(tempDir, path.basename(sourcePath));
	writeFileSync(probePath, initialContent);
	try {
		const chunks = await executeCodePath({
			command: "edit",
			target: probePath,
			actions: [{ kind: "fileWrite", content: nextContent, force: true }],
			root: tempDir,
			sessionId: PARSE_PROBE_SESSION_ID,
		});
		for (const chunk of chunks) {
			for (const diag of chunk.diagnostics ?? []) {
				const msg = typeof diag.message === "string" ? diag.message : "";
				if (msg.includes("structurally invalid") || msg.includes("buffer structurally invalid")) {
					return false;
				}
			}
			for (const node of chunk.nodes ?? []) {
				for (const diag of node.diagnostics ?? []) {
					const msg = typeof diag.message === "string" ? diag.message : "";
					if (msg.includes("structurally invalid") || msg.includes("buffer structurally invalid")) {
						return false;
					}
				}
			}
		}
		return true;
	} catch (_e) {
		// edit_transaction throws on certain failures; treat as parse-fail.
		return false;
	} finally {
		try {
			executeCodeBuffer({ command: "close", file: probePath });
		} catch (_e) {
			/* buffer may not be open; ignore */
		}
		try {
			rmSync(tempDir, { recursive: true, force: true });
		} catch (_e) {
			/* tempdir cleanup is best-effort */
		}
	}
}

/**
 * Gate writes that would introduce structural parse failures in code-supported
 * source files. Size-shrink heuristics were removed (FEAT-816): they produced
 * too many false positives — refactors and dead-code removal legitimately
 * shrink files. The structural parse probe remains as the only backstop;
 * `force:true` does not bypass it because shipping unparseable code is never
 * a valid intent.
 */
export async function evaluateWriteGuards(
	absolutePath: string,
	newContent: string,
	_options: { force?: boolean } = {},
): Promise<WriteGuardResult | WriteGuardBlocked> {
	if (!isCodeToolSupportedPath(absolutePath)) {
		return { ok: true };
	}

	if (!existsSync(absolutePath)) {
		return { ok: true };
	}

	const oldContent = readFileSync(absolutePath, "utf8");
	const oldParses = await probesAsStructurallyValid(absolutePath, "", oldContent);
	if (oldParses && !(await probesAsStructurallyValid(absolutePath, oldContent, newContent))) {
		return {
			ok: false,
			code: "WRITE_PARSE_REGRESSION",
			detail: `write would introduce structural parse failures for ${absolutePath}`,
		};
	}

	return { ok: true };
}
