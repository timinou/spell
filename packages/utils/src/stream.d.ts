export declare function readLines(stream: ReadableStream<Uint8Array>, signal?: AbortSignal): AsyncGenerator<Uint8Array>;
export declare function readJsonl<T>(stream: ReadableStream<Uint8Array>, signal?: AbortSignal): AsyncGenerator<T>;
/**
 * Stream parsed JSON objects from SSE `data:` lines.
 *
 * @example
 * ```ts
 * for await (const obj of readSseJson(response.body!)) {
 *   console.log(obj);
 * }
 * ```
 */
export declare function readSseJson<T>(stream: ReadableStream<Uint8Array>, signal?: AbortSignal): AsyncGenerator<T>;
/**
 * Parse a complete JSONL string, skipping malformed lines instead of throwing.
 *
 * Uses `Bun.JSONL.parseChunk` internally. On parse errors, the malformed
 * region is skipped up to the next newline and parsing continues.
 *
 * @example
 * ```ts
 * const entries = parseJsonlLenient<MyType>(fileContents);
 * ```
 */
export declare function parseJsonlLenient<T>(buffer: string): T[];
//# sourceMappingURL=stream.d.ts.map