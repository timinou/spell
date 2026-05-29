import * as os from "node:os";
import * as path from "node:path";
import { getAntigravityHeaders, getEnvApiKey, StringEnum } from "@oh-my-pi/pi-ai";
import { $env, isEnoent, ptree, readSseJson, Snowflake, untilAborted } from "@oh-my-pi/pi-utils";
import { type Static, Type } from "@sinclair/typebox";
import type { ModelRegistry } from "../config/model-registry";
import { renderPromptTemplate } from "../config/prompt-templates";
import type { CustomTool } from "../extensibility/custom-tools/types";
import imageGenerationDescription from "../prompts/tools/image-generation.md" with { type: "text" };
import { detectSupportedImageMimeTypeFromFile } from "../utils/mime";
import { resolveReadPath } from "./path-utils";

const DEFAULT_MODEL = "gemini-3-pro-image-preview";
const DEFAULT_OPENROUTER_MODEL = "google/gemini-3-pro-image-preview";
const DEFAULT_ANTIGRAVITY_MODEL = "gemini-3-pro-image";
const IMAGE_TIMEOUT = 3 * 60 * 1000; // 3 minutes
const MAX_IMAGE_SIZE = 35 * 1024 * 1024;

const ANTIGRAVITY_ENDPOINT = "https://daily-cloudcode-pa.sandbox.googleapis.com";
const IMAGE_SYSTEM_INSTRUCTION =
	"You are an AI image generator. Generate images based on user descriptions. Focus on creating high-quality, visually appealing images that match the user's request.";

// OpenAI Codex (ChatGPT subscription) hosted image_generation tool.
// Routes through the same /codex/responses endpoint Spell already uses for text;
// the backend resolves the hosted tool to `gpt-image-2` and bills against the
// caller's ChatGPT plan. Image-generating turns cost 3-5x a normal text turn
// against the Codex usage limits — see Codex docs.
const CODEX_BASE_URL = "https://chatgpt.com/backend-api";
const CODEX_RESPONSES_PATH = "/codex/responses";
const CODEX_TEXT_MODEL = "gpt-5.5";
const CODEX_IMAGE_BACKEND_MODEL = "gpt-image-2";
const CODEX_ORIGINATOR = "pi";
const CODEX_IMAGE_INSTRUCTIONS =
	"When the user asks for an image, call the image_generation tool exactly once with a precise prompt. Do not respond with text alone.";
const CODEX_JWT_AUTH_CLAIM = "https://api.openai.com/auth";

type ImageProvider = "antigravity" | "gemini" | "openrouter" | "openai-codex";
interface ImageApiKey {
	provider: ImageProvider;
	apiKey: string;
	projectId?: string;
}

const responseModalitySchema = StringEnum(["IMAGE", "TEXT"]);
const aspectRatioSchema = StringEnum(["1:1", "3:4", "4:3", "9:16", "16:9"], {
	description: "Aspect ratio (1:1, 3:4, 4:3, 9:16, 16:9).",
});
const imageSizeSchema = StringEnum(["1024x1024", "1536x1024", "1024x1536"], {
	description: "Image size, mainly for gemini-3-pro-image-preview.",
});

const inputImageSchema = Type.Object(
	{
		path: Type.Optional(Type.String({ description: "Path to an input image file." })),
		data: Type.Optional(Type.String({ description: "Base64 image data or a data: URL." })),
		mime_type: Type.Optional(Type.String({ description: "Required for raw base64 data." })),
	},
	{ additionalProperties: false },
);

const baseImageSchema = Type.Object(
	{
		subject: Type.String({
			description:
				"Main subject with key descriptors (e.g., 'A stoic robot barista with glowing blue optics', 'A weathered lighthouse on a rocky cliff').",
		}),
		action: Type.Optional(
			Type.String({
				description: "What the subject is doing (e.g., 'pouring latte art', 'standing against crashing waves').",
			}),
		),
		scene: Type.Optional(
			Type.String({
				description:
					"Location or environment (e.g., 'in a futuristic café on Mars', 'during a violent thunderstorm at dusk').",
			}),
		),
		composition: Type.Optional(
			Type.String({
				description:
					"Camera angle, framing, depth of field (e.g., 'low-angle close-up, shallow depth of field', 'wide establishing shot').",
			}),
		),
		lighting: Type.Optional(
			Type.String({
				description:
					"Lighting setup and mood (e.g., 'warm rim lighting', 'golden hour backlight', 'hard noon shadows').",
			}),
		),
		style: Type.Optional(
			Type.String({
				description:
					"Artistic style, mood, color grading, camera (e.g., 'film noir mood, cinematic color grading', 'Studio Ghibli watercolor', 'photorealistic').",
			}),
		),
		text: Type.Optional(
			Type.String({
				description:
					"Text to render in image with specs: exact wording in quotes, font style, color, placement (e.g., 'Headline \"URBAN EXPLORER\" in bold white sans-serif at top center').",
			}),
		),
		changes: Type.Optional(
			Type.Array(Type.String(), {
				description:
					"For edits: specific changes to make, as well as, what to keep unchanged (e.g., ['Change the tie to green', 'Remove the car in background']). Use with input_images.",
			}),
		),
		aspect_ratio: Type.Optional(aspectRatioSchema),
		image_size: Type.Optional(imageSizeSchema),
		input: Type.Optional(
			Type.Array(inputImageSchema, {
				description: "Optional input images for edits or variations.",
			}),
		),
	},
	{ additionalProperties: false },
);

