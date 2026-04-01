import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { createTarball } from "@oh-my-pi/pi-coding-agent/spellcast/tarball";

describe("createTarball", () => {
	let cwd = "";

	beforeEach(async () => {
		cwd = await fs.mkdtemp(path.join(os.tmpdir(), "spellcast-tarball-"));
		await Bun.write(path.join(cwd, "Main.qml"), "import QtQuick\nRectangle {}");
		await Bun.write(path.join(cwd, "data.json"), "{}");
	});

	afterEach(async () => {
		if (cwd) {
			await fs.rm(cwd, { recursive: true, force: true });
		}
	});

	it("creates a gzip tarball from the declared files", async () => {
		const tarball = await createTarball(cwd, ["Main.qml", "data.json"]);
		expect(tarball[0]).toBe(0x1f);
		expect(tarball[1]).toBe(0x8b);
	});

	it("throws when a declared file is missing", async () => {
		await expect(createTarball(cwd, ["missing.qml"]))
			.rejects.toThrow(/not found/i);
	});
});
