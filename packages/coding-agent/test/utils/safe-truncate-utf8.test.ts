import { describe, expect, test } from "bun:test";
import { safeTruncateUtf8 } from "../../src/utils/safe-truncate-utf8";

describe("safeTruncateUtf8", () => {
	test("returns ASCII input unchanged below the byte cap", () => {
		const result = safeTruncateUtf8("plain ascii", 64);
		expect(result).toEqual({ text: "plain ascii", truncated: false });
	});

	test("truncates ASCII input exactly at the byte cap", () => {
		const result = safeTruncateUtf8("abcdefghij", 4);
		expect(result).toEqual({ text: "abcd", truncated: true });
		expect(Buffer.byteLength(result.text, "utf8")).toBe(4);
	});

	test("backs off to a valid UTF-8 boundary when the cap lands inside a multibyte code point", () => {
		const result = safeTruncateUtf8("ab🙂cd", 5);
		expect(result.truncated).toBe(true);
		expect(result.text).toBe("ab");
		expect(result.text).not.toContain("\uFFFD");
		expect(Buffer.byteLength(result.text, "utf8")).toBeLessThanOrEqual(5);
	});
});
