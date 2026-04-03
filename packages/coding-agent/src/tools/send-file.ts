import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { AgentTool, AgentToolContext, AgentToolResult, AgentToolUpdateCallback } from "@oh-my-pi/pi-agent-core";
import { isEnoent } from "@oh-my-pi/pi-utils";
import { type Static, Type } from "@sinclair/typebox";
import sendFileDescription from "../prompts/tools/send-file.md" with { type: "text" };
import type { ToolSession } from "./index";
import type { OutputMeta } from "./output-meta";
import { resolveToCwd } from "./path-utils";
import { ToolError } from "./tool-errors";
import { toolResult } from "./tool-result";

const MAX_FILE_SIZE = 50 * 1024 * 1024;

const MIME_TYPES: Record<string, string> = {
	".csv": "text/csv",
	".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
	".gif": "image/gif",
	".gz": "application/gzip",
	".html": "text/html",
	".jpeg": "image/jpeg",
	".jpg": "image/jpeg",
	".json": "application/json",
	".md": "text/markdown",
	".mp3": "audio/mpeg",
	".mp4": "video/mp4",
	".pdf": "application/pdf",
	".png": "image/png",
	".svg": "image/svg+xml",
	".tar": "application/x-tar",
	".txt": "text/plain",
	".wav": "audio/wav",
	".webp": "image/webp",
	".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
	".xml": "application/xml",
	".zip": "application/zip",
};

const sendFileSchema = Type.Object({
	path: Type.String({ description: "File path (relative to CWD or absolute)" }),
	caption: Type.Optional(Type.String({ description: "Caption to accompany the file" })),
	filename: Type.Optional(Type.String({ description: "Override display filename" })),
});

type SendFileInput = Static<typeof sendFileSchema>;

// SYNC: Mirrored in packages/spell-server/src/rpc/types.ts — keep in sync
export interface FileDelivery {
	type: "document" | "photo";
	absolutePath: string;
	fileName: string;
	mimeType: string;
	caption?: string;
	fileSize: number;
}

export interface SendFileDetails {
	delivery: FileDelivery;
	meta?: OutputMeta;
}

function inferMimeType(filePath: string): string {
	const extension = path.extname(filePath).toLowerCase();
	return MIME_TYPES[extension] ?? "application/octet-stream";
}

function isImageMime(mimeType: string): boolean {
	return mimeType.startsWith("image/") && mimeType !== "image/svg+xml";
}

function formatFileSize(bytes: number): string {
	if (bytes < 1024) return `${bytes}B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

export class SendFileTool implements AgentTool<typeof sendFileSchema, SendFileDetails> {
	readonly name = "send_file";
	readonly label = "SendFile";
	readonly description = sendFileDescription;
	readonly parameters = sendFileSchema;
	readonly strict = true;

	#cwd: string;

	constructor(session: ToolSession) {
		this.#cwd = session.cwd;
	}

	async execute(
		_toolCallId: string,
		params: SendFileInput,
		_signal?: AbortSignal,
		_onUpdate?: AgentToolUpdateCallback<SendFileDetails>,
		_context?: AgentToolContext,
	): Promise<AgentToolResult<SendFileDetails>> {
		const absolutePath = resolveToCwd(params.path, this.#cwd);

		const stat = await fs.stat(absolutePath).catch((error: unknown) => {
			if (isEnoent(error)) {
				throw new ToolError(`File not found: ${params.path}`);
			}
			throw error;
		});

		if (!stat.isFile()) {
			throw new ToolError(`Not a file: ${params.path}`);
		}

		if (stat.size > MAX_FILE_SIZE) {
			throw new ToolError(`File too large: ${formatFileSize(stat.size)} (max ${formatFileSize(MAX_FILE_SIZE)})`);
		}

		const mimeType = inferMimeType(absolutePath);
		const fileName = params.filename ?? path.basename(absolutePath);
		const delivery: FileDelivery = {
			type: isImageMime(mimeType) ? "photo" : "document",
			absolutePath,
			fileName,
			mimeType,
			...(params.caption != null ? { caption: params.caption } : {}),
			fileSize: stat.size,
		};

		return toolResult<SendFileDetails>({ delivery })
			.text(`File queued for delivery: ${fileName} (${formatFileSize(stat.size)})`)
			.done();
	}
}
