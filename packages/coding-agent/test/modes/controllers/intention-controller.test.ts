import { describe, expect, test } from "bun:test";
import type { AgentStatus, AgentStatusContext } from "@oh-my-pi/pi-desktop-common";
import { IntentionController, type IntentionControllerDeps } from "../../../src/modes/controllers/intention-controller";
import {
	buildIntentionSummaryContent,
	INTENTION_SUMMARY_MESSAGE_TYPE,
	type IntentionSummaryDetails,
} from "../../../src/session/messages";
import type { SessionManager } from "../../../src/session/session-manager";
import type { BlockingEventLike, IntentionSummaryResult } from "../../../src/utils/intention-summarizer";

interface FakeEntry {
	type: string;
	id: string;
	customType?: string;
	content: string | unknown;
	details?: unknown;
	display: boolean;
	parentId: string | null;
	timestamp: string;
}

function createFakeSessionManager(initialEntries: FakeEntry[] = []) {
	const entries = [...initialEntries];
	return {
		entries,
		appendCustomMessageEntry<T>(
			customType: string,
			content: string,
			display: boolean,
			details?: T,
			_attribution?: string,
		) {
			const id = `entry-${entries.length}`;
			entries.push({
				type: "custom_message",
				id,
				customType,
				content,
				details,
				display,
				parentId: null,
				timestamp: new Date().toISOString(),
			});
			return id;
		},
		getEntries() {
			return [...entries] as unknown as ReturnType<SessionManager["getEntries"]>;
		},
		async rewriteEntries() {
			// no-op: in-place mutations already applied
		},
	} as unknown as SessionManager;
}

function createFakeDeps(overrides?: Partial<IntentionControllerDeps>): IntentionControllerDeps {
	return {
		sessionManager: createFakeSessionManager(),
		settings: {} as IntentionControllerDeps["settings"],
		modelRegistry: {} as IntentionControllerDeps["modelRegistry"],
		getStatusContext: (): AgentStatusContext => ({
			isStreaming: false,
			isPendingApproval: false,
			isAwaitingHookInput: false,
			isUserPaused: false,
			hasInputCallback: false,
			todoPhases: [],
		}),
		getCurrentBlockingEvent: () => undefined,
		getCurrentModel: () => undefined,
		getSessionId: () => "test-session",
		getFirstUserMessage: () => "hello world",
		getRecentAssistantTexts: () => [],
		getInProgressTodoTitles: () => [],
		getSessionTitle: () => undefined,
		generate: async () => null,
		...overrides,
	};
}

async function flushAsync(): Promise<void> {
	await new Promise(r => setTimeout(r, 0));
}

