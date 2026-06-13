/**
 * BUG-472 napi-mirror parity gate.
 *
 * `CodePathOptions` crosses the napi boundary as a `#[napi(object)]` Rust struct
 * (crates/pi-natives/src/code_path/napi.rs) AND a hand-authored TS interface
 * (packages/natives/src/code-path/types.ts). The build does not run
 * `napi build --dts`, so the TS side is a manual mirror that can silently drift —
 * exactly how the `transaction` field went missing until this guard was added.
 *
 * The Rust struct is the source of truth: `list_codepath_option_keys()` exposes
 * its JS-facing key names (and a compile-time exhaustiveness tripwire in Rust
 * keeps that list honest against the struct). This test pins the TS interface
 * keys against it — the same pattern as `verb-schema-parity.test.ts`/`listVerbKinds()`.
 *
 * A mismatch means a napi field was added/removed/renamed on one side only.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { expect, test } from "bun:test";
import { listCodepathOptionKeys } from "@spell/pi-natives";

const here = dirname(fileURLToPath(import.meta.url));
// test/tools → package root → natives types.ts
const typesPath = join(here, "../../../natives/src/code-path/types.ts");

/** Extract the property keys declared in the `interface CodePathOptions { … }` block. */
function tsInterfaceKeys(): string[] {
	const src = readFileSync(typesPath, "utf8");
	const start = src.indexOf("interface CodePathOptions {");
	expect(start, "CodePathOptions interface not found in types.ts").toBeGreaterThanOrEqual(0);
	// Walk to the matching closing brace.
	const open = src.indexOf("{", start);
	let depth = 0;
	let end = open;
	for (let i = open; i < src.length; i++) {
		if (src[i] === "{") depth++;
		else if (src[i] === "}") {
			depth--;
			if (depth === 0) {
				end = i;
				break;
			}
		}
	}
	const body = src.slice(open + 1, end);
	const keys: string[] = [];
	// `name?: Type;` or `name: Type;` at property position (skip comment/blank lines).
	for (const raw of body.split("\n")) {
		const line = raw.trim();
		if (!line || line.startsWith("//") || line.startsWith("/*") || line.startsWith("*")) continue;
		const m = /^([A-Za-z_][A-Za-z0-9_]*)\??\s*:/.exec(line);
		if (m) keys.push(m[1]);
	}
	return keys;
}

test("kernel list_codepath_option_keys() matches TS CodePathOptions interface keys", () => {
	const kernel = [...listCodepathOptionKeys()].sort();
	const ts = [...tsInterfaceKeys()].sort();
	expect(ts).toEqual(kernel);
});

test("regression: `transaction` is present on both sides (BUG-472 drift)", () => {
	expect(listCodepathOptionKeys()).toContain("transaction");
	expect(tsInterfaceKeys()).toContain("transaction");
});
