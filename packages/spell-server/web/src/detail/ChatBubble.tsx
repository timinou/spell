import { useMemo, type ReactNode } from "react";
import type { ChatBubble as Bubble } from "./chat-model";
import { classifyDiffLines, classifyEditResult, summariseArgs } from "./chat-presentation";

const SPEAKER: Record<string, string> = {
	user: "You",
	assistant: "Spell",
	assistant_thinking: "Spell · thinking",
	tool: "tool",
	blocking: "Blocking",
	ask: "Dialogue",
	error: "Error",
	system: "System",
};

function clock(ts: number): string {
	const d = new Date(ts);
	return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/** A single structured chat bubble. Tool tiles correlate a call with its result. */
export function ChatBubbleView({ bubble }: { bubble: Bubble }) {
	// Body text for a tool bubble is its result; for others it's `text`.
	const bodyText = bubble.kind === "tool" ? bubble.resultText : bubble.text;

	const editIntent = useMemo(
		() => (bubble.kind === "tool" ? classifyEditResult(bubble.toolName, bubble.resultText) : null),
		[bubble.kind, bubble.toolName, bubble.resultText],
	);
	const argSummary = useMemo(
		() => (bubble.kind === "tool" ? summariseArgs(bubble.args) : null),
		[bubble.kind, bubble.args],
	);
	const diffLines = useMemo(() => (bodyText ? classifyDiffLines(bodyText) : null), [bodyText]);

	const cls = [
		"cbub",
		bubble.kind,
		bubble.isError ? "err" : "",
		editIntent === "undo" || editIntent === "redo" ? "edit-undo" : "",
		editIntent === "declined" ? "edit-declined" : "",
	]
		.filter(Boolean)
		.join(" ");

	let body: ReactNode;
	if (bubble.kind === "ask" && bubble.ask) {
		body = (
			<>
				<div className="ask-q">{bubble.ask.fromTaskId ?? "worker"} asks</div>
				<div className="dim">{bubble.ask.question}</div>
				{bubble.ask.status === "answered" && <pre className="cbub-pre">{bubble.ask.answer}</pre>}
				{bubble.ask.status === "cancelled" && <div className="dim">cancelled — {bubble.ask.reason}</div>}
				{bubble.ask.status === "pending" && <div className="dim small">awaiting orchestrator…</div>}
			</>
		);
	} else if (bubble.kind === "tool" && !bodyText && argSummary) {
		body = <code className="tool-summary">{argSummary}</code>;
	} else if (bubble.kind === "tool" && bubble.pending && !bodyText) {
		body = <span className="dim small">running…</span>;
	} else if (diffLines) {
		body = (
			<pre className="cbub-pre diff">
				{diffLines.map((ln, i) => (
					// eslint-disable-next-line react/no-array-index-key
					<span key={i} className={`dl ${ln.cls}`}>
						{ln.text}
						{"\n"}
					</span>
				))}
			</pre>
		);
	} else if (bodyText) {
		body = <pre className="cbub-pre">{bodyText}</pre>;
	} else if (bubble.kind === "tool") {
		// A bare tool tile (e.g. external event_log marker) needs no body — the
		// meta line already names the tool. Avoid a noisy "(empty)".
		body = null;
	} else {
		body = <span className="dim">(empty)</span>;
	}

	return (
		<div className={cls}>
			<div className="cbub-meta">
				<span className="speaker">{SPEAKER[bubble.kind] ?? bubble.kind}</span>
				{bubble.toolName && <span className="mono dim">{bubble.toolName}</span>}
				{editIntent === "undo" && <span className="etag undo">undo</span>}
				{editIntent === "redo" && <span className="etag undo">redo</span>}
				{editIntent === "declined" && <span className="etag declined">declined</span>}
				{bubble.intent && <span className="dim small">{bubble.intent}</span>}
				<span className="clock dim">{clock(bubble.ts)}</span>
			</div>
			{body !== null && <div className="cbub-body">{body}</div>}
		</div>
	);
}