describe("IntentionController", () => {
	describe("T1: rising edge into needs_input fires briefing", () => {
		test("appends placeholder then resolves with generator result", async () => {
			const { promise, resolve } = Promise.withResolvers<IntentionSummaryResult | null>();
			const deps = createFakeDeps({
				getCurrentBlockingEvent: () =>
					({ kind: "hook_input", eventId: "in-1", title: "What next?" }) as BlockingEventLike,
				generate: async () => promise,
			});

			const controller = new IntentionController(deps);
			controller.handleStatusChange(null, "needs_input");
			await flushAsync();

			const entries = deps.sessionManager.getEntries();
			expect(entries.length).toBe(1);

			const first = entries[0] as unknown as FakeEntry;
			expect(first.customType).toBe(INTENTION_SUMMARY_MESSAGE_TYPE);
			expect(first.display).toBe(true);
			const details1 = first.details as IntentionSummaryDetails;
			expect(details1.pending).toBe(true);
			expect(details1.trigger).toBe("needs_input");
			expect(details1.eventId).toBe("in-1");

			// Resolve generator and wait for update
			resolve({ did: "coded", ask: "Review the PR", stuck: "waiting for review" });
			await flushAsync();

			const updated = deps.sessionManager.getEntries()[0] as unknown as FakeEntry;
			const details2 = updated.details as IntentionSummaryDetails;
			expect(details2.pending).toBe(false);
			expect(details2.did).toBe("coded");
			expect(details2.ask).toBe("Review the PR");
			expect(details2.stuck).toBe("waiting for review");
			expect(updated.content).toBe(buildIntentionSummaryContent(details2));
		});
	});

	describe("T2: needs_input → user_paused → needs_input fires only once", () => {
		test("does not re-fire when toggling user_paused off", async () => {
			const deps = createFakeDeps({
				generate: async () => ({ did: "x", ask: "y" }) as IntentionSummaryResult,
			});

			const controller = new IntentionController(deps);
			controller.handleStatusChange(null, "needs_input");
			await flushAsync();

			controller.handleStatusChange("needs_input", "user_paused");
			await flushAsync();

			controller.handleStatusChange("user_paused", "needs_input");
			await flushAsync();

			const entries = deps.sessionManager.getEntries();
			expect(entries.length).toBe(1);
		});
	});

	describe("T3: falling edge before gen resolves aborts and supersedes", () => {
		test("marks placeholder superseded when leaving briefing state before resolve", async () => {
			let resolveGen: ((v: IntentionSummaryResult | null) => void) | undefined;
			const deps = createFakeDeps({
				generate: async () =>
					new Promise<IntentionSummaryResult | null>(res => {
						resolveGen = res;
					}),
			});

			const controller = new IntentionController(deps);
			controller.handleStatusChange(null, "needs_input");
			await flushAsync();

			// Before generator resolves, transition out
			controller.handleStatusChange("needs_input", "running");
			await flushAsync();

			// Now let the generator finish (it should be aborted / ignored)
			resolveGen?.({ did: "should-not-apply", ask: "nope" });
			await flushAsync();

			const entries = deps.sessionManager.getEntries();
			expect(entries.length).toBe(1);
			const details = (entries[0] as unknown as FakeEntry).details as IntentionSummaryDetails;
			expect(details.superseded).toBe(true);
			expect(details.pending).toBe(false);
		});
	});

	describe("T4: rising into pending_approval", () => {
		test("uses trigger pending_approval", async () => {
			const deps = createFakeDeps({
				generate: async () => ({ did: "planned", ask: "Approve plan" }) as IntentionSummaryResult,
			});

			const controller = new IntentionController(deps);
			controller.handleStatusChange(null, "pending_approval");
			await flushAsync();
			await flushAsync();

			const entries = deps.sessionManager.getEntries();
			expect(entries.length).toBe(1);
			const details = (entries[0] as unknown as FakeEntry).details as IntentionSummaryDetails;
			expect(details.trigger).toBe("pending_approval");
			expect(details.pending).toBe(false);
		});
	});

	describe("T5: non-briefing transitions do NOT fire", () => {
		test.each<[AgentStatus]>([
			["error"],
			["completed"],
			["idle"],
			["running"],
		])("status %s does not append entry", async status => {
			const deps = createFakeDeps();
			const controller = new IntentionController(deps);
			controller.handleStatusChange(null, status);
			await flushAsync();

			expect(deps.sessionManager.getEntries().length).toBe(0);
		});
	});

	describe("T6: new briefing after resolved prior supersedes old entry", () => {
		test("prior entry gets superseded, fresh entry appended", async () => {
			const deps = createFakeDeps({
				generate: async () => ({ did: "a", ask: "b" }) as IntentionSummaryResult,
			});

			const controller = new IntentionController(deps);
			controller.handleStatusChange(null, "needs_input");
			await flushAsync();
			await flushAsync();

			// Leave briefing state
			controller.handleStatusChange("needs_input", "running");
			await flushAsync();

			// Re-enter
			controller.handleStatusChange("running", "needs_input");
			await flushAsync();
			await flushAsync();

			const entries = deps.sessionManager.getEntries();
			expect(entries.length).toBe(2);

			const first = (entries[0] as unknown as FakeEntry).details as IntentionSummaryDetails;
			expect(first.superseded).toBe(true);
			expect(first.pending).toBe(false);

			const second = (entries[1] as unknown as FakeEntry).details as IntentionSummaryDetails;
			expect(second.superseded).toBeUndefined();
			expect(second.pending).toBe(false);
		});
	});

	describe("T7: generator returns null resolves with fallback ask", () => {
		test("ask falls back to blockingEvent.title", async () => {
			const deps = createFakeDeps({
				getCurrentBlockingEvent: () =>
					({ kind: "hook_input", eventId: "in-2", title: "Pick a file" }) as BlockingEventLike,
				generate: async () => null,
			});

			const controller = new IntentionController(deps);
			controller.handleStatusChange(null, "needs_input");
			await flushAsync();
			await flushAsync();

			const entries = deps.sessionManager.getEntries();
			const details = (entries[0] as unknown as FakeEntry).details as IntentionSummaryDetails;
			expect(details.ask).toBe("Pick a file");
			expect(details.did).toBe("");
			expect(details.stuck).toBeUndefined();
			expect(details.pending).toBe(false);
		});

		test("ask falls back to 'Awaiting input' when no blocking event", async () => {
			const deps = createFakeDeps({
				generate: async () => null,
			});

			const controller = new IntentionController(deps);
			controller.handleStatusChange(null, "needs_input");
			await flushAsync();
			await flushAsync();

			const entries = deps.sessionManager.getEntries();
			const details = (entries[0] as unknown as FakeEntry).details as IntentionSummaryDetails;
			expect(details.ask).toBe("Awaiting input");
		});
	});

	describe("T8: orphan rehydration on construct", () => {
		test("marks pending orphan as superseded and does not regenerate", async () => {
			const orphanDetails: IntentionSummaryDetails = {
				did: "old",
				ask: "old ask",
				trigger: "needs_input",
				pending: true,
			};
			const initialEntry: FakeEntry = {
				type: "custom_message",
				id: "orphan-1",
				customType: INTENTION_SUMMARY_MESSAGE_TYPE,
				content: buildIntentionSummaryContent(orphanDetails),
				details: orphanDetails,
				display: true,
				parentId: null,
				timestamp: new Date().toISOString(),
			};
			const deps = createFakeDeps({
				sessionManager: createFakeSessionManager([initialEntry]),
				getStatusContext: (): AgentStatusContext => ({
					isStreaming: false,
					isPendingApproval: false,
					isAwaitingHookInput: false,
					isUserPaused: false,
					hasInputCallback: true,
					todoPhases: [],
				}),
				generate: async () => ({ did: "new", ask: "new ask" }) as IntentionSummaryResult,
			});

			new IntentionController(deps);
			await flushAsync();

			const entries = deps.sessionManager.getEntries();
			expect(entries.length).toBe(1);
			const details = (entries[0] as unknown as FakeEntry).details as IntentionSummaryDetails;
			expect(details.pending).toBe(false);
			expect(details.superseded).toBe(true);
		});
	});

	describe("T9: non-orphan history + stable status does not re-fire", () => {
		test("controller initialized in needs_input with resolved history does not fire on same-status callback", async () => {
			const historyDetails: IntentionSummaryDetails = {
				did: "done",
				ask: "done ask",
				trigger: "needs_input",
				pending: false,
			};
			const initialEntry: FakeEntry = {
				type: "custom_message",
				id: "hist-1",
				customType: INTENTION_SUMMARY_MESSAGE_TYPE,
				content: buildIntentionSummaryContent(historyDetails),
				details: historyDetails,
				display: true,
				parentId: null,
				timestamp: new Date().toISOString(),
			};
			const deps = createFakeDeps({
				sessionManager: createFakeSessionManager([initialEntry]),
				getStatusContext: (): AgentStatusContext => ({
					isStreaming: false,
					isPendingApproval: false,
					isAwaitingHookInput: false,
					isUserPaused: false,
					hasInputCallback: true,
					todoPhases: [],
				}),
				generate: async () => ({ did: "should-not-fire", ask: "nope" }) as IntentionSummaryResult,
			});

			const controller = new IntentionController(deps);
			await flushAsync();

			// Same status callback
			controller.handleStatusChange("needs_input", "needs_input");
			await flushAsync();

			const entries = deps.sessionManager.getEntries();
			expect(entries.length).toBe(1);
			const details = (entries[0] as unknown as FakeEntry).details as IntentionSummaryDetails;
			expect(details.did).toBe("done");
		});
	});
});
