import { describe, expect, it } from "bun:test";
import * as crypto from "node:crypto";
import { verifyBearerToken, verifyHmac } from "../../src/http";

function signBody(body: string, secret: string): string {
	return `sha256=${crypto.createHmac("sha256", secret).update(body).digest("hex")}`;
}

describe("webhook auth", () => {
	it("accepts a valid HMAC signature", async () => {
		const body = '{"goal":"ship-it"}';
		const request = new Request("http://localhost/trigger/ship-it", {
			method: "POST",
			headers: { "X-Signature-256": signBody(body, "secret") },
			body,
		});
		expect(await verifyHmac(request, body, "secret")).toBe(true);
	});

	it("rejects an invalid HMAC signature", async () => {
		const body = '{"goal":"ship-it"}';
		const request = new Request("http://localhost/trigger/ship-it", {
			method: "POST",
			headers: { "X-Signature-256": signBody(body, "wrong") },
			body,
		});
		expect(await verifyHmac(request, body, "secret")).toBe(false);
	});

	it("accepts a valid bearer token", () => {
		const request = new Request("http://localhost/trigger/ship-it", {
			headers: { Authorization: "Bearer token-123" },
		});
		expect(verifyBearerToken(request, "ship-it", { "ship-it": "token-123" })).toBe(true);
	});

	it("rejects requests missing a signature", async () => {
		const request = new Request("http://localhost/trigger/ship-it", { method: "POST", body: "{}" });
		expect(await verifyHmac(request, "{}", "secret")).toBe(false);
	});
});
