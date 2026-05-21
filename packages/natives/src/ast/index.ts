/**
 * Native AST structural search wrappers.
 */

import { native } from "../native";
import type { AstFindOptions, AstFindResult } from "./types";

export type { AstFindMatch, AstFindOptions, AstFindResult, AstStrictness } from "./types";

export async function astGrep(options: AstFindOptions): Promise<AstFindResult> {
	return native.astGrep(options);
}
