/**
 * Protocol handler for artifact:// URLs.
 *
 * Resolves session-scoped artifact URIs to files in the session artifacts directory.
 * Unlike agent://, artifacts are raw tool outputs with no JSON extraction.
 *
 * URL forms:
 * - artifact://<session-id>/<agent>/<tool>/<number>.<ext>
 * - artifact://<id> (legacy current-session lookup)
 *
 * Pagination is handled by the read tool via offset/limit parameters.
 */

import type * as nodeFs from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { getSessionsDir, isEnoent } from "@oh-my-pi/pi-utils";
import { extractArtifactSessionId, resolveArtifactScopeFromArtifactsDir } from "../session/artifacts";
import type { InternalResource, InternalUrl, ProtocolHandler } from "./types";

const BINARY_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".pdf"]);

export interface ArtifactProtocolOptions {
	/**
	 * Returns the artifacts directory path, or null if no session.
	 */
	getArtifactsDir: () => string | null;
}

interface ArtifactUriParts {
	sessionId: string;
	agentName: string;
	toolType: string;
	filename: string;
}

function decodeArtifactSegments(rawPathname: string | undefined): string[] {
	return (rawPathname ?? "/")
		.split("/")
		.filter(Boolean)
		.map(segment => {
			const decoded = decodeURIComponent(segment);
			if (
				decoded.length === 0 ||
				decoded === "." ||
				decoded === ".." ||
				decoded.includes("/") ||
				decoded.includes("\\")
			) {
				throw new Error(`Invalid artifact path segment: ${segment}`);
			}
			return decoded;
		});
}

function parseArtifactUri(url: InternalUrl): ArtifactUriParts | null {
	const sessionId = url.rawHost || url.hostname;
	const segments = decodeArtifactSegments(url.rawPathname ?? url.pathname);
	if (segments.length === 0) {
		return null;
	}
	if (!/^[0-9a-f]+$/i.test(sessionId)) {
		throw new Error(`artifact:// session ID must be a hex snowflake, got: ${sessionId}`);
	}
	if (segments.length !== 3) {
		throw new Error(
			"artifact:// URL must be artifact://<session-id>/<agent-name>/<tool>/<number>.<ext> or legacy artifact://<id>",
		);
	}
	const [agentName, toolType, filename] = segments;
	if (!/^\d+\.[a-z0-9._-]+$/i.test(filename)) {
		throw new Error(`artifact:// file name must be <number>.<ext>, got: ${filename}`);
	}
	return { sessionId, agentName, toolType, filename };
}

async function fileExists(filePath: string): Promise<boolean> {
	try {
		const stat = await fs.stat(filePath);
		return stat.isFile();
	} catch {
		return false;
	}
}

