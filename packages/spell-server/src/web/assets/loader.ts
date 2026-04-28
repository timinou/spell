import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { logger } from "@oh-my-pi/pi-utils";

export interface WebAsset {
	bytes: Uint8Array;
	mime: string;
	etag: string;
	hashed: boolean;
}

const MIME: Record<string, string> = {
	".html": "text/html; charset=utf-8",
	".js": "application/javascript; charset=utf-8",
	".mjs": "application/javascript; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".svg": "image/svg+xml",
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".gif": "image/gif",
	".webp": "image/webp",
	".ico": "image/x-icon",
	".woff": "font/woff",
	".woff2": "font/woff2",
	".ttf": "font/ttf",
	".json": "application/json; charset=utf-8",
	".map": "application/json; charset=utf-8",
	".txt": "text/plain; charset=utf-8",
};

export function inferMime(filename: string): string {
	const ext = path.extname(filename).toLowerCase();
	return MIME[ext] ?? "application/octet-stream";
}

async function sha256(bytes: Uint8Array): Promise<string> {
	const h = new Bun.CryptoHasher("sha256");
	h.update(bytes);
	return h.digest("hex");
}

function looksHashed(filename: string): boolean {
	// Vite output: `name-<8+ alphanumeric>.ext`
	return /-[A-Za-z0-9_]{8,}\.[a-zA-Z0-9]+$/.test(filename);
}

async function readDirRecursive(rootDir: string): Promise<string[]> {
	const out: string[] = [];
	async function walk(dir: string): Promise<void> {
		let items: import("node:fs").Dirent[];
		try {
			items = await fsp.readdir(dir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const item of items) {
			const full = path.join(dir, item.name);
			if (item.isDirectory()) await walk(full);
			else if (item.isFile()) out.push(full);
		}
	}
	await walk(rootDir);
	return out;
}

/**
 * Eagerly load every file under the bundled SPA `dist/` into memory keyed by
 * its `/web/<...>` URL path. Hashed asset paths get an immutable cache header;
 * `index.html` stays `no-cache` so deploys can rotate the bundle hash.
 */
export async function loadWebAssets(distDir: string): Promise<{
	assets: Map<string, WebAsset>;
	handle: (request: Request) => Promise<Response | null>;
}> {
	const assets = new Map<string, WebAsset>();
	const absDist = path.resolve(distDir);
	const files = await readDirRecursive(absDist);
	for (const filePath of files) {
		const rel = path.relative(absDist, filePath).replace(/\\/g, "/");
		const urlPath = `/web/${rel}`;
		const bytes = await fsp.readFile(filePath);
		const etag = `"${(await sha256(bytes)).slice(0, 16)}"`;
		assets.set(urlPath, { bytes, mime: inferMime(filePath), etag, hashed: looksHashed(rel) });
	}
	logger.debug("loaded web assets", { count: assets.size, dist: absDist });

	async function handle(request: Request): Promise<Response | null> {
		const url = new URL(request.url);
		if (!url.pathname.startsWith("/web")) return null;
		let key = url.pathname;
		if (key === "/web" || key === "/web/") key = "/web/index.html";
		const asset = assets.get(key);
		if (!asset) {
			if (url.pathname.startsWith("/web/api/") || url.pathname.startsWith("/web/artifacts/")) {
				return null;
			}
			if (url.pathname === "/web/ws") return null;
			const index = assets.get("/web/index.html");
			if (!index) return null;
			return new Response(index.bytes, {
				status: 200,
				headers: { "Content-Type": index.mime, "Cache-Control": "no-cache" },
			});
		}
		const headers: Record<string, string> = {
			"Content-Type": asset.mime,
			ETag: asset.etag,
			"Cache-Control": asset.hashed ? "public, max-age=31536000, immutable" : "no-cache",
		};
		const inm = request.headers.get("If-None-Match");
		if (inm && inm === asset.etag) {
			return new Response(null, { status: 304, headers });
		}
		return new Response(asset.bytes, { status: 200, headers });
	}

	return { assets, handle };
}

export function fallbackPlaceholderResponse(): Response {
	const body =
		'<!doctype html><meta charset="utf-8"><title>Spell Dashboard</title><body style="font-family: ui-sans-serif; padding: 2em; background: #0d1117; color: #c9d1d9;"><h1>Spell Dashboard</h1><p>Frontend bundle is missing. Run <code>bun run build:web</code> from <code>packages/spell-server</code> to populate the SPA.</p></body>';
	return new Response(body, {
		status: 200,
		headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-cache" },
	});
}
