import { executeCodeBuffer } from "@oh-my-pi/pi-natives";

export type WriteGuardCode = "WRITE_SHRINK_BLOCKED" | "WRITE_PARSE_REGRESSION";

export interface WriteGuardResult {
	ok: true;
}

export interface WriteGuardBlocked {
	ok: false;
	code: WriteGuardCode;
	detail: string;
}

function getBufferParseOk(file: string, content?: string): boolean {
	const result = content === undefined
		? executeCodeBuffer({ command: "status", file })
		: executeCodeBuffer({ command: "status", file, content });
	return !result.error;
}

export async function evaluateWriteGuards(absolutePath: string, newContent: string): Promise<WriteGuardResult | WriteGuardBlocked> {
	try {
		const oldResult = executeCodeBuffer({ command: "status", file: absolutePath });
		const oldExists = !oldResult.error;
		const oldContentLength = oldResult.error ? 0 : Number((oldResult.output as { contentLength?: number } | undefined)?.contentLength ?? 0);
		const newSize = Buffer.byteLength(newContent, "utf8");
		if (oldExists && oldContentLength >= 256 && newSize < Math.max(64, Math.floor(oldContentLength * 0.1))) {
			return {
				ok: false,
				code: "WRITE_SHRINK_BLOCKED",
				detail: `write would shrink ${absolutePath} from ${oldContentLength} bytes to ${newSize} bytes`,
			};
		}
		if (oldExists && getBufferParseOk(absolutePath) && !getBufferParseOk(absolutePath, newContent)) {
			return {
				ok: false,
				code: "WRITE_PARSE_REGRESSION",
				detail: `write would regress parsing for ${absolutePath}`,
			};
		}
		return { ok: true };
	} catch {
		return { ok: true };
	}
}
