import type { InternalResource, InternalUrl, ProtocolHandler } from "../internal-urls/types";

import {
	buildTaskUri,
	canonicalizeTaskUri,
	isTaskShortReference,
	isTaskUri,
	resolveTaskUri,
	type TaskUriContext,
	type TaskUriParts,
	type TaskUriScheme,
} from "./uri";

export interface TaskUriProtocolOptions extends TaskUriContext {
	/**
	 * Provides the active session id when canonicalizing `current` URIs.
	 */
	getCurrentSessionId?: () => string | undefined;
	/**
	 * Which scheme this handler instance resolves.
	 */
	scheme: TaskUriScheme;
}

function makeResolutionNotes(rawInput: string, canonicalUri: string): string[] {
	const notes = ["Task/data URI resolution is currently structural only."];
	if (rawInput !== canonicalUri) notes.push(`Canonicalized from ${rawInput}`);
	return notes;
}

type ResolvedTaskUri = TaskUriParts | null;

function toJsonResource(url: InternalUrl, canonicalUri: string, resolved: ResolvedTaskUri): InternalResource {
	return {
		url: canonicalUri,
		contentType: "application/json",
		content: JSON.stringify(
			{
				scheme: resolved?.scheme,
				canonicalUri,
				resolved: false,
				task: resolved,
				note: "Full task/data content resolution is deferred until DAG-native nodes land.",
			},
			null,
			2,
		),
		notes: makeResolutionNotes(url.href, canonicalUri),
	};
}

export function isTaskUriProtocol(input: string): boolean {
	return isTaskUri(input) || isTaskShortReference(input);
}

export class TaskUriProtocolHandler implements ProtocolHandler {
	readonly scheme: TaskUriScheme;

	constructor(private readonly options: TaskUriProtocolOptions) {
		this.scheme = options.scheme;
	}

	resolve(url: InternalUrl): Promise<InternalResource> {
		const currentSessionId = this.options.getCurrentSessionId?.() ?? this.options.currentSessionId;
		const currentAgentName = this.options.currentAgentName;
		const resolved = resolveTaskUri(url.href, { currentSessionId, currentAgentName });
		if (!resolved) throw new Error(`Invalid task URI: ${url.href}`);
		const canonicalUri =
			canonicalizeTaskUri(url.href, { currentSessionId, currentAgentName }) ?? buildTaskUri(resolved);
		return Promise.resolve(toJsonResource(url, canonicalUri, resolved));
	}
}

export function createTaskUriProtocolHandlers(
	options: Omit<TaskUriProtocolOptions, "scheme">,
): TaskUriProtocolHandler[] {
	return [
		new TaskUriProtocolHandler({ ...options, scheme: "task" }),
		new TaskUriProtocolHandler({ ...options, scheme: "data" }),
	];
}

export function isTaskDataProtocol(input: string): boolean {
	return input === "task" || input === "data";
}
