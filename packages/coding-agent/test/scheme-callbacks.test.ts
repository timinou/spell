/**
 * PLAN-310 W6: scheme-callbacks helpers.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { clearRuntimeSchemes, listRegisteredSchemes } from "@oh-my-pi/pi-natives";
import {
	RESERVED_NATIVE_SCHEMES,
	deriveSchemeFromServerName,
	registerScheme,
	unregisterScheme,
} from "../src/scheme-callbacks";

describe("deriveSchemeFromServerName", () => {
	it("lowercases", () => {
		expect(deriveSchemeFromServerName("Figma")).toBe("figma");
	});

	it("converts spaces to hyphens", () => {
		expect(deriveSchemeFromServerName("Notion MCP")).toBe("notion-mcp");
	});

	it("collapses consecutive non-alphanumeric runs", () => {
		expect(deriveSchemeFromServerName("foo!!@@bar")).toBe("foo-bar");
	});

	it("trims leading/trailing hyphens", () => {
		expect(deriveSchemeFromServerName("--alpha--beta--")).toBe("alpha-beta");
	});

	it("rejects empty result", () => {
		expect(() => deriveSchemeFromServerName("!!!")).toThrow();
	});

	it("rejects names that start with a digit", () => {
		expect(() => deriveSchemeFromServerName("123-svc")).toThrow();
	});
});

describe("RESERVED_NATIVE_SCHEMES coverage", () => {
	it("contains exactly the 9 kernel-owned schemes", () => {
		expect([...RESERVED_NATIVE_SCHEMES].sort()).toEqual(
			["agent", "artifact", "jobs", "local", "memory", "org", "pi", "rule", "skill"].sort(),
		);
	});
});

describe("registerScheme", () => {
	afterEach(() => {
		clearRuntimeSchemes();
	});

	const noopResolve = async (body: string) => ({ url: `test://${body}`, content: "ok" });

	it("rejects reserved native names", () => {
		const err = registerScheme("skill", noopResolve);
		expect(err).not.toBeNull();
		expect(err?.reason).toContain("reserved");
	});

	it("registers a fresh scheme successfully", () => {
		const err = registerScheme("custom-svc", noopResolve);
		expect(err).toBeNull();
		expect(listRegisteredSchemes()).toContain("custom-svc");
	});

	it("rejects duplicate registration", () => {
		expect(registerScheme("custom-dup", noopResolve)).toBeNull();
		const second = registerScheme("custom-dup", noopResolve);
		expect(second?.reason).toContain("already registered");
	});

	it("unregister removes a scheme", () => {
		registerScheme("svc-rm", noopResolve);
		expect(listRegisteredSchemes()).toContain("svc-rm");
		expect(unregisterScheme("svc-rm")).toBe(true);
		expect(listRegisteredSchemes()).not.toContain("svc-rm");
	});

	it("rejects invalid scheme name", () => {
		const err = registerScheme("Bad-Name", noopResolve);
		expect(err).not.toBeNull();
	});
});
