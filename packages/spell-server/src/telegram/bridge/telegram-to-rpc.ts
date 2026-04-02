import * as path from "node:path";
import { logger } from "@oh-my-pi/pi-utils";
import type { Context } from "grammy";
import type { RpcClient } from "../../rpc/rpc-client";
import type { ImageContentRef } from "../../rpc/types";
import type { AuthContext } from "../bot/auth";

interface TelegramPhoto {
	file_id: string;
	file_size?: number;
}

interface TelegramDocument {
	file_id: string;
	file_name?: string;
	mime_type?: string;
}

interface TelegramIncomingMessage {
	text?: string;
	photo?: TelegramPhoto[];
	document?: TelegramDocument;
}

interface FileDownloadResult {
	bytes: Uint8Array;
	mediaType: string;
}

interface FileLinkApi {
	getFileLink?: (fileId: string) => Promise<URL>;
	token?: string;
}

const TEXT_FILE_EXTENSIONS = new Set([
	".txt",
	".md",
	".json",
	".yaml",
	".yml",
	".ts",
	".tsx",
	".js",
	".jsx",
	".mjs",
	".cjs",
	".py",
	".rs",
	".go",
	".java",
	".c",
	".cc",
	".cpp",
	".h",
	".hpp",
	".css",
	".html",
	".xml",
	".toml",
	".ini",
	".log",
]);

function getIncomingMessage(ctx: Context): TelegramIncomingMessage | null {
	const message = ctx.message;
	if (!message || typeof message !== "object") {
		return null;
	}
	return message as unknown as TelegramIncomingMessage;
}

function isTextDocument(document: TelegramDocument): boolean {
	if (document.mime_type?.startsWith("text/")) {
		return true;
	}
	if (!document.file_name) {
		return false;
	}
	return TEXT_FILE_EXTENSIONS.has(path.extname(document.file_name).toLowerCase());
}

async function resolveFileUrl(ctx: AuthContext, fileId: string, filePath: string): Promise<string> {
	const api = ctx.api as unknown as FileLinkApi;
	if (api.getFileLink) {
		const fileUrl = await api.getFileLink(fileId);
		return fileUrl.toString();
	}
	if (typeof api.token === "string" && api.token.length > 0) {
		return `https://api.telegram.org/file/bot${api.token}/${filePath}`;
	}
	if (filePath.startsWith("http://") || filePath.startsWith("https://")) {
		return filePath;
	}
	return filePath;
}

async function downloadTelegramFile(
	ctx: AuthContext,
	fileId: string,
	fallbackMediaType: string,
): Promise<FileDownloadResult> {
	const telegramFile = await ctx.api.getFile(fileId);
	if (!telegramFile.file_path) {
		throw new Error(`Telegram file path missing for ${fileId}`);
	}

	const fileUrl = await resolveFileUrl(ctx, fileId, telegramFile.file_path);
	const response = await fetch(fileUrl);
	if (!response.ok) {
		throw new Error(`Failed to download Telegram file: ${response.status}`);
	}

	const bytes = new Uint8Array(await response.arrayBuffer());
	const mediaType = response.headers.get("content-type") ?? fallbackMediaType;
	return { bytes, mediaType };
}

function pickLargestPhoto(photos: TelegramPhoto[]): TelegramPhoto {
	if (photos.length === 0) {
		throw new Error("pickLargestPhoto requires a non-empty array");
	}

	let largest = photos[0]!;
	for (const photo of photos) {
		if ((photo.file_size ?? 0) > (largest.file_size ?? 0)) {
			largest = photo;
		}
	}
	return largest;
}

async function collectImages(ctx: AuthContext, message: TelegramIncomingMessage): Promise<ImageContentRef[]> {
	if (!message.photo || message.photo.length === 0) {
		return [];
	}

	const selectedPhoto = pickLargestPhoto(message.photo);
	try {
		const downloaded = await downloadTelegramFile(ctx, selectedPhoto.file_id, "image/jpeg");
		return [
			{
				type: "base64",
				media_type: downloaded.mediaType,
				data: Buffer.from(downloaded.bytes).toString("base64"),
			},
		];
	} catch (error) {
		logger.warn("Failed to download Telegram photo, skipping image", {
			error: String(error),
			fileId: selectedPhoto.file_id,
		});
		return [];
	}
}

async function readDocumentContext(ctx: AuthContext, message: TelegramIncomingMessage): Promise<string | null> {
	const document = message.document;
	if (!document || !isTextDocument(document)) {
		return null;
	}

	const fileName = document.file_name ?? "document";
	try {
		const downloaded = await downloadTelegramFile(ctx, document.file_id, document.mime_type ?? "text/plain");
		const documentText = new TextDecoder().decode(downloaded.bytes).trim();
		if (!documentText) {
			return null;
		}
		return `Attached file (${fileName}):\n${documentText}`;
	} catch (error) {
		logger.warn("Failed to download Telegram document context, skipping document", {
			error: String(error),
			fileId: document.file_id,
		});
		return null;
	}
}

export async function handleTelegramMessage(ctx: AuthContext, rpcClient: RpcClient): Promise<void> {
	try {
		const message = getIncomingMessage(ctx);
		if (!message) {
			await ctx.reply("Could not process this message.");
			return;
		}

		const text = message.text?.trim() ?? "";
		const images = await collectImages(ctx, message);
		const documentContext = await readDocumentContext(ctx, message);

		const promptBody = [documentContext, text]
			.filter(part => Boolean(part))
			.join("\n\n")
			.trim();
		const promptMessage =
			promptBody || (images.length > 0 ? "User sent an image without text." : "User sent an empty message.");

		await rpcClient.prompt(promptMessage, images.length > 0 ? images : undefined);
	} catch (error) {
		logger.error("Failed handling Telegram message", { error: String(error) });
		await ctx.reply(`Failed to send message to assistant: ${String(error)}`);
	}
}
