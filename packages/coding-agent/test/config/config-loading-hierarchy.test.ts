import { afterEach, beforeEach, describe, expect, it } from "bun:test";

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { loadMergedProviderConfigs } from "../../src/config/spell-kdl";
import { loadTaskPolicies } from "../../src/config/task-policies";
import { detectDomain } from "../../src/domain/detection";

describe("config loading hierarchy", () => {
	let tmpDir: string;

	beforeEach(async () => {
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "spell-hierarchy-"));
	});

	afterEach(async () => {
		await fs.rm(tmpDir, { recursive: true, force: true });
	});

	describe("loadTaskPolicies", () => {
		it("spell.kdl takes priority over .spell/task-policies.kdl", async () => {
			await Bun.write(path.join(tmpDir, "spell.kdl"), `domain "coding"\nimport "spell.coding.typescript"\n`);
			await Bun.write(
				path.join(tmpDir, ".spell", "task-policies.kdl"),
				`layer "old" description="Should not appear"\npolicy "old-policy" layer="old" {\n    gate-commit #true\n}\n`,
			);

			const result = await loadTaskPolicies(tmpDir);
			expect(result).toBeDefined();
			expect(result!.layers.core).toBeDefined();
			expect(result!.layers.old).toBeUndefined();
		});

		it("falls back to .spell/task-policies.kdl when no spell.kdl", async () => {
			await Bun.write(
				path.join(tmpDir, ".spell", "task-policies.kdl"),
				`layer "backend" description="Backend layer"\npolicy "backend-quality" layer="backend" {\n    gate-commit #true\n}\n`,
			);

			const result = await loadTaskPolicies(tmpDir);
			expect(result).toBeDefined();
			expect(result!.layers.backend).toEqual({ description: "Backend layer" });
			expect(result!.policies).toHaveLength(1);
			expect(result!.policies[0].name).toBe("backend-quality");
		});

		it("ignores legacy .spell/task-policies.yml files", async () => {
			await Bun.write(
				path.join(tmpDir, ".spell", "task-policies.yml"),
				"version: 1\nlayers:\n  infra:\n    description: Infrastructure\npolicies:\n  - name: infra-gates\n    match:\n      layer: infra\n    gates:\n      gateCommit: true\n",
			);

			const result = await loadTaskPolicies(tmpDir);
			expect(result).toBeUndefined();
		});

		it("returns undefined when no config files exist", async () => {
			const result = await loadTaskPolicies(tmpDir);
			expect(result).toBeUndefined();
		});

		it("malformed spell.kdl prevents fallthrough to .spell/task-policies.kdl", async () => {
			await Bun.write(path.join(tmpDir, "spell.kdl"), 'domain "broken" {');
			await Bun.write(
				path.join(tmpDir, ".spell", "task-policies.kdl"),
				`layer "old" description="Should not appear"\npolicy "old-policy" layer="old" {\n    gate-commit #true\n}\n`,
			);

			const result = await loadTaskPolicies(tmpDir);
			expect(result).toBeDefined();
			expect(result!.layers.old).toBeUndefined();
			expect(result!.policies).toEqual([]);
		});
	});

	describe("loadMergedProviderConfigs", () => {
		it("ignores legacy models.yml when spell.kdl is absent", async () => {
			const agentDir = path.join(tmpDir, "agent");
			await fs.mkdir(agentDir, { recursive: true });
			await Bun.write(path.join(agentDir, "models.yml"), "anthropic:\n  baseUrl: https://legacy.example/v1\n");

			const result = await loadMergedProviderConfigs(tmpDir, agentDir);
			expect(result).toBeUndefined();
		});
	});

	describe("detectDomain", () => {
		it("CLI override wins over spell.kdl", async () => {
			await Bun.write(path.join(tmpDir, "spell.kdl"), 'domain "growth"\n');

			const result = await detectDomain(tmpDir, "custom");
			expect(result).toBe("custom");
		});

		it("spell.kdl domain takes priority over domain.json", async () => {
			await Bun.write(path.join(tmpDir, "spell.kdl"), 'domain "growth"\n');
			await Bun.write(path.join(tmpDir, ".spell", "domain.json"), '{"domain": "coding"}');

			const result = await detectDomain(tmpDir);
			expect(result).toBe("growth");
		});

		it("falls back to domain.json when spell.kdl has no domain", async () => {
			await Bun.write(path.join(tmpDir, "spell.kdl"), 'import "spell.coding.typescript"\n');
			await Bun.write(path.join(tmpDir, ".spell", "domain.json"), '{"domain": "growth"}');

			const result = await detectDomain(tmpDir);
			expect(result).toBe("growth");
		});

		it("falls back to domain.json when no spell.kdl", async () => {
			await Bun.write(path.join(tmpDir, ".spell", "domain.json"), '{"domain": "growth"}');

			const result = await detectDomain(tmpDir);
			expect(result).toBe("growth");
		});

		it("returns 'coding' when neither file exists", async () => {
			const result = await detectDomain(tmpDir);
			expect(result).toBe("coding");
		});

		it("malformed spell.kdl prevents fallthrough to domain.json", async () => {
			await Bun.write(path.join(tmpDir, "spell.kdl"), 'domain "broken" {');
			await Bun.write(path.join(tmpDir, ".spell", "domain.json"), '{"domain": "growth"}');

			const result = await detectDomain(tmpDir);
			expect(result).toBe("coding");
		});
	});
});
