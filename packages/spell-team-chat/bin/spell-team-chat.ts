#!/usr/bin/env bun
/**
 * spell-team-chat — boot spell-server with our Svelte SPA mounted under /web/.
 *
 * Resolves the bundled dist relative to this file (so it works from a global
 * install or the monorepo) and sets SPELL_WEB_DIST so spell-server's
 * `resolveSpellWebDist()` picks it up.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const distDir = resolve(here, "..", "dist");
if (!existsSync(join(distDir, "index.html"))) {
	console.error(`[spell-team-chat] missing dist at ${distDir}`);
	console.error(`Run \`bun --cwd ${resolve(here, "..")} run build\` first.`);
	process.exit(1);
}

// Resolve spell-server entry. Prefer the package's main.ts, fall back to a
// monorepo-relative path.
function resolveServerEntry(): string {
	const candidates = [
		// installed/symlinked workspace package
		resolve(here, "..", "..", "spell-server", "src", "main.ts"),
		// global install layout (../node_modules)
		resolve(here, "..", "..", "..", "spell-server", "src", "main.ts"),
	];
	for (const c of candidates) {
		if (existsSync(c)) return c;
	}
	console.error(
		"[spell-team-chat] could not find @oh-my-pi/spell-server entry. Install it as a sibling package.",
	);
	process.exit(1);
}

const serverEntry = resolveServerEntry();
const env = { ...process.env, SPELL_WEB_DIST: distDir };
const child = spawn("bun", ["run", serverEntry, ...process.argv.slice(2)], {
	stdio: "inherit",
	env,
});

child.on("exit", code => process.exit(code ?? 0));
process.on("SIGINT", () => child.kill("SIGINT"));
process.on("SIGTERM", () => child.kill("SIGTERM"));
