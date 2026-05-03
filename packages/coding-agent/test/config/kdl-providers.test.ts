import { describe, expect, it } from "bun:test";
import { parse } from "@bgotink/kdl";

import { parseProvidersBlock, validateKdlProviderConfig } from "../../src/config/kdl-providers";

function parseDoc(kdl: string) {
	return parse(kdl);
}

describe("parseProvidersBlock", () => {
	it("returns empty providers for empty document", () => {
		expect(parseProvidersBlock(parseDoc(""))).toEqual({ providers: {} });
	});

	it("parses simple settings", () => {
		const result = parseProvidersBlock(
			parseDoc(`providers {
			web-search "auto"
			code-search "grep"
		}`),
		);

		expect(result.webSearch).toBe("auto");
		expect(result.codeSearch).toBe("grep");
		expect(result.providers).toEqual({});
	});

	it("parses provider api key env reference", () => {
		const result = parseProvidersBlock(
			parseDoc(`providers {
			provider "anthropic" {
				api-key "$ANTHROPIC_API_KEY"
			}
		}`),
		);

		expect(result.providers.anthropic).toEqual({ apiKey: "$ANTHROPIC_API_KEY" });
	});

	it("parses base url and auth", () => {
		const result = parseProvidersBlock(
			parseDoc(`providers {
			provider "ollama" {
				base-url "http://localhost:11434"
				auth "none"
			}
		}`),
		);

		expect(result.providers.ollama).toEqual({
			baseUrl: "http://localhost:11434",
			auth: "none",
		});
	});

	it("parses discovery config", () => {
		const result = parseProvidersBlock(
			parseDoc(`providers {
			provider "ollama" {
				discovery type="ollama"
			}
		}`),
		);

		expect(result.providers.ollama).toEqual({ discovery: { type: "ollama" } });
	});

	it("parses custom models", () => {
		const result = parseProvidersBlock(
			parseDoc(`providers {
			provider "ollama" {
				base-url "http://localhost:11434"
				model "llama3.2" {
					name "Llama 3.2"
					display-name "Llama 3.2 Instruct"
					reasoning #false
					thinking {
						mode "effort"
						max-level "high"
					}
					input "text" "image"
					cost {
						input 1.5
						output 2.5
					}
					premium-multiplier 1.2
					context-window 128000
					max-tokens 4096
				}
			}
		}`),
		);

		expect(result.providers.ollama?.models).toEqual([
			{
				id: "llama3.2",
				name: "Llama 3.2",
				displayName: "Llama 3.2 Instruct",
				reasoning: false,
				thinking: { mode: "effort", "max-level": "high" },
				input: ["text", "image"],
				cost: { input: 1.5, output: 2.5 },
				premiumMultiplier: 1.2,
				contextWindow: 128000,
				maxTokens: 4096,
			},
		]);
	});

	it("parses headers block", () => {
		const result = parseProvidersBlock(
			parseDoc(`providers {
			provider "company-proxy" {
				headers {
					X-Team "engineering"
					X-Env "prod"
				}
			}
		}`),
		);

		expect(result.providers["company-proxy"]?.headers).toEqual({
			"X-Team": "engineering",
			"X-Env": "prod",
		});
	});

	it("parses compat block", () => {
		const result = parseProvidersBlock(
			parseDoc(`providers {
			provider "company-proxy" {
				compat {
					supports-store #false
					max-tokens-field "max_tokens"
				}
			}
		}`),
		);

		expect(result.providers["company-proxy"]?.compat).toEqual({
			"supports-store": false,
			"max-tokens-field": "max_tokens",
		});
	});

	it("parses multiple providers", () => {
		const result = parseProvidersBlock(
			parseDoc(`providers {
			provider "anthropic" { api-key "$ANTHROPIC_API_KEY" }
			provider "ollama" {
				base-url "http://localhost:11434"
				auth "none"
			}
		}`),
		);

		expect(Object.keys(result.providers)).toEqual(["anthropic", "ollama"]);
	});
});

describe("validateKdlProviderConfig", () => {
	it("accepts env and shell api key references", () => {
		expect(() => validateKdlProviderConfig("anthropic", { apiKey: "$ANTHROPIC_API_KEY" })).not.toThrow();
		expect(() => validateKdlProviderConfig("anthropic", { apiKey: "!vault read secret/ai/key" })).not.toThrow();
	});
});
