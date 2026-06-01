import type { CodePathChunk, CodePathOptions, DiagnosticVariantInfo, EdgeKindInfo, LanguageDialectInfo, OpKindInfo, OpSchemaDto, QualifierInfo } from "./types";
export type { CodePathChunk, CodePathOptions, ContentDto, DiagnosticDto, DiagnosticVariantInfo, EdgeKindInfo, FieldSchemaDto, LanguageDialectInfo, NodeRefDto, OpKindInfo, OpSchemaDto, QualifierInfo, SpanDto, } from "./types";
export declare function listOps(): OpSchemaDto[];
export declare function executeCodePath(options: CodePathOptions): Promise<CodePathChunk[]>;
export declare function parseCodePath(target: string): any;
export declare function renderCodePath(ast: any): string;
export declare function getRegisteredExtensions(): string[];
export declare function listOpKinds(): OpKindInfo[];
export declare function listQualifiers(): QualifierInfo[];
export declare function listEdgeKinds(): EdgeKindInfo[];
export declare function listDiagnosticVariants(): DiagnosticVariantInfo[];
export declare function listLanguageDialects(): LanguageDialectInfo[];
export declare function registerSchemeCallback(scheme: string, callback: (body: string) => {
    url: string;
    content: string;
    mime?: string;
    notes?: string[];
    sourcePath?: string;
}, options?: import("./types").SchemeCallbackOptions): void;
export declare function unregisterSchemeCallback(scheme: string): boolean;
export declare function listRegisteredSchemes(): string[];
export declare function clearRuntimeSchemes(): void;
//# sourceMappingURL=index.d.ts.map