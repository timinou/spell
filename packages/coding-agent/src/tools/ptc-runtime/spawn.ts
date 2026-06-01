/**
 * Spawn-path resolution for the PtcRuntime BEAM coprocessor.
 *
 * Spell launches ONE long-lived BEAM runtime per session and talks to it over
 * stdio (NDJSON JSON-RPC; see `client.ts` and `beam/ptc_runtime`). This module
 * resolves *how* to launch it, mirroring the candidate-chain pattern Spell uses
 * for the native worker binary.
 *
 * ## Resolution chain (first match wins)
 *
 *   1. `PTC_RUNTIME_BIN`     — explicit override (a Burrito binary or wrapper).
 *   2. Burrito release       — `beam/ptc_runtime/burrito_out/ptc_runtime_<target>`
 *                              (Phase 0b artifact; bundles ERTS, no Elixir needed).
 *   3. `mix run` dev mode    — `mix run --no-halt` in `beam/ptc_runtime`
 *                              (requires Elixir on PATH; the fast dev loop).
 *
 * The chain is intentionally explicit and inspectable: `resolveSpawn()` returns
 * a fully-formed `{ command, args, cwd, env }` plus the `source` that won, so
 * callers (and tests) can assert which path was taken and surface a clear error
 * when nothing resolves.
 */

import { existsSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/** How the runtime will be launched. */
export interface SpawnPlan {
	/** Executable to spawn. */
	command: string;
	/** Arguments. */
	args: string[];
	/** Working directory (required for `mix run`; harmless otherwise). */
	cwd?: string;
	/** Extra environment for the child. */
	env: Record<string, string>;
	/** Which chain entry resolved (for diagnostics + tests). */
	source: "env" | "burrito" | "mix";
}

/** Options for resolution; all optional with sensible defaults. */
export interface ResolveSpawnOptions {
	/** Absolute path to `beam/ptc_runtime`. Defaults to repo-relative lookup. */
	runtimeDir?: string;
	/** Environment to read (defaults to `process.env`). Injectable for tests. */
	env?: NodeJS.ProcessEnv;
	/** Override platform/arch for burrito target naming (tests). */
	target?: string;
	/** Existence probe (injectable for tests). Defaults to `fs.existsSync`. */
	exists?: (p: string) => boolean;
}

/**
 * Resolve how to spawn the PtcRuntime. Throws only if `mix` fallback is selected
 * but the runtime directory is missing — every earlier branch is a file probe.
 */
export function resolveSpawn(opts: ResolveSpawnOptions = {}): SpawnPlan {
	const env = opts.env ?? process.env;
	const exists = opts.exists ?? existsSync;
	const runtimeDir = opts.runtimeDir ?? defaultRuntimeDir();
	const extraEnv = diagnosticEnv(env);

	// 1. Explicit override.
	const override = env.PTC_RUNTIME_BIN;
	if (override && override.length > 0) {
		return { command: override, args: [], env: extraEnv, source: "env" };
	}

	// 2. Burrito single-binary release (Phase 0b artifact).
	const burrito = burritoBinaryPath(runtimeDir, opts.target);
	if (exists(burrito)) {
		return { command: burrito, args: [], env: extraEnv, source: "burrito" };
	}

	// 3. Dev fallback: `mix run --no-halt` in the runtime dir.
	if (!exists(runtimeDir)) {
		throw new Error(
			`PtcRuntime: no spawn path resolved. PTC_RUNTIME_BIN unset, no burrito ` +
				`binary at ${burrito}, and runtime dir not found at ${runtimeDir}. ` +
				`Build the runtime (cd beam/ptc_runtime && mix deps.get) or set PTC_RUNTIME_BIN.`,
		);
	}

	return {
		command: "mix",
		args: ["run", "--no-halt"],
		cwd: runtimeDir,
		env: extraEnv,
		source: "mix",
	};
}

/** Burrito output binary path for the current (or overridden) target. */
export function burritoBinaryPath(runtimeDir: string, target?: string): string {
	const t = target ?? burritoTarget();
	return path.join(runtimeDir, "burrito_out", `ptc_runtime_${t}`);
}

/** Burrito names artifacts `<app>_<os>_<cpu>`; derive from host or override. */
function burritoTarget(): string {
	const osName = process.platform === "darwin" ? "darwin" : process.platform === "win32" ? "windows" : "linux";
	const cpu = process.arch === "arm64" ? "aarch64" : "x86_64";
	return `${osName}_${cpu}`;
}

/** Default `beam/ptc_runtime` location, repo-relative to this module. */
function defaultRuntimeDir(): string {
	// This file: packages/coding-agent/src/tools/ptc-runtime/spawn.ts
	// Repo root: five levels up. beam/ptc_runtime hangs off the root.
	return path.resolve(import.meta.dirname, "..", "..", "..", "..", "..", "beam", "ptc_runtime");
}

/**
 * Environment passed to the child. We forward a diagnostic log dir so the BEAM's
 * crash-safe logger (see PtcRuntime.Logger) writes somewhere predictable, never
 * to stderr (which would corrupt or crash the stdio protocol).
 */
function diagnosticEnv(env: NodeJS.ProcessEnv): Record<string, string> {
	const logDir = env.PTC_RUNTIME_LOG_DIR ?? path.join(os.tmpdir(), "spell-ptc-runtime");
	return { PTC_RUNTIME_LOG_DIR: logDir };
}
