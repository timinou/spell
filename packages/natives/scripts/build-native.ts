import * as fsSync from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { $ } from "bun";

const repoRoot = path.join(import.meta.dir, "../../..");
const rustDir = path.join(repoRoot, "crates/pi-natives");
const nativeDir = path.join(import.meta.dir, "../native");

const isDev = process.argv.includes("--dev");
const crossTarget = Bun.env.CROSS_TARGET;
const targetPlatform = Bun.env.TARGET_PLATFORM || process.platform;
const targetArch = Bun.env.TARGET_ARCH || process.arch;
const configuredVariantRaw = Bun.env.TARGET_VARIANT;
const isCrossCompile = Boolean(crossTarget) || targetPlatform !== process.platform || targetArch !== process.arch;

type X64Variant = "modern" | "baseline";

let configuredVariant: X64Variant | undefined;
if (configuredVariantRaw) {
	if (targetArch !== "x64") {
		throw new Error(`TARGET_VARIANT is only supported for x64 builds, got ${targetPlatform}-${targetArch}.`);
	}
	if (configuredVariantRaw !== "modern" && configuredVariantRaw !== "baseline") {
		throw new Error(`Unsupported TARGET_VARIANT: ${configuredVariantRaw}. Expected "modern" or "baseline".`);
	}
	configuredVariant = configuredVariantRaw;
}

function runCommand(command: string, args: string[]): string | null {
	try {
		const result = Bun.spawnSync([command, ...args], { stdout: "pipe", stderr: "pipe" });
		if (result.exitCode !== 0) return null;
		return result.stdout.toString("utf-8").trim();
	} catch {
		return null;
	}
}
// Cargo's real target dir honors CARGO_TARGET_DIR *and* `[build] target-dir`
// from any .cargo/config.toml (incl. ~/.cargo). A bare repoRoot/target scan
// misses a redirected dir and can install a stale artifact whose napi ABI no
// longer matches the TS bindings → SIGILL/SIGBUS on the first native call.
// `cargo metadata` is the authoritative resolver.
function resolveCargoTargetDir(): string | undefined {
	if (Bun.env.CARGO_TARGET_DIR) return path.resolve(Bun.env.CARGO_TARGET_DIR);
	const metadataJson = runCommand("cargo", [
		"metadata",
		"--no-deps",
		"--format-version",
		"1",
		"--manifest-path",
		path.join(repoRoot, "Cargo.toml"),
	]);
	if (!metadataJson) return undefined;
	try {
		const meta = JSON.parse(metadataJson) as { target_directory?: string };
		return meta.target_directory ? path.resolve(meta.target_directory) : undefined;
	} catch {
		return undefined;
	}
}
function detectHostAvx2Support(): boolean {
	if (process.arch !== "x64") return false;

	if (process.platform === "linux") {
		try {
			const cpuInfo = fsSync.readFileSync("/proc/cpuinfo", "utf8");
			return /\bavx2\b/i.test(cpuInfo);
		} catch {
			return false;
		}
	}

	if (process.platform === "darwin") {
		const leaf7 = runCommand("sysctl", ["-n", "machdep.cpu.leaf7_features"]);
		if (leaf7 && /\bAVX2\b/i.test(leaf7)) return true;
		const features = runCommand("sysctl", ["-n", "machdep.cpu.features"]);
		return Boolean(features && /\bAVX2\b/i.test(features));
	}

	if (process.platform === "win32") {
		const output = runCommand("powershell.exe", [
			"-NoProfile",
			"-NonInteractive",
			"-Command",
			"[System.Runtime.Intrinsics.X86.Avx2]::IsSupported",
		]);
		return output?.toLowerCase() === "true";
	}

	return false;
}

function resolveEffectiveVariant(): X64Variant | null {
	if (targetArch !== "x64") return null;
	if (configuredVariant) return configuredVariant;
	if (isCrossCompile) {
		throw new Error("x64 cross-builds require TARGET_VARIANT=modern or TARGET_VARIANT=baseline.");
	}
	return detectHostAvx2Support() ? "modern" : "baseline";
}

