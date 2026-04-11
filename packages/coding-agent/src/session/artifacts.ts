/**
 * Session-scoped artifact storage for truncated tool outputs.
 *
 * Artifacts are stored in a directory alongside the session file,
 * accessible via artifact:// URLs.
 */

import type * as nodeFs from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";

const SESSION_ROOT_NAME_RE = /_([0-9a-f]+)$/i;
const SAFE_SEGMENT_RE = /[^a-zA-Z0-9._-]/g;

export interface ArtifactRef {
	id: string;
	uri: string;
	path: string;
}

export interface ArtifactScope {
	sessionId: string;
	rootDir: string;
	agentName: string;
	agentDir: string;
	legacyDir: string;
}

function sanitizeSegment(value: string, fallback: string): string {
	const sanitized = value.trim().replace(SAFE_SEGMENT_RE, "_");
	return sanitized.length > 0 ? sanitized : fallback;
}

function stripJsonlExtension(filePath: string): string {
	return filePath.endsWith(".jsonl") ? filePath.slice(0, -6) : filePath;
}

export function extractArtifactSessionId(name: string): string | undefined {
	return name.match(SESSION_ROOT_NAME_RE)?.[1];
}

function resolveRootArtifactDir(targetPath: string): { rootDir: string; sessionId?: string } {
	const resolvedPath = path.resolve(targetPath);
	if (resolvedPath.endsWith(".jsonl")) {
		const sessionId = extractArtifactSessionId(path.basename(resolvedPath, ".jsonl"));
		if (sessionId) {
			return { rootDir: stripJsonlExtension(resolvedPath), sessionId };
		}
	}

	let current = resolvedPath.endsWith(".jsonl") ? path.dirname(resolvedPath) : resolvedPath;
	while (true) {
		const sessionId = extractArtifactSessionId(path.basename(current));
		if (sessionId) {
			return { rootDir: current, sessionId };
		}
		const parent = path.dirname(current);
		if (parent === current) {
			return { rootDir: resolvedPath.endsWith(".jsonl") ? stripJsonlExtension(resolvedPath) : resolvedPath };
		}
		current = parent;
	}
}

export function resolveArtifactScopeFromSessionFile(sessionFile: string, sessionId?: string): ArtifactScope {
	const resolvedSessionFile = path.resolve(sessionFile);
	const legacyDir = stripJsonlExtension(resolvedSessionFile);
	const root = resolveRootArtifactDir(resolvedSessionFile);
	const resolvedSessionId = root.sessionId ?? sessionId ?? sanitizeSegment(path.basename(legacyDir), "session");
	const isMainSession = root.rootDir === legacyDir;
	const agentName = isMainSession ? "main" : sanitizeSegment(path.basename(resolvedSessionFile, ".jsonl"), "main");
	const agentDir = path.join(root.rootDir, agentName);
	return {
		sessionId: resolvedSessionId,
		rootDir: root.rootDir,
		agentName,
		agentDir,
		legacyDir,
	};
}

export function resolveArtifactScopeFromArtifactsDir(artifactsDir: string): {
	rootDir: string;
	sessionId?: string;
	agentName: string;
} {
	const resolvedArtifactsDir = path.resolve(artifactsDir);
	const root = resolveRootArtifactDir(resolvedArtifactsDir);
	const agentName =
		root.rootDir === resolvedArtifactsDir ? "main" : sanitizeSegment(path.basename(resolvedArtifactsDir), "main");
	return {
		rootDir: root.rootDir,
		sessionId: root.sessionId,
		agentName,
	};
}

export function buildArtifactUri(sessionId: string, agentName: string, toolType: string, filename: string): string {
	return `artifact://${sessionId}/${agentName}/${toolType}/${filename}`;
}

async function listFilesRecursively(dir: string): Promise<string[]> {
	let entries: nodeFs.Dirent[];
	try {
		entries = await fs.readdir(dir, { withFileTypes: true });
	} catch {
		return [];
	}

	const nested = await Promise.all(
		entries.map(async entry => {
			const fullPath = path.join(dir, entry.name);
			if (entry.isDirectory()) {
				return listFilesRecursively(fullPath);
			}
			return entry.isFile() ? [fullPath] : [];
		}),
	);
	return nested.flat();
}

function extractArtifactIdFromFilename(fileName: string): number | undefined {
	const match = path.basename(fileName).match(/^(\d+)\./);
	if (!match) return undefined;
	return Number.parseInt(match[1], 10);
}

function normalizeExtension(extension: string | undefined): string {
	const trimmed = (extension ?? "txt").trim().replace(/^\./, "").toLowerCase();
	if (trimmed.length === 0) return "txt";
	return sanitizeSegment(trimmed, "txt");
}

/**
 * Manages artifact storage for a session.
 *
 * Artifacts are stored with sequential IDs in the session's artifact directory.
 * The directory is created lazily on first write.
 */
