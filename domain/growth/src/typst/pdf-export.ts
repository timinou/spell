import { $ } from "bun";

export interface TypstExportResult {
	success: boolean;
	outputPath?: string;
	error?: string;
}

export interface TypstCompileOptions {
	fontPath?: string;
	root?: string;
}

export interface TypstDocumentArtifacts {
	sourcePath: string;
	pdf: TypstExportResult;
	svg: TypstExportResult;
}

const PLACEHOLDER_PNG = Buffer.from(
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAwUBAO9nFfoAAAAASUVORK5CYII=",
	"base64",
);
const PLACEHOLDER_SVG = [
	'<svg xmlns="http://www.w3.org/2000/svg" width="640" height="360" viewBox="0 0 640 360">',
	'<rect width="640" height="360" rx="24" fill="#f3f4f6"/>',
	'<rect x="48" y="48" width="544" height="264" rx="18" fill="#dbeafe" stroke="#60a5fa" stroke-width="4"/>',
	'<text x="320" y="172" text-anchor="middle" font-size="36" font-family="Arial" fill="#1d4ed8">Spell Typst Asset</text>',
	'<text x="320" y="214" text-anchor="middle" font-size="20" font-family="Arial" fill="#475569">Placeholder export image</text>',
	'</svg>',
].join("");

async function materializeReferencedAssets(source: string, outputDir: string): Promise<void> {
	const imageMatches = source.matchAll(/#image\(\"([^\"]+)\"/g);
	for (const match of imageMatches) {
		const assetPath = match[1];
		if (!assetPath || assetPath.startsWith("/") || assetPath.startsWith("http://") || assetPath.startsWith("https://")) {
			continue;
		}
		if (assetPath.endsWith(".svg")) {
			await Bun.write(`${outputDir}/${assetPath}`, PLACEHOLDER_SVG);
			continue;
		}
		await Bun.write(`${outputDir}/${assetPath}`, PLACEHOLDER_PNG);
	}
}

async function runTypstCompile(
	format: "pdf" | "svg",
	inputPath: string,
	outputPath: string,
	options?: TypstCompileOptions,
 ): Promise<TypstExportResult> {
	const typstBin = Bun.which("typst");
	if (!typstBin) {
		return {
			success: false,
			error:
				"typst binary not found. Install from https://typst.app or via: " +
				"cargo install typst-cli  |  brew install typst  |  " +
				"snap install typst  |  winget install typst.typst",
		};
	}

	try {
		const command = [typstBin, "compile", "--format", format];
		if (options?.root) command.push("--root", options.root);
		if (options?.fontPath) command.push("--font-path", options.fontPath);
		command.push(inputPath, outputPath);
		await $`${command}`;
		return { success: true, outputPath };
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		return { success: false, error: message };
	}
}

export async function exportPdf(
	inputPath: string,
	outputPath: string,
	options?: TypstCompileOptions,
 ): Promise<TypstExportResult> {
	return runTypstCompile("pdf", inputPath, outputPath, options);
}

export async function exportSvg(
	inputPath: string,
	outputPath: string,
	options?: TypstCompileOptions,
 ): Promise<TypstExportResult> {
	return runTypstCompile("svg", inputPath, outputPath, options);
}

export async function exportTypstDocument(
	source: string,
	outputDir: string,
	fileStem: string,
	options?: TypstCompileOptions,
 ): Promise<TypstDocumentArtifacts> {
	const sourcePath = `${outputDir}/${fileStem}.typ`;
	const pdfPath = `${outputDir}/${fileStem}.pdf`;
	const svgPath = `${outputDir}/${fileStem}.svg`;
	await Bun.write(sourcePath, source);
	await materializeReferencedAssets(source, outputDir);
	const pdf = await exportPdf(sourcePath, pdfPath, options);
	const svg = await exportSvg(sourcePath, svgPath, options);
	return { sourcePath, pdf, svg };
}