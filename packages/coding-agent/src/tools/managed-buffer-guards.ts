import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { executeCodeBuffer } from "@oh-my-pi/pi-natives";
import { isCodeToolSupportedPath } from "./code-supported-files";

export type WriteGuardCode = "WRITE_SHRINK_BLOCKED" | "WRITE_PARSE_REGRESSION";

export interface WriteGuardResult {
	ok: true;
}

export interface WriteGuardBlocked {
	ok: false;
	code: WriteGuardCode;
	detail: string;
}

/** Minimum file size (bytes) before the shrink guard engages. Matches FEAT-585. */
const SHRINK_GUARD_MIN_BYTES = 256;
/** Floor for the allowed new size when the guard is active. Matches FEAT-585. */
const SHRINK_GUARD_FLOOR_BYTES = 64;
/** Ratio floor: the new size must not drop below this fraction of the old size. */
const SHRINK_GUARD_RATIO = 0.1;
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
 * Gate catastrophic overwrites of existing code-supported source files.
 *
 * Prior implementation probed the managed buffer via
 * `executeCodeBuffer({command:"status"})`. That command does not exist in
 * pi-natives: the native responds with `{error:true, output:"Unknown command:
 * status"}`, which the guard interpreted as "file is not tracked" and skipped
 * every check. This made the guard a silent no-op — the exact regression path
 * that let a subagent replace todo-write.ts (58_563 B parseable TS) with a
 * 1_691 B parseable stub in session 2026-04-19T08-55-28-607Z_14c08a4197c6a60b.
 *
 * The implementation here uses `fs.statSync` for existence + size. It does not
 * depend on the managed buffer at all, so the guard works identically for
 * files the managed buffer has seen and files it has not.
 *
 * Parse-regression guarding is advisory only at this layer: pi-natives
 * currently has no side-effect-free parse probe. The structural-validity
 * check inside `applyManagedBufferContent` (via
 * `executeCodeBuffer({command:"edit", actions:[{kind:"write"}]})`) rejects
 * writes that the native engine considers structurally invalid, which is the
 * real backstop. A `WRITE_PARSE_REGRESSION` gate can be added here once
 * pi-natives exposes a read-only parse command.
 */
export function evaluateWriteGuards(absolutePath: string, newContent: string): WriteGuardResult | WriteGuardBlocked {
	if (!isCodeToolSupportedPath(absolutePath)) {
		return { ok: true };
	}

	const oldExists = existsSync(absolutePath);
	if (!oldExists) {
		return { ok: true };
	}

	let oldSize = 0;
	try {
		oldSize = statSync(absolutePath).size;
	} catch {
		// Existence raced with removal — treat as new file, let the write
		// proceed and the kernel surface any real failure.
		return { ok: true };
	}

	const newSize = Buffer.byteLength(newContent, "utf8");

	if (oldSize >= SHRINK_GUARD_MIN_BYTES) {
		const floor = Math.max(SHRINK_GUARD_FLOOR_BYTES, Math.floor(oldSize * SHRINK_GUARD_RATIO));
		if (newSize < floor) {
			return {
				ok: false,
				code: "WRITE_SHRINK_BLOCKED",
				detail: `write would shrink ${absolutePath} from ${oldSize} bytes to ${newSize} bytes (floor ${floor})`,
			};
		}
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

/**
 * Diagnostic probe exported for tests: confirms the dependency the prior
 * implementation relied on is still absent, so the fix above remains
 * necessary rather than cosmetic.
 */
export function probeCodeBufferStatusCommand(): { available: boolean; output: string } {
	const result = executeCodeBuffer({ command: "status", file: "/tmp/__probe__" });
	return {
		available: result.error !== true,
		output: typeof result.output === "string" ? result.output : JSON.stringify(result.output ?? null),
	};
}
