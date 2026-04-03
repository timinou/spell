import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

export async function createManifestProject(
	files: Record<string, string>,
): Promise<{ dir: string; manifestPath: string }> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "spell-manifest-"));
	await Promise.all(
		Object.entries(files).map(async ([relativePath, content]) => {
			await Bun.write(path.join(dir, relativePath), content);
		}),
	);
	return {
		dir,
		manifestPath: path.join(dir, "autonomy.kdl"),
	};
}

export async function cleanupManifestProject(dir: string): Promise<void> {
	await fs.rm(dir, { recursive: true, force: true });
}
