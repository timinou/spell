import { describe, expect, it } from "bun:test";
import codingDomain from "../../../domain/coding/manifest";
import growthDomain from "../../../domain/growth/manifest";
import { resolveStartupRoute } from "../src/domain/startup";

describe("main domain startup behavior", () => {
	it("keeps the TUI as the default interactive surface for coding", () => {
		const route = resolveStartupRoute({
			displayAvailable: true,
			domainManifest: codingDomain,
			hasPipedInput: false,
		});

		expect(route).toEqual({ kind: "interactive-tui" });
	});

	it("auto-opens the growth QML surface for interactive sessions with a display", () => {
		const route = resolveStartupRoute({
			displayAvailable: true,
			domainManifest: growthDomain,
			hasPipedInput: false,
		});

		expect(route).toEqual({ kind: "interactive-qml" });
	});

	it("falls back to the TUI for growth when no display is available", () => {
		const route = resolveStartupRoute({
			displayAvailable: false,
			domainManifest: growthDomain,
			hasPipedInput: false,
		});

		expect(route).toEqual({ kind: "interactive-tui" });
	});

	it("keeps growth print sessions non-UI", () => {
		const route = resolveStartupRoute({
			displayAvailable: true,
			domainManifest: growthDomain,
			hasPipedInput: true,
		});

		expect(route).toEqual({ kind: "print", mode: "text" });
	});

	it("keeps growth rpc sessions non-UI", () => {
		const route = resolveStartupRoute({
			displayAvailable: true,
			domainManifest: growthDomain,
			hasPipedInput: false,
			mode: "rpc",
		});

		expect(route).toEqual({ kind: "rpc" });
	});

	it("preserves the explicit canvas display guard", () => {
		const route = resolveStartupRoute({
			canvas: "chat",
			displayAvailable: false,
			domainManifest: growthDomain,
			hasPipedInput: false,
		});

		expect(route).toEqual({ kind: "canvas-display-required" });
	});
});