export const imageGenerationSchema = baseImageSchema;
export type ImageGenerationParams = Static<typeof imageGenerationSchema>;
export type GeminiResponseModality = Static<typeof responseModalitySchema>;

/**
 * Assembles a structured prompt from the provided parameters.
 * For generation: builds "subject, action, scene. composition. lighting. camera. style."
 * For edits: appends change instructions and preserve directives.
 */
function assemblePrompt(params: ImageGenerationParams): string {
	const parts: string[] = [];

	// Core subject line: subject + action + scene
	const subjectParts = [params.subject];
	if (params.action) subjectParts.push(params.action);
	if (params.scene) subjectParts.push(params.scene);
	parts.push(subjectParts.join(", "));

	// Technical details as separate sentences
	if (params.composition) parts.push(params.composition);
	if (params.lighting) parts.push(params.lighting);
	if (params.style) parts.push(params.style);

	// Join with periods for sentence structure
	let prompt = `${parts.map(p => p.replace(/[.!,;:]+$/, "")).join(". ")}.`;

	// Text rendering specs
	if (params.text) {
		prompt += `\n\nText: ${params.text}`;
	}

	// Edit mode: changes and preserve directives
	if (params.changes?.length) {
		prompt += `\n\nChanges:\n${params.changes.map(c => `- ${c}`).join("\n")}`;
	}

	return prompt;
}

interface GeminiInlineData {
	data?: string;
	mimeType?: string;
}

interface GeminiPart {
	text?: string;
	inlineData?: GeminiInlineData;
}

interface GeminiCandidate {
	content?: { parts?: GeminiPart[] };
}

interface GeminiSafetyRating {
	category?: string;
	probability?: string;
}

interface GeminiPromptFeedback {
	blockReason?: string;
	safetyRatings?: GeminiSafetyRating[];
}

interface GeminiUsageMetadata {
	promptTokenCount?: number;
	candidatesTokenCount?: number;
	totalTokenCount?: number;
}

// --- OpenAI Codex hosted image_generation tool ---------------------------

interface CodexResponseEvent {
	type: string;
	item?: { type?: string; [k: string]: unknown };
	response?: {
		usage?: { input_tokens?: number; output_tokens?: number; total_tokens?: number };
		status?: string;
	};
	text?: string;
}

interface CodexImageGenerationCall {
	id: string;
	type: "image_generation_call";
	status: string;
	result?: string;
	output_format?: string;
	quality?: string;
	size?: string;
	revised_prompt?: string;
}

interface CodexInputContentPart {
	type: "input_text" | "input_image";
	text?: string;
	image_url?: string;
	detail?: "auto" | "low" | "high";
}

interface CodexInputMessage {
	type: "message";
	role: "user" | "developer";
	content: CodexInputContentPart[];
}

interface CodexImageToolSpec {
	type: "image_generation";
	size?: string;
	quality?: "low" | "medium" | "high" | "auto";
}

interface CodexResponsesRequest {
	model: string;
	stream: true;
	store: false;
	instructions: string;
	input: CodexInputMessage[];
	tools: CodexImageToolSpec[];
	tool_choice: "auto";
}

interface CodexImageResult {
	images: InlineImageData[];
	revisedPrompt?: string;
	responseText?: string;
	usage?: GeminiUsageMetadata;
}

interface GeminiGenerateContentResponse {
	candidates?: GeminiCandidate[];
	promptFeedback?: GeminiPromptFeedback;
	usageMetadata?: GeminiUsageMetadata;
}

interface OpenRouterImageUrl {
	url: string;
}

interface OpenRouterContentPart {
	type: "text" | "image_url";
	text?: string;
	image_url?: OpenRouterImageUrl;
}

interface OpenRouterMessage {
	content?: string | OpenRouterContentPart[];
	images?: Array<string | { image_url?: OpenRouterImageUrl }>;
}

interface OpenRouterChoice {
	message?: OpenRouterMessage;
}

interface OpenRouterResponse {
	choices?: OpenRouterChoice[];
}

