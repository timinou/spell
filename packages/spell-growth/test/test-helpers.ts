import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

export async function createTempDir(prefix: string): Promise<string> {
	return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

export async function cleanupTempDir(dir: string): Promise<void> {
	await fs.rm(dir, { recursive: true, force: true });
}