async function findSessionArtifactRoot(sessionId: string, currentRootDir?: string): Promise<string | null> {
	if (currentRootDir && extractArtifactSessionId(path.basename(currentRootDir)) === sessionId) {
		return currentRootDir;
	}

	const sessionsRoot = getSessionsDir();
	let projectDirs: nodeFs.Dirent[];
	try {
		projectDirs = await fs.readdir(sessionsRoot, { withFileTypes: true });
	} catch {
		return null;
	}

	for (const projectDir of projectDirs) {
		if (!projectDir.isDirectory()) continue;
		const projectPath = path.join(sessionsRoot, projectDir.name);
		let entries: nodeFs.Dirent[];
		try {
			entries = await fs.readdir(projectPath, { withFileTypes: true });
		} catch {
			continue;
		}

		const match = entries.find(entry => entry.isDirectory() && extractArtifactSessionId(entry.name) === sessionId);
		if (match) {
			return path.join(projectPath, match.name);
		}
	}

	return null;
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

async function listLegacyArtifacts(current: { rootDir: string; agentName: string }): Promise<string[]> {
	const agentDir = path.join(current.rootDir, current.agentName);
	const artifactIds = new Set<number>();
	const currentAgentFiles = await listFilesRecursively(agentDir);
	for (const filePath of currentAgentFiles) {
		const match = path.basename(filePath).match(/^(\d+)\./);
		if (match) {
			artifactIds.add(Number.parseInt(match[1], 10));
		}
	}

	const legacyRoot = current.agentName === "main" ? current.rootDir : path.join(current.rootDir, current.agentName);
	let legacyEntries: nodeFs.Dirent[];
	try {
		legacyEntries = await fs.readdir(legacyRoot, { withFileTypes: true });
	} catch {
		legacyEntries = [];
	}
	for (const entry of legacyEntries) {
		if (!entry.isFile()) continue;
		const match = entry.name.match(/^(\d+)\./);
		if (match) {
			artifactIds.add(Number.parseInt(match[1], 10));
		}
	}

	return [...artifactIds].sort((a, b) => a - b).map(String);
}

async function resolveLegacyArtifactPath(
	current: { rootDir: string; agentName: string },
	id: string,
): Promise<string | null> {
	const agentDir = path.join(current.rootDir, current.agentName);
	const currentAgentFiles = await listFilesRecursively(agentDir);
	const nestedMatch = currentAgentFiles.find(filePath => path.basename(filePath).startsWith(`${id}.`));
	if (nestedMatch) {
		return nestedMatch;
	}

	const legacyRoot = current.agentName === "main" ? current.rootDir : path.join(current.rootDir, current.agentName);
	let legacyEntries: nodeFs.Dirent[];
	try {
		legacyEntries = await fs.readdir(legacyRoot, { withFileTypes: true });
	} catch {
		return null;
	}
	const legacyMatch = legacyEntries.find(entry => entry.isFile() && entry.name.startsWith(`${id}.`));
	return legacyMatch ? path.join(legacyRoot, legacyMatch.name) : null;
}

async function buildResource(url: InternalUrl, filePath: string): Promise<InternalResource> {
	const stat = await fs.stat(filePath);
	const ext = path.extname(filePath).toLowerCase();
	if (BINARY_EXTENSIONS.has(ext)) {
		return {
			url: url.href,
			content: "",
			contentType: "text/plain",
			size: stat.size,
			sourcePath: filePath,
			notes: [`Binary artifact (${ext.slice(1)}). Use sourcePath-aware tools to inspect it.`],
		};
	}

	const content = await Bun.file(filePath).text();
	return {
		url: url.href,
		content,
		contentType: "text/plain",
		size: stat.size,
		sourcePath: filePath,
	};
}

/**
 * Handler for artifact:// URLs.
 *
 * Resolves session-scoped artifact URIs to their underlying files.
 * Legacy artifact://<id> URLs continue to resolve within the current agent scope.
 */
export class ArtifactProtocolHandler implements ProtocolHandler {
	readonly scheme = "artifact";

	constructor(private readonly options: ArtifactProtocolOptions) {}

	async resolve(url: InternalUrl): Promise<InternalResource> {
		const artifactsDir = this.options.getArtifactsDir();
		if (!artifactsDir) {
			throw new Error("No session - artifacts unavailable");
		}

		const current = resolveArtifactScopeFromArtifactsDir(artifactsDir);
		const hasScopedPath = decodeArtifactSegments(url.rawPathname ?? url.pathname).length > 0;
		if (hasScopedPath) {
			const parts = parseArtifactUri(url);
			if (!parts) {
				throw new Error("artifact:// URL requires an artifact path or legacy numeric ID");
			}
			const rootDir = await findSessionArtifactRoot(parts.sessionId, current.rootDir);
			if (!rootDir) {
				throw new Error(`Artifact session ${parts.sessionId} not found under ${getSessionsDir()}`);
			}
			const filePath = path.join(rootDir, parts.agentName, parts.toolType, parts.filename);
			if (!(await fileExists(filePath))) {
				throw new Error(`Artifact ${url.href} not found`);
			}
			return buildResource(url, filePath);
		}

		const id = url.rawHost || url.hostname;
		if (!id) {
			throw new Error("artifact:// URL requires an artifact ID or scoped path");
		}
		if (!/^\d+$/.test(id)) {
			throw new Error(`artifact:// legacy ID must be numeric, got: ${id}`);
		}

		try {
			await fs.stat(artifactsDir);
		} catch (err) {
			if (isEnoent(err)) {
				throw new Error("No artifacts directory found");
			}
			throw err;
		}

		const filePath = await resolveLegacyArtifactPath(current, id);
		if (!filePath) {
			const available = await listLegacyArtifacts(current);
			const availableStr = available.length > 0 ? available.join(", ") : "none";
			throw new Error(`Artifact ${id} not found. Available: ${availableStr}`);
		}
		return buildResource(url, filePath);
	}
}
