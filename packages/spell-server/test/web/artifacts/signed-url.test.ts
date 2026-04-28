import { describe, expect, it } from "bun:test";
import { mintSignedArtifactUrl, verifySignedUrl } from "../../../src/web/artifacts/signed-url";

const KEY = Buffer.from("test-key-bytes-32".padEnd(32, "x"));

function urlFromMint(uri: string, mint: string): string {
	return `http://localhost:8787${mint.startsWith("/") ? mint : `/${mint}`}`;
}

describe("signed artifact URL", () => {
	it("returns valid for a freshly minted URL", () => {
		const path = "/web/artifacts/sess/main/bash/0.txt";
		const minted = mintSignedArtifactUrl(path, 60, KEY);
		const req = new Request(urlFromMint(path, minted));
		expect(verifySignedUrl(req, KEY).valid).toBe(true);
	});

	it("rejects expired URLs", () => {
		const path = "/web/artifacts/sess/main/bash/0.txt";
		const minted = mintSignedArtifactUrl(path, 1, KEY);
		const future = () => Date.now() + 10_000;
		expect(verifySignedUrl(new Request(urlFromMint(path, minted)), KEY, future).valid).toBe(false);
	});

	it("rejects tampered exp", () => {
		const path = "/web/artifacts/sess/main/bash/0.txt";
		const minted = mintSignedArtifactUrl(path, 60, KEY);
		const url = new URL(urlFromMint(path, minted));
		const exp = Number(url.searchParams.get("exp"));
		url.searchParams.set("exp", String(exp + 1));
		expect(verifySignedUrl(new Request(url.toString()), KEY).valid).toBe(false);
	});

	it("rejects requests without sig/exp", () => {
		const req = new Request("http://localhost/web/artifacts/sess/main/bash/0.txt");
		expect(verifySignedUrl(req, KEY).valid).toBe(false);
	});

	it("rejects mismatched URI path with otherwise valid signature", () => {
		const path = "/web/artifacts/sess/main/bash/0.txt";
		const minted = mintSignedArtifactUrl(path, 60, KEY);
		// Replay sig+exp on a different path
		const params = new URL(urlFromMint(path, minted)).searchParams;
		const evilUrl = `http://localhost:8787/web/artifacts/sess/main/bash/secrets.txt?${params.toString()}`;
		expect(verifySignedUrl(new Request(evilUrl), KEY).valid).toBe(false);
	});
});
