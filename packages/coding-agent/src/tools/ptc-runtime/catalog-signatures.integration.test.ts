/**
 * Signature-validity guard: every PTC signature the catalog generator emits
 * MUST parse under the real ptc_runner grammar. This is the test that would
 * have caught the `[:t]?` optional-array bug (Review Gate 2, P1).
 *
 * We add a `validate_signature` method to the BEAM peer's surface? No — instead
 * we exercise it through `execute`: a program with a matching trivial return
 * validated against the signature. If the signature is unparseable, execute
 * returns a parse error; if it parses, execute succeeds (or fails on a
 * value-mismatch we don't trigger). We only assert the signature itself parses.
 *
 * Skipped when the runtime isn't built.
 */

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "bun:test";
import { Type } from "@sinclair/typebox";
import { PtcRuntimeClient, PtcRuntimeError, spawnTransport } from "./client";
import { type CatalogTool, generateToolCatalog } from "./catalog-gen";

const runtimeDir = path.resolve(import.meta.dirname, "..", "..", "..", "..", "..", "beam", "ptc_runtime");
const runnable = spawnSync("mix", ["--version"], { stdio: "ignore" }).status === 0 && existsSync(path.join(runtimeDir, "_build"));
const d = runnable ? describe : describe.skip;

// A representative cross-section of real Spell tool parameter shapes, including
// the optional-array case that broke the grammar.
const SAMPLE_TOOLS: CatalogTool[] = [
	{ name: "find", parameters: Type.Object({ target: Type.String(), content: Type.Optional(Type.Boolean()) }) },
	{
		name: "todo_write",
		parameters: Type.Object({ ops: Type.Array(Type.Object({})), note: Type.Optional(Type.String()) }),
	},
	{
		name: "memory",
		parameters: Type.Object({
			action: Type.String(),
			scope: Type.Optional(Type.Array(Type.String())),
			hops: Type.Optional(Type.Integer()),
			involved: Type.Optional(Type.Array(Type.String())),
		}),
	},
	{
		name: "org",
		parameters: Type.Object({
			command: Type.String(),
			depends: Type.Optional(Type.Array(Type.String())),
			limit: Type.Optional(Type.Integer()),
		}),
	},
];

d("generated signatures parse under real ptc_runner", () => {
	it("every catalog signature is accepted by the grammar", async () => {
		const { transport } = spawnTransport({ runtimeDir });
		const client = new PtcRuntimeClient({ transport, onToolCall: async () => null });
		try {
			await client.init({ tools: [] });
			const catalog = generateToolCatalog(SAMPLE_TOOLS);

			for (const entry of catalog) {
				// A program returning a trivial map, validated against the signature.
				// We only care that the SIGNATURE parses: a parse error has
				// reason "parse_error"; a value/shape mismatch is a different
				// reason (and acceptable — it proves the signature parsed).
				try {
					await client.execute({ program: "{}", signature: entry.signature });
				} catch (e) {
					if (e instanceof PtcRuntimeError) {
						const reason = (e.data as { reason?: string } | undefined)?.reason;
						expect(
							reason,
							`signature for '${entry.name}' did not parse: ${entry.signature}`,
						).not.toBe("parse_error");
					} else {
						throw e;
					}
				}
			}
		} finally {
			client.close();
		}
	}, 60_000);
});
