import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

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
			// Write spell.kdl at project root with a distinctive policy
			await Bun.write(path.join(tmpDir, "spell.kdl"), `domain "coding"\nimport "spell.coding.typescript"\n`);
			// Also write .spell/task-policies.kdl (should be ignored)
			await Bun.write(
				path.join(tmpDir, ".spell", "task-policies.kdl"),
				`layer "old" description="Should not appear"\npolicy "old-policy" layer="old" {\n    gate-commit #true\n}\n`,
			);

			const result = await loadTaskPolicies(tmpDir);
			expect(result).toBeDefined();
			// Should have typescript template layers (core, api, ui, data), not "old"
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

		it("falls back to .spell/task-policies.yml when no KDL files", async () => {
			await Bun.write(
				path.join(tmpDir, ".spell", "task-policies.yml"),
				"version: 1\nlayers:\n  infra:\n    description: Infrastructure\npolicies:\n  - name: infra-gates\n    match:\n      layer: infra\n    gates:\n      gateCommit: true\n",
			);

			const result = await loadTaskPolicies(tmpDir);
			expect(result).toBeDefined();
			expect(result!.layers.infra).toEqual({ description: "Infrastructure" });
			expect(result!.policies[0].name).toBe("infra-gates");
		});

		it("returns undefined when no config files exist", async () => {
			const result = await loadTaskPolicies(tmpDir);
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
			// spell.kdl exists but has no domain node
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
	});
});
