import { afterEach, beforeEach, describe, expect, it, spyOn, vi } from "bun:test";
import * as daemonModule from "../src/daemon";
import * as detectionModule from "../src/detection";
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

let detectEmacsSpy: ReturnType<typeof spyOn>;
let startEmacsSessionSpy: ReturnType<typeof spyOn>;

beforeEach(() => {
	detectEmacsSpy = spyOn(detectionModule, "detectEmacs");
	startEmacsSessionSpy = spyOn(daemonModule, "startEmacsSession");
});

afterEach(() => {
	vi.restoreAllMocks();
});

describe("startEmacsDaemon", () => {
	it("returns null when emacs binary is not found", async () => {
		detectEmacsSpy.mockResolvedValue({
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
		expect(startEmacsSessionSpy).not.toHaveBeenCalled();
	});

	it("returns null when emacs version is below minimum", async () => {
		detectEmacsSpy.mockResolvedValue({
			...AVAILABLE_DETECTION,
			meetsMinimum: false,
			errors: ["Emacs 28.1 is below minimum 29.1"],
		});

		const result = await startEmacsDaemon(undefined, "/tmp/proj", "s1");

		expect(result).toBeNull();
		expect(startEmacsSessionSpy).not.toHaveBeenCalled();
	});

	it("returns null when socat is missing", async () => {
		detectEmacsSpy.mockResolvedValue({
			...AVAILABLE_DETECTION,
			socatFound: false,
			socatPath: null,
			errors: ["socat not found"],
		});

		const result = await startEmacsDaemon(undefined, "/tmp/proj", "s1");

		expect(result).toBeNull();
		expect(startEmacsSessionSpy).not.toHaveBeenCalled();
	});

	it("returns null when treesit is not compiled into this Emacs build", async () => {
		detectEmacsSpy.mockResolvedValue({ ...AVAILABLE_DETECTION, treesitAvailable: false });

		const result = await startEmacsDaemon(undefined, "/tmp/proj", "s1");

		expect(result).toBeNull();
		expect(startEmacsSessionSpy).not.toHaveBeenCalled();
	});

	it("returns null without throwing when startEmacsSession throws", async () => {
		detectEmacsSpy.mockResolvedValue(AVAILABLE_DETECTION);
		startEmacsSessionSpy.mockRejectedValue(new Error("socket timeout"));

		const result = await startEmacsDaemon(undefined, "/tmp/proj", "s1");

		expect(result).toBeNull();
	});

	it("returns the EmacsSession on success", async () => {
		detectEmacsSpy.mockResolvedValue(AVAILABLE_DETECTION);
		startEmacsSessionSpy.mockResolvedValue(mockSession);

		const result = await startEmacsDaemon(undefined, "/tmp/proj", "s1");

		expect(result).toBe(mockSession);
		expect(startEmacsSessionSpy).toHaveBeenCalledTimes(1);
	});

	it("passes the configured emacs path to detectEmacs", async () => {
		detectEmacsSpy.mockResolvedValue(AVAILABLE_DETECTION);
		startEmacsSessionSpy.mockResolvedValue(mockSession);

		await startEmacsDaemon("/opt/emacs/bin/emacs", "/tmp/proj", "s1");

		expect(detectEmacsSpy).toHaveBeenCalledWith("/opt/emacs/bin/emacs");
	});
});
