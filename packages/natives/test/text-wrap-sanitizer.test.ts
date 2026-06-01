/**
 * Boundary sanitizer for `wrapTextWithAnsi`.
 *
 * Defends against the lone-ESC infinite loop that pre-fix `pi-natives <= 15.5.13`
 * builds had in `break_long_word`. The source is fixed; this sanitizer is a JS
 * boundary so a stale binary (e.g. a published one that hasn't been refreshed
 * in the bun install cache) cannot deadlock the TUI render thread.
 */
import { describe, expect, test } from "bun:test";
import { wrapTextWithAnsi } from "@spell/pi-natives";

const ESC = "\x1b";

describe("wrapTextWithAnsi sanitizer", () => {
	test("ASCII long word still wraps without modification", () => {
		const lines = wrapTextWithAnsi("X".repeat(400), 8);
		expect(lines.length).toBe(50);
		expect(lines.every(l => l === "XXXXXXXX")).toBe(true);
	});

	test("trailing lone ESC in a long word: completes (was: infinite loop)", () => {
		const start = performance.now();
		const lines = wrapTextWithAnsi("X".repeat(400) + ESC, 8);
		expect(performance.now() - start).toBeLessThan(500);
		// Stripped ESC should leave wrapped output equivalent to plain ASCII.
		expect(lines.length).toBe(50);
	});

	test("interior lone ESC inside a long token: completes", () => {
		const start = performance.now();
		const lines = wrapTextWithAnsi("X".repeat(200) + ESC + "X".repeat(200), 8);
		expect(performance.now() - start).toBeLessThan(500);
		expect(lines.length).toBe(50);
	});

	test("valid CSI sequence inside a long word: NOT stripped", () => {
		// \x1b[31m + 400 X + \x1b[0m
		const styled = `${ESC}[31m${"X".repeat(400)}${ESC}[0m`;
		const lines = wrapTextWithAnsi(styled, 8);
		expect(lines.length).toBeGreaterThanOrEqual(50);
		// First line should retain the SGR code.
		expect(lines[0]).toContain(`${ESC}[31m`);
	});

	test("short token with lone ESC: NOT touched (under 32-char threshold)", () => {
		// Below the long-token threshold so the sanitizer doesn't intervene.
		// The native handles this gracefully (sibling functions all have the fallback).
		const lines = wrapTextWithAnsi(`hi${ESC}world`, 80);
		expect(lines.length).toBe(1);
	});

	test("ESC mixed in but no whitespace at all (single 1000-char token): completes", () => {
		const blob = `${"a".repeat(500)}${ESC}${"b".repeat(500)}`;
		const start = performance.now();
		const lines = wrapTextWithAnsi(blob, 80);
		expect(performance.now() - start).toBeLessThan(500);
		// 1000 ASCII chars wrapped at 80 wide = 13 lines
		expect(lines.length).toBe(13);
	});

	test("multiple bad words separated by spaces: each scrubbed independently", () => {
		const bad = `${"x".repeat(100)}${ESC} good ${"y".repeat(100)}${ESC}`;
		const start = performance.now();
		const lines = wrapTextWithAnsi(bad, 80);
		expect(performance.now() - start).toBeLessThan(500);
		expect(lines.length).toBeGreaterThan(0);
	});

	test("empty string is identity", () => {
		expect(wrapTextWithAnsi("", 80)).toEqual([""]);
	});

	test("no-ESC fast path returns natively-wrapped output", () => {
		const lines = wrapTextWithAnsi("hello world this is a normal sentence", 10);
		expect(lines.join(" ")).toBe("hello world this is a normal sentence");
	});
});
