/**
 * Types for native ast-grep operations.
 */
import type { Cancellable } from "../bindings";
export type AstStrictness = "cst" | "smart" | "ast" | "relaxed" | "signature";
export interface AstFindOptions extends Cancellable {
    patterns?: string[];
    lang?: string;
    path?: string;
    glob?: string;
    selector?: string;
    strictness?: AstStrictness;
    limit?: number;
    offset?: number;
    includeMeta?: boolean;
    context?: number;
}
export interface AstFindMatch {
    path: string;
    text: string;
    byteStart: number;
    byteEnd: number;
    startLine: number;
    startColumn: number;
    endLine: number;
    endColumn: number;
    metaVariables?: Record<string, string>;
}
export interface AstFindResult {
    matches: AstFindMatch[];
    totalMatches: number;
    filesWithMatches: number;
    filesSearched: number;
    limitReached: boolean;
    parseErrors?: string[];
}
declare module "../bindings" {
    interface NativeBindings {
        astGrep(options: AstFindOptions): Promise<AstFindResult>;
    }
}
//# sourceMappingURL=types.d.ts.map
