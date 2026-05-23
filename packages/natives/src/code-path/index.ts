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

// PLAN-310: dynamic scheme registration helpers.
//
// Callbacks MUST return synchronously — the underlying napi
// ThreadsafeFunction calls back into JS from a kernel worker thread and
// blocks on an mpsc channel for the return value. Async returns (Promise)
// fail napi-rs field deserialization. For naturally-async I/O, prefer
// sync variants (fs.readFileSync) inside callbacks.
export function registerSchemeCallback(
	scheme: string,
	callback: (body: string) => { url: string; content: string; mime?: string; notes?: string[]; sourcePath?: string },
	options?: import("./types").SchemeCallbackOptions,
): void {
	native.registerSchemeCallback(scheme, (err: Error | null, body: string) => {
		if (err) throw err;
		return callback(body);
	}, options);
}

export function unregisterSchemeCallback(scheme: string): boolean {
	return native.unregisterSchemeCallback(scheme);
}

export function listRegisteredSchemes(): string[] {
	return native.listRegisteredSchemes();
}

export function clearRuntimeSchemes(): void {
	native.clearRuntimeSchemes();
}
