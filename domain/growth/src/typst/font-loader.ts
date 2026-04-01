import * as path from "node:path";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import { isEnoent, logger } from "@oh-my-pi/pi-utils";
import type { TypstCompiler } from "./wasm-compiler";

const FONT_EXTENSIONS = new Set([".otf", ".ttf"]);

/**
 * Load every .otf/.ttf font found in `brandingDir` into `compiler`.
 *
 * - Skips unreadable / corrupted files with a warning rather than throwing.
 * - Returns the list of font file names that were successfully loaded.
 * - If no custom fonts are found, returns an empty array (system fonts will be used).
 */
export async function loadFonts(
  compiler: TypstCompiler,
  brandingDir: string
): Promise<string[]> {
  let entries: fs.Dirent[];

  try {
    entries = await fsp.readdir(brandingDir, { withFileTypes: true });
  } catch (err) {
    if (isEnoent(err)) {
      // Branding directory does not exist — fall back to system fonts silently.
      return [];
    }
    throw err;
  }

  const fontFiles = entries
    .filter(
      (e) =>
        e.isFile() && FONT_EXTENSIONS.has(path.extname(e.name).toLowerCase())
    )
    .map((e) => e.name);

  const loaded: string[] = [];

  for (const name of fontFiles) {
    const filePath = path.join(brandingDir, name);
    try {
      const file = Bun.file(filePath);
      const data = new Uint8Array(await file.arrayBuffer());
      // Use the bare filename as the VFS path — typst resolves fonts by name,
      // not by the VFS path, so keeping the path short is fine.
      compiler.addFont(name, data);
      loaded.push(name);
    } catch (err) {
      // A corrupted or unreadable font must not abort the entire load.
      const message = err instanceof Error ? err.message : String(err);
      logger.warn("font-loader: skipping font", { name, error: message });
    }
  }

  return loaded;
}