const effectiveVariant = resolveEffectiveVariant();
const variantSuffix = effectiveVariant ? `-${effectiveVariant}` : "";
const exeSuffix = targetPlatform === "win32" ? ".exe" : "";

// Cargo's real target dir (honors ~/.cargo `[build] target-dir`). Resolved once
// here so the RUSTFLAGS guard below and the artifact scan further down agree.
const cargoTargetDir = resolveCargoTargetDir();
// A target dir outside the repo (e.g. a shared ~/.cache/cargo-target) may be
// reused across machines with different CPUs. cargo fingerprints on the
// RUSTFLAGS *string*, not the host ISA, so a `target-cpu=native` artifact built
// on CPU-A would be silently reused on CPU-B → SIGILL on an unsupported opcode.
// Only trust `native` when the target dir is repo-local.
const targetDirIsRepoLocal = !cargoTargetDir || cargoTargetDir.startsWith(`${repoRoot}${path.sep}`);

// Default to native CPU optimization for local builds; explicit variants use fixed ISA targets.
if (!isCrossCompile && !Bun.env.RUSTFLAGS) {
	if (effectiveVariant === "modern") {
		Bun.env.RUSTFLAGS = "-C target-cpu=x86-64-v3";
	} else if (effectiveVariant === "baseline") {
		Bun.env.RUSTFLAGS = "-C target-cpu=x86-64-v2";
	} else if (targetDirIsRepoLocal) {
		Bun.env.RUSTFLAGS = "-C target-cpu=native";
	}
	// else: shared/non-repo target dir on a variant-less arch → leave RUSTFLAGS
	// unset so cargo builds a portable baseline safe to reuse across CPUs.
}

async function cleanupStaleTemps(dir: string): Promise<void> {
	try {
		const entries = await fs.readdir(dir);
		for (const entry of entries) {
			if (entry.includes(".tmp.") || entry.includes(".old.") || entry.includes(".new.")) {
				await fs.unlink(path.join(dir, entry)).catch(() => {});
			}
		}
	} catch {
		// Directory might not exist yet
	}
}

async function installBinary(src: string, dest: string): Promise<void> {
	const tempPath = `${dest}.tmp.${process.pid}`;

	await fs.copyFile(src, tempPath);

	try {
		// Atomic rename - works even if dest is loaded on Linux/macOS (old inode stays valid)
		await fs.rename(tempPath, dest);
	} catch {
		// On Windows, loaded DLLs cannot be overwritten via rename
		// Try delete-then-rename as fallback
		try {
			await fs.unlink(dest);
		} catch (unlinkErr) {
			if ((unlinkErr as NodeJS.ErrnoException).code !== "ENOENT") {
				await fs.unlink(tempPath).catch(() => {});
				const isWindows = process.platform === "win32";
				throw new Error(
					`Cannot replace ${path.basename(dest)}${isWindows ? " (file may be in use - close any running processes)" : ""}: ${(unlinkErr as Error).message}`,
				);
			}
		}
		try {
			await fs.rename(tempPath, dest);
		} catch (finalErr) {
			await fs.unlink(tempPath).catch(() => {});
			throw new Error(`Failed to install ${path.basename(dest)}: ${(finalErr as Error).message}`);
		}
	}
}

async function findBuiltBinary(profileDirs: string[], names: string[]): Promise<string | null> {
	for (const dir of profileDirs) {
		for (const name of names) {
			const fullPath = path.join(dir, name);
			try {
				await fs.stat(fullPath);
				return fullPath;
			} catch (err) {
				if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
			}
		}
	}
	return null;
}

async function buildCargoPackage(packageName: string): Promise<{ exitCode: number; stderr: string }> {
	const cargoArgs = ["build", "-p", packageName];
	if (!isDev) cargoArgs.push("--release");
	if (crossTarget) cargoArgs.push("--target", crossTarget);
	const result = await $`cargo ${cargoArgs}`.cwd(repoRoot).nothrow();
	return { exitCode: result.exitCode, stderr: result.stderr?.toString("utf-8") ?? "" };
}

