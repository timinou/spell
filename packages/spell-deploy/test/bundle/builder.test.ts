import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { buildBundleCommand, generateManifest, isCacheValid, readCachedManifest, writeCachedManifest } from "../../src";
import type { BundleManifest } from "../../src/bundle/types";
import { buildUploadCommands } from "../../src/bundle/upload";
import type { SshOptions } from "../../src/sync/types";

const tempDirs: string[] = [];

async function createTempDir(): Promise<string> {
	const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "spell-deploy-bundle-"));
	tempDirs.push(tempDir);
	return tempDir;
}

afterEach(async () => {
	await Promise.all(
		tempDirs.splice(0).map(async dir => {
			await fs.rm(dir, { recursive: true, force: true });
		}),
	);
});

const sshOptionsWithKey: SshOptions = {
	host: "spell.example.com",
	user: "spell",
	port: 2222,
	sshKey: "~/.ssh/id_ed25519",
	connectTimeout: 10,
};

const baseManifest: BundleManifest = {
	version: "1.2.3+abc123",
	platform: "linux-x64",
	hash: "cafebabe",
	builtAt: "2026-04-03T00:00:00.000Z",
	binaryPath: "/tmp/spell",
};

describe("bundle builder", () => {
	it("produces the expected bun build args for the target platform", () => {
		expect(
			buildBundleCommand({
				platform: "linux-x64",
				outputPath: "dist/spell",
				entryPoint: "src/index.ts",
			}),
		).toEqual(["bun", "build", "--compile", "--target=bun-linux-x64", "--outfile", "dist/spell", "src/index.ts"]);
	});

	it("includes compile and target flags in the generated command", () => {
		const args = buildBundleCommand({
			platform: "darwin-arm64",
			outputPath: "build/spell",
			entryPoint: "cli.ts",
		});

		expect(args).toContain("--compile");
		expect(args).toContain("--target=bun-darwin-arm64");
	});

	it("generates a manifest with the computed hash and requested metadata", async () => {
		const tempDir = await createTempDir();
		const binaryPath = path.join(tempDir, "spell");
		await Bun.write(binaryPath, "spell-binary");

		const manifest = await generateManifest({
			binaryPath,
			platform: "linux-x64",
			version: "1.2.3+abc123",
		});

		expect(manifest.version).toBe("1.2.3+abc123");
		expect(manifest.platform).toBe("linux-x64");
		expect(manifest.binaryPath).toBe(binaryPath);
		expect(manifest.hash).toHaveLength(64);
		expect(new Date(manifest.builtAt).toISOString()).toBe(manifest.builtAt);
	});
});

describe("bundle upload", () => {
	it("builds scp args with port and ssh key", () => {
		const upload = buildUploadCommands({
			manifest: baseManifest,
			remoteBundleDir: "/srv/spell/bundles",
			sshOptions: sshOptionsWithKey,
		});

		expect(upload.scpArgs).toEqual([
			"scp",
			"-P",
			"2222",
			"-i",
			"~/.ssh/id_ed25519",
			"/tmp/spell",
			"spell@spell.example.com:/srv/spell/bundles/spell.tmp",
		]);
		expect(upload.verifyCommand.args.at(-1)).toBe(
			"chmod +x /srv/spell/bundles/spell.tmp && mv /srv/spell/bundles/spell.tmp /srv/spell/bundles/spell",
		);
	});

	it("omits the ssh key from scp args when not configured", () => {
		const upload = buildUploadCommands({
			manifest: baseManifest,
			remoteBundleDir: "/srv/spell/bundles",
			sshOptions: {
				host: "spell.example.com",
				user: "spell",
				port: 22,
				connectTimeout: 10,
			},
		});

		expect(upload.scpArgs).toEqual([
			"scp",
			"-P",
			"22",
			"/tmp/spell",
			"spell@spell.example.com:/srv/spell/bundles/spell.tmp",
		]);
		expect(upload.scpArgs.join(" ")).not.toContain(" -i ");
	});
});

describe("bundle cache", () => {
	it("returns null when the cached manifest is missing", async () => {
		const tempDir = await createTempDir();

		expect(await readCachedManifest(tempDir)).toBeNull();
	});

	it("writes and reads the cached manifest without losing fields", async () => {
		const tempDir = await createTempDir();
		const manifest: BundleManifest = {
			version: "1.2.3+abc123",
			platform: "linux-x64",
			hash: "deadbeef",
			builtAt: "2026-04-03T00:00:00.000Z",
			binaryPath: "/tmp/spell",
		};

		await writeCachedManifest(tempDir, manifest);

		expect(await readCachedManifest(tempDir)).toEqual(manifest);
	});

	it("reports the cache as invalid when the hash does not match", async () => {
		const tempDir = await createTempDir();
		await writeCachedManifest(tempDir, baseManifest);

		expect(await isCacheValid(tempDir, "different-hash")).toBeFalse();
	});
});
