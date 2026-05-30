import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { isEnoent } from "@spell/pi-utils";
import { validateRelativePath } from "./path-validation";
import type { InternalResource, InternalUrl, ProtocolHandler } from "./types";

export interface CanvasProtocolOptions {
	/**
	 * Returns the absolute path to the QML stdlib root directory (modes/qml/).
	 */
	getStdlibRoot: () => string;
	/**
	 * Returns the current session artifacts directory. When present, canvas session
	 * files are stored under <artifacts>/canvas.
	 */
	getArtifactsDir?: () => string | null;
	/**
	 * Returns current session id for tmpdir fallback when artifacts are unavailable.
	 */
	getSessionId?: () => string | null;
}

const CANVAS_SESSION_ROOT_DIR = "canvas";
const SUPPORTED_NAMESPACES = ["stdlib", "session"] as const;
const MUTABLE_NAMESPACES = ["session"] as const;
type CanvasNamespace = (typeof SUPPORTED_NAMESPACES)[number];
type MutableCanvasNamespace = (typeof MUTABLE_NAMESPACES)[number];

function parseCanvasUrl(input: string): InternalUrl {
	let parsed: URL;
	try {
		parsed = new URL(input);
	} catch {
		throw new Error(`Invalid URL: ${input}`);
	}

	const hostMatch = input.match(/^([a-z][a-z0-9+.-]*):\/\/([^/?#]*)/i);
	let rawHost = hostMatch ? hostMatch[2] : parsed.hostname;
	try {
		rawHost = decodeURIComponent(rawHost);
	} catch {
		// Keep rawHost if decoding fails.
	}
	(parsed as InternalUrl).rawHost = rawHost;

	const pathMatch = input.match(/^[a-z][a-z0-9+.-]*:\/\/[^/?#]*(\/[^?#]*)?/i);
	(parsed as InternalUrl).rawPathname = pathMatch?.[1] ?? parsed.pathname;

	return parsed as InternalUrl;
}

function ensureWithinRoot(targetPath: string, rootPath: string, namespace: CanvasNamespace): void {
	if (targetPath !== rootPath && !targetPath.startsWith(`${rootPath}${path.sep}`)) {
		throw new Error(`canvas://${namespace} URL escapes namespace root`);
	}
}

function toCanvasValidationError(error: unknown): Error {
	const message = error instanceof Error ? error.message : String(error);
	return new Error(message.replace("skill://", "canvas://"));
}

function getNamespace(url: InternalUrl): CanvasNamespace {
	const namespace = url.rawHost || url.hostname;
	if (!namespace) {
		throw new Error("canvas:// URL requires a namespace: canvas://stdlib/<path> or canvas://session/<path>");
	}
	if (!SUPPORTED_NAMESPACES.includes(namespace as CanvasNamespace)) {
		const available = SUPPORTED_NAMESPACES.join(", ");
		throw new Error(`Unknown canvas:// namespace: ${namespace}. Available: ${available}`);
	}
	return namespace as CanvasNamespace;
}

function getRelativePath(url: InternalUrl, namespace: CanvasNamespace): string {
	const rawPathname = url.rawPathname ?? url.pathname;
	const hasPath = rawPathname && rawPathname !== "/" && rawPathname !== "";
	if (!hasPath) {
		throw new Error(`canvas://${namespace} requires a file path: canvas://${namespace}/<path>`);
	}

	let relativePath: string;
	try {
		relativePath = decodeURIComponent(rawPathname.slice(1));
	} catch {
		throw new Error(`Invalid URL encoding in canvas://${namespace} path: ${url.href}`);
	}

	try {
		validateRelativePath(relativePath, "canvas");
	} catch (error) {
		throw toCanvasValidationError(error);
	}

	return relativePath;
}

async function resolveNamespaceRoot(namespace: CanvasNamespace, options: CanvasProtocolOptions): Promise<string> {
	const roots = resolveCanvasRoots(options);
	const root = namespace === "stdlib" ? roots.stdlibRoot : roots.sessionRoot;

	if (namespace === "session") {
		await fs.mkdir(root, { recursive: true });
	}

	return root;
}

export function resolveCanvasRoots(options: CanvasProtocolOptions): { stdlibRoot: string; sessionRoot: string } {
	const stdlibRoot = path.resolve(options.getStdlibRoot());
	const artifactsDir = options.getArtifactsDir?.();
	if (artifactsDir) {
		return {
			stdlibRoot,
			sessionRoot: path.resolve(artifactsDir, CANVAS_SESSION_ROOT_DIR),
		};
	}

	const sessionId = options.getSessionId?.() ?? "session";
	const safeSessionId = sessionId.replace(/[^a-zA-Z0-9_.-]/g, "_");
	return {
		stdlibRoot,
		sessionRoot: path.join(os.tmpdir(), "spell-canvas", safeSessionId),
	};
}

export function resolveCanvasUrlToPath(
	input: string | InternalUrl,
	options: CanvasProtocolOptions,
	intent: "read" | "write" = "read",
): string {
	const url = typeof input === "string" ? parseCanvasUrl(input) : input;
	const namespace = getNamespace(url);
	if (intent === "write" && !MUTABLE_NAMESPACES.includes(namespace as MutableCanvasNamespace)) {
		throw new Error(`canvas://${namespace} is read-only`);
	}

	const roots = resolveCanvasRoots(options);
	const namespaceRoot = path.resolve(namespace === "stdlib" ? roots.stdlibRoot : roots.sessionRoot);
	const relativePath = getRelativePath(url, namespace);
	const targetPath = path.resolve(namespaceRoot, relativePath);
	ensureWithinRoot(targetPath, namespaceRoot, namespace);
	return targetPath;
}

/**
 * Protocol handler for canvas:// URLs.
 *
 * URL forms:
 * - canvas://stdlib/<path> - Reads built-in Canvas files from the stdlib root (modes/qml/)
 * - canvas://session/<path> - Reads session-scoped canvas files from session artifacts
 */
export class CanvasProtocolHandler implements ProtocolHandler {
	readonly scheme = "canvas";

	constructor(private readonly options: CanvasProtocolOptions) {}

	async resolve(url: InternalUrl): Promise<InternalResource> {
		const namespace = getNamespace(url);
		const namespaceRoot = await resolveNamespaceRoot(namespace, this.options);
		let resolvedRoot: string;
		try {
			resolvedRoot = await fs.realpath(namespaceRoot);
		} catch (error) {
			if (isEnoent(error)) {
				throw new Error(`Canvas ${namespace} namespace root not found: ${namespaceRoot}`);
			}
			throw error;
		}

		const relativePath = getRelativePath(url, namespace);
		const targetPath = path.resolve(resolvedRoot, relativePath);
		ensureWithinRoot(targetPath, resolvedRoot, namespace);

		const parentDir = path.dirname(targetPath);
		try {
			const realParent = await fs.realpath(parentDir);
			ensureWithinRoot(realParent, resolvedRoot, namespace);
		} catch (error) {
			if (!isEnoent(error)) {
				throw error;
			}
		}

		let realTargetPath: string;
		try {
			realTargetPath = await fs.realpath(targetPath);
		} catch (error) {
			if (isEnoent(error)) {
				throw new Error(`Canvas ${namespace} file not found: ${url.href}`);
			}
			throw error;
		}
		ensureWithinRoot(realTargetPath, resolvedRoot, namespace);

		const stat = await fs.stat(realTargetPath);
		if (!stat.isFile()) {
			throw new Error(`canvas://${namespace} URL must resolve to a file: ${url.href}`);
		}

		const content = await Bun.file(realTargetPath).text();
		return {
			url: url.href,
			content,
			contentType: "text/plain",
			size: Buffer.byteLength(content, "utf-8"),
			sourcePath: realTargetPath,
			notes: namespace === "session" ? ["Session canvas files persist for this session id."] : [],
		};
	}
}
