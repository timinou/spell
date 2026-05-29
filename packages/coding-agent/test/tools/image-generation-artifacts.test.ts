import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { saveImageAsArtifact } from "@oh-my-pi/pi-coding-agent/tools/image-generation";

const tempDirs: string[] = [];

async function createTempDir(): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "img-art-"));
	tempDirs.push(dir);
	return dir;
}

afterEach(async () => {
	await Promise.all(tempDirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
});

describe("saveImageAsArtifact", () => {
	it("saves generated images to the artifact directory when an allocator is provided", async () => {
		const tmpDir = await createTempDir();
		const allocate = async (toolType: string, extension?: string) => {
			const dir = path.join(tmpDir, toolType);
			await fs.mkdir(dir, { recursive: true });
			const ext = extension ?? "txt";
			return {
				id: "0",
				path: path.join(dir, `0.${ext}`),
				uri: `artifact://test/main/${toolType}/0.${ext}`,
			};
		};
		const image = { data: Buffer.from("fake-png").toString("base64"), mimeType: "image/png" };

		const result = await saveImageAsArtifact(image, allocate);

		expect(result.uri).toBe("artifact://test/main/generate_image/0.png");
		expect(await Bun.file(result.path).exists()).toBe(true);
		expect(await Bun.file(result.path).text()).toBe("fake-png");
	});

	it("falls back to tmpdir when no allocator is available", async () => {
		const image = { data: Buffer.from("fake").toString("base64"), mimeType: "image/png" };

		const result = await saveImageAsArtifact(image);

		expect(result.uri).toBeUndefined();
		expect(result.path).toContain(os.tmpdir());
		expect(await Bun.file(result.path).exists()).toBe(true);
	});
});
