import type { AgentStatus, SessionStatusFile } from "@spell/pi-desktop-common";
import { StatusFileReader } from "@spell/pi-desktop-common";
import { logger } from "@spell/pi-utils";

interface StatusReader {
	readAll(): Promise<SessionStatusFile[]>;
}

const URGENCY_ORDER: Record<AgentStatus, number> = {
	needs_input: 0,
	pending_approval: 1,
	error: 2,
	running: 3,
	user_paused: 4,
	idle: 5,
	completed: 6,
};

export type SessionTransitionCallback = (session: SessionStatusFile, prevStatus: AgentStatus | null) => void;
export type SessionUpdateCallback = (sessions: readonly SessionStatusFile[]) => void;

export class SessionService {
	#reader: StatusReader;
	#sessions: SessionStatusFile[] = [];
	#previousStatuses = new Map<string, AgentStatus>();
	#timer: NodeJS.Timeout | undefined;
	#onTransition: SessionTransitionCallback | undefined;
	#onUpdate: SessionUpdateCallback | undefined;
	#pollIntervalMs: number;

	constructor(pollIntervalMs = 2000, reader: StatusReader = new StatusFileReader()) {
		this.#reader = reader;
		this.#pollIntervalMs = pollIntervalMs;
	}

	get sessions(): readonly SessionStatusFile[] {
		return this.#sessions;
	}

	get hasAttentionNeeded(): boolean {
		return this.#sessions.some(session => session.status === "needs_input" || session.status === "pending_approval");
	}

	onTransition(callback: SessionTransitionCallback): void {
		this.#onTransition = callback;
	}

	onUpdate(callback: SessionUpdateCallback): void {
		this.#onUpdate = callback;
	}

	start(): void {
		if (this.#timer) return;
		void this.pollNow();
		this.#timer = setInterval(() => void this.pollNow(), this.#pollIntervalMs);
	}

	stop(): void {
		if (!this.#timer) return;
		clearInterval(this.#timer);
		this.#timer = undefined;
	}

	async pollNow(): Promise<readonly SessionStatusFile[]> {
		try {
			const sessions = await this.#reader.readAll();
			sessions.sort((left, right) => {
				const urgencyDiff = (URGENCY_ORDER[left.status] ?? 99) - (URGENCY_ORDER[right.status] ?? 99);
				if (urgencyDiff !== 0) return urgencyDiff;
				return right.updatedAt - left.updatedAt;
			});
			this.#sessions = sessions;

			if (this.#onTransition) {
				for (const session of sessions) {
					const key = String(session.windowId);
					const previousStatus = this.#previousStatuses.get(key) ?? null;
					if (previousStatus !== session.status) {
						this.#onTransition(session, previousStatus);
					}
				}
			}

			this.#previousStatuses.clear();
			for (const session of sessions) {
				this.#previousStatuses.set(String(session.windowId), session.status);
			}

			this.#onUpdate?.(this.#sessions);
			return this.#sessions;
		} catch (error) {
			logger.debug("SessionService: poll failed", { err: String(error) });
			return this.#sessions;
		}
	}
}
