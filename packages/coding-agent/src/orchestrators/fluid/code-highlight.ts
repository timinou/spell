import { logger } from "@oh-my-pi/pi-utils";
import { createHighlighter, type Highlighter } from "shiki";

const HIGHLIGHT_THEME = "github-dark";
const HIGHLIGHT_LANGUAGES = [
	"typescript",
	"ts",
	"tsx",
	"javascript",
	"js",
	"jsx",
	"json",
	"yaml",
	"yml",
	"bash",
	"sh",
	"shellscript",
	"python",
	"py",
	"go",
	"rust",
	"sql",
	"diff",
	"markdown",
	"md",
] as const;

const HIGHLIGHT_LANGUAGE_SET = new Set<string>(HIGHLIGHT_LANGUAGES);
const LANGUAGE_ALIASES: Record<string, string> = {
	"c++": "cpp",
	"c#": "csharp",
	shell: "bash",
	zsh: "bash",
	plaintext: "text",
	txt: "text",
};

let highlighter: Highlighter | undefined;
void createFluidCodeHighlighter()
	.then(initializedHighlighter => {
		highlighter = initializedHighlighter;
	})
	.catch(() => undefined);

export interface FluidCodeBlockData {
	language: string;
	code: string;
	html: string;
}

function parseCodePayload(content: string): { code: string; languageHint?: string } {
	const fencedCodeMatch = /```([^\n`]*)\n([\s\S]*?)```/m.exec(content);
	if (!fencedCodeMatch) {
		return { code: content };
	}

	const [, rawLanguage, rawCode] = fencedCodeMatch;
	const code = rawCode.replace(/\n$/, "");
	const languageHint = rawLanguage.trim().toLowerCase();
	return {
		code,
		languageHint: languageHint.length > 0 ? languageHint : undefined,
	};
}

function normalizeLanguage(languageHint?: string): string {
	if (!languageHint) {
		return "text";
	}

	const normalized = languageHint.trim().toLowerCase();
	if (normalized.length === 0) {
		return "text";
	}

	const resolved = LANGUAGE_ALIASES[normalized] ?? normalized;
	if (!HIGHLIGHT_LANGUAGE_SET.has(resolved)) {
		return "text";
	}
	return resolved;
}

async function createFluidCodeHighlighter(): Promise<Highlighter | undefined> {
	try {
		return await createHighlighter({
			langs: [...HIGHLIGHT_LANGUAGES],
			themes: [HIGHLIGHT_THEME],
		});
	} catch (err) {
		logger.warn("Failed to initialize fluid code highlighter", {
			error: err instanceof Error ? err.message : String(err),
		});
		return undefined;
	}
}

export function highlightFluidCode(content: string): FluidCodeBlockData {
	const parsed = parseCodePayload(content);
	const language = normalizeLanguage(parsed.languageHint);
	if (!highlighter || language === "text") {
		return {
			language,
			code: parsed.code,
			html: "",
		};
	}

	try {
		return {
			language,
			code: parsed.code,
			html: highlighter.codeToHtml(parsed.code, { lang: language, theme: HIGHLIGHT_THEME }),
		};
	} catch (err) {
		logger.warn("Failed to highlight fluid code block", {
			language,
			error: err instanceof Error ? err.message : String(err),
		});
		return {
			language,
			code: parsed.code,
			html: "",
		};
	}
}
