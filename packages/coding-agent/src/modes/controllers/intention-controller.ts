import type { Api, Model } from "@spell/pi-ai";
import type { AgentStatus, AgentStatusContext } from "@spell/pi-desktop-common";
import { deriveAgentStatus } from "@spell/pi-desktop-common";
import type { ModelRegistry } from "../../config/model-registry";
import type { Settings } from "../../config/settings";
import {
	buildIntentionSummaryContent,
	INTENTION_SUMMARY_MESSAGE_TYPE,
	type IntentionSummaryDetails,
} from "../../session/messages";
import type { CustomMessageEntry, SessionManager } from "../../session/session-manager";
import { type BlockingEventLike, generateIntentionSummary } from "../../utils/intention-summarizer";

const BRIEFING_STATES = new Set<AgentStatus>(["needs_input", "pending_approval"]);

export interface IntentionControllerDeps {
	sessionManager: SessionManager;
	settings: Settings;
	modelRegistry: ModelRegistry;
	getStatusContext(): AgentStatusContext;
	getCurrentBlockingEvent(): BlockingEventLike | undefined;
	getCurrentModel(): Model<Api> | undefined;
	getSessionId(): string | undefined;
	getFirstUserMessage(): string;
	getRecentAssistantTexts(): string[];
	getInProgressTodoTitles(): string[];
	getSessionTitle(): string | undefined;
	/** Test hook to stub the summarizer. */
	generate?: typeof generateIntentionSummary;
}

export class IntentionController {
	#deps: IntentionControllerDeps;
	#pendingGen: AbortController | null = null;
	#activeEntryId: string | null = null;
	#disposed = false;

	constructor(deps: IntentionControllerDeps) {
		this.#deps = deps;
		this.#rehydrateFromHistory();
	}

