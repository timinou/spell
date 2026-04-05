import { describe, expect, it } from "bun:test";
import { parseManifestKdl } from "../../src/manifest/parser";

const BASE_KDL = `name "test"\nversion "1.0.0"\nsetup "worker" { domain "coding" }\ngoal "test-goal" { setup "worker"\nschedule type="cron" expression="0 * * * *"\nprompt "do stuff" }\n`;

describe("tool-module KDL parsing", () => {
	it("parses tool-module nodes with id and path", () => {
		const kdl = `${BASE_KDL}\ntool-module "growth-scoring" path=".spell/tools/growth-scoring.ts"`;
		const manifest = parseManifestKdl(kdl);
		expect(manifest.toolModules).toHaveLength(1);
		expect(manifest.toolModules[0]).toEqual({
			id: "growth-scoring",
			path: ".spell/tools/growth-scoring.ts",
		});
	});

	it("parses multiple tool-module nodes", () => {
		const kdl = `${BASE_KDL}
tool-module "growth-scoring" path=".spell/tools/growth-scoring.ts"
tool-module "feed-formatter" path=".spell/tools/feed-formatter.ts"`;
		const manifest = parseManifestKdl(kdl);
		expect(manifest.toolModules).toHaveLength(2);
		expect(manifest.toolModules[0].id).toBe("growth-scoring");
		expect(manifest.toolModules[1].id).toBe("feed-formatter");
	});

	it("rejects duplicate tool-module names", () => {
		const kdl = `${BASE_KDL}
tool-module "growth-scoring" path=".spell/tools/a.ts"
tool-module "growth-scoring" path=".spell/tools/b.ts"`;
		expect(() => parseManifestKdl(kdl)).toThrow("Duplicate tool-module");
	});

	it("rejects missing path property", () => {
		const kdl = `${BASE_KDL}\ntool-module "scoring"`;
		expect(() => parseManifestKdl(kdl)).toThrow("path is required");
	});

	it("returns empty toolModules when none declared", () => {
		const manifest = parseManifestKdl(BASE_KDL);
		expect(manifest.toolModules).toEqual([]);
	});
});
