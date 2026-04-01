/**
 * Typst WASM compiler wrapper.
 *
 * Wraps the typst-ts WASM modules. The actual npm packages may not be installed;
 * we define the interface and load lazily so callers get a clean error rather than
 * a hard startup crash.
 */

export interface CompileError {
  message: string;
  line?: number;
  column?: number;
}

export interface SourceMapEntry {
  /** ID of the SVG element that corresponds to this source position */
  svgElementId: string;
  sourceLine: number;
  sourceColumn?: number;
}

export interface CompileResult {
  svg: string;
  errors: CompileError[];
  sourceMap: SourceMapEntry[];
}

/**
 * Shape of the typst-ts WASM module we load at runtime.
 * Kept minimal — only the subset we actually need.
 */
interface TypstTsModule {
  TypstCompilerDriver: new () => TypstTsDriverInstance;
}

interface TypstTsDriverInstance {
  addSource(path: string, content: string): void;
  addFont(path: string, data: Uint8Array): void;
  compile(mainPath: string): { svg: string; diagnostics: Array<{ message: string; range?: { start: { line: number; character: number } } }> };
}

export class TypstCompiler {
  #driver: TypstTsDriverInstance | null = null;
  #initialized = false;
  #initError: string | null = null;

  /**
   * Load WASM modules. Must be called before compile().
   * Safe to call multiple times — subsequent calls are no-ops.
   */
  async init(): Promise<void> {
    if (this.#initialized) return;

    try {
      // Dynamic import so the module failing to resolve doesn't crash the whole process.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const mod: TypstTsModule = await import("@myriaddreamin/typst-ts-web-compiler" as any);
      this.#driver = new mod.TypstCompilerDriver();
      this.#initialized = true;
    } catch (err) {
      const msg =
        err instanceof Error ? err.message : String(err);
      this.#initError =
        `typst-ts WASM module unavailable: ${msg}. ` +
        `Install with: bun add @myriaddreamin/typst-ts-web-compiler`;
      this.#initialized = true; // prevent retry loops
    }
  }

  /**
   * Add a source file to the compiler's virtual filesystem.
   * Call init() first.
   */
  addSource(path: string, content: string): void {
    this.#requireDriver().addSource(path, content);
  }

  /**
   * Add a font to the compiler's virtual filesystem.
   * Call init() first.
   */
  addFont(path: string, data: Uint8Array): void {
    this.#requireDriver().addFont(path, data);
  }

  /**
   * Compile `mainPath` (must have been added via addSource).
   * Returns SVG output and any diagnostics. Never throws — errors are in result.errors.
   */
  async compile(mainPath: string): Promise<CompileResult> {
    if (this.#initError) {
      return {
        svg: "",
        errors: [{ message: this.#initError }],
        sourceMap: [],
      };
    }

    const driver = this.#requireDriver();

    try {
      const raw = driver.compile(mainPath);
      const errors: CompileError[] = (raw.diagnostics ?? []).map((d) => ({
        message: d.message,
        line: d.range?.start.line,
        column: d.range?.start.character,
      }));

      const sourceMap = extractSourceMap(raw.svg ?? "");

      return { svg: raw.svg ?? "", errors, sourceMap };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { svg: "", errors: [{ message }], sourceMap: [] };
    }
  }

  // ── private ─────────────────────────────────────────────────────────────────

  #requireDriver(): TypstTsDriverInstance {
    if (!this.#driver) {
      throw new Error(
        this.#initError ??
          "TypstCompiler not initialized — call init() first"
      );
    }
    return this.#driver;
  }
}

/**
 * Pull source-map entries that the typst-ts renderer embeds as data-source-line
 * attributes on SVG elements.
 */
function extractSourceMap(svg: string): SourceMapEntry[] {
  const entries: SourceMapEntry[] = [];
  // Match id="..." data-source-line="N" (order may vary).
  // We run two passes: collect ids with source-line attributes.
  const elementRe = /<[^>]+>/g;
  let m: RegExpExecArray | null;

  while ((m = elementRe.exec(svg)) !== null) {
    const tag = m[0];
    const idMatch = /\bid="([^"]+)"/.exec(tag);
    const lineMatch = /\bdata-source-line="(\d+)"/.exec(tag);
    if (idMatch && lineMatch) {
      const colMatch = /\bdata-source-col="(\d+)"/.exec(tag);
      entries.push({
        svgElementId: idMatch[1],
        sourceLine: parseInt(lineMatch[1], 10),
        sourceColumn: colMatch ? parseInt(colMatch[1], 10) : undefined,
      });
    }
  }

  return entries;
}
