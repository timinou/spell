import * as path from "node:path";
import { logger } from "@oh-my-pi/pi-utils";
import type { Context } from "grammy";
import type { VoiceConfig } from "../../config/types";
import type { RpcClient } from "../../rpc/rpc-client";
import type { ImageContentRef } from "../../rpc/types";
import type { AuthContext } from "../bot/auth";
import { extractAudioFromVideo, type SttProvider } from "../voice";

interface TelegramPhoto {
	file_id: string;
	file_size?: number;
}

interface TelegramDocument {
	file_id: string;
	file_name?: string;
	mime_type?: string;
}

interface TelegramVoice {
	file_id: string;
	duration: number;
	mime_type?: string;
	file_size?: number;
}

interface TelegramVideoNote {
	file_id: string;
	duration: number;
	length: number;
	file_size?: number;
}

interface TelegramAudio {
	file_id: string;
	duration: number;
	mime_type?: string;
	file_size?: number;
	title?: string;
}

interface TelegramIncomingMessage {
	text?: string;
	caption?: string;
	photo?: TelegramPhoto[];
	document?: TelegramDocument;
	voice?: TelegramVoice;
	video_note?: TelegramVideoNote;
	audio?: TelegramAudio;
}

interface FileDownloadResult {
	bytes: Uint8Array;
	mediaType: string;
}

interface FileLinkApi {
	getFileLink?: (fileId: string) => Promise<URL>;
	token?: string;
}

export interface HandleMessageOptions {
	sttProvider?: SttProvider;
	voiceConfig?: VoiceConfig;
}

const MAX_TEXT_DOCUMENT_BYTES = 512 * 1024;
const MAX_TEXT_SCAN_BYTES = 4096;
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

const VALID_IMAGE_MEDIA_TYPES = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);
const MISSING_STT_MESSAGE =
	"Voice messages require STT configuration. Add a voice { stt-provider ... } block to channels.kdl";
const VIDEO_NOTE_FFMPEG_MESSAGE =
	"Video note transcription requires ffmpeg. Install ffmpeg on the server and try again.";

function detectImageTypeFromBytes(bytes: Uint8Array): string | null {
	if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
		return "image/jpeg";
	}
	if (
		bytes.length >= 8 &&
		bytes[0] === 0x89 &&
		bytes[1] === 0x50 &&
		bytes[2] === 0x4e &&
		bytes[3] === 0x47 &&
		bytes[4] === 0x0d &&
		bytes[5] === 0x0a &&
		bytes[6] === 0x1a &&
		bytes[7] === 0x0a
	) {
		return "image/png";
	}
	if (bytes.length >= 4 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38) {
		return "image/gif";
	}
	if (
		bytes.length >= 12 &&
		bytes[0] === 0x52 &&
		bytes[1] === 0x49 &&
		bytes[2] === 0x46 &&
		bytes[3] === 0x46 &&
		bytes[8] === 0x57 &&
		bytes[9] === 0x45 &&
		bytes[10] === 0x42 &&
		bytes[11] === 0x50
	) {
		return "image/webp";
	}
	return null;
}

function normalizeImageMediaType(bytes: Uint8Array, headerMediaType: string, fallback: string): string {
	const stripped = headerMediaType.split(";")[0]!.trim().toLowerCase();
	if (VALID_IMAGE_MEDIA_TYPES.has(stripped)) return stripped;
	return detectImageTypeFromBytes(bytes) ?? fallback;
}

export {
	detectImageTypeFromBytes,
	MISSING_STT_MESSAGE,
	normalizeImageMediaType,
	VALID_IMAGE_MEDIA_TYPES,
	VIDEO_NOTE_FFMPEG_MESSAGE,
};

function isTextMimeType(mimeType: string | undefined): boolean {
	if (!mimeType) {
		return false;
	}

	if (mimeType.startsWith("text/")) {
		return true;
	}

	const normalized = mimeType.toLowerCase();
	return (
		normalized === "application/json" ||
		normalized === "application/xml" ||
		normalized === "application/x-yaml" ||
		normalized === "application/yaml"
	);
}

