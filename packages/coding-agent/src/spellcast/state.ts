import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { SpellcastPublishState, SpellcastPublishStateIndex } from "./index";

export const DEFAULT_SPELLCAST_STATE_PATH = path.join(".local", "spellcast-state.json");

function isPublishState(value: unknown): value is SpellcastPublishState {
	if (typeof value !== "object" || value === null) return false;
	const record = value as Record<string, unknown>;
	return (
		typeof record.manifestPath === "string" &&
		typeof record.appId === "string" &&
		typeof record.appUrl === "string" &&
		(record.visibility === "public" || record.visibility === "unlisted") &&
		typeof record.updatedAt === "string"
	);
}

export async function loadSpellcastPublishState(cwd: string): Promise<SpellcastPublishStateIndex> {
	const statePath = path.join(cwd, DEFAULT_SPELLCAST_STATE_PATH);
	let raw: string;
	try {
		raw = await Bun.file(statePath).text();
	} catch {
		return {};
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return {};
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		return {};
	}

	const entries = Object.entries(parsed as Record<string, unknown>);
	const validEntries = entries.filter((entry): entry is [string, SpellcastPublishState] => isPublishState(entry[1]));
	return Object.fromEntries(validEntries);
}

export async function writeSpellcastPublishState(cwd: string, state: SpellcastPublishStateIndex): Promise<void> {
	const statePath = path.join(cwd, DEFAULT_SPELLCAST_STATE_PATH);
	await fs.mkdir(path.dirname(statePath), { recursive: true });
	await Bun.write(statePath, JSON.stringify(state, null, 2));
}
