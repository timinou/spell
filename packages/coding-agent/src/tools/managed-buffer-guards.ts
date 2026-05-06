import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { executeCodeBuffer } from "@oh-my-pi/pi-natives";
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

function extractEditFailure(output: unknown): boolean {
	if (!output || typeof output !== "object" || Array.isArray(output)) return false;
	const status = Reflect.get(output, "status");
	if (status !== "failed" && status !== "partial") return false;
	const fileResults = Reflect.get(output, "fileResults");
	if (!Array.isArray(fileResults)) return true;
	return fileResults.some(entry => entry && typeof entry === "object" && Reflect.get(entry, "status") === "failed");
}

function probesAsStructurallyValid(sourcePath: string, initialContent: string, nextContent: string): boolean {
	const tempDir = mkdtempSync(path.join(tmpdir(), "write-guard-parse-"));
	const probePath = path.join(tempDir, path.basename(sourcePath));
	writeFileSync(probePath, initialContent);
	try {
		const result = executeCodeBuffer({
			command: "replace_content",
			file: probePath,
			content: nextContent,
			sessionId: PARSE_PROBE_SESSION_ID,
		});
		if (result.error || extractEditFailure(result.output)) return false;
		const save = executeCodeBuffer({ command: "save", file: probePath, sessionId: PARSE_PROBE_SESSION_ID });
		return save.error !== true;
	} finally {
		executeCodeBuffer({ command: "close", file: probePath });
		rmSync(tempDir, { recursive: true, force: true });
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
export function evaluateWriteGuards(
	absolutePath: string,
	newContent: string,
	_options: { force?: boolean } = {},
): WriteGuardResult | WriteGuardBlocked {
	if (!isCodeToolSupportedPath(absolutePath)) {
		return { ok: true };
	}

	if (!existsSync(absolutePath)) {
		return { ok: true };
	}

	const oldContent = readFileSync(absolutePath, "utf8");
	const oldParses = probesAsStructurallyValid(absolutePath, "", oldContent);
	if (oldParses && !probesAsStructurallyValid(absolutePath, oldContent, newContent)) {
		return {
			ok: false,
			code: "WRITE_PARSE_REGRESSION",
			detail: `write would introduce structural parse failures for ${absolutePath}`,
		};
	}

	return { ok: true };
}
