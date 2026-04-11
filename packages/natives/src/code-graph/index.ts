import { native } from "../native";

import type { CodeGraphOptions, CodeGraphResult } from "./types";

export type { CodeGraphOptions, CodeGraphResult } from "./types";

export async function executeCodeGraph(options: CodeGraphOptions): Promise<CodeGraphResult> {
	return native.executeCodeGraph(options);
}
