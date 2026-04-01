import { describe, expect, it } from "bun:test";
import type { SessionStatusFile } from "@oh-my-pi/pi-desktop-common";
import { SessionService } from "../src/session-service";

class FakeReader {
	readonly #sessions: SessionStatusFile[];

	constructor(sessions: SessionStatusFile[]) {
		this.#sessions = sessions;
	}

	async readAll(): Promise<SessionStatusFile[]> {
		return [...this.#sessions];
	}
}

function makeSession(overrides: Partial<SessionStatusFile>): SessionStatusFile {
	return {
		status: "idle",
		windowId: 1,
		pid: 123,
		projectName: "app",
		sessionTitle: "session",
		updatedAt: 1,
		...overrides,
	};
}

describe("SessionService", () => {
	it("sorts sessions by urgency then recency", async () => {
		const service = new SessionService(
			2000,
			new FakeReader([
				makeSession({ windowId: 1, status: "idle", updatedAt: 10 }),
				makeSession({ windowId: 2, status: "needs_input", updatedAt: 5 }),
				makeSession({ windowId: 3, status: "running", updatedAt: 20 }),
				makeSession({ windowId: 4, status: "running", updatedAt: 30 }),
			]),
		);
		const sessions = await service.pollNow();
		expect(sessions.map(session => session.windowId)).toEqual([2, 4, 3, 1]);
	});

	it("reports attention-needed sessions", async () => {
		const service = new SessionService(2000, new FakeReader([makeSession({ status: "pending_approval" })]));
		await service.pollNow();
		expect(service.hasAttentionNeeded).toBe(true);
	});

	it("emits transition callback when status changes from previous poll", async () => {
		let current = [makeSession({ windowId: 9, status: "running" })];
		const reader = {
			async readAll(): Promise<SessionStatusFile[]> {
				return [...current];
			},
		};
		const service = new SessionService(2000, reader);
		const transitions: string[] = [];
		service.onTransition((session, previousStatus) => {
			transitions.push(`${previousStatus ?? "null"}->${session.status}`);
		});
		await service.pollNow();
		current = [makeSession({ windowId: 9, status: "needs_input" })];
		await service.pollNow();
		expect(transitions).toEqual(["null->running", "running->needs_input"]);
	});
});
