#!/usr/bin/env bun
import * as fs from "node:fs";
import * as path from "node:path";
import { $ } from "bun";

const isDev = Bun.argv.includes("--dev");
const packageDir = path.resolve(import.meta.dir, "..");
const buildDir = path.join(packageDir, "build");
const nativeDir = path.join(packageDir, "native");
const binaryName = "omp-qml-bridge";
const outputPath = path.join(nativeDir, binaryName);

console.log(`Building omp-qml-bridge (${isDev ? "debug" : "release"})...`);

// Configure
const configArgs = ["-S", packageDir, "-B", buildDir];
if (!isDev) configArgs.push("-DCMAKE_BUILD_TYPE=Release");
else configArgs.push("-DCMAKE_BUILD_TYPE=Debug");

const configResult = await $`cmake ${configArgs}`.cwd(packageDir).nothrow();
if (configResult.exitCode !== 0) {
	console.error("cmake configure failed");
	process.exit(1);
}

// Build
const buildResult = await $`cmake --build ${buildDir} --parallel`.nothrow();
if (buildResult.exitCode !== 0) {
	console.error("cmake build failed");
	process.exit(1);
}

// Copy binary to native/
fs.mkdirSync(nativeDir, { recursive: true });

// Find binary (could be in build/ or build/Release/ or build/Debug/)
const candidates = [
	path.join(buildDir, binaryName),
	path.join(buildDir, "Release", binaryName),
	path.join(buildDir, "Debug", binaryName),
];

const built = candidates.find(p => fs.existsSync(p));
if (!built) {
	console.error(`Binary not found in expected locations: ${candidates.join(", ")}`);
	process.exit(1);
}

// Atomic install: write to temp then rename
const tmp = `${outputPath}.tmp`;
fs.copyFileSync(built, tmp);
fs.renameSync(tmp, outputPath);
fs.chmodSync(outputPath, 0o755);

console.log(`Installed: ${outputPath}`);
