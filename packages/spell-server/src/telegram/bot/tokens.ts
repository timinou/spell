import * as crypto from "node:crypto";
import * as os from "node:os";
import * as path from "node:path";
import { isEnoent, logger } from "@spell/pi-utils";
import type { TempToken } from "../../rpc/bridge-types";

const DEFAULT_EXPIRY_MS = 24 * 60 * 60 * 1000;
const TOKEN_STORE_PATH = path.join(os.homedir(), ".spell", "telegram-tokens.json");

interface TokenStoreFile {
	tokens: TempToken[];
}

function isTempToken(value: unknown): value is TempToken {
	if (!value || typeof value !== "object") {
		return false;
	}
	const candidate = value as Partial<TempToken>;
	return (
		typeof candidate.token === "string" &&
		typeof candidate.createdAt === "number" &&
		typeof candidate.expiresAt === "number" &&
		(candidate.claimedBy === undefined || typeof candidate.claimedBy === "string")
	);
}

export class TokenStore {
	#tokens = new Map<string, TempToken>();
	#storePath: string;

	constructor(storePath = TOKEN_STORE_PATH) {
		this.#storePath = storePath;
	}

	generate(expiresInMs = DEFAULT_EXPIRY_MS): TempToken {
		const now = Date.now();
		const token: TempToken = {
			token: crypto.randomBytes(16).toString("base64url"),
			createdAt: now,
			expiresAt: now + expiresInMs,
		};
		this.#tokens.set(token.token, token);
		return token;
	}

	validate(token: string): TempToken | null {
		const entry = this.#tokens.get(token);
		if (!entry) {
			return null;
		}
		if (entry.expiresAt <= Date.now()) {
			this.#tokens.delete(token);
			return null;
		}
		return entry;
	}

	claim(token: string, userId: string): boolean {
		const entry = this.validate(token);
		if (!entry) {
			return false;
		}
		if (entry.claimedBy && entry.claimedBy !== userId) {
			return false;
		}
		entry.claimedBy = userId;
		this.#tokens.set(token, entry);
		return true;
	}

	revoke(token: string): void {
		this.#tokens.delete(token);
	}

	findClaimedByUser(userId: string): TempToken | null {
		for (const token of this.#tokens.values()) {
			if (token.claimedBy !== userId) {
				continue;
			}
			if (token.expiresAt <= Date.now()) {
				this.#tokens.delete(token.token);
				continue;
			}
			return token;
		}
		return null;
	}

	async save(): Promise<void> {
		const now = Date.now();
		const persistedTokens = Array.from(this.#tokens.values()).filter(token => token.expiresAt > now);
		const payload: TokenStoreFile = {
			tokens: persistedTokens,
		};
		await Bun.write(this.#storePath, JSON.stringify(payload, null, 2));
	}

	async load(): Promise<void> {
		let text: string;
		try {
			text = await Bun.file(this.#storePath).text();
		} catch (err) {
			if (isEnoent(err)) {
				return;
			}
			throw err;
		}

		let parsed: unknown;
		try {
			parsed = JSON.parse(text);
		} catch {
			logger.warn("Ignoring malformed telegram token store", { path: this.#storePath });
			return;
		}

		if (!parsed || typeof parsed !== "object") {
			return;
		}

		const parsedTokens = (parsed as Partial<TokenStoreFile>).tokens;
		if (!Array.isArray(parsedTokens)) {
			return;
		}

		this.#tokens.clear();
		for (const entry of parsedTokens) {
			if (!isTempToken(entry)) {
				continue;
			}
			if (entry.expiresAt <= Date.now()) {
				continue;
			}
			this.#tokens.set(entry.token, entry);
		}
	}
}
