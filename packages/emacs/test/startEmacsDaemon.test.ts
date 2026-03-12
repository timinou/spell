import { mock, vi } from "bun:test";

// Mock detection BEFORE importing any module that uses it.
// Each describe block gets its own mock factory via mock.module hoisting.
const mockDetectEmacs = vi.fn();
mock.module("../src/detection", () => ({ detectEmacs: mockDetectEmacs }));

// Mock daemon startup so tests never spawn real processes.
const mockStartEmacsSession = vi.fn();
mock.module("../src/daemon", () => ({
	startEmacsSession: mockStartEmacsSession,
}));

import { afterEach, describe, expect, it } from "bun:test";
import { startEmacsDaemon } from "../src/tool";

const AVAILABLE_DETECTION = {
	found: true,
	path: "/usr/bin/emacs",
	version: "30.2",
	meetsMinimum: true,
	treesitAvailable: true,
	socatFound: true,
	socatPath: "/usr/bin/socat",
	errors: [],
};

const mockSession = {
	socketPath: "/run/user/1000/spell-emacs-abc123.sock",
	isAlive: () => true,
	stop: async () => {},
};

afterEach(() => {
	mockDetectEmacs.mockReset();
	mockStartEmacsSession.mockReset();
});

describe("startEmacsDaemon", () => {
	it("returns null when emacs binary is not found", async () => {
		mockDetectEmacs.mockResolvedValue({
			...AVAILABLE_DETECTION,
			found: false,
			path: null,
			version: null,
			meetsMinimum: false,
			treesitAvailable: false,
			socatFound: false,
			errors: ["Emacs not found in PATH"],
		});

		const result = await startEmacsDaemon(undefined, "/tmp/proj", "s1");

		expect(result).toBeNull();
		expect(mockStartEmacsSession).not.toHaveBeenCalled();
	});

	it("returns null when emacs version is below minimum", async () => {
		mockDetectEmacs.mockResolvedValue({
			...AVAILABLE_DETECTION,
			meetsMinimum: false,
			errors: ["Emacs 28.1 is below minimum 29.1"],
		});

		const result = await startEmacsDaemon(undefined, "/tmp/proj", "s1");

		expect(result).toBeNull();
		expect(mockStartEmacsSession).not.toHaveBeenCalled();
	});

	it("returns null when socat is missing", async () => {
		mockDetectEmacs.mockResolvedValue({
			...AVAILABLE_DETECTION,
			socatFound: false,
			socatPath: null,
			errors: ["socat not found"],
		});

		const result = await startEmacsDaemon(undefined, "/tmp/proj", "s1");

		expect(result).toBeNull();
		expect(mockStartEmacsSession).not.toHaveBeenCalled();
	});

	it("returns null when treesit is not compiled into this Emacs build", async () => {
		mockDetectEmacs.mockResolvedValue({ ...AVAILABLE_DETECTION, treesitAvailable: false });

		const result = await startEmacsDaemon(undefined, "/tmp/proj", "s1");

		expect(result).toBeNull();
		expect(mockStartEmacsSession).not.toHaveBeenCalled();
	});

	it("returns null without throwing when startEmacsSession throws", async () => {
		mockDetectEmacs.mockResolvedValue(AVAILABLE_DETECTION);
		mockStartEmacsSession.mockRejectedValue(new Error("socket timeout"));

		const result = await startEmacsDaemon(undefined, "/tmp/proj", "s1");

		expect(result).toBeNull();
	});

	it("returns the EmacsSession on success", async () => {
		mockDetectEmacs.mockResolvedValue(AVAILABLE_DETECTION);
		mockStartEmacsSession.mockResolvedValue(mockSession);

		const result = await startEmacsDaemon(undefined, "/tmp/proj", "s1");

		expect(result).toBe(mockSession);
		expect(mockStartEmacsSession).toHaveBeenCalledTimes(1);
	});

	it("passes the configured emacs path to detectEmacs", async () => {
		mockDetectEmacs.mockResolvedValue(AVAILABLE_DETECTION);
		mockStartEmacsSession.mockResolvedValue(mockSession);

		await startEmacsDaemon("/opt/emacs/bin/emacs", "/tmp/proj", "s1");

		expect(mockDetectEmacs).toHaveBeenCalledWith("/opt/emacs/bin/emacs");
	});
});
