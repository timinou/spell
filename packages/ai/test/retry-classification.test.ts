import { describe, expect, it } from "bun:test";
import { isRetryableError } from "@spell/pi-ai/utils/retry";

// BUG-493: reported incident — a raw Codex `error` event with `code=server_error`
// reached the user without being retried because the session-level backstop
// classifier only recognized phrase patterns ("server error"), not the
// underlying provider error code / OS-level connection failures. This test
// pins the exact reported string plus the broader gap table so regressions
// are caught before they reach production again.
describe("isRetryableError — BUG-493 retry classification gaps", () => {
	it("retries the exact reported Codex server_error incident", () => {
		const message =
			"Codex error event: An error occurred while processing your request. You can retry your " +
			"request, or contact us through our help center at help.openai.com if the error persists. " +
			"Please include the request ID 4c5a67ac-7cc9-4e41-a6db-28e82c9f72cd in your message. " +
			"(code=server_error)";
		expect(isRetryableError(new Error(message))).toBe(true);
	});

	it("retries provider-declared transient error codes", () => {
		expect(isRetryableError(new Error("Codex error event (code=server_error)"))).toBe(true);
		expect(isRetryableError(new Error("Codex error event (code=model_error)"))).toBe(true);
		expect(isRetryableError(new Error("Codex response failed (code=internal_error)"))).toBe(true);
	});

	it("retries transient wording independent of status/code", () => {
		expect(isRetryableError(new Error("Please retry your request shortly"))).toBe(true);
		expect(isRetryableError(new Error("The service is temporarily unavailable"))).toBe(true);
	});

	it("retries HTTP timeout/edge/overload statuses", () => {
		expect(isRetryableError(new Error("Request failed with status 408 Request Timeout"))).toBe(true);
		expect(isRetryableError(new Error("Error 520: web server is returning an unknown error"))).toBe(true);
		expect(isRetryableError(new Error("Error 522: connection timed out"))).toBe(true);
		expect(isRetryableError(new Error("Error 524: a timeout occurred"))).toBe(true);
		expect(isRetryableError(new Error("status 529"))).toBe(true);
		expect(isRetryableError(new Error("server is Overloaded (529)"))).toBe(true);
	});

	it("retries OS-level connection failures", () => {
		expect(isRetryableError(new Error("read ECONNRESET"))).toBe(true);
		expect(isRetryableError(new Error("socket hang up"))).toBe(true);
		expect(isRetryableError(new Error("connect ETIMEDOUT"))).toBe(true);
		expect(isRetryableError(new Error("getaddrinfo EAI_AGAIN api.openai.com"))).toBe(true);
	});

	it("still retries the previously-working transient classes", () => {
		expect(isRetryableError(new Error("429 too many requests"))).toBe(true);
		expect(isRetryableError(new Error("503 Service Unavailable"))).toBe(true);
		expect(isRetryableError(new Error("server error"))).toBe(true);
		expect(isRetryableError(new Error("internal error"))).toBe(true);
	});

	it("does NOT retry auth / user-input 4xx errors", () => {
		expect(isRetryableError(new Error("401 Unauthorized: invalid api key"))).toBe(false);
		expect(isRetryableError(new Error("403 Forbidden"))).toBe(false);
		expect(isRetryableError(new Error("400 Bad Request: missing field 'foo'"))).toBe(false);
		expect(isRetryableError(new Error("Error 404: model not found"))).toBe(false);
		expect(isRetryableError(new Error("422 Unprocessable Entity: schema validation failed"))).toBe(false);
	});
});
