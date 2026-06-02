/**
 * Capability policy enforcement tests — the security gate.
 */

import { describe, expect, it } from "bun:test";
import type { AgentToolResult } from "@spell/pi-agent-core";
import {
	allowedTools,
	DEFAULT_POLICY,
	enforcePolicy,
	isAllowed,
	PERMISSIVE_POLICY,
	PolicyDeniedError,
	READONLY_POLICY,
} from "./policy";
import { type DispatchableTool, lookupFromMap, makeToolDispatcher } from "./tool-dispatch";

function fakeTool(name: string): DispatchableTool {
	return {
		name,
		async execute() {
			return { content: [{ type: "text", text: "ran" }] } as AgentToolResult;
		},
	};
}

describe("enforcePolicy", () => {
	it("permits read+write tools under the default policy", () => {
		expect(enforcePolicy("find", DEFAULT_POLICY)).toBe("read");
		expect(enforcePolicy("edit", DEFAULT_POLICY)).toBe("write");
		expect(enforcePolicy("calc", DEFAULT_POLICY)).toBe("pure");
	});

	it("denies exec and network under the default policy", () => {
		expect(() => enforcePolicy("bash", DEFAULT_POLICY)).toThrow(PolicyDeniedError);
		expect(() => enforcePolicy("task", DEFAULT_POLICY)).toThrow(PolicyDeniedError);
		expect(() => enforcePolicy("fetch", DEFAULT_POLICY)).toThrow(PolicyDeniedError);
		expect(() => enforcePolicy("web_search", DEFAULT_POLICY)).toThrow(PolicyDeniedError);
	});

	it("denies an unknown tool (defaults to exec) under the default policy", () => {
		expect(() => enforcePolicy("mystery", DEFAULT_POLICY)).toThrow(PolicyDeniedError);
	});

	it("read-only policy denies writes", () => {
		expect(enforcePolicy("find", READONLY_POLICY)).toBe("read");
		expect(() => enforcePolicy("edit", READONLY_POLICY)).toThrow(PolicyDeniedError);
		// memory writes (note/save/link) must be denied under read-only.
		expect(() => enforcePolicy("memory", READONLY_POLICY)).toThrow(PolicyDeniedError);
	});

	it("permissive policy allows everything", () => {
		for (const t of ["find", "edit", "bash", "task", "fetch", "calc", "mystery"]) {
			expect(() => enforcePolicy(t, PERMISSIVE_POLICY)).not.toThrow();
		}
	});

	it("PolicyDeniedError carries tool, effect, and policy name", () => {
		try {
			enforcePolicy("bash", DEFAULT_POLICY);
			throw new Error("should have thrown");
		} catch (e) {
			expect(e).toBeInstanceOf(PolicyDeniedError);
			const pe = e as PolicyDeniedError;
			expect(pe.tool).toBe("bash");
			expect(pe.effect).toBe("exec");
			expect(pe.policy).toBe("read-write");
		}
	});
});

describe("isAllowed / allowedTools", () => {
	it("filters a tool list to the policy-permitted subset", () => {
		const names = ["find", "edit", "bash", "fetch", "calc", "memory"];
		expect(allowedTools(names, DEFAULT_POLICY).sort()).toEqual(["calc", "edit", "find", "memory"]);
		expect(allowedTools(names, READONLY_POLICY).sort()).toEqual(["calc", "find"]);
	});

	it("isAllowed matches enforcePolicy", () => {
		expect(isAllowed("find", DEFAULT_POLICY)).toBe(true);
		expect(isAllowed("bash", DEFAULT_POLICY)).toBe(false);
	});
});

describe("policy enforcement in the dispatcher", () => {
	it("denies an exec tool at dispatch even if the lookup returns it", async () => {
		// A bash-like tool present in the lookup must still be policy-denied.
		const tools = new Map<string, DispatchableTool>([["bash", fakeTool("bash")]]);
		const dispatch = makeToolDispatcher({ lookup: lookupFromMap(tools), policy: DEFAULT_POLICY });
		await expect(dispatch({ tool: "bash", args: {} })).rejects.toBeInstanceOf(PolicyDeniedError);
	});

	it("allows a write tool under the default policy", async () => {
		const tools = new Map<string, DispatchableTool>([["edit", fakeTool("edit")]]);
		const dispatch = makeToolDispatcher({ lookup: lookupFromMap(tools), policy: DEFAULT_POLICY });
		await expect(dispatch({ tool: "edit", args: {} })).resolves.toBe("ran");
	});
});
