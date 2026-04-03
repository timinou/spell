import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { BundleBuildOptions, BundleManifest } from "./types";

/** Build the bun compilation command args */
export function buildBundleCommand(opts: BundleBuildOptions): string[] {
	return ["bun", "build", "--compile", `--target=bun-${opts.platform}`, "--outfile", opts.outputPath, opts.entryPoint];
}

/** Compute SHA-256 hash of a file */
export async function hashFile(filePath: string): Promise<string> {
	const buffer = await fs.readFile(filePath);
	const hasher = new Bun.CryptoHasher("sha256");
	hasher.update(buffer);
	return hasher.digest("hex");
}

/** Generate a bundle manifest after build */
export async function generateManifest(opts: {
	binaryPath: string;
	platform: string;
	version: string;
}): Promise<BundleManifest> {
	const hash = await hashFile(opts.binaryPath);
	return {
		version: opts.version,
		platform: opts.platform,
		hash,
		builtAt: new Date().toISOString(),
		binaryPath: opts.binaryPath,
	};
}

/** Get version from package.json + git commit */
export async function getVersion(projectRoot: string): Promise<string> {
	try {
		const pkg = await Bun.file(path.join(projectRoot, "package.json")).json();
		const version = (pkg as { version?: string }).version ?? "0.0.0";
		const result = Bun.spawnSync(["git", "rev-parse", "--short", "HEAD"], {
			cwd: projectRoot,
			stdout: "pipe",
			stderr: "pipe",
		});
		if (result.exitCode === 0) {
			const hash = result.stdout.toString().trim();
			return `${version}+${hash}`;
		}
		return version;
	} catch {
		return "0.0.0";
	}
}