interface AntigravityRequest {
	project: string;
	model: string;
	request: {
		contents: Array<{ role: "user"; parts: Array<{ text?: string; inlineData?: InlineImageData }> }>;
		systemInstruction?: { parts: Array<{ text: string }> };
		generationConfig?: {
			responseModalities?: GeminiResponseModality[];
			imageConfig?: { aspectRatio?: string; imageSize?: string };
			candidateCount?: number;
		};
		safetySettings?: Array<{ category: string; threshold: string }>;
	};
	requestType?: string;
	userAgent?: string;
	requestId?: string;
}

interface AntigravityResponseChunk {
	response?: {
		candidates?: Array<{
			content?: {
				role: string;
				parts?: Array<{
					text?: string;
					inlineData?: { mimeType?: string; data?: string };
				}>;
			};
		}>;
		usageMetadata?: GeminiUsageMetadata;
	};
}

interface ImageGenerationToolDetails {
	provider: ImageProvider;
	model: string;
	imageCount: number;
	imagePaths: string[];
	imageUris?: string[];
	images: InlineImageData[];
	responseText?: string;
	promptFeedback?: GeminiPromptFeedback;
	usage?: GeminiUsageMetadata;
}

interface ImageInput {
	path?: string;
	data?: string;
	mime_type?: string;
}

interface InlineImageData {
	data: string;
	mimeType: string;
}

function normalizeDataUrl(data: string): { data: string; mimeType?: string } {
	const match = data.match(/^data:([^;]+);base64,(.+)$/);
	if (!match) return { data };
	return { data: match[2] ?? "", mimeType: match[1] };
}

function resolveOpenRouterModel(model: string): string {
	return model.includes("/") ? model : `google/${model}`;
}

function toDataUrl(image: InlineImageData): string {
	return `data:${image.mimeType};base64,${image.data}`;
}

async function loadImageFromUrl(imageUrl: string, signal?: AbortSignal): Promise<InlineImageData> {
	if (imageUrl.startsWith("data:")) {
		const normalized = normalizeDataUrl(imageUrl.trim());
		if (!normalized.mimeType) {
			throw new Error("mime_type is required when providing raw base64 data.");
		}
		if (!normalized.data) {
			throw new Error("Image data is empty.");
		}
		return { data: normalized.data, mimeType: normalized.mimeType };
	}

	const response = await fetch(imageUrl, { signal });
	if (!response.ok) {
		const rawText = await response.text();
		throw new Error(`Image download failed (${response.status}): ${rawText}`);
	}
	const contentType = response.headers.get("content-type")?.split(";")[0];
	if (!contentType || !contentType.startsWith("image/")) {
		throw new Error(`Unsupported image type from URL: ${imageUrl}`);
	}
	const buffer = await response.bytes();
	return { data: buffer.toBase64(), mimeType: contentType };
}

function collectOpenRouterResponseText(message: OpenRouterMessage | undefined): string | undefined {
	if (!message) return undefined;
	if (typeof message.content === "string") {
		const trimmed = message.content.trim();
		return trimmed.length > 0 ? trimmed : undefined;
	}
	if (Array.isArray(message.content)) {
		const texts = message.content
			.filter(part => part.type === "text")
			.map(part => part.text)
			.filter((text): text is string => Boolean(text));
		const combined = texts.join("\n").trim();
		return combined.length > 0 ? combined : undefined;
	}
	return undefined;
}

function extractOpenRouterImageUrls(message: OpenRouterMessage | undefined): string[] {
	const urls: string[] = [];
	if (!message) return urls;
	for (const image of message.images ?? []) {
		if (typeof image === "string") {
			urls.push(image);
			continue;
		}
		if (image.image_url?.url) {
			urls.push(image.image_url.url);
		}
	}
	if (Array.isArray(message.content)) {
		for (const part of message.content) {
			if (part.type === "image_url" && part.image_url?.url) {
				urls.push(part.image_url.url);
			}
		}
	}
	return urls;
}

/** Preferred provider set via settings (default: auto) */
let preferredImageProvider: ImageProvider | "auto" = "auto";

/** Set the preferred image provider from settings */
export function setPreferredImageProvider(provider: ImageProvider | "auto"): void {
	preferredImageProvider = provider;
}

interface ParsedAntigravityCredentials {
	accessToken: string;
	projectId: string;
}

function parseAntigravityCredentials(raw: string): ParsedAntigravityCredentials | null {
	try {
		const parsed = JSON.parse(raw) as { token?: string; projectId?: string };
		if (parsed.token && parsed.projectId) {
			return { accessToken: parsed.token, projectId: parsed.projectId };
		}
	} catch {
		// Invalid JSON
	}
	return null;
}

async function findAntigravityCredentials(modelRegistry: ModelRegistry): Promise<ImageApiKey | null> {
	const apiKey = await modelRegistry.getApiKeyForProvider("google-antigravity");
	if (!apiKey) return null;

	const parsed = parseAntigravityCredentials(apiKey);
	if (!parsed) return null;

	return {
		provider: "antigravity",
		apiKey: parsed.accessToken,
		projectId: parsed.projectId,
	};
}

