import { afterEach, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { loadConfig } from "../../spell-server/src/config/loader";
import { cleanupTempDir, createTempDir } from "./test-helpers";

const tempDirs = new Set<string>();

afterEach(async () => {
	await Promise.allSettled([...tempDirs].map(async dir => cleanupTempDir(dir)));
	tempDirs.clear();
});

describe("action registration", () => {
	it("resolves growth actions through the server bootstrap registry", async () => {
		const dir = await createTempDir("spell-growth-config-");
		tempDirs.add(dir);
		await Bun.write(
			path.join(dir, "server.kdl"),
			`http {\n\tport 0\n\tauth {\n\t\tusername \"spell\"\n\t\tpassword \"secret\"\n\t}\n}`,
		);
		await Bun.write(
			path.join(dir, "autonomy.kdl"),
			`name \"growth\"\nversion \"1.0.0\"\nsetup \"worker\" {\n\tdomain \"coding\"\n}\ngoal \"discover\" {\n\tsetup \"worker\"\n\tschedule type=\"cron\" expression=\"0 1 * * *\"\n\taction \"growth.discovery\"\n}`,
		);

		const loaded = await loadConfig(dir);
		expect(loaded.actionRegistry.has("growth.discovery")).toBe(true);
		expect(loaded.manifest.goals.get("discover")?.action?.id).toBe("growth.discovery");
	});
});
