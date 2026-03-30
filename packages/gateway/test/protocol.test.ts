import { describe, expect, test } from "bun:test";
import { type GatewayRequest, isValidAlias, parseMessage, resolveSocketPath, serializeMessage } from "../src/protocol";

describe("protocol", () => {
	describe("isValidAlias", () => {
		test("accepts valid aliases", () => {
			expect(isValidAlias("myapp")).toBe(true);
			expect(isValidAlias("my-app")).toBe(true);
			expect(isValidAlias("app123")).toBe(true);
			expect(isValidAlias("a")).toBe(true);
			expect(isValidAlias("a-b-c")).toBe(true);
		});

		test("rejects invalid aliases", () => {
			expect(isValidAlias("")).toBe(false);
			expect(isValidAlias("UPPER")).toBe(false);
			expect(isValidAlias("-leading")).toBe(false);
			expect(isValidAlias("trailing-")).toBe(false);
			expect(isValidAlias("has space")).toBe(false);
			expect(isValidAlias("has.dot")).toBe(false);
			expect(isValidAlias("has_underscore")).toBe(false);
			// 64+ chars
			expect(isValidAlias("a".repeat(64))).toBe(false);
		});

		test("accepts 63-char alias (max DNS label)", () => {
			expect(isValidAlias("a".repeat(63))).toBe(true);
		});
	});

	describe("serializeMessage", () => {
		test("serializes request with trailing newline", () => {
			const msg: GatewayRequest = { id: "1", type: "list" };
			const serialized = serializeMessage(msg);
			expect(serialized.endsWith("\n")).toBe(true);
			expect(JSON.parse(serialized)).toEqual(msg);
		});

		test("serializes response", () => {
			const msg = { id: "1", ok: true as const, data: { services: [] } };
			const serialized = serializeMessage(msg);
			expect(JSON.parse(serialized)).toEqual(msg);
		});
	});

	describe("parseMessage", () => {
		test("parses valid NDJSON line", () => {
			const msg = parseMessage('{"id":"1","type":"list"}');
			expect(msg).toEqual({ id: "1", type: "list" });
		});

		test("handles trailing whitespace", () => {
			const msg = parseMessage('{"id":"1","type":"list"}  \n');
			expect(msg).toEqual({ id: "1", type: "list" });
		});

		test("returns null for empty line", () => {
			expect(parseMessage("")).toBeNull();
			expect(parseMessage("  ")).toBeNull();
		});

		test("returns null for malformed JSON", () => {
			expect(parseMessage("{not valid json")).toBeNull();
		});

		test("round-trips request/response", () => {
			const req: GatewayRequest = {
				id: "test-42",
				type: "register",
				config: { alias: "myapp", target: "http://127.0.0.1:3000" },
			};
			const serialized = serializeMessage(req);
			const parsed = parseMessage(serialized);
			expect(parsed).toEqual(req);
		});
	});

	describe("resolveSocketPath", () => {
		test("returns a non-empty string", () => {
			const socketPath = resolveSocketPath();
			expect(socketPath.length).toBeGreaterThan(0);
			expect(socketPath).toContain("spell-gateway");
		});
	});
});