export class ArtifactManager {
	#nextId = 0;
	readonly #scope: ArtifactScope;
	#initialized = false;

	/**
	 * @param sessionFile Path to the session .jsonl file
	 */
	constructor(sessionFile: string, sessionId?: string) {
		this.#scope = resolveArtifactScopeFromSessionFile(sessionFile, sessionId);
	}

	/**
	 * Artifact directory path for the current agent.
	 * Directory may not exist until first artifact is saved.
	 */
	get dir(): string {
		return this.#scope.agentDir;
	}

	get scope(): ArtifactScope {
		return this.#scope;
	}

	async #ensureInitialized(): Promise<void> {
		if (this.#initialized) return;
		this.#initialized = true;
		await this.#scanExistingIds();
	}

	/**
	 * Scan existing artifact files to find the next available ID.
	 * This ensures we don't overwrite artifacts when resuming a session.
	 */
	async #scanExistingIds(): Promise<void> {
		const files = await this.#listCurrentAgentFiles();
		let maxId = -1;
		for (const file of files) {
			const id = extractArtifactIdFromFilename(file);
			if (id !== undefined && id > maxId) {
				maxId = id;
			}
		}
		this.#nextId = maxId + 1;
	}

	async #listCurrentAgentFiles(): Promise<string[]> {
		const currentFiles = await listFilesRecursively(this.#scope.agentDir);
		if (this.#scope.legacyDir === this.#scope.agentDir) {
			return currentFiles;
		}

		let legacyEntries: nodeFs.Dirent[];
		try {
			legacyEntries = await fs.readdir(this.#scope.legacyDir, { withFileTypes: true });
		} catch {
			return currentFiles;
		}

		const legacyFiles = legacyEntries
			.filter(entry => entry.isFile())
			.map(entry => path.join(this.#scope.legacyDir, entry.name));
		return [...currentFiles, ...legacyFiles];
	}

	async #findCurrentAgentArtifact(id: string): Promise<string | null> {
		const files = await this.#listCurrentAgentFiles();
		const match = files.find(file => path.basename(file).startsWith(`${id}.`));
		return match ?? null;
	}

	/**
	 * Atomically allocate next artifact ID.
	 * IDs are sequential within the current agent scope.
	 */
	allocateId(): number {
		return this.#nextId++;
	}

	/**
	 * Allocate a new artifact path and URI without writing content.
	 */
	async allocatePath(toolType: string, extension?: string): Promise<ArtifactRef> {
		await this.#ensureInitialized();
		const id = String(this.allocateId());
		const safeToolType = sanitizeSegment(toolType, "artifact");
		const safeExtension = normalizeExtension(extension);
		const filename = `${id}.${safeExtension}`;
		const toolDir = path.join(this.#scope.agentDir, safeToolType);
		await fs.mkdir(toolDir, { recursive: true });
		return {
			id,
			uri: buildArtifactUri(this.#scope.sessionId, this.#scope.agentName, safeToolType, filename),
			path: path.join(toolDir, filename),
		};
	}

	/**
	 * Save content as an artifact and return its resolved reference.
	 */
	async save(content: string | Uint8Array, toolType: string, extension?: string): Promise<ArtifactRef> {
		const artifact = await this.allocatePath(toolType, extension);
		await Bun.write(artifact.path, content);
		return artifact;
	}

	/**
	 * Check if an artifact exists.
	 * Accepts either a numeric ID or a full artifact:// URI for the current agent.
	 */
	async exists(idOrUri: string): Promise<boolean> {
		const filePath = await this.getPath(idOrUri);
		return filePath !== null;
	}

	/**
	 * List all artifact files for the current agent.
	 * Returns paths relative to the agent artifact directory when possible.
	 */
	async listFiles(): Promise<string[]> {
		const files = await this.#listCurrentAgentFiles();
		return files.map(file =>
			file.startsWith(`${this.#scope.agentDir}${path.sep}`) ? path.relative(this.#scope.agentDir, file) : file,
		);
	}

	/**
	 * Get the full path to an artifact file for the current agent.
	 * Returns null if the artifact doesn't exist.
	 */
	async getPath(idOrUri: string): Promise<string | null> {
		await this.#ensureInitialized();
		const parsedUrl = idOrUri.startsWith("artifact://") ? new URL(idOrUri) : null;
		if (parsedUrl) {
			const [, agentName, toolType, filename] = parsedUrl.pathname.split("/");
			if (
				(parsedUrl.hostname || parsedUrl.host) !== this.#scope.sessionId ||
				agentName !== this.#scope.agentName ||
				!toolType ||
				!filename
			) {
				return null;
			}
			const candidate = path.join(this.#scope.rootDir, agentName, toolType, filename);
			try {
				const stat = await fs.stat(candidate);
				return stat.isFile() ? candidate : null;
			} catch {
				return null;
			}
		}

		return this.#findCurrentAgentArtifact(idOrUri);
	}
}
