import { native } from "../native";
import type { CodeBufferOptions, CodeBufferResult } from "./types";

export type { CodeBufferOptions, CodeBufferResult } from "./types";

export function executeCodeBuffer(options: CodeBufferOptions): CodeBufferResult {
	return native.executeCodeBuffer(options);
}
