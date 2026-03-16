import * as fs from "node:fs/promises";

/**
 * Write content to a file atomically: write to a `.tmp` sibling, then rename.
 * Prevents half-written files from process crashes during Bun.write().
 */
export async function atomicWrite(filePath: string, content: string): Promise<void> {
	const tmpPath = `${filePath}.tmp`;
	await Bun.write(tmpPath, content);
	await fs.rename(tmpPath, filePath);
}
