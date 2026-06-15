import { afterEach, describe, expect, test } from "bun:test";
import { getBundledModel } from "../src/models";
import { DEFAULT_MODEL_PER_PROVIDER } from "../src/provider-models/descriptors";
import { MODELS_DEV_PROVIDER_DESCRIPTORS, mapModelsDevToModels } from "../src/provider-models/openai-compat";
import { getEnvApiKey } from "../src/stream";

const originalZhipuApiKey = Bun.env.ZHIPU_API_KEY;
const originalZaiApiKey = Bun.env.ZAI_API_KEY;

function restoreEnv(name: "ZHIPU_API_KEY" | "ZAI_API_KEY", value: string | undefined) {
	if (value === undefined) {
		delete Bun.env[name];
	} else {
		Bun.env[name] = value;
	}
}

afterEach(() => {
	restoreEnv("ZHIPU_API_KEY", originalZhipuApiKey);
	restoreEnv("ZAI_API_KEY", originalZaiApiKey);
});

describe("zai coding plan provider support", () => {
	test("prefers ZHIPU_API_KEY and falls back to ZAI_API_KEY", () => {
		Bun.env.ZHIPU_API_KEY = "dummy-zhipu-token"; // pragma: allowlist secret
		Bun.env.ZAI_API_KEY = "dummy-zai-token"; // pragma: allowlist secret
		expect(getEnvApiKey("zai")).toBe("dummy-zhipu-token");

		delete Bun.env.ZHIPU_API_KEY;
		expect(getEnvApiKey("zai")).toBe("dummy-zai-token");
	});

	test("defaults zai to GLM-5.2 coding plan model", () => {
		expect(DEFAULT_MODEL_PER_PROVIDER.zai).toBe("glm-5.2");
	});

	test("bundled GLM-5.2 uses the coding plan OpenAI-compatible endpoint", () => {
		const model = getBundledModel("zai", "glm-5.2");
		expect(model.api).toBe("openai-completions");
		expect(model.baseUrl).toBe("https://api.z.ai/api/coding/paas/v4");
		expect(model.contextWindow).toBe(1_000_000);
		expect(model.maxTokens).toBe(131_072);
		expect(model.reasoning).toBe(true);
	});

	test("maps models.dev Z.AI Coding Plan models to the coding endpoint", () => {
		const [model] = mapModelsDevToModels(
			{
				"zai-coding-plan": {
					models: {
						"glm-5.2": {
							name: "GLM-5.2",
							tool_call: true,
							reasoning: true,
							limit: { context: 1_000_000, output: 131_072 },
						},
					},
				},
			},
			MODELS_DEV_PROVIDER_DESCRIPTORS,
		).filter(item => item.provider === "zai" && item.id === "glm-5.2");

		expect(model).toBeDefined();
		expect(model?.api).toBe("openai-completions");
		expect(model?.baseUrl).toBe("https://api.z.ai/api/coding/paas/v4");
		expect(model?.contextWindow).toBe(1_000_000);
		expect(model?.maxTokens).toBe(131_072);
	});
});
