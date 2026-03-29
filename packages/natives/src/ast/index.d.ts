/**
 * Native AST structural search and rewrite wrappers.
 */
import type { AstFindOptions, AstFindResult, AstReplaceOptions, AstReplaceResult } from "./types";
export type { AstFindMatch, AstFindOptions, AstFindResult, AstReplaceChange, AstReplaceFileChange, AstReplaceOptions, AstReplaceResult, AstStrictness, } from "./types";
export declare function astGrep(options: AstFindOptions): Promise<AstFindResult>;
export declare function astEdit(options: AstReplaceOptions): Promise<AstReplaceResult>;
//# sourceMappingURL=index.d.ts.map