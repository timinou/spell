import { describe, expect, it } from "bun:test";
import { type AutonomyManifest, parseManifestKdl, serializeManifestKdl } from "../../src/manifest";

const FIXTURES_DIR = new URL("./fixtures/", import.meta.url);

async function readFixture(name: string): Promise<string> {
	return Bun.file(new URL(name, FIXTURES_DIR)).text();
}

function normalizeManifest(manifest: AutonomyManifest) {
	return {
		name: manifest.name,
		version: manifest.version,
		setups: [...manifest.setups.entries()],
		goals: [...manifest.goals.entries()],
	};
}

describe("parseManifestKdl", () => {
	it("parses minimal manifest fields", async () => {
		const manifest = parseManifestKdl(await readFixture("minimal.kdl"));
		expect(manifest.name).toBe("spell-minimal");
		expect(manifest.version).toBe("1.0");
		expect(manifest.setups.get("readonly-reviewer")).toEqual({ domain: "coding" });
		expect(manifest.goals.get("nightly-tests")).toEqual({
			setup: "readonly-reviewer",
			schedule: { type: "cron", expression: "0 2 * * *", timezone: undefined, jitter: undefined },
			prompt: "Run the full test suite.",
			hooks: undefined,
			state: undefined,
			retry: undefined,
		});
	});

	it("parses full manifest hooks, state, sandbox, and filters", async () => {
		const manifest = parseManifestKdl(await readFixture("full.kdl"));
		const setup = manifest.setups.get("readonly-reviewer");
		const nightly = manifest.goals.get("nightly-tests");
		expect(setup).toEqual({
			domain: "coding",
			mode: "reviewer",
			skills: { allow: ["coding", "qml-testing"], deny: ["voice-agent"] },
			tools: { allow: ["read", "grep", "find"], deny: ["bash"] },
			sandbox: {
				pathsWrite: ["src/", "test/"],
				bashAllow: ["bun test*", "git status"],
				bashDeny: ["rm -rf*"],
			},
			timeout: "30m",
			maxCostUsd: 12.5,
		});
		expect(nightly?.schedule).toEqual({
			type: "cron",
			expression: "0 2 * * *",
			timezone: "UTC",
			jitter: "5m",
		});
		expect(nightly?.prompt).toContain("café");
		expect(nightly?.hooks).toEqual({
			onSuccess: [
				{ type: "webhook", url: "https://hooks.slack.com/services/T000/B000/Ü", method: "POST" },
				{ type: "org", category: "AUTONOMY" },
			],
			onFailure: [{ type: "telegram", chatId: 12345 }],
			onComplete: [{ type: "webhook", url: "https://example.com/complete", method: "GET" }],
		});
		expect(nightly?.state).toEqual({
			persist: true,
			schema: [
				{ name: "summary", type: "string" },
				{ name: "metrics", type: "json" },
			],
		});
		expect(nightly?.retry).toEqual({ maxRetries: 3, initialDelayMs: 1000, multiplier: 2 });
	});

	it("rejects missing name", async () => {
		await expect(async () => parseManifestKdl(await readFixture("invalid-missing-name.kdl"))).toThrow(/name/);
	});

	it("rejects missing version", async () => {
		await expect(async () => parseManifestKdl(await readFixture("invalid-missing-version.kdl"))).toThrow(/version/);
	});

	it("rejects bad setup reference", async () => {
		await expect(async () => parseManifestKdl(await readFixture("invalid-setup-ref.kdl"))).toThrow(/Unknown setup/);
	});

	it("rejects invalid cron", async () => {
		await expect(async () => parseManifestKdl(await readFixture("invalid-cron.kdl"))).toThrow(
			/Invalid value for minute/,
		);
	});

	it("rejects duplicate setup names", () => {
		const input = `name "dup"\nversion "1.0"\nsetup "a" { domain "coding" }\nsetup "a" { domain "coding" }\ngoal "g" {\n\tsetup "a"\n\tschedule type="cron" expression="0 1 * * *"\n\tprompt "x"\n}\n`;
		expect(() => parseManifestKdl(input)).toThrow(/Duplicate setup/);
	});

	it("rejects duplicate goal names", () => {
		const input = `name "dup"\nversion "1.0"\nsetup "a" { domain "coding" }\ngoal "g" {\n\tsetup "a"\n\tschedule type="cron" expression="0 1 * * *"\n\tprompt "x"\n}\ngoal "g" {\n\tsetup "a"\n\tschedule type="cron" expression="0 2 * * *"\n\tprompt "y"\n}\n`;
		expect(() => parseManifestKdl(input)).toThrow(/Duplicate goal/);
	});

	it("parses webhook schedule", async () => {
		const manifest = parseManifestKdl(await readFixture("webhook-schedule.kdl"));
		expect(manifest.goals.get("incoming-webhook")?.schedule).toEqual({
			type: "webhook",
			path: "/incoming",
			auth: "bearer",
		});
	});

	it("round-trips via serializer", async () => {
		const original = parseManifestKdl(await readFixture("full.kdl"));
		const rendered = serializeManifestKdl(original);
		const reparsed = parseManifestKdl(rendered);
		expect(normalizeManifest(reparsed)).toEqual(normalizeManifest(original));
	});

	it("parses state with persist and schema columns", () => {
		const manifest = parseManifestKdl(
			`name "stateful"\nversion "1.0"\nsetup "a" { domain "coding" }\ngoal "g" {\n\tsetup "a"\n\tschedule type="cron" expression="0 1 * * *"\n\tprompt "ok"\n\tstate persist=#true {\n\t\tschema "enabled" type="boolean"\n\t\tschema "count" type="number"\n\t}\n}\n`,
		);
		expect(manifest.goals.get("g")?.state).toEqual({
			persist: true,
			schema: [
				{ name: "enabled", type: "boolean" },
				{ name: "count", type: "number" },
			],
		});
	});

	it("parses sandbox config and tool filter config", () => {
		const manifest = parseManifestKdl(
			`name "sandbox"\nversion "1.0"\nsetup "a" {\n\tdomain "coding"\n\ttools {\n\t\tallow "read" "find"\n\t\tdeny "bash"\n\t}\n\tsandbox {\n\t\tpaths-write "src/"\n\t\tbash-allow "bun test*"\n\t\tbash-deny "rm -rf*"\n\t}\n}\ngoal "g" {\n\tsetup "a"\n\tschedule type="cron" expression="0 1 * * *"\n\tprompt "ok"\n}\n`,
		);
		expect(manifest.setups.get("a")?.tools).toEqual({ allow: ["read", "find"], deny: ["bash"] });
		expect(manifest.setups.get("a")?.sandbox).toEqual({
			pathsWrite: ["src/"],
			bashAllow: ["bun test*"],
			bashDeny: ["rm -rf*"],
		});
	});
});
