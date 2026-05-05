import { native } from "../native";

import type { CodePathOptions, CodePathChunk } from "./types";

export type { CodePathOptions, CodePathChunk, NodeRefDto, ContentDto, DiagnosticDto, SpanDto } from "./types";

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
