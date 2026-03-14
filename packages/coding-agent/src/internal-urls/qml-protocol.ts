/**
 * Protocol handler for qml:// URLs.
 *
 * Resolves built-in QML files from the stdlib root.
 *
 * URL forms:
 * - qml://stdlib/<path> - Reads a QML file from the stdlib root (modes/qml/)
 */
import * as path from "node:path";
import { validateRelativePath } from "./skill-protocol";
import type { InternalResource, InternalUrl, ProtocolHandler } from "./types";

export interface QmlProtocolOptions {
	/**
	 * Returns the absolute path to the QML stdlib root directory (modes/qml/).
	 */
	getStdlibRoot: () => string;
}

const SUPPORTED_NAMESPACES = ["stdlib"] as const;

/**
 * Handler for qml:// URLs.
 *
 * Only the "stdlib" namespace is supported. Future namespaces (e.g. skill-specific
 * QML bundles) can be added by extending this handler.
 */
export class QmlProtocolHandler implements ProtocolHandler {
	readonly scheme = "qml";

	constructor(private readonly options: QmlProtocolOptions) {}

	async resolve(url: InternalUrl): Promise<InternalResource> {
		const namespace = url.rawHost || url.hostname;
		if (namespace !== "stdlib") {
			const available = SUPPORTED_NAMESPACES.join(", ");
			throw new Error(`Unknown qml:// namespace: ${namespace}. Available: ${available}`);
		}

		const urlPath = url.pathname;
		const hasPath = urlPath && urlPath !== "/" && urlPath !== "";
		if (!hasPath) {
			throw new Error("qml://stdlib requires a file path: qml://stdlib/<path>");
		}

		const relativePath = decodeURIComponent(urlPath.slice(1)); // remove leading /
		validateRelativePath(relativePath);

		const stdlibRoot = path.resolve(this.options.getStdlibRoot());
		const targetPath = path.resolve(stdlibRoot, relativePath);

		// Containment check — must stay within stdlib root
		if (targetPath !== stdlibRoot && !targetPath.startsWith(stdlibRoot + path.sep)) {
			throw new Error("Path traversal is not allowed in qml:// URLs");
		}

		const file = Bun.file(targetPath);
		if (!(await file.exists())) {
			throw new Error(`QML stdlib file not found: ${targetPath}`);
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
