import type { WindowInfo } from "@oh-my-pi/pi-qml";
import { classifyBrowserPayload } from "./canvas-browser-protocol";

export type EventClassification = "silent" | "loud";

/**
 * Classify an event as silent (noise) or loud (agent-visible).
 *
 * Silent: url_changed, browser state/url updates, harmless stderr (fontconfig,
 * CSP frame-ancestors, dev-mode warnings), or any event with payload.silent === true.
 * Loud: close, browser command results/failures, JS errors in stderr, user interactions, unknown types.
 */
export function classifyEvent(event: WindowInfo["events"][number]): EventClassification {
	const name = event.name ?? "";
	const payload = event.payload as Record<string, unknown>;

	// QML-side opt-in silence.
	if (payload.silent === true) return "silent";

	// Heartbeat events are daemon liveness pings — never surface to agent.
	if (name === "heartbeat") return "silent";

	// Socket disconnect is handled by the event loop retry logic, not surfaced as a turn.
	if (name === "socket_disconnected") return "silent";

	// close is always loud.
	if (name === "close" || payload.action === "close") return "loud";

	// Navigation noise.
	if (name === "url_changed") return "silent";

	const browserClassification = classifyBrowserPayload(payload);
	if (browserClassification) return browserClassification;

	// Stderr events: JS errors stay loud; harmless system messages are silent.
	if (name === "stderr") {
		const text = String(payload.text ?? payload.message ?? payload.data ?? "");
		// JS/runtime errors must surface to the agent.
		if (/TypeError|SyntaxError|ReferenceError|RangeError|URIError|EvalError/.test(text)) {
			return "loud";
		}
		// Known harmless patterns.
		if (
			/fontconfig|frame-ancestors|Content Security Policy|dev mode|Lit is in|Please use WebEngineProfilePrototype|Sandboxing disabled by user/i.test(
				text,
			)
		) {
			return "silent";
		}
		// Unknown stderr — surface it.
		return "loud";
	}

	// Default: loud (fail-open for visibility).
	return "loud";
}

/**
 * Collapse adjacent events with identical name+payload into a single entry
 * with a 'count' field in the payload to avoid redundant noise.
 */
export function deduplicateEvents(
	events: WindowInfo["events"],
): Array<WindowInfo["events"][number] & { count?: number }> {
	const out: Array<WindowInfo["events"][number] & { count?: number }> = [];
	for (const ev of events) {
		const prev = out.at(-1);
		if (prev && prev.name === ev.name && JSON.stringify(prev.payload) === JSON.stringify(ev.payload)) {
			prev.count = (prev.count ?? 1) + 1;
		} else {
			out.push({ ...ev });
		}
	}
	return out;
}
