import * as path from "node:path";
import { isEnoent, logger } from "@oh-my-pi/pi-utils";

export type ProjectLanguage = "typescript" | "javascript" | "rust" | "python" | "go" | "unknown";

export interface DetectedToolchain {
	testCmd?: string;
	checkCmd?: string;
	lintCmd?: string;
	formatCmd?: string;
}

export interface DetectedProject {
	name: string;
	language: ProjectLanguage;
	frameworks: string[];
	toolchain: DetectedToolchain;
	packageManager?: string;
	monorepo: boolean;
}

interface PackageJsonScripts {
	test?: unknown;
	check?: unknown;
	typecheck?: unknown;
	lint?: unknown;
	format?: unknown;
}

interface PackageJsonWorkspaceObject {
	packages?: unknown;
}

interface PackageJsonShape {
	name?: unknown;
	scripts?: unknown;
	dependencies?: unknown;
	devDependencies?: unknown;
	workspaces?: unknown;
}

const FRAMEWORK_DEPENDENCIES = ["next", "react", "vue", "svelte", "express", "fastify", "hono"] as const;

function createUnknownProject(cwd: string): DetectedProject {
	return {
		name: path.basename(cwd),
		language: "unknown",
		frameworks: [],
		toolchain: {},
		monorepo: false,
	};
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		return undefined;
	}
	return value as Record<string, unknown>;
}

function asString(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function hasWorkspaceConfig(workspaces: unknown): boolean {
	if (Array.isArray(workspaces)) return true;
	const workspaceObject = asRecord(workspaces) as PackageJsonWorkspaceObject | undefined;
	return Array.isArray(workspaceObject?.packages);
}

function detectFrameworks(dependencies: Record<string, unknown>): string[] {
	return FRAMEWORK_DEPENDENCIES.filter(dependency => dependency in dependencies);
}

function hasDependency(dependencies: Record<string, unknown>, dependency: string): boolean {
	return dependency in dependencies;
}

async function detectPackageManager(cwd: string): Promise<string | undefined> {
	const candidates = [
		{ fileName: "bun.lock", packageManager: "bun" },
		{ fileName: "bun.lockb", packageManager: "bun" },
		{ fileName: "package-lock.json", packageManager: "npm" },
		{ fileName: "yarn.lock", packageManager: "yarn" },
		{ fileName: "pnpm-lock.yaml", packageManager: "pnpm" },
	] as const;

	for (const candidate of candidates) {
		if (await Bun.file(path.join(cwd, candidate.fileName)).exists()) {
			return candidate.packageManager;
		}
	}

	return undefined;
}

async function detectJavaScriptProject(cwd: string, packageJson: PackageJsonShape): Promise<DetectedProject> {
	const dependencies = {
		...asRecord(packageJson.dependencies),
		...asRecord(packageJson.devDependencies),
	};
	const scripts = asRecord(packageJson.scripts) as PackageJsonScripts | undefined;
	const toolchain: DetectedToolchain = {
		testCmd: asString(scripts?.test),
		checkCmd: asString(scripts?.check) ?? asString(scripts?.typecheck),
		lintCmd: asString(scripts?.lint),
		formatCmd: asString(scripts?.format),
	};

	if (!toolchain.checkCmd) {
		if (await Bun.file(path.join(cwd, "tsgo.json")).exists()) {
			toolchain.checkCmd = "tsgo";
		} else if (await Bun.file(path.join(cwd, "tsconfig.json")).exists()) {
			toolchain.checkCmd = "tsc";
		}
	}

	if (!toolchain.lintCmd) {
		const biomeJsonExists = await Bun.file(path.join(cwd, "biome.json")).exists();
		const biomeJsoncExists = biomeJsonExists || (await Bun.file(path.join(cwd, "biome.jsonc")).exists());
		if (biomeJsoncExists) {
			toolchain.lintCmd = "biome check";
		}
	}

	return {
		name: asString(packageJson.name) ?? path.basename(cwd),
		language: hasDependency(dependencies, "typescript") ? "typescript" : "javascript",
		frameworks: detectFrameworks(dependencies),
		toolchain,
		packageManager: await detectPackageManager(cwd),
		monorepo: hasWorkspaceConfig(packageJson.workspaces),
	};
}

async function detectRustProject(cwd: string): Promise<DetectedProject> {
	const cargoTomlPath = path.join(cwd, "Cargo.toml");
	const cargoToml = await Bun.file(cargoTomlPath).text();
	return {
		name: path.basename(cwd),
		language: "rust",
		frameworks: [],
		toolchain: {
			testCmd: "cargo test",
			checkCmd: "cargo clippy",
			formatCmd: "cargo fmt",
		},
		packageManager: "cargo",
		monorepo: cargoToml.includes("[workspace]"),
	};
}

async function detectPythonProject(cwd: string): Promise<DetectedProject> {
	const pyprojectPath = path.join(cwd, "pyproject.toml");
	let pyproject = "";
	let packageManager: string | undefined = "pip";
	const monorepo = false;

	try {
		pyproject = await Bun.file(pyprojectPath).text();
		if (pyproject.includes("[tool.poetry]")) {
			packageManager = "poetry";
		}
	} catch (error) {
		if (!isEnoent(error)) {
			throw error;
		}
	}

	const toolchain: DetectedToolchain = {
		testCmd: "pytest",
	};
	if (pyproject.includes("[tool.mypy]")) {
		toolchain.checkCmd = "mypy";
	}
	if (pyproject.includes("[tool.ruff]")) {
		toolchain.lintCmd = "ruff check";
		toolchain.formatCmd = "ruff format";
	}

	return {
		name: path.basename(cwd),
		language: "python",
		frameworks: [],
		toolchain,
		packageManager,
		monorepo,
	};
}

function detectGoProject(cwd: string): DetectedProject {
	return {
		name: path.basename(cwd),
		language: "go",
		frameworks: [],
		toolchain: {
			testCmd: "go test ./...",
			checkCmd: "go vet ./...",
		},
		monorepo: false,
	};
}

export async function detectProject(cwd: string): Promise<DetectedProject> {
	const packageJsonPath = path.join(cwd, "package.json");
	try {
		const packageJson = (await Bun.file(packageJsonPath).json()) as PackageJsonShape;
		return await detectJavaScriptProject(cwd, packageJson);
	} catch (error) {
		if (!isEnoent(error)) {
			logger.warn("project-detection: malformed package.json, checking other languages", {
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}

	if (await Bun.file(path.join(cwd, "Cargo.toml")).exists()) {
		return detectRustProject(cwd);
	}

	if (
		(await Bun.file(path.join(cwd, "pyproject.toml")).exists()) ||
		(await Bun.file(path.join(cwd, "setup.py")).exists())
	) {
		return detectPythonProject(cwd);
	}

	if (await Bun.file(path.join(cwd, "go.mod")).exists()) {
		return detectGoProject(cwd);
	}

	return createUnknownProject(cwd);
}
