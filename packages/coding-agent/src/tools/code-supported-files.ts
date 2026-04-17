import * as path from "node:path";
import { executeCodeBuffer } from "@oh-my-pi/pi-natives";

const FALLBACK_SEMANTIC_EXTENSIONS = new Set([
	"ts",
	"tsx",
	"js",
	"jsx",
	"mjs",
	"cjs",
	"mts",
	"cts",
	"rs",
	"py",
	"pyi",
	"html",
	"htm",
	"css",
	"typ",
	"md",
	"mdx",
	"markdown",
	"org",
	"ex",
	"exs",
]);

let semanticExtensionsCache: Set<string> | undefined;

export function extractSemanticExtensions(output: unknown): Set<string> {
	const record = output as { languages?: Array<{ extensions?: string[] }> } | undefined;
	const extensions = new Set<string>();
	for (const language of record?.languages ?? []) {
		for (const extension of language.extensions ?? []) {
			if (extension) extensions.add(extension.toLowerCase());
		}
	}
	return extensions;
}

export function getSemanticExtensions(): Set<string> {
	if (semanticExtensionsCache) return semanticExtensionsCache;

	try {
		const result = executeCodeBuffer({ command: "languages" });
		if (result.error) return FALLBACK_SEMANTIC_EXTENSIONS;
		const extensions = extractSemanticExtensions(result.output);
		if (extensions.size > 0) {
			semanticExtensionsCache = extensions;
			return extensions;
		}
	} catch {}

	return FALLBACK_SEMANTIC_EXTENSIONS;
}

export function _resetSupportedExtensionsForTest(override?: Set<string>): void {
	semanticExtensionsCache = override;
}

export function isCodeToolSemanticPath(file: string): boolean {
	const extension = path.extname(file).slice(1).toLowerCase();
	return extension.length > 0 && getSemanticExtensions().has(extension);
}

export function describeCodeToolSemanticFiles(): string {
	return "TypeScript, Rust, Python, HTML, CSS, Typst, Markdown, Org, and Elixir";
}

export const extractSupportedExtensions = extractSemanticExtensions;
export const getSupportedExtensions = getSemanticExtensions;
export const isCodeToolSupportedPath = isCodeToolSemanticPath;
export const describeCodeToolSupportedFiles = describeCodeToolSemanticFiles;
