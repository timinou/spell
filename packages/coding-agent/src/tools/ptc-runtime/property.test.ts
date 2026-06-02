/**
 * Property + fuzz tests for the Node side (P0').
 *
 * No external property-testing dependency: a small seeded PRNG drives many
 * generated inputs against the invariants. This keeps the supply surface flat
 * while still exercising the catalog generator's totality, the client's framing
 * robustness, and the policy gate's completeness over generated tools.
 */

import { describe, expect, it } from "bun:test";
import { type TSchema, Type } from "@sinclair/typebox";
import { type CatalogTool, generateToolCatalog, ptcType, schemaToSignature } from "./catalog-gen";
import { PtcRuntimeClient, type ToolCallHandler, type Transport } from "./client";
import { ALL_EFFECTS, type EffectTag, effectOf } from "./effects";
import { DEFAULT_POLICY, enforcePolicy, isAllowed, PERMISSIVE_POLICY, READONLY_POLICY } from "./policy";

// ---- seeded PRNG (mulberry32) ----
function rng(seed: number): () => number {
	let a = seed >>> 0;
	return () => {
		a |= 0;
		a = (a + 0x6d2b79f5) | 0;
		let t = Math.imul(a ^ (a >>> 15), 1 | a);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

const RUNS = 200;

// ---- random JSON-Schema-ish node generator ----
function randSchema(r: () => number, depth: number): TSchema {
	const pick = Math.floor(r() * (depth > 0 ? 8 : 5));
	switch (pick) {
		case 0:
			return Type.String();
		case 1:
			return Type.Integer();
		case 2:
			return Type.Number();
		case 3:
			return Type.Boolean();
		case 4:
			return Type.Any();
		case 5:
			return Type.Array(randSchema(r, depth - 1));
		case 6:
			return Type.Union([Type.Literal("a"), Type.Literal("b")]);
		default:
			return Type.Record(Type.String(), randSchema(r, depth - 1));
	}
}

describe("catalog generator totality (property)", () => {
	it("ptcType never throws and always returns a non-empty token", () => {
		const r = rng(0xc0ffee);
		for (let i = 0; i < RUNS; i++) {
			const schema = randSchema(r, 3) as unknown as Parameters<typeof ptcType>[0];
			const ty = ptcType(schema);
			expect(typeof ty).toBe("string");
			expect(ty.length).toBeGreaterThan(0);
		}
	});

	it("schemaToSignature always yields a parseable-shaped signature string", () => {
		const r = rng(0x1234);
		for (let i = 0; i < RUNS; i++) {
			const n = Math.floor(r() * 5);
			const props: Record<string, TSchema> = {};
			for (let k = 0; k < n; k++) {
				const optional = r() < 0.5;
				const s = randSchema(r, 2);
				props[`f${k}`] = optional ? Type.Optional(s) : s;
			}
			const sig = schemaToSignature(Type.Object(props));
			// Shape invariant: '(...) -> :any', balanced parens, and crucially NO
			// optional list form '[:t]?' (the bug Review Gate 2 caught).
			expect(sig).toMatch(/^\(.*\) -> :any$/);
			expect(sig).not.toMatch(/\]\?/);
		}
	});

	it("generateToolCatalog tags every tool with a known effect", () => {
		const r = rng(0x55);
		for (let i = 0; i < RUNS; i++) {
			const name = `tool_${Math.floor(r() * 1000)}`;
			const tools: CatalogTool[] = [{ name, parameters: Type.Object({ a: randSchema(r, 1) }) }];
			const [entry] = generateToolCatalog(tools);
			expect(ALL_EFFECTS).toContain(entry.effect);
		}
	});
});

describe("policy completeness (property)", () => {
	it("enforcePolicy is total: every tool name either resolves an allowed effect or throws", () => {
		const r = rng(0xabcd);
		const policies = [DEFAULT_POLICY, READONLY_POLICY, PERMISSIVE_POLICY];
		for (let i = 0; i < RUNS; i++) {
			const name = `t${Math.floor(r() * 100)}`;
			const policy = policies[Math.floor(r() * policies.length)];
			const effect = effectOf(name);
			expect(ALL_EFFECTS).toContain(effect);
			if (policy.allowed.has(effect)) {
				expect(enforcePolicy(name, policy)).toBe(effect);
			} else {
				expect(() => enforcePolicy(name, policy)).toThrow();
			}
		}
	});

	it("the default policy denies exec+network for every effect-tagged tool", () => {
		// Exhaustive over the taxonomy: exec/network always denied by default.
		const denied: EffectTag[] = ["exec", "network"];
		for (const e of denied) {
			expect(DEFAULT_POLICY.allowed.has(e)).toBe(false);
		}
		expect(isAllowed("bash", DEFAULT_POLICY)).toBe(false);
		expect(isAllowed("fetch", DEFAULT_POLICY)).toBe(false);
	});
});

// ---- a fuzzable in-memory transport ----
class FuzzTransport implements Transport {
	sent: string[] = [];
	private lineCb: ((l: string) => void) | null = null;
	private closeCb: ((i: { code: number | null; signal: string | null }) => void) | null = null;
	writeLine(l: string): void {
		this.sent.push(l);
	}
	onLine(cb: (l: string) => void): void {
		this.lineCb = cb;
	}
	onClose(cb: (i: { code: number | null; signal: string | null }) => void): void {
		this.closeCb = cb;
	}
	close(): void {
		this.closeCb?.({ code: 0, signal: null });
	}
	feed(line: string): void {
		this.lineCb?.(line);
	}
	lastId(): number | undefined {
		const last = this.sent.at(-1);
		return last ? (JSON.parse(last).id as number) : undefined;
	}
}

describe("client framing robustness (fuzz)", () => {
	it("arbitrary inbound lines never throw out of onData", () => {
		const r = rng(0xfeed);
		const noTool: ToolCallHandler = async () => null;
		for (let i = 0; i < RUNS; i++) {
			const t = new FuzzTransport();
			new PtcRuntimeClient({ transport: t, onToolCall: noTool, onWarn: () => {} });
			// Random bytes / partial JSON / valid-but-unexpected frames.
			const kind = Math.floor(r() * 4);
			const line =
				kind === 0
					? randString(r, 40)
					: kind === 1
						? `{"jsonrpc":"2.0","id":${Math.floor(r() * 99)}`
						: kind === 2
							? JSON.stringify({ jsonrpc: "2.0", id: Math.floor(r() * 99), method: randString(r, 6) })
							: JSON.stringify({ jsonrpc: "2.0", id: Math.floor(r() * 99), result: randString(r, 6) });
			// Must not throw.
			expect(() => t.feed(line)).not.toThrow();
		}
	});

	it("a response for an unknown id is dropped, not thrown", () => {
		let warned = 0;
		const t = new FuzzTransport();
		new PtcRuntimeClient({ transport: t, onToolCall: async () => null, onWarn: () => warned++ });
		t.feed(JSON.stringify({ jsonrpc: "2.0", id: 9999, result: 1 }));
		expect(warned).toBeGreaterThan(0);
	});
});

function randString(r: () => number, n: number): string {
	let s = "";
	for (let i = 0; i < n; i++) s += String.fromCharCode(32 + Math.floor(r() * 94));
	return s;
}