function isAudioMimeType(mimeType: string | undefined): boolean {
	return typeof mimeType === "string" && mimeType.toLowerCase().startsWith("audio/");
}

function appearsTextual(bytes: Uint8Array): boolean {
	if (bytes.length === 0) {
		return false;
	}

	const scanned = bytes.slice(0, Math.min(bytes.length, MAX_TEXT_SCAN_BYTES));
	let isInvalidUtf8 = false;
	let controlBytes = 0;

	for (const byte of scanned) {
		if (byte === 0x00) {
			return false;
		}
		if (byte < 0x20 && byte !== 0x09 && byte !== 0x0a && byte !== 0x0d) {
			controlBytes += 1;
		}
	}

	const controlRatio = controlBytes / scanned.length;
	if (controlRatio > 0.05) {
		return false;
	}

	try {
		new TextDecoder("utf-8", { fatal: true }).decode(scanned);
	} catch {
		isInvalidUtf8 = true;
	}

	return !isInvalidUtf8;
}

function getIncomingMessage(ctx: Context): TelegramIncomingMessage | null {
	const message = ctx.message;
	if (!message || typeof message !== "object") {
		return null;
	}
	return message as unknown as TelegramIncomingMessage;
}

function isTextDocument(document: TelegramDocument): boolean {
	if (isTextMimeType(document.mime_type)) {
		return true;
	}
	if (!document.file_name) {
		return false;
	}
	return TEXT_FILE_EXTENSIONS.has(path.extname(document.file_name).toLowerCase());
}

