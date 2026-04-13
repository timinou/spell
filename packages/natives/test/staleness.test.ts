import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { checkNativeStaleness, checkStaleness } from "../src/native";

let tempDir: string;
let cratesDir: string;
let binaryPath: string;

async function writeFile(filePath: string, content = ""): Promise<void> {
	await fs.mkdir(path.dirname(filePath), { recursive: true });
	await fs.writeFile(filePath, content);
}

async function setMtime(filePath: string, timeMs: number): Promise<void> {
	const time = new Date(timeMs);
	await fs.utimes(filePath, time, time);
}

describe("native staleness detection", () => {
	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "native-staleness-"));
		cratesDir = path.join(tempDir, "crates");
		binaryPath = path.join(tempDir, "pi_natives.node");
		await fs.mkdir(cratesDir, { recursive: true });
		await writeFile(binaryPath, "binary");
	});

	afterEach(async () => {
		await fs.rm(tempDir, { recursive: true, force: true });
	});

	it("returns stale false when binary is newer than sources", async () => {
		const sourcePath = path.join(cratesDir, "pi-natives", "src", "lib.rs");
		await writeFile(sourcePath, "fn main() {}\n");
		await setMtime(sourcePath, 1_000);
		await setMtime(binaryPath, 2_000);

		const result = checkStaleness(binaryPath, cratesDir);
		expect(result).not.toBeNull();
		expect(result?.stale).toBe(false);
		expect(result?.newestSourceFile).toBe(sourcePath);
		expect(result?.binaryPath).toBe(binaryPath);
	});

	it("returns stale true when a source file is newer than binary", async () => {
		const sourcePath = path.join(cratesDir, "pi-natives", "Cargo.toml");
		await writeFile(sourcePath, '[package]\nname = "pi-natives"\n');
		await setMtime(binaryPath, 1_000);
		await setMtime(sourcePath, 2_000);

		const result = checkStaleness(binaryPath, cratesDir);
		expect(result).not.toBeNull();
		expect(result?.stale).toBe(true);
		expect(result?.newestSourceFile).toBe(sourcePath);
	});

	it("returns null when the binary path does not exist", () => {
		const result = checkStaleness(path.join(tempDir, "missing.node"), cratesDir);
		expect(result).toBeNull();
	});

	it("returns null when the crates directory has no tracked source files", () => {
		const result = checkStaleness(binaryPath, cratesDir);
		expect(result).toBeNull();
	});

	it("returns null when the crates directory does not exist", () => {
		const result = checkStaleness(binaryPath, path.join(tempDir, "missing-crates"));
		expect(result).toBeNull();
	});

	it("ignores newer files inside target directories", async () => {
		const realSourcePath = path.join(cratesDir, "pi-natives", "src", "lib.rs");
		const ignoredTargetPath = path.join(cratesDir, "pi-natives", "target", "debug", "generated.rs");
		await writeFile(realSourcePath, "fn main() {}\n");
		await writeFile(ignoredTargetPath, "generated\n");
		await setMtime(binaryPath, 2_000);
		await setMtime(realSourcePath, 1_500);
		await setMtime(ignoredTargetPath, 5_000);

		const result = checkStaleness(binaryPath, cratesDir);
		expect(result).not.toBeNull();
		expect(result?.stale).toBe(false);
		expect(result?.newestSourceFile).toBe(realSourcePath);
	});

	it("returns null from the wrapper when PI_DEV is unset", () => {
		expect(process.env.PI_DEV).toBeUndefined();
		expect(checkNativeStaleness(cratesDir)).toBeNull();
	});
});
