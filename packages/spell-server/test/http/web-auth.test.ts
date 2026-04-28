import { describe, expect, it } from "bun:test";
import type { WebConfig } from "../../src/config/types";
import { verifyWebToken } from "../../src/http/auth";

function makeWeb(entries: Array<[string, string]>): WebConfig {
	return { tokens: new Map(entries) };
}

function makeRequest(opts: { url?: string; auth?: string }): Request {
	const headers = new Headers();
	if (opts.auth !== undefined) headers.set("Authorization", opts.auth);
	return new Request(opts.url ?? "http://localhost:8787/web/api/sessions", { headers });
}

describe("verifyWebToken", () => {
	const web = makeWeb([
		["alice", "secret-a"],
		["bob", "secret-b"],
	]);

	it("returns identity on valid bearer header", () => {
		const id = verifyWebToken(makeRequest({ auth: "Bearer secret-a" }), web);
		expect(id).toEqual({ name: "alice" });
	});

	it("returns identity on valid query token (header absent)", () => {
		const id = verifyWebToken(makeRequest({ url: "http://localhost:8787/web/ws?token=secret-b" }), web);
		expect(id).toEqual({ name: "bob" });
	});

	it("prefers header over query when both are present", () => {
		const id = verifyWebToken(
			makeRequest({
				url: "http://localhost:8787/web/ws?token=secret-b",
				auth: "Bearer secret-a",
			}),
			web,
		);
		expect(id).toEqual({ name: "alice" });
	});

	it("returns null on invalid token", () => {
		expect(verifyWebToken(makeRequest({ auth: "Bearer nope" }), web)).toBeNull();
	});

	it("returns null when neither header nor query is present", () => {
		expect(verifyWebToken(makeRequest({}), web)).toBeNull();
	});

	it("returns null when header is whitespace-only after Bearer prefix", () => {
		expect(verifyWebToken(makeRequest({ auth: "Bearer    " }), web)).toBeNull();
	});

	it("returns null when web subsystem is undefined", () => {
		expect(verifyWebToken(makeRequest({ auth: "Bearer secret-a" }), undefined)).toBeNull();
	});

	it("rejects token of different length without leaking length difference", () => {
		// Should not throw regardless of length disparity.
		expect(verifyWebToken(makeRequest({ auth: "Bearer s" }), web)).toBeNull();
		expect(verifyWebToken(makeRequest({ auth: "Bearer this-is-much-longer-than-any-secret" }), web)).toBeNull();
	});

	it("returns first lex-sorted name when two tokens share the same secret", () => {
		const ambiguous = makeWeb([
			["bob", "shared"],
			["alice", "shared"],
		]);
		const id = verifyWebToken(makeRequest({ auth: "Bearer shared" }), ambiguous);
		expect(id?.name).toBe("alice");
	});
});
