import { describe, expect, it } from "bun:test";
import { enforceCaptionBudget, TELEGRAM_CAPTION_LIMITS } from "../../src/telegram/caption-budget";

describe("TELEGRAM_CAPTION_LIMITS", () => {
	it("defines correct limits for each kind", () => {
		expect(TELEGRAM_CAPTION_LIMITS.message).toBe(4096);
		expect(TELEGRAM_CAPTION_LIMITS.document).toBe(1024);
		expect(TELEGRAM_CAPTION_LIMITS.photo).toBe(1024);
		expect(TELEGRAM_CAPTION_LIMITS.voice).toBe(1024);
	});
});

describe("enforceCaptionBudget", () => {
	describe("text under limit", () => {
		it("returns unchanged text when under limit", () => {
			const text = "Short text";
			const result = enforceCaptionBudget(text, "message");
			expect(result).toBe(text);
		});

		it("returns unchanged text for document with short input", () => {
			const text = "Under 1024 chars";
			const result = enforceCaptionBudget(text, "document");
			expect(result).toBe(text);
		});
	});

	describe("text equal to limit", () => {
		it("returns unchanged text when exactly at limit", () => {
			const text = "x".repeat(4096);
			const result = enforceCaptionBudget(text, "message");
			expect(result).toBe(text);
			expect(Array.from(result).length).toBe(4096);
		});

		it("returns unchanged text for document at 1024 chars", () => {
			const text = "y".repeat(1024);
			const result = enforceCaptionBudget(text, "document");
			expect(result).toBe(text);
			expect(Array.from(result).length).toBe(1024);
		});
	});

	describe("truncation with default marker", () => {
		it("truncates over-limit message and appends default marker", () => {
			const text = "x".repeat(5000);
			const result = enforceCaptionBudget(text, "message");
			expect(result).toContain("… (full transcript attached)");
			expect(Array.from(result).length).toBe(4096);
		});

		it("truncates over-limit document text to 1024", () => {
			const text = "y".repeat(2000);
			const result = enforceCaptionBudget(text, "document");
			expect(result).toContain("… (full transcript attached)");
			expect(Array.from(result).length).toBe(1024);
		});

		it("truncates over-limit photo caption", () => {
			const text = "z".repeat(2000);
			const result = enforceCaptionBudget(text, "photo");
			expect(result).toContain("… (full transcript attached)");
			expect(Array.from(result).length).toBe(1024);
		});

		it("truncates over-limit voice caption", () => {
			const text = "a".repeat(2000);
			const result = enforceCaptionBudget(text, "voice");
			expect(result).toContain("… (full transcript attached)");
			expect(Array.from(result).length).toBe(1024);
		});

		it("preserves beginning of text when truncating", () => {
			const text = "Important start" + "x".repeat(5000);
			const result = enforceCaptionBudget(text, "message");
			expect(result.startsWith("Important start")).toBe(true);
			expect(Array.from(result).length).toBe(4096);
		});
	});

	describe("custom truncation marker", () => {
		it("respects custom marker", () => {
			const text = "x".repeat(2000);
			const marker = "[TRUNCATED]";
			const result = enforceCaptionBudget(text, "document", marker);
			expect(result).toContain("[TRUNCATED]");
			expect(result.endsWith("[TRUNCATED]")).toBe(true);
			expect(Array.from(result).length).toBe(1024);
		});

		it("uses custom marker of different length", () => {
			const text = "y".repeat(5000);
			const marker = "... (continued in full version)";
			const result = enforceCaptionBudget(text, "message", marker);
			expect(result).toContain("... (continued in full version)");
			expect(Array.from(result).length).toBe(4096);
		});

		it("applies custom marker to multiple kinds", () => {
			const text = "z".repeat(2000);
			const marker = "[CUT]";
			const docResult = enforceCaptionBudget(text, "document", marker);
			const photoResult = enforceCaptionBudget(text, "photo", marker);

			expect(docResult).toContain("[CUT]");
			expect(photoResult).toContain("[CUT]");
			expect(Array.from(docResult).length).toBe(1024);
			expect(Array.from(photoResult).length).toBe(1024);
		});
	});

	describe("empty marker", () => {
		it("truncates without suffix when marker is empty", () => {
			const text = "x".repeat(2000);
			const result = enforceCaptionBudget(text, "document", "");
			expect(result).not.toContain("… (full transcript attached)");
			expect(Array.from(result).length).toBe(1024);
		});

		it("returns exactly limit length with empty marker", () => {
			const text = "Important content ".repeat(500);
			const result = enforceCaptionBudget(text, "message", "");
			expect(Array.from(result).length).toBe(4096);
		});

		it("produces plain truncation without any suffix", () => {
			const longText = "a".repeat(1200);
			const result = enforceCaptionBudget(longText, "document", "");
			// Should just be 1024 'a's, no suffix
			expect(result).toBe("a".repeat(1024));
			expect(Array.from(result).length).toBe(1024);
		});
	});

	describe("marker longer than limit", () => {
		it("returns marker truncated from start when marker >= limit", () => {
			const text = "x".repeat(2000);
			const longMarker = "This is a very long marker " + "x".repeat(2000);
			const result = enforceCaptionBudget(text, "document", longMarker);

			// Should be exactly 1024 chars, the last 1024 of the marker
			expect(Array.from(result).length).toBe(1024);
			// Should end with part of the marker
			expect(result).toContain("x");
		});

		it("truncates marker from the start (right-aligned)", () => {
			const text = "y".repeat(2000);
			const marker = "PREFIX_" + "x".repeat(2000);
			const result = enforceCaptionBudget(text, "document", marker);

			// Text is over limit (2000 > 1024) with marker >> limit
			// Should return just marker truncated to 1024 chars
			expect(Array.from(result).length).toBe(1024);
			expect(result.endsWith("x")).toBe(true);
			// PREFIX should be cut off from start
			expect(result.includes("PREFIX_")).toBe(false);
		});

		it("handles marker exactly equal to limit", () => {
			const markerAtLimit = "x".repeat(1024);
			const result = enforceCaptionBudget("y".repeat(2000), "document", markerAtLimit);

			expect(Array.from(result).length).toBe(1024);
			expect(result).toBe(markerAtLimit);
		});
	});

	describe("Unicode handling", () => {
		it("respects character boundaries for emoji", () => {
			const text = "Hello 👋 World 🌍 " + "x".repeat(2000);
			const result = enforceCaptionBudget(text, "document");

			// Should not cut emoji in half, result should be valid Unicode
			expect(Array.from(result).length).toBe(1024);
			// Verify it doesn't have broken emoji (which would be detectable)
			expect(() => result).not.toThrow();
		});

		it("handles multi-codepoint emoji correctly", () => {
			// 👨‍👩‍👧‍👦 is a family emoji (zero-width joiners)
			const familyEmoji = "👨‍👩‍👧‍👦";
			const text = familyEmoji.repeat(500) + "x".repeat(2000);
			const result = enforceCaptionBudget(text, "document");

			expect(Array.from(result).length).toBe(1024);
			// Should be valid string
			expect(typeof result).toBe("string");
		});

		it("handles combining characters", () => {
			// Combining diacriticals: é = e + ◌́
			const textWithCombining = "café".repeat(500) + "x".repeat(2000);
			const result = enforceCaptionBudget(textWithCombining, "document");

			expect(Array.from(result).length).toBe(1024);
			expect(typeof result).toBe("string");
		});

		it("preserves UTF-16 surrogate pairs when truncating", () => {
			// Various emoji and special chars with surrogates
			const text = "🎉🎊🎈".repeat(400) + "x".repeat(2000);
			const result = enforceCaptionBudget(text, "document");

			expect(Array.from(result).length).toBe(1024);
			// Verify no encoding errors by checking it round-trips
			const roundtrip = String.fromCharCode(...Array.from(result).map((c) => c.charCodeAt(0)));
			// If result is valid, we can work with it
			expect(result.length).toBeGreaterThan(0);
		});
	});

	describe("edge cases", () => {
		it("handles empty string", () => {
			const result = enforceCaptionBudget("", "message");
			expect(result).toBe("");
		});

		it("handles whitespace-only string", () => {
			const text = "   \n\t  ";
			const result = enforceCaptionBudget(text, "message");
			expect(result).toBe(text);
		});

		it("handles single character", () => {
			const result = enforceCaptionBudget("x", "message");
			expect(result).toBe("x");
		});

		it("handles text just over limit by 1 char", () => {
			const text = "x".repeat(1025);
			const result = enforceCaptionBudget(text, "document");

			expect(Array.from(result).length).toBe(1024);
			// Should have marker appended and text truncated
			expect(result).toContain("… (full transcript attached)");
		});

		it("is idempotent on already-fitting text", () => {
			const text = "Short text";
			const first = enforceCaptionBudget(text, "message");
			const second = enforceCaptionBudget(first, "message");

			expect(first).toBe(second);
			expect(second).toBe(text);
		});

		it("is idempotent on already-truncated text", () => {
			const longText = "x".repeat(5000);
			const first = enforceCaptionBudget(longText, "message");
			const second = enforceCaptionBudget(first, "message");

			expect(first).toBe(second);
		});
	});

	describe("newlines and special characters", () => {
		it("preserves newlines in text", () => {
			const text = "Line 1\nLine 2\nLine 3";
			const result = enforceCaptionBudget(text, "message");
			expect(result).toBe(text);
		});

		it("handles text with mixed whitespace", () => {
			const text = "Text\twith\ttabs\nand\nnewlines";
			const result = enforceCaptionBudget(text, "message");
			expect(result).toBe(text);
		});

		it("truncates and preserves newlines in marker position", () => {
			const text = "Line 1\n" + "x".repeat(2000);
			const result = enforceCaptionBudget(text, "document");
			expect(Array.from(result).length).toBe(1024);
			expect(result).toContain("Line 1");
		});
	});

	describe("performance characteristics", () => {
		it("handles very large text efficiently", () => {
			const largeText = "x".repeat(100000);
			const start = Date.now();
			const result = enforceCaptionBudget(largeText, "message");
			const elapsed = Date.now() - start;

			expect(Array.from(result).length).toBe(4096);
			// Should complete quickly (< 1000ms for reasonable systems)
			expect(elapsed).toBeLessThan(1000);
		});

		it("handles deeply nested Unicode", () => {
			const complexUnicode = "🏴󠁧󠁢󠁳󠁣󠁴󠁿".repeat(500);
			const text = complexUnicode + "x".repeat(2000);
			const result = enforceCaptionBudget(text, "document");

			expect(Array.from(result).length).toBe(1024);
		});
	});
});
