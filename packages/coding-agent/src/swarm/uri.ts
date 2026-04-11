export type TaskUriScheme = "task" | "data";

export interface TaskUriParts {
	scheme: TaskUriScheme;
	sessionId: string;
	agentName: string;
	slug: string;
}

export interface TaskUriContext {
	currentSessionId?: string;
	currentAgentName?: string;
}

const TASK_URI_SCHEME = /^(task|data)$/i;
const TASK_URI_PREFIX = /^(?:task|data):\/\//i;
const TASK_SLUG_PREFIX = /^task-(\d+)(?:::([\s\S]+))?$/i;

function normalizeScheme(scheme: string): TaskUriScheme | null {
	if (!TASK_URI_SCHEME.test(scheme)) return null;
	return scheme.toLowerCase() as TaskUriScheme;
}

function decodeSegment(segment: string): string {
	try {
		return decodeURIComponent(segment);
	} catch {
		return segment;
	}
}

function encodeSegment(segment: string): string {
	return encodeURIComponent(segment).replaceAll("%3A", ":");
}

function resolveCurrentSessionId(sessionId: string, context: TaskUriContext): string {
	return sessionId === "current" ? (context.currentSessionId ?? sessionId) : sessionId;
}

export function isTaskUriScheme(input: string): input is TaskUriScheme {
	return input === "task" || input === "data";
}

export function isTaskUri(input: string): boolean {
	return TASK_URI_PREFIX.test(input);
}

export function isDataUri(input: string): boolean {
	return input.startsWith("data://");
}

export function isTaskShortReference(input: string): boolean {
	return TASK_SLUG_PREFIX.test(input);
}

export function parseTaskUri(input: string): TaskUriParts | null {
	if (!isTaskUri(input)) return null;
	let parsed: URL;
	try {
		parsed = new URL(input);
	} catch {
		return null;
	}
	const scheme = normalizeScheme(parsed.protocol.replace(/:$/, ""));
	if (!scheme) return null;
	const sessionId = decodeSegment(parsed.hostname);
	const segments = parsed.pathname.split("/").filter(Boolean).map(decodeSegment);
	if (segments.length < 2) return null;
	const [agentName, ...slugParts] = segments;
	const slug = slugParts.join("/");
	if (!sessionId || !agentName || !slug) return null;
	return { scheme, sessionId, agentName, slug };
}

export function parseTaskShortReference(input: string, context: TaskUriContext): TaskUriParts | null {
	if (!isTaskShortReference(input)) return null;
	const sessionId = context.currentSessionId;
	const agentName = context.currentAgentName;
	if (!sessionId || !agentName) return null;
	return { scheme: "task", sessionId, agentName, slug: input };
}

export function buildTaskUri(parts: TaskUriParts): string {
	const sessionId = encodeSegment(parts.sessionId);
	const agentName = encodeSegment(parts.agentName);
	const slug = parts.slug
		.split("/")
		.map(segment => encodeSegment(segment))
		.join("/");
	return `${parts.scheme}://${sessionId}/${agentName}/${slug}`;
}

export function canonicalizeTaskUri(input: string, context: TaskUriContext): string | null {
	const shortRef = parseTaskShortReference(input, context);
	if (shortRef) return buildTaskUri(shortRef);
	const parsed = parseTaskUri(input);
	if (!parsed) return null;
	return buildTaskUri({
		scheme: parsed.scheme,
		sessionId: resolveCurrentSessionId(parsed.sessionId, context),
		agentName: parsed.agentName,
		slug: parsed.slug,
	});
}

export function resolveTaskUri(input: string, context: TaskUriContext): TaskUriParts | null {
	const shortRef = parseTaskShortReference(input, context);
	if (shortRef) return shortRef;
	const parsed = parseTaskUri(input);
	if (!parsed) return null;
	return {
		scheme: parsed.scheme,
		sessionId: resolveCurrentSessionId(parsed.sessionId, context),
		agentName: parsed.agentName,
		slug: parsed.slug,
	};
}
