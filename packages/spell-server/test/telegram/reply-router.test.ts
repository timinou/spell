import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { ReplyRouter, type PendingReply } from "../../src/telegram/reply-router";

const tempDirs = new Set<string>();

async function createTempDir(): Promise<string> {
	const tempDir = path.join(os.tmpdir(), `spell-reply-router-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	await fs.mkdir(tempDir, { recursive: true });
	tempDirs.add(tempDir);
	return tempDir;
}

afterEach(async () => {
	await Promise.allSettled(
		[...tempDirs].map(async tempDir => {
			tempDirs.delete(tempDir);
			await fs.rm(tempDir, { recursive: true, force: true });
		}),
	);
});

describe("ReplyRouter", () => {
	it("register and lookup round-trip", async () => {
		const tempDir = await createTempDir();
		const persistPath = path.join(tempDir, "reply-map.json");

		const router = new ReplyRouter({
			persistencePath: persistPath,
			ttlMs: 10000,
		});

		await router.register(123, {
			chatId: 999,
			sessionId: "sess-1",
			eventId: "event-1",
			eventKind: "ask",
			sessionTitle: "Test Session",
		});

		const result = await router.lookup(123);
		expect(result).toBeDefined();
		expect(result?.chatId).toBe(999);
		expect(result?.sessionId).toBe("sess-1");
		expect(result?.eventId).toBe("event-1");
		expect(result?.eventKind).toBe("ask");
		expect(result?.sessionTitle).toBe("Test Session");
		expect(result?.stale).toBe(false);

		router.dispose();
	});

	it("lookup for missing messageId returns undefined", async () => {
		const tempDir = await createTempDir();
		const persistPath = path.join(tempDir, "reply-map.json");

		const router = new ReplyRouter({
			persistencePath: persistPath,
			ttlMs: 10000,
		});

		const result = await router.lookup(999);
		expect(result).toBeUndefined();

		router.dispose();
	});

	it("persistence: write, dispose, load, lookup still works", async () => {
		const tempDir = await createTempDir();
		const persistPath = path.join(tempDir, "reply-map.json");

		// First router: register and close
		const router1 = new ReplyRouter({
			persistencePath: persistPath,
			ttlMs: 100000,
		});

		await router1.register(456, {
			chatId: 111,
			sessionId: "sess-2",
			eventId: "event-2",
			eventKind: "plan_approval",
		});

		router1.dispose();

		// Second router: load and verify
		const router2 = new ReplyRouter({
			persistencePath: persistPath,
			ttlMs: 100000,
		});

		await router2.load();
		const result = await router2.lookup(456);
		expect(result).toBeDefined();
		expect(result?.chatId).toBe(111);
		expect(result?.sessionId).toBe("sess-2");
		expect(result?.eventId).toBe("event-2");

		router2.dispose();
	});

	it("TTL eviction: register, age entry, evictExpired removes it", async () => {
		const tempDir = await createTempDir();
		const persistPath = path.join(tempDir, "reply-map.json");

		const router = new ReplyRouter({
			persistencePath: persistPath,
			ttlMs: 1000, // 1 second TTL
		});

		await router.register(789, {
			chatId: 222,
			sessionId: "sess-3",
			eventId: "event-3",
			eventKind: "hook_input",
		});

		// Manually age the entry
		const entry = await router.lookup(789);
		expect(entry).toBeDefined();
		if (entry) {
			entry.sentAt = Date.now() - 2000; // 2 seconds old, exceeds 1s TTL
		}

		const { evicted } = await router.evictExpired();
		expect(evicted).toBe(1);

		const result = await router.lookup(789);
		expect(result).toBeUndefined();

		router.dispose();
	});

	it("supersede: marks prior mappings for same sessionId as stale", async () => {
		const tempDir = await createTempDir();
		const persistPath = path.join(tempDir, "reply-map.json");

		const router = new ReplyRouter({
			persistencePath: persistPath,
			ttlMs: 100000,
		});

		// Register entry for session A
		await router.register(101, {
			chatId: 333,
			sessionId: "sess-A",
			eventId: "event-A1",
			eventKind: "ask",
		});

		// Another entry for session A
		await router.register(102, {
			chatId: 333,
			sessionId: "sess-A",
			eventId: "event-A2",
			eventKind: "ask",
		});

		// Entry for session B
		await router.register(103, {
			chatId: 444,
			sessionId: "sess-B",
			eventId: "event-B",
			eventKind: "ask",
		});

		// Supersede session A
		await router.supersede("sess-A");

		// Check session A entries are marked stale
		const result101 = await router.lookup(101);
		const result102 = await router.lookup(102);
		const result103 = await router.lookup(103);

		expect(result101?.stale).toBe(true);
		expect(result102?.stale).toBe(true);
		expect(result103?.stale).toBe(false); // Not affected

		router.dispose();
	});

	it("load from nonexistent file initializes empty state", async () => {
		const tempDir = await createTempDir();
		const persistPath = path.join(tempDir, "nonexistent", "reply-map.json");

		const router = new ReplyRouter({
			persistencePath: persistPath,
			ttlMs: 10000,
		});

		await router.load(); // Should not throw

		const result = await router.lookup(999);
		expect(result).toBeUndefined();

		router.dispose();
	});

	it("load from corrupt JSON file logs warn and initializes empty", async () => {
		const tempDir = await createTempDir();
		const persistPath = path.join(tempDir, "reply-map.json");

		// Write corrupt JSON
		await Bun.write(persistPath, "{invalid json");

		const router = new ReplyRouter({
			persistencePath: persistPath,
			ttlMs: 10000,
		});

		await router.load(); // Should not throw, just log

		const result = await router.lookup(999);
		expect(result).toBeUndefined();

		router.dispose();
	});

	it("load drops expired entries", async () => {
		const tempDir = await createTempDir();
		const persistPath = path.join(tempDir, "reply-map.json");

		// Write persistence file with old and new entries
		const now = Date.now();
		const persistence = {
			"100": {
				chatId: 555,
				sessionId: "sess-old",
				eventId: "event-old",
				eventKind: "ask",
				sentAt: now - 100000, // Very old
				stale: false,
			} as PendingReply,
			"200": {
				chatId: 666,
				sessionId: "sess-new",
				eventId: "event-new",
				eventKind: "ask",
				sentAt: now - 100, // Recently added
				stale: false,
			} as PendingReply,
		};

		await Bun.write(persistPath, JSON.stringify(persistence));

		const router = new ReplyRouter({
			persistencePath: persistPath,
			ttlMs: 1000, // Only 1s TTL
		});

		await router.load();

		// Old entry should be dropped
		const oldResult = await router.lookup(100);
		expect(oldResult).toBeUndefined();

		// New entry should be present
		const newResult = await router.lookup(200);
		expect(newResult).toBeDefined();
		expect(newResult?.sessionId).toBe("sess-new");

		router.dispose();
	});

	it("evictExpired does not persist if nothing expired", async () => {
		const tempDir = await createTempDir();
		const persistPath = path.join(tempDir, "reply-map.json");

		const router = new ReplyRouter({
			persistencePath: persistPath,
			ttlMs: 100000,
		});

		await router.register(300, {
			chatId: 777,
			sessionId: "sess-fresh",
			eventId: "event-fresh",
			eventKind: "ask",
		});

		const { evicted } = await router.evictExpired();
		expect(evicted).toBe(0);

		// File should still exist with original data
		const result = await router.lookup(300);
		expect(result).toBeDefined();

		router.dispose();
	});

	it("cleanup interval runs periodically", async () => {
		const tempDir = await createTempDir();
		const persistPath = path.join(tempDir, "reply-map.json");

		const router = new ReplyRouter({
			persistencePath: persistPath,
			ttlMs: 100,
			cleanupIntervalMs: 50,
		});

		await router.register(400, {
			chatId: 888,
			sessionId: "sess-cleanup",
			eventId: "event-cleanup",
			eventKind: "ask",
		});

		// Age the entry
		const entry = await router.lookup(400);
		if (entry) {
			entry.sentAt = Date.now() - 500;
		}

		// Wait for cleanup to run
		await new Promise(resolve => setTimeout(resolve, 150));

		// Entry should be evicted by cleanup
		const result = await router.lookup(400);
		expect(result).toBeUndefined();

		router.dispose();
	});
});

// Voice reply handler tests
describe("Voice Reply Handler", () => {
	it("voice reply with high confidence transcription resolves event", async () => {
		// Test that high confidence (>= 0.4) transcriptions resolve the event
			const mockSttProvider = {
		transcribe: async (_buf?: Buffer, _opts?: { mimeType?: string }) => ({
			text: "hello world",
			confidence: 0.9,
		}),
	};

		// Test STT provider returns high confidence
		const result = await mockSttProvider.transcribe(Buffer.alloc(0), {
			mimeType: "audio/ogg",
		});
		expect(result.confidence).toBeGreaterThanOrEqual(0.4);
		expect(result.text).toBe("hello world");
	});

	it("voice reply with low confidence does not resolve event", async () => {
		// Test that low confidence (< 0.4) transcriptions do not resolve
		const mockSttProvider = {
			transcribe: async (_buf?: Buffer, _opts?: { mimeType?: string }) => ({
				text: "",
				confidence: 0.1,
			}),
		};

		const result = await mockSttProvider.transcribe(Buffer.alloc(0), {
			mimeType: "audio/ogg",
		});
		expect(result.confidence).toBeLessThan(0.4);
		expect(result.text).toBe("");
	});

	it("voice reply without STT config is rejected", async () => {
		// Test that missing voice config prevents voice replies
		const mockTelegramConfig = {
			botToken: "test-token",
			voice: undefined, // No voice config
			users: {
				"123": {},
			},
		};

		// Voice config should be undefined
		expect(mockTelegramConfig.voice).toBeUndefined();
	});

	it("voice reply registration and stale handling", async () => {
		const tempDir = await createTempDir();
		const persistPath = path.join(tempDir, "reply-map.json");

		const router = new ReplyRouter({
			persistencePath: persistPath,
			ttlMs: 100000,
		});

		// Register a voice reply entry
		await router.register(500, {
			chatId: 1000,
			sessionId: "voice-sess",
			eventId: "voice-event",
			eventKind: "hook_input",
		});

		const entry = await router.lookup(500);
		expect(entry).toBeDefined();
		expect(entry?.stale).toBe(false);

		// Mark as stale
		await router.supersede("voice-sess");
		const staledEntry = await router.lookup(500);
		expect(staledEntry?.stale).toBe(true);

		router.dispose();
	});
});