function decodeChatGptAccountId(accessToken: string): string | undefined {
	try {
		const parts = accessToken.split(".");
		if (parts.length !== 3) return undefined;
		const claims = JSON.parse(Buffer.from(parts[1] ?? "", "base64").toString("utf-8")) as Record<string, unknown>;
		const auth = claims[CODEX_JWT_AUTH_CLAIM] as { chatgpt_account_id?: string } | undefined;
		const accountId = auth?.chatgpt_account_id;
		return typeof accountId === "string" && accountId.length > 0 ? accountId : undefined;
	} catch {
		return undefined;
	}
}

async function findCodexCredentials(modelRegistry: ModelRegistry): Promise<ImageApiKey | null> {
	const accessToken = await modelRegistry.getApiKeyForProvider("openai-codex");
	if (!accessToken) return null;
	const accountId = decodeChatGptAccountId(accessToken);
	if (!accountId) return null;
	return {
		provider: "openai-codex",
		apiKey: accessToken,
		projectId: accountId,
	};
}

function aspectRatioToCodexSize(aspectRatio: string | undefined): string | undefined {
	switch (aspectRatio) {
		case "1:1":
			return "1024x1024";
		case "4:3":
		case "16:9":
			return "1536x1024";
		case "3:4":
		case "9:16":
			return "1024x1536";
		default:
			return undefined;
	}
}

function buildCodexInput(prompt: string, images: InlineImageData[]): CodexInputMessage[] {
	const content: CodexInputContentPart[] = [{ type: "input_text", text: prompt }];
	for (const image of images) {
		content.push({ type: "input_image", image_url: toDataUrl(image), detail: "auto" });
	}
	return [{ type: "message", role: "user", content }];
}

function buildCodexImageTool(params: ImageGenerationParams): CodexImageToolSpec {
	const tool: CodexImageToolSpec = { type: "image_generation" };
	const size = params.image_size ?? aspectRatioToCodexSize(params.aspect_ratio);
	if (size) tool.size = size;
	return tool;
}

function buildCodexHeaders(cred: ImageApiKey): Record<string, string> {
	if (!cred.projectId) {
		throw new Error("Missing ChatGPT account id for openai-codex image request.");
	}
	return {
		Authorization: `Bearer ${cred.apiKey}`,
		"chatgpt-account-id": cred.projectId,
		"OpenAI-Beta": "responses=experimental",
		originator: CODEX_ORIGINATOR,
		"Content-Type": "application/json",
		Accept: "text/event-stream",
	};
}

async function parseCodexImageSse(
	response: Response,
	signal?: AbortSignal,
): Promise<CodexImageResult> {
	if (!response.body) {
		throw new Error("No response body");
	}
	const images: InlineImageData[] = [];
	const texts: string[] = [];
	let usage: GeminiUsageMetadata | undefined;
	let revisedPrompt: string | undefined;

	for await (const event of readSseJson<CodexResponseEvent>(response.body, signal)) {
		if (event.type === "response.output_item.done") {
			const item = event.item as CodexImageGenerationCall | undefined;
			if (item?.type === "image_generation_call" && typeof item.result === "string" && item.result.length > 0) {
				const format = (item.output_format ?? "png").toLowerCase();
				const mimeType = format === "jpg" ? "image/jpeg" : `image/${format}`;
				images.push({ data: item.result, mimeType });
				if (item.revised_prompt && !revisedPrompt) {
					revisedPrompt = item.revised_prompt;
				}
			}
		} else if (event.type === "response.output_text.done" && typeof event.text === "string") {
			const trimmed = event.text.trim();
			if (trimmed.length > 0) texts.push(trimmed);
		} else if (event.type === "response.completed" && event.response?.usage) {
			const u = event.response.usage;
			usage = {
				promptTokenCount: u.input_tokens,
				candidatesTokenCount: u.output_tokens,
				totalTokenCount: u.total_tokens,
			};
		}
	}

	const responseText = texts.length > 0 ? texts.join("\n") : revisedPrompt;
	return { images, revisedPrompt, responseText, usage };
}

