import { describe, expect, it } from "bun:test";
import { enrichModelThinking } from "@spell/pi-ai/model-thinking";
import { type RequestBody, transformRequestBody } from "@spell/pi-ai/providers/openai-codex/request-transformer";
import type { Model } from "@spell/pi-ai/types";

function createCodexModel(id: string): Model<"openai-codex-responses"> {
	return enrichModelThinking({
		id,
		name: id,
		api: "openai-codex-responses",
		provider: "openai-codex",
		baseUrl: "https://api.openai.com/v1",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 272000,
		maxTokens: 128000,
	});
}

describe("openai-codex include handling", () => {
	it("always includes reasoning.encrypted_content when caller include is custom", async () => {
		const body: RequestBody = {
			model: "gpt-5.1-codex",
		};

		const transformed = await transformRequestBody(body, createCodexModel(body.model), { include: ["foo"] });
		expect(transformed.include).toEqual(["foo", "reasoning.encrypted_content"]);
	});

	it("does not duplicate reasoning.encrypted_content", async () => {
		const body: RequestBody = {
			model: "gpt-5.1-codex",
		};

		const transformed = await transformRequestBody(body, createCodexModel(body.model), {
			include: ["foo", "reasoning.encrypted_content"],
		});
		expect(transformed.include).toEqual(["foo", "reasoning.encrypted_content"]);
	});
});

describe("openai-codex text verbosity", () => {
	it("defaults verbosity to low (terse-by-default house style)", async () => {
		const body: RequestBody = { model: "gpt-5.1-codex" };
		const transformed = await transformRequestBody(body, createCodexModel(body.model), {});
		expect((transformed.text as { verbosity?: string }).verbosity).toBe("low");
	});

	it("honors an explicit textVerbosity override", async () => {
		const body: RequestBody = { model: "gpt-5.1-codex" };
		const transformed = await transformRequestBody(body, createCodexModel(body.model), {
			textVerbosity: "high",
		});
		expect((transformed.text as { verbosity?: string }).verbosity).toBe("high");
	});
});
