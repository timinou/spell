import { native } from "../native";

import type {
	CodePathChunk,
	CodePathOptions,
	DiagnosticVariantInfo,
	EdgeKindInfo,
	FieldSchemaDto,
	LanguageDialectInfo,
	OpKindInfo,
	OpSchemaDto,
	QualifierInfo,
} from "./types";

export type {
	CodePathChunk,
	CodePathOptions,
	ContentDto,
	DiagnosticDto,
	DiagnosticVariantInfo,
	EdgeKindInfo,
	FieldSchemaDto,
	LanguageDialectInfo,
	NodeRefDto,
	OpKindInfo,
	OpSchemaDto,
	QualifierInfo,
	SpanDto,
} from "./types";

export function listOps(): OpSchemaDto[] {
	return native.listOps();
}

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