async function findImageApiKey(modelRegistry?: ModelRegistry): Promise<ImageApiKey | null> {
	// Explicit preferred provider takes priority; fall through to auto-detect if its credential is missing.
	if (preferredImageProvider === "antigravity" && modelRegistry) {
		const antigravity = await findAntigravityCredentials(modelRegistry);
		if (antigravity) return antigravity;
	}
	if (preferredImageProvider === "openai-codex" && modelRegistry) {
		const codex = await findCodexCredentials(modelRegistry);
		if (codex) return codex;
	}
	if (preferredImageProvider === "gemini") {
		const geminiKey = getEnvApiKey("google");
		if (geminiKey) return { provider: "gemini", apiKey: geminiKey };
		const googleKey = $env.GOOGLE_API_KEY;
		if (googleKey) return { provider: "gemini", apiKey: googleKey };
	} else if (preferredImageProvider === "openrouter") {
		const openRouterKey = getEnvApiKey("openrouter");
		if (openRouterKey) return { provider: "openrouter", apiKey: openRouterKey };
	}

	// Auto-detect priority: Antigravity OAuth -> Codex (ChatGPT) OAuth -> OpenRouter -> Gemini.
	// OAuth providers come first because they piggyback on existing subscriptions and
	// don't require the user to manage an extra API key.
	if (modelRegistry) {
		const antigravity = await findAntigravityCredentials(modelRegistry);
		if (antigravity) return antigravity;

		const codex = await findCodexCredentials(modelRegistry);
		if (codex) return codex;
	}

	const openRouterKey = getEnvApiKey("openrouter");
	if (openRouterKey) return { provider: "openrouter", apiKey: openRouterKey };

	const geminiKey = getEnvApiKey("google");
	if (geminiKey) return { provider: "gemini", apiKey: geminiKey };

	const googleKey = $env.GOOGLE_API_KEY;
	if (googleKey) return { provider: "gemini", apiKey: googleKey };

	return null;
}

async function loadImageFromPath(imagePath: string, cwd: string): Promise<InlineImageData> {
	const resolved = resolveReadPath(imagePath, cwd);
	try {
		const buffer = await Bun.file(resolved).bytes();
		if (buffer.length > MAX_IMAGE_SIZE) {
			throw new Error(`Image file too large: ${imagePath}`);
		}

		const mimeType = await detectSupportedImageMimeTypeFromFile(resolved);
		if (!mimeType) {
			throw new Error(`Unsupported image type: ${imagePath}`);
		}

		return { data: buffer.toBase64(), mimeType };
	} catch (err) {
		if (isEnoent(err)) throw new Error(`Image file not found: ${imagePath}`);
		throw err;
	}
}

async function resolveInputImage(input: ImageInput, cwd: string): Promise<InlineImageData> {
	if (input.path) {
		return loadImageFromPath(input.path, cwd);
	}

	if (input.data) {
		const normalized = normalizeDataUrl(input.data.trim());
		const mimeType = normalized.mimeType ?? input.mime_type;
		if (!mimeType) {
			throw new Error("mime_type is required when providing raw base64 data.");
		}
		if (!normalized.data) {
			throw new Error("Image data is empty.");
		}
		return { data: normalized.data, mimeType };
	}

	throw new Error("input_images entries must include either path or data.");
}

function getExtensionForMime(mimeType: string): string {
	const map: Record<string, string> = {
		"image/png": "png",
		"image/jpeg": "jpg",
		"image/gif": "gif",
		"image/webp": "webp",
	};
	return map[mimeType] ?? "png";
}

async function saveImageToTemp(image: InlineImageData): Promise<string> {
	const ext = getExtensionForMime(image.mimeType);
	const filename = `spell-image-${Snowflake.next()}.${ext}`;
	const filepath = path.join(os.tmpdir(), filename);
	await Bun.write(filepath, Buffer.from(image.data, "base64"));
	return filepath;
}

interface SavedImageArtifact {
	path: string;
	uri?: string;
}

type ImageArtifactAllocator = (
	toolType: string,
	extension?: string,
) => Promise<{ id?: string; path?: string; uri?: string } | undefined>;

export async function saveImageAsArtifact(
	image: InlineImageData,
	allocate?: ImageArtifactAllocator,
): Promise<SavedImageArtifact> {
	const ext = getExtensionForMime(image.mimeType);
	if (allocate) {
		try {
			const artifact = await allocate("generate_image", ext);
			if (artifact?.path) {
				await Bun.write(artifact.path, Buffer.from(image.data, "base64"));
				return { path: artifact.path, uri: artifact.uri };
			}
		} catch {
			// Fall back to tmpdir when artifact allocation is unavailable.
		}
	}
	return { path: await saveImageToTemp(image) };
}

async function saveImagesAsArtifacts(
	images: InlineImageData[],
	allocate?: ImageArtifactAllocator,
): Promise<SavedImageArtifact[]> {
	return Promise.all(images.map(image => saveImageAsArtifact(image, allocate)));
}

function buildSavedImageDetails(
	savedImages: SavedImageArtifact[],
): Pick<ImageGenerationToolDetails, "imagePaths" | "imageUris"> {
	const imageUris = savedImages.map(image => image.uri).filter((uri): uri is string => Boolean(uri));
	return {
		imagePaths: savedImages.map(image => image.path),
		...(imageUris.length > 0 ? { imageUris } : {}),
	};
}
function buildResponseSummary(
	provider: ImageProvider,
	model: string,
	savedImages: SavedImageArtifact[],
	responseText: string | undefined,
): string {
	const lines = [`Provider: ${provider}`, `Model: ${model}`, `Generated ${savedImages.length} image(s):`];
	for (const image of savedImages) {
		lines.push(`  ${image.uri ?? image.path}`);
	}
	if (responseText) {
		lines.push("", responseText.trim());
	}
	return lines.join("\n");
}

