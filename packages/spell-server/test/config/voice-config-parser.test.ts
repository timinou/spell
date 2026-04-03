import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { parseChannelsConfig, resolveEnvValue } from "../../src/config/channels-parser";

const BASE_KDL = (voiceBlock: string) => `telegram {
	bot-token "123456:ABC-DEF"
	default-model "claude-sonnet-4-5"
	owners 12345
	${voiceBlock}
}`;

describe("resolveEnvValue", () => {
	const originalEnv = { ...process.env };

	afterEach(() => {
		process.env = { ...originalEnv };
	});

	it("returns plain strings unchanged", () => {
		expect(resolveEnvValue("my-api-key")).toBe("my-api-key");
	});

	it("resolves env(NAME) from process.env", () => {
		process.env.TEST_KEY_123 = "secret-value";
		expect(resolveEnvValue("env(TEST_KEY_123)")).toBe("secret-value");
	});

	it("resolves env(NAME, default=fallback) when env is set", () => {
		process.env.TEST_KEY_456 = "real-value";
		expect(resolveEnvValue("env(TEST_KEY_456, default=fallback)")).toBe("real-value");
	});

	it("uses default when env is not set", () => {
		delete process.env.MISSING_KEY_XYZ;
		expect(resolveEnvValue("env(MISSING_KEY_XYZ, default=my-fallback)")).toBe("my-fallback");
	});

	it("throws when env is not set and no default", () => {
		delete process.env.MISSING_KEY_ABC;
		expect(() => resolveEnvValue("env(MISSING_KEY_ABC)")).toThrow(
			"Environment variable MISSING_KEY_ABC is not set and no default provided",
		);
	});

	it("does not match partial env() patterns", () => {
		expect(resolveEnvValue("notenv(FOO)")).toBe("notenv(FOO)");
		expect(resolveEnvValue("env(FOO) extra")).toBe("env(FOO) extra");
	});
});

describe("parseChannelsConfig voice block", () => {
	const originalEnv = { ...process.env };

	beforeEach(() => {
		process.env.TEST_DEEPGRAM_KEY = "dg-test-key";
		process.env.TEST_ELEVENLABS_KEY = "el-test-key";
	});

	afterEach(() => {
		process.env = { ...originalEnv };
	});

	it("parses a full voice config with STT and TTS", () => {
		const config = parseChannelsConfig(
			BASE_KDL(`voice {
				stt-provider "deepgram"
				stt-api-key "env(TEST_DEEPGRAM_KEY)"
				stt-model "nova-2"
				stt-language "en"
				tts-provider "elevenlabs"
				tts-api-key "env(TEST_ELEVENLABS_KEY)"
				tts-model "eleven_multilingual_v2"
				tts-voice "rachel"
				reply-mode "always"
			}`),
		);

		expect(config.telegram?.voice).toEqual({
			stt: {
				provider: "deepgram",
				apiKey: "dg-test-key", // pragma: allowlist secret
				model: "nova-2",
				language: "en",
			},
			tts: {
				provider: "elevenlabs",
				apiKey: "el-test-key", // pragma: allowlist secret
				model: "eleven_multilingual_v2",
				voice: "rachel",
			},
			replyMode: "always",
		});
	});

	it("parses minimal voice config with STT only", () => {
		const config = parseChannelsConfig(
			BASE_KDL(`voice {
				stt-provider "openai"
				stt-api-key "raw-key-value"
			}`),
		);

		expect(config.telegram?.voice).toEqual({
			stt: {
				provider: "openai",
				apiKey: "raw-key-value", // pragma: allowlist secret
				model: undefined,
				language: "en",
			},
			tts: undefined,
			replyMode: "mirror",
		});
	});

	it("returns undefined voice when voice block is absent", () => {
		const config = parseChannelsConfig(BASE_KDL(""));
		expect(config.telegram?.voice).toBeUndefined();
	});

	it("throws on stt-provider without stt-api-key", () => {
		expect(() =>
			parseChannelsConfig(
				BASE_KDL(`voice {
					stt-provider "deepgram"
				}`),
			),
		).toThrow("stt-api-key is required when stt-provider is set");
	});

	it("throws on stt-api-key without stt-provider", () => {
		expect(() =>
			parseChannelsConfig(
				BASE_KDL(`voice {
					stt-api-key "some-key"
				}`),
			),
		).toThrow("stt-provider is required when stt-api-key is set");
	});

	it("throws on tts-provider without tts-api-key", () => {
		expect(() =>
			parseChannelsConfig(
				BASE_KDL(`voice {
					tts-provider "elevenlabs"
				}`),
			),
		).toThrow("tts-api-key is required when tts-provider is set");
	});

	it("throws on unknown stt-provider", () => {
		expect(() =>
			parseChannelsConfig(
				BASE_KDL(`voice {
					stt-provider "whisperx"
					stt-api-key "key"
				}`),
			),
		).toThrow("stt-provider must be one of: deepgram, openai");
	});

	it("throws on unknown tts-provider", () => {
		expect(() =>
			parseChannelsConfig(
				BASE_KDL(`voice {
					tts-provider "google"
					tts-api-key "key"
				}`),
			),
		).toThrow("tts-provider must be one of: elevenlabs, deepgram");
	});

	it("throws on invalid reply-mode", () => {
		expect(() =>
			parseChannelsConfig(
				BASE_KDL(`voice {
					reply-mode "auto"
				}`),
			),
		).toThrow("reply-mode must be one of: mirror, always, never");
	});

	it("defaults reply-mode to mirror", () => {
		const config = parseChannelsConfig(BASE_KDL("voice {}"));
		expect(config.telegram?.voice?.replyMode).toBe("mirror");
	});

	it("parses per-user voice overrides", () => {
		const config = parseChannelsConfig(`telegram {
			bot-token "123456:ABC-DEF"
			default-model "claude-sonnet-4-5"
			owners 12345
			user 999 {
				voice {
					reply-mode "always"
					tts-voice "adam"
				}
			}
		}`);

		expect(config.telegram?.users["999"]?.voice).toEqual({
			replyMode: "always",
			ttsVoice: "adam",
		});
	});

	it("returns undefined user voice when user has no voice block", () => {
		const config = parseChannelsConfig(`telegram {
			bot-token "123456:ABC-DEF"
			default-model "claude-sonnet-4-5"
			owners 12345
			user 999 {}
		}`);

		expect(config.telegram?.users["999"]?.voice).toBeUndefined();
	});
});
