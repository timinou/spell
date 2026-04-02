import * as fs from "node:fs/promises";
import * as path from "node:path";

function ensureRelativeFilePath(file: string): string {
	if (!file || path.isAbsolute(file) || file.includes("..") || file.includes("*")) {
		throw new Error(`Invalid manifest file path: ${file}`);
	}
	return file.replaceAll("\\", "/");
}

export async function createTarball(baseDir: string, files: readonly string[]): Promise<Buffer> {
	if (files.length === 0) {
		throw new Error("Cannot create spellcast tarball with no files");
	}

	for (const file of files) {
		const relative = ensureRelativeFilePath(file);
		const fullPath = path.join(baseDir, relative);
		try {
			const stat = await fs.stat(fullPath);
			if (!stat.isFile()) {
				throw new Error(`${relative} is not a file`);
			}
		} catch (_error) {
			throw new Error(`Spellcast file not found: ${relative}`);
		}
	}

	const proc = Bun.spawnSync(["tar", "-czf", "-", "-C", baseDir, ...files], {
		stdout: "pipe",
		stderr: "pipe",
	});
	if (proc.exitCode !== 0) {
		const stderr = Buffer.from(proc.stderr).toString("utf8").trim();
		throw new Error(stderr || "Failed to create spellcast tarball");
	}
	return Buffer.from(proc.stdout);
}
