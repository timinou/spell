import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { WebConfig } from "../../../src/config/types";
import { handleArtifactsRoute } from "../../../src/web/artifacts/router";
import { mintSignedArtifactUrl } from "../../../src/web/artifacts/signed-url";
import type { ArtifactRequestDeps } from "../../../src/web/artifacts/types";

const SIGNING_KEY = Buffer.from("test-signing-key".padEnd(32, "x"));

describe("handleArtifactsRoute", () => {
	let sessionRoot: string;
	let deps: ArtifactRequestDeps;

	beforeEach(async () => {
		sessionRoot = await fs.mkdtemp(path.join(os.tmpdir(), "spell-artifacts-router-"));
		await fs.mkdir(path.join(sessionRoot, "main", "bash"), { recursive: true });
		await Bun.write(path.join(sessionRoot, "main", "bash", "0.txt"), "hello");
		const web: WebConfig = { tokens: new Map([["alice", "secret-a"]]) };
		deps = {
			sessionRoots: id => (id === "sess" ? sessionRoot : undefined),
			web,
			signingKey: SIGNING_KEY,
		};
	});

	afterEach(async () => {
		await fs.rm(sessionRoot, { recursive: true, force: true });
	});

	it("returns null for non-/web/artifacts paths", async () => {
		const response = await handleArtifactsRoute(new Request("http://localhost/api/sessions"), deps);
		expect(response).toBeNull();
	});

	it("serves an artifact with valid bearer auth", async () => {
		const req = new Request("http://localhost/web/artifacts/sess/main/bash/0.txt", {
			headers: { Authorization: "Bearer secret-a" },
		});
		const response = await handleArtifactsRoute(req, deps);
		expect(response?.status).toBe(200);
		expect(response?.headers.get("content-type")).toContain("text/plain");
		expect(await response?.text()).toBe("hello");
	});

	it("returns 401 without auth", async () => {
		const req = new Request("http://localhost/web/artifacts/sess/main/bash/0.txt");
		const response = await handleArtifactsRoute(req, deps);
		expect(response?.status).toBe(401);
	});

	it("accepts signed URL and bypasses bearer", async () => {
		const minted = mintSignedArtifactUrl("/web/artifacts/sess/main/bash/0.txt", 60, SIGNING_KEY);
		const req = new Request(`http://localhost${minted}`);
		const response = await handleArtifactsRoute(req, deps);
		expect(response?.status).toBe(200);
	});

	it("rejects unsafe segments (returns null or 400)", async () => {
		// Filename containing a NUL byte (after URL decoding) cannot match the
		// safe-segment regex, so the router refuses to serve it.
		const req = new Request("http://localhost/web/artifacts/sess/main/bash/%00.txt", {
			headers: { Authorization: "Bearer secret-a" },
		});
		const response = await handleArtifactsRoute(req, deps);
		if (response !== null) {
			expect([400, 404]).toContain(response.status);
		}
	});

	it("returns 404 for unknown sessionId", async () => {
		const req = new Request("http://localhost/web/artifacts/missing/main/bash/0.txt", {
			headers: { Authorization: "Bearer secret-a" },
		});
		const response = await handleArtifactsRoute(req, deps);
		expect(response?.status).toBe(404);
	});

	it("supports HEAD with same headers and no body", async () => {
		const req = new Request("http://localhost/web/artifacts/sess/main/bash/0.txt", {
			method: "HEAD",
			headers: { Authorization: "Bearer secret-a" },
		});
		const response = await handleArtifactsRoute(req, deps);
		expect(response?.status).toBe(200);
		expect(response?.headers.get("content-length")).toBe("5");
		expect(await response?.text()).toBe("");
	});

	it("uses Content-Disposition: attachment when ?download=1", async () => {
		const req = new Request("http://localhost/web/artifacts/sess/main/bash/0.txt?download=1", {
			headers: { Authorization: "Bearer secret-a" },
		});
		const response = await handleArtifactsRoute(req, deps);
		expect(response?.headers.get("content-disposition")).toMatch(/attachment/);
	});
});
