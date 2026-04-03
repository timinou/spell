import { describe, expect, it } from "bun:test";
import { loadPersonaRegistry } from "../src/registries/persona-loader";

describe("persona registry", () => {
	it("parses personas, validates required fields, and preserves declaration order", () => {
		const personas = loadPersonaRegistry(`persona "ops" name="Ops" summary="Ops buyers" {
	goal "Reduce toil"
	challenge "Manual reporting"
	keyword "automation"
}
persona "finance" name="Finance" summary="Finance buyers" {
	goal "Visibility"
	challenge "Spreadsheet sprawl"
	keyword "forecasting"
}
`);
		expect(personas.map(persona => persona.slug)).toEqual(["ops", "finance"]);
		expect(() => loadPersonaRegistry(`persona "ops" name="" summary="Missing name" {}`)).toThrow(
			/missing required fields/i,
		);
		expect(() =>
			loadPersonaRegistry(`persona "ops" name="Ops" summary="A" {}
persona "ops" name="Ops 2" summary="B" {}`),
		).toThrow(/Duplicate persona slug/);
	});
});