function collectResponseText(parts: GeminiPart[]): string | undefined {
	const texts = parts.map(part => part.text).filter((text): text is string => Boolean(text));
	const combined = texts.join("\n").trim();
	return combined.length > 0 ? combined : undefined;
}

function collectInlineImages(parts: GeminiPart[]): InlineImageData[] {
	const images: InlineImageData[] = [];
	for (const part of parts) {
		const data = part.inlineData?.data;
		const mimeType = part.inlineData?.mimeType;
		if (!data || !mimeType) continue;
		images.push({ data, mimeType });
	}
	return images;
}

function combineParts(response: GeminiGenerateContentResponse): GeminiPart[] {
	const parts: GeminiPart[] = [];
	for (const candidate of response.candidates ?? []) {
		const candidateParts = candidate.content?.parts ?? [];
		parts.push(...candidateParts);
	}
	return parts;
}

function buildAntigravityRequest(
	prompt: string,
	model: string,
	projectId: string,
	aspectRatio: string | undefined,
	imageSize: string | undefined,
	inputImages: InlineImageData[],
): AntigravityRequest {
	const parts: Array<{ text?: string; inlineData?: InlineImageData }> = [];
	for (const image of inputImages) {
		parts.push({ inlineData: image });
	}
	parts.push({ text: prompt });

	const imageConfig = aspectRatio || imageSize ? { aspectRatio: aspectRatio, imageSize: imageSize } : undefined;

	return {
		project: projectId,
		model,
		request: {
			contents: [{ role: "user", parts }],
			systemInstruction: { parts: [{ text: IMAGE_SYSTEM_INSTRUCTION }] },
			generationConfig: {
				responseModalities: ["IMAGE"],
				imageConfig,
				candidateCount: 1,
			},
			safetySettings: [
				{ category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_ONLY_HIGH" },
				{ category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_ONLY_HIGH" },
				{ category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_ONLY_HIGH" },
				{ category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_ONLY_HIGH" },
				{ category: "HARM_CATEGORY_CIVIC_INTEGRITY", threshold: "BLOCK_ONLY_HIGH" },
			],
		},
		requestType: "agent",
		requestId: `agent-${Date.now()}-${Math.random().toString(36).slice(2, 11)}`,
		userAgent: "antigravity",
	};
}

interface AntigravitySseResult {
	images: InlineImageData[];
	text: string[];
	usage?: GeminiUsageMetadata;
}

const _prefix = Buffer.from("data: ", "utf-8");

async function parseAntigravitySseForImage(response: Response, signal?: AbortSignal): Promise<AntigravitySseResult> {
	if (!response.body) {
		throw new Error("No response body");
	}

	const textParts: string[] = [];
	const images: InlineImageData[] = [];
	let usage: GeminiUsageMetadata | undefined;

	for await (const chunk of readSseJson<AntigravityResponseChunk>(response.body, signal)) {
		const responseData = chunk.response;
		if (!responseData) continue;
		if (!responseData.candidates) continue;
		for (const candidate of responseData.candidates) {
			const parts = candidate.content?.parts;
			if (!parts) continue;
			for (const part of parts) {
				if (part.text) {
					textParts.push(part.text);
				}
				const inlineData = part.inlineData;
				if (inlineData?.data && inlineData.mimeType) {
					images.push({ data: inlineData.data, mimeType: inlineData.mimeType });
				}
			}
		}
		if (responseData.usageMetadata) {
			usage = responseData.usageMetadata;
		}
	}

	return { images, text: textParts, usage };
}

export const imageGenerationTool: CustomTool<typeof imageGenerationSchema, ImageGenerationToolDetails> = {
	name: "generate_image",
	label: "GenerateImage",
	description: renderPromptTemplate(imageGenerationDescription),
	parameters: imageGenerationSchema,
	async execute(_toolCallId, params, _onUpdate, ctx, signal) {
		return untilAborted(signal, async () => {
			const apiKey = await findImageApiKey(ctx.modelRegistry);
			if (!apiKey) {
				throw new Error(
					"No image API credentials found. Login with google-antigravity or openai-codex (ChatGPT), or set OPENROUTER_API_KEY, GEMINI_API_KEY, or GOOGLE_API_KEY.",
				);
			}

			const provider = apiKey.provider;
			const model =
				provider === "antigravity"
					? DEFAULT_ANTIGRAVITY_MODEL
					: provider === "openrouter"
						? DEFAULT_OPENROUTER_MODEL
						: provider === "openai-codex"
							? CODEX_IMAGE_BACKEND_MODEL
							: DEFAULT_MODEL;
			const resolvedModel = provider === "openrouter" ? resolveOpenRouterModel(model) : model;
			const cwd = ctx.sessionManager.getCwd();
			const allocateArtifact = ctx.sessionManager.allocateArtifactPath.bind(ctx.sessionManager);
			const resolvedImages: InlineImageData[] = [];
			if (params.input?.length) {
				for (const input of params.input) {
					resolvedImages.push(await resolveInputImage(input, cwd));
				}
			}

			const requestSignal = ptree.combineSignals(signal, IMAGE_TIMEOUT);

			if (provider === "antigravity") {
				if (!apiKey.projectId) {
					throw new Error("Missing projectId in antigravity credentials");
				}

				const prompt = assemblePrompt(params);
				const requestBody = buildAntigravityRequest(
					prompt,
					model,
					apiKey.projectId,
					params.aspect_ratio,
					params.image_size,
					resolvedImages,
				);

				const response = await fetch(`${ANTIGRAVITY_ENDPOINT}/v1internal:streamGenerateContent?alt=sse`, {
					method: "POST",
					headers: {
						Authorization: `Bearer ${apiKey.apiKey}`,
						"Content-Type": "application/json",
						Accept: "text/event-stream",
						...getAntigravityHeaders(),
					},
					body: JSON.stringify(requestBody),
					signal: requestSignal,
				});

				if (!response.ok) {
					const errorText = await response.text();
					let message = errorText;
					try {
						const parsed = JSON.parse(errorText) as { error?: { message?: string } };
						message = parsed.error?.message ?? message;
					} catch {
						// Keep raw text.
					}
					throw new Error(`Antigravity image request failed (${response.status}): ${message}`);
				}

				const parsed = await parseAntigravitySseForImage(response, requestSignal);
				const responseText = parsed.text.length > 0 ? parsed.text.join(" ") : undefined;

				if (parsed.images.length === 0) {
					const messageText = responseText ? `\n\n${responseText}` : "";
					return {
						content: [{ type: "text", text: `No image data returned.${messageText}` }],
						details: {
							provider,
							model,
							imageCount: 0,
							imagePaths: [],
							imageUris: [],
							images: [],
							responseText,
							usage: parsed.usage,
						},
					};
				}

				const savedImages = await saveImagesAsArtifacts(parsed.images, allocateArtifact);

				return {
					content: [{ type: "text", text: buildResponseSummary(provider, model, savedImages, responseText) }],
					details: {
						provider,
						model,
						imageCount: parsed.images.length,
						...buildSavedImageDetails(savedImages),
						images: parsed.images,
						responseText,
						usage: parsed.usage,
					},
				};
			}

			if (provider === "openai-codex") {
				const prompt = assemblePrompt(params);
				const requestBody: CodexResponsesRequest = {
					model: CODEX_TEXT_MODEL,
					stream: true,
					store: false,
					instructions: CODEX_IMAGE_INSTRUCTIONS,
					input: buildCodexInput(prompt, resolvedImages),
					tools: [buildCodexImageTool(params)],
					tool_choice: "auto",
				};

				const response = await fetch(`${CODEX_BASE_URL}${CODEX_RESPONSES_PATH}`, {
					method: "POST",
					headers: buildCodexHeaders(apiKey),
					body: JSON.stringify(requestBody),
					signal: requestSignal,
				});

				if (!response.ok) {
					const errorText = await response.text();
					let message = errorText;
					try {
						const parsed = JSON.parse(errorText) as { error?: { message?: string } };
						message = parsed.error?.message ?? message;
					} catch {
						// Keep raw text.
					}
					throw new Error(`OpenAI Codex image request failed (${response.status}): ${message}`);
				}

				const result = await parseCodexImageSse(response, requestSignal);

				if (result.images.length === 0) {
					const messageText = result.responseText ? `\n\n${result.responseText}` : "";
					return {
						content: [{ type: "text", text: `No image data returned.${messageText}` }],
						details: {
							provider,
							model,
							imageCount: 0,
							imagePaths: [],
							imageUris: [],
							images: [],
							responseText: result.responseText,
							usage: result.usage,
						},
					};
				}

				const savedImages = await saveImagesAsArtifacts(result.images, allocateArtifact);

				return {
					content: [
						{ type: "text", text: buildResponseSummary(provider, model, savedImages, result.responseText) },
					],
					details: {
						provider,
						model,
						imageCount: result.images.length,
						...buildSavedImageDetails(savedImages),
						images: result.images,
						responseText: result.responseText,
						usage: result.usage,
					},
				};
			}

			if (provider === "openrouter") {
				const prompt = assemblePrompt(params);
				const contentParts: OpenRouterContentPart[] = [{ type: "text", text: prompt }];
				for (const image of resolvedImages) {
					contentParts.push({ type: "image_url", image_url: { url: toDataUrl(image) } });
				}

				const requestBody = {
					model: resolvedModel,
					messages: [{ role: "user" as const, content: contentParts }],
				};

				const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
					method: "POST",
					headers: {
						"Content-Type": "application/json",
						Authorization: `Bearer ${apiKey.apiKey}`,
					},
					body: JSON.stringify(requestBody),
					signal: requestSignal,
				});

				const rawText = await response.text();
				if (!response.ok) {
					let message = rawText;
					try {
						const parsed = JSON.parse(rawText) as { error?: { message?: string } };
						message = parsed.error?.message ?? message;
					} catch {
						// Keep raw text.
					}
					throw new Error(`OpenRouter image request failed (${response.status}): ${message}`);
				}

				const data = JSON.parse(rawText) as OpenRouterResponse;
				const message = data.choices?.[0]?.message;
				const responseText = collectOpenRouterResponseText(message);
				const imageUrls = extractOpenRouterImageUrls(message);
				const inlineImages: InlineImageData[] = [];
				for (const imageUrl of imageUrls) {
					inlineImages.push(await loadImageFromUrl(imageUrl, requestSignal));
				}

				if (inlineImages.length === 0) {
					const messageText = responseText ? `\n\n${responseText}` : "";
					return {
						content: [{ type: "text", text: `No image data returned.${messageText}` }],
						details: {
							provider,
							model: resolvedModel,
							imageCount: 0,
							imagePaths: [],
							imageUris: [],
							images: [],
							responseText,
						},
					};
				}

				const savedImages = await saveImagesAsArtifacts(inlineImages, allocateArtifact);

				return {
					content: [
						{ type: "text", text: buildResponseSummary(provider, resolvedModel, savedImages, responseText) },
					],
					details: {
						provider,
						model: resolvedModel,
						imageCount: inlineImages.length,
						...buildSavedImageDetails(savedImages),
						images: inlineImages,
						responseText,
					},
				};
			}

			const parts = [] as Array<{ text?: string; inlineData?: InlineImageData }>;
			for (const image of resolvedImages) {
				parts.push({ inlineData: image });
			}
			parts.push({ text: assemblePrompt(params) });

			const generationConfig: {
				responseModalities: GeminiResponseModality[];
				imageConfig?: { aspectRatio?: string; imageSize?: string };
			} = {
				responseModalities: ["IMAGE"],
			};

			if (params.aspect_ratio || params.image_size) {
				generationConfig.imageConfig = {
					aspectRatio: params.aspect_ratio,
					imageSize: params.image_size,
				};
			}

			const requestBody = {
				contents: [{ role: "user" as const, parts }],
				generationConfig,
			};

			const response = await fetch(
				`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
				{
					method: "POST",
					headers: {
						"Content-Type": "application/json",
						"x-goog-api-key": apiKey.apiKey,
					},
					body: JSON.stringify(requestBody),
					signal: requestSignal,
				},
			);

			const rawText = await response.text();
			if (!response.ok) {
				let message = rawText;
				try {
					const parsed = JSON.parse(rawText) as { error?: { message?: string } };
					message = parsed.error?.message ?? message;
				} catch {
					// Keep raw text.
				}
				throw new Error(`Gemini image request failed (${response.status}): ${message}`);
			}

			const data = JSON.parse(rawText) as GeminiGenerateContentResponse;
			const responseParts = combineParts(data);
			const responseText = collectResponseText(responseParts);
			const inlineImages = collectInlineImages(responseParts);

			if (inlineImages.length === 0) {
				const blocked = data.promptFeedback?.blockReason
					? `Blocked: ${data.promptFeedback.blockReason}`
					: "No image data returned.";
				return {
					content: [{ type: "text", text: `${blocked}${responseText ? `\n\n${responseText}` : ""}` }],
					details: {
						provider,
						model,
						imageCount: 0,
						imagePaths: [],
						imageUris: [],
						images: [],
						responseText,
						promptFeedback: data.promptFeedback,
						usage: data.usageMetadata,
					},
				};
			}

			const savedImages = await saveImagesAsArtifacts(inlineImages, allocateArtifact);

			return {
				content: [{ type: "text", text: buildResponseSummary(provider, model, savedImages, responseText) }],
				details: {
					provider,
					model,
					imageCount: inlineImages.length,
					...buildSavedImageDetails(savedImages),
					images: inlineImages,
					responseText,
					promptFeedback: data.promptFeedback,
					usage: data.usageMetadata,
				},
			};
		});
	},
};

export async function getImageGenerationTools(): Promise<
	Array<CustomTool<typeof imageGenerationSchema, ImageGenerationToolDetails>>
> {
	const apiKey = await findImageApiKey();
	if (!apiKey) return [];
	return [imageGenerationTool];
}

export async function getImageGenerationToolsWithRegistry(
	modelRegistry: ModelRegistry,
): Promise<Array<CustomTool<typeof imageGenerationSchema, ImageGenerationToolDetails>>> {
	const apiKey = await findImageApiKey(modelRegistry);
	if (!apiKey) return [];
	return [imageGenerationTool];
}
