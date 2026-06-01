/**
 * Unit tests for the spawn-path resolution chain. Pure (injected env + probe).
 */

import { describe, expect, it } from "bun:test";
import { burritoBinaryPath, resolveSpawn } from "./spawn";

const RUNTIME = "/repo/beam/ptc_runtime";
const never = () => false;
const always = () => true;

describe("resolveSpawn", () => {
	it("prefers PTC_RUNTIME_BIN override", () => {
		const plan = resolveSpawn({
			runtimeDir: RUNTIME,
			env: { PTC_RUNTIME_BIN: "/opt/ptc" },
			exists: never,
		});
		expect(plan.source).toBe("env");
		expect(plan.command).toBe("/opt/ptc");
		expect(plan.args).toEqual([]);
	});

	it("falls back to the burrito binary when it exists", () => {
		const burrito = burritoBinaryPath(RUNTIME, "linux_x86_64");
		const plan = resolveSpawn({
			runtimeDir: RUNTIME,
			env: {},
			target: "linux_x86_64",
			exists: p => p === burrito,
		});
		expect(plan.source).toBe("burrito");
		expect(plan.command).toBe(burrito);
	});

	it("falls back to mix run when only the runtime dir exists", () => {
		const plan = resolveSpawn({
			runtimeDir: RUNTIME,
			env: {},
			target: "linux_x86_64",
			exists: p => p === RUNTIME,
		});
		expect(plan.source).toBe("mix");
		expect(plan.command).toBe("mix");
		expect(plan.args).toEqual(["run", "--no-halt"]);
		expect(plan.cwd).toBe(RUNTIME);
	});

	it("throws a clear error when nothing resolves", () => {
		expect(() => resolveSpawn({ runtimeDir: RUNTIME, env: {}, exists: never })).toThrow(
			/no spawn path resolved/,
		);
	});

	it("always forwards a diagnostic log dir", () => {
		const plan = resolveSpawn({ runtimeDir: RUNTIME, env: { PTC_RUNTIME_BIN: "/x" }, exists: never });
		expect(plan.env.PTC_RUNTIME_LOG_DIR).toBeTruthy();
	});

	it("honors an explicit PTC_RUNTIME_LOG_DIR", () => {
		const plan = resolveSpawn({
			runtimeDir: RUNTIME,
			env: { PTC_RUNTIME_BIN: "/x", PTC_RUNTIME_LOG_DIR: "/logs/here" },
			exists: never,
		});
		expect(plan.env.PTC_RUNTIME_LOG_DIR).toBe("/logs/here");
	});
});

describe("burritoBinaryPath", () => {
	it("names the artifact <app>_<os>_<cpu>", () => {
		expect(burritoBinaryPath(RUNTIME, "darwin_aarch64")).toBe(
			"/repo/beam/ptc_runtime/burrito_out/ptc_runtime_darwin_aarch64",
		);
	});
});
