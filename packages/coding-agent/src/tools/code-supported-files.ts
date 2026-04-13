import * as path from "node:path";
import { executeCodeBuffer } from "@oh-my-pi/pi-natives";

const FALLBACK_EXTENSIONS = new Set([
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
	"typ",
	"md",
	"mdx",
	"markdown",
	"org",
	"ex",
	"exs",
]);

let supportedExtensionsCache: Set<string> | undefined;

export function extractSupportedExtensions(output: unknown): Set<string> {
	const record = output as { languages?: Array<{ extensions?: string[] }> } | undefined;
	const extensions = new Set<string>();
	for (const language of record?.languages ?? []) {
		for (const extension of language.extensions ?? []) {
			if (extension) extensions.add(extension.toLowerCase());
		}
	}
	return extensions;
}

export function getSupportedExtensions(): Set<string> {
	if (supportedExtensionsCache) return supportedExtensionsCache;

	try {
		const result = executeCodeBuffer({ command: "languages" });
		if (result.error) return FALLBACK_EXTENSIONS;
		const extensions = extractSupportedExtensions(result.output);
		if (extensions.size > 0) {
			supportedExtensionsCache = extensions;
			return extensions;
		}
	} catch {}

	return FALLBACK_EXTENSIONS;
}

export function _resetSupportedExtensionsForTest(override?: Set<string>): void {
	supportedExtensionsCache = override;
}

export function isCodeToolSupportedPath(file: string): boolean {
	const extension = path.extname(file).slice(1).toLowerCase();
	return extension.length > 0 && getSupportedExtensions().has(extension);
}

export function describeCodeToolSupportedFiles(): string {
	return "TypeScript, Rust, Python, Typst, Markdown, Org, and Elixir";
}
