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
		exportTargets: manifest.exportTargets,
		notificationRoutes: manifest.notificationRoutes,
		reviewPolicies: manifest.reviewPolicies,
		checkpoints: manifest.checkpoints,
		panels: manifest.panels,
		layouts: manifest.layouts,
		syncCollections: manifest.syncCollections,
		stateSchemas: manifest.stateSchemas,
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
		expect(manifest.exportTargets).toEqual([]);
		expect(manifest.notificationRoutes).toEqual([]);
		expect(manifest.reviewPolicies).toEqual([]);
		expect(manifest.checkpoints).toEqual([]);
		expect(manifest.panels).toEqual([]);
		expect(manifest.layouts).toEqual([]);
		expect(manifest.syncCollections).toEqual([]);
		expect(manifest.stateSchemas).toEqual([]);
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
		await expect(async () => parseManifestKdl(await readFixture("invalid-cron.kdl"))).toThrow(/Invalid value for minute/);
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

	it("parses export-target nodes", () => {
		const manifest = parseManifestKdl(
			`name "exports"\nversion "1.0"\nsetup "a" { domain "coding" }\ngoal "g" {\n\tsetup "a"\n\tschedule type="cron" expression="0 1 * * *"\n\tprompt "ok"\n}\nexport-target "digest" kind="http" url="https://example.com/feed" format="json"\nexport-target "repo" kind="git-repo" path="out/content" format="md"\n`,
		);
		expect(manifest.exportTargets).toEqual([
			{ id: "digest", kind: "http", url: "https://example.com/feed", format: "json" },
			{ id: "repo", kind: "git-repo", path: "out/content", format: "md" },
		]);
	});

	it("parses notification-route nodes", () => {
		const manifest = parseManifestKdl(
			`name "routes"\nversion "1.0"\nsetup "a" { domain "coding" }\ngoal "g" {\n\tsetup "a"\n\tschedule type="cron" expression="0 1 * * *"\n\tprompt "ok"\n}\nnotification-route "ops" channel="telegram" on="failure" chat-id=12345\nnotification-route "audit" channel="webhook" on="complete" url="https://example.com/hook"\n`,
		);
		expect(manifest.notificationRoutes).toEqual([
			{ id: "ops", channel: "telegram", on: "failure", chatId: 12345 },
			{ id: "audit", channel: "webhook", on: "complete", url: "https://example.com/hook" },
		]);
	});

	it("parses review-policy with states and transitions", () => {
		const manifest = parseManifestKdl(
			`name "policy"\nversion "1.0"\nsetup "a" { domain "coding" }\ngoal "g" {\n\tsetup "a"\n\tschedule type="cron" expression="0 1 * * *"\n\tprompt "ok"\n}\nreview-policy "content-review" {\n\tstate "draft" initial=#true\n\tstate "approved" terminal=#true\n\ttransition from="draft" to="approved" action="approve"\n\ttransition from="approved" to="draft" action="reopen"\n}\n`,
		);
		expect(manifest.reviewPolicies).toEqual([
			{
				id: "content-review",
				states: [
					{ name: "draft", initial: true },
					{ name: "approved", terminal: true },
				],
				transitions: [
					{ from: "draft", to: "approved", action: "approve" },
					{ from: "approved", to: "draft", action: "reopen" },
				],
			},
		]);
	});

	it("parses checkpoint with requirements", () => {
		const manifest = parseManifestKdl(
			`name "checkpoint"\nversion "1.0"\nsetup "a" { domain "coding" }\ngoal "g" {\n\tsetup "a"\n\tschedule type="cron" expression="0 1 * * *"\n\tprompt "ok"\n}\ncheckpoint "publish" {\n\trequire "qa" kind="review" policy="content-review" state="approved"\n\trequire "legal" kind="approval" scope="release"\n}\n`,
		);
		expect(manifest.checkpoints).toEqual([
			{
				id: "publish",
				requires: [
					{ name: "qa", kind: "review", policy: "content-review", state: "approved" },
					{ name: "legal", kind: "approval", scope: "release" },
				],
			},
		]);
	});

	it("parses panel with columns and actions", () => {
		const manifest = parseManifestKdl(
			`name "panel"\nversion "1.0"\nsetup "a" { domain "coding" }\ngoal "g" {\n\tsetup "a"\n\tschedule type="cron" expression="0 1 * * *"\n\tprompt "ok"\n}\npanel "queue" source="articles" {\n\tcolumn "title" type="string"\n\tcolumn "score" type="number"\n\taction "approve" label="Approve"\n\taction "reject" label="Reject"\n}\n`,
		);
		expect(manifest.panels).toEqual([
			{
				id: "queue",
				source: "articles",
				columns: [
					{ name: "title", type: "string" },
					{ name: "score", type: "number" },
				],
				actions: [
					{ name: "approve", label: "Approve" },
					{ name: "reject", label: "Reject" },
				],
			},
		]);
	});

	it("parses layout with regions", () => {
		const manifest = parseManifestKdl(
			`name "layout"\nversion "1.0"\nsetup "a" { domain "coding" }\ngoal "g" {\n\tsetup "a"\n\tschedule type="cron" expression="0 1 * * *"\n\tprompt "ok"\n}\nlayout "review" {\n\tregion "main" panel="queue"\n\tregion "sidebar" panel="details"\n}\n`,
		);
		expect(manifest.layouts).toEqual([
			{ id: "review", regions: [{ name: "main", panel: "queue" }, { name: "sidebar", panel: "details" }] },
		]);
	});

	it("parses sync-collection nodes", () => {
		const manifest = parseManifestKdl(
			`name "sync"\nversion "1.0"\nsetup "a" { domain "coding" }\ngoal "g" {\n\tsetup "a"\n\tschedule type="cron" expression="0 1 * * *"\n\tprompt "ok"\n}\nsync-collection "published" source="cms.posts" filter="status=published"\n`,
		);
		expect(manifest.syncCollections).toEqual([{ id: "published", source: "cms.posts", filter: "status=published" }]);
	});

	it("parses state-schema with tables and columns", () => {
		const manifest = parseManifestKdl(
			`name "schema"\nversion "1.0"\nsetup "a" { domain "coding" }\ngoal "g" {\n\tsetup "a"\n\tschedule type="cron" expression="0 1 * * *"\n\tprompt "ok"\n}\nstate-schema "review-db" backend="sqlite" {\n\ttable "articles" {\n\t\tcolumn "id" type="text" primary=#true\n\t\tcolumn "title" type="text"\n\t}\n\ttable "reviews" {\n\t\tcolumn "article_id" type="text"\n\t\tcolumn "status" type="text"\n\t}\n}\n`,
		);
		expect(manifest.stateSchemas).toEqual([
			{
				id: "review-db",
				backend: "sqlite",
				tables: [
					{
						name: "articles",
						columns: [
							{ name: "id", type: "text", primary: true },
							{ name: "title", type: "text" },
						],
					},
					{
						name: "reviews",
						columns: [
							{ name: "article_id", type: "text" },
							{ name: "status", type: "text" },
						],
					},
				],
			},
		]);
	});
});
