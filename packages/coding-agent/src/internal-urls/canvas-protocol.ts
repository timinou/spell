/**
 * Protocol handler for canvas:// URLs.
 *
 * Resolves built-in Canvas (QML) files from the stdlib root.
 *
 * URL forms:
 * - canvas://stdlib/<path> - Reads a Canvas file from the stdlib root (modes/qml/)
 */
import * as path from "node:path";
import { validateRelativePath } from "./skill-protocol";
import type { InternalResource, InternalUrl, ProtocolHandler } from "./types";

export interface CanvasProtocolOptions {
	/**
	 * Returns the absolute path to the QML stdlib root directory (modes/qml/).
	 */
	getStdlibRoot: () => string;
}

const SUPPORTED_NAMESPACES = ["stdlib"] as const;

/**
 * Handler for canvas:// URLs.
 *
 * Only the "stdlib" namespace is supported. Future namespaces (e.g. skill-specific
 * Canvas bundles) can be added by extending this handler.
 */
export class CanvasProtocolHandler implements ProtocolHandler {
	readonly scheme = "canvas";

	constructor(private readonly options: CanvasProtocolOptions) {}

	async resolve(url: InternalUrl): Promise<InternalResource> {
		const namespace = url.rawHost || url.hostname;
		if (namespace !== "stdlib") {
			const available = SUPPORTED_NAMESPACES.join(", ");
			throw new Error(`Unknown canvas:// namespace: ${namespace}. Available: ${available}`);
		}

		const urlPath = url.pathname;
		const hasPath = urlPath && urlPath !== "/" && urlPath !== "";
		if (!hasPath) {
			throw new Error("canvas://stdlib requires a file path: canvas://stdlib/<path>");
		}

		const relativePath = decodeURIComponent(urlPath.slice(1)); // remove leading /
		validateRelativePath(relativePath);

		const stdlibRoot = path.resolve(this.options.getStdlibRoot());
		const targetPath = path.resolve(stdlibRoot, relativePath);

		// Containment check — must stay within stdlib root
		if (targetPath !== stdlibRoot && !targetPath.startsWith(stdlibRoot + path.sep)) {
			throw new Error("Path traversal is not allowed in canvas:// URLs");
		}

		const file = Bun.file(targetPath);
		if (!(await file.exists())) {
			throw new Error(`Canvas stdlib file not found: ${targetPath}`);
		}

		const content = await file.text();
		return {
			url: url.href,
			content,
			contentType: "text/plain",
			size: Buffer.byteLength(content, "utf-8"),
			sourcePath: targetPath,
			notes: [],
		};
	}
}
