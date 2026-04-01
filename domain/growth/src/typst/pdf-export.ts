import { $ } from "bun";

export interface PdfExportResult {
  success: boolean;
  outputPath?: string;
  error?: string;
}

/**
 * Compile a Typst source file to PDF using the `typst` CLI.
 *
 * Preconditions:
 * - `typst` binary must be on PATH (https://typst.app).
 * - `inputPath` must be a valid Typst source file.
 *
 * Returns a structured result rather than throwing so callers can handle
 * missing-binary gracefully (e.g. show an install prompt in the UI).
 */
export async function exportPdf(
  inputPath: string,
  outputPath: string,
  options?: { fontPath?: string }
): Promise<PdfExportResult> {
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
    if (options?.fontPath) {
      await $`${typstBin} compile --font-path ${options.fontPath} ${inputPath} ${outputPath}`;
    } else {
      await $`${typstBin} compile ${inputPath} ${outputPath}`;
    }

    return { success: true, outputPath };
  } catch (err) {
    // Bun shell throws when the process exits non-zero; stderr is in the message.
    const message = err instanceof Error ? err.message : String(err);
    return { success: false, error: message };
  }
}
