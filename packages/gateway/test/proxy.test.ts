import { describe, expect, test } from "bun:test";
import { extractAlias } from "../src/proxy";

describe("proxy", () => {
	describe("extractAlias", () => {
		test("extracts alias from Host header", () => {
			expect(extractAlias("myapp.localhost")).toBe("myapp");
			expect(extractAlias("api.localhost")).toBe("api");
			expect(extractAlias("my-service.localhost")).toBe("my-service");
		});

		test("strips port from Host header", () => {
			expect(extractAlias("myapp.localhost:443")).toBe("myapp");
			expect(extractAlias("myapp.localhost:8443")).toBe("myapp");
		});

		test("returns null for non-.localhost hosts", () => {
			expect(extractAlias("example.com")).toBeNull();
			expect(extractAlias("localhost")).toBeNull();
			expect(extractAlias("app.example.com")).toBeNull();
		});

		test("returns null for null/empty input", () => {
			expect(extractAlias(null)).toBeNull();
			expect(extractAlias("")).toBeNull();
		});

		test("returns null for bare .localhost", () => {
			expect(extractAlias(".localhost")).toBeNull();
		});
	});
});
