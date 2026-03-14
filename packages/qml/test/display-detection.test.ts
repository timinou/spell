/**
 * Tests for isDisplayAvailable.
 *
 * Contracts:
 * 1. Non-linux platforms (darwin, win32) always return true.
 * 2. Linux with DISPLAY set returns true.
 * 3. Linux with WAYLAND_DISPLAY set returns true.
 * 4. Linux with neither set returns false.
 * 5. Linux with empty DISPLAY returns false.
 * 6. Linux with both set returns true.
 */

import { describe, expect, it } from "bun:test";
import { isDisplayAvailable } from "../src/qml-bridge";

/**
 * Temporarily overrides process.platform and process.env for the
 * duration of `fn`, restoring both afterward.
 */
function withEnv(platform: string, env: Record<string, string | undefined>, fn: () => void): void {
	const origPlatform = process.platform;
	const origEnv = { ...process.env };

	Object.defineProperty(process, "platform", {
		value: platform,
		configurable: true,
	});
	Object.assign(process.env, env);
	for (const [k, v] of Object.entries(env)) {
		if (v === undefined) delete process.env[k];
	}

	try {
		fn();
	} finally {
		Object.defineProperty(process, "platform", {
			value: origPlatform,
			configurable: true,
		});
		for (const k of Object.keys(process.env)) {
			if (!(k in origEnv)) delete process.env[k];
		}
		Object.assign(process.env, origEnv);
	}
}

describe("isDisplayAvailable", () => {
	it("returns true on macOS regardless of DISPLAY", () => {
		withEnv("darwin", { DISPLAY: undefined, WAYLAND_DISPLAY: undefined }, () => {
			expect(isDisplayAvailable()).toBe(true);
		});
	});

	it("returns true on Windows", () => {
		withEnv("win32", { DISPLAY: undefined, WAYLAND_DISPLAY: undefined }, () => {
			expect(isDisplayAvailable()).toBe(true);
		});
	});

	it("returns true on Linux with DISPLAY set", () => {
		withEnv("linux", { DISPLAY: ":0", WAYLAND_DISPLAY: undefined }, () => {
			expect(isDisplayAvailable()).toBe(true);
		});
	});

	it("returns true on Linux with WAYLAND_DISPLAY set", () => {
		withEnv("linux", { DISPLAY: undefined, WAYLAND_DISPLAY: "wayland-0" }, () => {
			expect(isDisplayAvailable()).toBe(true);
		});
	});

	it("returns false on Linux with neither DISPLAY nor WAYLAND_DISPLAY", () => {
		withEnv("linux", { DISPLAY: undefined, WAYLAND_DISPLAY: undefined }, () => {
			expect(isDisplayAvailable()).toBe(false);
		});
	});

	it("returns false on Linux with empty DISPLAY", () => {
		withEnv("linux", { DISPLAY: "", WAYLAND_DISPLAY: undefined }, () => {
			expect(isDisplayAvailable()).toBe(false);
		});
	});

	it("returns true on Linux with both DISPLAY and WAYLAND_DISPLAY set", () => {
		withEnv("linux", { DISPLAY: ":0", WAYLAND_DISPLAY: "wayland-0" }, () => {
			expect(isDisplayAvailable()).toBe(true);
		});
	});
});
