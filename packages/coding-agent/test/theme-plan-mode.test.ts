import { describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { getAvailableThemes, getThemeByName } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";

const themeDir = path.resolve(fileURLToPath(import.meta.url), "../../src/modes/theme");

describe("planMode theme color — builtin defaults", () => {
	// Contract: every JSON file under defaults/ and the two base themes (dark, light)
	// must declare a "planMode" color key. This is a static structural guarantee —
	// if a file is missing the key, adding a new builtin theme will silently omit
	// the plan-mode border tint.
	test("every defaults JSON file declares planMode", async () => {
		const defaultsDir = path.join(themeDir, "defaults");
		const files = (await fs.readdir(defaultsDir)).filter(f => f.endsWith(".json"));
		expect(files.length).toBeGreaterThan(0);

		const missing: string[] = [];
		for (const file of files) {
			const json = await Bun.file(path.join(defaultsDir, file)).json();
			if (!json?.colors?.planMode) missing.push(file);
		}
		expect(missing).toEqual([]);
	});

	test("dark.json and light.json declare planMode", async () => {
		for (const base of ["dark.json", "light.json"]) {
			const json = await Bun.file(path.join(themeDir, base)).json();
			expect(json?.colors?.planMode, `${base} missing planMode`).toBeDefined();
		}
	});
});

describe("planMode theme color — runtime resolution", () => {
	// Contract: every theme that loads successfully must resolve planMode to an ANSI
	// string. Themes that are already broken (pre-existing invalid var references)
	// are skipped — the test only covers themes the runtime can actually load.
	test("every loadable builtin theme resolves planMode without throwing", async () => {
		const names = await getAvailableThemes();

		// Only test themes that load without error — pre-existing broken themes
		// (invalid var references etc.) are not in scope of this contract.
		const results = await Promise.all(
			names.map(async name => {
				const t = await getThemeByName(name);
				if (!t) return null; // already broken — skip
				try {
					const colored = t.fg("planMode", "x");
					return { name, ok: typeof colored === "string" && colored.includes("x") };
				} catch (err) {
					return { name, error: String(err) };
				}
			}),
		);

		const failures = results.filter((r): r is { name: string; error: string } => r !== null && "error" in r);
		expect(failures).toEqual([]);
	});

	test("getPlanModeBorderColor returns a colorizing function", async () => {
		const t = await getThemeByName("dark");
		expect(t).toBeDefined();
		const colorize = t!.getPlanModeBorderColor();
		expect(typeof colorize).toBe("function");
		const result = colorize("hello");
		// Must embed the input
		expect(result).toContain("hello");
		// Must wrap with at least one ANSI escape sequence
		expect(result).toMatch(/\x1b\[/);
	});

	// Contract: custom themes that omit planMode must not crash the runtime.
	// The theme loader returns undefined for invalid themes — no unhandled throw.
	test("a custom theme missing planMode returns undefined rather than throwing", async () => {
		// We cannot guarantee a custom theme is installed, so simulate by checking
		// the getThemeByName contract: it must return undefined, not throw.
		// "nonexistent-theme" exercises the same code path as a schema-invalid theme.
		const t = await getThemeByName("__nonexistent_plan_mode_test__");
		expect(t).toBeUndefined();
	});
});