const profile = isDev ? "debug" : "release";
// cargoTargetDir resolved once near the RUSTFLAGS guard above.
// Scan cargo's authoritative target dir FIRST so a freshly-built artifact is
// always preferred over a stale one left in repoRoot/target (e.g. a fossil
// from before a `[build] target-dir` redirect). The legacy locations remain as
// fallbacks for setups where `cargo metadata` is unavailable.
const targetRoots = [
	...new Set(
		[cargoTargetDir, path.join(repoRoot, "target"), path.join(rustDir, "target")].filter((v): v is string =>
			Boolean(v),
		),
	),
];

const profileDirs = targetRoots.flatMap(root => {
	if (crossTarget) {
		return [path.join(root, crossTarget, profile), path.join(root, profile)];
	}
	return [path.join(root, profile)];
});

const addonNames = ["libpi_natives.so", "libpi_natives.dylib", "pi_natives.dll", "libpi_natives.dll"];
const workerNames = [
	`pi-knowledge-worker${exeSuffix}`,
	`pi_knowledge_worker${exeSuffix}`,
	`pi-knowledge-worker`,
	`pi_knowledge_worker`,
	// Legacy names (PLAN-315 rename); retained one release.
	`pi-embedding-worker${exeSuffix}`,
	`pi_embedding_worker${exeSuffix}`,
	`pi-embedding-worker`,
	`pi_embedding_worker`,
];

console.log(`Building pi-natives for ${targetPlatform}-${targetArch}${variantSuffix}${isDev ? " (debug)" : ""}…`);
const addonBuild = await buildCargoPackage("pi-natives");
if (addonBuild.exitCode !== 0) {
	throw new Error(`cargo build -p pi-natives failed${addonBuild.stderr ? `:\n${addonBuild.stderr}` : ""}`);
}

await fs.mkdir(nativeDir, { recursive: true });
await cleanupStaleTemps(nativeDir);

const sourcePath = await findBuiltBinary(profileDirs, addonNames);
if (!sourcePath) {
	const checked = profileDirs.map(d => `  - ${d}`).join("\n");
	throw new Error(`Built library not found. Checked:\n${checked}`);
}

console.log(`Found addon: ${sourcePath}`);
const taggedPath = isDev
	? path.join(nativeDir, "pi_natives.dev.node")
	: path.join(nativeDir, `pi_natives.${targetPlatform}-${targetArch}${variantSuffix}.node`);
console.log(`Installing addon: ${taggedPath}`);
await installBinary(sourcePath, taggedPath);

console.log(`Building pi-knowledge-worker for ${targetPlatform}-${targetArch}${isDev ? " (debug)" : ""}…`);
const workerBuild = await buildCargoPackage("pi-knowledge-worker");
if (workerBuild.exitCode !== 0) {
	console.warn(
		`Warning: cargo build -p pi-knowledge-worker failed; addon install will continue.${workerBuild.stderr ? `\n${workerBuild.stderr}` : ""}`,
	);
	console.log("Build complete.");
	process.exit(0);
}

const workerSourcePath = await findBuiltBinary(profileDirs, workerNames);
if (!workerSourcePath) {
	console.warn(
		`Warning: pi-knowledge-worker built successfully, but no binary was found in:\n${profileDirs.map(d => `  - ${d}`).join("\n")}`,
	);
	console.log("Build complete.");
	process.exit(0);
}

const workerTaggedPath = path.join(nativeDir, `pi-knowledge-worker${exeSuffix}`);
console.log(`Installing worker: ${workerTaggedPath}`);
await installBinary(workerSourcePath, workerTaggedPath);

// PLAN-315: also stage a legacy-name symlink so older clients that look
// up `pi-embedding-worker` continue to find the same binary.
const legacyWorkerPath = path.join(nativeDir, `pi-embedding-worker${exeSuffix}`);
try {
	await fs.unlink(legacyWorkerPath).catch(() => {});
	await fs.symlink(`pi-knowledge-worker${exeSuffix}`, legacyWorkerPath);
	console.log(`Linked legacy: ${legacyWorkerPath} → pi-knowledge-worker${exeSuffix}`);
} catch (err) {
	console.warn(`Warning: could not stage legacy worker symlink: ${err}`);
}

console.log("Build complete.");
