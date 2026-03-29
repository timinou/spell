import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { $ } from "bun";
import { importParsedSpecs } from "../../src/loop/ingestion/importer";
import { parseSpecDirectory } from "../../src/loop/ingestion/parser";
import type { LoopRoleResponder } from "../../src/loop/orchestration/phase-coordinator";
import { LoopJourney } from "./loop-journey";

export class IntegrationJourney {
	readonly cwd: string;
	readonly loop: LoopJourney;
	readonly specDir: string;

	constructor(cwd: string, responder: LoopRoleResponder) {
		this.cwd = cwd;
		this.loop = new LoopJourney(cwd, responder);
		this.specDir = path.join(cwd, "specs");
	}

	static async create(responder: LoopRoleResponder): Promise<IntegrationJourney> {
		const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "loop-integration-"));
		await $`git init`.cwd(cwd).quiet().nothrow();
		await $`git config user.email test@example.com`.cwd(cwd).quiet().nothrow();
		await $`git config user.name Test User`.cwd(cwd).quiet().nothrow();
		return new IntegrationJourney(cwd, responder);
	}

	async writeSpec(name: string, content: string): Promise<string> {
		const filePath = path.join(this.specDir, name);
		await Bun.write(filePath, content);
		return filePath;
	}

	async importSpecs(): Promise<string[]> {
		const parsed = await parseSpecDirectory(this.specDir);
		return importParsedSpecs(this.cwd, parsed, this.specDir);
	}

	async commitAll(message: string): Promise<void> {
		await $`git add .`.cwd(this.cwd).quiet().nothrow();
		await $`git commit -m ${message}`.cwd(this.cwd).quiet().nothrow();
	}

	async teardown(): Promise<void> {
		await fs.rm(this.cwd, { recursive: true, force: true });
	}
}
