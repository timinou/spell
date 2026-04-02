import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { SandboxConfig } from "../manifest/types";

export async function writeSandboxPolicy(sandbox: SandboxConfig): Promise<string> {
	const tmpDir = os.tmpdir();
	const fileName = `spell-sandbox-${Date.now()}-${crypto.randomUUID()}.json`;
	const filePath = path.join(tmpDir, fileName);
	const policy = {
		pathsWrite: sandbox.pathsWrite ?? [],
		bashAllow: sandbox.bashAllow ?? [],
		bashDeny: sandbox.bashDeny ?? [],
	};
	await Bun.write(filePath, JSON.stringify(policy));
	return filePath;
}

export async function removeSandboxPolicy(filePath: string): Promise<void> {
	try {
		await fs.unlink(filePath);
	} catch {
		// Best-effort cleanup.
	}
}
