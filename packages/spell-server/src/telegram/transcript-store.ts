import * as fs from "node:fs/promises";
import * as path from "node:path";
import { logger } from "@oh-my-pi/pi-utils";
import type { RpcEvent } from "../rpc/types";

function sanitizeTranscriptKey(chatId: string): string {
	const sanitized = chatId
		.toLowerCase()
		.replace(/[^a-z0-9_-]+/g, "-")
		.replace(/^-+|-+$/g, "");
	return sanitized || "chat";
}

function buildTranscriptPath(rootDir: string, chatId: string, createdAt: number): string {
	const timestamp = new Date(createdAt).toISOString().replace(/[:.]/g, "-");
	return path.join(rootDir, "transcripts", `${timestamp}_${sanitizeTranscriptKey(chatId)}.jsonl`);
}

export interface RpcTranscriptWriter {
	path: string;
	append(event: RpcEvent): void;
	flush(): Promise<void>;
}

class FileRpcTranscriptWriter implements RpcTranscriptWriter {
	#path: string;
	#pending: Promise<void> = Promise.resolve();

	constructor(pathValue: string) {
		this.#path = pathValue;
	}

	get path(): string {
		return this.#path;
	}

	async ensureFile(): Promise<void> {
		await fs.mkdir(path.dirname(this.#path), { recursive: true });
		await fs.appendFile(this.#path, "");
	}

	append(event: RpcEvent): void {
		const line = `${JSON.stringify(event)}\n`;
		this.#pending = this.#pending
			.then(() => fs.appendFile(this.#path, line))
			.catch(error => {
				logger.error("Failed to append Telegram transcript event", {
					transcriptPath: this.#path,
					error: String(error),
				});
			});
	}

	async flush(): Promise<void> {
		await this.#pending;
	}
}

export async function createRpcTranscriptWriter(
	rootDir: string,
	chatId: string,
	createdAt: number,
	restoredPath?: string,
): Promise<RpcTranscriptWriter> {
	const writer = new FileRpcTranscriptWriter(restoredPath ?? buildTranscriptPath(rootDir, chatId, createdAt));
	await writer.ensureFile();
	return writer;
}
