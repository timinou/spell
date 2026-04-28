import * as path from "node:path";
import { logger } from "@oh-my-pi/pi-utils";
import { verifyWebToken } from "../../http/auth";
import { verifySignedUrl } from "./signed-url";
import type { ArtifactRequestDeps } from "./types";

const SAFE_SEGMENT = /^[a-zA-Z0-9._-]+$/;

const MIME_FALLBACK: Record<string, string> = {
	".pdf": "application/pdf",
	".typ": "text/plain",
	".svg": "image/svg+xml",
	".md": "text/markdown",
	".log": "text/plain",
	".jsonl": "application/x-ndjson",
};

interface ParsedArtifactRequest {
	sessionId: string;
	agent: string;
	tool: string;
	filename: string;
}

function parseArtifactPath(pathname: string): ParsedArtifactRequest | null {
	if (!pathname.startsWith("/web/artifacts/")) return null;
	const remainder = pathname.slice("/web/artifacts/".length);
	const segments = remainder.split("/");
	if (segments.length !== 4) return null;
	for (const segment of segments) {
		if (!segment || segment === ".." || segment === "." || !SAFE_SEGMENT.test(segment)) return null;
	}
	const [sessionId, agent, tool, filename] = segments as [string, string, string, string];
	return { sessionId, agent, tool, filename };
}

function resolveMime(filename: string, fileType: string): string {
	if (fileType && fileType !== "application/octet-stream") return fileType;
	const ext = path.extname(filename).toLowerCase();
	return MIME_FALLBACK[ext] ?? "application/octet-stream";
}

/**
 * Serve a single artifact file. Two auth modes are supported:
 *  - `Authorization: Bearer <token>` against the configured `web.tokens`.
 *  - Short-lived signed URL via `?sig=` + `?exp=` (used by iframe/img/video
 *    embeds where browsers cannot inject custom headers).
 *
 * Returns `null` when the request is not a `/web/artifacts/*` URL so the
 * caller can fall through to the next route handler.
 */
export async function handleArtifactsRoute(request: Request, deps: ArtifactRequestDeps): Promise<Response | null> {
	const url = new URL(request.url);
	const parsed = parseArtifactPath(url.pathname);
	if (!parsed) return null;

	if (request.method !== "GET" && request.method !== "HEAD") {
		return new Response("Method Not Allowed", { status: 405, headers: { Allow: "GET, HEAD" } });
	}

	// Auth: prefer signed URL when present so embed contexts work.
	const hasSignature = url.searchParams.has("sig") && url.searchParams.has("exp");
	if (hasSignature) {
		const verdict = verifySignedUrl(request, deps.signingKey);
		if (!verdict.valid) {
			return new Response("Unauthorized", { status: 401 });
		}
	} else {
		const identity = verifyWebToken(request, deps.web);
		if (!identity) {
			return new Response("Unauthorized", { status: 401 });
		}
	}

	const sessionRoot = deps.sessionRoots(parsed.sessionId);
	if (!sessionRoot) return new Response("Not Found", { status: 404 });

	const targetPath = path.join(sessionRoot, parsed.agent, parsed.tool, parsed.filename);
	const rel = path.relative(sessionRoot, targetPath);
	if (rel.startsWith("..") || path.isAbsolute(rel)) {
		return new Response("Bad Request", { status: 400 });
	}

	const file = Bun.file(targetPath);
	if (!(await file.exists())) {
		return new Response("Not Found", { status: 404 });
	}
	const mime = resolveMime(parsed.filename, file.type ?? "");
	const sizeBytes = file.size;
	const headers: Record<string, string> = {
		"Content-Type": mime,
		"Content-Length": String(sizeBytes),
		"Content-Disposition": `${url.searchParams.get("download") === "1" ? "attachment" : "inline"}; filename=${JSON.stringify(parsed.filename)}`,
		"Cache-Control": "private, max-age=300",
	};
	if (request.method === "HEAD") {
		return new Response(null, { status: 200, headers });
	}
	logger.debug("serving artifact", {
		sessionId: parsed.sessionId,
		filename: parsed.filename,
		signed: hasSignature,
	});
	return new Response(file.stream(), { status: 200, headers });
}
