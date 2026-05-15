import { native } from "../native";

import type { CodePathOptions, CodePathChunk, OpKindInfo, QualifierInfo, EdgeKindInfo, DiagnosticVariantInfo, LanguageDialectInfo } from "./types";

export type { CodePathOptions, CodePathChunk, NodeRefDto, ContentDto, DiagnosticDto, SpanDto, OpKindInfo, QualifierInfo, EdgeKindInfo, DiagnosticVariantInfo, LanguageDialectInfo } from "./types";

export async function executeCodePath(options: CodePathOptions): Promise<CodePathChunk[]> {
	return native.executeCodePath(options);
}

export function parseCodePath(target: string): any {
	return native.parseCodePath(target);
}

export function renderCodePath(ast: any): string {
	return native.renderCodePath(ast);
}

export function getRegisteredExtensions(): string[] {
	return native.getRegisteredExtensions();
}

export function listOpKinds(): OpKindInfo[] {
	return native.listOpKinds();
}

export function listQualifiers(): QualifierInfo[] {
	return native.listQualifiers();
}

export function listEdgeKinds(): EdgeKindInfo[] {
	return native.listEdgeKinds();
}

export function listDiagnosticVariants(): DiagnosticVariantInfo[] {
	return native.listDiagnosticVariants();
}

export function listLanguageDialects(): LanguageDialectInfo[] {
	return native.listLanguageDialects();
}
