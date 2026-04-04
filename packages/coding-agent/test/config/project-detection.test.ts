import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { detectProject } from "../../src/config/project-detection";

const tempDirs: string[] = [];

async function createTempDir(): Promise<string> {
	const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "spell-detect-"));
	tempDirs.push(tempDir);
	return tempDir;
}

afterEach(async () => {
	await Promise.all(tempDirs.splice(0).map(tempDir => fs.rm(tempDir, { recursive: true, force: true })));
});

describe("detectProject", () => {
	it("detects a TypeScript Bun project from package.json and lockfile", async () => {
		const tempDir = await createTempDir();
		await Bun.write(
			path.join(tempDir, "package.json"),
			JSON.stringify({
				name: "test-app",
				scripts: {
					test: "bun test",
					lint: "biome check",
				},
				devDependencies: {
					typescript: "^5",
				},
			}),
		);
		await Bun.write(path.join(tempDir, "bun.lock"), "");

		const project = await detectProject(tempDir);

		expect(project).toEqual({
			name: "test-app",
			language: "typescript",
			frameworks: [],
			toolchain: {
				testCmd: "bun test",
				lintCmd: "biome check",
			},
			packageManager: "bun",
			monorepo: false,
		});
	});

	it("uses tsgo as the type checker fallback when tsgo.json exists", async () => {
		const tempDir = await createTempDir();
		await Bun.write(
			path.join(tempDir, "package.json"),
			JSON.stringify({
				devDependencies: {
					typescript: "^5",
				},
			}),
		);
		await Bun.write(path.join(tempDir, "tsgo.json"), "{}");

		const project = await detectProject(tempDir);

		expect(project.language).toBe("typescript");
		expect(project.toolchain.checkCmd).toBe("tsgo");
	});

	it("detects a Rust project with cargo defaults", async () => {
		const tempDir = await createTempDir();
		await Bun.write(path.join(tempDir, "Cargo.toml"), '[package]\nname = "example"\n');

		const project = await detectProject(tempDir);

		expect(project).toEqual({
			name: path.basename(tempDir),
			language: "rust",
			frameworks: [],
			toolchain: {
				testCmd: "cargo test",
				checkCmd: "cargo clippy",
				formatCmd: "cargo fmt",
			},
			packageManager: "cargo",
			monorepo: false,
		});
	});

	it("marks a Cargo workspace as a monorepo", async () => {
		const tempDir = await createTempDir();
		await Bun.write(path.join(tempDir, "Cargo.toml"), '[workspace]\nmembers = ["crates/*"]\n');

		const project = await detectProject(tempDir);

		expect(project.language).toBe("rust");
		expect(project.monorepo).toBe(true);
	});

	it("detects Python toolchain defaults from pyproject.toml", async () => {
		const tempDir = await createTempDir();
		await Bun.write(
			path.join(tempDir, "pyproject.toml"),
			"[tool.mypy]\nstrict = true\n\n[tool.ruff]\nline-length = 100\n",
		);

		const project = await detectProject(tempDir);

		expect(project).toEqual({
			name: path.basename(tempDir),
			language: "python",
			frameworks: [],
			toolchain: {
				testCmd: "pytest",
				checkCmd: "mypy",
				lintCmd: "ruff check",
				formatCmd: "ruff format",
			},
			packageManager: "pip",
			monorepo: false,
		});
	});

	it("detects a Go project", async () => {
		const tempDir = await createTempDir();
		await Bun.write(path.join(tempDir, "go.mod"), "module example.com/project\n");

		const project = await detectProject(tempDir);

		expect(project).toEqual({
			name: path.basename(tempDir),
			language: "go",
			frameworks: [],
			toolchain: {
				testCmd: "go test ./...",
				checkCmd: "go vet ./...",
			},
			monorepo: false,
		});
	});

	it("returns unknown for an empty directory", async () => {
		const tempDir = await createTempDir();

		const project = await detectProject(tempDir);

		expect(project).toEqual({
			name: path.basename(tempDir),
			language: "unknown",
			frameworks: [],
			toolchain: {},
			monorepo: false,
		});
	});

	it("detects frameworks from dependencies", async () => {
		const tempDir = await createTempDir();
		await Bun.write(
			path.join(tempDir, "package.json"),
			JSON.stringify({
				dependencies: {
					next: "15.0.0",
					react: "19.0.0",
				},
			}),
		);

		const project = await detectProject(tempDir);

		expect(project.language).toBe("javascript");
		expect(project.frameworks).toEqual(["next", "react"]);
	});

	it("detects monorepos from package.json workspaces", async () => {
		const tempDir = await createTempDir();
		await Bun.write(path.join(tempDir, "package.json"), JSON.stringify({ workspaces: ["packages/*"] }));

		const project = await detectProject(tempDir);

		expect(project.monorepo).toBe(true);
	});

	it("falls through to Rust when package.json is malformed", async () => {
		const tempDir = await createTempDir();
		await Bun.write(path.join(tempDir, "package.json"), "{ invalid json");
		await Bun.write(path.join(tempDir, "Cargo.toml"), '[package]\nname = "detected"\n');

		const project = await detectProject(tempDir);

		expect(project.language).toBe("rust");
		expect(project.toolchain.testCmd).toBe("cargo test");
	});

	it("returns unknown for malformed package.json with no other language markers", async () => {
		const tempDir = await createTempDir();
		await Bun.write(path.join(tempDir, "package.json"), "not json at all");

		const project = await detectProject(tempDir);

		expect(project.language).toBe("unknown");
	});

	it("prefers bun when multiple JavaScript lockfiles exist", async () => {
		const tempDir = await createTempDir();
		await Bun.write(path.join(tempDir, "package.json"), JSON.stringify({}));
		await Bun.write(path.join(tempDir, "bun.lock"), "");
		await Bun.write(path.join(tempDir, "package-lock.json"), "{}");

		const project = await detectProject(tempDir);

		expect(project.packageManager).toBe("bun");
	});
});