function unsupportedDocumentMessage(
	document: TelegramDocument,
	fileSize: number,
	mediaType: string,
	reason: string,
): string {
	const fileName = document.file_name ?? "document";
	const mimeType = document.mime_type ?? mediaType;
	return `Attached file (${fileName}): ${reason}. mime=${mimeType}, size=${fileSize} bytes.`;
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

export async function downloadTelegramFile(
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
				type: "image",
				mimeType: normalizeImageMediaType(downloaded.bytes, downloaded.mediaType, "image/jpeg"),
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
	if (!document || isAudioMimeType(document.mime_type)) {
		return null;
	}

	const fileName = document.file_name ?? "document";
	try {
		const downloaded = await downloadTelegramFile(ctx, document.file_id, document.mime_type ?? "text/plain");
		if (downloaded.bytes.length > MAX_TEXT_DOCUMENT_BYTES) {
			return unsupportedDocumentMessage(
				document,
				downloaded.bytes.length,
				downloaded.mediaType,
				"Unable to inline due to size limit",
			);
		}

		if (!isTextDocument(document) && !appearsTextual(downloaded.bytes)) {
			return unsupportedDocumentMessage(
				document,
				downloaded.bytes.length,
				downloaded.mediaType,
				"Unable to parse as text",
			);
		}

		let documentText: string;
		try {
			documentText = new TextDecoder("utf-8", { fatal: true }).decode(downloaded.bytes).trim();
		} catch {
			return unsupportedDocumentMessage(
				document,
				downloaded.bytes.length,
				downloaded.mediaType,
				"Unable to decode as UTF-8 text",
			);
		}

		if (!documentText) {
			return null;
		}

		return `Attached file (${fileName}):\n${documentText}`;
	} catch (error) {
		logger.warn("Failed to download Telegram document, using attachment summary", {
			error: String(error),
			fileId: document.file_id,
		});
		return unsupportedDocumentMessage(
			document,
			0,
			document.mime_type ?? "text/plain",
			"Failed to download attachment",
		);
	}
}

function isVoiceMessage(message: TelegramIncomingMessage): boolean {
	return Boolean(
		message.voice ||
			message.video_note ||
			message.audio ||
			(message.document && isAudioMimeType(message.document.mime_type)),
	);
}

async function collectVoiceTranscription(
	ctx: AuthContext,
	message: TelegramIncomingMessage,
	sttProvider: SttProvider,
	voiceConfig: VoiceConfig,
): Promise<string | null> {
	const sttLanguage = voiceConfig.stt?.language;

	if (message.voice) {
		const downloaded = await downloadTelegramFile(ctx, message.voice.file_id, message.voice.mime_type ?? "audio/ogg");
		const result = await sttProvider.transcribe(Buffer.from(downloaded.bytes), {
			mimeType: downloaded.mediaType,
			language: sttLanguage,
		});
		return result.text;
	}

	if (message.video_note) {
		const downloaded = await downloadTelegramFile(ctx, message.video_note.file_id, "video/mp4");
		const extractedAudio = await extractAudioFromVideo(Buffer.from(downloaded.bytes));
		const result = await sttProvider.transcribe(extractedAudio, {
			mimeType: "audio/ogg",
			language: sttLanguage,
		});
		return result.text;
	}

	if (message.audio) {
		const downloaded = await downloadTelegramFile(
			ctx,
			message.audio.file_id,
			message.audio.mime_type ?? "audio/mpeg",
		);
		const result = await sttProvider.transcribe(Buffer.from(downloaded.bytes), {
			mimeType: downloaded.mediaType,
			language: sttLanguage,
		});
		return result.text;
	}

	if (message.document && isAudioMimeType(message.document.mime_type)) {
		const downloaded = await downloadTelegramFile(
			ctx,
			message.document.file_id,
			message.document.mime_type ?? "application/octet-stream",
		);
		const result = await sttProvider.transcribe(Buffer.from(downloaded.bytes), {
			mimeType: downloaded.mediaType,
			language: sttLanguage,
		});
		return result.text;
	}

	return null;
}

export async function handleTelegramMessage(
	ctx: AuthContext,
	rpcClient: RpcClient,
	options: HandleMessageOptions = {},
): Promise<void> {
	try {
		const message = getIncomingMessage(ctx);
		if (!message) {
			await ctx.reply("Could not process this message.");
			return;
		}

		const isVoice = isVoiceMessage(message);
		const text = message.text?.trim() ?? message.caption?.trim() ?? "";
		const images = await collectImages(ctx, message);
		const documentContext = await readDocumentContext(ctx, message);
		let transcription: string | undefined;

		if (isVoice) {
			if (!options.sttProvider || !options.voiceConfig?.stt) {
				await ctx.reply(MISSING_STT_MESSAGE);
				return;
			}

			try {
				transcription =
					(await collectVoiceTranscription(ctx, message, options.sttProvider, options.voiceConfig)) ?? undefined;
			} catch (error) {
				if (error instanceof Error && error.message.includes("ffmpeg is not installed")) {
					await ctx.reply(VIDEO_NOTE_FFMPEG_MESSAGE);
					return;
				}
				logger.warn("Voice transcription failed", { error: String(error) });
				await ctx.reply("Voice transcription failed. Please try again.");
				return;
			}
		}

		const voiceContext =
			transcription === undefined
				? null
				: transcription.length > 0
					? `Voice transcription:\n${transcription}`
					: "[Voice message could not be transcribed]";
		const promptBody = [voiceContext, documentContext, text]
			.filter((part): part is string => Boolean(part))
			.join("\n\n")
			.trim();
		const promptMessage =
			promptBody ||
			(images.length > 0
				? "User sent an image without text."
				: isVoice
					? "User sent a voice message without text."
					: "User sent an empty message.");

		await rpcClient.prompt(promptMessage, images.length > 0 ? images : undefined);
	} catch (error) {
		logger.error("Failed handling Telegram message", { error: String(error) });
		await ctx.reply(`Failed to send message to assistant: ${String(error)}`);
	}
}
