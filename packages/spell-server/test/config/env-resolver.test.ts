import { describe, expect, it } from "bun:test";
import {
	type EnvReferenceInfo,
	type EnvValidationResult,
	formatEnvReport,
	parseEnvReference,
	resolveEnvString,
	resolveEnvValue,
	scanEnvReferences,
	splitEnvTokens,
	validateEnvReferences,
} from "../../src/config/env-resolver";

describe("splitEnvTokens", () => {
	it("splits simple tokens", () => {
		expect(splitEnvTokens("FOO, default=bar")).toEqual(["FOO", "default=bar"]);
	});

	it("respects quoted strings with commas", () => {
		expect(splitEnvTokens('FOO, default="a,b"')).toEqual(["FOO", 'default="a,b"']);
	});

	it("returns single token", () => {
		expect(splitEnvTokens("FOO")).toEqual(["FOO"]);
	});

	it("trims whitespace", () => {
		expect(splitEnvTokens("  FOO , default=bar  ")).toEqual(["FOO", "default=bar"]);
	});
});

describe("parseEnvReference", () => {
	it("parses simple env(NAME)", () => {
		const ref = parseEnvReference("env(FOO)");
		expect(ref).toEqual({ name: "FOO", optional: false });
	});

	it("parses env(NAME, default=value)", () => {
		const ref = parseEnvReference("env(FOO, default=bar)");
		expect(ref).toEqual({ name: "FOO", optional: false, defaultValue: "bar" });
	});

	it("parses env(NAME, default=42) with numeric default", () => {
		const ref = parseEnvReference("env(PORT, default=42)");
		expect(ref).toEqual({ name: "PORT", optional: false, defaultValue: 42 });
	});

	it("parses env(NAME, type=number)", () => {
		const ref = parseEnvReference("env(PORT, type=number)");
		expect(ref).toEqual({ name: "PORT", optional: false, type: "number" });
	});

	it("parses env(NAME, optional)", () => {
		const ref = parseEnvReference("env(FOO, optional)");
		expect(ref).toEqual({ name: "FOO", optional: true });
	});

	it("returns null for non-env strings", () => {
		expect(parseEnvReference("just-a-string")).toBeNull();
		expect(parseEnvReference("notenv(FOO)")).toBeNull();
	});

	it("throws on empty env()", () => {
		expect(() => parseEnvReference("env()")).toThrow("env() requires a variable name");
	});

	it("throws on unsupported type", () => {
		expect(() => parseEnvReference("env(FOO, type=array)")).toThrow("Unsupported env() type: array");
	});
});

describe("resolveEnvValue", () => {
	it("resolves env(NAME) from env map", () => {
		const result = resolveEnvValue<string>("env(FOO)", "string", "test.field", { FOO: "bar" });
		expect(result).toBe("bar");
	});

	it("returns literal string as-is", () => {
		const result = resolveEnvValue<string>("literal", "string", "test.field", {});
		expect(result).toBe("literal");
	});

	it("resolves env(NAME, default=fallback) when missing", () => {
		const result = resolveEnvValue<string>("env(FOO, default=fallback)", "string", "test.field", {});
		expect(result).toBe("fallback");
	});

	it("resolves env(NAME, default=fallback) when present", () => {
		const result = resolveEnvValue<string>("env(FOO, default=fallback)", "string", "test.field", { FOO: "real" });
		expect(result).toBe("real");
	});

	it("throws on missing required env var", () => {
		expect(() => resolveEnvValue<string>("env(MISSING)", "string", "test.field", {})).toThrow(
			"test.field requires environment variable MISSING",
		);
	});

	it("coerces to number when expectedType is number", () => {
		const result = resolveEnvValue<number>("env(PORT)", "number", "test.port", { PORT: "8080" });
		expect(result).toBe(8080);
	});

	it("passes through literal number", () => {
		const result = resolveEnvValue<number>(3000, "number", "test.port", {});
		expect(result).toBe(3000);
	});

	it("throws on non-finite number", () => {
		expect(() => resolveEnvValue<number>("env(PORT)", "number", "test.port", { PORT: "abc" })).toThrow(
			"to resolve to a finite number",
		);
	});

	it("coerces to boolean", () => {
		const result = resolveEnvValue<boolean>("env(FLAG)", "boolean", "test.flag", { FLAG: "true" });
		expect(result).toBe(true);
	});
});

describe("resolveEnvString", () => {
	it("resolves env(NAME) for string fields", () => {
		expect(resolveEnvString("env(API_KEY)", "test.key", { API_KEY: "secret" })).toBe("secret"); // pragma: allowlist secret
	});

	it("returns literal string", () => {
		expect(resolveEnvString("literal", "test.key", {})).toBe("literal");
	});
});

