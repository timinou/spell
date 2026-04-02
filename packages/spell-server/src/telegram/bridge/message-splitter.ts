const DEFAULT_MAX_LEN = 4_096;

const TRACKED_TAGS = new Set(["b", "i", "s", "u", "code", "pre", "a", "blockquote"] as const);

type TrackedTag = "b" | "i" | "s" | "u" | "code" | "pre" | "a" | "blockquote";

type Segment =
	| {
			kind: "text";
			value: string;
	  }
	| {
			kind: "pre";
			value: string;
	  };

interface OpenTagState {
	name: TrackedTag;
	openTag: string;
}

interface ParsedTag {
	name: string;
	kind: "open" | "close" | "self";
}

type BoundaryLevel = "paragraph" | "sentence" | "word" | "char";

export function splitMessage(html: string, maxLen = DEFAULT_MAX_LEN): string[] {
	if (html.length <= maxLen) {
		return [html];
	}

	const segments = splitByPreBlocks(html);
	const chunks: string[] = [];
	let stack: OpenTagState[] = [];
	let current = "";
	let hasPayload = false;

	const buildClosers = (activeStack: OpenTagState[]): string => {
		let result = "";
		for (let index = activeStack.length - 1; index >= 0; index -= 1) {
			result += `</${activeStack[index]?.name ?? ""}>`;
		}
		return result;
	};

	const buildOpeners = (activeStack: OpenTagState[]): string => {
		let result = "";
		for (const tag of activeStack) {
			result += tag.openTag;
		}
		return result;
	};

	const canAppend = (fragment: string): boolean => {
		const nextStack = applyTags(fragment, stack);
		const predictedLength = current.length + fragment.length + buildClosers(nextStack).length;
		return predictedLength <= maxLen;
	};

	const append = (fragment: string): void => {
		if (fragment.length === 0) {
			return;
		}
		current += fragment;
		stack = applyTags(fragment, stack);
		hasPayload = true;
	};

	const flush = (): void => {
		if (!hasPayload) {
			return;
		}
		chunks.push(current + buildClosers(stack));
		current = buildOpeners(stack);
		hasPayload = false;
	};

	const splitIndexForLevel = (input: string, level: BoundaryLevel): number => {
		const boundaries = collectBoundaries(input, level);
		for (let index = boundaries.length - 1; index >= 0; index -= 1) {
			const boundary = boundaries[index] ?? 0;
			if (boundary <= 0 || boundary >= input.length) {
				continue;
			}
			if (canAppend(input.slice(0, boundary))) {
				return boundary;
			}
		}
		return 0;
	};

	const findSplitIndex = (input: string): number => {
		const levels: BoundaryLevel[] = ["paragraph", "sentence", "word", "char"];
		for (const level of levels) {
			const boundary = splitIndexForLevel(input, level);
			if (boundary > 0) {
				return boundary;
			}
		}
		return 0;
	};

	const appendTextWithSplits = (text: string): void => {
		let remaining = text;
		while (remaining.length > 0) {
			if (canAppend(remaining)) {
				append(remaining);
				break;
			}

			const boundary = findSplitIndex(remaining);
			if (boundary === 0) {
				if (hasPayload) {
					flush();
					continue;
				}
				append(remaining);
				break;
			}

			const head = remaining.slice(0, boundary);
			if (!canAppend(head)) {
				if (hasPayload) {
					flush();
					continue;
				}
				append(head);
				flush();
				remaining = remaining.slice(boundary);
				continue;
			}

			append(head);
			flush();
			remaining = remaining.slice(boundary);
		}
	};

	for (const segment of segments) {
		if (segment.value.length === 0) {
			continue;
		}

		if (segment.kind === "pre") {
			if (!canAppend(segment.value) && hasPayload) {
				flush();
			}
			append(segment.value);
			const currentLength = current.length + buildClosers(stack).length;
			if (currentLength > maxLen) {
				flush();
			}
			continue;
		}

		appendTextWithSplits(segment.value);
	}

	flush();
	return chunks.length > 0 ? chunks : [html];
}