	/** Public entry called from interactive-mode's session.subscribe callback. */
	handleStatusChange(prev: AgentStatus | null, next: AgentStatus): void {
		if (this.#disposed) return;
		if (prev === next) return;

		if (BRIEFING_STATES.has(next)) {
			if (prev !== "user_paused") {
				void this.#fireBriefing(next as "needs_input" | "pending_approval");
			}
		} else if (prev && BRIEFING_STATES.has(prev) && !BRIEFING_STATES.has(next)) {
			// Falling edge — abort any in-flight gen and supersede the active card.
			this.#pendingGen?.abort();
			this.#pendingGen = null;
			if (this.#activeEntryId) {
				const id = this.#activeEntryId;
				this.#activeEntryId = null;
				void this.#updateEntryDetails(id, d => ({ ...d, pending: false, superseded: true })).catch(() => {});
			}
		}


	}

	dispose(): void {
		this.#disposed = true;
		this.#pendingGen?.abort();
		this.#pendingGen = null;
	}

	/* === private === */

	#rehydrateFromHistory(): void {
		const entries = this.#deps.sessionManager.getEntries();
		for (let i = entries.length - 1; i >= 0; i--) {
			const entry = entries[i];
			if (entry.type === "custom_message" && entry.customType === INTENTION_SUMMARY_MESSAGE_TYPE) {
				const details = (entry as CustomMessageEntry<IntentionSummaryDetails>).details;
				if (details?.pending) {
					const fixed: IntentionSummaryDetails = { ...details, pending: false, superseded: true };
					(entry as CustomMessageEntry<IntentionSummaryDetails>).details = fixed;
					(entry as CustomMessageEntry<IntentionSummaryDetails>).content = buildIntentionSummaryContent(fixed);
					void this.#deps.sessionManager.rewriteEntries().catch(() => {});
				}
				break; // only the latest matters
			}
		}
		const currentStatus = deriveAgentStatus(this.#deps.getStatusContext());
		// Silence unused warning; status is tracked by the caller (InteractiveMode).
		void currentStatus;
	}

	async #fireBriefing(trigger: "needs_input" | "pending_approval"): Promise<void> {
		// 1. Abort any in-flight gen + supersede prior entries.
		this.#pendingGen?.abort();
		this.#pendingGen = null;
		await this.#supersedePrior();

		if (this.#disposed) return;

		// 2. Snapshot inputs synchronously.
		const blockingEvent = this.#deps.getCurrentBlockingEvent();
		const initialDetails: IntentionSummaryDetails = {
			did: "",
			ask: "",
			trigger,
			eventId: blockingEvent?.eventId,
			pending: true,
		};

		// 3. Append placeholder.
		const entryId = this.#deps.sessionManager.appendCustomMessageEntry<IntentionSummaryDetails>(
			INTENTION_SUMMARY_MESSAGE_TYPE,
			buildIntentionSummaryContent(initialDetails),
			/* display */ true,
			initialDetails,
			/* attribution */ "agent",
		);
		this.#activeEntryId = entryId;

		// 4. Kick off async gen.
		const ac = new AbortController();
		this.#pendingGen = ac;

		const input = {
			firstUserMessage: this.#deps.getFirstUserMessage(),
			recentAssistantTexts: this.#deps.getRecentAssistantTexts(),
			blockingEvent,
			inProgressTodoTitles: this.#deps.getInProgressTodoTitles(),
			sessionTitle: this.#deps.getSessionTitle(),
		};

		const generate = this.#deps.generate ?? generateIntentionSummary;

		try {
			const result = await generate(input, this.#deps.modelRegistry, this.#deps.settings, {
				sessionId: this.#deps.getSessionId(),
				currentModel: this.#deps.getCurrentModel(),
				signal: ac.signal,
			});

			if (ac.signal.aborted || this.#disposed) return;

			const fallbackAsk = blockingEvent?.title ?? "Awaiting input";
			const finalDetails: IntentionSummaryDetails = {
				did: result?.did ?? "",
				stuck: result?.stuck,
				ask: result?.ask ?? fallbackAsk,
				trigger,
				eventId: blockingEvent?.eventId,
				pending: false,
			};
			await this.#updateEntryDetails(entryId, () => finalDetails);
		} catch {
			if (ac.signal.aborted || this.#disposed) return;
			const fallbackAsk = blockingEvent?.title ?? "Awaiting input";
			await this.#updateEntryDetails(entryId, prev => ({ ...prev, pending: false, ask: fallbackAsk }));
		} finally {
			if (this.#pendingGen === ac) {
				this.#pendingGen = null;
			}
		}
	}

	async #supersedePrior(exceptEntryId?: string): Promise<void> {
		let mutated = false;
		const entries = this.#deps.sessionManager.getEntries();
		for (const entry of entries) {
			if (
				entry.type === "custom_message" &&
				entry.customType === INTENTION_SUMMARY_MESSAGE_TYPE &&
				entry.id !== exceptEntryId
			) {
				const customEntry = entry as CustomMessageEntry<IntentionSummaryDetails>;
				if (customEntry.details && !customEntry.details.superseded) {
					customEntry.details = { ...customEntry.details, superseded: true, pending: false };
					customEntry.content = buildIntentionSummaryContent(customEntry.details);
					mutated = true;
				}
			}
		}
		if (mutated) {
			await this.#deps.sessionManager.rewriteEntries();
		}
	}

	async #updateEntryDetails(
		entryId: string,
		mutator: (d: IntentionSummaryDetails) => IntentionSummaryDetails,
	): Promise<void> {
		const entries = this.#deps.sessionManager.getEntries();
		for (const entry of entries) {
			if (entry.id === entryId && entry.type === "custom_message") {
				const customEntry = entry as CustomMessageEntry<IntentionSummaryDetails>;
				if (customEntry.details) {
					customEntry.details = mutator(customEntry.details);
					customEntry.content = buildIntentionSummaryContent(customEntry.details);
					await this.#deps.sessionManager.rewriteEntries();
				}
				return;
			}
		}
	}
}