describe("scanEnvReferences", () => {
	it("extracts env() refs from KDL text", () => {
		const kdl = `
http {
  port 8787
  auth {
    password "env(HTTP_PASSWORD)"
  }
  webhook-secret "env(WEBHOOK_SECRET)"
}`;
		const refs = scanEnvReferences(kdl, "server.kdl");
		expect(refs).toHaveLength(2);
		expect(refs[0]).toMatchObject({ name: "HTTP_PASSWORD", source: "server.kdl" });
		expect(refs[1]).toMatchObject({ name: "WEBHOOK_SECRET", source: "server.kdl" });
	});

	it("extracts refs with options", () => {
		const kdl = `max-cost "env(MAX_COST, type=number, default=10)"`;
		const refs = scanEnvReferences(kdl, "autonomy.kdl");
		expect(refs).toHaveLength(1);
		expect(refs[0]).toMatchObject({ name: "MAX_COST", defaultValue: 10, type: "number" });
	});

	it("skips KDL comment lines", () => {
		const kdl = `
// password "env(COMMENTED_OUT)"
password "env(REAL_PASSWORD)"`;
		const refs = scanEnvReferences(kdl, "test.kdl");
		expect(refs).toHaveLength(1);
		expect(refs[0].name).toBe("REAL_PASSWORD");
	});

	it("deduplicates within same source", () => {
		const kdl = `
stt-api-key "env(DEEPGRAM_KEY)"
tts-api-key "env(DEEPGRAM_KEY)"`;
		const refs = scanEnvReferences(kdl, "channels.kdl");
		expect(refs).toHaveLength(1);
	});

	it("returns empty for text with no env() refs", () => {
		expect(scanEnvReferences("port 8787", "test.kdl")).toEqual([]);
	});

	it("parses optional flag", () => {
		const kdl = `key "env(OPT_KEY, optional)"`;
		const refs = scanEnvReferences(kdl, "test.kdl");
		expect(refs[0].optional).toBe(true);
	});
});

describe("validateEnvReferences", () => {
	it("classifies loaded vars", () => {
		const refs: EnvReferenceInfo[] = [{ name: "FOO", optional: false, source: "test.kdl" }];
		const result = validateEnvReferences(refs, { FOO: "bar" });
		expect(result.loaded).toHaveLength(1);
		expect(result.missing).toHaveLength(0);
	});

	it("classifies missing vars", () => {
		const refs: EnvReferenceInfo[] = [{ name: "FOO", optional: false, source: "test.kdl" }];
		const result = validateEnvReferences(refs, {});
		expect(result.missing).toHaveLength(1);
		expect(result.loaded).toHaveLength(0);
	});

	it("classifies defaulted vars", () => {
		const refs: EnvReferenceInfo[] = [{ name: "FOO", optional: false, defaultValue: "bar", source: "test.kdl" }];
		const result = validateEnvReferences(refs, {});
		expect(result.defaulted).toHaveLength(1);
		expect(result.missing).toHaveLength(0);
	});

	it("classifies optional vars as defaulted", () => {
		const refs: EnvReferenceInfo[] = [{ name: "FOO", optional: true, source: "test.kdl" }];
		const result = validateEnvReferences(refs, {});
		expect(result.defaulted).toHaveLength(1);
	});

	it("deduplicates by name", () => {
		const refs: EnvReferenceInfo[] = [
			{ name: "FOO", optional: false, source: "a.kdl" },
			{ name: "FOO", optional: false, source: "b.kdl" },
		];
		const result = validateEnvReferences(refs, { FOO: "bar" });
		expect(result.loaded).toHaveLength(1);
	});

	it("treats empty string as missing", () => {
		const refs: EnvReferenceInfo[] = [{ name: "FOO", optional: false, source: "test.kdl" }];
		const result = validateEnvReferences(refs, { FOO: "" });
		expect(result.missing).toHaveLength(1);
	});
});

describe("formatEnvReport", () => {
	it("produces report with loaded and missing vars", () => {
		const result: EnvValidationResult = {
			loaded: [{ name: "HTTP_PASSWORD", optional: false, source: "server.kdl" }],
			defaulted: [{ name: "MAX_COST", optional: false, defaultValue: 10, source: "autonomy.kdl" }],
			missing: [{ name: "WEBHOOK_SECRET", optional: false, source: "server.kdl" }],
		};
		const report = formatEnvReport(result, "/home/user/.spell/.env");
		expect(report).toContain("HTTP_PASSWORD");
		expect(report).toContain("loaded");
		expect(report).toContain("MAX_COST");
		expect(report).toContain("default: 10");
		expect(report).toContain("WEBHOOK_SECRET");
		expect(report).toContain("MISSING");
		expect(report).toContain("required by server.kdl");
		expect(report).toContain("Add to /home/user/.spell/.env");
		expect(report).toContain("WEBHOOK_SECRET=");
	});

	it("produces compact report when all vars present", () => {
		const result: EnvValidationResult = {
			loaded: [{ name: "FOO", optional: false, source: "test.kdl" }],
			defaulted: [],
			missing: [],
		};
		const report = formatEnvReport(result, "/path/.env");
		expect(report).toContain("FOO");
		expect(report).toContain("loaded");
		expect(report).not.toContain("Error:");
	});
});
