import { useState } from "react";
import type { BlockingEventPayload, EventResponsePayload } from "../api/client";

interface Props {
	event: BlockingEventPayload;
	onAnswer: (eventId: string, payload: EventResponsePayload) => void;
}

/**
 * Pinned card rendered above the composer when a session is blocked waiting for
 * input (plan approval, ask, hook selector/input). Mirrors the Telegram answer
 * surface so external sessions can be unblocked from the web.
 */
export function BlockingEventCard({ event, onAnswer }: Props) {
	if (event.kind === "plan_approval") {
		return (
			<div className="blocking-card">
				<div className="bc-title">Plan approval — {event.title}</div>
				{event.planSummary && <div className="bc-body">{event.planSummary}</div>}
				<div className="bc-actions">
					{event.selectorOptions.map((option) => (
						<button
							key={option}
							className="btn"
							onClick={() => onAnswer(event.eventId, { kind: "plan_approval", selectedOption: option })}
						>
							{option}
						</button>
					))}
				</div>
			</div>
		);
	}

	if (event.kind === "ask") {
		return <AskCard event={event} onAnswer={onAnswer} />;
	}

	if (event.kind === "hook_selector") {
		return (
			<div className="blocking-card">
				<div className="bc-title">{event.title}</div>
				<div className="bc-actions">
					{event.options.map((option, index) => (
						<button
							key={option}
							className="btn"
							onClick={() => onAnswer(event.eventId, { kind: "hook_selector", selectedIndex: index })}
						>
							{option}
						</button>
					))}
				</div>
			</div>
		);
	}

	if (event.kind === "hook_input") {
		return <HookInputCard event={event} onAnswer={onAnswer} />;
	}

	return (
		<div className="blocking-card">
			<div className="bc-title">Pending action — {event.actionType}</div>
			<div className="bc-body">{event.description}</div>
		</div>
	);
}

function AskCard({
	event,
	onAnswer,
}: {
	event: Extract<BlockingEventPayload, { kind: "ask" }>;
	onAnswer: (eventId: string, payload: EventResponsePayload) => void;
}) {
	const [selected, setSelected] = useState<Record<string, Set<number>>>({});

	function toggle(qId: string, index: number, multi: boolean | undefined): void {
		setSelected((prev) => {
			const next = { ...prev };
			const set = new Set(multi ? next[qId] ?? [] : []);
			if (set.has(index)) set.delete(index);
			else set.add(index);
			next[qId] = set;
			return next;
		});
	}

	function submit(): void {
		const answers = event.questions.map((q) => ({
			questionId: q.id,
			selectedIndices: [...(selected[q.id] ?? new Set<number>())],
		}));
		onAnswer(event.eventId, { kind: "ask", answers });
	}

	const ready = event.questions.every((q) => (selected[q.id]?.size ?? 0) > 0);

	return (
		<div className="blocking-card">
			{event.questions.map((q) => (
				<div key={q.id} className="bc-question">
					<div className="bc-title">{q.question}</div>
					<div className="bc-actions">
						{q.options.map((opt, index) => {
							const active = selected[q.id]?.has(index) ?? false;
							const recommended = q.recommended === index;
							return (
								<button
									key={opt.label}
									className={`btn${active ? " btn-primary" : ""}`}
									onClick={() => toggle(q.id, index, q.multi)}
								>
									{opt.label}
									{recommended ? " ★" : ""}
								</button>
							);
						})}
					</div>
				</div>
			))}
			<div className="bc-actions">
				<button className="btn btn-primary" onClick={submit} disabled={!ready}>
					Submit
				</button>
			</div>
		</div>
	);
}

function HookInputCard({
	event,
	onAnswer,
}: {
	event: Extract<BlockingEventPayload, { kind: "hook_input" }>;
	onAnswer: (eventId: string, payload: EventResponsePayload) => void;
}) {
	const [value, setValue] = useState("");
	return (
		<div className="blocking-card">
			<div className="bc-title">{event.title}</div>
			<textarea
				value={value}
				placeholder={event.placeholder ?? "Type your answer…"}
				onChange={(e) => setValue(e.target.value)}
			/>
			<div className="bc-actions">
				<button
					className="btn btn-primary"
					onClick={() => onAnswer(event.eventId, { kind: "hook_input", value })}
					disabled={value.trim().length === 0}
				>
					Submit
				</button>
			</div>
		</div>
	);
}
