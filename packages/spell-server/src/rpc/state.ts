import * as os from "node:os";
import * as path from "node:path";
import { isEnoent, logger } from "@oh-my-pi/pi-utils";
import type { BridgeState, ChatSession } from "./bridge-types";

const STATE_FILE_PATH = path.join(os.homedir(), ".spell", "telegram-state.json");
const EMPTY_STATE: BridgeState = { sessions: {} };

function parseBridgeState(raw: unknown): BridgeState {
	if (!raw || typeof raw !== "object") return EMPTY_STATE;
	const record = raw as Record<string, unknown>;
	if (!record.sessions || typeof record.sessions !== "object") return EMPTY_STATE;

	const rawSessions = record.sessions as Record<string, unknown>;
	const sessions: BridgeState["sessions"] = {};

	for (const [chatId, entry] of Object.entries(rawSessions)) {
		if (!entry || typeof entry !== "object") continue;
		const value = entry as Record<string, unknown>;
		if (typeof value.project !== "string" || typeof value.mode !== "string" || typeof value.userId !== "string") {
			continue;
		}

		const sessionPath = typeof value.sessionPath === "string" ? value.sessionPath : undefined;
		const transcriptPath = typeof value.transcriptPath === "string" ? value.transcriptPath : undefined;
		if (!sessionPath && !transcriptPath) {
			continue;
		}

		sessions[chatId] = {
			sessionPath,
			transcriptPath,
			project: value.project,
			mode: value.mode,
			userId: value.userId,
		};
	}

	return { sessions };
}

export async function saveBridgeState(sessions: Map<string, ChatSession>): Promise<void> {
	const state: BridgeState = { sessions: {} };

	for (const [chatId, session] of sessions) {
		if (!session.sessionPath && !session.transcriptPath) continue;
		state.sessions[chatId] = {
			sessionPath: session.sessionPath,
			transcriptPath: session.transcriptPath,
			project: session.project,
			mode: session.mode,
			userId: session.userId,
		};
	}

	await Bun.write(STATE_FILE_PATH, `${JSON.stringify(state, null, 2)}\n`);
}

export async function loadBridgeState(): Promise<BridgeState> {
	try {
		const parsed = (await Bun.file(STATE_FILE_PATH).json()) as unknown;
		return parseBridgeState(parsed);
	} catch (error) {
		if (isEnoent(error)) {
			return EMPTY_STATE;
		}
		logger.warn("Failed to load telegram bridge state; starting empty", { error: String(error) });
		return EMPTY_STATE;
	}
}
