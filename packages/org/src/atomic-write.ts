import * as fs from "node:fs/promises";

/**
 * Write content to a file atomically: write to a `.tmp` sibling, then rename.
 * Prevents half-written files from process crashes during Bun.write().
 */
export async function atomicWrite(filePath: string, content: string): Promise<void> {
	const tmpPath = `${filePath}.${crypto.randomUUID().slice(0, 8)}.tmp`;
	try {
		await Bun.write(tmpPath, content);
		await fs.rename(tmpPath, filePath);
	} catch (error) {
		try {
			await fs.unlink(tmpPath);
		} catch (unlinkError) {
			const code = unlinkError instanceof Error && "code" in unlinkError ? unlinkError.code : undefined;
			if (code === "ENOENT") {
				// Tmp already gone (e.g. rename completed); keep propagating original error.
			}
		}
		throw error;
	}
}
