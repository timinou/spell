import { describe, expect, test } from "bun:test";
import { WAVE_REGEXP, WAVES_REGEXP } from "../src/schema/defaults";

describe("WAVE_REGEXP", () => {
	test("accepts valid single integers", () => {
		expect("1").toMatch(WAVE_REGEXP);
		expect("2").toMatch(WAVE_REGEXP);
		expect("10").toMatch(WAVE_REGEXP);
		expect("0").toMatch(WAVE_REGEXP);
		expect("999").toMatch(WAVE_REGEXP);
	});

	test("rejects invalid values", () => {
		expect("").not.toMatch(WAVE_REGEXP);
		expect("a").not.toMatch(WAVE_REGEXP);
		expect("1.5").not.toMatch(WAVE_REGEXP);
		expect("-1").not.toMatch(WAVE_REGEXP);
		expect("1,2").not.toMatch(WAVE_REGEXP);
		expect(" 1").not.toMatch(WAVE_REGEXP);
		expect("1 ").not.toMatch(WAVE_REGEXP);
	});
});

describe("WAVES_REGEXP", () => {
	test("accepts valid comma-separated integers", () => {
		expect("1").toMatch(WAVES_REGEXP);
		expect("1,2").toMatch(WAVES_REGEXP);
		expect("1,2,3").toMatch(WAVES_REGEXP);
		expect("0,10,200").toMatch(WAVES_REGEXP);
	});

	test("rejects invalid values", () => {
		expect("").not.toMatch(WAVES_REGEXP);
		expect("1,").not.toMatch(WAVES_REGEXP);
		expect(",1").not.toMatch(WAVES_REGEXP);
		expect("1,,2").not.toMatch(WAVES_REGEXP);
		expect("a,b").not.toMatch(WAVES_REGEXP);
		expect("1, 2").not.toMatch(WAVES_REGEXP);
		expect(",").not.toMatch(WAVES_REGEXP);
	});
});
