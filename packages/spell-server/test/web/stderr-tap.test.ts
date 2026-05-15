import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { RpcClient } from "../../src/rpc/rpc-client";

describe("RpcClient.onStderr", () => {
	let binDir = "";
	let spellPath = "";

	beforeAll(async () => {
		binDir = await fs.mkdtemp(path.join(os.tmpdir(), "spell-stderr-tap-"));
		spellPath = path.join(binDir, "spell");
		// Mock binary: emits "ready" on stdout, then writes a sequence of stderr
		// lines determined by the --append-system-prompt scenario flag.
		const script = `#!/usr/bin/env bun
const args = process.argv.slice(2);
const flag = args.indexOf("--append-system-prompt");
const scenario = flag >= 0 ? args[flag + 1] : "default";
process.stdout.write(JSON.stringify({type:"ready"}) + "\\n");

if (scenario === "lines") {
	process.stderr.write("line one\\nline two\\n");
	process.stderr.write("partial");
	process.stderr.write("-rest\\n");
	process.stderr.write("line four\\n");
}
if (scenario === "oversize") {
	process.stderr.write("ok\\n");
	process.stderr.write("X".repeat(5000) + "\\n");
	process.stderr.write("after\\n");
}
// keep process alive briefly so reader drains
setTimeout(() => process.exit(0), 200);
`;
		await fs.writeFile(spellPath, script, { mode: 0o755 });
	});

	afterAll(async () => {
		await fs.rm(binDir, { recursive: true, force: true }).catch(() => undefined);
	});

	it("buffers stderr across chunks and emits whole lines in order", async () => {
		const client = new RpcClient(
			{ cwd: process.cwd(), tools: [], appendSystemPrompt: "lines" },
			{ command: spellPath },
		);
		const received: string[] = [];
		client.onStderr(line => received.push(line));
		await client.start();
		// allow stderr to flush
		await Bun.sleep(300);
		await client.kill();
		expect(received).toEqual(["line one", "line two", "partial-rest", "line four"]);
	});

	it("drops lines longer than 4096 chars silently", async () => {
		const client = new RpcClient(
			{ cwd: process.cwd(), tools: [], appendSystemPrompt: "oversize" },
			{ command: spellPath },
		);
		const received: string[] = [];
		client.onStderr(line => received.push(line));
		await client.start();
		await Bun.sleep(300);
		await client.kill();
		expect(received).toEqual(["ok", "after"]);
	});
});
