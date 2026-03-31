import { describe, expect, test } from "bun:test";
import { extractIdLinks, parseSubOutlineId } from "../src";
import { CUSTOM_ID_REGEXP } from "../src/schema/defaults";

describe("CUSTOM_ID_REGEXP with sub-outline IDs", () => {
	test("validates FEAT-001::define-types", () => {
		expect(CUSTOM_ID_REGEXP.test("FEAT-001::define-types")).toBe(true);
	});

	test("validates PROJ-007::schema", () => {
		expect(CUSTOM_ID_REGEXP.test("PROJ-007::schema")).toBe(true);
	});

	test("rejects FEAT-001:: (empty slug)", () => {
		expect(CUSTOM_ID_REGEXP.test("FEAT-001::")).toBe(false);
	});

	test("rejects ::define-types (no parent prefix)", () => {
		expect(CUSTOM_ID_REGEXP.test("::define-types")).toBe(false);
	});

	test("still validates FEAT-001 (top-level)", () => {
		expect(CUSTOM_ID_REGEXP.test("FEAT-001")).toBe(true);
	});

	test("still validates FEAT-001-add-auth (with slug)", () => {
		expect(CUSTOM_ID_REGEXP.test("FEAT-001-add-auth")).toBe(true);
	});
});

describe("extractIdLinks with sub-outline IDs", () => {
	test("extracts FEAT-001::define-types from link", () => {
		expect(extractIdLinks("see [[id:FEAT-001::define-types]]")).toEqual(["FEAT-001::define-types"]);
	});

	test("extracts both top-level and sub-outline from mixed text", () => {
		const text = "depends on [[id:FEAT-001]] and [[id:FEAT-001::define-types]]";
		expect(extractIdLinks(text)).toEqual(["FEAT-001", "FEAT-001::define-types"]);
	});
});

describe("parseSubOutlineId", () => {
	test("returns parts for FEAT-001::define-types", () => {
		expect(parseSubOutlineId("FEAT-001::define-types")).toEqual({
			parentId: "FEAT-001",
			subSlug: "define-types",
		});
	});

	test("returns null for top-level FEAT-001", () => {
		expect(parseSubOutlineId("FEAT-001")).toBeNull();
	});

	test("returns null for empty slug FEAT-001::", () => {
		expect(parseSubOutlineId("FEAT-001::")).toBeNull();
	});
});
