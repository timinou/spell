/**
 * Session inheritance tests.
 *
 * Verifies that the shared storageName mechanism (for parent/child services)
 * works correctly by testing registry-level inheritance. The actual cookie
 * sharing relies on WebEngine's storage directory, which is confirmed by the
 * fact that both profiles resolve to the same storageName.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { ServiceRegistry } from "../../src/browser/service-registry";

let tmpDir: string;
let registryPath: string;
let storageRoot: string;

describe("Session inheritance via shared storageName", () => {
	beforeEach(async () => {
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "spell-inherit-test-"));
		registryPath = path.join(tmpDir, "services.json");
		storageRoot = path.join(tmpDir, "QtWebEngine");
		await fs.mkdir(storageRoot, { recursive: true });
	});

	afterEach(async () => {
		await fs.rm(tmpDir, { recursive: true, force: true });
	});

	it("child service resolves to parent storageName", async () => {
		const registry = new ServiceRegistry(registryPath, storageRoot);

		// Add parent service
		await registry.add({
			name: "google-personal",
			displayName: "Google Personal",
			description: "Personal Google account",
			profileStorage: "google-personal",
			domains: ["google.com", "accounts.google.com"],
		});

		// Add child service (YouTube shares Google's profile)
		await registry.add({
			name: "youtube",
			displayName: "YouTube",
			description: "Video streaming",
			profileStorage: "youtube", // Will resolve to parent's profileStorage
			domains: ["youtube.com", "www.youtube.com"],
			parentService: "google-personal",
		});

		// Child should use parent's profileStorage
		const youtube = await registry.get("youtube");
		expect(youtube).not.toBeNull();
		expect(youtube!.profileStorage).toBe("google-personal");

		// Both services share the same storage path
		const googlePath = registry.resolveStoragePath("google-personal");
		const youtubePath = registry.resolveStoragePath(youtube!.profileStorage);
		expect(youtubePath).toBe(googlePath);
	});

	it("removing parent does not cascade to children", async () => {
		const registry = new ServiceRegistry(registryPath, storageRoot);

		await registry.add({
			name: "google-work",
			displayName: "Google Work",
			description: "Work Google account",
			profileStorage: "google-work",
			domains: ["google.com"],
		});

		await registry.add({
			name: "gmail-work",
			displayName: "Gmail Work",
			description: "Work email",
			profileStorage: "gmail",
			domains: ["mail.google.com"],
			parentService: "google-work",
		});

		// Remove parent
		await registry.remove("google-work");

		// Child survives with its inherited profileStorage
		const gmail = await registry.get("gmail-work");
		expect(gmail).not.toBeNull();
		expect(gmail!.profileStorage).toBe("google-work");
		expect(gmail!.parentService).toBe("google-work");
	});

	it("multiple children share the same parent profile", async () => {
		const registry = new ServiceRegistry(registryPath, storageRoot);

		await registry.add({
			name: "google",
			displayName: "Google",
			description: "Google account",
			profileStorage: "google-profile",
			domains: ["google.com"],
		});

		await registry.add({
			name: "youtube",
			displayName: "YouTube",
			description: "Video",
			profileStorage: "yt",
			domains: ["youtube.com"],
			parentService: "google",
		});

		await registry.add({
			name: "gmail",
			displayName: "Gmail",
			description: "Email",
			profileStorage: "gm",
			domains: ["mail.google.com"],
			parentService: "google",
		});

		const yt = await registry.get("youtube");
		const gm = await registry.get("gmail");

		// Both children share parent's profileStorage
		expect(yt!.profileStorage).toBe("google-profile");
		expect(gm!.profileStorage).toBe("google-profile");
	});
});