function splitByPreBlocks(html: string): Segment[] {
	const segments: Segment[] = [];
	const preTagPattern = /<\s*\/?\s*pre\b[^>]*>/gi;
	let cursor = 0;
	let depth = 0;
	let preStart = -1;

	let match = preTagPattern.exec(html);
	while (match !== null) {
		const raw = match[0];
		const isClosing = /^<\s*\//.test(raw);
		if (!isClosing) {
			if (depth === 0) {
				if (match.index > cursor) {
					segments.push({ kind: "text", value: html.slice(cursor, match.index) });
				}
				preStart = match.index;
			}
			depth += 1;
		} else if (depth > 0) {
			depth -= 1;
			if (depth === 0 && preStart >= 0) {
				const end = match.index + raw.length;
				segments.push({ kind: "pre", value: html.slice(preStart, end) });
				cursor = end;
				preStart = -1;
			}
		}

		match = preTagPattern.exec(html);
	}

	if (depth > 0 && preStart >= 0) {
		segments.push({ kind: "pre", value: html.slice(preStart) });
		cursor = html.length;
	}

	if (cursor < html.length) {
		segments.push({ kind: "text", value: html.slice(cursor) });
	}

	return segments;
}

function collectBoundaries(input: string, level: BoundaryLevel): number[] {
	const boundaries: number[] = [];
	let inTag = false;

	for (let index = 0; index < input.length; index += 1) {
		const char = input[index] ?? "";

		if (char === "<") {
			inTag = true;
		}

		if (!inTag) {
			if (level === "paragraph" && char === "\n" && input[index + 1] === "\n") {
				boundaries.push(index + 2);
				index += 1;
				continue;
			}

			if (level === "sentence" && (char === "." || char === "\n")) {
				boundaries.push(index + 1);
				continue;
			}

			if (level === "word" && /\s/.test(char)) {
				boundaries.push(index + 1);
				continue;
			}

			if (level === "char") {
				boundaries.push(index + 1);
			}
		}

		if (char === ">" && inTag) {
			inTag = false;
		}
	}

	return boundaries;
}

function applyTags(fragment: string, currentStack: OpenTagState[]): OpenTagState[] {
	const nextStack = [...currentStack];
	const tagPattern = /<[^>]+>/g;

	let match = tagPattern.exec(fragment);
	while (match !== null) {
		const rawTag = match[0];
		const parsedTag = parseTag(rawTag);
		if (parsedTag === null) {
			match = tagPattern.exec(fragment);
			continue;
		}

		if (!TRACKED_TAGS.has(parsedTag.name as TrackedTag)) {
			match = tagPattern.exec(fragment);
			continue;
		}

		const name = parsedTag.name as TrackedTag;
		if (parsedTag.kind === "open") {
			nextStack.push({ name, openTag: rawTag });
		} else if (parsedTag.kind === "close") {
			popMatchingTag(nextStack, name);
		}

		match = tagPattern.exec(fragment);
	}

	return nextStack;
}

function parseTag(rawTag: string): ParsedTag | null {
	if (rawTag.startsWith("<!")) {
		return null;
	}

	const match = rawTag.match(/^<\s*\/?\s*([a-zA-Z0-9]+)/);
	if (!match || !match[1]) {
		return null;
	}

	const name = match[1].toLowerCase();
	if (/^<\s*\//.test(rawTag)) {
		return { name, kind: "close" };
	}

	if (/\/\s*>$/.test(rawTag)) {
		return { name, kind: "self" };
	}

	return { name, kind: "open" };
}

function popMatchingTag(stack: OpenTagState[], tagName: TrackedTag): void {
	for (let index = stack.length - 1; index >= 0; index -= 1) {
		if (stack[index]?.name === tagName) {
			stack.splice(index, 1);
			return;
		}
	}
}
