import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { type AssistantMessage, createToolCallStreamDiagnostic } from "@spell/pi-ai";
import {
	loadEntriesFromFile,
	SessionManager,
	type SessionMessageEntry,
} from "@spell/pi-coding-agent/session/session-manager";
import { getBlobsDir, TempDir } from "@spell/pi-utils";

function isAssistantSessionEntry(entry: unknown): entry is SessionMessageEntry & { message: AssistantMessage } {
	return (
		typeof entry === "object" &&
		entry !== null &&
		"type" in entry &&
		entry.type === "message" &&
		"message" in entry &&
		typeof entry.message === "object" &&
		entry.message !== null &&
		"role" in entry.message &&
		entry.message.role === "assistant"
	);
}

function getAssistantMessage(session: SessionManager): AssistantMessage {
	const assistantEntry = session.getEntries().find(isAssistantSessionEntry);
	if (!assistantEntry) throw new Error("Expected assistant message");
	return assistantEntry.message;
}

describe("SessionManager signature persistence", () => {
	it("clears oversized signatures instead of truncating them", async () => {
		using tempDir = TempDir.createSync("@pi-session-signature-persistence-");
		const session = SessionManager.create(tempDir.path(), tempDir.path());

		session.appendMessage({ role: "user", content: "continue", timestamp: 1 });
		session.appendMessage({
			role: "assistant",
			content: [
				{ type: "thinking", thinking: "reasoning", thinkingSignature: "s".repeat(600_000) },
				{ type: "text", text: "done", textSignature: "m".repeat(600_000) },
				{ type: "toolCall", id: "tool_1", name: "read", arguments: {}, thoughtSignature: "t".repeat(600_000) },
			],
			api: "openai-responses",
			provider: "openai",
			model: "gpt-5-mini",
			usage: {
				input: 1,
				output: 1,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 2,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: 2,
		} satisfies AssistantMessage);
		await session.flush();

		const reloaded = await SessionManager.open(session.getSessionFile()!);
		const assistant = getAssistantMessage(reloaded);

		expect(assistant.content[0]).toMatchObject({ type: "thinking", thinking: "reasoning", thinkingSignature: "" });
		expect(assistant.content[1]).toMatchObject({ type: "text", text: "done", textSignature: "" });
		expect(assistant.content[2]).toMatchObject({ type: "toolCall", id: "tool_1", thoughtSignature: "" });
	});

	it("externalizes provider image data URLs and restores them across reload", async () => {
		using tempDir = TempDir.createSync("@pi-session-provider-image-persistence-");
		const session = SessionManager.create(tempDir.path(), tempDir.path());
		const largeImageUrl = `data:image/png;base64,${"a".repeat(600_000)}`;

		session.appendMessage({ role: "user", content: "continue", timestamp: 1 });
		session.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: "done" }],
			api: "openai-codex-responses",
			provider: "openai-codex",
			model: "gpt-5.4",
			usage: {
				input: 1,
				output: 1,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 2,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			providerPayload: {
				type: "openaiResponsesHistory",
				provider: "openai-codex",
				items: [
					{
						type: "message",
						role: "user",
						content: [
							{ type: "input_text", text: "look at this" },
							{ type: "input_image", detail: "auto", image_url: largeImageUrl },
						],
					},
				],
			},
			timestamp: 2,
		} satisfies AssistantMessage);
		await session.flush();

		const expectedBlobHash = new Bun.CryptoHasher("sha256").update(Buffer.from(largeImageUrl, "utf8")).digest("hex");
		const persistedBlob = await fs.readFile(path.join(getBlobsDir(), expectedBlobHash), "utf8");
		expect(persistedBlob).toBe(largeImageUrl);

		const reloaded = await SessionManager.open(session.getSessionFile()!);
		const assistant = getAssistantMessage(reloaded);

		expect(assistant.providerPayload).toEqual({
			type: "openaiResponsesHistory",
			provider: "openai-codex",
			items: [
				{
					type: "message",
					role: "user",
					content: [
						{ type: "input_text", text: "look at this" },
						{ type: "input_image", detail: "auto", image_url: largeImageUrl },
					],
				},
			],
		});
	});

	it("externalizes raw stalled tool payloads to artifacts and preserves references across reload", async () => {
		using tempDir = TempDir.createSync("@pi-session-tool-call-diagnostic-persistence-");
		const session = SessionManager.create(tempDir.path(), tempDir.path());
		const rawPartialJson = '{"path":"specs/markdown-code-engine-integration.md"}';

		session.appendMessage({ role: "user", content: "continue", timestamp: 1 });
		session.appendMessage({
			role: "assistant",
			content: [
				{
					type: "toolCall",
					id: "tool_1",
					name: "write",
					arguments: { path: "specs/markdown-code-engine-integration.md" },
				},
			],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-sonnet-4-5",
			usage: {
				input: 1,
				output: 1,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 2,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "error",
			errorMessage: "Anthropic messages stream stalled while streaming incomplete write tool arguments",
			streamDiagnostics: [
				createToolCallStreamDiagnostic({
					state: "stalled_incomplete_tool_args",
					api: "anthropic-messages",
					provider: "anthropic",
					model: "claude-sonnet-4-5",
					toolName: "write",
					toolCallId: "tool_1",
					arguments: { path: "specs/markdown-code-engine-integration.md" },
					rawPartialJson,
					firstTokenTimeMs: 120,
					idleTimeoutMs: 45_000,
					providerRetryAttempt: 1,
				}),
			],
			timestamp: 2,
		} satisfies AssistantMessage);
		await session.flush();

		const sessionFile = session.getSessionFile();
		if (!sessionFile) throw new Error("Expected persisted session file");
		const persistedEntries = await loadEntriesFromFile(sessionFile);
		const persistedEntry = persistedEntries.find(isAssistantSessionEntry);
		if (!persistedEntry) throw new Error("Expected persisted assistant message");
		const persistedDiagnostic = persistedEntry.message.streamDiagnostics?.[0];
		const rawArtifact = persistedDiagnostic?.rawPartialJsonArtifact;

		expect(persistedDiagnostic?.rawPartialJson).toBeUndefined();
		expect(persistedDiagnostic?.rawPartialJsonBytes).toBe(new TextEncoder().encode(rawPartialJson).length);
		expect(rawArtifact?.uri).toMatch(/^artifact:\/\//);
		expect(rawArtifact?.path).toContain("tool-call-diagnostic");

		if (!rawArtifact?.uri || !rawArtifact.path) {
			throw new Error("Expected persisted stalled-tool artifact reference");
		}
		expect(await session.getArtifactPath(rawArtifact.uri)).toBe(rawArtifact.path);
		expect(await Bun.file(rawArtifact.path).text()).toBe(rawPartialJson);

		const reloaded = await SessionManager.open(sessionFile);
		const assistant = getAssistantMessage(reloaded);
		const reloadedDiagnostic = assistant.streamDiagnostics?.[0];

		expect(reloadedDiagnostic?.rawPartialJson).toBeUndefined();
		expect(reloadedDiagnostic?.rawPartialJsonArtifact).toEqual(rawArtifact);
		expect(await reloaded.getArtifactPath(rawArtifact.uri)).toBe(rawArtifact.path);
	});
});
